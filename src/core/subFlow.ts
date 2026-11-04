/**
 * 子流程执行：把一个流程当成"工具"整条跑一遍。
 *
 * 这是「流程即工具」的实现核心——外层会话的模型调用 `flow_xxx` 时，
 * 这里起一个内层 agent 把目标流程从头跑到尾，把最后的汇报文本还回去。
 *
 * 内层只装目标流程自己的工具（不装流程工具），所以不会自我递归；
 * ctx / store 与外层共用，审批事件、审计流水、业务数据都落在同一次会话里。
 */

import type { Agent, StreamFn } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { Store } from "../store/memory.js";
import { ToolRegistry } from "./registry.js";
import { createBusinessAgent } from "./runtime.js";
import type { BizContext, WorkflowDef } from "./types.js";
import { WorkflowEngine } from "./workflow.js";

export interface SubFlowOptions {
	workflow: WorkflowDef;
	store: Store;
	ctx: BizContext;
	model: Model<any>;
	streamFn: StreamFn;
	/** 要交给这条流程处理的业务请求。 */
	task: string;
	maxTurns?: number;
}

export interface SubFlowResult {
	/** 内层 agent 的最后一段汇报文本。 */
	text: string;
	/** 目标流程是否真的走完了全部步骤。 */
	done: boolean;
	engine: WorkflowEngine;
	agent: Agent;
}

export async function runSubWorkflow(options: SubFlowOptions): Promise<SubFlowResult> {
	const { workflow, store, ctx, model, streamFn } = options;
	const engine = new WorkflowEngine(workflow);
	const registry = new ToolRegistry().registerAll(workflow.createTools(store));
	const nested = createBusinessAgent({
		workflow,
		registry,
		ctx,
		model,
		streamFn,
		engine,
		maxTurns: options.maxTurns ?? 12,
	});

	await nested.agent.prompt(options.task);

	return { text: lastAssistantTextOf(nested.agent), done: engine.done, engine, agent: nested.agent };
}

/** 从后往前找最后一条助手文本。 */
export function lastAssistantTextOf(agent: Agent): string {
	const messages = agent.state.messages;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]!;
		if (message.role === "assistant") {
			return message.content
				.filter((block) => block.type === "text")
				.map((block) => (block as { text: string }).text)
				.join("");
		}
	}
	return "";
}
