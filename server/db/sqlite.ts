/**
 * SQLite 实现（Node 内置 `node:sqlite`，零第三方依赖）—— 默认后端，测试跑的就是这条路径。
 *
 * 存储策略与拆分前一致：一张 `sessions` 表，元数据做成可查询的列，
 * 完整会话（对话记录 / 审计 / 流程状态 / 业务数据 / agent 上下文）序列化成 payload JSON。
 * 这样既可以用 SQL 按时间过滤，又不用维护六张关联表。
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { WorkflowSkillText, WorkflowStep } from "../../src/core/types.js";
import { DEFAULT_WORKSPACE_ID } from "./types.js";
import type {
	ApiKeyInput,
	ApiKeyPatch,
	ApiKeyRecord,
	AuditFilter,
	AuditLogInput,
	AuditLogRecord,
	ImBotInput,
	ImBotPatch,
	ImBotRecord,
	ImPlatform,
	ImSessionInput,
	ImSessionPatch,
	ImSessionRecord,
	MigrationRecord,
	MonitorStats,
	ModelInput,
	ModelPatch,
	ModelProviderInput,
	ModelProviderKind,
	ModelProviderPatch,
	ModelProviderRecord,
	ModelRecord,
	ModelType,
	McpServerInput,
	McpServerPatch,
	McpServerRecord,
	McpServerStatus,
	McpToolInput,
	McpToolPatch,
	McpToolRecord,
	McpTransport,
	PersistedSession,
	RemoveProviderResult,
	Role,
	Storage,
	StorageDiagnostics,
	StorageInfo,
	TraceEventInput,
	TraceEventKind,
	TraceEventRecord,
	TraceFilter,
	TraceRecord,
	TraceStatus,
	TraceSummaryRecord,
	UserInput,
	UserPatch,
	UserRecord,
	WorkflowRow,
} from "./types.js";

/** workflows 表的行（列名是下划线风格，只在这一层做映射）。 */
interface WorkflowDbRow {
	id: string;
	name: string;
	system_prompt: string;
	steps: string;
	skill: string | null;
	created_at: number;
	updated_at: number;
}

/**
 * 表结构内建（不走 db/migrations 的 SQL 文件：那些是 Postgres 方言）。
 * 老库缺列不能指望 CREATE TABLE IF NOT EXISTS，见构造函数里的 PRAGMA 兜底。
 */
const SCHEMA_DDL = `
	CREATE TABLE IF NOT EXISTS sessions (
		id          TEXT PRIMARY KEY,
		workflow_id TEXT NOT NULL,
		created_at  INTEGER NOT NULL,
		updated_at  INTEGER NOT NULL,
		done        INTEGER NOT NULL DEFAULT 0,
		payload     TEXT NOT NULL
	);
	CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions (updated_at DESC);
	CREATE TABLE IF NOT EXISTS workflows (
		id            TEXT PRIMARY KEY,
		name          TEXT NOT NULL,
		system_prompt TEXT NOT NULL,
		steps         TEXT NOT NULL,
		skill         TEXT,
		created_at    INTEGER NOT NULL,
		updated_at    INTEGER NOT NULL
	);
	CREATE TABLE IF NOT EXISTS users (
		id            TEXT PRIMARY KEY,
		workspace_id  TEXT NOT NULL DEFAULT 'default',
		email         TEXT NOT NULL UNIQUE,
		name          TEXT,
		password_hash TEXT,
		role          TEXT NOT NULL DEFAULT 'developer',
		disabled      INTEGER NOT NULL DEFAULT 0,
		created_at    INTEGER NOT NULL,
		last_login_at INTEGER
	);
	CREATE TABLE IF NOT EXISTS audit_logs (
		id           INTEGER PRIMARY KEY AUTOINCREMENT,
		workspace_id TEXT NOT NULL DEFAULT 'default',
		actor_type   TEXT NOT NULL,
		actor_id     TEXT,
		action       TEXT NOT NULL,
		target_type  TEXT,
		target_id    TEXT,
		detail       TEXT,
		trace_id     TEXT,
		created_at   INTEGER NOT NULL
	);
	CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs (created_at DESC, id DESC);
	CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs (action, created_at DESC);
	CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs (actor_id, created_at DESC);
	CREATE TABLE IF NOT EXISTS model_providers (
		id                TEXT PRIMARY KEY,
		name              TEXT NOT NULL UNIQUE,
		kind              TEXT NOT NULL DEFAULT 'openai',
		base_url          TEXT,
		api_key_encrypted TEXT,
		enabled           INTEGER NOT NULL DEFAULT 1,
		created_at        INTEGER NOT NULL,
		updated_at        INTEGER NOT NULL
	);
	CREATE TABLE IF NOT EXISTS models (
		id             TEXT PRIMARY KEY,
		provider_id    TEXT NOT NULL,
		name           TEXT NOT NULL,
		model_id       TEXT NOT NULL,
		kind           TEXT NOT NULL DEFAULT 'chat',
		enabled        INTEGER NOT NULL DEFAULT 1,
		context_window INTEGER,
		created_at     INTEGER NOT NULL,
		updated_at     INTEGER NOT NULL
	);
	CREATE INDEX IF NOT EXISTS idx_models_provider ON models (provider_id, kind);
	CREATE TABLE IF NOT EXISTS api_keys (
		id                 TEXT PRIMARY KEY,
		workspace_id       TEXT NOT NULL DEFAULT 'default',
		name               TEXT NOT NULL,
		prefix             TEXT NOT NULL,
		key_hash           TEXT NOT NULL,
		role               TEXT NOT NULL DEFAULT 'operator',
		rate_limit_per_min INTEGER NOT NULL DEFAULT 60,
		disabled           INTEGER NOT NULL DEFAULT 0,
		last_used_at       INTEGER,
		created_at         INTEGER NOT NULL,
		revoked_at         INTEGER
	);
	CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys (prefix);
	CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys (key_hash);
	CREATE TABLE IF NOT EXISTS mcp_servers (
		id              TEXT PRIMARY KEY,
		workspace_id    TEXT NOT NULL DEFAULT 'default',
		name            TEXT NOT NULL,
		transport       TEXT NOT NULL DEFAULT 'stdio',
		command         TEXT,
		args            TEXT,
		url             TEXT,
		headers         TEXT,
		env             TEXT,
		enabled         INTEGER NOT NULL DEFAULT 1,
		last_status     TEXT NOT NULL DEFAULT 'unknown',
		last_error      TEXT,
		last_checked_at INTEGER,
		created_at      INTEGER NOT NULL,
		updated_at      INTEGER NOT NULL
	);
	CREATE INDEX IF NOT EXISTS idx_mcp_servers_enabled ON mcp_servers (enabled, created_at ASC);
	CREATE TABLE IF NOT EXISTS mcp_tools (
		id           TEXT PRIMARY KEY,
		server_id    TEXT NOT NULL,
		name         TEXT NOT NULL,
		description  TEXT NOT NULL DEFAULT '',
		input_schema TEXT,
		enabled      INTEGER NOT NULL DEFAULT 1,
		created_at   INTEGER NOT NULL,
		UNIQUE (server_id, name)
	);
	CREATE INDEX IF NOT EXISTS idx_mcp_tools_server ON mcp_tools (server_id, enabled);
	CREATE TABLE IF NOT EXISTS traces (
		id           TEXT PRIMARY KEY,
		workspace_id TEXT NOT NULL DEFAULT 'default',
		session_id   TEXT,
		workflow_id  TEXT,
		skill_id     TEXT,
		started_at   INTEGER NOT NULL,
		finished_at  INTEGER,
		status       TEXT NOT NULL DEFAULT 'running',
		error        TEXT
	);
	CREATE INDEX IF NOT EXISTS idx_traces_started ON traces (started_at DESC);
	CREATE INDEX IF NOT EXISTS idx_traces_session ON traces (session_id, started_at DESC);
	CREATE INDEX IF NOT EXISTS idx_traces_status ON traces (status, started_at DESC);
	CREATE TABLE IF NOT EXISTS trace_events (
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		trace_id   TEXT NOT NULL,
		seq        INTEGER NOT NULL,
		kind       TEXT NOT NULL,
		name       TEXT,
		ok         INTEGER,
		ms         INTEGER,
		payload    TEXT,
		created_at INTEGER NOT NULL,
		UNIQUE (trace_id, seq)
	);
	CREATE INDEX IF NOT EXISTS idx_trace_events_trace ON trace_events (trace_id, seq);
	CREATE INDEX IF NOT EXISTS idx_trace_events_kind ON trace_events (kind, created_at DESC);
	CREATE TABLE IF NOT EXISTS im_bots (
		id               TEXT PRIMARY KEY,
		workspace_id     TEXT NOT NULL DEFAULT 'default',
		name             TEXT NOT NULL,
		platform         TEXT NOT NULL DEFAULT 'dingtalk',
		app_key          TEXT NOT NULL DEFAULT '',
		app_secret_enc   TEXT,
		sign_secret_enc  TEXT,
		robot_code       TEXT NOT NULL DEFAULT '',
		aes_key_enc      TEXT,
		workflow_id      TEXT NOT NULL DEFAULT 'auto-flow',
		enabled          INTEGER NOT NULL DEFAULT 1,
		last_callback_at INTEGER,
		created_at       INTEGER NOT NULL,
		updated_at       INTEGER NOT NULL
	);
	CREATE INDEX IF NOT EXISTS idx_im_bots_workspace ON im_bots (workspace_id, created_at ASC);
	CREATE TABLE IF NOT EXISTS im_sessions (
		id               TEXT PRIMARY KEY,
		bot_id           TEXT NOT NULL,
		conversation_id  TEXT NOT NULL,
		external_user_id TEXT,
		session_id       TEXT NOT NULL DEFAULT '',
		last_msg_id      TEXT,
		created_at       INTEGER NOT NULL,
		updated_at       INTEGER NOT NULL,
		UNIQUE (bot_id, conversation_id)
	);
	CREATE INDEX IF NOT EXISTS idx_im_sessions_bot ON im_sessions (bot_id, updated_at DESC);
`;

/**
 * 需要靠 `PRAGMA table_info` + `ALTER TABLE` 补齐的列（坑 19/23）。
 * `CREATE TABLE IF NOT EXISTS` 只对新库生效，老库加了列必须在这里补一行，否则读写直接炸。
 */
const EXTRA_COLUMNS: { table: string; name: string; ddl: string }[] = [
	{ table: "workflows", name: "skill", ddl: "ALTER TABLE workflows ADD COLUMN skill TEXT" },
	// P7 MCP：老库可能只建了 0001 那版（没有 env / 最近一次发现状态），启动时补齐
	{ table: "mcp_servers", name: "env", ddl: "ALTER TABLE mcp_servers ADD COLUMN env TEXT" },
	{
		table: "mcp_servers",
		name: "last_status",
		ddl: "ALTER TABLE mcp_servers ADD COLUMN last_status TEXT NOT NULL DEFAULT 'unknown'",
	},
	{ table: "mcp_servers", name: "last_error", ddl: "ALTER TABLE mcp_servers ADD COLUMN last_error TEXT" },
	{
		table: "mcp_servers",
		name: "last_checked_at",
		ddl: "ALTER TABLE mcp_servers ADD COLUMN last_checked_at INTEGER",
	},
	{
		table: "mcp_tools",
		name: "description",
		ddl: "ALTER TABLE mcp_tools ADD COLUMN description TEXT NOT NULL DEFAULT ''",
	},
	{ table: "mcp_tools", name: "input_schema", ddl: "ALTER TABLE mcp_tools ADD COLUMN input_schema TEXT" },
	{
		table: "mcp_tools",
		name: "enabled",
		ddl: "ALTER TABLE mcp_tools ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1",
	},
	// P9：trace_events 的 ok / ms 是后加的列（0001 只有 payload），老库启动时补齐
	{ table: "trace_events", name: "ok", ddl: "ALTER TABLE trace_events ADD COLUMN ok INTEGER" },
	{ table: "trace_events", name: "ms", ddl: "ALTER TABLE trace_events ADD COLUMN ms INTEGER" },
	// P8 IM：0001 的 PG 表没有这些列，SQLite 侧新建时已建好；老库/手工建表补一遍（幂等）
	{
		table: "im_bots",
		name: "robot_code",
		ddl: "ALTER TABLE im_bots ADD COLUMN robot_code TEXT NOT NULL DEFAULT ''",
	},
	{ table: "im_bots", name: "aes_key_enc", ddl: "ALTER TABLE im_bots ADD COLUMN aes_key_enc TEXT" },
	{ table: "im_bots", name: "last_callback_at", ddl: "ALTER TABLE im_bots ADD COLUMN last_callback_at INTEGER" },
	{ table: "im_sessions", name: "last_msg_id", ddl: "ALTER TABLE im_sessions ADD COLUMN last_msg_id TEXT" },
];

export class SqliteStorage implements Storage {
	readonly kind = "sqlite" as const;
	private readonly db: DatabaseSync;
	private readonly path: string;

	constructor(path: string) {
		this.path = path;
		mkdirSync(dirname(path), { recursive: true });
		this.db = new DatabaseSync(path);
		this.db.exec(SCHEMA_DDL);
		this.healColumns();
	}

	/** 老库缺列自愈：按表分组查一次 PRAGMA，缺哪列补哪列（幂等，跑几次都一样）。 */
	private healColumns(): void {
		const tables = [...new Set(EXTRA_COLUMNS.map((column) => column.table))];
		for (const table of tables) {
			const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
			for (const column of EXTRA_COLUMNS.filter((item) => item.table === table)) {
				if (!columns.some((existing) => existing.name === column.name)) {
					this.db.exec(column.ddl);
				}
			}
		}
		// P9：采集器重试靠 (trace_id, seq) 唯一；老库可能没有这个索引，缺了就补。
		// 极小概率已有重复行时先保留最小 id 再建索引——监控元数据不能让服务起不来。
		try {
			this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_trace_events_trace_seq ON trace_events (trace_id, seq)");
		} catch {
			this.db.exec("DELETE FROM trace_events WHERE id NOT IN (SELECT MIN(id) FROM trace_events GROUP BY trace_id, seq)");
			this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_trace_events_trace_seq ON trace_events (trace_id, seq)");
		}
	}

	info(): StorageInfo {
		return { kind: "sqlite", detail: this.path };
	}

	diagnostics(): StorageDiagnostics {
		const version = this.db.prepare("SELECT sqlite_version() AS version").get() as { version: string };
		const tables = (
			this.db
				.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
				.all() as { name: string }[]
		).map((row) => row.name);
		return { version: `SQLite ${version.version}`, tables };
	}

	/** SQLite 没有 SQL 迁移文件：表结构内建 + PRAGMA 自愈，这里保持空数组。 */
	migrations(): MigrationRecord[] {
		return [];
	}

	/* ---------------- 自定义流程 ---------------- */

	saveWorkflow(row: WorkflowRow): void {
		this.db
			.prepare(
				`INSERT INTO workflows (id, name, system_prompt, steps, skill, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET
					name          = excluded.name,
					system_prompt = excluded.system_prompt,
					steps         = excluded.steps,
					skill         = excluded.skill,
					updated_at    = excluded.updated_at`,
			)
			.run(
				row.id,
				row.name,
				row.systemPrompt,
				JSON.stringify(row.steps),
				row.skill ? JSON.stringify(row.skill) : null,
				row.createdAt,
				row.updatedAt,
			);
	}

	getWorkflow(id: string): WorkflowRow | undefined {
		const row = this.db
			.prepare("SELECT id, name, system_prompt, steps, skill, created_at, updated_at FROM workflows WHERE id = ?")
			.get(id) as WorkflowDbRow | undefined;
		return row ? this.toWorkflowRow(row) : undefined;
	}

	listWorkflows(): WorkflowRow[] {
		const rows = this.db
			.prepare(
				"SELECT id, name, system_prompt, steps, skill, created_at, updated_at FROM workflows ORDER BY created_at ASC",
			)
			.all() as unknown as WorkflowDbRow[];
		return rows.map((row) => this.toWorkflowRow(row));
	}

	removeWorkflow(id: string): boolean {
		const result = this.db.prepare("DELETE FROM workflows WHERE id = ?").run(id);
		return Number(result.changes) > 0;
	}

	private toWorkflowRow(row: WorkflowDbRow): WorkflowRow {
		return {
			id: row.id,
			name: row.name,
			systemPrompt: row.system_prompt,
			steps: JSON.parse(row.steps) as WorkflowStep[],
			...(row.skill ? { skill: JSON.parse(row.skill) as WorkflowSkillText } : {}),
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		};
	}

	/* ---------------- 会话 ---------------- */

	save(record: PersistedSession): void {
		this.db
			.prepare(
				`INSERT INTO sessions (id, workflow_id, created_at, updated_at, done, payload)
				 VALUES (?, ?, ?, ?, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET
					updated_at = excluded.updated_at,
					done       = excluded.done,
					payload    = excluded.payload`,
			)
			.run(
				record.id,
				record.workflowId,
				record.createdAt,
				record.updatedAt,
				record.done ? 1 : 0,
				JSON.stringify(record),
			);
	}

	load(id: string): PersistedSession | undefined {
		const row = this.db.prepare("SELECT payload FROM sessions WHERE id = ?").get(id) as
			| { payload: string }
			| undefined;
		if (!row) {
			return undefined;
		}
		return JSON.parse(row.payload) as PersistedSession;
	}

	/** 按更新时间倒序返回全部会话。 */
	list(): PersistedSession[] {
		const rows = this.db.prepare("SELECT payload FROM sessions ORDER BY updated_at DESC").all() as { payload: string }[];
		return rows.map((row) => JSON.parse(row.payload) as PersistedSession);
	}

	/** 只取 id，用于和内存中的活跃会话合并。 */
	ids(): string[] {
		const rows = this.db.prepare("SELECT id FROM sessions ORDER BY updated_at DESC").all() as { id: string }[];
		return rows.map((row) => row.id);
	}

	remove(id: string): boolean {
		const result = this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
		return Number(result.changes) > 0;
	}

	clear(): number {
		const result = this.db.prepare("DELETE FROM sessions").run();
		return Number(result.changes);
	}

	count(): number {
		const row = this.db.prepare("SELECT COUNT(*) AS total FROM sessions").get() as { total: number };
		return Number(row.total);
	}

	/* ---------------- 成员（P3） ---------------- */

	getUserByEmail(email: string): UserRecord | undefined {
		const row = this.db
			.prepare(
				"SELECT id, workspace_id, email, name, password_hash, role, disabled, created_at, last_login_at FROM users WHERE email = ?",
			)
			.get(email) as UserDbRow | undefined;
		return row ? toUserRecord(row) : undefined;
	}

	getUserById(id: string): UserRecord | undefined {
		const row = this.db
			.prepare(
				"SELECT id, workspace_id, email, name, password_hash, role, disabled, created_at, last_login_at FROM users WHERE id = ?",
			)
			.get(id) as UserDbRow | undefined;
		return row ? toUserRecord(row) : undefined;
	}

	createUser(user: UserInput): UserRecord {
		this.db
			.prepare(
				`INSERT INTO users (id, workspace_id, email, name, password_hash, role, disabled, created_at, last_login_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
			)
			.run(
				user.id,
				user.workspaceId,
				user.email,
				user.name,
				user.passwordHash,
				user.role,
				user.disabled ? 1 : 0,
				user.createdAt,
			);
		return { ...user, lastLoginAt: null };
	}

	listUsers(): UserRecord[] {
		const rows = this.db
			.prepare(
				"SELECT id, workspace_id, email, name, password_hash, role, disabled, created_at, last_login_at FROM users WHERE workspace_id = ? ORDER BY created_at ASC",
			)
			.all(DEFAULT_WORKSPACE_ID) as unknown as UserDbRow[];
		return rows.map(toUserRecord);
	}

	countUsers(): number {
		const row = this.db.prepare("SELECT COUNT(*) AS total FROM users").get() as { total: number };
		return Number(row.total);
	}

	updateLoginTime(id: string, at: number): void {
		this.db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(at, id);
	}

	updateUser(id: string, patch: UserPatch): UserRecord | undefined {
		// SET 片段只来自列名常量，值一律走参数；空补丁 = 纯读取（不产生 UPDATE）
		const sets: string[] = [];
		const params: (string | number | null)[] = [];
		if (patch.role !== undefined) {
			sets.push("role = ?");
			params.push(patch.role);
		}
		if (patch.disabled !== undefined) {
			sets.push("disabled = ?");
			params.push(patch.disabled ? 1 : 0);
		}
		if (patch.name !== undefined) {
			sets.push("name = ?");
			params.push(patch.name);
		}
		if (sets.length > 0) {
			this.db.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).run(...params, id);
		}
		return this.getUserById(id);
	}

	deleteUser(id: string): boolean {
		const result = this.db.prepare("DELETE FROM users WHERE id = ?").run(id);
		return Number(result.changes) > 0;
	}

	/* ---------------- 平台审计（P3） ---------------- */

	appendAudit(entry: AuditLogInput): void {
		this.db
			.prepare(
				`INSERT INTO audit_logs (workspace_id, actor_type, actor_id, action, target_type, target_id, detail, trace_id, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				entry.workspaceId,
				entry.actorType,
				entry.actorId ?? null,
				entry.action,
				entry.targetType ?? null,
				entry.targetId ?? null,
				entry.detail === undefined ? null : JSON.stringify(entry.detail),
				entry.traceId ?? null,
				entry.createdAt,
			);
	}

	listAudit(filter: AuditFilter): AuditLogRecord[] {
		const { where, params } = auditWhere(filter);
		const rows = this.db
			.prepare(
				`SELECT id, workspace_id, actor_type, actor_id, action, target_type, target_id, detail, trace_id, created_at
				 FROM audit_logs ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
			)
			.all(...params, filter.limit, filter.offset) as unknown as AuditDbRow[];
		return rows.map(toAuditRecord);
	}

	countAudit(filter: Omit<AuditFilter, "limit" | "offset"> = {}): number {
		const { where, params } = auditWhere(filter);
		const row = this.db.prepare(`SELECT COUNT(*) AS total FROM audit_logs ${where}`).get(...params) as {
			total: number;
		};
		return Number(row.total);
	}

	/* ---------------- 多模型管理（P6） ---------------- */

	private static readonly PROVIDER_COLUMNS =
		"id, name, kind, base_url, api_key_encrypted, enabled, created_at, updated_at";

	listModelProviders(): ModelProviderRecord[] {
		const rows = this.db
			.prepare(`SELECT ${SqliteStorage.PROVIDER_COLUMNS} FROM model_providers ORDER BY created_at ASC`)
			.all() as unknown as ModelProviderDbRow[];
		return rows.map(toProviderRecord);
	}

	getModelProvider(id: string): ModelProviderRecord | undefined {
		const row = this.db
			.prepare(`SELECT ${SqliteStorage.PROVIDER_COLUMNS} FROM model_providers WHERE id = ?`)
			.get(id) as ModelProviderDbRow | undefined;
		return row ? toProviderRecord(row) : undefined;
	}

	createModelProvider(provider: ModelProviderInput): ModelProviderRecord {
		this.db
			.prepare(
				`INSERT INTO model_providers (id, name, kind, base_url, api_key_encrypted, enabled, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				provider.id,
				provider.name,
				provider.kind,
				provider.baseUrl,
				provider.apiKeyEncrypted,
				provider.enabled ? 1 : 0,
				provider.createdAt,
				provider.updatedAt,
			);
		return { ...provider };
	}

	updateModelProvider(id: string, patch: ModelProviderPatch): ModelProviderRecord | undefined {
		const sets = ["updated_at = ?"];
		const values: (string | number | null)[] = [patch.updatedAt];
		if (patch.name !== undefined) {
			sets.push("name = ?");
			values.push(patch.name);
		}
		if (patch.kind !== undefined) {
			sets.push("kind = ?");
			values.push(patch.kind);
		}
		if (patch.baseUrl !== undefined) {
			sets.push("base_url = ?");
			values.push(patch.baseUrl);
		}
		if (patch.apiKeyEncrypted !== undefined) {
			sets.push("api_key_encrypted = ?");
			values.push(patch.apiKeyEncrypted);
		}
		if (patch.enabled !== undefined) {
			sets.push("enabled = ?");
			values.push(patch.enabled ? 1 : 0);
		}
		this.db.prepare(`UPDATE model_providers SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
		return this.getModelProvider(id);
	}

	removeModelProvider(id: string): RemoveProviderResult {
		const modelsRemoved = Number(this.db.prepare("DELETE FROM models WHERE provider_id = ?").run(id).changes);
		const removed = Number(this.db.prepare("DELETE FROM model_providers WHERE id = ?").run(id).changes) > 0;
		return { removed, modelsRemoved };
	}

	private static readonly MODEL_COLUMNS =
		"id, provider_id, name, model_id, kind, enabled, context_window, created_at, updated_at";

	listModels(): ModelRecord[] {
		const rows = this.db
			.prepare(`SELECT ${SqliteStorage.MODEL_COLUMNS} FROM models ORDER BY created_at ASC`)
			.all() as unknown as ModelDbRow[];
		return rows.map(toModelRecord);
	}

	getModel(id: string): ModelRecord | undefined {
		const row = this.db.prepare(`SELECT ${SqliteStorage.MODEL_COLUMNS} FROM models WHERE id = ?`).get(id) as
			| ModelDbRow
			| undefined;
		return row ? toModelRecord(row) : undefined;
	}

	createModel(model: ModelInput): ModelRecord {
		this.db
			.prepare(
				`INSERT INTO models (id, provider_id, name, model_id, kind, enabled, context_window, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				model.id,
				model.providerId,
				model.name,
				model.modelId,
				model.kind,
				model.enabled ? 1 : 0,
				model.contextWindow,
				model.createdAt,
				model.updatedAt,
			);
		return { ...model };
	}

	updateModel(id: string, patch: ModelPatch): ModelRecord | undefined {
		const sets = ["updated_at = ?"];
		const values: (string | number | null)[] = [patch.updatedAt];
		if (patch.providerId !== undefined) {
			sets.push("provider_id = ?");
			values.push(patch.providerId);
		}
		if (patch.name !== undefined) {
			sets.push("name = ?");
			values.push(patch.name);
		}
		if (patch.modelId !== undefined) {
			sets.push("model_id = ?");
			values.push(patch.modelId);
		}
		if (patch.kind !== undefined) {
			sets.push("kind = ?");
			values.push(patch.kind);
		}
		if (patch.enabled !== undefined) {
			sets.push("enabled = ?");
			values.push(patch.enabled ? 1 : 0);
		}
		if (patch.contextWindow !== undefined) {
			sets.push("context_window = ?");
			values.push(patch.contextWindow);
		}
		this.db.prepare(`UPDATE models SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
		return this.getModel(id);
	}

	removeModel(id: string): boolean {
		return Number(this.db.prepare("DELETE FROM models WHERE id = ?").run(id).changes) > 0;
	}

	/* ---------------- 开放 API 的 API Key（P4） ---------------- */

	private static readonly API_KEY_COLUMNS =
		"id, name, prefix, key_hash, role, rate_limit_per_min, disabled, last_used_at, created_at, revoked_at";

	listApiKeys(): ApiKeyRecord[] {
		const rows = this.db
			.prepare(`SELECT ${SqliteStorage.API_KEY_COLUMNS} FROM api_keys ORDER BY created_at ASC`)
			.all() as unknown as ApiKeyDbRow[];
		return rows.map(toApiKeyRecord);
	}

	getApiKeyByHash(keyHash: string): ApiKeyRecord | undefined {
		const row = this.db
			.prepare(`SELECT ${SqliteStorage.API_KEY_COLUMNS} FROM api_keys WHERE key_hash = ?`)
			.get(keyHash) as ApiKeyDbRow | undefined;
		return row ? toApiKeyRecord(row) : undefined;
	}

	createApiKey(key: ApiKeyInput): ApiKeyRecord {
		this.db
			.prepare(
				`INSERT INTO api_keys (id, workspace_id, name, prefix, key_hash, role, rate_limit_per_min, disabled, last_used_at, created_at, revoked_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				key.id,
				DEFAULT_WORKSPACE_ID,
				key.name,
				key.prefix,
				key.keyHash,
				key.role,
				key.rateLimitPerMin,
				key.disabled ? 1 : 0,
				key.lastUsedAt,
				key.createdAt,
				key.revokedAt,
			);
		return { ...key };
	}

	updateApiKey(id: string, patch: ApiKeyPatch): ApiKeyRecord | undefined {
		const sets: string[] = [];
		const values: (string | number | null)[] = [];
		if (patch.name !== undefined) {
			sets.push("name = ?");
			values.push(patch.name);
		}
		if (patch.role !== undefined) {
			sets.push("role = ?");
			values.push(patch.role);
		}
		if (patch.rateLimitPerMin !== undefined) {
			sets.push("rate_limit_per_min = ?");
			values.push(patch.rateLimitPerMin);
		}
		if (patch.disabled !== undefined) {
			sets.push("disabled = ?");
			values.push(patch.disabled ? 1 : 0);
		}
		if (patch.lastUsedAt !== undefined) {
			sets.push("last_used_at = ?");
			values.push(patch.lastUsedAt);
		}
		if (patch.revokedAt !== undefined) {
			sets.push("revoked_at = ?");
			values.push(patch.revokedAt);
		}
		if (sets.length > 0) {
			this.db.prepare(`UPDATE api_keys SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
		}
		return this.apiKeyById(id);
	}

	removeApiKey(id: string): boolean {
		return Number(this.db.prepare("DELETE FROM api_keys WHERE id = ?").run(id).changes) > 0;
	}

	touchApiKey(id: string, at: number): void {
		this.db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(at, id);
	}

	private apiKeyById(id: string): ApiKeyRecord | undefined {
		const row = this.db
			.prepare(`SELECT ${SqliteStorage.API_KEY_COLUMNS} FROM api_keys WHERE id = ?`)
			.get(id) as ApiKeyDbRow | undefined;
		return row ? toApiKeyRecord(row) : undefined;
	}

	/* ---------------- MCP 集成（P7） ---------------- */

	private static readonly MCP_SERVER_COLUMNS =
		"id, name, transport, command, args, url, headers, env, enabled, last_status, last_error, last_checked_at, created_at, updated_at";

	listMcpServers(): McpServerRecord[] {
		const rows = this.db
			.prepare(`SELECT ${SqliteStorage.MCP_SERVER_COLUMNS} FROM mcp_servers ORDER BY created_at ASC`)
			.all() as unknown as McpServerDbRow[];
		return rows.map(toMcpServerRecord);
	}

	getMcpServer(id: string): McpServerRecord | undefined {
		const row = this.db
			.prepare(`SELECT ${SqliteStorage.MCP_SERVER_COLUMNS} FROM mcp_servers WHERE id = ?`)
			.get(id) as McpServerDbRow | undefined;
		return row ? toMcpServerRecord(row) : undefined;
	}

	createMcpServer(server: McpServerInput): McpServerRecord {
		this.db
			.prepare(
				`INSERT INTO mcp_servers
					(id, name, transport, command, args, url, headers, env, enabled, last_status, last_error, last_checked_at, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				server.id,
				server.name,
				server.transport,
				server.command,
				JSON.stringify(server.args),
				server.url,
				JSON.stringify(server.headers),
				JSON.stringify(server.env),
				server.enabled ? 1 : 0,
				server.lastStatus ?? "unknown",
				server.lastError ?? null,
				server.lastCheckedAt ?? null,
				server.createdAt,
				server.updatedAt,
			);
		return this.getMcpServer(server.id)!;
	}

	updateMcpServer(id: string, patch: McpServerPatch): McpServerRecord | undefined {
		const sets = ["updated_at = ?"];
		const values: (string | number | null)[] = [patch.updatedAt];
		if (patch.name !== undefined) {
			sets.push("name = ?");
			values.push(patch.name);
		}
		if (patch.transport !== undefined) {
			sets.push("transport = ?");
			values.push(patch.transport);
		}
		if (patch.command !== undefined) {
			sets.push("command = ?");
			values.push(patch.command);
		}
		if (patch.args !== undefined) {
			sets.push("args = ?");
			values.push(JSON.stringify(patch.args));
		}
		if (patch.url !== undefined) {
			sets.push("url = ?");
			values.push(patch.url);
		}
		if (patch.headers !== undefined) {
			sets.push("headers = ?");
			values.push(JSON.stringify(patch.headers));
		}
		if (patch.env !== undefined) {
			sets.push("env = ?");
			values.push(JSON.stringify(patch.env));
		}
		if (patch.enabled !== undefined) {
			sets.push("enabled = ?");
			values.push(patch.enabled ? 1 : 0);
		}
		if (patch.lastStatus !== undefined) {
			sets.push("last_status = ?");
			values.push(patch.lastStatus);
		}
		if (patch.lastError !== undefined) {
			sets.push("last_error = ?");
			values.push(patch.lastError);
		}
		if (patch.lastCheckedAt !== undefined) {
			sets.push("last_checked_at = ?");
			values.push(patch.lastCheckedAt);
		}
		this.db.prepare(`UPDATE mcp_servers SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
		return this.getMcpServer(id);
	}

	removeMcpServer(id: string): boolean {
		// SQLite 没开外键：工具必须显式删，否则会留下永远停用的孤儿行
		this.db.prepare("DELETE FROM mcp_tools WHERE server_id = ?").run(id);
		return Number(this.db.prepare("DELETE FROM mcp_servers WHERE id = ?").run(id).changes) > 0;
	}

	private static readonly MCP_TOOL_COLUMNS = "id, server_id, name, description, input_schema, enabled, created_at";

	listMcpTools(serverId?: string): McpToolRecord[] {
		const rows = (
			serverId === undefined
				? this.db
						.prepare(`SELECT ${SqliteStorage.MCP_TOOL_COLUMNS} FROM mcp_tools ORDER BY created_at ASC`)
						.all()
				: this.db
						.prepare(
							`SELECT ${SqliteStorage.MCP_TOOL_COLUMNS} FROM mcp_tools WHERE server_id = ? ORDER BY created_at ASC`,
						)
						.all(serverId)
		) as unknown as McpToolDbRow[];
		return rows.map(toMcpToolRecord);
	}

	getMcpTool(id: string): McpToolRecord | undefined {
		const row = this.db
			.prepare(`SELECT ${SqliteStorage.MCP_TOOL_COLUMNS} FROM mcp_tools WHERE id = ?`)
			.get(id) as McpToolDbRow | undefined;
		return row ? toMcpToolRecord(row) : undefined;
	}

	createMcpTool(tool: McpToolInput): McpToolRecord {
		this.db
			.prepare(
				`INSERT INTO mcp_tools (id, server_id, name, description, input_schema, enabled, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				tool.id,
				tool.serverId,
				tool.name,
				tool.description,
				JSON.stringify(tool.inputSchema),
				tool.enabled ? 1 : 0,
				tool.createdAt,
			);
		return this.getMcpTool(tool.id)!;
	}

	updateMcpTool(id: string, patch: McpToolPatch): McpToolRecord | undefined {
		const sets: string[] = [];
		const values: (string | number | null)[] = [];
		if (patch.description !== undefined) {
			sets.push("description = ?");
			values.push(patch.description);
		}
		if (patch.inputSchema !== undefined) {
			sets.push("input_schema = ?");
			values.push(JSON.stringify(patch.inputSchema));
		}
		if (patch.enabled !== undefined) {
			sets.push("enabled = ?");
			values.push(patch.enabled ? 1 : 0);
		}
		if (sets.length > 0) {
			this.db.prepare(`UPDATE mcp_tools SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
		}
		return this.getMcpTool(id);
	}

	removeMcpTool(id: string): boolean {
		return Number(this.db.prepare("DELETE FROM mcp_tools WHERE id = ?").run(id).changes) > 0;
	}

	removeMcpToolsByServer(serverId: string): number {
		return Number(this.db.prepare("DELETE FROM mcp_tools WHERE server_id = ?").run(serverId).changes);
	}

	/* ---------------- IM Bot 网关（P8） ---------------- */

	private static readonly IM_BOT_COLUMNS =
		"id, workspace_id, name, platform, app_key, app_secret_enc, sign_secret_enc, robot_code, aes_key_enc, workflow_id, enabled, last_callback_at, created_at, updated_at";

	listImBots(): ImBotRecord[] {
		const rows = this.db
			.prepare(`SELECT ${SqliteStorage.IM_BOT_COLUMNS} FROM im_bots ORDER BY created_at ASC`)
			.all() as unknown as ImBotDbRow[];
		return rows.map(toImBotRecord);
	}

	getImBot(id: string): ImBotRecord | undefined {
		const row = this.db
			.prepare(`SELECT ${SqliteStorage.IM_BOT_COLUMNS} FROM im_bots WHERE id = ?`)
			.get(id) as ImBotDbRow | undefined;
		return row ? toImBotRecord(row) : undefined;
	}

	createImBot(bot: ImBotInput): ImBotRecord {
		this.db
			.prepare(
				`INSERT INTO im_bots
					(id, workspace_id, name, platform, app_key, app_secret_enc, sign_secret_enc, robot_code, aes_key_enc,
					 workflow_id, enabled, last_callback_at, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
			)
			.run(
				bot.id,
				bot.workspaceId,
				bot.name,
				bot.platform,
				bot.appKey,
				bot.appSecretEnc,
				bot.callbackTokenEnc,
				bot.robotCode,
				bot.aesKeyEnc,
				bot.workflowId,
				bot.enabled ? 1 : 0,
				bot.createdAt,
				bot.updatedAt,
			);
		return this.getImBot(bot.id)!;
	}

	updateImBot(id: string, patch: ImBotPatch): ImBotRecord | undefined {
		const sets = ["updated_at = ?"];
		const values: (string | number | null)[] = [patch.updatedAt];
		if (patch.name !== undefined) {
			sets.push("name = ?");
			values.push(patch.name);
		}
		if (patch.appKey !== undefined) {
			sets.push("app_key = ?");
			values.push(patch.appKey);
		}
		if (patch.appSecretEnc !== undefined) {
			sets.push("app_secret_enc = ?");
			values.push(patch.appSecretEnc);
		}
		if (patch.callbackTokenEnc !== undefined) {
			sets.push("sign_secret_enc = ?");
			values.push(patch.callbackTokenEnc);
		}
		if (patch.robotCode !== undefined) {
			sets.push("robot_code = ?");
			values.push(patch.robotCode);
		}
		if (patch.aesKeyEnc !== undefined) {
			sets.push("aes_key_enc = ?");
			values.push(patch.aesKeyEnc);
		}
		if (patch.workflowId !== undefined) {
			sets.push("workflow_id = ?");
			values.push(patch.workflowId);
		}
		if (patch.enabled !== undefined) {
			sets.push("enabled = ?");
			values.push(patch.enabled ? 1 : 0);
		}
		if (patch.lastCallbackAt !== undefined) {
			sets.push("last_callback_at = ?");
			values.push(patch.lastCallbackAt);
		}
		this.db.prepare(`UPDATE im_bots SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
		return this.getImBot(id);
	}

	removeImBot(id: string): boolean {
		// SQLite 没开外键：会话映射必须显式删，否则留下指向不存在机器人的孤儿行
		this.db.prepare("DELETE FROM im_sessions WHERE bot_id = ?").run(id);
		return Number(this.db.prepare("DELETE FROM im_bots WHERE id = ?").run(id).changes) > 0;
	}

	countImSessions(botId: string): number {
		const row = this.db.prepare("SELECT COUNT(*) AS total FROM im_sessions WHERE bot_id = ?").get(botId) as {
			total: number;
		};
		return Number(row.total);
	}

	private static readonly IM_SESSION_COLUMNS =
		"id, bot_id, conversation_id, external_user_id, session_id, last_msg_id, created_at, updated_at";

	getImSession(botId: string, conversationId: string): ImSessionRecord | undefined {
		const row = this.db
			.prepare(
				`SELECT ${SqliteStorage.IM_SESSION_COLUMNS} FROM im_sessions WHERE bot_id = ? AND conversation_id = ?`,
			)
			.get(botId, conversationId) as ImSessionDbRow | undefined;
		return row ? toImSessionRecord(row) : undefined;
	}

	createImSession(session: ImSessionInput): ImSessionRecord {
		this.db
			.prepare(
				`INSERT INTO im_sessions
					(id, bot_id, conversation_id, external_user_id, session_id, last_msg_id, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				session.id,
				session.botId,
				session.conversationId,
				session.externalUserId,
				session.sessionId,
				session.lastMsgId,
				session.createdAt,
				session.updatedAt,
			);
		return this.getImSession(session.botId, session.conversationId)!;
	}

	updateImSession(id: string, patch: ImSessionPatch): ImSessionRecord | undefined {
		const sets = ["updated_at = ?"];
		const values: (string | number | null)[] = [patch.updatedAt];
		if (patch.sessionId !== undefined) {
			sets.push("session_id = ?");
			values.push(patch.sessionId);
		}
		if (patch.externalUserId !== undefined) {
			sets.push("external_user_id = ?");
			values.push(patch.externalUserId);
		}
		if (patch.lastMsgId !== undefined) {
			sets.push("last_msg_id = ?");
			values.push(patch.lastMsgId);
		}
		this.db.prepare(`UPDATE im_sessions SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
		const row = this.db
			.prepare(`SELECT ${SqliteStorage.IM_SESSION_COLUMNS} FROM im_sessions WHERE id = ?`)
			.get(id) as ImSessionDbRow | undefined;
		return row ? toImSessionRecord(row) : undefined;
	}

	removeImSessionsByBot(botId: string): number {
		return Number(this.db.prepare("DELETE FROM im_sessions WHERE bot_id = ?").run(botId).changes);
	}

	/* ---------------- 监控与可观测（P9） ---------------- */

	saveTraces(records: TraceRecord[]): void {
		if (records.length === 0) {
			return;
		}
		const statement = this.db.prepare(
			`INSERT INTO traces (id, workspace_id, session_id, workflow_id, skill_id, started_at, finished_at, status, error)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET
				session_id  = excluded.session_id,
				workflow_id = excluded.workflow_id,
				skill_id    = excluded.skill_id,
				finished_at = excluded.finished_at,
				status      = excluded.status,
				error       = excluded.error`,
		);
		// 一个批次一个事务：要么整批落库，要么整批回滚（重试时靠唯一键保证幂等）
		this.db.exec("BEGIN");
		try {
			for (const record of records) {
				statement.run(
					record.id,
					record.workspaceId,
					record.sessionId,
					record.workflowId,
					record.skillId,
					record.startedAt,
					record.finishedAt,
					record.status,
					record.error,
				);
			}
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	appendTraceEvents(events: TraceEventInput[]): void {
		if (events.length === 0) {
			return;
		}
		const statement = this.db.prepare(
			`INSERT OR IGNORE INTO trace_events (trace_id, seq, kind, name, ok, ms, payload, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		this.db.exec("BEGIN");
		try {
			for (const event of events) {
				statement.run(
					event.traceId,
					event.seq,
					event.kind,
					event.name ?? null,
					event.ok === null || event.ok === undefined ? null : event.ok ? 1 : 0,
					event.ms ?? null,
					event.payload === undefined || event.payload === null ? null : JSON.stringify(event.payload),
					event.createdAt,
				);
			}
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	listTraces(filter: TraceFilter): TraceSummaryRecord[] {
		const { where, params } = traceWhere(filter);
		const rows = this.db
			.prepare(`${TRACE_LIST_SQL} ${where} ORDER BY t.started_at DESC, t.id DESC LIMIT ? OFFSET ?`)
			.all(...params, filter.limit, filter.offset) as unknown as TraceListDbRow[];
		return rows.map(toTraceSummaryRecord);
	}

	countTraces(filter: Omit<TraceFilter, "limit" | "offset">): number {
		const { where, params } = traceWhere(filter);
		const row = this.db.prepare(`SELECT COUNT(*) AS total FROM traces t ${where}`).get(...params) as { total: number };
		return Number(row.total);
	}

	getTrace(id: string): TraceSummaryRecord | undefined {
		const row = this.db.prepare(`${TRACE_LIST_SQL} WHERE t.id = ?`).get(id) as TraceListDbRow | undefined;
		return row ? toTraceSummaryRecord(row) : undefined;
	}

	listTraceEvents(traceId: string): TraceEventRecord[] {
		const rows = this.db
			.prepare(
				`SELECT trace_id, seq, kind, name, ok, ms, payload, created_at
				 FROM trace_events WHERE trace_id = ? ORDER BY seq ASC`,
			)
			.all(traceId) as unknown as TraceEventDbRow[];
		return rows.map(toTraceEventRecord);
	}

	monitorStats(since: number, activeSince: number): MonitorStats {
		const sessions = this.db
			.prepare(
				`SELECT COUNT(*) AS total,
				        COALESCE(SUM(CASE WHEN updated_at >= ? THEN 1 ELSE 0 END), 0) AS active
				 FROM sessions`,
			)
			.get(activeSince) as { total: number; active: number };
		const messages = this.db.prepare("SELECT COUNT(*) AS total FROM traces WHERE started_at >= ?").get(since) as {
			total: number;
		};
		const tools = this.db
			.prepare(
				`SELECT COUNT(*) AS total,
				        COALESCE(SUM(CASE WHEN e.ok = 1 THEN 1 ELSE 0 END), 0) AS ok,
				        COALESCE(SUM(CASE WHEN e.ok = 0 THEN 1 ELSE 0 END), 0) AS failed,
				        COALESCE(AVG(e.ms), 0) AS avg_ms
				 FROM trace_events e JOIN traces t ON t.id = e.trace_id
				 WHERE t.started_at >= ? AND e.kind = 'tool'`,
			)
			.get(since) as { total: number; ok: number; failed: number; avg_ms: number };
		const skills = this.db
			.prepare(
				`SELECT e.name AS id, COUNT(*) AS calls
				 FROM trace_events e JOIN traces t ON t.id = e.trace_id
				 WHERE t.started_at >= ? AND e.kind = 'skill' AND e.ok = 1 AND e.name IS NOT NULL
				 GROUP BY e.name ORDER BY calls DESC, id ASC`,
			)
			.all(since) as unknown as { id: string; calls: number }[];
		const mcp = this.db
			.prepare(
				`SELECT e.name AS server, COUNT(*) AS calls,
				        COALESCE(SUM(CASE WHEN e.ok = 0 THEN 1 ELSE 0 END), 0) AS failed
				 FROM trace_events e JOIN traces t ON t.id = e.trace_id
				 WHERE t.started_at >= ? AND e.kind = 'mcp' AND e.name IS NOT NULL
				 GROUP BY e.name ORDER BY calls DESC, server ASC`,
			)
			.all(since) as unknown as { server: string; calls: number; failed: number }[];
		const models = this.db
			.prepare(
				`SELECT e.name AS model, COUNT(*) AS calls, COALESCE(AVG(e.ms), 0) AS avg_ms
				 FROM trace_events e JOIN traces t ON t.id = e.trace_id
				 WHERE t.started_at >= ? AND e.kind = 'llm' AND e.name IS NOT NULL
				 GROUP BY e.name ORDER BY calls DESC, model ASC`,
			)
			.all(since) as unknown as { model: string; calls: number; avg_ms: number }[];
		const errors = this.db
			.prepare("SELECT COUNT(*) AS total FROM traces WHERE started_at >= ? AND status = 'error'")
			.get(since) as { total: number };
		const durations = this.db
			.prepare(
				`SELECT e.ms AS ms FROM trace_events e JOIN traces t ON t.id = e.trace_id
				 WHERE t.started_at >= ? AND e.kind = 'tool' AND e.ms IS NOT NULL
				 ORDER BY e.id ASC LIMIT 10000`,
			)
			.all(since) as unknown as { ms: number }[];
		return {
			sessions: { total: Number(sessions.total), active24h: Number(sessions.active) },
			messages: Number(messages.total),
			toolCalls: {
				total: Number(tools.total),
				ok: Number(tools.ok),
				failed: Number(tools.failed),
				avgMs: Number(tools.avg_ms),
			},
			skills: skills.map((row) => ({ id: String(row.id), calls: Number(row.calls) })),
			mcp: mcp.map((row) => ({ server: String(row.server), calls: Number(row.calls), failed: Number(row.failed) })),
			model: models.map((row) => ({ model: String(row.model), calls: Number(row.calls), avgMs: Number(row.avg_ms) })),
			errors: Number(errors.total),
			toolDurations: durations.map((row) => Number(row.ms)),
		};
	}

	close(): void {
		this.db.close();
	}
}

/** IM 机器人表的行（列名下划线，只在这一层映射）。 */
interface ImBotDbRow {
	id: string;
	workspace_id: string;
	name: string;
	platform: string;
	app_key: string;
	app_secret_enc: string | null;
	sign_secret_enc: string | null;
	robot_code: string | null;
	aes_key_enc: string | null;
	workflow_id: string | null;
	enabled: number;
	last_callback_at: number | null;
	created_at: number;
	updated_at: number;
}

function toImBotRecord(row: ImBotDbRow): ImBotRecord {
	return {
		id: row.id,
		workspaceId: row.workspace_id,
		name: row.name,
		platform: (row.platform === "wecom" ? "wecom" : "dingtalk") as ImPlatform,
		appKey: row.app_key ?? "",
		appSecretEnc: row.app_secret_enc ?? "",
		callbackTokenEnc: row.sign_secret_enc ?? "",
		robotCode: row.robot_code ?? "",
		aesKeyEnc: row.aes_key_enc,
		workflowId: row.workflow_id ?? "auto-flow",
		enabled: Number(row.enabled) === 1,
		lastCallbackAt: row.last_callback_at === null ? null : Number(row.last_callback_at),
		createdAt: Number(row.created_at),
		updatedAt: Number(row.updated_at),
	};
}

interface ImSessionDbRow {
	id: string;
	bot_id: string;
	conversation_id: string;
	external_user_id: string | null;
	session_id: string | null;
	last_msg_id: string | null;
	created_at: number;
	updated_at: number;
}

function toImSessionRecord(row: ImSessionDbRow): ImSessionRecord {
	return {
		id: row.id,
		botId: row.bot_id,
		conversationId: row.conversation_id,
		externalUserId: row.external_user_id,
		sessionId: row.session_id ?? "",
		lastMsgId: row.last_msg_id,
		createdAt: Number(row.created_at),
		updatedAt: Number(row.updated_at),
	};
}

/** users 表的行（列名下划线，只在这一层映射）。 */
interface UserDbRow {
	id: string;
	workspace_id: string;
	email: string;
	name: string | null;
	password_hash: string | null;
	role: string;
	disabled: number;
	created_at: number;
	last_login_at: number | null;
}

interface AuditDbRow {
	id: number;
	workspace_id: string;
	actor_type: string;
	actor_id: string | null;
	action: string;
	target_type: string | null;
	target_id: string | null;
	detail: string | null;
	trace_id: string | null;
	created_at: number;
}

/** model_providers 表的行（列名下划线，只在这一层映射）。 */
interface ModelProviderDbRow {
	id: string;
	name: string;
	kind: string;
	base_url: string | null;
	api_key_encrypted: string | null;
	enabled: number;
	created_at: number;
	updated_at: number;
}

interface ModelDbRow {
	id: string;
	provider_id: string;
	name: string;
	model_id: string;
	kind: string;
	enabled: number;
	context_window: number | null;
	created_at: number;
	updated_at: number;
}

interface ApiKeyDbRow {
	id: string;
	name: string;
	prefix: string;
	key_hash: string;
	role: string;
	rate_limit_per_min: number;
	disabled: number;
	last_used_at: number | null;
	created_at: number;
	revoked_at: number | null;
}

interface McpServerDbRow {
	id: string;
	name: string;
	transport: string;
	command: string | null;
	args: string | null;
	url: string | null;
	headers: string | null;
	env: string | null;
	enabled: number;
	last_status: string;
	last_error: string | null;
	last_checked_at: number | null;
	created_at: number;
	updated_at: number;
}

interface McpToolDbRow {
	id: string;
	server_id: string;
	name: string;
	description: string | null;
	input_schema: string | null;
	enabled: number;
	created_at: number;
}

/** MCP 的 inputSchema 缺省值：始终给模型一个 object schema，免得 function calling 直接挂。 */
const EMPTY_INPUT_SCHEMA: Record<string, unknown> = { type: "object", properties: {} };

/** 解析 JSON 字符串列；坏数据一律当空（旧库/手工导入的数据不能把服务启动搞崩）。 */
function parseJsonArray(raw: string | null): string[] {
	if (!raw) {
		return [];
	}
	try {
		const parsed = JSON.parse(raw) as unknown;
		return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
	} catch {
		return [];
	}
}

function parseJsonMap(raw: string | null): Record<string, string> {
	if (!raw) {
		return {};
	}
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return {};
		}
		const entries = Object.entries(parsed as Record<string, unknown>)
			.filter((entry): entry is [string, string] => typeof entry[1] === "string");
		return Object.fromEntries(entries);
	} catch {
		return {};
	}
}

function parseJsonObject(raw: string | null): Record<string, unknown> {
	if (!raw) {
		return { ...EMPTY_INPUT_SCHEMA };
	}
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return { ...EMPTY_INPUT_SCHEMA };
		}
		return parsed as Record<string, unknown>;
	} catch {
		return { ...EMPTY_INPUT_SCHEMA };
	}
}

function toMcpServerRecord(row: McpServerDbRow): McpServerRecord {
	const transport = row.transport === "http" || row.transport === "sse" ? row.transport : "stdio";
	const status = row.last_status === "ok" || row.last_status === "error" ? row.last_status : "unknown";
	return {
		id: row.id,
		name: row.name,
		transport: transport as McpTransport,
		command: row.command,
		args: parseJsonArray(row.args),
		url: row.url,
		headers: parseJsonMap(row.headers),
		env: parseJsonMap(row.env),
		enabled: Number(row.enabled) === 1,
		lastStatus: status as McpServerStatus,
		lastError: row.last_error,
		lastCheckedAt: row.last_checked_at === null ? null : Number(row.last_checked_at),
		createdAt: Number(row.created_at),
		updatedAt: Number(row.updated_at),
	};
}

function toMcpToolRecord(row: McpToolDbRow): McpToolRecord {
	return {
		id: row.id,
		serverId: row.server_id,
		name: row.name,
		description: row.description ?? "",
		inputSchema: parseJsonObject(row.input_schema),
		enabled: Number(row.enabled) === 1,
		createdAt: Number(row.created_at),
	};
}

function toProviderRecord(row: ModelProviderDbRow): ModelProviderRecord {
	return {
		id: row.id,
		name: row.name,
		kind: row.kind as ModelProviderKind,
		baseUrl: row.base_url,
		apiKeyEncrypted: row.api_key_encrypted,
		enabled: Number(row.enabled) === 1,
		createdAt: Number(row.created_at),
		updatedAt: Number(row.updated_at),
	};
}

function toModelRecord(row: ModelDbRow): ModelRecord {
	return {
		id: row.id,
		providerId: row.provider_id,
		name: row.name,
		modelId: row.model_id,
		kind: row.kind as ModelType,
		enabled: Number(row.enabled) === 1,
		contextWindow: row.context_window === null ? null : Number(row.context_window),
		createdAt: Number(row.created_at),
		updatedAt: Number(row.updated_at),
	};
}

function toApiKeyRecord(row: ApiKeyDbRow): ApiKeyRecord {
	return {
		id: row.id,
		name: row.name,
		prefix: row.prefix,
		keyHash: row.key_hash,
		role: row.role as Role,
		rateLimitPerMin: Number(row.rate_limit_per_min),
		disabled: Number(row.disabled) === 1,
		lastUsedAt: row.last_used_at === null ? null : Number(row.last_used_at),
		createdAt: Number(row.created_at),
		revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
	};
}

function toUserRecord(row: UserDbRow): UserRecord {
	return {
		id: row.id,
		workspaceId: row.workspace_id,
		email: row.email,
		name: row.name,
		passwordHash: row.password_hash,
		role: row.role as Role,
		disabled: Number(row.disabled) === 1,
		createdAt: Number(row.created_at),
		lastLoginAt: row.last_login_at === null ? null : Number(row.last_login_at),
	};
}

function toAuditRecord(row: AuditDbRow): AuditLogRecord {
	return {
		id: Number(row.id),
		workspaceId: row.workspace_id,
		actorType: row.actor_type,
		actorId: row.actor_id,
		action: row.action,
		targetType: row.target_type,
		targetId: row.target_id,
		detail: row.detail === null ? null : JSON.parse(row.detail),
		traceId: row.trace_id,
		createdAt: Number(row.created_at),
	};
}

/** 审计列表与计数的公共 WHERE 片段（参数化，别拼值）。 */
function auditWhere(filter: {
	action?: string;
	actor?: string;
	actorType?: string;
	targetType?: string;
	from?: number;
	to?: number;
	q?: string;
}): { where: string; params: (string | number)[] } {
	const clauses: string[] = [];
	const params: (string | number)[] = [];
	if (filter.action) {
		clauses.push("action = ?");
		params.push(filter.action);
	}
	if (filter.actor) {
		clauses.push("actor_id = ?");
		params.push(filter.actor);
	}
	if (filter.actorType) {
		clauses.push("actor_type = ?");
		params.push(filter.actorType);
	}
	if (filter.targetType) {
		clauses.push("target_type = ?");
		params.push(filter.targetType);
	}
	if (filter.from !== undefined) {
		clauses.push("created_at >= ?");
		params.push(filter.from);
	}
	if (filter.to !== undefined) {
		clauses.push("created_at <= ?");
		params.push(filter.to);
	}
	if (filter.q) {
		// 模糊匹配动作名与目标（SQLite 的 LIKE 对 ASCII 大小写不敏感；转义 % _ \ 让用户输入按字面量处理）
		const pattern = `%${filter.q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
		clauses.push("(action LIKE ? ESCAPE '\\' OR target_type LIKE ? ESCAPE '\\' OR target_id LIKE ? ESCAPE '\\')");
		params.push(pattern, pattern, pattern);
	}
	return { where: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

/* ---------------- 监控与可观测（P9）的行映射 ---------------- */

interface TraceDbRow {
	id: string;
	workspace_id: string;
	session_id: string | null;
	workflow_id: string | null;
	skill_id: string | null;
	started_at: number;
	finished_at: number | null;
	status: string;
	error: string | null;
}

interface TraceListDbRow extends TraceDbRow {
	model: string | null;
	tool_count: number;
}

interface TraceEventDbRow {
	trace_id: string;
	seq: number;
	kind: string;
	name: string | null;
	ok: number | null;
	ms: number | null;
	payload: string | null;
	created_at: number;
}

/** 列表 / 详情共用的 SELECT：model 与 toolCount 由事件派生子查询，避免给 traces 再加列。 */
const TRACE_LIST_SQL = `SELECT t.id, t.workspace_id, t.session_id, t.workflow_id, t.skill_id,
	t.started_at, t.finished_at, t.status, t.error,
	(SELECT COUNT(*) FROM trace_events e WHERE e.trace_id = t.id AND e.kind = 'tool') AS tool_count,
	(SELECT e.name FROM trace_events e WHERE e.trace_id = t.id AND e.kind = 'llm' ORDER BY e.seq ASC LIMIT 1) AS model
	FROM traces t`;

function traceStatusOf(value: string): TraceStatus {
	return value === "ok" || value === "error" ? value : "running";
}

function toTraceSummaryRecord(row: TraceListDbRow): TraceSummaryRecord {
	return {
		id: String(row.id),
		workspaceId: String(row.workspace_id),
		sessionId: row.session_id,
		workflowId: row.workflow_id,
		skillId: row.skill_id,
		startedAt: Number(row.started_at),
		finishedAt: row.finished_at === null ? null : Number(row.finished_at),
		status: traceStatusOf(String(row.status)),
		error: row.error,
		model: row.model ?? null,
		toolCount: Number(row.tool_count ?? 0),
	};
}

function toTraceEventRecord(row: TraceEventDbRow): TraceEventRecord {
	let payload: unknown = null;
	if (row.payload !== null && row.payload !== undefined) {
		try {
			payload = JSON.parse(row.payload) as unknown;
		} catch {
			payload = null;
		}
	}
	return {
		traceId: String(row.trace_id),
		seq: Number(row.seq),
		kind: String(row.kind) as TraceEventKind,
		name: row.name,
		ok: row.ok === null ? null : Number(row.ok) === 1,
		ms: row.ms === null ? null : Number(row.ms),
		payload,
		createdAt: Number(row.created_at),
	};
}

/** 调用链列表 / 计数的公共 WHERE（`t` 是 traces 的别名）。 */
function traceWhere(filter: Omit<TraceFilter, "limit" | "offset">): {
	where: string;
	params: (string | number)[];
} {
	const clauses: string[] = [];
	const params: (string | number)[] = [];
	if (filter.sessionId) {
		clauses.push("t.session_id = ?");
		params.push(filter.sessionId);
	}
	if (filter.sessionIds) {
		// developer 只能看自己的会话：空列表必须查不到任何行（不能退化成"不过滤"）
		if (filter.sessionIds.length === 0) {
			clauses.push("1 = 0");
		} else {
			clauses.push(`t.session_id IN (${filter.sessionIds.map(() => "?").join(", ")})`);
			params.push(...filter.sessionIds);
		}
	}
	if (filter.status) {
		clauses.push("t.status = ?");
		params.push(filter.status);
	}
	if (filter.from !== undefined) {
		clauses.push("t.started_at >= ?");
		params.push(filter.from);
	}
	if (filter.to !== undefined) {
		clauses.push("t.started_at <= ?");
		params.push(filter.to);
	}
	return { where: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "", params };
}
