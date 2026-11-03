/**
 * SQLite 持久化层（使用 Node 内置 node:sqlite，零第三方依赖）。
 *
 * 存储策略：一张 sessions 表，元数据做成可查询的列，
 * 完整会话（对话记录 / 审计 / 流程状态 / 业务数据 / agent 上下文）序列化成 payload JSON。
 * 这样既可以用 SQL 按时间、流程过滤，又不用维护六张关联表。
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AuditEntry, WorkflowState } from "../src/core/types.js";
import type { Store } from "../src/store/memory.js";

export interface TranscriptEntry {
	role: "user" | "assistant";
	text: string;
	at: number;
}

export interface PersistedSession {
	id: string;
	workflowId: string;
	modelId: string | null;
	mode: "live" | "simulated";
	modeLabel: string;
	permissionMode: "full" | "readonly";
	createdAt: number;
	updatedAt: number;
	done: boolean;
	transcript: TranscriptEntry[];
	audit: AuditEntry[];
	workflow: WorkflowState;
	store: Store;
	/** Pi 的 AgentMessage[]，用于恢复模型上下文 */
	agentMessages: unknown[];
}

export class SessionDb {
	private readonly db: DatabaseSync;

	constructor(path: string) {
		mkdirSync(dirname(path), { recursive: true });
		this.db = new DatabaseSync(path);
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS sessions (
				id          TEXT PRIMARY KEY,
				workflow_id TEXT NOT NULL,
				created_at  INTEGER NOT NULL,
				updated_at  INTEGER NOT NULL,
				done        INTEGER NOT NULL DEFAULT 0,
				payload     TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions (updated_at DESC);
		`);
	}

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

	close(): void {
		this.db.close();
	}
}
