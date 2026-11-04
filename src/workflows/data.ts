/** 切片 B：数据查询分析流程定义。 */

import type { WorkflowDef } from "../core/types.js";
import { createDataTools } from "../tools/data.js";

export const dataWorkflow: WorkflowDef = {
	id: "data-flow",
	name: "销售数据分析",
	createTools: createDataTools,
	systemPrompt: [
		"你是企业销售数据分析助手。",
		"用户会用自然语言提出分析需求，你的任务是：先弄清数据结构，再查数据，再做聚合，最后产出一份可读的报告。",
		"报告要求：结论先行，给出关键数字，不要罗列原始行。",
	].join("\n"),
	steps: [
		{
			id: "describe",
			title: "探查数据结构",
			via: ["data_describe"],
			hint: "调用 data_describe 确认 orders 表有哪些字段和取值。",
		},
		{
			id: "query",
			title: "查询明细数据",
			via: ["data_query"],
			hint: "根据用户的问题，调用 data_query 取相关明细，确认数据规模。",
		},
		{
			id: "aggregate",
			title: "聚合统计",
			via: ["data_aggregate"],
			hint: "调用 data_aggregate 做聚合，得出可以直接写进结论的数字。",
		},
		{
			id: "report",
			title: "生成报告",
			via: ["report_save"],
			hint: "把结论写成 Markdown 报告，调用 report_save 保存。",
		},
	],
	skill: {
		description:
			"把一句自然语言分析需求做成可读报告：探查字段 → 查明细 → 聚合 → 保存报告。用户问「汇总/统计/排名/趋势/多少」时用它。",
		instructions: [
			"你现在以「销售数据分析」技能工作：目标是一份结论先行、带关键数字的可读报告。",
			"",
			"做法：",
			"- 先探查表里有什么（字段、状态取值），再决定怎么筛；不要凭想象写筛选条件。",
			"- 只查需要的明细确认规模，真正的数字来自聚合；报告里不要罗列原始行。",
			"- 用户给的口径照做（例如“已支付”就是 status=paid）；口径不清就先做最合理的一种并说明假设。",
			"- 金额保留千分位，结论里带上合计或占比，别只丢一张表。",
			"",
			"收尾要求：报告落库后，在对话里给出一段结论 + 关键数字（可以用表格），并说明报告保存成了什么名字，不要只回「已完成」。",
		].join("\n"),
	},
};
