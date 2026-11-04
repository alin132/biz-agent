/**
 * 切片 B：数据查询分析。
 *
 * 覆盖"探查结构 → 查明细 → 聚合统计 → 生成报告"。
 * 重点不在工具复杂，而在于让模型自己决定查什么、聚合什么——
 * 这正是业务人员用自然语言问数的形态。
 */

import type { Order, Store } from "../store/memory.js";
import { now } from "../store/memory.js";
import type { ToolDef } from "../core/types.js";

function row(order: Order): string {
	return `${order.id} | ${order.customer} | ${order.region} | ¥${order.amount} | ${order.status} | ${order.createdAt}`;
}

export function createDataTools(store: Store): ToolDef[] {
	return [
		{
			name: "data_describe",
			description: "描述可用数据表的结构：表名、字段、字段含义、取值范围。分析前必须先调用它确认数据形态。",
			category: "数据",
			risk: "low",
			parameters: { type: "object", properties: {}, required: [] },
			execute: async () => {
				return {
					content: [
						"表名：orders（销售订单）",
						"字段：",
						"  id        订单号，形如 SO-2001",
						"  customer  客户名称",
						"  region    区域，取值：华东 / 华北 / 华南",
						"  amount    金额，单位：元",
						"  status    状态，取值：paid / refunded / pending",
						"  createdAt 创建日期，YYYY-MM-DD",
						`当前共 ${store.orders.length} 条记录。`,
					].join("\n"),
				};
			},
		},

		{
			name: "data_query",
			description: "按条件查询订单明细。所有条件都是可选的，用于查看具体数据。",
			category: "数据",
			risk: "low",
			parameters: {
				type: "object",
				properties: {
					region: { type: "string", enum: ["华东", "华北", "华南"], description: "按区域过滤，可选" },
					status: { type: "string", enum: ["paid", "refunded", "pending"], description: "按状态过滤，可选" },
					limit: { type: "number", description: "最多返回条数，默认 20" },
				},
				required: [],
			},
			example: { status: "paid" },
			execute: async (args) => {
				const region = typeof args.region === "string" ? args.region : undefined;
				const status = typeof args.status === "string" ? args.status : undefined;
				const limit = typeof args.limit === "number" ? args.limit : 20;

				const hits = store.orders
					.filter((order) => (region === undefined || order.region === region) && (status === undefined || order.status === status))
					.slice(0, limit);

				if (hits.length === 0) {
					return { content: "没有匹配的订单。" };
				}
				return { content: hits.map(row).join("\n") };
			},
		},

		{
			name: "data_aggregate",
			description: "按区域或客户聚合订单金额/数量。只统计状态为 paid 的订单。",
			category: "数据",
			risk: "low",
			parameters: {
				type: "object",
				properties: {
					groupBy: { type: "string", enum: ["region", "customer"], description: "聚合维度" },
					metric: { type: "string", enum: ["sum_amount", "count"], description: "聚合指标" },
				},
				required: ["groupBy", "metric"],
			},
			example: { groupBy: "region", metric: "sum_amount" },
			execute: async (args) => {
				const groupBy = String(args.groupBy ?? "region") as "region" | "customer";
				const metric = String(args.metric ?? "sum_amount") as "sum_amount" | "count";

				const paid = store.orders.filter((order) => order.status === "paid");
				const buckets = new Map<string, { amount: number; count: number }>();
				for (const order of paid) {
					const key = order[groupBy];
					const bucket = buckets.get(key) ?? { amount: 0, count: 0 };
					bucket.amount += order.amount;
					bucket.count += 1;
					buckets.set(key, bucket);
				}

				const lines = [...buckets.entries()]
					.sort((a, b) => b[1].amount - a[1].amount)
					.map(([key, bucket]) => `${key} | ${metric === "count" ? `${bucket.count} 单` : `¥${bucket.amount}`}`);

				return {
					content: [`按 ${groupBy} 聚合（仅 paid 订单，共 ${paid.length} 单）：`, ...lines].join("\n"),
				};
			},
		},

		{
			name: "report_save",
			description: "把分析结论保存为报告。title 是报告标题，content 是正文（Markdown）。",
			category: "数据",
			risk: "low",
			parameters: {
				type: "object",
				properties: {
					title: { type: "string", description: "报告标题" },
					content: { type: "string", description: "报告正文，Markdown 格式" },
				},
				required: ["title", "content"],
			},
			example: {
				title: "区域销售分析",
				content: "# 区域销售分析\n\n华南 ¥215,000 居首，华东 ¥204,000 次之，华北 ¥98,000。",
			},
			execute: async (args) => {
				const title = String(args.title ?? "未命名报告");
				const content = String(args.content ?? "");
				if (content.length === 0) {
					return { content: "报告正文不能为空。", isError: true };
				}
				const report = {
					id: `RP-${store.reports.length + 1}`,
					title,
					content,
					createdAt: now(),
				};
				store.reports.push(report);
				return { content: `报告已保存：${report.id}《${title}》，共 ${content.length} 字。` };
			},
		},
	];
}
