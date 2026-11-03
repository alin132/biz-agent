/**
 * 上下文治理：挂在 Pi 的 transformContext 上。
 *
 * Pi 每个请求前都会调用它。这里做滑动窗口压缩：
 * 保留开头的 system 消息（系统提示 + 工具声明），只留最近 N 条对话，
 * 并在中间插一条"已省略多少条"的提示，让模型知道历史被截断过。
 *
 * 注意：transformContext 每次请求都基于完整 transcript 重新计算，
 * 所以不会像"往 transcript 里反复追加"那样越滚越大。
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";

export interface ContextWindowOptions {
	/** 保留的最近消息条数（不含开头的 system 消息）。 */
	maxMessages: number;
}

/** 生成一个 Pi 兼容的 system 消息（Pi 的 SystemMessage 仅需 role/content/timestamp）。 */
function systemNotice(text: string): AgentMessage {
	return { role: "system", content: text, timestamp: Date.now() };
}

function createContextTransformer(options: ContextWindowOptions) {
	return async (messages: AgentMessage[]): Promise<AgentMessage[]> => {
		const { maxMessages } = options;
		if (messages.length <= maxMessages) {
			return messages;
		}

		// 找到开头连续的 system 消息（系统提示 + 工具声明），永不裁剪
		let head = 0;
		while (head < messages.length && messages[head]!.role === "system") {
			head++;
		}
		const leading = messages.slice(0, head);
		const rest = messages.slice(head);

		const keep = rest.slice(-maxMessages);
		const omitted = rest.length - keep.length;

		return [...leading, systemNotice(`[上下文压缩] 已省略 ${omitted} 条较早的对话与工具结果。`), ...keep];
	};
}

export { createContextTransformer };
