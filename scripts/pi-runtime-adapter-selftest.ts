import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { access, readFile } from "node:fs/promises";
import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { AgentMessage, AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { ToolRegistry } from "../src/core/registry.js";
import { createBusinessRuntime } from "../src/core/runtime.js";
import type { BizContext, ToolDef, WorkflowDef } from "../src/core/types.js";
import { createPiSessionHistory, serializePiSessionHistory } from "../server/piSessionHistory.js";
import { createPiBusinessAgent, createPiRuntimeAdapter, toPiAgentTools } from "../server/piRuntimeAdapter.js";
import { createMcpExtension } from "@earendil-works/pi-coding-agent";
import { createPiMcpTransport } from "../server/mcp/piTransport.js";
import { piMcpToolName } from "../server/mcp/piNames.js";
import { createPiAuditHook, createPiPermissionHook } from "../server/piRuntimeAdapter.js";
import { createPiModelRuntime, PiModelRuntimeRegistry } from "../server/piModelRuntime.js";
import { McpClient } from "@earendil-works/pi-mcp";
import { createPiMcpTransportForTest, piSseSource } from "../server/mcp/piTransport.js";

const model: Model<any> = {
	id: "mock-model",
	name: "Mock Model",
	api: "openai-completions",
	provider: "openai",
	baseUrl: "https://example.invalid/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 4096,
	maxTokens: 512,
};

const sseState: { response?: import("node:http").ServerResponse; closed: boolean } = { closed: false };
const sseServer = createServer(async (request, response) => {
	if (request.method === "GET" && request.url === "/sse") {
		response.writeHead(200, { "Content-Type": "text/event-stream", "Mcp-Session-Id": "pi-sse-selftest" });
		sseState.response = response;
		response.once("close", () => { sseState.closed = true; });
		response.write("event: endpoint\ndata: /message\n\n");
		return;
	}
	if (request.method === "POST" && request.url === "/message") {
		assert.equal(request.headers["mcp-session-id"], "pi-sse-selftest", "SSE session id is propagated to POST requests");
		let body = "";
		for await (const chunk of request) body += chunk.toString();
		const message = JSON.parse(body) as { id?: string | number; method?: string };
		if (!message.id) {
			response.writeHead(202).end();
			return;
		}
		const result = message.method === "initialize"
			? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "legacy-sse-selftest", version: "1" } }
			: message.method === "tools/list"
				? { tools: [{ name: "add", description: "Add two numbers", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] } }] }
				: { content: [{ type: "text", text: "42" }] };
		response.writeHead(202).end();
		setImmediate(() => sseState.response?.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`));
		return;
	}
	response.writeHead(404).end();
});

const tools: AgentTool[] = ["first", "second"].map((name) => ({
	name,
	label: name,
	description: name,
	executionMode: name === "first" ? "parallel" : "sequential",
	parameters: { type: "object", properties: {} } as AgentTool["parameters"],
	execute: async () => ({ content: [{ type: "text", text: name }], details: undefined }),
}));

let requests = 0;
const streamFn: StreamFn = (requestModel) => {
	requests++;
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		const content = requests === 1
			? [{ type: "toolCall" as const, id: "call-1", name: "first", arguments: {} }]
			: [{ type: "text" as const, text: requests > 2 ? "summary" : `answer-${requests}` }];
		stream.push({
			type: "done",
			reason: requests === 1 ? "toolUse" : "stop",
			message: {
				...fauxAssistantMessage(""),
				content,
				api: requestModel.api,
				provider: requestModel.provider,
				model: requestModel.id,
			},
		});
	});
	return stream;
};

const boundaryTool: ToolDef = {
	name: "boundary_tool",
	description: "Boundary tool",
	category: "test",
	risk: "low",
	parameters: { type: "object", properties: {} },
	execute: async () => ({ content: "ok" }),
};
let extensionSessionStartCalls = 0;
let extensionSessionShutdownCalls = 0;
const lifecycleExtension = {
	name: "selftest-lifecycle",
	hidden: true,
	factory: (pi: import("@earendil-works/pi-coding-agent").ExtensionAPI) => {
		pi.on("session_start", () => {
			extensionSessionStartCalls++;
		});
		pi.on("session_shutdown", () => {
			extensionSessionShutdownCalls++;
		});
	},
};
const boundaryWorkflow: WorkflowDef = {
	id: "boundary-workflow",
	name: "Boundary workflow",
	systemPrompt: "Current business prompt",
	steps: [{ id: "one", title: "One", via: [boundaryTool.name], hint: "" }],
	createTools: () => [boundaryTool],
};
const boundaryRegistry = new ToolRegistry().registerAll([boundaryTool]);
const boundaryContext: BizContext = {
	tenantId: "test", userId: "test", traceId: "test", allow: ["*"], requireApproval: [],
};
const businessRuntime = createBusinessRuntime({ workflow: boundaryWorkflow, registry: boundaryRegistry });
const businessAgent = createPiBusinessAgent({
	business: businessRuntime,
	registry: boundaryRegistry,
	ctx: boundaryContext,
	model,
	streamFn,
	messages: [
		{ role: "system", content: "Stale system prompt", timestamp: 0 },
		{ role: "user", content: "Keep this history", timestamp: 1 },
	] as AgentMessage[],
});
assert.equal(businessAgent.state.systemPrompt, businessRuntime.systemPrompt, "Pi receives the pure business system prompt");
assert.deepEqual(businessAgent.state.tools.map((tool) => tool.name), [boundaryTool.name], "Pi converts the business tool definitions");
assert.ok(!businessAgent.state.messages.some((message) => message.role === "system" && message.content === "Stale system prompt"), "adapter drops stale system history");
assert.ok(businessAgent.state.messages.some((message) => message.role === "user" && message.content === "Keep this history"), "adapter preserves conversation history");
console.log("Pi business-to-agent boundary selftest passed (4 assertions)");

const agent = new Agent({
	streamFn,
	initialState: { model, systemPrompt: "Business system prompt", tools: [tools[0]!] },
});
let beforeCalls = 0;
let afterCalls = 0;
const beforeToolCall = async () => {
	beforeCalls++;
	return undefined;
};
const afterToolCall = async () => {
	afterCalls++;
	return undefined;
};
agent.beforeToolCall = beforeToolCall;
agent.afterToolCall = afterToolCall;

const history = createPiSessionHistory({ sessionId: "adapter-selftest" });
const adapter = await createPiRuntimeAdapter({
	agent,
	sessionManager: history,
	tools,
	extensions: [lifecycleExtension],
	cwd: process.cwd(),
	keepRecentTokens: 1,
	reserveTokens: 1,
});

try {
	assert.ok(agent.state.systemPrompt.includes("Business system prompt"), "keeps the business system prompt");
	assert.equal(adapter.systemPrompt(), "Business system prompt", "Pi session exposes the active system prompt through the adapter");
	assert.deepEqual(adapter.messages().map((message) => message.role), ["system"], "Pi session exposes its active message projection through the adapter");
	assert.equal(adapter.lastAssistantMessage(), undefined, "no assistant message exists before the first prompt");
	assert.deepEqual(agent.state.tools.map((tool) => tool.name), ["first"]);
	assert.equal(adapter.session.getToolDefinition("first")?.label, "first", "business tool label is registered through the Pi extension");
	assert.equal(adapter.session.getToolDefinition("first")?.executionMode, "parallel", "business parallel execution mode is preserved");
	assert.ok(adapter.session.getToolDefinition("first")?.parameters, "business tool schema is registered through the Pi extension");
	assert.equal(adapter.session.getToolDefinition("second")?.name, "second", "inactive business tools remain in Pi's extension registry");
	assert.equal(extensionSessionStartCalls, 1, "Pi extension session_start lifecycle runs when the runtime is created");
	assert.equal(adapter.session.getToolDefinition("second")?.executionMode, "sequential", "business sequential execution mode is preserved");
	assert.deepEqual(adapter.session.getActiveToolNames(), ["first"], "Pi loadout preserves the business active-tool list");
	const events: string[] = [];
	const unsubscribe = adapter.subscribe((event) => events.push(event.type));
	await adapter.prompt("first question");
	assert.ok(adapter.messages().some((message) => message.role === "user"), "adapter reads the active Pi conversation after a prompt");
	assert.ok(adapter.lastAssistantMessage(), "adapter exposes the latest assistant message");
	assert.ok(adapter.lastAssistantText().length > 0, "adapter extracts the latest assistant text");
	assert.equal(beforeCalls, 1, "Pi tool_call extension invokes the host approval hook");
	assert.equal(afterCalls, 1, "Pi tool_result extension invokes the host audit hook");
	adapter.setActiveToolsByName(["second"]);
	assert.deepEqual(agent.state.tools.map((tool) => tool.name), ["second"]);

	await adapter.prompt("second question");
	const secondUser = history.getEntries().find((entry) => entry.type === "message" && entry.message.role === "user" && JSON.stringify(entry.message.content).includes("second question"));
	assert.ok(secondUser, "Pi stores the second user prompt as a tree node");
	const navigation = await adapter.navigateTree(secondUser.id);
	assert.equal(navigation.editorText, "second question", "Pi returns the selected user message for the composer");
	assert.ok(!history.getBranch().some((entry) => entry.id === secondUser.id), "navigating to a user prompt resumes before that prompt");
	assert.ok(history.getEntries().some((entry) => entry.id === secondUser.id), "navigating preserves the abandoned branch in Pi history");
	const compacted = await adapter.compact("Keep the key facts");
	unsubscribe();

	assert.ok(compacted.summary.length > 0, "Pi compaction returns a summary");
	assert.ok(events.includes("compaction_start"));
	assert.ok(events.includes("compaction_end"));
	assert.ok(adapter.exportHistory().some((entry) => entry.type === "compaction"));
	assert.ok(requests >= 4, "the mock stream served prompts and the compaction summary");
	adapter.newSession();
	assert.equal(history.buildSessionContext().messages.length, 0, "Pi SessionManager starts a clean session");
	console.log("Pi runtime adapter selftest passed (21 assertions)");
} finally {
	await adapter.shutdown();
}
assert.equal(extensionSessionShutdownCalls, 1, "awaitable Pi shutdown waits for the extension lifecycle hook");

const mcpLegacyTool: ToolDef = {
	name: "mcp_selftest_mcp_add",
	description: "Add values through MCP",
	category: "MCP",
	risk: "high",
	parameters: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
	execute: async () => ({ content: "legacy MCP implementation must not run" }),
};

const sseAddress = await new Promise<AddressInfo>((resolve, reject) => {
	sseServer.once("error", reject);
	sseServer.listen(0, "127.0.0.1", () => resolve(sseServer.address() as AddressInfo));
});
const sseClient = new McpClient({ name: "biz-agent-sse-selftest", version: "1" });
try {
	const sseTransport = createPiMcpTransportForTest({
		name: "legacy-sse-selftest",
		source: piSseSource("legacy-sse-selftest"),
		scope: "extension",
		config: { type: "http", url: `http://127.0.0.1:${sseAddress.port}/sse`, headers: {} },
	}, process.cwd());
	await sseClient.connect(sseTransport);
	assert.equal((await sseClient.listTools())[0]?.name, "add", "Pi MCP client discovers tools over the legacy SSE transport");
	const sseResult = await sseClient.callTool("add", { a: 19, b: 23 });
	assert.equal(sseResult.content?.[0]?.type, "text", "legacy SSE tool call returns the Pi MCP result");
	assert.equal((sseResult.content?.[0] as { text?: string }).text, "42");
	await sseClient.close();
	assert.equal(sseClient.connectionState, "closed", "closing the Pi MCP client closes the legacy SSE transport");
	for (let attempt = 0; attempt < 20 && !sseState.closed; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(sseState.closed, true, "closing the Pi MCP client aborts its long-lived SSE stream");
	console.log("Pi legacy SSE MCP transport selftest passed (5 assertions)");
} finally {
	await sseClient.close().catch(() => {});
	sseState.response?.end();
	sseServer.closeAllConnections();
	await new Promise<void>((resolve) => sseServer.close(() => resolve()));
}

const mcpRegistry = new ToolRegistry().register(mcpLegacyTool);
const mcpNativeName = piMcpToolName("selftest-mcp", "add");
const mcpAliases = { [mcpNativeName]: mcpLegacyTool.name };
let mcpApprovalCalls = 0;
let mcpAuditName = "";
let mcpRequestCount = 0;
const mcpContext: BizContext = {
	...boundaryContext,
	requireApproval: [mcpLegacyTool.name],
	requestApproval: async (request) => {
		mcpApprovalCalls++;
		assert.equal(request.toolName, mcpLegacyTool.name, "approval keeps the persisted business tool name");
		return true;
	},
	audit: (entry) => { mcpAuditName = entry.toolName; },
};
const mcpAgent = new Agent({
	streamFn: (requestModel) => {
		mcpRequestCount++;
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => stream.push({
			type: "done",
			reason: mcpRequestCount === 1 ? "toolUse" : "stop",
			message: {
				...fauxAssistantMessage(""),
				content: mcpRequestCount === 1
					? [{ type: "toolCall" as const, id: "native-mcp-call", name: mcpNativeName, arguments: { a: 19, b: 23 } }]
					: [{ type: "text" as const, text: "native MCP finished" }],
				api: requestModel.api,
				provider: requestModel.provider,
				model: requestModel.id,
			},
		}));
		return stream;
	},
	initialState: { model, systemPrompt: "Native Pi MCP selftest", tools: [] },
});
mcpAgent.beforeToolCall = createPiPermissionHook(mcpContext, mcpRegistry, mcpAliases, (name) => name === mcpLegacyTool.name);
mcpAgent.afterToolCall = createPiAuditHook(mcpContext, mcpAliases);
const mcpHistory = createPiSessionHistory({ sessionId: "native-mcp-selftest" });
const mcpAdapter = await createPiRuntimeAdapter({
	agent: mcpAgent,
	sessionManager: mcpHistory,
	tools: toPiAgentTools([mcpLegacyTool], mcpContext),
	nativeToolNames: [mcpLegacyTool.name],
	toolNameAliases: mcpAliases,
	isToolAvailable: (name) => name === mcpLegacyTool.name,
	extensions: [createMcpExtension({
		loadConfig: () => ({
			servers: [{
				name: "selftest-mcp",
				source: "selftest",
				scope: "extension" as const,
				config: {
					type: "stdio" as const,
					command: process.execPath,
					args: [fileURLToPath(new URL("./fixtures/mcp-stdio-server.mjs", import.meta.url))],
					env: { FIXTURE_GREETING: "pi-native" },
					exposure: "direct" as const,
				},
			}],
			errors: [],
		}),
		createTransport: createPiMcpTransport,
	})],
	cwd: process.cwd(),
});
try {
	for (let attempt = 0; attempt < 100 && !mcpAdapter.session.getToolDefinition(mcpNativeName); attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	assert.ok(mcpAdapter.session.getToolDefinition(mcpNativeName), "Pi native MCP extension connects and registers discovered tools");
	mcpAdapter.setActiveToolsByName([mcpLegacyTool.name]);
	const mcpEvents: string[] = [];
	const stopMcpEvents = mcpAdapter.subscribe((event) => {
		if (event.type === "tool_execution_start" || event.type === "tool_execution_end") mcpEvents.push(event.type);
	});
	await mcpAdapter.prompt("Add 19 and 23");
	stopMcpEvents();
	assert.equal(mcpAdapter.canonicalToolName(mcpNativeName), mcpLegacyTool.name, "Pi tool events map back to the stable business name");
	assert.equal(mcpApprovalCalls, 1, "native Pi MCP calls still pass the enterprise approval hook");
	assert.equal(mcpAuditName, mcpLegacyTool.name, "native Pi MCP results still pass the enterprise audit hook");
	assert.ok(mcpEvents.includes("tool_execution_start") && mcpEvents.includes("tool_execution_end"), "native MCP execution emits Pi tool lifecycle events");
	assert.equal(mcpAdapter.lastAssistantText(), "native MCP finished");
	console.log("Pi native MCP transport, tool pipeline and enterprise policy selftest passed (6 assertions)");
} finally {
	mcpAdapter.dispose();
}

const skillBaseTool: AgentTool = {
	name: "use_skill",
	label: "use_skill",
	description: "base skill tool",
	parameters: { type: "object", properties: { skillId: { type: "string" } }, required: ["skillId"] } as AgentTool["parameters"],
	execute: async () => ({ content: [{ type: "text", text: "base implementation must be overridden" }], details: undefined }),
};
let skillRequest = 0;
let loadedSkill = "";
const skillBeforeCalls: string[] = [];
const skillAfterCalls: string[] = [];
const skillRequestContexts: string[] = [];
let skillContextReads = 0;
let skillAdapter: Awaited<ReturnType<typeof createPiRuntimeAdapter>> | undefined;
const skillAgent = new Agent({
	streamFn: (requestModel, context) => {
		skillRequest++;
		skillRequestContexts.push(JSON.stringify(context.messages));
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => stream.push({
			type: "done",
			reason: skillRequest === 1 ? "toolUse" : "stop",
			message: {
				...fauxAssistantMessage(""),
				content: skillRequest === 1
					? [{ type: "toolCall" as const, id: "skill-call", name: "use_skill", arguments: { skillId: "sales" } }]
					: skillRequest === 2
						? [{ type: "toolCall" as const, id: "second-call", name: "second", arguments: {} }]
						: [{ type: "text" as const, text: "skill-ready" }],
				api: requestModel.api,
				provider: requestModel.provider,
				model: requestModel.id,
			},
		}));
		return stream;
	},
	initialState: { model, systemPrompt: "Skill extension selftest", tools: [skillBaseTool] },
});
skillAgent.beforeToolCall = async ({ toolCall }) => { skillBeforeCalls.push(toolCall.name); return undefined; };
skillAgent.afterToolCall = async ({ toolCall }) => { skillAfterCalls.push(toolCall.name); return undefined; };
const skillHistory = createPiSessionHistory({ sessionId: "native-skill-tool-selftest" });
skillAdapter = await createPiRuntimeAdapter({
	agent: skillAgent,
	sessionManager: skillHistory,
	tools: [skillBaseTool, tools[1]!],
	cwd: process.cwd(),
		workflow: {
			maxTurns: 8,
			startRun: () => {},
			finishTurn: (results) => ({ continue: results.length > 0, terminateTools: false }),
			nextPrompt: () => "Continue the skill",
			limitReached: () => false,
		},
	skill: {
		name: "use_skill",
		description: () => "Available skill: sales (Sales analysis)",
		contextMessage: () => { skillContextReads++; return loadedSkill ? { role: "user", content: "ACTIVE_SKILL_CONTEXT_BODY", timestamp: Date.now() } : null; },
		load: (skillId) => {
			loadedSkill = skillId;
			skillAdapter!.setActiveToolsByName(["second"]);
			return "Sales analysis instructions";
		},
	},
});
try {
	await skillAdapter.prompt("Run the sales analysis skill");
	assert.equal(loadedSkill, "sales", "Pi's registered extension tool loads the selected business skill");
	assert.deepEqual(skillBeforeCalls, ["use_skill", "second"], "native skill and business extension tools pass through the host permission hook");
	assert.deepEqual(skillAfterCalls, ["use_skill", "second"], "native skill and business extension tools pass through the host audit hook");
	assert.equal(skillAdapter.session.getToolDefinition("use_skill")?.label, "加载技能", "use_skill is provided by the Pi extension, not the business AgentTool placeholder");
	assert.ok(skillAdapter.session.getToolDefinition("second"), "ordinary business tools are also registered by the Pi extension");
	assert.deepEqual(skillAgent.state.tools.map((tool) => tool.name), ["second"], "skill activation can replace Pi's active tool set during tool execution");
	assert.ok(JSON.stringify(skillHistory.getEntries()).includes("Sales analysis instructions"), "the extension tool returns skill instructions into Pi history");
	assert.ok(JSON.stringify(skillHistory.getEntries()).includes("Continue the skill"), "Pi prepareNextTurn persists the business continuation as a user message");
	assert.ok(skillContextReads > 0, `the Pi context hook reads the current skill state; requests=${JSON.stringify(skillRequestContexts)}`);
	assert.ok(skillRequestContexts.some((context) => context.includes("ACTIVE_SKILL_CONTEXT_BODY")), `the active skill context callback is injected for Pi's next request; reads=${skillContextReads}`);
	assert.ok(!JSON.stringify(skillHistory.getEntries()).includes("ACTIVE_SKILL_CONTEXT_BODY"), "the dynamic skill context remains transient and is not persisted into Pi history");
	console.log("Pi native skill extension selftest passed (8 assertions)");
} finally {
	skillAdapter.dispose();
}

const automaticModel = { ...model, id: "auto-compact-model", contextWindow: 512, maxTokens: 128 };
const automaticStreamFn: StreamFn = (requestModel) => {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => stream.push({
		type: "done",
		reason: "stop",
		message: {
			...fauxAssistantMessage(""),
			content: [{ type: "text", text: "ack" }],
			api: requestModel.api,
			provider: requestModel.provider,
			model: requestModel.id,
		},
	}));
	return stream;
};
const automaticAgent = new Agent({
	streamFn: automaticStreamFn,
	initialState: { model: automaticModel, systemPrompt: "Automatic compaction selftest", tools: [] },
});
const automaticHistory = createPiSessionHistory({ sessionId: "automatic-compaction-selftest" });
const automaticAdapter = await createPiRuntimeAdapter({
	agent: automaticAgent,
	sessionManager: automaticHistory,
	tools: [],
	cwd: process.cwd(),
	keepRecentTokens: 128,
	reserveTokens: 128,
});
const automaticEvents: Array<{ type: string; reason?: string }> = [];
const unsubscribeAutomatic = automaticAdapter.subscribe((event) => automaticEvents.push(event));
try {
	for (let turn = 0; turn < 6; turn++) {
		await automaticAdapter.prompt(`第 ${turn + 1} 轮背景：` + "业务事实。".repeat(100));
		if (automaticEvents.some((event) => event.type === "compaction_end" && event.reason === "threshold")) break;
	}
	assert.ok(automaticEvents.some((event) => event.type === "compaction_start" && event.reason === "threshold"), `Pi automatically starts threshold compaction when context exceeds the configured budget; events=${JSON.stringify(automaticEvents)}`);
	assert.ok(automaticEvents.some((event) => event.type === "compaction_end" && event.reason === "threshold"), "Pi completes automatic threshold compaction within the prompt lifecycle");
	assert.ok(automaticAdapter.exportHistory().some((entry) => entry.type === "compaction"), "automatic compaction is stored as a native Pi session entry");
	const restoredAutomaticHistory = createPiSessionHistory({
		sessionId: "automatic-compaction-selftest",
		piSessionEntries: JSON.parse(JSON.stringify(automaticAdapter.exportHistory())) as unknown[],
		piSessionLeafId: automaticHistory.getLeafId(),
	});
	assert.ok(restoredAutomaticHistory.getBranch().some((entry) => entry.type === "compaction"), "the restored Pi branch retains its native compaction boundary");
	assert.ok(
		restoredAutomaticHistory.buildSessionContext().messages.length < restoredAutomaticHistory.getBranch().filter((entry) => entry.type === "message").length,
		"the restored Pi context projection omits messages summarized by the compaction entry",
	);
	console.log("Pi automatic compaction selftest passed (5 assertions)");
} finally {
	unsubscribeAutomatic();
	automaticAdapter.dispose();
}

const originalFetch = globalThis.fetch;
let observedAuthorization = "";
globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
	const headers = new Headers(init?.headers);
	observedAuthorization = headers.get("authorization") ?? "";
	return new Response([
		'data: {"choices":[{"delta":{"content":"pi-runtime-ok"},"finish_reason":null}]}',
		'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
		"data: [DONE]",
		"",
	].join("\n\n"), { headers: { "content-type": "text/event-stream" } });
}) as typeof fetch;
try {
	const runtimeModel = { ...model, provider: "openai", baseUrl: "http://pi-runtime.test/v1" };
	const modelRuntime = await createPiModelRuntime({
		model: runtimeModel,
		providerId: "biz_runtime_selftest",
		providerName: "Pi runtime selftest",
		apiKey: "pi-runtime-test-key",
	});
	const registered = modelRuntime.getModel("biz_runtime_selftest", model.id);
	assert.ok(registered, "Pi ModelRuntime registers the selected provider/model");
	const response = await modelRuntime.completeSimple(registered, {
		messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
	});
	assert.equal(response.content[0]?.type, "text");
	assert.equal(response.content[0]?.text, "pi-runtime-ok", "Pi ModelRuntime parses the provider stream");
	assert.equal(observedAuthorization, "Bearer pi-runtime-test-key", "Pi ModelRuntime resolves the provider API key");
	console.log("Pi ModelRuntime provider selftest passed (3 assertions)");
} finally {
	globalThis.fetch = originalFetch;
}

const switchFetch = globalThis.fetch;
const routedRequests: Array<{ model: string; authorization: string }> = [];
globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
	const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
	const authorization = new Headers(init?.headers).get("authorization") ?? "";
	routedRequests.push({ model: body.model ?? "", authorization });
	const content = body.model === "model-two" ? "reply-two" : "reply-one";
	return new Response([
		`data: {"choices":[{"delta":{"content":"${content}"},"finish_reason":null}]}`,
		'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
		"data: [DONE]",
		"",
	].join("\n\n"), { headers: { "content-type": "text/event-stream" } });
}) as typeof fetch;
const switchHistory = createPiSessionHistory({ sessionId: "native-model-switch-selftest" });
let switchAdapter: Awaited<ReturnType<typeof createPiRuntimeAdapter>> | undefined;
try {
	const registry = new PiModelRuntimeRegistry();
	const modelOne = await registry.register({
		model: { ...model, id: "model-one", provider: "openai", baseUrl: "http://pi-switch.test/v1" },
		providerId: "biz_switch_one", providerName: "Switch one", apiKey: "key-one",
	});
	await registry.register({
		model: { ...model, id: "model-sibling", provider: "openai", baseUrl: "http://pi-switch.test/v1" },
		providerId: "biz_switch_one", providerName: "Switch one", apiKey: "key-one",
	});
	const modelTwo = await registry.register({
		model: { ...model, id: "model-two", provider: "openai", baseUrl: "http://pi-switch.test/v1" },
		providerId: "biz_switch_two", providerName: "Switch two", apiKey: "key-two",
	});
	const modelStream: StreamFn = (requestModel, context, options) => registry.runtime().then((runtime) =>
		runtime.streamSimple(requestModel, context, options));
	const switchAgent = new Agent({ streamFn: modelStream, initialState: { model: modelOne, systemPrompt: "keep history", tools: [] } });
	switchAdapter = await createPiRuntimeAdapter({
		agent: switchAgent,
		sessionManager: switchHistory,
		tools: [],
		cwd: process.cwd(),
		modelRuntime: registry.runtime(),
	});
	await switchAdapter.prompt("first turn");
	await switchAdapter.setModel(modelTwo);
	await switchAdapter.prompt("second turn");
	assert.deepEqual(routedRequests.map((request) => request.model), ["model-one", "model-two"], "native Pi model switch routes the next request through the new provider model");
	assert.deepEqual(routedRequests.map((request) => request.authorization), ["Bearer key-one", "Bearer key-two"], "each model uses its own Pi-managed credential");
	assert.ok(JSON.stringify(switchHistory.buildSessionContext().messages).includes("first turn"), "native model switch preserves prior session history");
	assert.ok(serializePiSessionHistory(switchHistory).some((entry) => entry.type === "model_change"), "Pi records the native model change in session history");
	assert.ok((await registry.runtime()).getModel("biz_switch_one", "model-sibling"), "provider registration keeps sibling models in its catalog");
	await registry.replaceProvider({
		providerId: "biz_switch_one",
		providerName: "Switch one updated",
		apiKey: "key-one-rotated",
		models: [{ ...model, id: "model-one", provider: "openai", baseUrl: "http://pi-switch.test/v1" }],
	});
	const refreshedRuntime = await registry.runtime();
	assert.equal(refreshedRuntime.getModel("biz_switch_one", "model-sibling"), undefined, "provider replacement removes stale models");
	const refreshedModel = refreshedRuntime.getModel("biz_switch_one", "model-one");
	assert.ok(refreshedModel);
	await refreshedRuntime.completeSimple(refreshedModel!, { messages: [{ role: "user", content: "after rotation", timestamp: Date.now() }] });
	assert.equal(routedRequests.at(-1)?.authorization, "Bearer key-one-rotated", "provider replacement rotates the Pi-managed credential");
	await registry.unregisterProvider("biz_switch_one");
	assert.equal(refreshedRuntime.getModel("biz_switch_one", "model-one"), undefined, "provider removal clears its models");
	console.log("Pi native model switch selftest passed (9 assertions)");
} finally {
	switchAdapter?.dispose();
	globalThis.fetch = switchFetch;
}

const anthropicFetch = globalThis.fetch;
let anthropicHeaders: Headers | undefined;
globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
		anthropicHeaders = new Headers(init?.headers);
		return new Response(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "fixture" } }), {
			status: 401,
			headers: { "content-type": "application/json" },
		});
}) as typeof fetch;
try {
	const anthropicModel = {
		...model,
		id: "anthropic-selftest",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "http://pi-anthropic.test",
	};
	const runtime = await createPiModelRuntime({
		model: anthropicModel,
		providerId: "biz_anthropic_selftest",
		providerName: "Anthropic selftest",
		apiKey: "anthropic-fixture-key",
	});
	const registered = runtime.getModel("biz_anthropic_selftest", anthropicModel.id);
	assert.ok(registered);
	await runtime.completeSimple(registered, { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] });
	assert.equal(anthropicHeaders?.get("x-api-key"), "anthropic-fixture-key", "Pi applies the Anthropic API key header");
	assert.equal(anthropicHeaders?.get("authorization"), null, "Pi does not force an OpenAI Bearer header on Anthropic");
	console.log("Pi provider-specific auth selftest passed (2 assertions)");
} finally {
	globalThis.fetch = anthropicFetch;
}

const deferredTool: AgentTool = {
	name: "deferred_sales_report",
	label: "deferred_sales_report",
	description: "Read the sales report and summarize sales by region",
	parameters: { type: "object", properties: {} } as AgentTool["parameters"],
	execute: async () => ({ content: [{ type: "text", text: "North: 5" }], details: undefined }),
};
let discoveryRequest = 0;
const discoveryToolResults: string[][] = [];
const discoveryAgent = new Agent({
	streamFn: (requestModel) => {
		discoveryRequest++;
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => stream.push({
			type: "done",
			reason: discoveryRequest < 3 ? "toolUse" : "stop",
			message: {
				...fauxAssistantMessage(""),
				content: discoveryRequest === 1
					? [{ type: "toolCall" as const, id: "search-call", name: "tool_search", arguments: { query: "sales report" } }]
					: discoveryRequest === 2
						? [{ type: "toolCall" as const, id: "business-call", name: deferredTool.name, arguments: {} }]
						: [{ type: "text" as const, text: "Sales report complete" }],
				api: requestModel.api,
				provider: requestModel.provider,
				model: requestModel.id,
			},
		}));
		return stream;
	},
	initialState: { model, systemPrompt: "Search tools before calling them", tools: [] },
});
const discoveryHistory = createPiSessionHistory({ sessionId: "pi-tool-search-selftest" });
const discoveryAdapter = await createPiRuntimeAdapter({
	agent: discoveryAgent,
	sessionManager: discoveryHistory,
	tools: [deferredTool],
	alwaysActiveToolNames: ["tool_search"],
	cwd: process.cwd(),
	workflow: {
		maxTurns: 8,
		startRun: () => {},
		finishTurn: (results) => {
			discoveryToolResults.push(results.map((result) => result.toolName));
			return { continue: results.length > 0, terminateTools: false };
		},
		nextPrompt: () => "Continue with tools found in the catalog",
		limitReached: () => false,
	},
});
try {
	assert.ok(discoveryAdapter.session.getToolDefinition("tool_search"), "Pi's native tool_search extension is registered");
	assert.deepEqual(discoveryAdapter.session.getActiveToolNames(), ["tool_search"], "tool_search is active before deferred business tools are exposed");
	assert.equal(discoveryAdapter.session.getToolDefinition(deferredTool.name)?.exposure, "deferred", "inactive business tools use Pi's deferred exposure");
	await discoveryAdapter.prompt("Find and read the sales report");
	assert.deepEqual(discoveryToolResults[0], [], "Pi tool discovery does not count as executing a business workflow tool");
	assert.ok(discoveryToolResults.some((names) => names.includes(deferredTool.name)), "the searched business tool executes in a later Pi turn");
	assert.ok(discoveryHistory.getBranch().some((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "tool_search"), "Pi records its native discovery result in the session branch");
	assert.ok(discoveryHistory.getBranch().some((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === deferredTool.name), "the loaded business tool result is persisted after discovery");
	console.log("Pi native tool search selftest passed (6 assertions)");
} finally {
	discoveryAdapter.dispose();
}

let piSkillPrompt = "";
const nativeSkillAgent = new Agent({
	streamFn: (requestModel, context) => {
		piSkillPrompt = JSON.stringify(context.messages);
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => stream.push({
			type: "done",
			reason: "stop",
			message: { ...fauxAssistantMessage("Pi skill loaded"), content: [{ type: "text", text: "Pi skill loaded" }], api: requestModel.api, provider: requestModel.provider, model: requestModel.id },
		}));
		return stream;
	},
	initialState: { model, systemPrompt: "Native Pi skill test", tools: [] },
});
const nativeSkillAdapter = await createPiRuntimeAdapter({
	agent: nativeSkillAgent,
	sessionManager: createPiSessionHistory({ sessionId: "pi-native-skill-command-selftest" }),
	tools: [],
	cwd: process.cwd(),
	autoCompactionEnabled: false,
	reserveTokens: 8192,
	keepRecentTokens: 12000,
	piSkills: [{ name: "sales-analysis", description: "Analyze sales records", instructions: "NATIVE_SALES_SKILL_BODY", files: [
		{ path: "references/fields.md", contentBase64: Buffer.from("Revenue is net of refunds.").toString("base64") },
		{ path: "assets/sample.bin", contentBase64: Buffer.from([0, 255, 7]).toString("base64") },
	] }],
});
const nativeSkill = nativeSkillAdapter.session.resourceLoader.getSkills().skills[0];
const nativeSkillPath = nativeSkill?.filePath;
try {
	assert.ok(nativeSkillPath, "the enabled imported Pi skill is discovered by Pi's resource loader");
	assert.deepEqual(nativeSkillAdapter.session.settingsManager.getSettings().compaction, { enabled: false, reserveTokens: 8192, keepRecentTokens: 12000 }, "the Pi runtime receives the configured automatic compaction settings");
	assert.ok(nativeSkill?.baseDir, "Pi resource loader exposes a base directory for relative skill resources");
	assert.equal(await readFile(`${nativeSkill!.baseDir}/references/fields.md`, "utf8"), "Revenue is net of refunds.", "relative reference files are available beside the Pi skill");
	assert.deepEqual(await readFile(`${nativeSkill!.baseDir}/assets/sample.bin`), Buffer.from([0, 255, 7]), "binary skill assets preserve their bytes");
	await nativeSkillAdapter.prompt("/skill:sales-analysis Summarize last month's sales");
	assert.ok(piSkillPrompt.includes("NATIVE_SALES_SKILL_BODY"), "Pi expands /skill:name and injects the native skill body into the model request");
	assert.ok(piSkillPrompt.includes("Summarize last month's sales"), "text after the Pi skill command remains the user's task");
	console.log("Pi imported skill command and resources selftest passed (6 assertions)");
} finally {
	await nativeSkillAdapter.shutdown();
	if (nativeSkillPath) await assert.rejects(access(nativeSkillPath), "Pi skill snapshot is removed when its session shuts down");
}
