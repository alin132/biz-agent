import type { AgentRecord } from "../db/types.js";

export interface AgentCheckIssue {
	code: string;
	level: "error" | "warning";
	message: string;
}

export interface AgentPreflight {
	agentId: string;
	checkedAt: number;
	ready: boolean;
	issues: AgentCheckIssue[];
}

export interface AgentCheckDependencies {
	model: (id?: string) => { mode: "live" | "simulated" | "fallback"; error?: string; contextWindow?: number };
	skillAvailable: (id: string) => boolean;
	knowledgeBases: () => { id: string; documentCount: number }[];
	mcpServers: () => { name: string; enabled: boolean; lastStatus: string | null }[];
}

/** 只检查本地配置与最近发现状态，不进行网络探测。 */
export function checkAgentConfiguration(agent: AgentRecord, deps: AgentCheckDependencies): AgentCheckIssue[] {
	const issues: AgentCheckIssue[] = [];
	const add = (code: string, level: AgentCheckIssue["level"], message: string) => issues.push({ code, level, message });
	const model = deps.model(agent.modelConfig.chatModelId || undefined);
	if (model.error) add("model_unavailable", "error", model.error);
	else if (model.mode === "simulated") add("simulated_model", "warning", "当前使用模拟模型，只能演示，无法验证真实推理与工具选择。请在模型管理中配置并测试真实模型。");
	else if (model.mode === "fallback") add("fallback_model", "warning", "尚未选择可用的入库模型，将回落到服务端默认配置；未配置默认模型时使用模拟模式。请通过试聊确认实际效果。");
	else add("model_connectivity_unverified", "warning", "模型配置检查通过；本次未请求外部服务，请在模型管理中测试连通性，并通过试聊确认效果。");
	if (!agent.agentsMd.trim()) add("persona_empty", "warning", "尚未填写人格与指令，建议明确职责、回答要求和操作边界。");
	for (const id of agent.skillIds) {
		if (!deps.skillAvailable(id)) add("skill_unavailable", "error", `绑定的技能「${id}」不存在、已停用或定义失效，请重新绑定。`);
	}
	const bases = deps.knowledgeBases();
	for (const id of agent.kbIds) {
		const kb = bases.find((item) => item.id === id);
		if (!kb) add("kb_missing", "error", `绑定的知识库「${id}」不存在，请重新绑定。`);
		else if (kb.documentCount === 0) add("kb_empty", "warning", `知识库「${id}」尚无文档，无法提供检索资料。`);
	}
	for (const server of deps.mcpServers()) {
		if (server.enabled && server.lastStatus !== "ok") add("mcp_unverified", "warning", `MCP 服务「${server.name}」尚未连接成功，依赖它的工具可能不可用。`);
	}
	const context = model.contextWindow;
	if (context && (agent.modelConfig.maxTokens ?? 0) > context) add("output_exceeds_context", "error", "最大输出 token 超过模型上下文容量，请调整模型策略。");
	if (context && (agent.memoryConfig.reserveTokens ?? 16384) >= context) add("compaction_reserve", "warning", "压缩预留 token 不小于模型上下文容量，建议调整记忆配置。");
	return issues;
}
