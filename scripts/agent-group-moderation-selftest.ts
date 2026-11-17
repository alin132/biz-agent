import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { SqliteStorage } from '../server/db/sqlite.js';
import type { AgentGroupMessageRecord } from '../server/db/types.js';
import type { SessionHub } from '../server/session.js';
import { AgentGroupService, AgentGroupError } from '../server/agentGroups/service.js';
import { handleAgentGroups } from '../server/agentGroups/routes.js';
import { permissionFor } from '../server/auth/roles.js';
import type { AuthRuntime } from '../server/auth/service.js';
import { addPiUsage, structuredDiscussionContext } from '../server/agentGroups/results.js';
import { collaborationConfig, parseDepartmentReply, parseHostPlan, parseHostSummary, moderateDiscussion } from '../server/agentGroups/moderation.js';

const dir = mkdtempSync(join(tmpdir(), 'group-moderation-'));
const path = join(dir, 'groups.db');
let storage = new SqliteStorage(path);
let passed = 0;
async function check(name: string, action: () => unknown | Promise<unknown>) { await action(); console.log(`  ✓ ${name}`); passed++; }
type Mode = 'consensus' | 'loop' | 'invalid' | 'invalid-member' | 'cancel' | 'host-summary-error' | 'late-failure' | 'structured-summary';
let mode: Mode = 'consensus';
let calls: { agentId: string; prompt: string; sessionId: string }[] = [];
let sequence = 0;
let release: (() => void) | undefined;
let resolveStarted: (() => void) | undefined;
const sessions = new Map<string, { id: string; transcript: { role: string; text: string }[]; send: (text: string) => Promise<void>; stop: () => boolean; setPermissionMode: (mode: string) => void }>();
const permissions: string[] = [];
const readonlySessionIds = new Set<string>();
const fakeHub = {
 get: (id: string) => sessions.get(id), remove: (id: string) => sessions.delete(id),
 create: (_workflow: string, options: {agent: {id: string; skillIds: string[]; kbIds: string[]}}) => {
  const id = `worker-${++sequence}`;
  const agentId = options.agent.id;
  const session = { id, subscribe: (_listener: unknown) => () => {}, transcript: [] as {role: string;text: string}[],
   piStats: async () => ({}),
   piBudgetUsage: () => ({tokens:session.transcript.filter(entry=>entry.role==='assistant').length*10,costUsd:null,piReportedCostUsd:null}),
   setModelRequestGuard: (_guard?:()=>void) => {},
   setPermissionMode: (value: string) => { permissions.push(value); if(value==='readonly')readonlySessionIds.add(id); assert.equal(options.agent.skillIds.length, 0); },
   stop: () => { release?.(); return true; },
   send: async (prompt: string) => {
    calls.push({agentId,prompt,sessionId:id}); session.transcript.push({role:'user',text:prompt});
    let content = '';
    const round = Number(prompt.match(/第 (\d+) 轮/)?.[1] ?? 1);
    if (mode === 'cancel') { resolveStarted?.(); await new Promise<void>(resolve=>{release=resolve;}); }
    if (prompt.startsWith('BIZ_GROUP_HOST_PLAN')) content = mode === 'invalid' ? '普通文本，缺少结构' : JSON.stringify({content:'先请销售评估，再核对财务意见',proposal:round===1?'预算十万':'预算八万，分期交付',agentIds:['sales']});
    else if (prompt.startsWith('BIZ_GROUP_HOST_SUMMARY')) {
     if (mode==='host-summary-error') throw new Error('汇总模型不可用');
     if (mode==='structured-summary') {
      const cited=JSON.parse(prompt.match(/本轮可引用发言：(\[[\s\S]*?\])\n/)?.[1]??'[]') as {id:string;agentId:string|null}[];
      const source=cited.find(message=>message.agentId==='sales')?.id;
      assert.ok(source,'汇总提示包含本轮发言来源 ID');
      content=JSON.stringify({summary:'预算安排已经确认。',decisions:[{content:'先核对预算。',sourceMessageIds:[source]}],actionItems:[{title:'核对销售预测',ownerAgentId:'sales',deadline:'2026-12-01',sourceMessageIds:[source]}],unresolved:[]});
     }
     else
     content = '## 统一汇总\n按各部门确认的方案安排交付，未解决事项请用户决策。';
    } else {
     if (mode==='late-failure' && agentId==='sales' && round===2) throw new Error('销售执行失败');
     const stance=mode==='loop'?'disagree':round===1?'needs_info':'agree';
     content=JSON.stringify({content:round===1?'@财务 请核对预算':'同意本轮修订方案',mentions:mode==='invalid-member'?['outsider']:[],stance,proposalId:`round-${round}`});
    }
    session.transcript.push({role:'assistant',text:content});
   }
  };
  sessions.set(id,session); return session;
 }
} as unknown as SessionHub;
try {
 for(const [id,name] of [['host','协调主持'],['sales','销售'],['finance','财务']])storage.createAgent({id,name,status:'published',createdAt:1,updatedAt:1,statusChangedAt:1});
 const service = new AgentGroupService(storage, fakeHub);
 function create(maxRounds=3,maxCalls=24) { return service.create({name:'交付协同',agentIds:['host','sales','finance'],createdBy:null,collaboration:{mode:'moderated',hostAgentId:'host',maxRounds,maxCalls}}); }
 await check('交付点名已发言的销售、财务后，二者优先回应，再轮到风控',async()=>{
  const members=['host','sales','finance','delivery','risk'].map((agentId,position)=>({id:agentId,groupId:'queue-test',agentId,agentName:({host:'主持',sales:'销售部',finance:'财务部',delivery:'交付部',risk:'风控部'} as Record<string,string>)[agentId]!,position,sessionId:null,addedAt:1}));
  const order:string[]=[];
  const messages:AgentGroupMessageRecord[]=[];
  const result=await moderateDiscussion({config:{mode:'moderated',hostAgentId:'host',maxRounds:1,maxCalls:24},members,initialTargets:[],groupName:'点名顺序',userMessage:'评审',previousSummaries:'',signal:new AbortController().signal,
   invoke:async(agentId,prompt)=>{
    if(prompt.startsWith('BIZ_GROUP_HOST_PLAN'))return JSON.stringify({content:'请依次评审',proposal:'完整方案',agentIds:['sales','finance','delivery','risk']});
    if(prompt.startsWith('BIZ_GROUP_HOST_SUMMARY'))return '汇总仍有分歧';
    order.push(agentId);
    return JSON.stringify({content:agentId==='delivery'?'请 @销售部 先补充清单，@财务部 核算成本':'收到，已回应',mentions:agentId==='delivery'?['sales','finance']:[],stance:agentId==='delivery'?'needs_info':'agree',proposalId:'round-1'});
   },append:(agentId,content,metadata,isError=false)=>{messages.push({id:String(messages.length),groupId:'queue-test',turnId:'turn',role:'agent',agentId,agentName:agentId,content,metadata,isError,createdAt:messages.length});},messages:()=>messages,persist:()=>{}});
  assert.deepEqual(order,['sales','finance','delivery','sales','finance','risk']);
  assert.equal(result.outcome,'round_limit');
 });
 await check('第三次点名仍优先接话，持续互相点名由总预算结束并汇总',async()=>{
  const members=['host','sales','finance','risk'].map((agentId,position)=>({id:agentId,groupId:'cycle',agentId,agentName:agentId,position,sessionId:null,addedAt:1}));
  const order:string[]=[];const messages:AgentGroupMessageRecord[]=[];
  const result=await moderateDiscussion({config:{mode:'moderated',hostAgentId:'host',maxRounds:1,maxCalls:24},members,initialTargets:[],groupName:'循环点名',userMessage:'评审',previousSummaries:'',signal:new AbortController().signal,
   invoke:async(agentId,prompt)=>{
    if(prompt.startsWith('BIZ_GROUP_HOST_PLAN'))return JSON.stringify({content:'先请财务',proposal:'方案',agentIds:['finance','risk','sales']});
    if(prompt.startsWith('BIZ_GROUP_HOST_SUMMARY'))return '未决点名需要继续处理';
    order.push(agentId);return JSON.stringify({content:'同意，但请补充',mentions:agentId==='sales'?['finance']:agentId==='finance'?['sales']:[],stance:'agree',proposalId:'round-1'});
   },append:(agentId,content,metadata,isError=false)=>{messages.push({id:String(messages.length),groupId:'cycle',turnId:'t',role:'agent',agentId,agentName:agentId,content,metadata,isError,createdAt:messages.length});},messages:()=>messages,persist:()=>{}});
  assert.deepEqual(order,Array.from({length:22},(_,index)=>index%2===0?'finance':'sales'));
  assert.equal(result.outcome,'call_limit');assert.equal(result.calls,24);
  assert.ok(!messages.some(message=>message.content.includes('本轮已发言两次')));
  assert.ok(messages.some(message=>message.metadata?.kind==='notice'&&message.content.includes('待回应或待发言事项')&&message.content.includes('risk')));
  assert.equal(messages.at(-1)?.metadata?.kind,'summary');
 });
 await check('点名预算耗尽仍保留最终汇总，不能把未回应成员判为共识',async()=>{
  const members=['host','sales','finance'].map((agentId,position)=>({id:agentId,groupId:'budget',agentId,agentName:agentId,position,sessionId:null,addedAt:1}));
  const order:string[]=[];const messages:AgentGroupMessageRecord[]=[];
  const result=await moderateDiscussion({config:{mode:'moderated',hostAgentId:'host',maxRounds:3,maxCalls:4},members,initialTargets:[],groupName:'预算',userMessage:'评审',previousSummaries:'',signal:new AbortController().signal,
   invoke:async(agentId,prompt)=>{
    order.push(agentId);
    if(prompt.startsWith('BIZ_GROUP_HOST_PLAN'))return JSON.stringify({content:'请销售',proposal:'方案',agentIds:['sales']});
    if(prompt.startsWith('BIZ_GROUP_HOST_SUMMARY'))return '预算已满，仍有未决事项';
    return JSON.stringify({content:'请另一部门核实',mentions:agentId==='sales'?['finance']:['sales'],stance:'agree',proposalId:'round-1'});
   },append:(agentId,content,metadata,isError=false)=>{messages.push({id:String(messages.length),groupId:'budget',turnId:'t',role:'agent',agentId,agentName:agentId,content,metadata,isError,createdAt:messages.length});},messages:()=>messages,persist:()=>{}});
  assert.deepEqual(order,['host','sales','finance','host']);assert.equal(result.calls,4);assert.equal(result.outcome,'call_limit');assert.equal(messages.at(-1)?.metadata?.kind,'summary');
 });
 await check('配置校验拒绝外部主持、越界轮数和调用预算',()=>{
  for(const config of [{mode:'moderated',hostAgentId:'outsider'}, {mode:'moderated',hostAgentId:'host',maxRounds:7}, {mode:'moderated',hostAgentId:'host',maxCalls:2}])assert.throws(()=>collaborationConfig(config,['host','sales']));
 });
 await check('结构化汇总拒绝伪造来源、群外负责人和无效截止日期',()=>{
  const members=[{agentId:'sales',agentName:'销售'}];
  const messages:AgentGroupMessageRecord[]=[{id:'source',groupId:'g',turnId:'t',role:'agent',agentId:'sales',agentName:'销售',content:'同意核对',isError:false,createdAt:1}];
  const base={summary:'总结',decisions:[],actionItems:[{title:'核对',ownerAgentId:'sales',deadline:null,sourceMessageIds:['source']}],unresolved:[]};
  assert.equal(parseHostSummary('旧版文本汇总',members,messages).structured,false);
  for(const patch of [{sourceMessageIds:['foreign']},{ownerAgentId:'outsider'},{deadline:'2026-02-30'}])assert.throws(()=>parseHostSummary(JSON.stringify({...base,actionItems:[{...base.actionItems[0],...patch}]}),members,messages));
  assert.throws(()=>collaborationConfig({mode:'moderated',hostAgentId:'host',maxDurationMs:999},['host','sales']));
 });
 await check('讨论耗时预算达到上限后停止，记录耗时且不继续发起汇总',async()=>{
  let clock=0;let count=0;const messages:AgentGroupMessageRecord[]=[];
  const result=await moderateDiscussion({config:{mode:'moderated',hostAgentId:'host',maxRounds:3,maxCalls:24,maxDurationMs:1000},members:['host','sales'].map((agentId,position)=>({id:agentId,groupId:'time',agentId,agentName:agentId,position,sessionId:null,addedAt:1})),initialTargets:[],groupName:'时限',userMessage:'测试',previousSummaries:'',signal:new AbortController().signal,now:()=>clock,
   invoke:async()=>{count++;clock+=1001;return JSON.stringify({content:'选择销售',proposal:'方案',agentIds:['sales']});},append:(agentId,content,metadata,isError=false)=>{messages.push({id:String(messages.length),groupId:'time',turnId:'t',role:'agent',agentId,agentName:agentId,content,metadata,isError,createdAt:messages.length});},messages:()=>messages,persist:()=>{}});
  assert.equal(result.outcome,'time_limit');assert.equal(result.elapsedMs,1001);assert.equal(count,1);assert.equal(result.calls,1);assert.equal(result.checkpoint?.phase,'planning');
 });
 await check('token 消耗只取 Pi 统计差额，未知 usage 和定价不冒充零',()=>{
  const previous={tokens:20,costUsd:null,piReportedCostUsd:0.1};
  const result=addPiUsage(previous,{tokens:100,costUsd:null,piReportedCostUsd:0.2},{tokens:112,costUsd:null,piReportedCostUsd:0.25});
  assert.equal(result.tokens,32);assert.equal(result.costUsd,null);assert.ok(Math.abs(result.piReportedCostUsd!-0.15)<1e-9);
  assert.equal(addPiUsage(previous,{tokens:100,costUsd:null,piReportedCostUsd:null},{tokens:null,costUsd:null,piReportedCostUsd:null}).tokens,null);
  assert.throws(()=>collaborationConfig({mode:'moderated',hostAgentId:'host',maxTokens:0},['host','sales']));
  assert.throws(()=>collaborationConfig({mode:'moderated',hostAgentId:'host',maxCostUsd:1},['host','sales']));
 });
 await check('token 预算用完后不继续调度部门或最终汇总',async()=>{
  let tokens=0;let calls=0;
  const result=await moderateDiscussion({config:{mode:'moderated',hostAgentId:'host',maxRounds:3,maxCalls:24,maxTokens:10},members:['host','sales'].map((agentId,position)=>({id:agentId,groupId:'tokens',agentId,agentName:agentId,position,sessionId:null,addedAt:1})),initialTargets:[],groupName:'tokens',userMessage:'测试',previousSummaries:'',signal:new AbortController().signal,
   invoke:async()=>{calls++;tokens=12;return JSON.stringify({content:'选择销售',proposal:'方案',agentIds:['sales']});},usage:()=>({tokens,costUsd:null,piReportedCostUsd:null}),append:()=>{},messages:()=>[],persist:()=>{}});
  assert.equal(result.outcome,'token_limit');assert.equal(result.usage?.tokens,12);assert.equal(calls,1);
 });
 const group=create();
 let result=await service.send(group.id,'讨论交付预算');
 await check('主持选部门，部门 @ 即时纳入队列，多轮辩论后确认共识',()=>{
  assert.equal(result.turns.at(-1)?.discussion?.outcome,'consensus');
  assert.equal(result.turns.at(-1)?.discussion?.round,2);
  assert.deepEqual(result.turns.at(-1)?.discussion?.participants,['sales','finance']);
  const replies=result.messages.filter(message=>message.metadata?.kind==='reply');
  assert.deepEqual(replies.map(reply=>[reply.agentId,reply.metadata?.round]),[['sales',1],['finance',1],['sales',2],['finance',2]]);
  assert.deepEqual(replies[0]?.metadata?.mentions,['finance']);
  assert.ok(calls.find(call=>call.agentId==='finance')?.prompt.includes('预算十万'));
  assert.ok(calls.filter(call=>call.agentId==='sales'&&call.prompt.startsWith('BIZ_GROUP_DEPARTMENT')).at(-1)?.prompt.includes('@财务 请核对预算'));
  assert.equal(result.messages.at(-1)?.metadata?.kind,'summary');
  assert.match(result.messages.at(-1)!.content,/已就本轮方案达成共识/);
  assert.equal(result.turns.at(-1)?.discussion?.calls,7);
 });
 await check('主持使用独立只读会话，结束清理；部门会话持续保留',()=>{
  assert.deepEqual(permissions,['readonly']);
  assert.equal(result.members.find(member=>member.agentId==='host')?.sessionId,null);
  for(const id of ['sales','finance'])assert.ok(sessions.has(result.members.find(member=>member.agentId===id)!.sessionId!));
  assert.ok(!sessions.has(calls.find(call=>call.agentId==='host')!.sessionId));
 });
 calls=[]; result=await service.send(group.id,'下一事项');
 await check('后续事项收到公共最终汇总，而非丢失跨部门讨论记忆',()=>{
  assert.ok(calls[0]!.prompt.includes('统一汇总'));
  assert.equal(result.turns.length,2);
 });
 await check('配置、讨论进度、表态和汇总重开数据库后仍完整',()=>{
  storage.close();storage=new SqliteStorage(path);
  assert.deepEqual(storage.getAgentGroup(group.id)?.collaboration,group.collaboration);
  assert.equal(storage.listAgentGroupTurns(group.id).at(-1)?.discussion?.outcome,'consensus');
  assert.ok(storage.listAgentGroupMessages(group.id).some(message=>message.metadata?.stance==='agree'));
 });
 await check('同一群新建多个对话，消息、部门会话及主持历史相互隔离，重开后可切回',async()=>{
  const isolatedService=new AgentGroupService(storage,fakeHub);mode='consensus';
  const first=isolatedService.createConversation(group.id);const firstId=first.activeConversationId;
  assert.equal(first.messages.length,0);assert.equal(first.turns.length,0);assert.ok(first.members.every(member=>member.sessionId===null));
  calls=[];const firstDone=await isolatedService.send(group.id,'独立对话甲',undefined,firstId);
  assert.ok(!calls[0]!.prompt.includes('统一汇总'));assert.equal(firstDone.turns.length,1);assert.equal(firstDone.conversations.find(c=>c.id===firstId)?.title,'独立对话甲');
  const firstWorkers=firstDone.members.map(member=>member.sessionId).filter(Boolean);
  const second=isolatedService.createConversation(group.id);calls=[];
  const secondDone=await isolatedService.send(group.id,'独立对话乙',undefined,second.activeConversationId);
  assert.ok(!calls[0]!.prompt.includes('独立对话甲'));assert.ok(!calls[0]!.prompt.includes('统一汇总'));
  assert.ok(secondDone.members.filter(member=>member.sessionId).every(member=>!firstWorkers.includes(member.sessionId)));
  const restored=isolatedService.get(group.id,firstId);assert.deepEqual(restored.messages,firstDone.messages);assert.ok(!restored.messages.some(message=>message.content.includes('独立对话乙')));
  assert.equal(isolatedService.get(group.id).turns.length,2);assert.equal(restored.conversations.length,3);
  calls=[];await isolatedService.send(group.id,'甲的后续问题',undefined,firstId);assert.ok(calls[0]!.prompt.includes('统一汇总'));
  const other=isolatedService.create({name:'其他群',agentIds:['host','sales','finance'],createdBy:null});
  assert.throws(()=>isolatedService.get(other.id,firstId),AgentGroupError);
  const otherTurns=storage.listAgentGroupTurns(other.id).length;
  await assert.rejects(()=>isolatedService.send(other.id,'越界对话',undefined,firstId),AgentGroupError);assert.equal(storage.listAgentGroupTurns(other.id).length,otherTurns);
  storage.close();storage=new SqliteStorage(path);assert.equal(storage.getAgentGroupConversation(firstId)?.title,'独立对话甲');assert.ok(storage.listAgentGroupTurns(group.id).some(turn=>turn.conversationId===firstId));
 });
 // Service keeps a storage instance; use a fresh service after the readback.
 const currentService = new AgentGroupService(storage,fakeHub);
 const nextGroup=(maxRounds=3,maxCalls=24)=>currentService.create({name:'边界协同',agentIds:['host','sales','finance'],createdBy:null,collaboration:{mode:'moderated',hostAgentId:'host',maxRounds,maxCalls}});
 mode='loop';calls=[];
 const bounded=await currentService.send(nextGroup(2).id,'持续分歧');
 await check('相互点名或持续反对到轮数上限时停止，并汇总未决分歧',()=>{
  assert.equal(bounded.turns.at(-1)?.discussion?.outcome,'round_limit');
  assert.equal(bounded.turns.at(-1)?.discussion?.round,2);
  assert.match(bounded.messages.at(-1)!.content,/尚未达成共识/);
  assert.ok(calls.length<=24);
 });
 const limited=await currentService.send(nextGroup(6,4).id,'调用预算限制');
 await check('严格调用预算预留最终汇总，不因部门 @ 无限执行',()=>{
  assert.equal(limited.turns.at(-1)?.discussion?.outcome,'call_limit');
  assert.ok(limited.turns.at(-1)!.discussion!.calls <= 4);
  assert.equal(limited.messages.at(-1)?.metadata?.kind,'summary');
 });
 mode='invalid';
 const invalid=await currentService.send(nextGroup().id,'主持响应不合规');
 await check('主持未返回结构化分派时显式失败，不假装达成共识',()=>{
  assert.equal(invalid.turns.at(-1)?.status,'failed');
  assert.equal(invalid.turns.at(-1)?.discussion?.outcome,'failed');
  assert.ok(invalid.messages.at(-1)?.isError);
 });
 mode='invalid-member';
 const invalidMember=await currentService.send(nextGroup().id,'越权点名');
 await check('拒绝模型分派或点名群外成员，失败后仍有最终汇总',()=>{
  assert.equal(invalidMember.turns.at(-1)?.discussion?.outcome,'failed');
  assert.equal(invalidMember.messages.at(-1)?.metadata?.kind,'summary');
  assert.throws(()=>parseHostPlan(JSON.stringify({content:'test',proposal:'test',agentIds:['outsider']}),[{agentId:'sales',agentName:'销售'}]));
  assert.throws(()=>parseDepartmentReply(JSON.stringify({content:'同意',stance:'agree',proposalId:'round-1'}),[], 'sales','round-2'));
 });
 mode='host-summary-error';
 const failedSummary=await currentService.send(nextGroup().id,'汇总失败');
 await check('最终汇总失败时整体标记失败，不保留成功共识结果',()=>assert.equal(failedSummary.turns.at(-1)?.discussion?.outcome,'failed'));
 mode='consensus';
 const beforeSummaryResume=calls.length;
 const summaryResumed=await currentService.resume(failedSummary.id,failedSummary.turns.at(-1)!.id);
 await check('只汇总失败的轮次恢复时不重复分派或执行部门',()=>{
  const retried=calls.slice(beforeSummaryResume);assert.equal(retried.length,1);assert.ok(retried[0]!.prompt.startsWith('BIZ_GROUP_HOST_SUMMARY'));assert.equal(summaryResumed.turns.at(-1)?.discussion?.outcome,'consensus');
 });
 mode='late-failure';
 const lateFailure=await currentService.send(nextGroup().id,'重复发言失败');
 await check('后续轮次成员失败不被其前轮成功回复掩盖',()=>assert.equal(lateFailure.turns.at(-1)?.status,'failed'));
 mode='structured-summary';
 const structured=await currentService.send(nextGroup().id,'结构化行动项来源校验');
 const structuredTurn=structured.turns.at(-1)!;
 await check('主持决策与行动项使用可验证的本轮来源和群内负责人',()=>{
  const result=structuredTurn.discussion?.result;assert.equal(result?.structured,true);assert.equal(result?.actionItems[0]?.ownerAgentId,'sales');assert.equal(result?.actionItems[0]?.status,'pending');
  for(const item of [...(result?.decisions??[]),...(result?.actionItems??[]),...(result?.unresolved??[])])assert.ok(item.sourceMessageIds.every(id=>structured.messages.some(message=>message.id===id&&!message.isError)));
  const changed=currentService.updateAction(structured.id,{turnId:structuredTurn.id,actionId:result!.actionItems[0]!.id,status:'done'});assert.equal(changed.turns.at(-1)?.discussion?.result?.actionItems[0]?.status,'done');
 });
 await check('已完成的主持轮次拒绝恢复，防止重复执行',async()=>assert.rejects(()=>currentService.resume(structured.id,structuredTurn.id),(error:unknown)=>error instanceof AgentGroupError&&error.status===409));
 await check('后续讨论注入已更新行动项及来源，群内新对话和其它群不继承',async()=>{
  mode='consensus';calls=[];
  await currentService.send(structured.id,'继续复核已完成事项');
  const prompt=calls[0]!.prompt;assert.ok(prompt.includes('已持久化结构化事实'));assert.ok(prompt.includes('"status":"done"'));assert.ok(prompt.includes('核对销售预测'));assert.ok(prompt.includes(structuredTurn.discussion!.result!.actionItems[0]!.sourceMessageIds[0]!));
  const isolated=currentService.createConversation(structured.id);calls=[];
  await currentService.send(structured.id,'全新独立事项',undefined,isolated.activeConversationId);assert.ok(!calls[0]!.prompt.includes('核对销售预测'));
  calls=[];await currentService.send(nextGroup().id,'其他群事项');assert.ok(!calls[0]!.prompt.includes('核对销售预测'));
  const large={...structuredTurn,discussion:{...structuredTurn.discussion!,result:{...structuredTurn.discussion!.result!,actionItems:Array.from({length:30},(_,index)=>({...structuredTurn.discussion!.result!.actionItems[0]!,id:`action-${index}`,title:'预算核算'.repeat(100)}))}}};
  const bounded=structuredDiscussionContext([large]);assert.ok(bounded.length<=6000);assert.ok(bounded.includes('超出预算'));
 });
 mode='consensus';
 const recoverable=nextGroup();
 const interrupted={id:'turn-readable-resume',groupId:recoverable.id,sequence:1,userMessage:'恢复未完成分歧',status:'running' as const,createdAt:Date.now(),completedAt:null,
  discussion:{round:2,calls:2,phase:'discussing' as const,outcome:'pending' as const,participants:['sales','finance'],proposal:'已在评审的方案',checkpoint:{phase:'discussing' as const,round:2,queue:['sales','finance'],ballots:{},requests:['finance'],pending:[],committedReplyCount:0}}};
 storage.createAgentGroupTurn(interrupted);
 storage.appendAgentGroupMessage({id:'resume-user',groupId:recoverable.id,turnId:interrupted.id,role:'user',agentId:null,agentName:null,content:interrupted.userMessage,isError:false,createdAt:interrupted.createdAt+1});
 storage.appendAgentGroupMessage({id:'resume-sales',groupId:recoverable.id,turnId:interrupted.id,role:'agent',agentId:'sales',agentName:'销售',content:'销售确认方案',isError:false,createdAt:interrupted.createdAt+2,metadata:{kind:'reply',round:2,stance:'agree',proposalId:'round-2'}});
 new AgentGroupService(storage,fakeHub);
 const callsBeforeResume=calls.length;
 const resumed=await new AgentGroupService(storage,fakeHub).resume(recoverable.id,interrupted.id);
 await check('中断主持轮次仅恢复待回应成员，沿用原轮次且所有恢复会话只读',()=>{
  const recoveredCalls=calls.slice(callsBeforeResume);assert.equal(recoveredCalls.filter(call=>call.agentId==='sales'&&call.prompt.startsWith('BIZ_GROUP_DEPARTMENT')).length,0);
  assert.equal(recoveredCalls.filter(call=>call.agentId==='finance'&&call.prompt.startsWith('BIZ_GROUP_DEPARTMENT')).length,1);
  assert.ok(recoveredCalls.every(call=>readonlySessionIds.has(call.sessionId)));
  const resumedTurn=resumed.turns.find(turn=>turn.id===interrupted.id)!;assert.equal(resumedTurn.sequence,1);assert.equal(resumedTurn.discussion?.resumeCount,1);assert.equal(resumedTurn.discussion?.outcome,'consensus');assert.ok(resumedTurn.discussion!.elapsedMs!>=0);
  assert.equal(resumed.messages.filter(message=>message.id==='resume-sales').length,1,'恢复不重复写入已提交的销售回复');
 });
 mode='cancel';
 const cancelGroup=nextGroup();
 const started=new Promise<void>(resolve=>{resolveStarted=resolve;});
 const running=currentService.send(cancelGroup.id,'停止主持');await started;
 assert.equal(currentService.cancel(cancelGroup.id),true);
 assert.throws(()=>currentService.createConversation(cancelGroup.id),AgentGroupError);
 const cancelled=await running;
 await check('停止主持阶段中止当前 Pi 会话，不再调度部门或汇总',()=>{
  assert.equal(cancelled.turns.at(-1)?.status,'cancelled');
  assert.equal(cancelled.turns.at(-1)?.discussion?.outcome,'cancelled');
  assert.equal(cancelled.messages.filter(message=>message.metadata?.kind==='reply').length,0);
  assert.equal(currentService.get(cancelGroup.id).running,false);
 });
 await check('运行中的主持轮次重启后标记中断，不重放业务动作',()=>{
  const restart=nextGroup();
  storage.createAgentGroupTurn({id:'interrupted-moderation',groupId:restart.id,sequence:1,userMessage:'旧事项',status:'running',createdAt:1,completedAt:null,discussion:{round:2,calls:4,phase:'discussing',outcome:'pending',participants:['sales'],proposal:'旧方案'}});
  new AgentGroupService(storage,fakeHub);
  assert.equal(storage.getAgentGroupTurn('interrupted-moderation')?.discussion?.outcome,'interrupted');
  assert.match(storage.listAgentGroupMessages(restart.id).at(-1)!.content,/不会自动重放/);
 });
 await check('顺序模式同样隔离多对话，删除群组会清理各对话工作会话及存储',async()=>{
  mode='consensus';const sequential=currentService.create({name:'顺序多对话',agentIds:['sales','finance'],createdBy:null});
  const a=currentService.createConversation(sequential.id);const b=currentService.createConversation(sequential.id);
  const aDone=await currentService.send(sequential.id,'顺序事项甲',undefined,a.activeConversationId);
  const bDone=await currentService.send(sequential.id,'顺序事项乙',undefined,b.activeConversationId);
  const workerIds=aDone.members.map(member=>member.sessionId!);
  assert.ok(bDone.members.every(member=>!workerIds.includes(member.sessionId!)));
  assert.equal(currentService.get(sequential.id,a.activeConversationId).messages[0]?.content,'顺序事项甲');
  assert.equal(currentService.get(sequential.id).messages.length,0);
  workerIds.push(...bDone.members.map(member=>member.sessionId!));currentService.delete(sequential.id);
  assert.ok(workerIds.every(id=>!sessions.has(id)));assert.equal(storage.getAgentGroupConversation(a.activeConversationId),undefined);assert.equal(storage.listAgentGroupTurns(sequential.id).length,0);
 });
 await check('关闭主持模式可保存，移除仍被设为主持的成员被拒绝',()=>{
  assert.throws(()=>currentService.update(group.id,{name:'x',agentIds:['sales','finance']}),AgentGroupError);
  const updated=currentService.update(group.id,{name:'顺序模式',agentIds:['sales','finance'],collaboration:null});
  assert.equal(updated.collaboration,undefined);
 });
 await check('HTTP 恢复与行动项状态接口验证边界且使用正确权限点',async()=>{
  mode='host-summary-error';const failed=await currentService.send(nextGroup().id,'HTTP 汇总恢复');mode='consensus';
  const auth={userOf:()=>undefined} as unknown as AuthRuntime;
  const server=createServer(async(req,res)=>{await handleAgentGroups(req,res,new URL(req.url!,'http://local'),currentService,auth);});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address&&typeof address==='object');const base=`http://127.0.0.1:${address.port}`;
  const post=(path:string,body:unknown,method='POST')=>fetch(base+path,{method,headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  try{
   assert.equal(permissionFor('POST',`/api/agent-groups/${failed.id}/resume`),'session.run');
   assert.equal(permissionFor('PATCH',`/api/agent-groups/${structured.id}/actions`),'session.write');
   const resumed=await post(`/api/agent-groups/${failed.id}/resume`,{turnId:failed.turns.at(-1)!.id});assert.equal(resumed.status,200);
   const body=await resumed.json() as {turns:{status:string;discussion:{resumeCount:number}}[]};assert.equal(body.turns.at(-1)?.discussion.resumeCount,1);assert.equal(body.turns.at(-1)?.status,'completed');
   assert.equal((await post(`/api/agent-groups/${failed.id}/resume`,{turnId:failed.turns.at(-1)!.id})).status,409);
   assert.equal((await post(`/api/agent-groups/${failed.id}/resume`,{turnId:structuredTurn.id})).status,404);
   assert.equal((await post(`/api/agent-groups/${failed.id}/resume`,{turnId:null})).status,400);
   const changed=await post(`/api/agent-groups/${structured.id}/actions`,{turnId:structuredTurn.id,actionId:'action-1',status:'in_progress'},'PATCH');assert.equal(changed.status,200);
   assert.equal(storage.getAgentGroupTurn(structuredTurn.id)?.discussion?.result?.actionItems[0]?.status,'in_progress');
   assert.equal((await post(`/api/agent-groups/${structured.id}/actions`,{turnId:structuredTurn.id,actionId:'action-1',status:'bogus'},'PATCH')).status,400);
   assert.equal((await post(`/api/agent-groups/${structured.id}/actions`,{turnId:structuredTurn.id,actionId:'missing',status:'done'},'PATCH')).status,404);
  }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
 });
 console.log(`主持协作自检：${passed} 组通过`);
} finally {storage.close();rmSync(dir,{recursive:true,force:true});}
