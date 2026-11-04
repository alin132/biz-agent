/**
 * schema 迁移：`db/migrations/*.sql` 按文件名顺序执行，执行过的记进 `schema_migrations`。
 *
 * 只服务 Postgres（pgvector / gin 索引这些是 PG 方言）；SQLite 的表结构仍然内建在
 * `sqlite.ts` 里，老库缺列靠 `PRAGMA table_info` + `ALTER TABLE` 自愈（AGENTS 坑 19），
 * 所以 SQLite 的 `migrations()` 返回空数组。
 *
 * 单个迁移文件整体在一个事务里：要么全部生效并记账，要么回滚，不留半截 schema。
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MigrationRecord } from "./types.js";

export interface Migration {
	/** 版本号 = 文件名数字前缀，例如 `0001` */
	version: string;
	/** 迁移名 = 前缀之后的文件名（下划线转空格），例如 `init` */
	name: string;
	sql: string;
}

/** 仓库根的 `db/migrations/`；迁移文件是数据不是代码，所以放在仓库根而不是 server 下。 */
const MIGRATIONS_DIR = fileURLToPath(new URL("../../db/migrations/", import.meta.url));

/** 迁移账本；两种后端都用同一份结构，runner 启动前先确保它存在。 */
export const SCHEMA_MIGRATIONS_DDL = `CREATE TABLE IF NOT EXISTS schema_migrations (
	version    TEXT PRIMARY KEY,
	name       TEXT NOT NULL,
	applied_at BIGINT NOT NULL
)`;

/**
 * 迁移执行目标：两种后端各自实现"事务 + 记账"的细节，runner 只管顺序与幂等。
 * （PG 走工作线程的一个事务消息；SQLite 用 BEGIN/COMMIT 包住 exec。）
 */
export interface MigrationTarget {
	/** 已应用的版本，按版本号升序。 */
	applied(): MigrationRecord[];
	/** 在单个事务里执行这份迁移的 SQL，并把它记进 schema_migrations。 */
	apply(migration: Migration): void;
}

/** 读 `db/migrations/` 下的迁移文件，按数字前缀排序（`0100` 之后也能正确排）。 */
export function loadMigrations(dir = MIGRATIONS_DIR): Migration[] {
	const files = readdirSync(dir)
		.filter((file) => file.endsWith(".sql"))
		.sort();
	return files.map((file) => {
		const match = /^(\d+)_(.+)\.sql$/.exec(file);
		if (!match) {
			throw new Error(`迁移文件名不规范（要「0001_init.sql」这种数字前缀 + 下划线）：${file}`);
		}
		return {
			version: match[1]!,
			name: match[2]!.replace(/_/g, " "),
			sql: readFileSync(join(dir, file), "utf8"),
		};
	});
}

export interface MigrationRun {
	/** 本次真正执行了的迁移（空数组 = 已经是最新） */
	justApplied: Migration[];
	/** 执行完之后账本里的全部版本 */
	applied: MigrationRecord[];
}

/** 幂等：跑几次结果一样，已记账的版本直接跳过。 */
export function runMigrations(target: MigrationTarget): MigrationRun {
	const done = new Set(target.applied().map((record) => record.version));
	const justApplied = loadMigrations().filter((migration) => !done.has(migration.version));
	for (const migration of justApplied) {
		target.apply(migration);
	}
	return { justApplied, applied: target.applied() };
}
