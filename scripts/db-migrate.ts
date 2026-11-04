/**
 * 手动跑一次 schema 迁移（服务启动时本来也会自动跑，这里是显式入口，给排查/初始化空库用）。
 *
 * 用法（PowerShell）：
 *   npm run db:migrate                                              # 按 env 决定后端
 *   $env:DB_PATH="data\scratch.db"; npm run db:migrate              # 建一个空 SQLite 库并确保表结构
 *   $env:DATABASE_URL="postgres://biz:biz@127.0.0.1:5433/biz"; npm run db:migrate
 *
 * 幂等：重复跑只会打印"已是最新"，不会重复执行已记账的迁移。
 */

import { openStore } from "../server/db/index.js";
import { loadEnvFile } from "../server/env.js";

function formatTime(at: number): string {
	const date = new Date(at);
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function main(): void {
	loadEnvFile();
	const store = openStore();
	try {
		const info = store.info();
		console.log(`存储后端: ${info.kind === "postgres" ? "Postgres" : "SQLite"}（${info.detail}）`);

		const applied = store.migrations();
		if (info.kind === "sqlite") {
			// SQLite 的表结构内建在 server/db/sqlite.ts，老库缺列靠 PRAGMA + ALTER TABLE 自愈
			console.log("SQL 迁移: 无（SQLite 表结构内建，启动时自动建表并补齐缺失列）");
		} else if (applied.length === 0) {
			console.log("SQL 迁移: 本次没有可执行的迁移文件（db/migrations/*.sql 为空？）");
		} else {
			console.log(`SQL 迁移: 已应用 ${applied.length} 个版本`);
			for (const record of applied) {
				console.log(`  ${record.version}  ${record.name}  @ ${formatTime(record.appliedAt)}`);
			}
		}

		const diagnostics = store.diagnostics();
		console.log(`引擎版本: ${diagnostics.version}`);
		console.log(`表(${diagnostics.tables.length}): ${diagnostics.tables.join(", ") || "（无）"}`);
		console.log(`现有数据: 会话 ${store.count()} 条 / 自定义流程 ${store.listWorkflows().length} 条`);
	} finally {
		store.close();
	}
}

try {
	main();
} catch (error) {
	console.error(`✗ 迁移失败：${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
}
