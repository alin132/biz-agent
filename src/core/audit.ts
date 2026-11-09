/** Business audit and output-governance policy, independent from an agent runtime. */

import type { BizContext } from "./types.js";

/** Maximum number of characters returned to the model for one tool result. */
export const MAX_RESULT_CHARS = 4000;

export interface AuditedToolOutput {
	content: string[];
	outputChars: number;
	truncated: boolean;
}

export function createAuditPolicy(ctx: BizContext) {
	return (input: {
		toolName: string;
		args?: Record<string, unknown>;
		isError?: boolean;
		content: string[];
	}): AuditedToolOutput => {
		let outputChars = 0;
		let truncated = false;
		const content = input.content.map((text) => {
			outputChars += text.length;
			if (text.length <= MAX_RESULT_CHARS) return text;
			truncated = true;
			return `${text.slice(0, MAX_RESULT_CHARS)}\n…[结果已截断，原长 ${text.length} 字符]`;
		});

		ctx.audit?.({
			traceId: ctx.traceId,
			tenantId: ctx.tenantId,
			userId: ctx.userId,
			toolName: input.toolName,
			args: input.args ?? {},
			ok: !input.isError,
			outputChars,
			truncated,
			at: Date.now(),
		});

		return { content, outputChars, truncated };
	};
}
