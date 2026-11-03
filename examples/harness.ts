/**
 * demo 公共工具：用 Pi 内置的 faux provider 造一个"脚本化模型"。
 *
 * 好处是三个切片都能离线跑通、不花 token、结果可复现；
 * 换成真实模型只需把 model / streamFn 换成 models.getModel("deepseek", ...) 即可。
 */

import type { Agent, StreamFn } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import type { BizContext } from "../src/core/types.js";

export interface FauxRuntime {
	model: Model<any>;
	streamFn: StreamFn;
}

/** 构造一个按队列吐响应的假模型。 */
export function createFauxRuntime(steps: FauxResponseStep[]): FauxRuntime {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses(steps);
	return {
		model: faux.getModel(),
		streamFn: models.streamSimple.bind(models) as StreamFn,
	};
}

/** 一步"模型发起工具调用"。 */
export function callTool(name: string, args: Record<string, unknown>): FauxResponseStep {
	// demo 脚本里传的都是字面量，必然可 JSON 序列化；fauxToolCall 声明的参数类型是 JsonObject。
	const toolArgs = args as Parameters<typeof fauxToolCall>[1];
	return fauxAssistantMessage(fauxToolCall(name, toolArgs));
}

/** 一步"模型输出文本"。 */
export function say(text: string): FauxResponseStep {
	return fauxAssistantMessage(text);
}

/** 造一个业务上下文；默认允许所有工具、审计打到控制台。 */
export function createCtx(overrides: Partial<BizContext> = {}): BizContext {
	return {
		tenantId: "tenant-demo",
		userId: "u-001",
		traceId: `trace-${Date.now().toString(36)}`,
		allow: ["*"],
		requireApproval: [],
		audit: (entry) => {
			const flag = entry.ok ? "OK " : "ERR";
			console.log(
				`[audit] ${flag} ${entry.toolName} args=${JSON.stringify(entry.args)} chars=${entry.outputChars}${
					entry.truncated ? " (已截断)" : ""
				}`,
			);
		},
		...overrides,
	};
}

/** 取最后一条 assistant 消息的纯文本。 */
export function lastAssistantText(agent: Agent): string {
	const messages = agent.state.messages;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]!;
		if (message.role === "assistant") {
			return message.content
				.filter((block) => block.type === "text")
				.map((block) => (block as { text: string }).text)
				.join("");
		}
	}
	return "";
}

export function title(text: string): void {
	console.log(`\n${"=".repeat(76)}`);
	console.log(text);
	console.log("=".repeat(76));
}

export function section(text: string): void {
	console.log(`\n--- ${text} ---`);
}
