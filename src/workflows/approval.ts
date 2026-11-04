/** 切片 C：审批流定义。 */

import type { WorkflowDef } from "../core/types.js";
import { createApprovalTools } from "../tools/approval.js";

export const approvalWorkflow: WorkflowDef = {
	id: "approval-flow",
	name: "费用审批",
	createTools: createApprovalTools,
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
	skill: {
		description:
			"报销/费用审批的完整链路：规则校验 → 提交单据 → 归档。用户提到报销、审批、金额、事由、发票时用它。",
		instructions: [
			"你现在以「费用审批」技能工作：目标是把一笔费用如实、合规地提交掉并归档。",
			"",
			"职责边界：",
			"- 提交是不可撤销的写操作：先校验规则，再把校验结论如实转述给用户，不要为了“帮上忙”把不达标的单子报上去。",
			"- 缺关键信息（申请人、类型、金额、事由）就先问清楚，不要自己编金额或事由。",
			"- 规则没通过时，把缺什么、为什么说清楚，并给出怎么改的建议；不要直接提交。",
			"",
			"收尾要求：提交成功后用一段话汇报单号、申请人、类型、金额、审批结果和归档状态，不要只回「已提交」。",
		].join("\n"),
	},
};
