import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';

const dir=mkdtempSync(join(tmpdir(),'biz-memory-ownership-'));
const dbPath=join(dir,'required.db');
const password=randomUUID();
const email='memory-owner@example.invalid';
const socket=createServer();
await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));
const port=socket.address().port;
await new Promise(resolve=>socket.close(resolve));
const base=`http://127.0.0.1:${port}`;
const child=spawn(process.execPath,['--import','tsx','server/index.ts'],{windowsHide:true,stdio:'ignore',env:{...process.env,PORT:String(port),DB_PATH:dbPath,DATABASE_URL:'',LLM_DISABLE:'1',AUTH_MODE:'required',AUTH_SECRET:randomUUID(),SECRET_KEY:randomUUID(),AUTH_BOOTSTRAP_EMAIL:email,AUTH_BOOTSTRAP_PASSWORD:password,DINGTALK_TRANSPORT:'fake'}});
let passed=0;
async function check(name,fn){await fn();passed++;console.log(`  ✓ ${name}`);}
async function request(path,token,method='GET',body){return fetch(base+path,{method,headers:{...(token?{Authorization:`Bearer ${token}`} :{}),'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});}
async function call(path,token,method='GET',body){const response=await request(path,token,method,body);assert.ok(response.ok,`${method} ${path}: HTTP ${response.status}`);return response.json();}
try{
 let ready=false;
 for(let attempt=0;attempt<450;attempt++){if(child.exitCode!==null)throw new Error(`临时服务退出：${child.exitCode}`);try{if((await fetch(base+'/api/health')).ok){ready=true;break;}}catch{}await delay(200);}
 assert.ok(ready,'临时服务启动超时');
 const owner=(await call('/api/auth/login',null,'POST',{email,password})).token;
 const otherEmail='memory-developer@example.invalid';
 await call('/api/auth/users',owner,'POST',{email:otherEmail,password,role:'developer'});
 const other=(await call('/api/auth/login',null,'POST',{email:otherEmail,password})).token;
 const a=await call('/api/sessions',owner,'POST',{workflowId:'auto-flow'});
 const b=await call('/api/sessions',other,'POST',{workflowId:'auto-flow'});
 await check('会话列表仅显示本人，owner管理员也不能读取他人私有会话',async()=>{
  assert.deepEqual((await call('/api/sessions',owner)).map(s=>s.id),[a.id]);
  assert.deepEqual((await call('/api/sessions',other)).map(s=>s.id),[b.id]);
  assert.equal((await request(`/api/sessions/${a.id}`,other)).status,404);
  assert.equal((await request(`/api/sessions/${b.id}`,owner)).status,404);
 });
 await check('他人不能发送、导出、订阅、分叉、修改或删除私有会话',async()=>{
  for(const suffix of ['', '/events','/export','/export-html','/pi-tree','/pi-stats']) assert.equal((await request(`/api/sessions/${a.id}${suffix}`,other)).status,404,suffix);
  for(const suffix of ['/messages','/skills','/approve','/permissions','/stop','/thinking','/plan','/compact','/model','/clone','/fork','/pi-reload','/pi-tree/label','/pi-tree/navigate']) assert.equal((await request(`/api/sessions/${a.id}${suffix}`,other,'POST',{})).status,404,suffix);
  assert.equal((await request(`/api/sessions/${a.id}`,other,'PATCH',{title:'越权'})).status,404);
  assert.equal((await request(`/api/sessions/${a.id}`,other,'DELETE')).status,404);
  assert.equal((await request(`/api/sessions/${a.id}`,owner)).status,200);
 });
 await check('批量清理只删除本人会话，不影响其它用户',async()=>{
  assert.equal((await call('/api/sessions',other,'DELETE')).removed,1);
  assert.equal((await request(`/api/sessions/${a.id}`,owner)).status,200);
  assert.deepEqual(await call('/api/sessions',other),[]);
 });
 await check('旧的无归属会话和内部群聊会话不能通过普通接口访问',async()=>{
  const legacy=await call('/api/sessions',owner,'POST',{workflowId:'auto-flow'});
  const internal=await call('/api/sessions',owner,'POST',{workflowId:'auto-flow'});
  const raw=new DatabaseSync(dbPath);
  try{for(const [id,patch] of [[legacy.id,{createdBy:null}],[internal.id,{internalGroupSession:true}]]){const row=raw.prepare('SELECT payload FROM sessions WHERE id=?').get(id);const payload={...JSON.parse(row.payload),...patch};raw.prepare('UPDATE sessions SET payload=? WHERE id=?').run(JSON.stringify(payload),id);}}finally{raw.close();}
  for(const id of [legacy.id,internal.id]){assert.equal((await request(`/api/sessions/${id}`,owner)).status,404);assert.equal((await request(`/api/sessions/${id}/export`,owner)).status,404);}
  assert.deepEqual((await call('/api/sessions',owner)).map(s=>s.id),[a.id]);
 });
 await check('个人记忆接口不接受owner冒充，越权更新删除均404',async()=>{
  const memory=await call('/api/memories',owner,'POST',{content:'个人确认偏好',source:'用户确认'});
  assert.deepEqual((await call('/api/memories?ownerId=ignored',other)).items,[]);
  assert.equal((await request(`/api/memories/${memory.id}`,other,'PATCH',{content:'越权'})).status,404);
  assert.equal((await request(`/api/memories/${memory.id}`,other,'DELETE')).status,404);
 });
 await check('审批待办和处理同样限定会话创建者',async()=>{
  const approval=await call('/api/sessions',owner,'POST',{workflowId:'approval-flow'});
  await call(`/api/sessions/${approval.id}/messages`,owner,'POST',{text:'提交差旅报销'});
  let pending;
  for(let attempt=0;attempt<100;attempt++){pending=(await call('/api/approvals',owner)).items.find(item=>item.sessionId===approval.id);if(pending)break;await delay(100);}
  assert.ok(pending,'审批待办未出现');
  assert.equal((await call('/api/approvals',other)).items.length,0);
  assert.equal((await request(`/api/approvals/${approval.id}`,other,'POST',{requestId:pending.requestId,approved:true})).status,404);
  assert.equal((await request(`/api/approvals/${approval.id}`,owner,'POST',{requestId:pending.requestId,approved:false})).status,200);
 });
 console.log(`长期记忆会话所有权端到端：${passed} 组通过`);
}finally{
 if(child.exitCode===null){const stopped=new Promise(resolve=>child.once('exit',resolve));child.kill();await stopped;}
 rmSync(dir,{recursive:true,force:true});
}
