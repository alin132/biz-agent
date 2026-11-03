/** 切片 C：审批流定义。 */

import type { WorkflowDef } from "../core/types.js";

export const approvalWorkflow: WorkflowDef = {
	id: "approval-flow",
	name: "费用审批",
	systemPrompt: [
		"你是企业费用审批助手。",
		"你的任务是帮申请人完成一笔费用的审批提交：先校验规则，再提交单据，最后归档。",
		"提交是不可撤销的写操作，必须如实转述规则校验的结论。",
	].join("\n"),
	steps: [
		{
			id: "check",
			title: "校验审批规则",
			via: ["approval_check_rules"],
			hint: "调用 approval_check_rules，用申请人提供的类型和金额做规则校验。",
		},
		{
			id: "submit",
			title: "提交审批单",
			via: ["approval_submit"],
			hint: "调用 approval_submit 正式提交，把申请人、类型、金额、事由都填上。",
		},
		{
			id: "archive",
			title: "归档审批单",
			via: ["approval_archive"],
			hint: "调用 approval_archive 归档已经处理完的单据。",
		},
	],
};
