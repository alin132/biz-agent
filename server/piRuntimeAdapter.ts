import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentMessage, AgentTool, AgentToolCall, AfterToolCallContext, BeforeToolCallContext, StreamFn } from "@earendil-works/pi-agent-core";
import {
	AgentSession,
	DefaultResourceLoader,
	SettingsManager,
	convertToLlm,
	createToolSearchExtension,
	type AgentSessionEventListener,
	type ExtensionAPI,
	type FileEntry,
	type InlineExtension,
	type ModelRuntime,
	type SessionManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ToolRegistry } from "../src/core/registry.js";
import { createAuditPolicy } from "../src/core/audit.js";
import { createPermissionPolicy } from "../src/core/permission.js";
import type { BusinessRuntime } from "../src/core/runtime.js";
import type { ToolRegistry as BusinessToolRegistry } from "../src/core/registry.js";
import type { BizContext, ToolDef } from "../src/core/types.js";
import type { WorkflowToolResult } from "../src/core/workflowPolicy.js";
import { serializePiSessionHistory } from "./piSessionHistory.js";

type ToolResultMessage = Extract<AgentMessage, { role: "toolResult" }>;

export interface CreatePiRuntimeAdapterOptions {
	agent: Agent;
	sessionManager: SessionManager;
	tools: AgentTool[];
	/** Additional Pi-native extensions whose tool names are also present in `tools`. */
	extensions?: InlineExtension[];
	nativeToolNames?: string[];
	toolNameAliases?: Record<string, string>;
	isToolAvailable?: (legacyName: string) => boolean;
	alwaysActiveToolNames?: string[];
	cwd: string;
	keepRecentTokens?: number;
	reserveTokens?: number;
	autoCompactionEnabled?: boolean;
	modelRuntime?: Promise<ModelRuntime>;
	piSkills?: Array<{ name: string; description: string; instructions: string; files?: Array<{ path: string; contentBase64: string }> }>;
	skill?: {
		name: string;
		description(): string;
		load(skillId: string): string;
		contextMessage?(): AgentMessage | null;
	};
	workflow?: {
		maxTurns: number;
		startRun(): void;
		finishTurn(toolResults: ToolResultMessage[]): { continue: boolean; terminateTools: boolean };
		nextPrompt(): string;
		limitReached(): boolean;
		onStateChange?(): void;
	};
}

export interface PiRuntimeAdapter {
	prompt(text: string): Promise<void>;
	followUp(text: string): Promise<void>;
	messages(): AgentMessage[];
	systemPrompt(): string;
	lastAssistantText(): string;
	lastAssistantMessage(): Extract<AgentMessage, { role: "assistant" }> | undefined;
	stats(): ReturnType<AgentSession["getSessionStats"]>;
	compact(instructions?: string): ReturnType<AgentSession["compact"]>;
	abort(): Promise<void>;
	setActiveToolsByName(names: string[]): void;
	canonicalToolName(name: string): string;
	setModel(model: Model<any>): Promise<void>;
	newSession(): void;
	getThinkingLevel?(): AgentSession["thinkingLevel"];
	setThinkingLevel?(level: AgentSession["thinkingLevel"]): void;
	navigateTree(targetId: string): ReturnType<AgentSession["navigateTree"]>;
	subscribe(listener: AgentSessionEventListener): () => void;
	exportHistory(): FileEntry[];
	piSkills(): string[];
	dispose(): void;
	shutdown(): Promise<void>;
	readonly session: AgentSession;
}

export type PiSessionStats = Omit<ReturnType<AgentSession["getSessionStats"]>, "sessionFile" | "sessionId">;

export interface CreatePiBusinessAgentOptions {
	business: BusinessRuntime;
	registry: BusinessToolRegistry;
	ctx: BizContext;
	model: Model<any>;
	streamFn: StreamFn;
	messages?: AgentMessage[];
	/** Tools registered by native Pi extensions instead of the business host extension. */
	nativeToolNames?: string[];
	toolNameAliases?: Record<string, string>;
	isToolAvailable?: (legacyName: string) => boolean;
}

export interface CreatePiBusinessRuntimeOptions extends CreatePiBusinessAgentOptions {
	sessionManager: SessionManager;
	cwd: string;
	keepRecentTokens?: number;
	reserveTokens?: number;
	autoCompactionEnabled?: boolean;
	modelRuntime?: Promise<ModelRuntime>;
	piSkills?: CreatePiRuntimeAdapterOptions["piSkills"];
	extensions?: InlineExtension[];
	nativeToolNames?: string[];
	alwaysActiveToolNames?: string[];
	skill?: CreatePiRuntimeAdapterOptions["skill"];
	workflow?: CreatePiRuntimeAdapterOptions["workflow"];
}

/** Adapt the pure business runtime into Pi's Agent API at the host boundary. */
export function createPiBusinessAgent(options: CreatePiBusinessAgentOptions): Agent {
	const history = options.messages ?? [];
	const firstNonSystem = history.findIndex((message) => message.role !== "system");
	const restored = firstNonSystem >= 0 ? history.slice(firstNonSystem) : [];
	return new Agent({
		initialState: {
			systemPrompt: options.business.systemPrompt,
			model: options.model,
			tools: toPiAgentTools(
				options.business.toolDefinitions().filter((tool) => !options.nativeToolNames?.includes(tool.name)),
				options.ctx,
			),
			...(restored.length > 0 ? { messages: restored } : {}),
		},
		streamFn: options.streamFn,
		beforeToolCall: createPiPermissionHook(options.ctx, options.registry, options.toolNameAliases, options.isToolAvailable),
		afterToolCall: createPiAuditHook(options.ctx, options.toolNameAliases),
	});
}

/** Create a complete Pi AgentSession from a pure business runtime description. */
export async function createPiBusinessRuntime(options: CreatePiBusinessRuntimeOptions): Promise<PiRuntimeAdapter> {
	const agent = createPiBusinessAgent(options);
	return createPiRuntimeAdapter({
		agent,
		sessionManager: options.sessionManager,
		tools: toPiAgentTools(options.registry.all(), options.ctx),
		cwd: options.cwd,
		keepRecentTokens: options.keepRecentTokens,
		reserveTokens: options.reserveTokens,
		autoCompactionEnabled: options.autoCompactionEnabled,
		modelRuntime: options.modelRuntime,
		piSkills: options.piSkills,
		extensions: options.extensions,
		nativeToolNames: options.nativeToolNames,
		toolNameAliases: options.toolNameAliases,
		isToolAvailable: options.isToolAvailable,
		alwaysActiveToolNames: options.alwaysActiveToolNames,
		skill: options.skill,
		workflow: options.workflow,
	});
}

/** Convert registered business tools into Pi-native tools. */
export function toPiAgentTools(definitions: ToolDef[], ctx: BizContext): AgentTool<any>[] {
	return definitions.map((def) => ({
		name: def.name,
		label: def.name,
		description: def.description,
		parameters: def.parameters,
		executionMode: def.risk === "high" ? "sequential" : "parallel",
		async execute(_toolCallId: string, params: Record<string, unknown>) {
			const result = await def.execute(params ?? {}, ctx);
			return {
				content: [{ type: "text" as const, text: result.content }],
				details: undefined,
				...(result.isError === true ? { isError: true } : {}),
			};
		},
	}));
}

function legacyToolName(name: string, aliases: Record<string, string> = {}): string {
	return aliases[name] ?? name;
}

export function createPiPermissionHook(
	ctx: BizContext,
	registry: BusinessToolRegistry,
	aliases: Record<string, string> = {},
	isToolAvailable?: (legacyName: string) => boolean,
) {
	const decide = createPermissionPolicy(ctx, registry);
	return async (before: BeforeToolCallContext) => {
		const toolName = legacyToolName(before.toolCall.name, aliases);
		if (isToolAvailable && !isToolAvailable(toolName)) {
			return { block: true as const, reason: `工具「${toolName}」已停用或不存在` };
		}
		const decision = await decide({ toolName, args: before.args as Record<string, unknown> | undefined });
		return decision.allowed ? undefined : { block: true as const, reason: decision.reason };
	};
}

export function createPiAuditHook(ctx: BizContext, aliases: Record<string, string> = {}) {
	const audit = createAuditPolicy(ctx);
	return async (after: AfterToolCallContext) => {
		const textBlocks = after.result.content.filter((block) => block.type === "text");
		const output = audit({
			toolName: legacyToolName(after.toolCall.name, aliases),
			args: after.args as Record<string, unknown> | undefined,
			isError: after.isError,
			content: textBlocks.map((block) => block.text),
		});
		let textIndex = 0;
		const content = after.result.content.map((block) => {
			if (block.type !== "text") return block;
			return { ...block, text: output.content[textIndex++]! };
		});
		return { content };
	};
}

export function lastAssistantTextOf(agent: Agent): string {
	const messages = agent.state.messages;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]!;
		if (message.role === "assistant") {
			return message.content.filter((block) => block.type === "text").map((block) => (block as { text: string }).text).join("");
		}
	}
	return "";
}

export interface CreatePiBusinessSessionOptions {
	model: Model<any>;
	streamFn: StreamFn;
	systemPrompt: string;
	tools: ToolDef[];
	ctx: BizContext;
	sessionManager: SessionManager;
	cwd: string;
	keepRecentTokens?: number;
	reserveTokens?: number;
	modelRuntime?: Promise<ModelRuntime>;
	workflow: {
		maxTurns: number;
		startRun(): void;
		finishTurn(toolResults: WorkflowToolResult[]): { continue: boolean; terminateTools: boolean };
		nextPrompt(): string;
		limitReached(): boolean;
	};
}

/** Build a Pi-owned nested business session; core workflow code never constructs Pi agents. */
export async function createPiBusinessSession(options: CreatePiBusinessSessionOptions): Promise<{
	prompt(text: string): Promise<void>;
	text(): string;
	dispose(): void;
}> {
	const registry = new ToolRegistry().registerAll(options.tools);
	const agent = new Agent({
		initialState: {
			systemPrompt: options.systemPrompt,
			model: options.model,
			tools: toPiAgentTools(options.tools, options.ctx),
		},
		streamFn: options.streamFn,
		beforeToolCall: createPiPermissionHook(options.ctx, registry),
		afterToolCall: createPiAuditHook(options.ctx),
	});
	const runtime = await createPiRuntimeAdapter({
		agent,
		sessionManager: options.sessionManager,
		tools: agent.state.tools,
		cwd: options.cwd,
		keepRecentTokens: options.keepRecentTokens,
		reserveTokens: options.reserveTokens,
		modelRuntime: options.modelRuntime,
		workflow: options.workflow,
	});
	return {
		prompt: runtime.prompt,
		text: () => lastAssistantTextOf(agent),
		dispose: runtime.dispose,
	};
}

function hostExtension(
	agent: Agent,
	beforeToolCall: Agent["beforeToolCall"],
	afterToolCall: Agent["afterToolCall"],
	workflow: CreatePiRuntimeAdapterOptions["workflow"],
	turnState: { index: number; limitReached: boolean },
	skill: CreatePiRuntimeAdapterOptions["skill"],
	tools: AgentTool[],
	nativeToolNames: Set<string>,
): InlineExtension {
	return {
		name: "biz-agent-host",
		hidden: true,
		factory: (pi: ExtensionAPI) => {
			for (const tool of tools) {
				if ((skill && tool.name === skill.name) || nativeToolNames.has(tool.name)) continue;
				pi.registerTool({
					name: tool.name,
					label: tool.label,
					description: tool.description,
					parameters: tool.parameters as ToolDefinition["parameters"],
					...(tool.executionMode ? { executionMode: tool.executionMode } : {}),
					...(tool.prepareArguments ? { prepareArguments: tool.prepareArguments } : {}),
					...(tool.outputSchema ? { outputSchema: tool.outputSchema as ToolDefinition["outputSchema"] } : {}),
					...(!agent.state.tools.some((active) => active.name === tool.name) ? { exposure: "deferred" as const } : {}),
					defaultActive: false,
					async execute(toolCallId, params, signal, onUpdate) {
						const result = await tool.execute(toolCallId, params, signal, onUpdate);
						return workflow && turnState.index + 1 >= workflow.maxTurns
							? { ...result, terminate: true }
							: result;
					},
				});
			}
			if (skill) {
				pi.registerTool({
					name: skill.name,
					label: "加载技能",
					description: skill.description(),
					parameters: {
						type: "object",
						properties: { skillId: { type: "string", description: "要加载的技能 id" } },
						required: ["skillId"],
					} as ToolDefinition["parameters"],
					defaultActive: false,
					prepareLoadout: () => ({ descriptions: { [skill.name]: skill.description() } }),
					async execute(_toolCallId, params) {
						try {
							const skillId = (params as Record<string, unknown>).skillId;
							if (typeof skillId !== "string" || !skillId) throw new Error("技能 id 不能为空");
							return { content: [{ type: "text", text: skill.load(skillId) }], details: undefined };
						} catch (error) {
							return {
								content: [{ type: "text", text: `加载技能失败：${error instanceof Error ? error.message : String(error)}` }],
								details: undefined,
								isError: true,
							};
						}
					},
				});
			}
			pi.on("context", (event) => {
				const skillMessage = skill?.contextMessage?.();
				return skillMessage ? { messages: [skillMessage, ...event.messages] } : undefined;
			});
			pi.on("tool_call", async (event) => {
				const assistantMessage = [...agent.state.messages].reverse().find((message) => message.role === "assistant");
				if (!assistantMessage || assistantMessage.role !== "assistant") {
					return { block: true, reason: "找不到发起工具调用的模型消息" };
				}
				const result = await beforeToolCall?.({
					assistantMessage,
					toolCall: {
						type: "toolCall",
						id: event.toolCallId,
						name: event.toolName,
						arguments: event.input as AgentToolCall["arguments"],
					},
					args: event.input,
					context: { messages: agent.state.messages, tools: agent.state.tools },
				});
				return result?.block ? { block: true, reason: result.reason, terminate: result.terminate } : undefined;
			});

			pi.on("tool_result", async (event) => {
				const assistantMessage = [...agent.state.messages].reverse().find((message) => message.role === "assistant");
				if (!assistantMessage || assistantMessage.role !== "assistant") return undefined;
				const result = await afterToolCall?.({
					assistantMessage,
					toolCall: {
						type: "toolCall",
						id: event.toolCallId,
						name: event.toolName,
						arguments: event.input as AgentToolCall["arguments"],
					},
					args: event.input,
					result: {
						content: event.content,
						details: event.details,
						structuredContent: event.structuredContent,
						usage: event.usage,
						isError: event.isError,
					},
					isError: event.isError,
					context: { messages: agent.state.messages, tools: agent.state.tools },
				});
				return result
					? {
						...(result ?? {}),
						...(result?.content ? { content: result.content } : {}),
						...(result?.details !== undefined ? { details: result.details } : {}),
						...(result?.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
						...(result?.isError !== undefined ? { isError: result.isError } : {}),
						...(result?.usage !== undefined ? { usage: result.usage } : {}),
					}
					: undefined;
			});
		},
	};
}

function modelRuntimeFacade(model: Model<any>): ModelRuntime {
	const findModel = (provider: string, modelId: string): Model<any> | undefined =>
		provider === model.provider && modelId === model.id ? model : undefined;
	const facade = {
		getModel: findModel,
		getPhysicalModel: findModel,
		getModels: () => [model],
		getAvailableSnapshot: () => [model],
		hasConfiguredAuth: () => true,
		checkAuth: async () => ({}),
		isUsingOAuth: () => false,
		getAuth: async () => undefined,
		getError: () => undefined,
		getProvider: () => undefined,
		getModelOfType: () => undefined,
		getCompatibilityRequestConfig: () => ({}),
		getProviderAuthStatus: () => ({ configured: true }),
		refresh: async () => ({ added: 0, removed: 0, updated: 0 }),
	};
	return facade as unknown as ModelRuntime;
}

/**
 * Add Pi coding-agent's session lifecycle and compaction to a Pi Agent built from business policy.
 * The host supplies storage and business policy; Pi owns model execution and session lifecycle.
 */
export async function createPiRuntimeAdapter(options: CreatePiRuntimeAdapterOptions): Promise<PiRuntimeAdapter> {
	const { agent, sessionManager, tools, cwd } = options;
	const canonicalToolName = (name: string) => legacyToolName(name, options.toolNameAliases);
	const model = agent.state.model;
	if (!model) throw new Error("Pi session adapter requires a selected model");

	const settingsManager = SettingsManager.inMemory({
		compaction: {
			enabled: options.autoCompactionEnabled ?? true,
			reserveTokens: Math.max(0, Math.round(options.reserveTokens ?? 16_384)),
			keepRecentTokens: Math.max(0, Math.round(options.keepRecentTokens ?? 20_000)),
		},
	});
	const modelRuntime = options.modelRuntime ? await options.modelRuntime : modelRuntimeFacade(model);
	agent.convertToLlm = convertToLlm;
	const beforeToolCall = agent.beforeToolCall;
	const afterToolCall = agent.afterToolCall;
	const turnState = { index: 0, limitReached: false };
	const previousTransformContext = agent.transformContext;
	let session: AgentSession | undefined;
	const piSkillDir = options.piSkills?.length ? await mkdtemp(join(tmpdir(), "biz-agent-pi-skills-")) : null;
	const skillPaths: string[] = [];
	try {
		for (const [index, skill] of (options.piSkills ?? []).entries()) {
			if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.name)) throw new Error(`Invalid Pi skill name: ${skill.name}`);
			const skillRoot = join(piSkillDir!, `${index}-${skill.name}`);
			await mkdir(skillRoot, { recursive: true });
			const filePath = join(skillRoot, "SKILL.md");
			const description = JSON.stringify(skill.description);
			await writeFile(filePath, `---\nname: ${skill.name}\ndescription: ${description}\ndisable-model-invocation: true\n---\n\n${skill.instructions}\n`, "utf8");
			const resourcePaths = new Set<string>();
			let resourceBytes = 0;
			if ((skill.files?.length ?? 0) > 40) throw new Error("Pi skill resources exceed 40 files");
			for (const file of skill.files ?? []) {
				if (typeof file.path !== "string" || !file.path || file.path.includes("\\") || file.path.startsWith("/") || file.path.split("/").some((part) => !part || part === "." || part === ".." || part.startsWith(".")) || file.path.split("/").at(-1)?.toLowerCase() === "skill.md") {
					throw new Error(`Invalid Pi skill resource path: ${String(file.path)}`);
				}
				if (typeof file.contentBase64 !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.contentBase64)) {
					throw new Error(`Invalid Pi skill resource encoding: ${file.path}`);
				}
				if (resourcePaths.has(file.path.toLowerCase())) throw new Error(`Duplicate Pi skill resource path: ${file.path}`);
				resourcePaths.add(file.path.toLowerCase());
				const bytes = Buffer.from(file.contentBase64, "base64");
				if (bytes.length > 512 * 1024) throw new Error(`Pi skill resource exceeds 512 KB: ${file.path}`);
				resourceBytes += bytes.length;
				if (resourceBytes > 2 * 1024 * 1024) throw new Error("Pi skill resources exceed 2 MB");
				const target = join(skillRoot, ...file.path.split("/"));
				await mkdir(dirname(target), { recursive: true });
				await writeFile(target, bytes, { mode: 0o600 });
			}
			skillPaths.push(skillRoot);
		}
	} catch (error) {
		if (piSkillDir) await rm(piSkillDir, { recursive: true, force: true });
		throw error;
	}
	if (options.workflow) {
		const policy = options.workflow;
		const previousFinishTurn = agent.finishTurn;
		const previousPrepareNextTurn = agent.prepareNextTurnWithContext ?? (agent.prepareNextTurn
			? async (_turn, signal) => agent.prepareNextTurn?.(signal)
			: undefined);
			agent.finishTurn = async (turn, signal) => {
			const toolResults = turn.toolResults as ToolResultMessage[];
			const hasToolSearch = toolResults.some((result) => result.role === "toolResult" && result.toolName === "tool_search");
			const canonicalResults = toolResults.map((result) => result.role === "toolResult"
				? { ...result, toolName: legacyToolName(result.toolName, options.toolNameAliases) }
				: result);
			const decision = policy.finishTurn(canonicalResults.filter((result) => result.role !== "toolResult" || result.toolName !== "tool_search"));
			policy.onStateChange?.();
			if (hasToolSearch && !policy.limitReached()) decision.continue = true;
			turnState.index++;
			turnState.limitReached = policy.limitReached();
			const previous = await previousFinishTurn?.(turn, signal);
			if (previous?.action === "end" || !decision.continue) return { action: "end" as const };
			return { action: "continue" as const };
		};
		agent.prepareNextTurnWithContext = async (turn, signal) => {
			const previous = await previousPrepareNextTurn?.(turn, signal);
			const prompt = policy.nextPrompt();
			return {
				...previous,
				...(prompt ? { messages: [...(previous?.messages ?? []), { role: "user" as const, content: prompt, timestamp: Date.now() }] } : {}),
			};
		};
	}
	agent.transformContext = async (messages, signal) => {
		const transformed = previousTransformContext ? await previousTransformContext(messages, signal) : messages;
		return session ? session.extensionRunner.emitContext(transformed) : transformed;
	};
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir: cwd,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		additionalSkillPaths: skillPaths,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		extensionFactories: [
			hostExtension(agent, beforeToolCall, afterToolCall, options.workflow, turnState, options.skill, tools, new Set(options.nativeToolNames ?? [])),
			createToolSearchExtension(),
			...(options.extensions ?? []),
		],
		systemPrompt: agent.state.systemPrompt,
	});
	await resourceLoader.reload();
	const toolNames = new Set(tools.map((tool) => tool.name));
	if (toolNames.size !== tools.length) throw new Error("Pi session adapter received duplicate tool names");
	for (const name of options.alwaysActiveToolNames ?? []) toolNames.add(name);
	const piNamesFor = (names: string[]) => names.map((name) => Object.entries(options.toolNameAliases ?? {}).find(([, legacy]) => legacy === name)?.[0] ?? name);
	for (const nativeName of Object.keys(options.toolNameAliases ?? {})) toolNames.add(nativeName);
	session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd,
		modelRuntime,
		resourceLoader,
		initialActiveToolNames: [...new Set([...piNamesFor(agent.state.tools.map((tool) => tool.name)), ...(options.alwaysActiveToolNames ?? [])])],
	});
	await session.bindExtensions({});
	const runtimeSession = session;
	let shutdownPromise: Promise<void> | null = null;
	const shutdown = (): Promise<void> => {
		if (!shutdownPromise) {
			shutdownPromise = (async () => {
				try {
					await runtimeSession.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
				} finally {
					runtimeSession.dispose();
					if (piSkillDir) await rm(piSkillDir, { recursive: true, force: true });
				}
			})();
		}
		return shutdownPromise;
	};

	return {
		session: runtimeSession,
		messages: () => runtimeSession.agent.state.messages,
		systemPrompt: () => runtimeSession.agent.state.systemPrompt,
		lastAssistantText: () => lastAssistantTextOf(runtimeSession.agent),
		lastAssistantMessage: () => [...runtimeSession.agent.state.messages].reverse().find((message) => message.role === "assistant"),
		prompt: async (text) => {
			turnState.index = 0;
			turnState.limitReached = false;
			options.workflow?.startRun();
			return session.prompt(text, { expandPromptTemplates: true, source: "rpc" });
		},
		followUp: async (text) => {
			await session.prompt(text, { expandPromptTemplates: true, source: "rpc", streamingBehavior: "followUp" });
		},
		stats: () => runtimeSession.getSessionStats(),
		compact: (instructions) => runtimeSession.compact(instructions),
		abort: () => runtimeSession.abort(),
		setModel: (nextModel) => runtimeSession.setModel(nextModel, { persist: false }),
		setActiveToolsByName: (names) => {
			for (const name of names) {
				if (!toolNames.has(name)) throw new Error(`Pi session adapter has no registered tool: ${name}`);
			}
			runtimeSession.setActiveToolsByName([...new Set([...piNamesFor(names), ...(options.alwaysActiveToolNames ?? [])])]);
		},
		canonicalToolName: (name) => canonicalToolName(name),
		newSession: () => {
			sessionManager.newSession();
			agent.state.messages = [];
		},
		getThinkingLevel: () => runtimeSession.thinkingLevel,
		setThinkingLevel: (level) => runtimeSession.setThinkingLevel(level),
		navigateTree: (targetId) => runtimeSession.navigateTree(targetId),
		subscribe: (listener) => runtimeSession.subscribe(listener),
		exportHistory: () => serializePiSessionHistory(sessionManager),
		piSkills: () => runtimeSession.resourceLoader.getSkills().skills.map((skill) => skill.name),
		dispose: () => { void shutdown().catch(() => runtimeSession.dispose()); },
		shutdown,
	};
}
