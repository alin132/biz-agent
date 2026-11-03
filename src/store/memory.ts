/**
 * 内存业务数据。真实项目里这里换成数据库/内部 API 客户端，
 * 工具层的签名不需要变。
 */

export interface Ticket {
	id: string;
	title: string;
	status: "open" | "assigned" | "processing" | "closed";
	assignee: string | null;
	priority: "high" | "normal" | "low";
	customer: string;
	createdAt: string;
}

export interface Order {
	id: string;
	customer: string;
	region: "华东" | "华北" | "华南";
	amount: number;
	status: "paid" | "refunded" | "pending";
	createdAt: string;
}

export interface ApprovalItem {
	id: string;
	applicant: string;
	type: string;
	amount: number;
	status: "draft" | "pending" | "approved" | "rejected" | "archived";
	reason: string;
}

export interface Report {
	id: string;
	title: string;
	content: string;
	createdAt: string;
}

export interface Store {
	tickets: Ticket[];
	orders: Order[];
	approvals: ApprovalItem[];
	reports: Report[];
	/** 通知流水，用于验证"通知"这一步真的发生了。 */
	notifications: { channel: string; message: string; ref: string; at: string }[];
}

function now(): string {
	return new Date().toISOString();
}

export function createStore(): Store {
	return {
		tickets: [
			{
				id: "TK-1001",
				title: "支付回调偶发超时",
				status: "open",
				assignee: null,
				priority: "high",
				customer: "云图科技",
				createdAt: "2026-10-28T09:12:00Z",
			},
			{
				id: "TK-1002",
				title: "对账单导出缺少字段",
				status: "open",
				assignee: null,
				priority: "normal",
				customer: "华东置业",
				createdAt: "2026-10-30T14:03:00Z",
			},
			{
				id: "TK-1003",
				title: "账号无法登录",
				status: "assigned",
				assignee: "张三",
				priority: "high",
				customer: "恒信物流",
				createdAt: "2026-11-01T08:40:00Z",
			},
		],
		orders: [
			{ id: "SO-2001", customer: "云图科技", region: "华东", amount: 128000, status: "paid", createdAt: "2026-10-02" },
			{ id: "SO-2002", customer: "华东置业", region: "华东", amount: 76000, status: "paid", createdAt: "2026-10-09" },
			{ id: "SO-2003", customer: "恒信物流", region: "华北", amount: 43000, status: "pending", createdAt: "2026-10-15" },
			{ id: "SO-2004", customer: "启明医疗", region: "华南", amount: 215000, status: "paid", createdAt: "2026-10-21" },
			{ id: "SO-2005", customer: "云图科技", region: "华东", amount: 52000, status: "refunded", createdAt: "2026-10-27" },
			{ id: "SO-2006", customer: "北辰能源", region: "华北", amount: 98000, status: "paid", createdAt: "2026-11-02" },
		],
		approvals: [],
		reports: [],
		notifications: [],
	};
}

export { now };
