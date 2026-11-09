/**
 * 临时诊断脚本：带时间戳观察 agent 每一轮的请求与事件，定位卡点。
 *
 * 跑法：npx tsx scripts/debug-live.ts
 */

import { loadEnvFile } from "../server/env.js";
import { resolveLlm } from "../server/llm.js";
import { createPiBusinessAgent, createPiRuntimeAdapter } from "../server/piRuntimeAdapter.js";
import { createPiSessionHistory } from "../server/piSessionHistory.js";
import { ToolRegistry } from "../src/core/registry.js";
import { createBusinessRuntime } from "../src/core/runtime.js";
import { createStore } from "../src/store/memory.js";
import { createTicketTools } from "../src/tools/ticket.js";
import { ticketWorkflow } from "../src/workflows/ticket.js";

loadEnvFile();

const llm = resolveLlm();
if (!llm) {
	console.error("没有可用模型");
	process.exit(1);
}

const started = Date.now();
const stamp = () => `${String(Date.now() - started).padStart(6)}ms`;

const store = createStore();
const registry = new ToolRegistry().registerAll(createTicketTools(store));

const ctx = {
	tenantId: "t",
	userId: "u",
	traceId: "debug",
	allow: ["*"],
	requireApproval: [],
};
const built = createBusinessRuntime({
	workflow: ticketWorkflow,
	registry,
	maxTurns: 12,
});

const agent = createPiBusinessAgent({ business: built, registry, ctx, model: llm.model, streamFn: llm.streamFn });
const piSession = await createPiRuntimeAdapter({
	agent,
	tools: agent.state.tools,
	cwd: process.cwd(),
	sessionManager: createPiSessionHistory({ sessionId: "debug-live" }),
	workflow: {
		maxTurns: 12,
		startRun: built.startRun,
		finishTurn: built.finishTurn,
		nextPrompt: built.nextPrompt,
		limitReached: built.limitReached,
	},
});

agent.subscribe((event) => {
	switch (event.type) {
		case "agent_start":
			console.log(`${stamp()}  agent_start`);
			break;
		case "turn_start":
			console.log(`${stamp()}  turn_start`);
			break;
		case "message_start":
			console.log(`${stamp()}  message_start  role=${event.message.role}`);
			break;
		case "message_end": {
			const message = event.message;
			console.log(`${stamp()}  message_end    role=${message.role}`);

			if (message.role === "assistant") {
				const blockTypes = message.content.map((block) => block.type).join(",");
				const stop = (message as { stopReason?: string }).stopReason;
				const error = (message as { errorMessage?: string }).errorMessage;
				console.log(`${stamp()}    blocks=[${blockTypes}] stopReason=${stop}${error ? ` error=${error}` : ""}`);
			}
			break;
		}
		case "tool_execution_start":
			console.log(`${stamp()}  tool_start     ${event.toolName} ${JSON.stringify(event.args ?? {})}`);
			break;
		case "tool_execution_end":
			console.log(`${stamp()}  tool_end       ${event.toolName} ok=${!event.isError}`);
			break;
		case "turn_end":
			console.log(`${stamp()}  turn_end`);
			break;
		case "agent_end":
			console.log(`${stamp()}  agent_end`);
			break;
		default:
			break;
	}
});

const guard = setTimeout(async () => {
	console.log(`${stamp()}  !!! 60 秒未结束，主动 abort`);
	await piSession.abort();
	console.log(`${stamp()}  aborted`);

	let text = "";
	for (let index = agent.state.messages.length - 1; index >= 0; index--) {
		const message = agent.state.messages[index];
		if (message?.role === "assistant") {
			text = message.content
				.filter((block) => block.type === "text")
				.map((block) => (block as { text: string }).text)
				.join("");
			break;
		}
	}
	console.log(`${stamp()}  最后一条 assistant 文本: ${text.slice(0, 200) || "（空）"}`);
	process.exit(2);
}, 60000);

try {
	console.log(`${stamp()}  开始 prompt，模型=${llm.label}`);
	await piSession.prompt("把 TK-1003 号工单处理掉，指派给赵工，然后通知客户");
	clearTimeout(guard);
	console.log(`${stamp()}  prompt 正常结束`);
	console.log(`步骤: ${built.engine.state.completed.join(" → ")}`);
	piSession.dispose();
} catch (error) {
	clearTimeout(guard);
	piSession.dispose();
	console.log(`${stamp()}  prompt 抛错: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(3);
}

process.exit(0);
