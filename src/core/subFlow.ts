/**
 * 子流程执行：把一个流程当成"工具"整条跑一遍。
 *
 * 这是「流程即工具」的实现核心——外层会话的模型调用 `flow_xxx` 时，
 * 这里起一个内层 agent 把目标流程从头跑到尾，把最后的汇报文本还回去。
 *
 * 内层只装目标流程自己的工具（不装流程工具），所以不会自我递归；
 * ctx / store 与外层共用，审批事件、审计流水、业务数据都落在同一次会话里。
 */

import type { Store } from "../store/memory.js";
import { ToolRegistry } from "./registry.js";
import { buildBusinessSystemPrompt } from "./runtime.js";
import { createWorkflowTurnPolicy } from "./workflowPolicy.js";
import type { BizContext, WorkflowDef } from "./types.js";
import type { ToolDef } from "./types.js";
import type { WorkflowToolResult } from "./workflowPolicy.js";
import { WorkflowEngine } from "./workflow.js";

export interface SubFlowOptions {
	workflow: WorkflowDef;
	store: Store;
	ctx: BizContext;
	/** 要交给这条流程处理的业务请求。 */
	task: string;
	maxTurns?: number;
	/** Host runtime owns agent/session construction; this module supplies only business policy and tools. */
	createSession(input: {
		systemPrompt: string;
		tools: ToolDef[];
		ctx: BizContext;
		workflow: {
			maxTurns: number;
			startRun(): void;
			finishTurn(toolResults: WorkflowToolResult[]): { continue: boolean; terminateTools: boolean };
			nextPrompt(): string;
			limitReached(): boolean;
		};
	}): Promise<{ prompt(text: string): Promise<void>; text(): string; dispose(): void }>;
}

export interface SubFlowResult {
	/** 内层 agent 的最后一段汇报文本。 */
	text: string;
	/** 目标流程是否真的走完了全部步骤。 */
	done: boolean;
	engine: WorkflowEngine;
}

export async function runSubWorkflow(options: SubFlowOptions): Promise<SubFlowResult> {
	const { workflow, store, ctx } = options;
	const engine = new WorkflowEngine(workflow);
	const registry = new ToolRegistry().registerAll(workflow.createTools(store));
	const tools = registry.select([...new Set(workflow.steps.flatMap((step) => step.via))]);
	const maxTurns = options.maxTurns ?? 12;
	const policy = createWorkflowTurnPolicy(engine, maxTurns);

	const session = await options.createSession({
		systemPrompt: buildBusinessSystemPrompt(workflow, []),
		tools,
		ctx,
		workflow: {
			maxTurns,
			startRun: policy.startRun,
			finishTurn: policy.finishTurn,
			nextPrompt: policy.nextPrompt,
			limitReached: policy.limitReached,
		},
	});
	try {
		await session.prompt(options.task);
		return { text: session.text(), done: engine.done, engine };
	} finally {
		session.dispose();
	}
}
