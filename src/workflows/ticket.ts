/** 切片 A：工单流转流程定义。 */

import type { WorkflowDef } from "../core/types.js";
import { createTicketTools } from "../tools/ticket.js";

export const ticketWorkflow: WorkflowDef = {
	id: "ticket-flow",
	name: "工单处理",
	createTools: createTicketTools,
	systemPrompt: [
		"你是企业工单处理助手。",
		"你的任务是按固定流程处理一条客户工单：先找到它，指派给合适的人，推动状态，最后通知客户。",
		"处理人选择规则：支付类问题找「李工」，数据和报表类找「王工」，账号类问题找「赵工」；无法判断时指派给「值班组」。",
	].join("\n"),
	steps: [
		{
			id: "search",
			title: "查询工单",
			via: ["ticket_search"],
			hint: "调用 ticket_search 找到目标工单，记下它的 ID、标题、客户和当前状态。",
		},
		{
			id: "assign",
			title: "指派处理人",
			via: ["ticket_assign"],
			hint: "根据问题类型选择处理人，调用 ticket_assign 完成指派。",
		},
		{
			id: "update",
			title: "更新工单状态",
			via: ["ticket_update_status"],
			hint: "指派完成后，调用 ticket_update_status 把状态改成 processing，表示已进入处理中。",
		},
		{
			id: "notify",
			title: "通知客户",
			via: ["ticket_notify"],
			hint: "调用 ticket_notify，通过 im 渠道告知客户工单已被受理、由谁负责。",
		},
	],
	skill: {
		description:
			"处理一条客户工单的完整链路：定位工单 → 指派处理人 → 状态改为处理中 → 通知客户。用户提到工单号、报障、催处理时用它。",
		instructions: [
			"你现在以「工单处理」技能工作：目标是把一条客户工单推到「有人负责、客户已知晓」的状态。",
			"",
			"职责边界：",
			"- 只动工单流转。用户如果问的是别的事（数据分析、报销审批），换用对应技能或委托 flow_xxx，别硬套工单步骤。",
			"- 处理人按规则指派：支付/交易类 → 李工，数据/报表类 → 王工，账号/权限类 → 赵工，判断不出 → 值班组。",
			"- 客户名与工单号必须与 ticket_search 的结果一致，不要编造；查不到就如实说并问用户要工单号。",
			"- 通知渠道默认 im，内容要写清楚“由谁负责、后面会怎么跟进”。",
			"",
			"收尾要求：四步都成功后，用一段话汇报工单号、指派人、最新状态、通知结果，不要只回「好的」。",
		].join("\n"),
	},
};
