import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { assistantText, evaluateToolSelection, evaluateRecall, evaluateGroup, numericMetrics, failureReason, summarize, selectCases } from './real-model-eval-core.mjs';

// No model requests or database changes without explicit opt-in.
if (process.env.REAL_EVAL !== '1') {
 console.log('真实模型验收未运行：请显式设置 REAL_EVAL=1。将使用临时数据库，调用已配置的环境模型并产生费用。');
 process.exit(0);
}
const localFixture = process.env.REAL_EVAL_LOCAL_FIXTURE === '1';
const output = resolve(process.env.REAL_EVAL_OUT?.trim() || (localFixture ? 'data/real-eval-fixture' : 'data/real-eval'));
const results = [];
const runStarted = Date.now();
let cases = [], directory, child, childError, base, activeSession, activeGroup;
let caseTimeout = 180_000, deadline = Infinity, stage = 'configuration';
const startup = { status: 'pending' };
const cleanup = { serverStopped: true, temporaryDataRemoved: true };

function timeoutSetting(name, fallback, minimum, maximum) {
 const value = Number(process.env[name] ?? fallback);
 if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error('invalid_timeout');
 return value;
}
async function request(path, body, method = body === undefined ? 'GET' : 'POST', timeoutMs = 3000) {
 try {
  const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' },
   ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(Math.max(1, Math.floor(timeoutMs))) });
  if (!response.ok) throw new Error(`http_${response.status}`);
  return await response.json();
 } catch (error) {
  if (error.name === 'TimeoutError' || error.name === 'AbortError') throw new Error('request_timeout');
  throw error;
 }
}
async function api(path, body, method) {
 const remaining = deadline - Date.now();
 if (remaining <= 0) throw new Error('case_timeout');
 try { return await request(path, body, method, Math.min(remaining, caseTimeout)); }
 catch (error) { if (Date.now() >= deadline) throw new Error('case_timeout'); throw error; }
}
async function createSession(agentId) {
 const session = await api('/api/sessions', { workflowId: 'auto-flow', ...(agentId ? { agentId } : {}) });
 if (session.mode !== 'live') throw new Error('real_model_required');
 activeSession = session.id;
 return session.id;
}
async function send(id, text) {
 const before = await api(`/api/sessions/${id}`);
 const assistantCount = before.transcript.filter(entry => entry.role === 'assistant').length;
 await api(`/api/sessions/${id}/messages`, { text });
 while (Date.now() < deadline) {
  const view = await api(`/api/sessions/${id}`);
  if (view.pendingApprovals?.length) throw new Error('unexpected_approval');
  if (!view.running) {
   if (view.transcript.filter(entry => entry.role === 'assistant').length > assistantCount) {
    if (!assistantText(view).trim()) throw new Error('empty_answer');
    return view;
   }
   // Failed turns emit error without adding an assistant transcript entry.
   const traceId = view.traceIds?.at(-1);
   if (traceId && !(before.traceIds ?? []).includes(traceId)) {
    try {
     const detail = await api(`/api/monitor/traces/${encodeURIComponent(traceId)}`);
     if (detail.trace?.error) throw new Error(failureReason(detail.trace.error));
    } catch (error) {
     if (!/^http_/.test(error.message)) throw error;
    }
   }
   throw new Error('model_or_runtime_failed');
  }
  await delay(Math.min(200, Math.max(1, deadline - Date.now())));
 }
 throw new Error('case_timeout');
}
async function stats(id) { return numericMetrics(await api(`/api/sessions/${id}/pi-stats`)); }
async function stopActiveWork() {
 const stops = [];
 if (activeSession) stops.push(request(`/api/sessions/${activeSession}/stop`, {}, 'POST').then(() => ({ target: 'session', acknowledged: true }), () => ({ target: 'session', acknowledged: false })));
 if (activeGroup) stops.push(request(`/api/agent-groups/${activeGroup}/cancel`, {}, 'POST').then(() => ({ target: 'group', acknowledged: true }), () => ({ target: 'group', acknowledged: false })));
 return Promise.all(stops);
}
async function waitForExit(process, timeoutMs) {
 if (!process.pid || process.exitCode !== null || process.signalCode !== null) return true;
 return new Promise(resolve => {
  const finish = () => { clearTimeout(timer); resolve(true); };
  const timer = setTimeout(() => { process.removeListener('exit', finish); resolve(false); }, timeoutMs);
  process.once('exit', finish);
 });
}

try {
 try { cases = selectCases(process.env.REAL_EVAL_CASES); } catch { throw new Error('invalid_cases'); }
 caseTimeout = timeoutSetting('REAL_EVAL_TIMEOUT_MS', 180_000, 10_000, 600_000);
 const startupTimeout = timeoutSetting('REAL_EVAL_STARTUP_TIMEOUT_MS', 90_000, 1000, 180_000);
 if (localFixture) {
  const endpoint = new URL(process.env.LLM_BASE_URL ?? 'http://invalid');
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname)) throw new Error('local_fixture_requires_loopback');
 }
 stage = 'startup';
 directory = await mkdtemp(join(tmpdir(), 'biz-real-eval-'));
 const socket = createServer();
 await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
 const port = socket.address().port;
 await new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
 base = `http://127.0.0.1:${port}`;
 child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
  windowsHide: true, stdio: 'ignore', env: { ...process.env, PORT: String(port), DB_PATH: join(directory, 'evaluation.db'), DATABASE_URL: '',
   AUTH_MODE: 'off', AUTH_SECRET: randomUUID(), SECRET_KEY: randomUUID(), LLM_DISABLE: '0', LLM_MAX_RETRIES: '0',
   LLM_TIMEOUT_MS: String(Math.min(caseTimeout, 90_000)), DINGTALK_TRANSPORT: 'fake', WECOM_TRANSPORT: 'fake' },
 });
 child.once('error', error => { childError = error; });
 const startupStarted = Date.now(), startupDeadline = startupStarted + startupTimeout;
 let ready = false;
 while (Date.now() < startupDeadline) {
  if (childError) throw new Error('spawn_failed');
  if (child.exitCode !== null || child.signalCode !== null) throw new Error('isolated_server_failed');
  try {
   const health = await request('/api/health', undefined, 'GET', Math.min(1500, startupDeadline - Date.now()));
   if (health.ok) {
    if (health.model?.mode !== 'live') throw new Error('real_model_required');
    ready = true; break;
   }
  } catch (error) { if (error.message === 'real_model_required') throw error; }
  await delay(200);
 }
 if (!ready) throw new Error('isolated_server_timeout');
 Object.assign(startup, { status: 'passed', durationMs: Date.now() - startupStarted });
 for (const id of cases) {
  const started = Date.now(); deadline = started + caseTimeout; activeSession = undefined; activeGroup = undefined;
  try {
   let criteria, metrics;
   stage = 'create_session';
   if (id === 'tool-selection') {
    const session = await createSession(); stage = 'tool_selection';
    criteria = evaluateToolSelection(await send(session, '请使用合适的销售分析技能，统计已支付订单按区域的金额汇总。数字必须来自实际工具，最后给出简短结论。'));
    metrics = await stats(session);
   } else if (id === 'constraint-memory' || id === 'compaction-memory') {
    let agentId;
    if (id === 'compaction-memory') {
     const agent = await api('/api/agents', { name: '压缩验收', memoryConfig: { keepRecentTokens: 0 } });
     await api(`/api/agents/${agent.id}/actions`, { action: 'publish' }); agentId = agent.id;
    }
    const session = await createSession(agentId);
    const code = `EVAL-${randomUUID().slice(0, 8)}`, budget = 18000;
    stage = 'record_constraint';
    await send(session, `本次项目代号 ${code}，预算上限 ${budget} 元。这是不可更改的约束。只回复已记录，不要调用工具。`);
    stage = 'record_delivery';
    await send(session, '补充：需要分两期交付，先做验收清单。只回复已记录，不要调用工具。');
    if (id === 'compaction-memory') {
     stage = 'compaction';
     await api(`/api/sessions/${session}/compact`, {});
     const compacted = await api(`/api/sessions/${session}`);
     if (!compacted.compactedAt || !compacted.summary) throw new Error('compaction_not_performed');
    }
    stage = 'recall';
    criteria = evaluateRecall(await send(session, '请回忆项目代号和预算上限，金额只用阿拉伯数字表示。不要调用工具。'), code, budget);
    metrics = await stats(session);
    if (id === 'compaction-memory') metrics.compactionKeepRecentTokens = 0;
   } else {
    const agents = [];
    for (const name of ['验收主持', '验收销售', '验收财务']) {
     const agent = await api('/api/agents', { name, description: '隔离真实模型验收，讨论预算与交付，不执行业务写入。' });
     await api(`/api/agents/${agent.id}/actions`, { action: 'publish' }); agents.push(agent);
    }
    const group = await api('/api/agent-groups', { name: '隔离模型协作验收', agentIds: agents.map(agent => agent.id),
     collaboration: { mode: 'moderated', hostAgentId: agents[0].id, maxRounds: 1, maxCalls: 6 } });
    activeGroup = group.id; stage = 'group_discussion';
    const view = await api(`/api/agent-groups/${group.id}/turns`, { message: '预算上限18000元，分两期交付。请销售与财务都评审，财务明确核对预算。意见不足就记录分歧，不要虚构共识。只讨论，不执行任何业务操作。' });
    criteria = evaluateGroup(view);
    metrics = { agentInvocations: view.turns.at(-1)?.discussion?.calls ?? null, invocationBasis: 'group_scheduler' };
   }
   results.push({ id, status: criteria.every(item => item.passed) ? 'passed' : 'failed', durationMs: Date.now() - started, criteria, metrics });
  } catch (error) {
   const failure = { id, status: 'failed', durationMs: Date.now() - started, reason: failureReason(error), stage };
   failure.stopRequests = await stopActiveWork();
   if (activeSession) {
    try { failure.metrics = numericMetrics(await request(`/api/sessions/${activeSession}/pi-stats`)); }
    catch { failure.metricsUnavailable = true; }
   }
   results.push(failure);
  }
  console.log(`${results.at(-1).status === 'passed' ? '✓' : '✗'} ${id} (${results.at(-1).durationMs}ms)${results.at(-1).reason ? ` ${results.at(-1).reason}` : ''}`);
 }
} catch (error) {
 Object.assign(startup, { status: 'failed', reason: failureReason(error), stage, durationMs: Date.now() - runStarted });
 for (const id of cases) if (!results.some(result => result.id === id)) results.push({ id, status: 'skipped', reason: 'startup_failed' });
 console.error(`隔离验收未完成：${startup.reason}`);
} finally {
 if (child?.pid && child.exitCode === null && child.signalCode === null) {
  child.kill();
  cleanup.serverStopped = await waitForExit(child, 5000);
  if (!cleanup.serverStopped) { child.kill('SIGKILL'); cleanup.serverStopped = await waitForExit(child, 3000); }
 }
 if (directory) {
  cleanup.temporaryDataRemoved = false;
  if (cleanup.serverStopped) {
   try { await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); cleanup.temporaryDataRemoved = true; }
   catch { /* Report failed cleanup instead of hiding it or printing private paths. */ }
  }
 }
 const report = { schemaVersion: 2, mode: localFixture ? 'local-fake' : 'real', createdAt: new Date().toISOString(), isolatedDatabase: true, durationMs: Date.now() - runStarted,
  status: startup.status === 'passed' && results.every(result => result.status === 'passed') && cleanup.serverStopped && cleanup.temporaryDataRemoved ? 'passed' : 'failed',
  startup, cleanup, summary: summarize(results), results };
 try {
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'latest.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`${localFixture ? '本机假模型框架验证' : '真实模型验收'}：${report.summary.passed}/${report.summary.executed}，报告 ${join(output, 'latest.json')}`);
 } catch { console.error('验收报告写入失败。'); process.exitCode = 1; }
 if (report.status !== 'passed') process.exitCode = 1;
}
