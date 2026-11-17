export const CASE_IDS = ['tool-selection', 'constraint-memory', 'compaction-memory', 'group-collaboration'];

export function assistantText(view) {
	return (view.transcript ?? []).filter(entry => entry.role === 'assistant').at(-1)?.text ?? '';
}

export function evaluateToolSelection(view) {
	const calls = (view.audit ?? []).filter(entry => entry.ok);
	return [
		{ name: '已实际查询或聚合销售数据，或委托销售技能', passed: calls.some(entry => /^(data_query|data_aggregate|flow_data_flow)$/.test(entry.toolName)) },
		{ name: '给出非空最终回答', passed: assistantText(view).trim().length > 0 },
	];
}

export function evaluateRecall(view, code, budget) {
	const answer = assistantText(view);
	const escapedCode = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return [
		{ name: '保留项目代号', passed: new RegExp(`(^|[^A-Za-z0-9_-])${escapedCode}(?![A-Za-z0-9_-])`).test(answer) },
		{ name: '保留预算约束', passed: new RegExp(`(^|[^0-9.−-])${budget}(?:\\.0+)?(?![0-9.])`).test(answer.replaceAll(',', '').replaceAll('，', '')) },
	];
}

export function evaluateGroup(view) {
	const turn = view.turns?.at(-1);
	const discussion = turn?.discussion;
	const messages = (view.messages ?? []).filter(message => message.turnId === turn?.id);
	const participantReplies = new Set(messages.filter(message => message.metadata?.kind === 'reply' && !message.isError && message.agentId && message.agentId !== view.collaboration?.hostAgentId).map(message => message.agentId));
	return [
		{ name: '讨论成功结束或明确达到预算', passed: turn?.status === 'completed' && ['consensus', 'round_limit', 'call_limit'].includes(discussion?.outcome) },
		{ name: '至少两个部门实际发言', passed: participantReplies.size >= 2 },
		{ name: '主持产生最终汇总', passed: messages.some(message => message.metadata?.kind === 'summary' && !message.isError) },
		{ name: '调用次数不超过配置上限', passed: Number.isInteger(discussion?.calls) && discussion.calls <= (view.collaboration?.maxCalls ?? 0) },
	];
}

export function numericMetrics(value) {
	const valid = number => typeof number === 'number' && Number.isFinite(number) && number >= 0;
	return {
		toolCalls: Number.isInteger(value?.toolCalls) && value.toolCalls >= 0 ? value.toolCalls : null,
		tokens: Object.fromEntries(['input', 'output', 'cacheRead', 'cacheWrite', 'total'].filter(name => valid(value?.tokens?.[name])).map(name => [name, value.tokens[name]])),
		cost: valid(value?.cost) ? value.cost : null,
		costBasis: 'pi_model_catalog_estimate',
	};
}

export function failureReason(error) {
	const message = typeof error === 'string' ? error : error?.message ?? '';
	const known = /^(case_timeout|request_timeout|http_\d{3}|real_model_required|unexpected_approval|empty_answer|compaction_not_performed|model_or_runtime_failed|isolated_server_failed|isolated_server_timeout|invalid_cases|invalid_timeout|local_fixture_requires_loopback|spawn_failed|group_execution_failed)$/;
	if (known.test(message)) return message;
	if (/\b401\b|\b403\b|unauthorized|invalid.*key|authentication/i.test(message)) return 'model_authentication_failed';
	if (/\b429\b|rate.?limit/i.test(message)) return 'model_rate_limited';
	if (/timeout|timed.?out|超时/i.test(message) || error?.name === 'TimeoutError') return 'model_timeout';
	if (/\b5\d\d\b|overloaded|unavailable/i.test(message)) return 'model_provider_unavailable';
	return 'request_or_runtime_failed';
}

export function summarize(results) {
	const completed = results.filter(result => result.status !== 'skipped');
	const passed = completed.filter(result => result.status === 'passed').length;
	return { total: results.length, executed: completed.length, passed, failed: completed.length - passed,
		skipped: results.length - completed.length, successRate: completed.length ? passed / completed.length : null,
		durationMs: results.reduce((total, result) => total + (result.durationMs ?? 0), 0) };
}

export function selectCases(value) {
	const selected = value ? value.split(',').map(id => id.trim()).filter(Boolean) : CASE_IDS;
	if (!selected.length || selected.some(id => !CASE_IDS.includes(id))) throw new Error('未知验收场景');
	return [...new Set(selected)];
}
