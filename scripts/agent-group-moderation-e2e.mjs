import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';

const dir=mkdtempSync(join(tmpdir(),'biz-group-moderation-e2e-'));
const out=resolve('data/ui-redesign');mkdirSync(out,{recursive:true});
let child,browser,page,base,passed=0,scenario='consensus',repeatReplies=0;
const ids={};const requests=[];
const model=createServer(async(req,res)=>{
 try {
  assert.equal(req.url,'/v1/chat/completions');
  let raw='';for await(const chunk of req)raw+=chunk;
  const body=JSON.parse(raw);
  const message=body.messages.filter(message=>message.role==='user').at(-1);
  const prompt=typeof message?.content==='string'?message.content:message?.content?.map(item=>item.text??'').join('\n')??'';
  requests.push(prompt);
  let content;
  const round=Number(prompt.match(/第 (\d+) 轮/)?.[1]??1);
  if(prompt.startsWith('BIZ_GROUP_HOST_PLAN')&&scenario==='repeat')content=JSON.stringify({content:'先请财务评估，再请风控和销售',proposal:'完整方案',agentIds:[ids.finance,ids.risk,ids.sales]});
  else if(prompt.startsWith('BIZ_GROUP_DEPARTMENT')&&scenario==='repeat'){
   repeatReplies++;
   const target=repeatReplies<5?(prompt.includes('你代表「财务」')?'sales':'finance'):null;
   content=JSON.stringify({content:target?`请 @${target==='sales'?'销售':'财务'} 补充本次问题`:'已补充并同意当前方案',mentions:target?[ids[target]]:[],stance:'agree',proposalId:`round-${round}`});
  }
  else if(prompt.startsWith('BIZ_GROUP_HOST_PLAN')&&scenario==='priority')content=JSON.stringify({content:'请按销售、财务、交付、风控评审',proposal:'完整方案',agentIds:[ids.sales,ids.finance,ids.delivery,ids.risk]});
  else if(prompt.startsWith('BIZ_GROUP_DEPARTMENT')&&scenario==='priority')content=JSON.stringify({content:prompt.includes('你代表「交付」')?'请 @销售 先补充清单，@财务 核算成本':'已回应本轮方案',mentions:prompt.includes('你代表「交付」')?[ids.sales,ids.finance]:[],stance:prompt.includes('你代表「交付」')?'needs_info':'agree',proposalId:`round-${round}`});
  else if(prompt.startsWith('BIZ_GROUP_HOST_PLAN'))content=JSON.stringify({content:round===1?'请销售先评估交付方案':'根据财务意见修订方案并邀请复核',proposal:round===1?'预算十万，月底交付':'预算八万，分期交付',agentIds:[ids.sales]});
  else if(prompt.startsWith('BIZ_GROUP_HOST_SUMMARY'))content='## 统一汇总\n\n预算八万，分期交付。\n\n- 销售：确认客户范围\n- 财务：复核预算\n\n未解决的事项需用户确认。';
  else if(prompt.startsWith('BIZ_GROUP_DEPARTMENT'))content=JSON.stringify({content:round===1?'@财务 请核对预算':'已核对预算与交付安排',mentions:[],stance:scenario==='dispute'?'disagree':round===1?'needs_info':'agree',proposalId:`round-${round}`});
  else throw new Error('非预期模型请求');
  res.writeHead(200,{'content-type':'text/event-stream'});
  for(const payload of [{choices:[{delta:{role:'assistant',content},finish_reason:null}]},{choices:[{delta:{},finish_reason:'stop'}]}])res.write(`data: ${JSON.stringify(payload)}\n\n`);
  res.end('data: [DONE]\n\n');
 }catch(error){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:error.message}}));}
});
await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));
async function api(path,body,method=body===undefined?'GET':'POST'){
 const response=await fetch(base+path,{method,headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 const result=await response.json();assert.ok(response.ok,`${method} ${path}: ${response.status} ${JSON.stringify(result)}`);return result;
}
async function check(name,fn){await fn();console.log(`  ✓ ${name}`);passed++;}
try {
 const portServer=createServer();await new Promise(resolve=>portServer.listen(0,'127.0.0.1',resolve));const port=portServer.address().port;await new Promise(resolve=>portServer.close(resolve));base=`http://127.0.0.1:${port}`;
 child=spawn(process.execPath,['--import','tsx','server/index.ts'],{windowsHide:true,stdio:'ignore',env:{...process.env,PORT:String(port),DB_PATH:join(dir,'test.db'),DATABASE_URL:'',LLM_DISABLE:'0',AUTH_MODE:'off',AUTH_SECRET:randomUUID(),SECRET_KEY:randomUUID(),DINGTALK_TRANSPORT:'fake'}});
 for(let n=0;n<450;n++){try{if((await fetch(base+'/api/health')).ok)break;}catch{}if(child.exitCode!==null)throw new Error('隔离群聊服务退出');if(n===449)throw new Error('隔离服务启动超时');await delay(200);}
 const provider=await api('/api/models/providers',{name:'本机群聊测试模型',kind:'custom',baseUrl:`http://127.0.0.1:${model.address().port}/v1`,apiKey:randomUUID()});
 const chatModel=await api('/api/models',{providerId:provider.id,modelId:'group-test',name:'群聊本机测试',kind:'chat',contextWindow:128000});
 for(const [key,name] of [['host','主持'],['sales','销售'],['finance','财务'],['delivery','交付'],['risk','风控']]){const agent=await api('/api/agents',{name,description:key==='host'?'协调部门讨论并形成统一汇总':'对交付事项提出部门意见',modelConfig:{chatModelId:chatModel.id},agentsMd:'请遵循当前群聊讨论协议，独立分析。'});ids[key]=agent.id;await api(`/api/agents/${agent.id}/actions`,{action:'publish'});}
 browser=await chromium.launch();page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(15000);
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 let group;
 await check('浏览器创建主持协作群并持久化主持和讨论预算',async()=>{
  await page.goto(base+'/#/agent-groups');await page.getByRole('button',{name:'新建群聊',exact:true}).click();
  const modal=page.locator('.n-modal');await modal.getByPlaceholder('例如：新客户交付协同').fill('交付项目评审');
  await modal.locator('.n-select').nth(0).click();for(const name of ['主持','销售','财务'])await page.locator('.n-base-select-option:visible').filter({hasText:name}).click();
  await modal.getByPlaceholder('例如：新客户交付协同').click();
  await modal.locator('.n-select').nth(1).click();await page.locator('.n-base-select-option:visible').filter({hasText:'主持协作 · 多轮讨论与统一汇总'}).click();
  await modal.locator('.moderation-config .n-select').click();await page.locator('.n-base-select-option:visible').filter({hasText:/^主持$/}).click();
  await expect(modal.getByRole('button',{name:'创建群聊',exact:true})).toBeEnabled();
  const response=page.waitForResponse(response=>response.url().endsWith('/api/agent-groups')&&response.request().method()==='POST');await modal.getByRole('button',{name:'创建群聊',exact:true}).click();group=await(await response).json();
  assert.equal(group.collaboration.hostAgentId,ids.host);assert.equal(group.collaboration.maxRounds,3);assert.equal(group.collaboration.maxCalls,24);
  await page.reload();await expect(page.locator(`[data-group-id="${group.id}"]`)).toContainText('主持协作');
 });
 await check('真实 Pi 请求经本机模型完成自动分派、部门点名、多轮讨论和共识汇总',async()=>{
  await page.locator(`[data-group-id="${group.id}"]`).getByRole('button',{name:'进入群聊',exact:true}).click();
  const input=page.getByRole('textbox',{name:'群聊消息',exact:true});
  await input.fill('@销售');await input.press('Enter');await expect(input).toHaveValue('@销售 ');
  assert.equal((await api(`/api/agent-groups/${group.id}`)).turns.length,0);
  await input.fill('评估预算和交付周期，必要时互相 @ 补充信息，形成各部门认可的方案');
  await input.press('Shift+Enter');await expect(input).toHaveValue(/方案\n$/);
  await input.dispatchEvent('keydown',{key:'Enter',code:'Enter',isComposing:true});
  await input.dispatchEvent('keydown',{key:'Enter',code:'Enter',keyCode:229});
  assert.equal((await api(`/api/agent-groups/${group.id}`)).turns.length,0);
  await input.press('Enter');
  await expect(page.getByTestId('group-discussion-state')).toContainText('参与部门已达成共识',{timeout:30000});
  await expect(page.locator('.summary-message')).toContainText('统一汇总');
  await expect(page.locator('.group-message .message-stage').filter({hasText:'主持分派'})).toHaveCount(2);
  const result=await api(`/api/agent-groups/${group.id}`);const discussion=result.turns.at(-1).discussion;
  assert.equal(discussion.round,2);assert.equal(discussion.calls,7);assert.deepEqual(discussion.participants,[ids.sales,ids.finance]);
  const replies=result.messages.filter(message=>message.metadata?.kind==='reply');
  assert.equal(replies.length,4);assert.equal(replies[0].agentId,ids.sales);assert.equal(replies[1].agentId,ids.finance);assert.equal(replies[1].metadata.round,1);
  assert.ok(requests.some(prompt=>prompt.startsWith('BIZ_GROUP_HOST_PLAN')&&prompt.includes('@财务 请核对预算')));
  assert.ok(requests.some(prompt=>prompt.startsWith('BIZ_GROUP_DEPARTMENT')&&prompt.includes('你代表「财务」')));
  await page.screenshot({path:join(out,'agent-group-moderated-consensus.png'),fullPage:true,animations:'disabled'});
  await page.reload();await expect(page.getByTestId('group-discussion-state')).toContainText('参与部门已达成共识');
  await expect(page.locator('.summary-message')).toHaveCount(1);
 });
 await check('持续分歧达到轮数上限，最终汇总保留未达共识状态',async()=>{
  scenario='dispute';await api(`/api/agent-groups/${group.id}`,{name:group.name,agentIds:[ids.host,ids.sales,ids.finance],collaboration:{...group.collaboration,maxRounds:2}},'PATCH');
  await page.getByRole('textbox',{name:'群聊消息',exact:true}).fill('继续评估但各部门仍有分歧');await page.getByRole('button',{name:'发送',exact:true}).click();
  await expect(page.getByTestId('group-discussion-state')).toContainText('已达轮数上限',{timeout:30000});
  await expect(page.locator('.summary-message').last()).toContainText('尚未达成共识');
  await page.screenshot({path:join(out,'agent-group-moderated-dispute.png'),fullPage:true,animations:'disabled'});
 });
 await check('点名已发言的部门后立即补充，风控等待点名回应完成再继续',async()=>{
  scenario='priority';const priorityGroup=await api('/api/agent-groups',{name:'点名优先验证',agentIds:[ids.host,ids.sales,ids.finance,ids.delivery,ids.risk],collaboration:{mode:'moderated',hostAgentId:ids.host,maxRounds:1,maxCalls:24}});
  await page.goto(base+'/#/agent-groups/'+priorityGroup.id+'/chat');
  await page.getByRole('textbox',{name:'群聊消息',exact:true}).fill('请交付评估并点名销售、财务补充');await page.getByRole('button',{name:'发送',exact:true}).click();
  await expect(page.getByTestId('group-discussion-state')).toContainText('已达轮数上限',{timeout:30000});
  const result=await api(`/api/agent-groups/${priorityGroup.id}`);
  assert.deepEqual(result.messages.filter(message=>message.metadata?.kind==='reply').map(message=>message.agentId),[ids.sales,ids.finance,ids.delivery,ids.sales,ids.finance,ids.risk]);
  assert.deepEqual(await page.locator('.group-message').filter({has:page.locator('.message-stage').filter({hasText:'部门意见'})}).locator('.group-message-meta strong').allTextContents(),['销售','财务','交付','销售','财务','风控']);
  await page.screenshot({path:join(out,'agent-group-mention-priority.png'),fullPage:true,animations:'disabled'});
 });
 await check('同轮第三次点名仍由被点名部门回应，完成后再轮到风控',async()=>{
  scenario='repeat';repeatReplies=0;
  const repeatGroup=await api('/api/agent-groups',{name:'多次点名验证',agentIds:[ids.host,ids.sales,ids.finance,ids.risk],collaboration:{mode:'moderated',hostAgentId:ids.host,maxRounds:1,maxCalls:24}});
  await page.goto(base+'/#/agent-groups/'+repeatGroup.id+'/chat');
  await page.getByRole('textbox',{name:'群聊消息',exact:true}).fill('财务与销售需要多次互相补充，再请风控评估');
  await page.getByRole('textbox',{name:'群聊消息',exact:true}).press('Enter');
  await expect(page.getByTestId('group-discussion-state')).toContainText('参与部门已达成共识',{timeout:30000});
  const result=await api(`/api/agent-groups/${repeatGroup.id}`);
  assert.deepEqual(result.messages.filter(message=>message.metadata?.kind==='reply').map(message=>message.agentId),[ids.finance,ids.sales,ids.finance,ids.sales,ids.finance,ids.risk]);
  assert.deepEqual(await page.locator('.group-message').filter({has:page.locator('.message-stage').filter({hasText:'部门意见'})}).locator('.group-message-meta strong').allTextContents(),['财务','销售','财务','销售','财务','风控']);
  assert.equal(result.turns.at(-1).discussion.calls,8);
  assert.ok(!result.messages.some(message=>message.content.includes('本轮已发言两次')));
  await page.screenshot({path:join(out,'agent-group-repeated-mentions.png'),fullPage:true,animations:'disabled'});
 });
 await check('新对话留空、独立发言和记忆，历史切换与刷新恢复',async()=>{
  scenario='consensus';await page.goto(base+'/#/agent-groups/'+group.id+'/chat');
  const original=await api(`/api/agent-groups/${group.id}`);const count=original.messages.length;
  await page.getByRole('button',{name:'新对话',exact:true}).click();await expect(page.locator('.group-message')).toHaveCount(0);
  const conversationId=new URL(page.url().split('#')[1],'http://local').searchParams.get('conversation');assert.ok(conversationId);
  const independent=await api(`/api/agent-groups/${group.id}?conversationId=${conversationId}`);assert.ok(independent.members.every(member=>!member.sessionId));
  const start=requests.length;await page.getByRole('textbox',{name:'群聊消息',exact:true}).fill('独立事项：只讨论八万元分期交付');await page.getByRole('textbox',{name:'群聊消息',exact:true}).press('Enter');
  await expect(page.getByTestId('group-discussion-state')).toContainText('参与部门已达成共识',{timeout:30000});
  assert.ok(!requests[start].includes('继续评估但各部门仍有分歧'));
  const originalAfter=await api(`/api/agent-groups/${group.id}`);assert.equal(originalAfter.messages.length,count);
  await page.reload();await expect(page.locator('.summary-message')).toHaveCount(1);
  await page.locator('.group-conversation-bar .n-select').click();await page.locator('.n-base-select-option:visible').filter({hasText:original.conversations.find(c=>c.id===group.id).title}).click();
  await expect(page.locator('.group-message')).toHaveCount(count);
  await page.locator('.group-conversation-bar .n-select').click();await page.locator('.n-base-select-option:visible').filter({hasText:'独立事项：只讨论八万元分期交付'}).click();
  await expect(page.locator('.summary-message')).toHaveCount(1);
  await page.screenshot({path:join(out,'agent-group-conversations.png'),fullPage:true,animations:'disabled'});
 });
 await check('移动端主持状态与最终汇总不挤走输入框',async()=>{
  await page.setViewportSize({width:390,height:844});await expect.poll(()=>page.locator('.app-sider').evaluate(el=>el.getBoundingClientRect().right)).toBeLessThanOrEqual(1);
  await expect(page.getByRole('textbox',{name:'群聊消息',exact:true})).toBeInViewport();
  const before=await page.locator('.group-composer').boundingBox();await page.getByTestId('group-messages').evaluate(el=>{el.scrollTop=0;});
  const after=await page.locator('.group-composer').boundingBox();assert.ok(Math.abs(before.y-after.y)<1);assert.ok(after.y+after.height<=845);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:join(out,'agent-group-moderated-mobile.png'),fullPage:true,animations:'disabled'});
 });
 assert.deepEqual(errors,[]);console.log(`主持群聊端到端：${passed} 组通过（真实 Pi + 本机假模型，临时 SQLite）`);
} catch(error) {
 if(page)console.error(await page.locator('.group-message').allTextContents());
 if(page)await page.screenshot({path:join(out,'agent-group-moderated-failure.png'),fullPage:true,animations:'disabled'}).catch(()=>{});
 throw error;
} finally {
 if(browser)await browser.close();if(child){child.kill();await Promise.race([new Promise(resolve=>child.once('exit',resolve)),delay(5000)]);}
 await new Promise(resolve=>model.close(resolve));rmSync(dir,{recursive:true,force:true});
}
