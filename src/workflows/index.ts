/**
 * 流程注册出口：平台里"内置流程"与"工具目录"的唯一真相来源。
 *
 * 平台支持两种流程：
 *   ① 内置流程（代码）：写工具 + 写流程定义 + 加进 `workflowList`，随代码发布
 *   ② 自定义流程（运行时）：控制台新建，定义存 SQLite，只按名字引用 `builtinToolFactories` 里的工具
 *
 * 无论哪种，副作用（工具）都只存在于代码里，流程只负责编排顺序。
 */

import type { ToolFactory } from "../core/catalog.js";
import type { WorkflowDef } from "../core/types.js";
import { createApprovalTools } from "../tools/approval.js";
import { createDataTools } from "../tools/data.js";
import { createTicketTools } from "../tools/ticket.js";
import { approvalWorkflow } from "./approval.js";
import { dataWorkflow } from "./data.js";
import { ticketWorkflow } from "./ticket.js";

/** 平台的全部业务能力；自定义流程只能在这个目录里按名字挑工具。 */
export const builtinToolFactories: ToolFactory[] = [createTicketTools, createDataTools, createApprovalTools];

/**
 * 自动编排：不预设步骤，也不预设要用哪些工具。
 *
 * 它是"新建会话不必先选流程"的入口——手上是全平台的能力 + 所有流程工具，
 * 由模型自己判断：简单的事直接调工具，整条的活就调 flow_xxx 把流程跑完。
 */
export const autoWorkflow: WorkflowDef = {
	id: "auto-flow",
	name: "自动编排",
	systemPrompt: [
		"你是企业业务总管，手上有全平台的能力：既能直接调用单个业务工具，也能调用 flow_xxx 把某条流程整条跑完。",
		"先判断用户的需求属于哪类业务。如果正好有一条流程能整条覆盖，就调用对应的 flow_xxx，把用户原话作为 task 传进去。",
		"如果只是简单查询或单步操作，直接调用具体业务工具即可，不必绕流程。",
		"信息不足时先问一个最关键的问题，不要瞎猜参数。",
	].join("\n"),
	steps: [],
	createTools: (store) => builtinToolFactories.flatMap((factory) => factory(store)),
	skill: {
		description:
			"没有预设步骤的通用能力：手上是整个工具目录。适合一次性查询/修改、或不确定该走哪条流程时的兜底。",
		instructions: [
			"你现在以「自动编排」技能工作：没有写死的步骤，自己判断怎么把事办成。",
			"",
			"判断顺序：",
			"- 一次查询或一次修改就能解决 → 直接调对应业务工具，不要加载别的技能；",
			"- 用户的诉求正好是某条完整流程（工单处理、销售数据分析、费用审批）→ 加载那条技能按步骤做，或调 flow_xxx 整条委托；",
			"- 信息不足 → 先问最关键的一个问题，不要瞎猜参数。",
			"",
			"收尾要求：办完用一段话汇报做了什么、结果是什么，不要只回「好的」。",
		].join("\n"),
	},
};

/**
 * 平台内置的全部流程；顺序即控制台里的展示顺序。
 * 「自动编排」排第一：新建会话时的默认选择是不选流程，让模型自己挑。
 */
export const workflowList: WorkflowDef[] = [autoWorkflow, ticketWorkflow, dataWorkflow, approvalWorkflow];

/**
 * 按 id 建索引。
 * id 重复会立即抛错——否则控制台会出现两条同名流程，排查起来比启动失败更难。
 */export function indexWorkflows(defs: WorkflowDef[] = workflowList): Record<string, WorkflowDef> {
	const map: Record<string, WorkflowDef> = {};
	for (const def of defs) {
		if (map[def.id]) {
			throw new Error(`流程 id 重复: ${def.id}`);
		}
		map[def.id] = def;
	}
	return map;
}

export { approvalWorkflow } from "./approval.js";
export { dataWorkflow } from "./data.js";
export { ticketWorkflow } from "./ticket.js";
