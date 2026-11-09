/** Business authorization and approval policy, independent from an agent runtime. */

import type { ToolRegistry } from "./registry.js";
import type { BizContext } from "./types.js";

export type PermissionDecision = { allowed: true } | { allowed: false; reason: string };

/** Approval results are cached by tool for one conversation. */
export function createPermissionPolicy(ctx: BizContext, registry: ToolRegistry) {
	const approved = new Set<string>();

	return async (input: { toolName: string; args?: Record<string, unknown> }): Promise<PermissionDecision> => {
		const { toolName } = input;
		if (!ctx.allow.includes("*") && !ctx.allow.includes(toolName)) {
			return { allowed: false, reason: `无权调用工具「${toolName}」（租户 ${ctx.tenantId} / 用户 ${ctx.userId}）` };
		}

		const def = registry.get(toolName);
		const risk = def?.risk ?? "medium";
		if (risk !== "high" && !ctx.requireApproval.includes(toolName)) return { allowed: true };
		if (approved.has(toolName)) return { allowed: true };

		const granted = ctx.requestApproval
			? await ctx.requestApproval({
					traceId: ctx.traceId,
					tenantId: ctx.tenantId,
					userId: ctx.userId,
					toolName,
					args: input.args ?? {},
					risk,
				})
			: false;
		if (!granted) return { allowed: false, reason: `高风险操作「${toolName}」未获人工审批，已阻断` };

		approved.add(toolName);
		return { allowed: true };
	};
}
