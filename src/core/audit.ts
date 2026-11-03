/**
 * 审计与结果治理：挂在 Pi 的 afterToolCall 上。
 *
 * 两件事：
 * 1) 每次工具调用落一条审计记录（谁、在哪个租户、调了什么、成没成）；
 * 2) 截断超长工具结果——一次大查询的结果就能把上下文窗口撑爆，
 *    统一截到 MAX_RESULT_CHARS，并在末尾标注原始长度。
 */

import type { AfterToolCallContext, AfterToolCallResult } from "@earendil-works/pi-agent-core";
import type { BizContext } from "./types.js";

/** 单个工具结果给模型的最大字符数。 */
const MAX_RESULT_CHARS = 4000;

function createAuditHook(ctx: BizContext) {
	return async (after: AfterToolCallContext): Promise<AfterToolCallResult | undefined> => {
		let outputChars = 0;
		let truncated = false;

		const content = after.result.content.map((block) => {
			if (block.type !== "text") {
				return block;
			}
			outputChars += block.text.length;
			if (block.text.length <= MAX_RESULT_CHARS) {
				return block;
			}
			truncated = true;
			return {
				type: "text" as const,
				text: `${block.text.slice(0, MAX_RESULT_CHARS)}\n…[结果已截断，原长 ${block.text.length} 字符]`,
			};
		});

		ctx.audit?.({
			traceId: ctx.traceId,
			tenantId: ctx.tenantId,
			userId: ctx.userId,
			toolName: after.toolCall.name,
			args: (after.args ?? {}) as Record<string, unknown>,
			ok: !after.isError,
			outputChars,
			truncated,
			at: Date.now(),
		});

		return { content };
	};
}

export { createAuditHook, MAX_RESULT_CHARS };
