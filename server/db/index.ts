/**
 * 存储层入口：`openStore()` 按环境决定后端 —— 配了 `DATABASE_URL` 走 Postgres，否则走 SQLite。
 *
 * 两种实现共用 `Storage` 契约（见 `types.ts`），所以 `server/index.ts` / `session.ts` /
 * `workflows.ts` 只认这个工厂导出的对象，不知道、也不需要知道底下是哪种库。
 *
 * 环境变量：
 *   DATABASE_URL   例如 postgres://biz:biz@127.0.0.1:5433/biz（docker compose 起的那个库）
 *   DB_PATH        SQLite 库文件路径（默认 data/biz-agent.db）
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PostgresStorage } from "./postgres.js";
import { SqliteStorage } from "./sqlite.js";
import type { Storage } from "./types.js";

export type {
	MigrationRecord,
	PersistedSession,
	Storage,
	StorageDiagnostics,
	StorageInfo,
	StorageKind,
	TranscriptEntry,
	WorkflowRow,
} from "./types.js";
export { DEFAULT_WORKSPACE_ID } from "./types.js";

/** 默认库位置：仓库根的 data/biz-agent.db（`data/` 整个被 gitignore）。 */
export const DEFAULT_DB_PATH = fileURLToPath(new URL("../../data/biz-agent.db", import.meta.url));

export interface OpenStoreOptions {
	/** 连接串；不传就看 `DATABASE_URL`，都没有就回落到 SQLite */
	databaseUrl?: string | null;
	/** SQLite 库文件路径；不传就看 `DB_PATH`，都没有就用 `DEFAULT_DB_PATH` */
	dbPath?: string;
}

/**
 * 打开存储。Postgres 分支是**同步**的：内部工作线程建连 + 跑迁移，
 * 期间主线程被 Atomics.wait 挡住，返回时 schema 已经是最新的。
 */
export function openStore(options: OpenStoreOptions = {}): Storage {
	const databaseUrl = (options.databaseUrl ?? process.env.DATABASE_URL ?? "").trim();
	if (databaseUrl.length > 0) {
		assertPostgresUrl(databaseUrl);
		return new PostgresStorage(databaseUrl);
	}
	const dbPath = resolve(options.dbPath ?? process.env.DB_PATH ?? DEFAULT_DB_PATH);
	return new SqliteStorage(dbPath);
}

/** `DATABASE_URL` 写错时给一条人话，而不是让 `pg` 抛它的内部错误。 */
function assertPostgresUrl(databaseUrl: string): void {
	if (!/^postgres(ql)?:\/\//i.test(databaseUrl)) {
		throw new Error(
			`DATABASE_URL 必须形如 postgres://用户:口令@主机:端口/库名（当前值以「${databaseUrl.slice(0, 12)}…」开头）`,
		);
	}
	try {
		new URL(databaseUrl);
	} catch {
		throw new Error("DATABASE_URL 不是合法的连接串（URL 解析失败）");
	}
}
