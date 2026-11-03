/** 切片 A：工单流转流程定义。 */

import type { WorkflowDef } from "../core/types.js";

export const ticketWorkflow: WorkflowDef = {
	id: "ticket-flow",
	name: "工单处理",
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
};
