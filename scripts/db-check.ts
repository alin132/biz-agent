/**
 * 存储自检：连库、打印后端类型 / 引擎版本 / 表清单 / 数据量 / 已应用迁移。
 *
 * 两种后端走同一份代码，靠 env 切换：
 *   npm run db:check                                              # 默认 SQLite（data/biz-agent.db）
 *   $env:DB_PATH="data\scratch.db"; npm run db:check              # 指定 SQLite 库
 *   $env:DATABASE_URL="postgres://biz:biz@127.0.0.1:5433/biz"; npm run db:check
 *
 * 只读：不动数据（openStore 会确保 schema 就绪，但不会写业务数据）。
 */

import { openStore } from "../server/db/index.js";
import { loadEnvFile } from "../server/env.js";

function main(): void {
	loadEnvFile();
	const store = openStore();
	try {
		const info = store.info();
		const diagnostics = store.diagnostics();
		console.log("【存储后端】");
		console.log(`  类型: ${info.kind}`);
		console.log(`  位置: ${info.detail}`);
		console.log(`  引擎: ${diagnostics.version}`);
		console.log(`  表(${diagnostics.tables.length}): ${diagnostics.tables.join(", ") || "（无）"}`);

		console.log("【schema 迁移】");
		const applied = store.migrations();
		if (info.kind === "sqlite") {
			console.log("  无 SQL 迁移文件（SQLite 表结构内建，老库靠 PRAGMA + ALTER TABLE 自愈）");
		} else if (applied.length === 0) {
			console.log("  （无）");
		} else {
			for (const record of applied) {
				console.log(`  ${record.version}  ${record.name}`);
			}
		}

		console.log("【数据量】");
		console.log(`  会话: ${store.count()}`);
		console.log(`  自定义流程: ${store.listWorkflows().length}`);
	} finally {
		store.close();
	}
}

try {
	main();
} catch (error) {
	console.error(`✗ 存储自检失败：${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
}
