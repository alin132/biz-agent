/**
 * Postgres 实现（配了 `DATABASE_URL` 时启用；默认仍走 SQLite）。
 *
 * 三层结构：
 *   本文件    —— 与 SQLite 完全一样的同步接口，SQL 全部参数化（工作空间 id 也是参数）
 *   syncBridge —— 主线程同步等、工作线程干活
 *   postgresWorker —— 真正持有 `pg.Pool` 的地方（异步）
 *
 * 表结构见 `db/migrations/0001_init.sql`：`sessions.payload` / `workflows.definition` 是 jsonb，
 * 语义与 SQLite 的单表 payload 设计一致（整条会话序列化），只有需要 SQL 过滤的字段做成列。
 */

import { runMigrations, SCHEMA_MIGRATIONS_DDL } from "./migrations.js";
import type { Migration } from "./migrations.js";
import { SyncWorkerBridge } from "./syncBridge.js";
import {
	type AgentGroupMemberRecord,
	type AgentGroupMessageRecord,
	type AgentGroupRecord,
	type AgentGroupTurnRecord,
	DEFAULT_WORKSPACE_ID,
	type PluginRecord,
	type AgentInput,
	type AgentPatch,
	type AgentRecord,
	type AgentStatus,
	type ApiKeyInput,
	type ApiKeyPatch,
	type ApiKeyRecord,
	type AuditFilter,
	type AuditLogInput,
	type AuditLogRecord,
	type ImBotInput,
	type ImBotPatch,
	type ImBotRecord,
	type ImPlatform,
	type ImSessionInput,
	type ImSessionPatch,
	type ImSessionRecord,
	type MigrationRecord,
	type MonitorStats,
	type ModelInput,
	type ModelPatch,
	type ModelProviderInput,
	type ModelProviderKind,
	type ModelProviderPatch,
	type ModelProviderRecord,
	type ModelRecord,
	type ModelType,
	type McpServerInput,
	type McpServerPatch,
	type McpServerRecord,
	type McpServerStatus,
	type McpToolInput,
	type McpToolPatch,
	type McpToolRecord,
	type McpTransport,
	type PersistedSession,
	type RemoveProviderResult,
	type Role,
	type Storage,
	type StorageDiagnostics,
	type StorageInfo,
	type TraceEventInput,
	type TraceEventKind,
	type TraceEventRecord,
	type TraceFilter,
	type TraceRecord,
	type TraceStatus,
	type TraceSummaryRecord,
	type UserInput,
	type UserPatch,
	type UserRecord,
	type WorkflowRow,
} from "./types.js";
import type { WorkflowSkillText, WorkflowStep } from "../../src/core/types.js";

/** 工作线程入口（本仓库没有构建步骤，`tsx` 直接跑 `.ts`）。 */
const WORKER_URL = new URL("./postgresWorker.ts", import.meta.url);

/** users / audit_logs 的列清单抽出来复用（select 与 insert 的列必须对得上）。 */
const USER_COLUMNS_SQL =
	"SELECT id, workspace_id, email, name, password_hash, role, disabled, created_at, last_login_at FROM users";
const AUDIT_COLUMNS_SQL =
	"SELECT id, workspace_id, actor_type, actor_id, action, target_type, target_id, detail, trace_id, created_at FROM audit_logs";
const PROVIDER_COLUMNS_SQL =
	"SELECT id, name, kind, base_url, api_key_encrypted, enabled, created_at, updated_at FROM model_providers";
const MODEL_COLUMNS_SQL =
	"SELECT id, provider_id, name, model_id, kind, enabled, context_window, created_at, updated_at FROM models";
const API_KEY_COLUMNS_SQL =
	"SELECT id, name, prefix, key_hash, role, rate_limit_per_min, disabled, last_used_at, created_at, revoked_at FROM api_keys";
const MCP_SERVER_COLUMNS_SQL =
	"SELECT id, name, transport, command, args, url, headers, env, enabled, last_status, last_error, last_checked_at, created_at, updated_at FROM mcp_servers";
const MCP_TOOL_COLUMNS_SQL =
	"SELECT id, server_id, name, description, input_schema, enabled, created_at FROM mcp_tools";
const IM_BOT_COLUMNS_SQL =
	"SELECT id, workspace_id, name, platform, app_key, app_secret_enc, sign_secret_enc, robot_code, aes_key_enc, workflow_id, enabled, last_callback_at, created_at, updated_at FROM im_bots";
const IM_SESSION_COLUMNS_SQL =
	"SELECT id, bot_id, conversation_id, external_user_id, session_id, last_msg_id, created_at, updated_at FROM im_sessions";

/** 审计列表/计数的公共 WHERE：工作空间也走参数（$1），其余条件按需追加 $n。 */
function auditWhere(filter: {
	action?: string;
	actor?: string;
	actorType?: string;
	targetType?: string;
	from?: number;
	to?: number;
	q?: string;
}): { where: string; params: unknown[] } {
	const params: unknown[] = [DEFAULT_WORKSPACE_ID];
	const clauses = ["workspace_id = $1"];
	if (filter.action) {
		params.push(filter.action);
		clauses.push(`action = $${params.length}`);
	}
	if (filter.actor) {
		params.push(filter.actor);
		clauses.push(`actor_id = $${params.length}`);
	}
	if (filter.actorType) {
		params.push(filter.actorType);
		clauses.push(`actor_type = $${params.length}`);
	}
	if (filter.targetType) {
		params.push(filter.targetType);
		clauses.push(`target_type = $${params.length}`);
	}
	if (filter.from !== undefined) {
		params.push(filter.from);
		clauses.push(`created_at >= $${params.length}`);
	}
	if (filter.to !== undefined) {
		params.push(filter.to);
		clauses.push(`created_at <= $${params.length}`);
	}
	if (filter.q) {
		// 转义 % _ \ 让用户输入按字面量匹配（PG 的 LIKE 区分大小写，所以两边都 lower 一次）
		const pattern = `%${filter.q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
		params.push(pattern, pattern, pattern);
		const size = params.length;
		clauses.push(
			`(lower(action) LIKE lower($${size - 2}) ESCAPE '\\' OR lower(target_type) LIKE lower($${size - 1}) ESCAPE '\\' OR lower(target_id) LIKE lower($${size}) ESCAPE '\\')`,
		);
	}
	return { where: `WHERE ${clauses.join(" AND ")}`, params };
}

/** `workflows.definition` 这一列存的东西。 */
interface WorkflowDefinition {
	systemPrompt: string;
	steps: WorkflowStep[];
}

/** PG 的 int8/bigint 会以字符串返回，映射成 number；jsonb 正常是对象，字符串兼容一下（手工导入的数据）。 */
function asNumber(value: unknown): number {
	return typeof value === "number" ? value : Number(value);
}

function asJson<T>(value: unknown): T {
	return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

/** jsonb 列可能被手工导成字符串，解析失败一律当空，别让一行坏数据把服务搞崩。 */
function parseJsonValue(value: unknown): unknown {
	if (value === null || value === undefined) {
		return null;
	}
	if (typeof value !== "string") {
		return value;
	}
	try {
		return JSON.parse(value) as unknown;
	} catch {
		return null;
	}
}

function asStringArray(value: unknown): string[] {
	const parsed = parseJsonValue(value);
	return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
}

function asStringMap(value: unknown): Record<string, string> {
	const parsed = parseJsonValue(value);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return {};
	}
	return Object.fromEntries(
		Object.entries(parsed as Record<string, unknown>).filter(
			(entry): entry is [string, string] => typeof entry[1] === "string",
		),
	);
}

const EMPTY_INPUT_SCHEMA: Record<string, unknown> = { type: "object", properties: {} };

function asInputSchema(value: unknown): Record<string, unknown> {
	const parsed = parseJsonValue(value);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { ...EMPTY_INPUT_SCHEMA };
	}
	return parsed as Record<string, unknown>;
}

function toMcpServerRecord(row: Record<string, unknown>): McpServerRecord {
	const rawTransport = String(row.transport ?? "stdio");
	const transport: McpTransport = rawTransport === "http" || rawTransport === "sse" ? rawTransport : "stdio";
	const rawStatus = String(row.last_status ?? "unknown");
	const lastStatus: McpServerStatus = rawStatus === "ok" || rawStatus === "error" ? rawStatus : "unknown";
	return {
		id: String(row.id),
		name: String(row.name),
		transport,
		command: row.command === null || row.command === undefined ? null : String(row.command),
		args: asStringArray(row.args),
		url: row.url === null || row.url === undefined ? null : String(row.url),
		headers: asStringMap(row.headers),
		env: asStringMap(row.env),
		enabled: row.enabled === true,
		lastStatus,
		lastError: row.last_error === null || row.last_error === undefined ? null : String(row.last_error),
		lastCheckedAt:
			row.last_checked_at === null || row.last_checked_at === undefined ? null : asNumber(row.last_checked_at),
		createdAt: asNumber(row.created_at),
		updatedAt: asNumber(row.updated_at),
	};
}

function toMcpToolRecord(row: Record<string, unknown>): McpToolRecord {
	return {
		id: String(row.id),
		serverId: String(row.server_id),
		name: String(row.name),
		description: row.description === null || row.description === undefined ? "" : String(row.description),
		inputSchema: asInputSchema(row.input_schema),
		enabled: row.enabled === true,
		createdAt: asNumber(row.created_at),
	};
}

function toImBotRecord(row: Record<string, unknown>): ImBotRecord {
	return {
		id: String(row.id),
		workspaceId: String(row.workspace_id),
		name: String(row.name),
		platform: (String(row.platform) === "wecom" ? "wecom" : "dingtalk") as ImPlatform,
		appKey: row.app_key === null || row.app_key === undefined ? "" : String(row.app_key),
		appSecretEnc: row.app_secret_enc === null || row.app_secret_enc === undefined ? "" : String(row.app_secret_enc),
		callbackTokenEnc:
			row.sign_secret_enc === null || row.sign_secret_enc === undefined ? "" : String(row.sign_secret_enc),
		robotCode: row.robot_code === null || row.robot_code === undefined ? "" : String(row.robot_code),
		aesKeyEnc: row.aes_key_enc === null || row.aes_key_enc === undefined ? null : String(row.aes_key_enc),
		workflowId:
			row.workflow_id === null || row.workflow_id === undefined ? "auto-flow" : String(row.workflow_id),
		enabled: row.enabled === true,
		lastCallbackAt:
			row.last_callback_at === null || row.last_callback_at === undefined ? null : asNumber(row.last_callback_at),
		createdAt: asNumber(row.created_at),
		updatedAt: asNumber(row.updated_at),
	};
}

function toImSessionRecord(row: Record<string, unknown>): ImSessionRecord {
	return {
		id: String(row.id),
		botId: String(row.bot_id),
		conversationId: String(row.conversation_id),
		externalUserId:
			row.external_user_id === null || row.external_user_id === undefined ? null : String(row.external_user_id),
		sessionId: row.session_id === null || row.session_id === undefined ? "" : String(row.session_id),
		lastMsgId: row.last_msg_id === null || row.last_msg_id === undefined ? null : String(row.last_msg_id),
		createdAt: asNumber(row.created_at),
		updatedAt: asNumber(row.updated_at),
	};
}

export class PostgresStorage implements Storage {
	readonly kind = "postgres" as const;
	private readonly bridge: SyncWorkerBridge;
	private readonly workspaceId = DEFAULT_WORKSPACE_ID;

	constructor(private readonly databaseUrl: string) {
		this.bridge = new SyncWorkerBridge(WORKER_URL);
		this.bridge.init(databaseUrl);
		// 启动即迁移：先保证账本表在，再按文件名顺序补齐 db/migrations/*
		this.exec(SCHEMA_MIGRATIONS_DDL);
		runMigrations({
			applied: () => this.migrations(),
			apply: (migration: Migration) => this.applyMigration(migration),
		});
	}

	info(): StorageInfo {
		let detail = this.databaseUrl;
		try {
			const parsed = new URL(this.databaseUrl);
			const database = parsed.pathname.replace(/^\//, "") || "postgres";
			detail = `${parsed.hostname}:${parsed.port || "5432"}/${database}`;
		} catch {
			// 连接串不是标准 URL 时退回原文（不含口令的情况下也只是方便定位）
		}
		return { kind: "postgres", detail };
	}

	diagnostics(): StorageDiagnostics {
		const version = this.rows("SELECT version() AS version")[0]?.version;
		const tables = this.rows(
			"SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
		).map((row) => String(row.tablename));
		return { version: String(version ?? "PostgreSQL"), tables };
	}

	migrations(): MigrationRecord[] {
		return this.rows("SELECT version, name, applied_at FROM schema_migrations ORDER BY version ASC").map((row) => ({
			version: String(row.version),
			name: String(row.name),
			appliedAt: asNumber(row.applied_at),
		}));
	}

	/* ---------------- 插件包 ---------------- */

	listPlugins(): PluginRecord[] {
		return this.rows("SELECT * FROM plugins WHERE workspace_id = $1 ORDER BY created_at ASC", [this.workspaceId]).map((row) => this.toPluginRecord(row));
	}

	getPlugin(id: string): PluginRecord | undefined {
		const row = this.rows("SELECT * FROM plugins WHERE id = $1 AND workspace_id = $2", [id, this.workspaceId])[0];
		return row ? this.toPluginRecord(row) : undefined;
	}

	createPlugin(plugin: PluginRecord): PluginRecord {
		this.exec("INSERT INTO plugins (id,workspace_id,name,version,description,manifest,enabled,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)", [plugin.id,this.workspaceId,plugin.name,plugin.version,plugin.description,JSON.stringify(plugin.manifest),plugin.enabled,plugin.createdAt,plugin.updatedAt]);
		return plugin;
	}

	updatePlugin(id: string, patch: Partial<Pick<PluginRecord, "enabled" | "manifest" | "updatedAt">>): PluginRecord | undefined {
		const current = this.getPlugin(id); if (!current) return undefined; const next = { ...current, ...patch };
		this.exec("UPDATE plugins SET manifest=$1::jsonb, enabled=$2, updated_at=$3 WHERE id=$4 AND workspace_id=$5", [JSON.stringify(next.manifest),next.enabled,next.updatedAt,id,this.workspaceId]); return next;
	}

	removePlugin(id: string): boolean { return this.rowCount("DELETE FROM plugins WHERE id=$1 AND workspace_id=$2", [id,this.workspaceId]) > 0; }

	private toPluginRecord(row: Record<string, unknown>): PluginRecord {
		return { id:String(row.id),name:String(row.name),version:String(row.version),description:String(row.description),manifest:asJson<Record<string, unknown>>(row.manifest),enabled:Boolean(row.enabled),createdAt:asNumber(row.created_at),updatedAt:asNumber(row.updated_at) };
	}

	/* ---------------- 自定义流程 ---------------- */

	saveWorkflow(row: WorkflowRow): void {
		const definition: WorkflowDefinition = { systemPrompt: row.systemPrompt, steps: row.steps };
		this.exec(
			`INSERT INTO workflows (id, workspace_id, plugin_id, name, definition, skill, created_at, updated_at)
			 VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8)
			 ON CONFLICT (id) DO UPDATE SET
				plugin_id  = excluded.plugin_id,
				name       = excluded.name,
				definition = excluded.definition,
				skill      = excluded.skill,
				updated_at = excluded.updated_at`,
			[
				row.id,
				this.workspaceId,
				row.pluginId ?? null,
				row.name,
				JSON.stringify(definition),
				row.skill ? JSON.stringify(row.skill) : null,
				row.createdAt,
				row.updatedAt,
			],
		);
	}

	getWorkflow(id: string): WorkflowRow | undefined {
		const row = this.rows(
			"SELECT id, plugin_id, name, definition, skill, created_at, updated_at FROM workflows WHERE id = $1",
			[id],
		)[0];
		return row ? this.toWorkflowRow(row) : undefined;
	}

	listWorkflows(): WorkflowRow[] {
		return this.rows(
			"SELECT id, plugin_id, name, definition, skill, created_at, updated_at FROM workflows WHERE workspace_id = $1 ORDER BY created_at ASC",
			[this.workspaceId],
		).map((row) => this.toWorkflowRow(row));
	}

	removeWorkflow(id: string): boolean {
		return this.rowCount("DELETE FROM workflows WHERE id = $1", [id]) > 0;
	}

	private toWorkflowRow(row: Record<string, unknown>): WorkflowRow {
		const definition = asJson<WorkflowDefinition>(row.definition);
		const skill = row.skill === null || row.skill === undefined ? undefined : asJson<WorkflowSkillText>(row.skill);
		return {
			id: String(row.id),
			...(row.plugin_id ? { pluginId: String(row.plugin_id) } : {}),
			name: String(row.name),
			systemPrompt: definition.systemPrompt,
			steps: definition.steps,
			...(skill ? { skill } : {}),
			createdAt: asNumber(row.created_at),
			updatedAt: asNumber(row.updated_at),
		};
	}

	/* ---------------- 会话 ---------------- */

	save(record: PersistedSession): void {
		this.exec(
			`INSERT INTO sessions (id, workspace_id, workflow_id, title, archived, done, created_at, updated_at, payload)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
			 ON CONFLICT (id) DO UPDATE SET
				workflow_id = excluded.workflow_id,
				title       = excluded.title,
				archived    = excluded.archived,
				done        = excluded.done,
				updated_at  = excluded.updated_at,
				payload     = excluded.payload`,
			[
				record.id,
				this.workspaceId,
				record.workflowId,
				record.title ?? null,
				record.archived ?? false,
				record.done,
				record.createdAt,
				record.updatedAt,
				JSON.stringify(record),
			],
		);
	}

	load(id: string): PersistedSession | undefined {
		const row = this.rows("SELECT payload FROM sessions WHERE id = $1", [id])[0];
		return row ? asJson<PersistedSession>(row.payload) : undefined;
	}

	/** 按更新时间倒序返回全部会话。 */
	list(): PersistedSession[] {
		return this.rows("SELECT payload FROM sessions WHERE workspace_id = $1 ORDER BY updated_at DESC", [
			this.workspaceId,
		]).map((row) => asJson<PersistedSession>(row.payload));
	}

	/** 只取 id，用于和内存中的活跃会话合并。 */
	ids(): string[] {
		return this.rows("SELECT id FROM sessions WHERE workspace_id = $1 ORDER BY updated_at DESC", [
			this.workspaceId,
		]).map((row) => String(row.id));
	}

	remove(id: string): boolean {
		return this.rowCount("DELETE FROM sessions WHERE id = $1", [id]) > 0;
	}

	clear(): number {
		return this.rowCount("DELETE FROM sessions WHERE workspace_id = $1", [this.workspaceId]);
	}

	count(): number {
		const row = this.rows("SELECT count(*)::int AS total FROM sessions WHERE workspace_id = $1", [
			this.workspaceId,
		])[0];
		return asNumber(row?.total ?? 0);
	}

	/* ---------------- 成员（P3） ---------------- */

	getUserByEmail(email: string): UserRecord | undefined {
		const row = this.rows(`${USER_COLUMNS_SQL} WHERE email = $1`, [email])[0];
		return row ? this.toUserRecord(row) : undefined;
	}

	getUserById(id: string): UserRecord | undefined {
		const row = this.rows(`${USER_COLUMNS_SQL} WHERE id = $1`, [id])[0];
		return row ? this.toUserRecord(row) : undefined;
	}

	createUser(user: UserInput): UserRecord {
		this.exec(
			`INSERT INTO users (id, workspace_id, email, name, password_hash, role, disabled, created_at, last_login_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL)`,
			[
				user.id,
				user.workspaceId,
				user.email,
				user.name,
				user.passwordHash,
				user.role,
				user.disabled,
				user.createdAt,
			],
		);
		return { ...user, lastLoginAt: null };
	}

	countUsers(): number {
		const row = this.rows("SELECT count(*)::int AS total FROM users")[0];
		return asNumber(row?.total ?? 0);
	}

	listUsers(): UserRecord[] {
		return this.rows(`${USER_COLUMNS_SQL} WHERE workspace_id = $1 ORDER BY created_at ASC`, [
			this.workspaceId,
		]).map((row) => this.toUserRecord(row));
	}

	updateLoginTime(id: string, at: number): void {
		this.exec("UPDATE users SET last_login_at = $1 WHERE id = $2", [at, id]);
	}

	updateUser(id: string, patch: UserPatch): UserRecord | undefined {
		// 列名常量 + $n 占位符；空补丁只回读，不发 UPDATE
		const sets: string[] = [];
		const params: unknown[] = [];
		if (patch.role !== undefined) {
			params.push(patch.role);
			sets.push(`role = $${params.length}`);
		}
		if (patch.disabled !== undefined) {
			params.push(patch.disabled);
			sets.push(`disabled = $${params.length}`);
		}
		if (patch.name !== undefined) {
			params.push(patch.name);
			sets.push(`name = $${params.length}`);
		}
		if (sets.length > 0) {
			params.push(id);
			this.exec(`UPDATE users SET ${sets.join(", ")} WHERE id = $${params.length}`, params);
		}
		return this.getUserById(id);
	}

	deleteUser(id: string): boolean {
		return this.rowCount("DELETE FROM users WHERE id = $1", [id]) > 0;
	}

	private toUserRecord(row: Record<string, unknown>): UserRecord {
		return {
			id: String(row.id),
			workspaceId: String(row.workspace_id),
			email: String(row.email),
			name: row.name === null || row.name === undefined ? null : String(row.name),
			passwordHash:
				row.password_hash === null || row.password_hash === undefined ? null : String(row.password_hash),
			role: String(row.role) as Role,
			disabled: row.disabled === true,
			createdAt: asNumber(row.created_at),
			lastLoginAt: row.last_login_at === null || row.last_login_at === undefined ? null : asNumber(row.last_login_at),
		};
	}

	/* ---------------- 平台审计（P3） ---------------- */

	appendAudit(entry: AuditLogInput): void {
		this.exec(
			`INSERT INTO audit_logs (workspace_id, actor_type, actor_id, action, target_type, target_id, detail, trace_id, created_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)`,
			[
				entry.workspaceId,
				entry.actorType,
				entry.actorId ?? null,
				entry.action,
				entry.targetType ?? null,
				entry.targetId ?? null,
				entry.detail === undefined ? null : JSON.stringify(entry.detail),
				entry.traceId ?? null,
				entry.createdAt,
			],
		);
	}

	listAudit(filter: AuditFilter): AuditLogRecord[] {
		const { where, params } = auditWhere(filter);
		const rows = this.rows(
			`${AUDIT_COLUMNS_SQL} ${where} ORDER BY created_at DESC, id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
			[...params, filter.limit, filter.offset],
		);
		return rows.map((row) => this.toAuditRecord(row));
	}

	countAudit(filter: Omit<AuditFilter, "limit" | "offset"> = {}): number {
		const { where, params } = auditWhere(filter);
		const row = this.rows(`SELECT count(*)::int AS total FROM audit_logs ${where}`, params)[0];
		return asNumber(row?.total ?? 0);
	}

	private toAuditRecord(row: Record<string, unknown>): AuditLogRecord {
		return {
			id: asNumber(row.id),
			workspaceId: String(row.workspace_id),
			actorType: String(row.actor_type),
			actorId: row.actor_id === null || row.actor_id === undefined ? null : String(row.actor_id),
			action: String(row.action),
			targetType: row.target_type === null || row.target_type === undefined ? null : String(row.target_type),
			targetId: row.target_id === null || row.target_id === undefined ? null : String(row.target_id),
			detail: row.detail === null || row.detail === undefined ? null : asJson<unknown>(row.detail),
			traceId: row.trace_id === null || row.trace_id === undefined ? null : String(row.trace_id),
			createdAt: asNumber(row.created_at),
		};
	}

	/* ---------------- 多模型管理（P6） ---------------- */

	getModelSetting(key: string): string | undefined {
		const row = this.rows("SELECT value FROM model_settings WHERE workspace_id = $1 AND key = $2", [this.workspaceId, key])[0];
		return row ? String(row.value) : undefined;
	}

	setModelSetting(key: string, value: string | null): void {
		if (value === null) {
			this.exec("DELETE FROM model_settings WHERE workspace_id = $1 AND key = $2", [this.workspaceId, key]);
			return;
		}
		this.exec(
			"INSERT INTO model_settings (workspace_id, key, value, updated_at) VALUES ($1, $2, $3, $4) ON CONFLICT (workspace_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
			[this.workspaceId, key, value, Date.now()],
		);
	}

	listModelProviders(): ModelProviderRecord[] {
		return this.rows(`${PROVIDER_COLUMNS_SQL} WHERE workspace_id = $1 ORDER BY created_at ASC`, [
			this.workspaceId,
		]).map((row) => this.toProviderRecord(row));
	}

	getModelProvider(id: string): ModelProviderRecord | undefined {
		const row = this.rows(`${PROVIDER_COLUMNS_SQL} WHERE id = $1 AND workspace_id = $2`, [id, this.workspaceId])[0];
		return row ? this.toProviderRecord(row) : undefined;
	}

	createModelProvider(provider: ModelProviderInput): ModelProviderRecord {
		this.exec(
			`INSERT INTO model_providers (id, workspace_id, name, kind, base_url, api_key_encrypted, enabled, created_at, updated_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
			[
				provider.id,
				this.workspaceId,
				provider.name,
				provider.kind,
				provider.baseUrl,
				provider.apiKeyEncrypted,
				provider.enabled,
				provider.createdAt,
				provider.updatedAt,
			],
		);
		return { ...provider };
	}

	updateModelProvider(id: string, patch: ModelProviderPatch): ModelProviderRecord | undefined {
		const sets = ["updated_at = $1"];
		const params: unknown[] = [patch.updatedAt];
		const add = (column: string, value: unknown): void => {
			params.push(value);
			sets.push(`${column} = $${params.length}`);
		};
		if (patch.name !== undefined) add("name", patch.name);
		if (patch.kind !== undefined) add("kind", patch.kind);
		if (patch.baseUrl !== undefined) add("base_url", patch.baseUrl);
		if (patch.apiKeyEncrypted !== undefined) add("api_key_encrypted", patch.apiKeyEncrypted);
		if (patch.enabled !== undefined) add("enabled", patch.enabled);
		params.push(id);
		this.exec(`UPDATE model_providers SET ${sets.join(", ")} WHERE id = $${params.length}`, params);
		return this.getModelProvider(id);
	}

	removeModelProvider(id: string): RemoveProviderResult {
		const modelsRemoved = this.rowCount("DELETE FROM models WHERE provider_id = $1 AND workspace_id = $2", [
			id,
			this.workspaceId,
		]);
		const removed = this.rowCount("DELETE FROM model_providers WHERE id = $1 AND workspace_id = $2", [
			id,
			this.workspaceId,
		]) > 0;
		return { removed, modelsRemoved };
	}

	listModels(): ModelRecord[] {
		return this.rows(`${MODEL_COLUMNS_SQL} WHERE workspace_id = $1 ORDER BY created_at ASC`, [
			this.workspaceId,
		]).map((row) => this.toModelRecord(row));
	}

	getModel(id: string): ModelRecord | undefined {
		const row = this.rows(`${MODEL_COLUMNS_SQL} WHERE id = $1 AND workspace_id = $2`, [id, this.workspaceId])[0];
		return row ? this.toModelRecord(row) : undefined;
	}

	createModel(model: ModelInput): ModelRecord {
		this.exec(
			`INSERT INTO models (id, workspace_id, provider_id, name, model_id, kind, enabled, context_window, created_at, updated_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
			[
				model.id,
				this.workspaceId,
				model.providerId,
				model.name,
				model.modelId,
				model.kind,
				model.enabled,
				model.contextWindow,
				model.createdAt,
				model.updatedAt,
			],
		);
		return { ...model };
	}

	updateModel(id: string, patch: ModelPatch): ModelRecord | undefined {
		const sets = ["updated_at = $1"];
		const params: unknown[] = [patch.updatedAt];
		const add = (column: string, value: unknown): void => {
			params.push(value);
			sets.push(`${column} = $${params.length}`);
		};
		if (patch.providerId !== undefined) add("provider_id", patch.providerId);
		if (patch.name !== undefined) add("name", patch.name);
		if (patch.modelId !== undefined) add("model_id", patch.modelId);
		if (patch.kind !== undefined) add("kind", patch.kind);
		if (patch.enabled !== undefined) add("enabled", patch.enabled);
		if (patch.contextWindow !== undefined) add("context_window", patch.contextWindow);
		params.push(id);
		this.exec(`UPDATE models SET ${sets.join(", ")} WHERE id = $${params.length}`, params);
		return this.getModel(id);
	}

	removeModel(id: string): boolean {
		return this.rowCount("DELETE FROM models WHERE id = $1 AND workspace_id = $2", [id, this.workspaceId]) > 0;
	}

	private toProviderRecord(row: Record<string, unknown>): ModelProviderRecord {
		return {
			id: String(row.id),
			name: String(row.name),
			kind: String(row.kind) as ModelProviderKind,
			baseUrl: row.base_url === null || row.base_url === undefined ? null : String(row.base_url),
			apiKeyEncrypted:
				row.api_key_encrypted === null || row.api_key_encrypted === undefined
					? null
					: String(row.api_key_encrypted),
			enabled: row.enabled === true,
			createdAt: asNumber(row.created_at),
			updatedAt: asNumber(row.updated_at),
		};
	}

	private toModelRecord(row: Record<string, unknown>): ModelRecord {
		return {
			id: String(row.id),
			providerId: String(row.provider_id),
			name: String(row.name),
			modelId: String(row.model_id),
			kind: String(row.kind) as ModelType,
			enabled: row.enabled === true,
			contextWindow:
				row.context_window === null || row.context_window === undefined ? null : asNumber(row.context_window),
			createdAt: asNumber(row.created_at),
			updatedAt: asNumber(row.updated_at),
		};
	}

	/* ---------------- 开放 API 的 API Key（P4） ---------------- */

	listApiKeys(): ApiKeyRecord[] {
		return this.rows(`${API_KEY_COLUMNS_SQL} WHERE workspace_id = $1 ORDER BY created_at ASC`, [
			this.workspaceId,
		]).map((row) => this.toApiKeyRecord(row));
	}

	getApiKeyByHash(keyHash: string): ApiKeyRecord | undefined {
		const row = this.rows(`${API_KEY_COLUMNS_SQL} WHERE key_hash = $1`, [keyHash])[0];
		return row ? this.toApiKeyRecord(row) : undefined;
	}

	createApiKey(key: ApiKeyInput): ApiKeyRecord {
		this.exec(
			`INSERT INTO api_keys (id, workspace_id, name, prefix, key_hash, role, rate_limit_per_min, disabled, last_used_at, created_at, revoked_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
			[
				key.id,
				this.workspaceId,
				key.name,
				key.prefix,
				key.keyHash,
				key.role,
				key.rateLimitPerMin,
				key.disabled,
				key.lastUsedAt,
				key.createdAt,
				key.revokedAt,
			],
		);
		return { ...key };
	}

	updateApiKey(id: string, patch: ApiKeyPatch): ApiKeyRecord | undefined {
		const sets: string[] = [];
		const params: unknown[] = [];
		const add = (column: string, value: unknown): void => {
			params.push(value);
			sets.push(`${column} = $${params.length}`);
		};
		if (patch.name !== undefined) add("name", patch.name);
		if (patch.role !== undefined) add("role", patch.role);
		if (patch.rateLimitPerMin !== undefined) add("rate_limit_per_min", patch.rateLimitPerMin);
		if (patch.disabled !== undefined) add("disabled", patch.disabled);
		if (patch.lastUsedAt !== undefined) add("last_used_at", patch.lastUsedAt);
		if (patch.revokedAt !== undefined) add("revoked_at", patch.revokedAt);
		if (sets.length > 0) {
			params.push(id);
			this.exec(`UPDATE api_keys SET ${sets.join(", ")} WHERE id = $${params.length}`, params);
		}
		return this.apiKeyById(id);
	}

	removeApiKey(id: string): boolean {
		return this.rowCount("DELETE FROM api_keys WHERE id = $1 AND workspace_id = $2", [id, this.workspaceId]) > 0;
	}

	touchApiKey(id: string, at: number): void {
		this.exec("UPDATE api_keys SET last_used_at = $1 WHERE id = $2", [at, id]);
	}

	private apiKeyById(id: string): ApiKeyRecord | undefined {
		const row = this.rows(`${API_KEY_COLUMNS_SQL} WHERE id = $1 AND workspace_id = $2`, [id, this.workspaceId])[0];
		return row ? this.toApiKeyRecord(row) : undefined;
	}

	private toApiKeyRecord(row: Record<string, unknown>): ApiKeyRecord {
		return {
			id: String(row.id),
			name: String(row.name),
			prefix: String(row.prefix),
			keyHash: String(row.key_hash),
			role: String(row.role) as Role,
			rateLimitPerMin: asNumber(row.rate_limit_per_min),
			disabled: row.disabled === true,
			lastUsedAt: row.last_used_at === null || row.last_used_at === undefined ? null : asNumber(row.last_used_at),
			createdAt: asNumber(row.created_at),
			revokedAt: row.revoked_at === null || row.revoked_at === undefined ? null : asNumber(row.revoked_at),
		};
	}

	/* ---------------- MCP 集成（P7） ---------------- */

	listMcpServers(): McpServerRecord[] {
		return this.rows(`${MCP_SERVER_COLUMNS_SQL} WHERE workspace_id = $1 ORDER BY created_at ASC`, [
			this.workspaceId,
		]).map(toMcpServerRecord);
	}

	getMcpServer(id: string): McpServerRecord | undefined {
		const row = this.rows(`${MCP_SERVER_COLUMNS_SQL} WHERE id = $1 AND workspace_id = $2`, [
			id,
			this.workspaceId,
		])[0];
		return row ? toMcpServerRecord(row) : undefined;
	}

	createMcpServer(server: McpServerInput): McpServerRecord {
		this.exec(
			`INSERT INTO mcp_servers
				(id, workspace_id, name, transport, command, args, url, headers, env, enabled, last_status, last_error, last_checked_at, created_at, updated_at)
			 VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, $9::jsonb, $10, $11, $12, $13, $14, $15)`,
			[
				server.id,
				this.workspaceId,
				server.name,
				server.transport,
				server.command,
				JSON.stringify(server.args),
				server.url,
				JSON.stringify(server.headers),
				JSON.stringify(server.env),
				server.enabled,
				server.lastStatus ?? "unknown",
				server.lastError ?? null,
				server.lastCheckedAt ?? null,
				server.createdAt,
				server.updatedAt,
			],
		);
		return this.getMcpServer(server.id)!;
	}

	updateMcpServer(id: string, patch: McpServerPatch): McpServerRecord | undefined {
		const sets = ["updated_at = $1"];
		const params: unknown[] = [patch.updatedAt];
		const add = (column: string, value: unknown, cast = ""): void => {
			params.push(value);
			sets.push(`${column} = $${params.length}${cast}`);
		};
		if (patch.name !== undefined) add("name", patch.name);
		if (patch.transport !== undefined) add("transport", patch.transport);
		if (patch.command !== undefined) add("command", patch.command);
		if (patch.args !== undefined) add("args", JSON.stringify(patch.args), "::jsonb");
		if (patch.url !== undefined) add("url", patch.url);
		if (patch.headers !== undefined) add("headers", JSON.stringify(patch.headers), "::jsonb");
		if (patch.env !== undefined) add("env", JSON.stringify(patch.env), "::jsonb");
		if (patch.enabled !== undefined) add("enabled", patch.enabled);
		if (patch.lastStatus !== undefined) add("last_status", patch.lastStatus);
		if (patch.lastError !== undefined) add("last_error", patch.lastError);
		if (patch.lastCheckedAt !== undefined) add("last_checked_at", patch.lastCheckedAt);
		params.push(id, this.workspaceId);
		this.exec(
			`UPDATE mcp_servers SET ${sets.join(", ")} WHERE id = $${params.length - 1} AND workspace_id = $${params.length}`,
			params,
		);
		return this.getMcpServer(id);
	}

	removeMcpServer(id: string): boolean {
		// 外键 on delete cascade 已覆盖工具，这里显式删一次保证两种后端行为一致
		this.rowCount("DELETE FROM mcp_tools WHERE server_id = $1", [id]);
		return this.rowCount("DELETE FROM mcp_servers WHERE id = $1 AND workspace_id = $2", [
			id,
			this.workspaceId,
		]) > 0;
	}

	listMcpTools(serverId?: string): McpToolRecord[] {
		const rows = serverId === undefined
			? this.rows(`${MCP_TOOL_COLUMNS_SQL} ORDER BY created_at ASC`)
			: this.rows(`${MCP_TOOL_COLUMNS_SQL} WHERE server_id = $1 ORDER BY created_at ASC`, [serverId]);
		return rows.map(toMcpToolRecord);
	}

	getMcpTool(id: string): McpToolRecord | undefined {
		const row = this.rows(`${MCP_TOOL_COLUMNS_SQL} WHERE id = $1`, [id])[0];
		return row ? toMcpToolRecord(row) : undefined;
	}

	createMcpTool(tool: McpToolInput): McpToolRecord {
		this.exec(
			`INSERT INTO mcp_tools (id, server_id, name, description, input_schema, enabled, created_at)
			 VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
			[
				tool.id,
				tool.serverId,
				tool.name,
				tool.description,
				JSON.stringify(tool.inputSchema),
				tool.enabled,
				tool.createdAt,
			],
		);
		return this.getMcpTool(tool.id)!;
	}

	updateMcpTool(id: string, patch: McpToolPatch): McpToolRecord | undefined {
		const sets: string[] = [];
		const params: unknown[] = [];
		const add = (column: string, value: unknown, cast = ""): void => {
			params.push(value);
			sets.push(`${column} = $${params.length}${cast}`);
		};
		if (patch.description !== undefined) add("description", patch.description);
		if (patch.inputSchema !== undefined) add("input_schema", JSON.stringify(patch.inputSchema), "::jsonb");
		if (patch.enabled !== undefined) add("enabled", patch.enabled);
		if (sets.length > 0) {
			params.push(id);
			this.exec(`UPDATE mcp_tools SET ${sets.join(", ")} WHERE id = $${params.length}`, params);
		}
		return this.getMcpTool(id);
	}

	removeMcpTool(id: string): boolean {
		return this.rowCount("DELETE FROM mcp_tools WHERE id = $1", [id]) > 0;
	}

	removeMcpToolsByServer(serverId: string): number {
		return this.rowCount("DELETE FROM mcp_tools WHERE server_id = $1", [serverId]);
	}

	/* ---------------- IM Bot 网关（P8） ---------------- */

	listImBots(): ImBotRecord[] {
		return this.rows(`${IM_BOT_COLUMNS_SQL} WHERE workspace_id = $1 ORDER BY created_at ASC`, [
			this.workspaceId,
		]).map(toImBotRecord);
	}

	getImBot(id: string): ImBotRecord | undefined {
		const row = this.rows(`${IM_BOT_COLUMNS_SQL} WHERE id = $1 AND workspace_id = $2`, [
			id,
			this.workspaceId,
		])[0];
		return row ? toImBotRecord(row) : undefined;
	}

	createImBot(bot: ImBotInput): ImBotRecord {
		this.exec(
			`INSERT INTO im_bots
				(id, workspace_id, name, platform, app_key, app_secret_enc, sign_secret_enc, robot_code, aes_key_enc,
				 workflow_id, enabled, last_callback_at, created_at, updated_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NULL, $12, $13)`,
			[
				bot.id,
				this.workspaceId,
				bot.name,
				bot.platform,
				bot.appKey,
				bot.appSecretEnc,
				bot.callbackTokenEnc,
				bot.robotCode,
				bot.aesKeyEnc,
				bot.workflowId,
				bot.enabled,
				bot.createdAt,
				bot.updatedAt,
			],
		);
		return this.getImBot(bot.id)!;
	}

	updateImBot(id: string, patch: ImBotPatch): ImBotRecord | undefined {
		const sets = ["updated_at = $1"];
		const params: unknown[] = [patch.updatedAt];
		const add = (column: string, value: unknown): void => {
			params.push(value);
			sets.push(`${column} = $${params.length}`);
		};
		if (patch.name !== undefined) add("name", patch.name);
		if (patch.appKey !== undefined) add("app_key", patch.appKey);
		if (patch.appSecretEnc !== undefined) add("app_secret_enc", patch.appSecretEnc);
		if (patch.callbackTokenEnc !== undefined) add("sign_secret_enc", patch.callbackTokenEnc);
		if (patch.robotCode !== undefined) add("robot_code", patch.robotCode);
		if (patch.aesKeyEnc !== undefined) add("aes_key_enc", patch.aesKeyEnc);
		if (patch.workflowId !== undefined) add("workflow_id", patch.workflowId);
		if (patch.enabled !== undefined) add("enabled", patch.enabled);
		if (patch.lastCallbackAt !== undefined) add("last_callback_at", patch.lastCallbackAt);
		params.push(id, this.workspaceId);
		this.exec(
			`UPDATE im_bots SET ${sets.join(", ")} WHERE id = $${params.length - 1} AND workspace_id = $${params.length}`,
			params,
		);
		return this.getImBot(id);
	}

	removeImBot(id: string): boolean {
		// 外键 on delete cascade 已覆盖会话映射，这里显式删一次保证两种后端行为一致
		this.rowCount("DELETE FROM im_sessions WHERE bot_id = $1", [id]);
		return this.rowCount("DELETE FROM im_bots WHERE id = $1 AND workspace_id = $2", [
			id,
			this.workspaceId,
		]) > 0;
	}

	countImSessions(botId: string): number {
		const row = this.rows("SELECT count(*)::int AS total FROM im_sessions WHERE bot_id = $1", [botId])[0];
		return asNumber(row?.total ?? 0);
	}

	getImSession(botId: string, conversationId: string): ImSessionRecord | undefined {
		const row = this.rows(`${IM_SESSION_COLUMNS_SQL} WHERE bot_id = $1 AND conversation_id = $2`, [
			botId,
			conversationId,
		])[0];
		return row ? toImSessionRecord(row) : undefined;
	}

	createImSession(session: ImSessionInput): ImSessionRecord {
		this.exec(
			`INSERT INTO im_sessions
				(id, bot_id, conversation_id, external_user_id, session_id, last_msg_id, created_at, updated_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
			[
				session.id,
				session.botId,
				session.conversationId,
				session.externalUserId,
				session.sessionId,
				session.lastMsgId,
				session.createdAt,
				session.updatedAt,
			],
		);
		return this.getImSession(session.botId, session.conversationId)!;
	}

	updateImSession(id: string, patch: ImSessionPatch): ImSessionRecord | undefined {
		const sets = ["updated_at = $1"];
		const params: unknown[] = [patch.updatedAt];
		const add = (column: string, value: unknown): void => {
			params.push(value);
			sets.push(`${column} = $${params.length}`);
		};
		if (patch.sessionId !== undefined) add("session_id", patch.sessionId);
		if (patch.externalUserId !== undefined) add("external_user_id", patch.externalUserId);
		if (patch.lastMsgId !== undefined) add("last_msg_id", patch.lastMsgId);
		params.push(id);
		this.exec(`UPDATE im_sessions SET ${sets.join(", ")} WHERE id = $${params.length}`, params);
		const row = this.rows(`${IM_SESSION_COLUMNS_SQL} WHERE id = $1`, [id])[0];
		return row ? toImSessionRecord(row) : undefined;
	}

	removeImSessionsByBot(botId: string): number {
		return this.rowCount("DELETE FROM im_sessions WHERE bot_id = $1", [botId]);
	}

	/* ---------------- 监控与可观测（P9） ---------------- */

	saveTraces(records: TraceRecord[]): void {
		if (records.length === 0) {
			return;
		}
		const params: unknown[] = [];
		const tuples = records.map((record, index) => {
			params.push(
				record.id,
				this.workspaceId,
				record.sessionId,
				record.workflowId,
				record.skillId,
				record.startedAt,
				record.finishedAt,
				record.status,
				record.error,
			);
			const base = index * 9;
			return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9})`;
		});
		this.exec(
			`INSERT INTO traces (id, workspace_id, session_id, workflow_id, skill_id, started_at, finished_at, status, error)
			 VALUES ${tuples.join(", ")}
			 ON CONFLICT (id) DO UPDATE SET
				session_id  = excluded.session_id,
				workflow_id = excluded.workflow_id,
				skill_id    = excluded.skill_id,
				finished_at = excluded.finished_at,
				status      = excluded.status,
				error       = excluded.error`,
			params,
		);
	}

	appendTraceEvents(events: TraceEventInput[]): void {
		if (events.length === 0) {
			return;
		}
		const params: unknown[] = [];
		const tuples = events.map((event, index) => {
			params.push(
				event.traceId,
				event.seq,
				event.kind,
				event.name ?? null,
				event.ok === null || event.ok === undefined ? null : event.ok,
				event.ms ?? null,
				event.payload === undefined || event.payload === null ? null : JSON.stringify(event.payload),
				event.createdAt,
			);
			const base = index * 8;
			return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}::jsonb, $${base + 8})`;
		});
		// 唯一索引 (trace_id, seq) 让重试幂等：重复批次不会产生重复事件
		this.exec(
			`INSERT INTO trace_events (trace_id, seq, kind, name, ok, ms, payload, created_at)
			 VALUES ${tuples.join(", ")} ON CONFLICT (trace_id, seq) DO NOTHING`,
			params,
		);
	}

	listTraces(filter: TraceFilter): TraceSummaryRecord[] {
		const { where, params } = traceWhere(filter);
		const rows = this.rows(
			`${TRACE_LIST_SQL} ${where} ORDER BY t.started_at DESC, t.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
			[...params, filter.limit, filter.offset],
		);
		return rows.map(toTraceSummaryRecord);
	}

	countTraces(filter: Omit<TraceFilter, "limit" | "offset">): number {
		const { where, params } = traceWhere(filter);
		const row = this.rows(`SELECT count(*)::int AS total FROM traces t ${where}`, params)[0];
		return asNumber(row?.total ?? 0);
	}

	getTrace(id: string): TraceSummaryRecord | undefined {
		const row = this.rows(`${TRACE_LIST_SQL} WHERE t.id = $1 AND t.workspace_id = $2`, [id, this.workspaceId])[0];
		return row ? toTraceSummaryRecord(row) : undefined;
	}

	listTraceEvents(traceId: string): TraceEventRecord[] {
		const rows = this.rows(
			`SELECT e.trace_id, e.seq, e.kind, e.name, e.ok, e.ms, e.payload, e.created_at
			 FROM trace_events e JOIN traces t ON t.id = e.trace_id
			 WHERE e.trace_id = $1 AND t.workspace_id = $2
			 ORDER BY e.seq ASC`,
			[traceId, this.workspaceId],
		);
		return rows.map(toTraceEventRecord);
	}

	purgeTracesBefore(cutoffMs: number): { traces: number; events: number } {
		const events = this.rows(
			`WITH removed AS (
			   DELETE FROM trace_events e USING traces t
			   WHERE e.trace_id = t.id AND e.created_at < $1 AND t.workspace_id = $2
			   RETURNING 1
			 ) SELECT count(*)::int AS n FROM removed`,
			[cutoffMs, this.workspaceId],
		)[0];
		const traces = this.rows(
			`WITH removed AS (
			   DELETE FROM traces WHERE started_at < $1 AND workspace_id = $2 RETURNING 1
			 ) SELECT count(*)::int AS n FROM removed`,
			[cutoffMs, this.workspaceId],
		)[0];
		return { traces: Number(traces?.n ?? 0), events: Number(events?.n ?? 0) };
	}

	monitorStats(since: number, activeSince: number): MonitorStats {
		const sessions = this.rows(
			`SELECT count(*)::int AS total,
			        coalesce(sum(CASE WHEN updated_at >= $1 THEN 1 ELSE 0 END), 0)::int AS active
			 FROM sessions WHERE workspace_id = $2`,
			[activeSince, this.workspaceId],
		)[0];
		const messages = this.rows(
			"SELECT count(*)::int AS total FROM traces WHERE started_at >= $1 AND workspace_id = $2",
			[since, this.workspaceId],
		)[0];
		const tools = this.rows(
			`SELECT count(*)::int AS total,
			        coalesce(sum(CASE WHEN e.ok THEN 1 ELSE 0 END), 0)::int AS ok,
			        coalesce(sum(CASE WHEN e.ok = false THEN 1 ELSE 0 END), 0)::int AS failed,
			        coalesce(avg(e.ms), 0) AS avg_ms
			 FROM trace_events e JOIN traces t ON t.id = e.trace_id
			 WHERE t.started_at >= $1 AND t.workspace_id = $2 AND e.kind = 'tool'`,
			[since, this.workspaceId],
		)[0];
		const skills = this.rows(
			`SELECT e.name AS id, count(*)::int AS calls
			 FROM trace_events e JOIN traces t ON t.id = e.trace_id
			 WHERE t.started_at >= $1 AND t.workspace_id = $2 AND e.kind = 'skill' AND e.ok AND e.name IS NOT NULL
			 GROUP BY e.name ORDER BY calls DESC, id ASC`,
			[since, this.workspaceId],
		);
		const mcp = this.rows(
			`SELECT e.name AS server, count(*)::int AS calls,
			        coalesce(sum(CASE WHEN e.ok = false THEN 1 ELSE 0 END), 0)::int AS failed
			 FROM trace_events e JOIN traces t ON t.id = e.trace_id
			 WHERE t.started_at >= $1 AND t.workspace_id = $2 AND e.kind = 'mcp' AND e.name IS NOT NULL
			 GROUP BY e.name ORDER BY calls DESC, server ASC`,
			[since, this.workspaceId],
		);
		const models = this.rows(
			`SELECT e.name AS model, count(*)::int AS calls, coalesce(avg(e.ms), 0) AS avg_ms
			 FROM trace_events e JOIN traces t ON t.id = e.trace_id
			 WHERE t.started_at >= $1 AND t.workspace_id = $2 AND e.kind = 'llm' AND e.name IS NOT NULL
			 GROUP BY e.name ORDER BY calls DESC, model ASC`,
			[since, this.workspaceId],
		);
		const errors = this.rows(
			"SELECT count(*)::int AS total FROM traces WHERE started_at >= $1 AND workspace_id = $2 AND status = 'error'",
			[since, this.workspaceId],
		)[0];
		const durations = this.rows(
			`SELECT e.ms AS ms FROM trace_events e JOIN traces t ON t.id = e.trace_id
			 WHERE t.started_at >= $1 AND t.workspace_id = $2 AND e.kind = 'tool' AND e.ms IS NOT NULL
			 ORDER BY e.id ASC LIMIT 10000`,
			[since, this.workspaceId],
		);
		return {
			sessions: { total: asNumber(sessions?.total ?? 0), active24h: asNumber(sessions?.active ?? 0) },
			messages: asNumber(messages?.total ?? 0),
			toolCalls: {
				total: asNumber(tools?.total ?? 0),
				ok: asNumber(tools?.ok ?? 0),
				failed: asNumber(tools?.failed ?? 0),
				avgMs: asNumber(tools?.avg_ms ?? 0),
			},
			skills: skills.map((row) => ({ id: String(row.id), calls: asNumber(row.calls) })),
			mcp: mcp.map((row) => ({
				server: String(row.server),
				calls: asNumber(row.calls),
				failed: asNumber(row.failed),
			})),
			model: models.map((row) => ({
				model: String(row.model),
				calls: asNumber(row.calls),
				avgMs: asNumber(row.avg_ms),
			})),
			errors: asNumber(errors?.total ?? 0),
			toolDurations: durations.map((row) => asNumber(row.ms)),
		};
	}

	close(): void {
		this.bridge.close();
	}

	/* ---------------- 内部：所有 SQL 都从这里走（参数化，禁止拼串） ---------------- */

	private rows(sql: string, params: unknown[] = []): Record<string, unknown>[] {
		return this.bridge.query(sql, params).rows;
	}

	private exec(sql: string, params: unknown[] = []): void {
		this.bridge.query(sql, params);
	}

	private rowCount(sql: string, params: unknown[] = []): number {
		return this.bridge.query(sql, params).rowCount;
	}

	/* ---------------- Agent 实体（P10） ---------------- */

	private static readonly AGENT_COLUMNS =
		"id, workspace_id, name, description, category, icon, agents_md, model_config, memory_config, advanced_config, skill_ids, kb_ids, status, created_by, created_at, updated_at, status_changed_at";

	listAgents(): AgentRecord[] {
		const rows = this.bridge.query(
			`SELECT ${PostgresStorage.AGENT_COLUMNS} FROM agents WHERE workspace_id = $1 ORDER BY updated_at DESC`,
			[this.workspaceId],
		).rows;
		return rows.map(toAgentRecord);
	}

	getAgent(id: string): AgentRecord | undefined {
		const rows = this.bridge.query(
			`SELECT ${PostgresStorage.AGENT_COLUMNS} FROM agents WHERE id = $1 AND workspace_id = $2`,
			[id, this.workspaceId],
		).rows;
		return rows.length > 0 ? toAgentRecord(rows[0]!) : undefined;
	}

	createAgent(input: AgentInput): AgentRecord {
		this.exec(
			`INSERT INTO agents (id, workspace_id, name, description, category, icon, agents_md, model_config, memory_config, advanced_config, skill_ids, kb_ids, status, created_by, created_at, updated_at, status_changed_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
			[
				input.id,
				this.workspaceId,
				input.name,
				input.description ?? "",
				input.category ?? "",
				input.icon ?? "",
				input.agentsMd ?? "",
				JSON.stringify(input.modelConfig ?? {}),
				JSON.stringify(input.memoryConfig ?? {}),
				JSON.stringify(input.advancedConfig ?? {}),
				JSON.stringify(input.skillIds ?? []),
				JSON.stringify(input.kbIds ?? []),
				input.status,
				input.createdBy ?? null,
				input.createdAt,
				input.updatedAt,
				input.statusChangedAt,
			],
		);
		return this.getAgent(input.id)!;
	}

	updateAgent(id: string, patch: AgentPatch): AgentRecord | undefined {
		const sets = ["updated_at = $1"];
		const params: unknown[] = [patch.updatedAt ?? Date.now()];
		const push = (column: string, value: unknown): void => {
			params.push(value);
			sets.push(`${column} = $${params.length}`);
		};
		if (patch.name !== undefined) push("name", patch.name);
		if (patch.description !== undefined) push("description", patch.description);
		if (patch.category !== undefined) push("category", patch.category);
		if (patch.icon !== undefined) push("icon", patch.icon);
		if (patch.agentsMd !== undefined) push("agents_md", patch.agentsMd);
		if (patch.modelConfig !== undefined) push("model_config", JSON.stringify(patch.modelConfig));
		if (patch.memoryConfig !== undefined) push("memory_config", JSON.stringify(patch.memoryConfig));
		if (patch.advancedConfig !== undefined) push("advanced_config", JSON.stringify(patch.advancedConfig));
		if (patch.skillIds !== undefined) push("skill_ids", JSON.stringify(patch.skillIds));
		if (patch.kbIds !== undefined) push("kb_ids", JSON.stringify(patch.kbIds));
		params.push(id);
		this.exec(`UPDATE agents SET ${sets.join(", ")} WHERE id = $${params.length}`, params);
		return this.getAgent(id);
	}

	setAgentStatus(id: string, status: AgentStatus, at: number): AgentRecord | undefined {
		this.exec("UPDATE agents SET status = $1, status_changed_at = $2, updated_at = $3 WHERE id = $4", [
			status,
			at,
			at,
			id,
		]);
		return this.getAgent(id);
	}

	removeAgent(id: string): boolean {
		return this.rowCount("DELETE FROM agents WHERE id = $1", [id]) > 0;
	}

	countAgents(): number {
		const rows = this.bridge.query("SELECT count(*)::int AS total FROM agents").rows;
		return rows.length > 0 ? asNumber(rows[0]!.total) : 0;
	}

	listAgentGroups(): AgentGroupRecord[] {
		return this.rows("SELECT id, name, created_by, created_at, updated_at FROM agent_groups WHERE workspace_id = $1 ORDER BY updated_at DESC, id", [this.workspaceId]).map(toAgentGroupRecord);
	}

	getAgentGroup(id: string): AgentGroupRecord | undefined {
		const row = this.rows("SELECT id, name, created_by, created_at, updated_at FROM agent_groups WHERE id = $1 AND workspace_id = $2", [id, this.workspaceId])[0];
		return row ? toAgentGroupRecord(row) : undefined;
	}

	createAgentGroup(group: AgentGroupRecord): AgentGroupRecord {
		this.exec("INSERT INTO agent_groups (id, workspace_id, name, created_by, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)", [group.id, this.workspaceId, group.name, group.createdBy, group.createdAt, group.updatedAt]);
		return this.getAgentGroup(group.id)!;
	}

	updateAgentGroup(id: string, patch: Partial<Pick<AgentGroupRecord, "name" | "updatedAt">>): AgentGroupRecord | undefined {
		const current = this.getAgentGroup(id);
		if (!current) return undefined;
		this.exec("UPDATE agent_groups SET name = $1, updated_at = $2 WHERE id = $3 AND workspace_id = $4", [patch.name ?? current.name, patch.updatedAt ?? Date.now(), id, this.workspaceId]);
		return this.getAgentGroup(id);
	}

	deleteAgentGroup(id: string): boolean {
		return this.rowCount("DELETE FROM agent_groups WHERE id = $1 AND workspace_id = $2", [id, this.workspaceId]) > 0;
	}

	listAgentGroupMembers(groupId: string): AgentGroupMemberRecord[] {
		return this.rows("SELECT id, group_id, agent_id, agent_name, position, session_id, added_at FROM agent_group_members WHERE group_id = $1 AND workspace_id = $2 ORDER BY position, added_at, id", [groupId, this.workspaceId]).map(toAgentGroupMemberRecord);
	}

	getAgentGroupMember(id: string): AgentGroupMemberRecord | undefined {
		const row = this.rows("SELECT id, group_id, agent_id, agent_name, position, session_id, added_at FROM agent_group_members WHERE id = $1 AND workspace_id = $2", [id, this.workspaceId])[0];
		return row ? toAgentGroupMemberRecord(row) : undefined;
	}

	addAgentGroupMember(member: AgentGroupMemberRecord): AgentGroupMemberRecord {
		this.exec("INSERT INTO agent_group_members (id, workspace_id, group_id, agent_id, agent_name, position, session_id, added_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)", [member.id, this.workspaceId, member.groupId, member.agentId, member.agentName, member.position, member.sessionId, member.addedAt]);
		return this.getAgentGroupMember(member.id)!;
	}

	updateAgentGroupMember(id: string, patch: { sessionId?: string | null }): AgentGroupMemberRecord | undefined {
		if (patch.sessionId === undefined) return this.getAgentGroupMember(id);
		this.exec("UPDATE agent_group_members SET session_id = $1 WHERE id = $2 AND workspace_id = $3", [patch.sessionId, id, this.workspaceId]);
		return this.getAgentGroupMember(id);
	}

	removeAgentGroupMember(id: string): boolean {
		return this.rowCount("DELETE FROM agent_group_members WHERE id = $1 AND workspace_id = $2", [id, this.workspaceId]) > 0;
	}

	listAgentGroupTurns(groupId: string): AgentGroupTurnRecord[] {
		return this.rows("SELECT id, group_id, sequence, user_message, status, created_at, completed_at FROM agent_group_turns WHERE group_id = $1 AND workspace_id = $2 ORDER BY sequence, id", [groupId, this.workspaceId]).map(toAgentGroupTurnRecord);
	}

	getAgentGroupTurn(id: string): AgentGroupTurnRecord | undefined {
		const row = this.rows("SELECT id, group_id, sequence, user_message, status, created_at, completed_at FROM agent_group_turns WHERE id = $1 AND workspace_id = $2", [id, this.workspaceId])[0];
		return row ? toAgentGroupTurnRecord(row) : undefined;
	}

	createAgentGroupTurn(turn: AgentGroupTurnRecord): AgentGroupTurnRecord {
		this.exec("INSERT INTO agent_group_turns (id, workspace_id, group_id, sequence, user_message, status, created_at, completed_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)", [turn.id, this.workspaceId, turn.groupId, turn.sequence, turn.userMessage, turn.status, turn.createdAt, turn.completedAt]);
		return this.getAgentGroupTurn(turn.id)!;
	}

	updateAgentGroupTurn(id: string, patch: Partial<Pick<AgentGroupTurnRecord, "status" | "completedAt">>): AgentGroupTurnRecord | undefined {
		const current = this.getAgentGroupTurn(id);
		if (!current) return undefined;
		this.exec("UPDATE agent_group_turns SET status = $1, completed_at = $2 WHERE id = $3 AND workspace_id = $4", [patch.status ?? current.status, patch.completedAt === undefined ? current.completedAt : patch.completedAt, id, this.workspaceId]);
		return this.getAgentGroupTurn(id);
	}

	listAgentGroupMessages(groupId: string): AgentGroupMessageRecord[] {
		return this.rows("SELECT id, group_id, turn_id, role, agent_id, agent_name, content, is_error, created_at FROM agent_group_messages WHERE group_id = $1 AND workspace_id = $2 ORDER BY created_at, id", [groupId, this.workspaceId]).map(toAgentGroupMessageRecord);
	}

	listAgentGroupTurnMessages(turnId: string): AgentGroupMessageRecord[] {
		return this.rows("SELECT id, group_id, turn_id, role, agent_id, agent_name, content, is_error, created_at FROM agent_group_messages WHERE turn_id = $1 AND workspace_id = $2 ORDER BY created_at, id", [turnId, this.workspaceId]).map(toAgentGroupMessageRecord);
	}

	appendAgentGroupMessage(message: AgentGroupMessageRecord): AgentGroupMessageRecord {
		this.exec("INSERT INTO agent_group_messages (id, workspace_id, group_id, turn_id, role, agent_id, agent_name, content, is_error, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)", [message.id, this.workspaceId, message.groupId, message.turnId, message.role, message.agentId, message.agentName, message.content, message.isError, message.createdAt]);
		return this.listAgentGroupTurnMessages(message.turnId).find((entry) => entry.id === message.id)!;
	}

	/** 单个迁移文件 = 一个事务：schema 变更和记账一起提交，失败一起回滚。 */
	private applyMigration(migration: Migration): void {
		this.bridge.transaction([
			{ sql: migration.sql },
			{
				sql: "INSERT INTO schema_migrations (version, name, applied_at) VALUES ($1, $2, $3)",
				params: [migration.version, migration.name, Date.now()],
			},
		]);
	}
}

/* ---------------- Agent 实体（P10）的行映射 ---------------- */

function toAgentRecord(row: Record<string, unknown>): AgentRecord {
	const asJson = <T>(value: unknown, fallback: T): T => {
		if (value === null || value === undefined) return fallback;
		// pg 会把 jsonb 直接反序列化成对象；TEXT 列才是字符串。两种都吃得下
		if (typeof value === "string") {
			try {
				return (JSON.parse(value) as T) ?? fallback;
			} catch {
				return fallback;
			}
		}
		return value as T;
	};
	return {
		id: String(row.id),
		workspaceId: String(row.workspace_id),
		name: String(row.name),
		description: String(row.description ?? ""),
		category: String(row.category ?? ""),
		icon: String(row.icon ?? ""),
		agentsMd: String(row.agents_md ?? ""),
		modelConfig: asJson(row.model_config, {}),
		memoryConfig: asJson(row.memory_config, {}),
		advancedConfig: asJson(row.advanced_config, {}),
		skillIds: asJson(row.skill_ids, [] as string[]),
		kbIds: asJson(row.kb_ids, [] as string[]),
		status: (String(row.status ?? "draft") as AgentStatus) || "draft",
		createdBy: row.created_by === null || row.created_by === undefined ? null : String(row.created_by),
		createdAt: asNumber(row.created_at),
		updatedAt: asNumber(row.updated_at),
		statusChangedAt: asNumber(row.status_changed_at),
	};
}

function toAgentGroupRecord(row: Record<string, unknown>): AgentGroupRecord {
	return { id: String(row.id), name: String(row.name), createdBy: row.created_by == null ? null : String(row.created_by), createdAt: asNumber(row.created_at), updatedAt: asNumber(row.updated_at) };
}

function toAgentGroupMemberRecord(row: Record<string, unknown>): AgentGroupMemberRecord {
	return { id: String(row.id), groupId: String(row.group_id), agentId: String(row.agent_id), agentName: String(row.agent_name), position: asNumber(row.position), sessionId: row.session_id == null ? null : String(row.session_id), addedAt: asNumber(row.added_at) };
}

function toAgentGroupTurnRecord(row: Record<string, unknown>): AgentGroupTurnRecord {
	return { id: String(row.id), groupId: String(row.group_id), sequence: asNumber(row.sequence), userMessage: String(row.user_message), status: String(row.status) as AgentGroupTurnRecord["status"], createdAt: asNumber(row.created_at), completedAt: row.completed_at == null ? null : asNumber(row.completed_at) };
}

function toAgentGroupMessageRecord(row: Record<string, unknown>): AgentGroupMessageRecord {
	return { id: String(row.id), groupId: String(row.group_id), turnId: String(row.turn_id), role: String(row.role) as AgentGroupMessageRecord["role"], agentId: row.agent_id == null ? null : String(row.agent_id), agentName: row.agent_name == null ? null : String(row.agent_name), content: String(row.content), isError: row.is_error === true, createdAt: asNumber(row.created_at) };
}

/* ---------------- 监控与可观测（P9）的行映射 ---------------- */

/** 列表 / 详情共用的 SELECT：model 与 toolCount 由事件派生子查询，避免给 traces 再加列。 */
const TRACE_LIST_SQL = `SELECT t.id, t.workspace_id, t.session_id, t.workflow_id, t.skill_id,
	t.started_at, t.finished_at, t.status, t.error,
	(SELECT count(*)::int FROM trace_events e WHERE e.trace_id = t.id AND e.kind = 'tool') AS tool_count,
	(SELECT e.name FROM trace_events e WHERE e.trace_id = t.id AND e.kind = 'llm' ORDER BY e.seq ASC LIMIT 1) AS model
	FROM traces t`;

function traceStatusOf(value: string): TraceStatus {
	return value === "ok" || value === "error" ? value : "running";
}

function toTraceSummaryRecord(row: Record<string, unknown>): TraceSummaryRecord {
	return {
		id: String(row.id),
		workspaceId: String(row.workspace_id),
		sessionId: row.session_id === null || row.session_id === undefined ? null : String(row.session_id),
		workflowId: row.workflow_id === null || row.workflow_id === undefined ? null : String(row.workflow_id),
		skillId: row.skill_id === null || row.skill_id === undefined ? null : String(row.skill_id),
		startedAt: asNumber(row.started_at),
		finishedAt:
			row.finished_at === null || row.finished_at === undefined ? null : asNumber(row.finished_at),
		status: traceStatusOf(String(row.status)),
		error: row.error === null || row.error === undefined ? null : String(row.error),
		model: row.model === null || row.model === undefined ? null : String(row.model),
		toolCount: asNumber(row.tool_count ?? 0),
	};
}

function toTraceEventRecord(row: Record<string, unknown>): TraceEventRecord {
	return {
		traceId: String(row.trace_id),
		seq: asNumber(row.seq),
		kind: String(row.kind) as TraceEventKind,
		name: row.name === null || row.name === undefined ? null : String(row.name),
		ok: row.ok === null || row.ok === undefined ? null : row.ok === true,
		ms: row.ms === null || row.ms === undefined ? null : asNumber(row.ms),
		payload: parseJsonValue(row.payload),
		createdAt: asNumber(row.created_at),
	};
}

/** 调用链列表 / 计数的公共 WHERE（`t` 是 traces 的别名，工作空间走 $1）。 */
function traceWhere(filter: Omit<TraceFilter, "limit" | "offset">): { where: string; params: unknown[] } {
	const params: unknown[] = [DEFAULT_WORKSPACE_ID];
	const clauses = ["t.workspace_id = $1"];
	if (filter.sessionId) {
		params.push(filter.sessionId);
		clauses.push(`t.session_id = $${params.length}`);
	}
	if (filter.sessionIds) {
		// developer 只能看自己的会话：空列表必须查不到任何行（不能退化成"不过滤"）
		if (filter.sessionIds.length === 0) {
			clauses.push("false");
		} else {
			const placeholders = filter.sessionIds.map((sessionId) => {
				params.push(sessionId);
				return `$${params.length}`;
			});
			clauses.push(`t.session_id IN (${placeholders.join(", ")})`);
		}
	}
	if (filter.status) {
		params.push(filter.status);
		clauses.push(`t.status = $${params.length}`);
	}
	if (filter.from !== undefined) {
		params.push(filter.from);
		clauses.push(`t.started_at >= $${params.length}`);
	}
	if (filter.to !== undefined) {
		params.push(filter.to);
		clauses.push(`t.started_at <= $${params.length}`);
	}
	return { where: `WHERE ${clauses.join(" AND ")}`, params };
}
