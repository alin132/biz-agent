/**
 * 权限与审批：挂在 Pi 的 beforeToolCall 上。
 *
 * 这是企业场景的硬需求——Pi 自身不提供任何权限系统（官方 README 明确说明），
 * 所以"谁能调什么、什么操作要人确认"必须在这里自己实现。
 */

import type { BeforeToolCallContext, BeforeToolCallResult } from "@earendil-works/pi-agent-core";
import type { ToolRegistry } from "./registry.js";
import type { BizContext } from "./types.js";

/** 审批结果按「会话 + 工具」缓存，同一次会话内同一工具只问一次。 */
function createPermissionHook(ctx: BizContext, registry: ToolRegistry) {
	const approved = new Set<string>();

	return async (before: BeforeToolCallContext): Promise<BeforeToolCallResult | undefined> => {
		const toolName = before.toolCall.name;

		// 1) 角色白名单
		if (!ctx.allow.includes("*") && !ctx.allow.includes(toolName)) {
			return {
				block: true,
				reason: `无权调用工具「${toolName}」（租户 ${ctx.tenantId} / 用户 ${ctx.userId}）`,
			};
		}

		// 2) 风险等级 → 是否要人工审批
		const def = registry.get(toolName);
		const risk = def?.risk ?? "medium";
		const needsApproval = risk === "high" || ctx.requireApproval.includes(toolName);
		if (!needsApproval) {
			return undefined;
		}

		if (approved.has(toolName)) {
			return undefined;
		}

		const granted = ctx.requestApproval
			? await ctx.requestApproval({
					traceId: ctx.traceId,
					tenantId: ctx.tenantId,
					userId: ctx.userId,
					toolName,
					args: (before.args ?? {}) as Record<string, unknown>,
					risk,
				})
			: false;

		if (!granted) {
			return {
				block: true,
				reason: `高风险操作「${toolName}」未获人工审批，已阻断`,
			};
		}

		approved.add(toolName);
		return undefined;
	};
}

export { createPermissionHook };
