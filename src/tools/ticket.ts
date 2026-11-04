/**
 * 切片 A：工单流转。
 *
 * 覆盖"查询 → 指派 → 改状态 → 通知"四步，是最典型的业务流程形态：
 * 每步一个写操作，顺序不能乱，最后一歩对外发消息。
 */

import type { Store, Ticket } from "../store/memory.js";
import { now } from "../store/memory.js";
import type { ToolDef } from "../core/types.js";

function brief(ticket: Ticket): string {
	return `${ticket.id} | ${ticket.title} | 状态=${ticket.status} | 处理人=${ticket.assignee ?? "未指派"} | 优先级=${ticket.priority} | 客户=${ticket.customer}`;
}

export function createTicketTools(store: Store): ToolDef[] {
	return [
		{
			name: "ticket_search",
			description: "按关键词或状态查询工单。返回工单 ID、标题、状态、处理人。用于找到需要处理的工单。",
			category: "工单",
			risk: "low",
			parameters: {
				type: "object",
				properties: {
					keyword: { type: "string", description: "标题或客户名中的关键词，可选" },
					status: {
						type: "string",
						enum: ["open", "assigned", "processing", "closed"],
						description: "按状态过滤，可选",
					},
				},
				required: [],
			},
			example: { keyword: "支付" },
			execute: async (args) => {
				const keyword = typeof args.keyword === "string" ? args.keyword : undefined;
				const status = typeof args.status === "string" ? args.status : undefined;

				const hits = store.tickets.filter((ticket) => {
					const matchKeyword =
						keyword === undefined ||
						ticket.title.includes(keyword) ||
						ticket.customer.includes(keyword) ||
						ticket.id.includes(keyword);
					const matchStatus = status === undefined || ticket.status === status;
					return matchKeyword && matchStatus;
				});

				if (hits.length === 0) {
					return { content: "没有匹配的工单。" };
				}
				return { content: hits.map(brief).join("\n") };
			},
		},

		{
			name: "ticket_assign",
			description: "把工单指派给指定处理人。会把工单状态从 open 改为 assigned。",
			category: "工单",
			risk: "medium",
			parameters: {
				type: "object",
				properties: {
					ticketId: { type: "string", description: "工单 ID，例如 TK-1001" },
					assignee: { type: "string", description: "处理人姓名" },
				},
				required: ["ticketId", "assignee"],
			},
			example: { ticketId: "TK-1001", assignee: "李工" },
			execute: async (args) => {
				const ticketId = String(args.ticketId ?? "");
				const assignee = String(args.assignee ?? "");
				const ticket = store.tickets.find((item) => item.id === ticketId);
				if (!ticket) {
					return { content: `工单 ${ticketId} 不存在。`, isError: true };
				}
				ticket.assignee = assignee;
				ticket.status = "assigned";
				return { content: `已把 ${ticket.id} 指派给 ${assignee}。\n${brief(ticket)}` };
			},
		},

		{
			name: "ticket_update_status",
			description: "更新工单状态。允许的取值：open / assigned / processing / closed。",
			category: "工单",
			risk: "medium",
			parameters: {
				type: "object",
				properties: {
					ticketId: { type: "string", description: "工单 ID" },
					status: {
						type: "string",
						enum: ["open", "assigned", "processing", "closed"],
						description: "目标状态",
					},
				},
				required: ["ticketId", "status"],
			},
			example: { ticketId: "TK-1001", status: "processing" },
			execute: async (args) => {
				const ticketId = String(args.ticketId ?? "");
				const status = String(args.status ?? "") as Ticket["status"];
				const allowed: Ticket["status"][] = ["open", "assigned", "processing", "closed"];
				if (!allowed.includes(status)) {
					return { content: `非法状态 ${status}。`, isError: true };
				}
				const ticket = store.tickets.find((item) => item.id === ticketId);
				if (!ticket) {
					return { content: `工单 ${ticketId} 不存在。`, isError: true };
				}
				if (status === "closed" && ticket.assignee === null) {
					return { content: `工单 ${ticket.id} 还没有处理人，不能直接关闭。`, isError: true };
				}
				ticket.status = status;
				return { content: `工单 ${ticket.id} 状态已更新为 ${status}。\n${brief(ticket)}` };
			},
		},

		{
			name: "ticket_notify",
			description: "向客户或处理人发送工单处理通知。支持 channel：sms / email / im。",
			category: "工单",
			risk: "medium",
			parameters: {
				type: "object",
				properties: {
					ticketId: { type: "string", description: "工单 ID" },
					channel: { type: "string", enum: ["sms", "email", "im"], description: "通知渠道" },
					message: { type: "string", description: "通知内容" },
				},
				required: ["ticketId", "channel", "message"],
			},
			example: { ticketId: "TK-1001", channel: "im", message: "工单已受理，由李工负责跟进" },
			execute: async (args) => {
				const ticketId = String(args.ticketId ?? "");
				const channel = String(args.channel ?? "im");
				const message = String(args.message ?? "");
				const ticket = store.tickets.find((item) => item.id === ticketId);
				if (!ticket) {
					return { content: `工单 ${ticketId} 不存在。`, isError: true };
				}
				store.notifications.push({ channel, message, ref: ticket.id, at: now() });
				return {
					content: `已通过 ${channel} 向 ${ticket.customer} 发送通知：「${message}」（工单 ${ticket.id}）`,
				};
			},
		},
	];
}
