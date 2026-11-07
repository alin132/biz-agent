/**
 * 存储层契约：SQLite（默认）与 Postgres（配 `DATABASE_URL`）两种实现共用这一份接口。
 *
 * 为什么是**同步**签名：现有会话层/流程仓库/路由层全部按"同步存储"写的
 * （`Session` 构造里就落库、`SessionHub.get()` 直接返回对象、路由里 `hub.list()` 没有 await）。
 * 把接口改成 Promise 会顺着 `persist()` / `reload()` / 一堆路由一路改成异步，
 * 属于改业务层而不是换存储层。所以 Postgres 实现内部用工作线程 + Atomics.wait
 * 把异步驱动转成同步调用（见 `syncBridge.ts`），业务代码一行都不用动。
 */

import type { AuditEntry, WorkflowSkillText, WorkflowState, WorkflowStep } from "../../src/core/types.js";
import type { Store } from "../../src/store/memory.js";

export interface TranscriptEntry {
	role: "user" | "assistant";
	text: string;
	at: number;
	/** 用户轮次的整轮耗时和工具记录。 */
	durationMs?: number;
	tools?: Array<{
		id: string;
		name: string;
		args: unknown;
		ok?: boolean;
		result?: string;
		durationMs?: number;
	}>;
}

/** 自定义流程（运行时配置的那部分流程定义）。 */
export interface WorkflowRow {
	id: string;
	pluginId?: string;
	name: string;
	systemPrompt: string;
	steps: WorkflowStep[];
	/**
	 * 技能文案（可选）：技能目录里的一句话 + 加载后的正文。
	 * 不填也照样能当技能用（正文回落 systemPrompt），只是目录里少了"什么时候该用我"那句话。
	 */
	skill?: WorkflowSkillText;
	createdAt: number;
	updatedAt: number;
}

export interface PluginRecord {
	id: string;
	name: string;
	version: string;
	description: string;
	manifest: Record<string, unknown>;
	enabled: boolean;
	createdAt: number;
	updatedAt: number;
}

export interface PersistedSession {
	id: string;
	workflowId: string;
	modelId: string | null;
	/**
	 * 这条会话选中的模型记录 id（model-xxx）；缺省 = 没单独选过。
	 *
	 * 与全局「当前模型」不是一回事：全局那个只决定新建会话用哪条模型，
	 * 会话级换模型（`POST /api/sessions/:id/model`）改的是这里，重启后按它重新解析，
	 * 所以「换模型」不会串台到别的会话。老记录没有这个字段，按 null 处理。
	 */
	modelKey?: string | null;
	mode: "live" | "simulated";
	modeLabel: string;
	permissionMode: "full" | "readonly";
	/** 用户自定义标题；null 表示用首条消息自动派生 */
	title: string | null;
	/** 已归档：不在默认会话列表里露出，但随时能翻出来继续聊（老记录没有这个字段，视为未归档） */
	archived?: boolean;
	createdAt: number;
	updatedAt: number;
	done: boolean;
	transcript: TranscriptEntry[];
	audit: AuditEntry[];
	workflow: WorkflowState;
	store: Store;
	/** Pi 的 AgentMessage[]，用于恢复模型上下文 */
	agentMessages: unknown[];
	/** 当前加载的技能 id（= 流程 id）；老记录没有这个字段，视为没加载技能 */
	activeSkillId?: string | null;
	baseWorkflowState?: WorkflowState;
	/** 建会话的用户 id（P9 监控据此把 developer 限制在自己的会话上；老记录没有就是 null） */
	createdBy?: string | null;
	/** 最近 20 条调用链 id（倒序）；老记录没有这个字段 */
	traceIds?: string[];
	/** 这条对话是跟哪个已发布的 Agent 聊的；null / 缺省 = 没用 Agent 的普通对话 */
	agentId?: string | null;
	/** 绑定的 Agent 名字（冗余存一份：展示用，且 Agent 被删后历史会话仍能显示当时的名字）。 */
	agentName?: string | null;
	/** 会话创建时的执行策略快照；旧记录回落到绑定 Agent。 */
	agentConfig?: {
		modelConfig: AgentModelConfig;
		memoryConfig: AgentMemoryConfig;
		advancedConfig: AgentAdvancedConfig;
	};
	/** 计划模式：会话级开关，落进 payload 才能跨重启保持（见 planModePromptOf） */
	planMode?: boolean;
	/** 最近一次上下文压缩的时间戳；null / 缺省 = 还没压缩过 */
	compactedAt?: number | null;
	/** 最近一次压缩生成的摘要原文（重开会话时前端要能显示回消息列表） */
	summary?: string | null;
	/** 最近一次模型请求的输入上下文 token 数。 */
	contextTokens?: number;
	/** true 表示该值由本地文本估算得出。 */
	contextTokensEstimated?: boolean;
}

export type StorageKind = "sqlite" | "postgres";

/** `/api/health` 与启动日志里暴露的存储后端信息。 */
export interface StorageInfo {
	kind: StorageKind;
	/** 人能看懂的定位串：SQLite 是库文件绝对路径，Postgres 是 host:port/db（**不含密码**） */
	detail: string;
}

/** 一条已应用的 schema 迁移（SQLite 没有 SQL 迁移文件，返回空数组）。 */
export interface MigrationRecord {
	version: string;
	name: string;
	appliedAt: number;
}

/** `npm run db:check` 用的自检信息。 */
export interface StorageDiagnostics {
	/** 引擎版本，例如 "SQLite 3.49.1" / "PostgreSQL 16.4 on x86_64-pc-linux-gnu, ..." */
	version: string;
	/** public/sqlite_master 里的表名（升序） */
	tables: string[];
}

/* ---------------- 成员与平台审计（P3） ---------------- */

/**
 * 四个内置角色。权限矩阵在 `server/auth/roles.ts`（唯一真相），这里只是"库列的类型"，
 * 免得存储层反过来依赖 auth 层。
 */
export type Role = "owner" | "developer" | "operator" | "auditor";

export interface UserRecord {
	id: string;
	workspaceId: string;
	/** 已规范化（trim + 小写）的登录邮箱 */
	email: string;
	name: string | null;
	/** `scrypt$N$r$p$salt$hash` 自描述串；不存明文，也不存可逆加密 */
	passwordHash: string | null;
	role: Role;
	disabled: boolean;
	createdAt: number;
	lastLoginAt: number | null;
}

/** 建用户时能提供的字段（id / createdAt 由调用方生成，便于测试注入）。 */
export interface UserInput {
	id: string;
	workspaceId: string;
	email: string;
	name: string | null;
	passwordHash: string | null;
	role: Role;
	disabled: boolean;
	createdAt: number;
}

/**
 * 成员变更补丁：只列可改字段，`undefined` = 不动（`name: null` = 清空姓名）。
 * 校验（角色合法性 / 保护规则）在 `server/auth/service.ts`，DAO 只负责按补丁落库。
 */
export interface UserPatch {
	role?: Role;
	disabled?: boolean;
	name?: string | null;
}

/** 一条平台审计记录（登录、写接口等）；与 P9 的工具调用审计共用 audit_logs 表。 */
export interface AuditLogRecord {
	id: number;
	workspaceId: string;
	/** user / anonymous / system */
	actorType: string;
	actorId: string | null;
	/** 动作名，例如 auth.login / workflow.create */
	action: string;
	targetType: string | null;
	targetId: string | null;
	detail: unknown;
	traceId: string | null;
	createdAt: number;
}

export interface AuditLogInput {
	workspaceId: string;
	actorType: string;
	actorId: string | null;
	action: string;
	targetType?: string | null;
	targetId?: string | null;
	detail?: unknown;
	traceId?: string | null;
	createdAt: number;
}

export interface AuditFilter {
	limit: number;
	offset: number;
	/** 精确匹配动作名 */
	action?: string;
	/** 精确匹配 actor_id */
	actor?: string;
	/** 精确匹配 actor_type（user / anonymous / system / api_key）—— P9 审计查询增强 */
	actorType?: string;
	/** 精确匹配 target_type（session / workflow / user…） */
	targetType?: string;
	/** 时间下界（毫秒时间戳，含） */
	from?: number;
	/** 时间上界（毫秒时间戳，含） */
	to?: number;
	/** 动作/目标的模糊匹配（大小写不敏感，`%`/`_` 按字面量处理） */
	q?: string;
}

/* ---------------- 监控与可观测（P9） ---------------- */

/** 一条调用链的状态：running = 还在跑，ok / error = 已结束。 */
export type TraceStatus = "running" | "ok" | "error";

/** trace_events 的事件类型；只允许这几类，聚合 SQL 按 kind 分组。 */
export type TraceEventKind = "llm" | "tool" | "skill" | "mcp" | "approval" | "error";

/** traces 表的一行（一条用户消息 = 一条调用链）。 */
export interface TraceRecord {
	id: string;
	workspaceId: string;
	sessionId: string | null;
	workflowId: string | null;
	skillId: string | null;
	startedAt: number;
	finishedAt: number | null;
	status: TraceStatus;
	error: string | null;
}

/** 列表与详情用的 trace：model / toolCount 由 trace_events 派生子查询算出，不额外加列。 */
export interface TraceSummaryRecord extends TraceRecord {
	/** 本轮第一次 LLM 调用用的模型名；没有 llm 事件时为 null */
	model: string | null;
	/** 本轮工具调用次数 */
	toolCount: number;
}

/** trace_events 表的一行；ok / ms 只有部分事件有。 */
export interface TraceEventRecord {
	traceId: string;
	seq: number;
	kind: TraceEventKind;
	name: string | null;
	ok: boolean | null;
	ms: number | null;
	payload: unknown;
	createdAt: number;
}

/** 写入 trace 时的字段（id / startedAt 由采集器生成）。 */
export interface TraceInput {
	id: string;
	workspaceId: string;
	sessionId: string | null;
	workflowId: string | null;
	skillId: string | null;
	startedAt: number;
	finishedAt?: number | null;
	status?: TraceStatus;
	error?: string | null;
}

export interface TraceEventInput {
	traceId: string;
	seq: number;
	kind: TraceEventKind;
	name?: string | null;
	ok?: boolean | null;
	ms?: number | null;
	payload?: unknown;
	createdAt: number;
}

/** 调用链列表的过滤条件（分页 + 会话 + 时间窗；developer 还会用到 sessionIds 收窄权限）。 */
export interface TraceFilter {
	limit: number;
	offset: number;
	sessionId?: string;
	/** 只查这些会话（developer 只能看自己会话时用） */
	sessionIds?: string[];
	status?: TraceStatus;
	from?: number;
	to?: number;
}

/** `GET /api/monitor/summary` 的聚合结果（p95 由服务层算，SQL 只出原始毫秒序列）。 */
export interface MonitorStats {
	sessions: { total: number; active24h: number };
	/** range 窗口内的用户消息数（一轮消息 = 一条 trace） */
	messages: number;
	toolCalls: { total: number; ok: number; failed: number; avgMs: number };
	skills: { id: string; calls: number }[];
	mcp: { server: string; calls: number; failed: number }[];
	model: { model: string; calls: number; avgMs: number }[];
	errors: number;
	/** 工具调用耗时明细（服务层用来算 p95；SQL 不提供 percentile 聚合） */
	toolDurations: number[];
}

/* ---------------- 多模型管理（P6） ---------------- */

/**
 * 供应商类型：决定"用哪种协议探测/调用"。
 * ollama 与 custom 都按 OpenAI 兼容端点处理（Ollama 自带 /v1 兼容层）。
 */
export type ModelProviderKind = "openai" | "deepseek" | "ollama" | "anthropic" | "custom";

/** 模型用途：chat 能开会话，embedding 只给知识库/向量化用。 */
export type ModelType = "chat" | "embedding";

export interface ModelProviderRecord {
	id: string;
	name: string;
	kind: ModelProviderKind;
	/** OpenAI 兼容端点或官方端点前缀；null = 用内置默认 */
	baseUrl: string | null;
	/** AES-256-GCM 密文（`{v,iv,tag,data}` 的 JSON 文本）；出参永远只有掩码 */
	apiKeyEncrypted: string | null;
	enabled: boolean;
	createdAt: number;
	updatedAt: number;
}

export interface ModelProviderInput {
	id: string;
	name: string;
	kind: ModelProviderKind;
	baseUrl: string | null;
	apiKeyEncrypted: string | null;
	enabled: boolean;
	createdAt: number;
	updatedAt: number;
}

/** PATCH 语义：字段不传 = 不改；可空字段显式传 null = 清空。 */
export interface ModelProviderPatch {
	name?: string;
	kind?: ModelProviderKind;
	baseUrl?: string | null;
	apiKeyEncrypted?: string | null;
	enabled?: boolean;
	updatedAt: number;
}

export interface ModelRecord {
	id: string;
	providerId: string;
	name: string;
	/** 供应商那边的真实模型 id（例如 deepseek-chat） */
	modelId: string;
	kind: ModelType;
	enabled: boolean;
	contextWindow: number | null;
	createdAt: number;
	updatedAt: number;
}

export interface ModelInput {
	id: string;
	providerId: string;
	name: string;
	modelId: string;
	kind: ModelType;
	enabled: boolean;
	contextWindow: number | null;
	createdAt: number;
	updatedAt: number;
}

export interface ModelPatch {
	providerId?: string;
	name?: string;
	modelId?: string;
	kind?: ModelType;
	enabled?: boolean;
	contextWindow?: number | null;
	updatedAt: number;
}

/** 删供应商的返回：`removed=false` 表示供应商本来就不存在。 */
export interface RemoveProviderResult {
	removed: boolean;
	modelsRemoved: number;
}

/* ---------------- 开放 API 的 API Key（P4） ---------------- */

/** 库里只存 sha256(key)，明文只在创建那一刻返回一次。 */
export interface ApiKeyRecord {
	id: string;
	name: string;
	/** 明文前 8 位，方便人认出是哪把钥匙（不是完整密钥） */
	prefix: string;
	keyHash: string;
	role: Role;
	rateLimitPerMin: number;
	disabled: boolean;
	lastUsedAt: number | null;
	createdAt: number;
	/** 非 null = 已吊销（软删除，保留审计线索） */
	revokedAt: number | null;
}

export interface ApiKeyInput {
	id: string;
	name: string;
	prefix: string;
	keyHash: string;
	role: Role;
	rateLimitPerMin: number;
	disabled: boolean;
	lastUsedAt: number | null;
	createdAt: number;
	revokedAt: number | null;
}

export interface ApiKeyPatch {
	name?: string;
	role?: Role;
	rateLimitPerMin?: number;
	disabled?: boolean;
	lastUsedAt?: number | null;
	revokedAt?: number | null;
}

/* ---------------- MCP 集成（P7） ---------------- */

/** 三种传输：本地子进程 / 旧版 HTTP+SSE / 新版 Streamable HTTP。 */
export type McpTransport = "stdio" | "sse" | "http";

/** 最近一次发现的结果：ok = 握手与 tools/list 都成功，error = 失败（lastError 是中文原因）。 */
export type McpServerStatus = "unknown" | "ok" | "error";

/**
 * 一条 MCP 服务配置。
 *
 * stdio 用 command/args/env；http 与 sse 用 url/headers。多余的字段存 null/空对象，
 * 出参永远给全字段，前端不用做存在性判断。
 */
export interface McpServerRecord {
	id: string;
	name: string;
	transport: McpTransport;
	command: string | null;
	args: string[];
	url: string | null;
	headers: Record<string, string>;
	env: Record<string, string>;
	enabled: boolean;
	lastStatus: McpServerStatus;
	lastError: string | null;
	lastCheckedAt: number | null;
	createdAt: number;
	updatedAt: number;
}

export interface McpServerInput {
	id: string;
	name: string;
	transport: McpTransport;
	command: string | null;
	args: string[];
	url: string | null;
	headers: Record<string, string>;
	env: Record<string, string>;
	enabled: boolean;
	lastStatus?: McpServerStatus;
	lastError?: string | null;
	lastCheckedAt?: number | null;
	createdAt: number;
	updatedAt: number;
}

/** PATCH 语义：字段不传 = 不改（与流程/模型的 PATCH 一致）。 */
export interface McpServerPatch {
	name?: string;
	transport?: McpTransport;
	command?: string | null;
	args?: string[];
	url?: string | null;
	headers?: Record<string, string>;
	env?: Record<string, string>;
	enabled?: boolean;
	lastStatus?: McpServerStatus;
	lastError?: string | null;
	lastCheckedAt?: number | null;
	updatedAt: number;
}

/**
 * 一条从 MCP server `tools/list` 发现到的工具（原始名，不带 `mcp_` 前缀）。
 *
 * 对外暴露给模型的工具名由 `server/mcp/names.ts` 的 `mcpToolName()` 统一生成，
 * 库里只存 server 那边的原名——改名规则变了不用刷库。
 */
export interface McpToolRecord {
	id: string;
	serverId: string;
	name: string;
	description: string;
	/** MCP 的 inputSchema，原样透传给模型（缺省时归一成空 object schema）。 */
	inputSchema: Record<string, unknown>;
	enabled: boolean;
	createdAt: number;
}

export interface McpToolInput {
	id: string;
	serverId: string;
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	enabled: boolean;
	createdAt: number;
}

export interface McpToolPatch {
	description?: string;
	inputSchema?: Record<string, unknown>;
	enabled?: boolean;
}

/* ---------------- IM Bot 网关（P8） ---------------- */

/** IM 平台：目前只实现钉钉；wecom 留给后续（0001 的 check 约束里已经允许）。 */
export type ImPlatform = "dingtalk" | "wecom";

/**
 * 一个 IM 机器人。
 *
 * 凭证字段一律存 AES-256-GCM 密文（复用 `server/models/crypto.ts` 的 `encryptSecret`）：
 * - `appSecretEnc` 对应 0001 的 `app_secret_enc`（应用密钥，加签与换 access token 都用它）；
 * - `callbackTokenEnc` 对应 0001 的 `sign_secret_enc`（钉钉后台「回调签名 token」，也是秘密）；
 * - `aesKeyEnc` 是 0006 补的列（AES 加密回调可选，不配就走明文 JSON + 加签）。
 *
 * 为什么 callbackToken 复用 sign_secret_enc：0001 已经建好了列，且语义就是"签名密钥"；
 * 加新列反而会留下两列含义重叠的坑，这里在注释里把映射写死。
 */
export interface ImBotRecord {
	id: string;
	workspaceId: string;
	name: string;
	platform: ImPlatform;
	/** 钉钉应用的 AppKey（不是秘密，出参可以给明文） */
	appKey: string;
	/** appSecret 的密文 */
	appSecretEnc: string;
	/** 回调签名 token 的密文（列名 sign_secret_enc） */
	callbackTokenEnc: string;
	/** 钉钉机器人 / 应用的 robotCode */
	robotCode: string;
	/** AES 回调密钥的密文；null = 没配置 */
	aesKeyEnc: string | null;
	/** 回调默认落到哪条内部流程/技能（默认 auto-flow） */
	workflowId: string;
	enabled: boolean;
	/** 最近一次通过校验的回调时间（毫秒时间戳） */
	lastCallbackAt: number | null;
	createdAt: number;
	updatedAt: number;
}

export interface ImBotInput {
	id: string;
	workspaceId: string;
	name: string;
	platform: ImPlatform;
	appKey: string;
	appSecretEnc: string;
	callbackTokenEnc: string;
	robotCode: string;
	aesKeyEnc: string | null;
	workflowId: string;
	enabled: boolean;
	createdAt: number;
	updatedAt: number;
}

/** PATCH 语义：字段不传 = 不改；`aesKeyEnc` 显式传 null = 清空。 */
export interface ImBotPatch {
	name?: string;
	appKey?: string;
	appSecretEnc?: string;
	callbackTokenEnc?: string;
	robotCode?: string;
	aesKeyEnc?: string | null;
	workflowId?: string;
	enabled?: boolean;
	lastCallbackAt?: number | null;
	updatedAt: number;
}

/** 外部会话 ↔ 内部会话的映射（同一 bot + conversationId 只有一行）。 */
export interface ImSessionRecord {
	id: string;
	botId: string;
	conversationId: string;
	externalUserId: string | null;
	/** 映射到的内部会话 id */
	sessionId: string;
	/** 最近处理过的钉钉 msgId（幂等双保险） */
	lastMsgId: string | null;
	createdAt: number;
	updatedAt: number;
}

export interface ImSessionInput {
	id: string;
	botId: string;
	conversationId: string;
	externalUserId: string | null;
	sessionId: string;
	lastMsgId: string | null;
	createdAt: number;
	updatedAt: number;
}

export interface ImSessionPatch {
	sessionId?: string;
	externalUserId?: string | null;
	lastMsgId?: string | null;
	updatedAt: number;
}

/**
 * 存储层接口。方法名与拆分前的 `SessionDb` 完全一致（会话 7 个 + 流程 4 个 + close），
 * 只是多了 `info/diagnostics/migrations` 三个自检用的只读方法，以及 P3 的成员/审计、
 * P6 的多模型、P4 的 API Key、P7 的 MCP、P8 的 IM Bot（全部保持**同步**契约，见坑 22）。
 */
export interface Storage {
	readonly kind: StorageKind;
	info(): StorageInfo;
	diagnostics(): StorageDiagnostics;
	migrations(): MigrationRecord[];

	/* ---------------- 会话（单表 payload：元数据做列，整条会话序列化进 payload） ---------------- */
	save(record: PersistedSession): void;
	load(id: string): PersistedSession | undefined;
	list(): PersistedSession[];
	/** 只取 id，用于和内存中的活跃会话合并。 */
	ids(): string[];
	remove(id: string): boolean;
	clear(): number;
	count(): number;

	/* ---------------- 插件包 ---------------- */
	listPlugins(): PluginRecord[];
	getPlugin(id: string): PluginRecord | undefined;
	createPlugin(plugin: PluginRecord): PluginRecord;
	updatePlugin(id: string, patch: Partial<Pick<PluginRecord, "enabled" | "manifest" | "updatedAt">>): PluginRecord | undefined;
	removePlugin(id: string): boolean;

	/* ---------------- 自定义流程（内置流程在代码里，不落库） ---------------- */
	saveWorkflow(row: WorkflowRow): void;
	getWorkflow(id: string): WorkflowRow | undefined;
	listWorkflows(): WorkflowRow[];
	removeWorkflow(id: string): boolean;

	/* ---------------- 成员（P3） ---------------- */
	getUserByEmail(email: string): UserRecord | undefined;
	getUserById(id: string): UserRecord | undefined;
	createUser(user: UserInput): UserRecord;
	/** 全部用户（按创建时间升序），成员页用；返回值不含明文口令（只有哈希） */
	listUsers(): UserRecord[];
	countUsers(): number;
	updateLoginTime(id: string, at: number): void;
	/** 按补丁更新成员（只写传了的字段）；id 不存在返回 undefined（P3 成员写接口） */
	updateUser(id: string, patch: UserPatch): UserRecord | undefined;
	/** 物理删除成员（不是停用）；返回是否真的删掉了一行 */
	deleteUser(id: string): boolean;

	/* ---------------- 平台审计（P3，倒序 = 最新的在前） ---------------- */
	appendAudit(entry: AuditLogInput): void;
	listAudit(filter: AuditFilter): AuditLogRecord[];
	countAudit(filter?: Omit<AuditFilter, "limit" | "offset">): number;

	/* ---------------- 多模型管理（P6） ---------------- */
	getModelSetting(key: string): string | undefined;
	setModelSetting(key: string, value: string | null): void;
	listModelProviders(): ModelProviderRecord[];
	getModelProvider(id: string): ModelProviderRecord | undefined;
	createModelProvider(provider: ModelProviderInput): ModelProviderRecord;
	updateModelProvider(id: string, patch: ModelProviderPatch): ModelProviderRecord | undefined;
	/** 删供应商连带删它的模型（SQLite 没开外键，PG 靠事务/级联，两种后端行为一致）。 */
	removeModelProvider(id: string): RemoveProviderResult;
	listModels(): ModelRecord[];
	getModel(id: string): ModelRecord | undefined;
	createModel(model: ModelInput): ModelRecord;
	updateModel(id: string, patch: ModelPatch): ModelRecord | undefined;
	removeModel(id: string): boolean;

	/* ---------------- 开放 API 的 API Key（P4） ---------------- */
	listApiKeys(): ApiKeyRecord[];
	/** 按 sha256 定位（一张表里 hash 唯一，前缀只用于展示） */
	getApiKeyByHash(keyHash: string): ApiKeyRecord | undefined;
	createApiKey(key: ApiKeyInput): ApiKeyRecord;
	updateApiKey(id: string, patch: ApiKeyPatch): ApiKeyRecord | undefined;
	removeApiKey(id: string): boolean;
	/** 每次鉴权成功更新 last_used_at */
	touchApiKey(id: string, at: number): void;

	/* ---------------- MCP 集成（P7，同步契约） ---------------- */
	listMcpServers(): McpServerRecord[];
	getMcpServer(id: string): McpServerRecord | undefined;
	createMcpServer(server: McpServerInput): McpServerRecord;
	updateMcpServer(id: string, patch: McpServerPatch): McpServerRecord | undefined;
	/** 删服务连带删它发现到的工具（SQLite 没开外键，PG 靠外键/事务，两种后端行为一致）。 */
	removeMcpServer(id: string): boolean;
	/** 不传 serverId = 全部工具（启动时重建快照用）。 */
	listMcpTools(serverId?: string): McpToolRecord[];
	getMcpTool(id: string): McpToolRecord | undefined;
	createMcpTool(tool: McpToolInput): McpToolRecord;
	updateMcpTool(id: string, patch: McpToolPatch): McpToolRecord | undefined;
	removeMcpTool(id: string): boolean;
	removeMcpToolsByServer(serverId: string): number;

	/* ---------------- IM Bot 网关（P8，同步契约） ---------------- */
	listImBots(): ImBotRecord[];
	getImBot(id: string): ImBotRecord | undefined;
	createImBot(bot: ImBotInput): ImBotRecord;
	updateImBot(id: string, patch: ImBotPatch): ImBotRecord | undefined;
	/** 删机器人连带删它的会话映射（SQLite 没开外键，PG 靠外键/事务，两种后端行为一致）。 */
	removeImBot(id: string): boolean;
	/** 某个机器人映射了几条外部会话（列表页的「会话数」）。 */
	countImSessions(botId: string): number;
	getImSession(botId: string, conversationId: string): ImSessionRecord | undefined;
	createImSession(session: ImSessionInput): ImSessionRecord;
	updateImSession(id: string, patch: ImSessionPatch): ImSessionRecord | undefined;
	removeImSessionsByBot(botId: string): number;

	/* ---------------- 监控与可观测（P9，同步契约） ---------------- */
	/** 批量 upsert 调用链（采集器每 200ms flush 一次；结束状态也用同一条路径更新）。 */
	saveTraces(records: TraceRecord[]): void;
	/** 批量追加事件；同一 (trace_id, seq) 重复写会被忽略（重试幂等）。 */
	appendTraceEvents(events: TraceEventInput[]): void;
	listTraces(filter: TraceFilter): TraceSummaryRecord[];
	countTraces(filter: Omit<TraceFilter, "limit" | "offset">): number;
	getTrace(id: string): TraceSummaryRecord | undefined;
	/** 某条调用链的全部事件，按 seq 升序。 */
	listTraceEvents(traceId: string): TraceEventRecord[];
	/** 监控首页聚合：`since` 是 range 窗口下界，`activeSince` 固定 24h 窗口。 */
	monitorStats(since: number, activeSince: number): MonitorStats;
	/**
	 * 清理保留期之外的调用链：先删过期事件、再删过期 trace，返回删除条数。
	 * 供采集器定时调用（`TRACE_RETENTION_DAYS`），不做任何业务判定。
	 */
	purgeTracesBefore(cutoffMs: number): { traces: number; events: number };

	/* ---------------- Agent 实体（P10，同步契约） ---------------- */
	listAgents(): AgentRecord[];
	getAgent(id: string): AgentRecord | undefined;
	createAgent(input: AgentInput): AgentRecord;
	/** 只写传了的字段；id 不存在返回 undefined */
	updateAgent(id: string, patch: AgentPatch): AgentRecord | undefined;
	/** 只改状态与状态时间（状态机专用，避免和配置更新混在一起） */
	setAgentStatus(id: string, status: AgentStatus, at: number): AgentRecord | undefined;
	removeAgent(id: string): boolean;
	countAgents(): number;

	close(): void;
}

/* ---------------- Agent 实体（P10：六维配置 + 状态机） ---------------- */

/**
 * Agent 状态机：draft → testing → published → stopped，任意态可 revert 回 draft。
 *
 * 语义照搬 AgentOne，别自己发明：
 *  - 仅 draft / testing / published 可对话，stopped 一律拒绝；
 *  - 已发布（published）不可直接改配置，必须先 revert 回草稿。
 */
export type AgentStatus = "draft" | "testing" | "published" | "stopped";

export type AgentAction = "test" | "publish" | "stop" | "revert";

/** 模型策略：对应 AgentOne 的 modelConfig */
export interface AgentModelConfig {
	/** 模型记录的 id（model-xxx）；空 = 用当前模型 */
	chatModelId?: string | null;
	temperature?: number;
	topP?: number;
	maxTokens?: number;
	stream?: boolean;
}

/** 记忆策略：对应 AgentOne 的 memoryConfig */
export interface AgentMemoryConfig {
	/** 短期记忆保留几轮 */
	shortTermRounds?: number;
	/** 溢出策略 */
	overflowStrategy?: "sliding_window" | "summarize";
}

/** 高级配置：对应 AgentOne 的 advancedConfig，留给未来扩展 */
export interface AgentAdvancedConfig {
	/** 最大推理轮数 */
	maxIters?: number;
	/** 是否把思考过程透传给前端 */
	showThinking?: boolean;
	[key: string]: unknown;
}

export interface AgentRecord {
	/** agent_xxx */
	id: string;
	workspaceId: string;
	/** 基础信息（六维第一维） */
	name: string;
	description: string;
	category: string;
	icon: string;
	/** 人格与指令：Markdown 源码，相当于 AGENTS.md */
	agentsMd: string;
	/** 模型策略 / 记忆 / 高级 */
	modelConfig: AgentModelConfig;
	memoryConfig: AgentMemoryConfig;
	advancedConfig: AgentAdvancedConfig;
	/** 能力绑定：技能 id 列表 + 知识库 id 列表 */
	skillIds: string[];
	kbIds: string[];
	status: AgentStatus;
	createdBy: string | null;
	createdAt: number;
	updatedAt: number;
	/** 最近一次状态变更时间 */
	statusChangedAt: number;
}

export interface AgentInput {
	id: string;
	name: string;
	status: AgentStatus;
	createdAt: number;
	updatedAt: number;
	statusChangedAt: number;
	description?: string;
	category?: string;
	icon?: string;
	agentsMd?: string;
	modelConfig?: AgentModelConfig;
	memoryConfig?: AgentMemoryConfig;
	advancedConfig?: AgentAdvancedConfig;
	skillIds?: string[];
	kbIds?: string[];
	createdBy?: string | null;
}

/** PATCH 语义与流程/模型一致：字段不传 = 不改 */
export interface AgentPatch {
	/** 由服务层填；直接调 DAO 时要自己给 */
	updatedAt?: number;
	name?: string;
	description?: string;
	category?: string;
	icon?: string;
	agentsMd?: string;
	modelConfig?: AgentModelConfig;
	memoryConfig?: AgentMemoryConfig;
	advancedConfig?: AgentAdvancedConfig;
	skillIds?: string[];
	kbIds?: string[];
}

/**
 * 唯一的工作空间 id：P2 先只有一个"默认工作空间"，多租户留到需要时开
 * （见 docs/ROADMAP.md 关键决策）。Postgres 侧所有查询都把它当参数传，不拼 SQL。
 */
export const DEFAULT_WORKSPACE_ID = "default";
