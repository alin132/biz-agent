import assert from 'node:assert/strict';
import { evaluateToolSelection, evaluateRecall, evaluateGroup, numericMetrics, failureReason, summarize, selectCases } from './real-model-eval-core.mjs';

let passed = 0;
function check(name, fn) { fn(); passed++; console.log(`  ✓ ${name}`); }
const assistant = text => ({ transcript: [{ role: 'assistant', text }] });
const all = criteria => criteria.every(item => item.passed);
check('实际聚合工具和最终回答同时满足才成功', () => assert.ok(all(evaluateToolSelection({ ...assistant('结果'), audit: [{ toolName: 'data_aggregate', ok: true }] }))));
check('文字声称查询不能代替工具调用', () => assert.ok(!all(evaluateToolSelection({ ...assistant('我已经查询'), audit: [] }))));
check('失败工具不能算作成功执行', () => assert.ok(!all(evaluateToolSelection({ ...assistant('失败'), audit: [{ toolName: 'data_query', ok: false }] }))));
check('只查看结构不能算作完成销售统计', () => assert.ok(!all(evaluateToolSelection({ ...assistant('结果'), audit: [{ toolName: 'data_describe', ok: true }] }))));
check('保留项目代号与千分位或等值小数预算', () => { for (const amount of ['18,000', '18000.00']) assert.ok(all(evaluateRecall(assistant(`项目 EVAL-32，预算 ${amount} 元`), 'EVAL-32', 18000))); });
check('预算错误、数量级错误、负数和非等值小数均不能误判', () => { for (const amount of ['19000', '180000', '118000', '-18000', '−18000', '18000.5']) assert.ok(!all(evaluateRecall(assistant(`项目 EVAL-32，预算 ${amount} 元`), 'EVAL-32', 18000))); });
check('项目代号前后缀不允许模糊命中', () => { for (const code of ['EVAL-321', 'OTHER-EVAL-32']) assert.ok(!all(evaluateRecall(assistant(`项目 ${code}，预算18000元`), 'EVAL-32', 18000))); });
const group = { collaboration: { maxCalls: 6, hostAgentId: 'host' }, turns: [{ id: 't', status: 'completed', discussion: { outcome: 'round_limit', calls: 5 } }], messages: [
 { turnId: 't', agentId: 'a', metadata: { kind: 'reply' } }, { turnId: 't', agentId: 'b', metadata: { kind: 'reply' } }, { turnId: 't', metadata: { kind: 'summary' } },
] };
check('两个部门发言、主持汇总和调用预算完整验收', () => assert.ok(all(evaluateGroup(group))));
check('失败结局与超额调用不能通过', () => assert.ok(!all(evaluateGroup({ ...group, turns: [{ ...group.turns[0], discussion: { outcome: 'failed', calls: 7 } }] }))));
check('主持和无名发言不能冒充参与部门', () => assert.ok(!all(evaluateGroup({ ...group, messages: [{ turnId: 't', agentId: 'host', metadata: { kind: 'reply' } }, { turnId: 't', agentId: null, metadata: { kind: 'reply' } }, group.messages[2]] }))));
check('未知指标用null表示，不能伪造零消耗', () => assert.deepEqual(numericMetrics({}), { toolCalls: null, tokens: {}, cost: null, costBasis: 'pi_model_catalog_estimate' }));
check('数值指标限制白名单和有限非负数', () => assert.deepEqual(numericMetrics({ toolCalls: 2, tokens: { input: 20, output: 4, total: Infinity, private: 8 }, cost: -1 }), { toolCalls: 2, tokens: { input: 20, output: 4 }, cost: null, costBasis: 'pi_model_catalog_estimate' }));
check('错误报告只保留安全原因码', () => { assert.equal(failureReason(new Error('401 private-key-value')), 'model_authentication_failed'); assert.equal(failureReason('429 rate limit'), 'model_rate_limited'); assert.equal(failureReason('unavailable endpoint/private'), 'model_provider_unavailable'); assert.equal(failureReason('private unknown payload'), 'request_or_runtime_failed'); });
check('场景选择去重且拒绝未知项', () => { assert.deepEqual(selectCases('constraint-memory,tool-selection,constraint-memory'), ['constraint-memory', 'tool-selection']); assert.throws(() => selectCases('unknown'), /未知/); });
check('空报告没有伪造成功率', () => assert.deepEqual(summarize([]), { total: 0, executed: 0, passed: 0, failed: 0, skipped: 0, successRate: null, durationMs: 0 }));
check('跳过项目不计入成功或已执行', () => assert.deepEqual(summarize([{ status: 'passed', durationMs: 10 }, { status: 'failed', durationMs: 20 }, { status: 'skipped' }]), { total: 3, executed: 2, passed: 1, failed: 1, skipped: 1, successRate: 0.5, durationMs: 30 }));
console.log(`真实模型验收判定：${passed} 项通过（不调用模型）`);
