import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const directory = await mkdtemp(join(tmpdir(), 'biz-eval-integration-'));
const realReport = resolve('data/real-eval/latest.json');
const previousReport = existsSync(realReport) ? await readFile(realReport) : null;
const secret = 'fixture-private-value-must-never-be-reported';
let scenario = 'success', passed = 0, requests = 0;
const children = new Set();
const textOf = message => typeof message.content === 'string' ? message.content : (message.content ?? []).map(part => part.text ?? '').join('\n');
const model = createServer(async (req, res) => {
	try {
		assert.equal(req.url, '/v1/chat/completions');
		let raw = ''; for await (const chunk of req) raw += chunk;
		const body = JSON.parse(raw); requests++;
		if (scenario === 'auth-error') { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: `401 invalid API key ${secret}` } })); return; }
		if (scenario === 'hang') return;
		const prompt = textOf(body.messages.filter(message => message.role === 'user').at(-1));
		const context = body.messages.map(textOf).join('\n');
		const code = context.match(/EVAL-[a-f0-9]{8}/)?.[0] ?? 'missing-project-code';
		let content, toolCall;
		if (prompt.startsWith('BIZ_GROUP_HOST_PLAN')) {
			const members = JSON.parse(prompt.match(/部门目录：([^\n]+)/)[1]);
			content = JSON.stringify({ content: '请销售与财务核对预算', proposal: '预算18000元，分两期交付', agentIds: members.map(member => member.agentId) });
		} else if (prompt.startsWith('BIZ_GROUP_DEPARTMENT')) {
			content = JSON.stringify({ content: '已独立评审预算与交付安排', mentions: [], stance: 'agree', proposalId: 'round-1' });
		} else if (prompt.startsWith('BIZ_GROUP_HOST_SUMMARY')) {
			content = JSON.stringify({ summary: '预算18000元，分两期交付；已记录部门意见。', decisions: [], actionItems: [], unresolved: [] });
		} else if (prompt.includes('<conversation>')) {
			content = `## 项目约束\n项目 ${code}，预算上限18000元，分两期交付。`;
		} else if (prompt.includes('请回忆项目代号')) {
			content = `项目 ${code}，预算上限18000元。`;
		} else if (context.includes('统计已支付订单') && !body.messages.some(message => message.role === 'tool' && message.tool_call_id === 'fixture-aggregate')) {
			const toolNames = body.tools?.map(tool => tool.function.name) ?? [];
			assert.ok(toolNames.includes('data_aggregate'), 'fixture requires actual registered aggregation tool');
			toolCall = { index: 0, id: 'fixture-aggregate', type: 'function', function: { name: 'data_aggregate', arguments: JSON.stringify({ groupBy: 'region', metric: 'sum_amount' }) } };
		} else content = context.includes('统计已支付订单') ? '已基于实际工具汇总已支付订单。' : '已记录。';
		res.writeHead(200, { 'content-type': 'text/event-stream' });
		for (const payload of [
			{ choices: [{ index: 0, delta: toolCall ? { role: 'assistant', tool_calls: [toolCall] } : { role: 'assistant', content }, finish_reason: null }] },
			{ choices: [{ index: 0, delta: {}, finish_reason: toolCall ? 'tool_calls' : 'stop' }] },
			{ choices: [], usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } },
		]) res.write(`data: ${JSON.stringify(payload)}\n\n`);
		res.end('data: [DONE]\n\n');
	} catch { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'fixture_protocol_failed' } })); }
});
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));

async function run(name, extra = {}) {
	const output = join(directory, name);
	const child = spawn(process.execPath, ['scripts/real-model-eval.mjs'], {
		windowsHide: true, env: { ...process.env, REAL_EVAL: '1', REAL_EVAL_LOCAL_FIXTURE: '1', REAL_EVAL_OUT: output,
			REAL_EVAL_TIMEOUT_MS: '20000', REAL_EVAL_STARTUP_TIMEOUT_MS: '90000', REAL_EVAL_CASES: '',
			LLM_PROVIDER: 'deepseek', LLM_MODEL: 'deepseek-flash', LLM_BASE_URL: `http://127.0.0.1:${model.address().port}/v1`,
			LLM_API_KEY: secret, DEEPSEEK_API_KEY: secret, ...extra },
	});
	children.add(child);
	let stdout = '', stderr = '';
	child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
	const code = await new Promise((resolve, reject) => {
		const timer = setTimeout(() => { child.kill(); reject(new Error('evaluation_fixture_process_timeout')); }, 180_000);
		child.once('error', error => { clearTimeout(timer); reject(error); });
		child.once('exit', code => { clearTimeout(timer); children.delete(child); resolve(code); });
	});
	assert.ok(!stdout.includes(secret) && !stderr.includes(secret), '验收输出不能包含凭证或供应商原始错误内容');
	const reportPath = join(output, 'latest.json');
	const report = existsSync(reportPath) ? JSON.parse(await readFile(reportPath, 'utf8')) : null;
	assert.ok(!JSON.stringify(report).includes(secret));
	if (report) { assert.equal(report.mode, 'local-fake'); assert.deepEqual(report.cleanup, { serverStopped: true, temporaryDataRemoved: true }); }
	return { code, report };
}
async function check(name, fn) { await fn(); passed++; console.log(`  ✓ ${name}`); }
try {
	await check('默认不联网、不创建报告或数据库', async () => {
		const before = requests;
		const result = await run('disabled', { REAL_EVAL: '' });
		assert.equal(result.code, 0); assert.equal(result.report, null); assert.equal(requests, before);
	});
	await check('本机假模型走完整四场景并记录实际工具、token和压缩设置', async () => {
		const result = await run('success');
		assert.equal(result.code, 0, JSON.stringify(result.report?.results));
		assert.equal(result.report.status, 'passed'); assert.equal(result.report.summary.passed, 4);
		const tool = result.report.results.find(item => item.id === 'tool-selection');
		assert.equal(tool.metrics.toolCalls, 1); assert.ok(tool.metrics.tokens.total > 0);
		assert.equal(tool.metrics.costBasis, 'pi_model_catalog_estimate');
		assert.equal(result.report.results.find(item => item.id === 'compaction-memory').metrics.compactionKeepRecentTokens, 0);
	});
	await check('模型即时401错误尽早失败，报告归类且不泄漏原始错误', async () => {
		scenario = 'auth-error';
		const result = await run('auth-error', { REAL_EVAL_CASES: 'constraint-memory' });
		assert.equal(result.code, 1); assert.equal(result.report.status, 'failed');
		assert.equal(result.report.results[0].reason, 'model_authentication_failed');
		assert.ok(result.report.results[0].durationMs < 10000, '即时失败不应空等20秒案例超时');
		assert.deepEqual(result.report.results[0].stopRequests, [{ target: 'session', acknowledged: true }]);
	});
	await check('模型不回复时按案例预算超时并停止活动会话', async () => {
		scenario = 'hang';
		const result = await run('timeout', { REAL_EVAL_CASES: 'constraint-memory', REAL_EVAL_TIMEOUT_MS: '10000' });
		assert.equal(result.code, 1); assert.equal(result.report.results[0].reason, 'case_timeout');
		assert.ok(result.report.results[0].durationMs >= 9900 && result.report.results[0].durationMs < 15000);
		assert.deepEqual(result.report.results[0].stopRequests, [{ target: 'session', acknowledged: true }]);
	});
	await check('缺少可用环境模型时仍生成启动失败报告且场景不算执行', async () => {
		const before = requests;
		const result = await run('startup-failure', { LLM_PROVIDER: 'unsupported-fixture', REAL_EVAL_CASES: 'constraint-memory' });
		assert.equal(result.code, 1); assert.equal(result.report.startup.status, 'failed');
		assert.equal(result.report.startup.reason, 'real_model_required');
		assert.equal(result.report.summary.executed, 0); assert.equal(result.report.summary.skipped, 1);
		assert.equal(requests, before);
	});
	await check('非法场景在启动前报告，不发模型请求', async () => {
		const before = requests;
		const result = await run('invalid-case', { REAL_EVAL_CASES: 'unknown-fixture' });
		assert.equal(result.code, 1); assert.equal(result.report.startup.reason, 'invalid_cases'); assert.equal(requests, before);
	});
	if (previousReport) assert.ok(previousReport.equals(await readFile(realReport)), '本机假模型测试不可覆盖已有真实验收报告');
	console.log(`验收框架集成：${passed} 项通过（真实服务与 Pi + 本机假模型，不代表真实模型验收）`);
} finally {
	for (const child of children) child.kill();
	model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
	await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
