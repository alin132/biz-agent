/**
 * 流程即工具：把每条流程也包成一个工具，交给模型自己挑。
 *
 * 两种用法并存：
 *   - 用户在左栏选一条流程建会话 → 代码/用户决定走哪条（确定性优先）
 *   - 任何会话里调 `flow_xxx` 工具 → 模型自己决定走哪条（灵活性优先）
 *
 * 工具名只允许字母数字下划线，所以 workflowId 里的 `-` 要换成 `_`；
 * 这里的命名规则是唯一的真相，测试与 server 层都引用它。
 */

import type { WorkflowDef } from "./types.js";

export const FLOW_TOOL_PREFIX = "flow_";

/** `ticket-flow` → `flow_ticket_flow`。 */
export function flowToolName(workflowId: string): string {
	return `${FLOW_TOOL_PREFIX}${workflowId.replace(/[^a-zA-Z0-9_]/g, "_")}`;
}

/** 是不是"流程工具"（用来避免把流程工具注册进子 agent，造成递归）。 */
export function isFlowToolName(toolName: string): boolean {
	return toolName.startsWith(FLOW_TOOL_PREFIX);
}

/** 流程工具的入参 schema。 */
export function flowToolParameters(): Record<string, unknown> {
	return {
		type: "object",
		properties: {
			task: { type: "string", description: "要交给这条流程处理的业务请求，用自然语言描述" },
		},
		required: ["task"],
	};
}

/** 流程工具的描述：带流程名与步骤，模型才知道什么时候该挑它。 */
export function flowToolDescription(workflow: WorkflowDef): string {
	const steps = workflow.steps.map((step) => step.title).join(" → ");
	return `把「${workflow.name}」这条流程整条跑完（步骤：${steps}）。当用户的需求正好属于这条流程时调用它，把用户原话作为 task 传入。返回值是这条流程面向用户的执行结果，调用后请把它整理成回答，不要只回「好的」。`;
}
