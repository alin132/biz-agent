/** 切片 B：数据查询分析流程定义。 */

import type { WorkflowDef } from "../core/types.js";

export const dataWorkflow: WorkflowDef = {
	id: "data-flow",
	name: "销售数据分析",
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
};
