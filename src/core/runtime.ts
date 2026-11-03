/**
 * 运行时装配：把"业务流程配置"翻译成一个 Pi 的 Agent。
 *
 * 这里是全项目唯一接触 Pi 具体 API 的地方——五个能力各挂一个钩子：
 *   工具      → AgentTool[]
 *   权限审批  → beforeToolCall
 *   审计治理  → afterToolCall
 *   上下文    → transformContext
 *   流程编排  → finishTurn + prepareNextTurnWithContext
 *
 * 换业务流程不需要改这里，只换 WorkflowDef 和 ToolRegistry。
 */

import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentLoopTurnUpdate, AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import type { Model, SystemMessage } from "@earendil-works/pi-ai";
import { createAuditHook } from "./audit.js";
import { createContextTransformer } from "./context.js";
import { createPermissionHook } from "./permission.js";
import type { ToolRegistry } from "./registry.js";
import type { BizContext, WorkflowDef } from "./types.js";
import { WorkflowEngine } from "./workflow.js";

export interface CreateBusinessAgentOptions {
	workflow: WorkflowDef;
	registry: ToolRegistry;
	ctx: BizContext;
	model: Model<any>;
	streamFn: StreamFn;
	/** 最大工具轮次，防止流程卡死时无限循环。 */
	maxTurns?: number;
	/** 上下文滑动窗口大小。 */
	maxContextMessages?: number;
	/** 可选的流程引擎；不传则内部创建。 */
	engine?: WorkflowEngine;
	/** 恢复历史对话时传入已持久化的消息，让模型保留上下文。 */
	messages?: AgentMessage[];
}

export interface BusinessAgent {
	agent: Agent;
	engine: WorkflowEngine;
	/** 当前系统提示词（含流程步骤），便于排查。 */
	systemPrompt: string;
}

/** 把流程步骤渲染进系统提示词。 */
function buildSystemPrompt(workflow: WorkflowDef): string {
	const steps = workflow.steps.map((step, index) => {
		const tools = step.via.join(" / ");
		return `${index + 1}. ${step.title}（工具：${tools}）`;
	});

	return [
		workflow.systemPrompt,
		"",
		`# 业务流程：${workflow.name}`,
		"",
		"必须按以下顺序推进，每一步用一个工具完成：",
		...steps,
		"",
		"规则：",
		"- 一次只推进一个步骤，不要跳步。",
		"- 上一步成功后立刻进行下一步，不要停下来问用户。",
		"- 全部步骤完成后，用一段话汇报结果，不要再调用任何工具。",
	].join("\n");
}

export function createBusinessAgent(options: CreateBusinessAgentOptions): BusinessAgent {
	const { workflow, registry, ctx, model, streamFn } = options;
	const maxTurns = options.maxTurns ?? 20;
	const maxContextMessages = options.maxContextMessages ?? 40;

	// 允许外部传入引擎，便于调用方（如 Web 会话）读取流程状态或给模型脚本注入步骤。
	const engine = options.engine ?? new WorkflowEngine(workflow);
	const toolNames = [...new Set(workflow.steps.flatMap((step) => step.via))];
	const tools = registry.toAgentTools(toolNames, ctx);
	const systemPrompt = buildSystemPrompt(workflow);

	let turns = 0;
	let lastTurnHadError = false;

	const agent = new Agent({
		initialState: {
			systemPrompt,
			model,
			tools,
			// 有历史消息就恢复上下文；此时系统提示词来自历史里的第一条 system 消息
			...(options.messages && options.messages.length > 0 ? { messages: options.messages } : {}),
		},
		streamFn,
		transformContext: createContextTransformer({ maxMessages: maxContextMessages }),
		beforeToolCall: createPermissionHook(ctx, registry),
		afterToolCall: createAuditHook(ctx),
		finishTurn: (turn) => {
			for (const result of turn.toolResults) {
				engine.recordToolResult(result.toolName, !result.isError);
			}

			const hasToolCalls = turn.toolResults.length > 0;
			const hadError = turn.toolResults.some((result) => result.isError);

			// 这一轮模型没调工具，说明它想收尾了。
			if (!hasToolCalls) {
				// 流程已走完 → 这就是总结，结束。
				if (engine.done) return { action: "end" };
				// 上一步工具失败，模型选择说明原因 → 尊重它，结束。
				if (lastTurnHadError) return { action: "end" };
				// 否则说明模型提前停了，继续逼它推进流程。
			} else if (engine.done) {
				// 刚做完最后一步，再给一轮机会写总结。
				lastTurnHadError = hadError;
				return { action: "continue" };
			}

			lastTurnHadError = hadError;
			turns++;
			return turns >= maxTurns ? { action: "end" } : { action: "continue" };
		},
		prepareNextTurnWithContext: (): AgentLoopTurnUpdate => {
			const nudge: SystemMessage = {
				role: "system",
				content: engine.nextPrompt(),
				timestamp: Date.now(),
			};
			return { messages: [nudge] };
		},
	});

	return { agent, engine, systemPrompt };
}

/** 订阅 agent 事件，把流式文本打到 stdout。返回取消订阅函数。 */
export function pipeTextToStdout(agent: Agent): () => void {
	return agent.subscribe((event) => {
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			process.stdout.write(event.assistantMessageEvent.delta);
		}
	});
}
