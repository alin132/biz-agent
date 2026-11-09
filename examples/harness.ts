/**
 * demo 公共工具：用 Pi 内置的 faux provider 造一个"脚本化模型"。
 *
 * 好处是三个切片都能离线跑通、不花 token、结果可复现；
 * 换成真实模型只需把 model / streamFn 换成 models.getModel("deepseek", ...) 即可。
 */

import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import type { BizContext } from "../src/core/types.js";
import type { ToolRegistry } from "../src/core/registry.js";
import type { BusinessRuntime } from "../src/core/runtime.js";
import { createPiBusinessAgent, createPiRuntimeAdapter } from "../server/piRuntimeAdapter.js";
import { createPiSessionHistory } from "../server/piSessionHistory.js";

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


export function createWorkflowPiSession(
	built: BusinessRuntime,
	options: { registry: ToolRegistry; ctx: BizContext; runtime: FauxRuntime; maxTurns?: number },
) {
	const agent = createPiBusinessAgent({
		business: built,
		registry: options.registry,
		ctx: options.ctx,
		model: options.runtime.model,
		streamFn: options.runtime.streamFn,
	});
	const maxTurns = options.maxTurns ?? 20;
	return createPiRuntimeAdapter({
		agent,
		tools: agent.state.tools,
		cwd: process.cwd(),
		sessionManager: createPiSessionHistory({ sessionId: `demo-${Date.now().toString(36)}` }),
		workflow: {
			maxTurns,
			startRun: built.startRun,
			finishTurn: built.finishTurn,
			nextPrompt: built.nextPrompt,
			limitReached: built.limitReached,
		},
	});
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
export function lastAssistantText(session: Awaited<ReturnType<typeof createPiRuntimeAdapter>>): string {
	return session.lastAssistantText();
}

export function title(text: string): void {
	console.log(`\n${"=".repeat(76)}`);
	console.log(text);
	console.log("=".repeat(76));
}

export function section(text: string): void {
	console.log(`\n--- ${text} ---`);
}
