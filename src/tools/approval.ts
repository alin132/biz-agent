/**
 * 切片 C：审批流。
 *
 * 覆盖"规则校验 → 提交审批 → 归档"。
 * 提交动作标记为 high 风险，会被 beforeToolCall 拦下来要求人工确认——
 * 这是权限钩子最典型的用武之地。
 */

import type { Store } from "../store/memory.js";
import type { ToolDef } from "../core/types.js";

/** 报销/采购规则：金额阈值。 */
const LIMITS = {
	autoApprove: 5000,
	managerApprove: 50000,
};

export function createApprovalTools(store: Store): ToolDef[] {
	return [
		{
			name: "approval_check_rules",
			description: "校验申请是否符合审批规则，返回所需的审批层级。提交前必须先调用。",
			category: "审批",
			risk: "low",
			parameters: {
				type: "object",
				properties: {
					type: { type: "string", description: "申请类型，如：报销 / 采购 / 合同" },
					amount: { type: "number", description: "申请金额（元）" },
				},
				required: ["type", "amount"],
			},
			execute: async (args) => {
				const type = String(args.type ?? "");
				const amount = Number(args.amount ?? 0);

				if (!Number.isFinite(amount) || amount <= 0) {
					return { content: "金额必须为正数。", isError: true };
				}

				let level: string;
				if (amount <= LIMITS.autoApprove) {
					level = "L1 自动审批";
				} else if (amount <= LIMITS.managerApprove) {
					level = "L2 部门经理审批";
				} else {
					level = "L3 财务总监 + 分管副总审批";
				}

				return {
					content: [
						`申请类型：${type}，金额：¥${amount}`,
						`校验结果：符合规则，需走「${level}」。`,
						`阈值参考：≤¥${LIMITS.autoApprove} 自动审批，≤¥${LIMITS.managerApprove} 经理审批，超出走高层审批。`,
					].join("\n"),
				};
			},
		},

		{
			name: "approval_submit",
			description: "正式提交审批单并落库。这是不可撤销的写操作，金额较大时会触发人工确认。",
			category: "审批",
			risk: "high",
			parameters: {
				type: "object",
				properties: {
					applicant: { type: "string", description: "申请人" },
					type: { type: "string", description: "申请类型" },
					amount: { type: "number", description: "申请金额（元）" },
					reason: { type: "string", description: "申请事由" },
				},
				required: ["applicant", "type", "amount", "reason"],
			},
			execute: async (args, ctx) => {
				const applicant = String(args.applicant ?? ctx.userId);
				const type = String(args.type ?? "");
				const amount = Number(args.amount ?? 0);
				const reason = String(args.reason ?? "");

				// 小额自动通过，大额留 pending 等人工走审批层级——和 check_rules 的阈值保持一致。
				const status = amount <= LIMITS.autoApprove ? ("approved" as const) : ("pending" as const);
				const item = {
					id: `AP-${store.approvals.length + 1}`,
					applicant,
					type,
					amount,
					status,
					reason,
				};
				store.approvals.push(item);

				const note =
					status === "approved"
						? "金额在自动审批阈值内，已自动通过。"
						: "金额超出自动审批阈值，等待审批人处理。";
				return {
					content: `审批单已提交：${item.id}（${applicant} / ${type} / ¥${amount}），当前状态 ${status}。${note}`,
				};
			},
		},

		{
			name: "approval_archive",
			description: "把已处理完的审批单归档。只能归档状态为 approved 或 rejected 的单据。",
			category: "审批",
			risk: "medium",
			parameters: {
				type: "object",
				properties: {
					approvalId: { type: "string", description: "审批单 ID，例如 AP-1" },
				},
				required: ["approvalId"],
			},
			execute: async (args) => {
				const approvalId = String(args.approvalId ?? "");
				const item = store.approvals.find((entry) => entry.id === approvalId);
				if (!item) {
					return { content: `审批单 ${approvalId} 不存在。`, isError: true };
				}
				if (item.status !== "approved" && item.status !== "rejected") {
					return {
						content: `审批单 ${item.id} 当前状态是 ${item.status}，只有 approved / rejected 可以归档。`,
						isError: true,
					};
				}
				item.status = "archived";
				return { content: `审批单 ${item.id} 已归档。` };
			},
		},
	];
}
