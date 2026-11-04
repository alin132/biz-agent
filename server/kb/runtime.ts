/**
 * 知识库模块的进程内单例。
 *
 * 为什么不把单例塞进 `routes.ts`：`initKb()` 要在服务启动时主动建好表（而不是等第一个请求），
 * 而路由模块只该负责 HTTP 解析。`handleKb` 里再兜一次懒加载，防止宿主忘了调 `initKb()`
 * 时整个知识库模块报 500。
 *
 * 后端选择与宿主存储层同一套语义：配了 `DATABASE_URL` → Postgres（pgvector 检索，表由
 * `db/migrations` 建）；否则 → SQLite（表建在 `DB_PATH` 同一个库文件里，向量存 JSON 文本）。
 */

import { createKbPgStore } from "./pgStore.js";
import { createKbService } from "./service.js";
import type { KbService } from "./service.js";
import { createKbStore } from "./store.js";

let current: KbService | null = null;

export interface InitKbOptions {
	/** 库文件路径；不传按 `DB_PATH` → 仓库默认位置（与宿主同一套语义；只在 SQLite 分支生效） */
	dbPath?: string | null;
	/** Postgres 连接串；不传就现读 `DATABASE_URL`（有值即走 pgvector 后端） */
	databaseUrl?: string | null;
}

/**
 * 建表/建单例。幂等：重复调用直接返回同一个实例。
 * SQLite 分支现场建表；Postgres 分支假设 `openStore()` 已经在这个库上跑过迁移，
 * 缺表时会在 `createKbPgStore()` 里给出「请先 npm run db:migrate」的中文错误。
 */
export function initKb(options: InitKbOptions = {}): KbService {
	if (current) {
		return current;
	}
	const databaseUrl = (options.databaseUrl ?? process.env.DATABASE_URL ?? "").trim();
	const store =
		databaseUrl.length > 0
			? createKbPgStore({ databaseUrl })
			: createKbStore(options.dbPath ? { path: options.dbPath } : {});
	// 后端如实打一条日志：迁移/备份出问题时先看这里（别在界面上假装一直是 SQLite）
	console.log(
		`[kb] 知识库存储后端：${store.info().kind}（${store.info().path}）` +
			(store.info().kind === "postgres" ? "；语义检索走 pgvector" : "；语义检索在本地算余弦（JSON 向量）"),
	);
	current = createKbService({ store });
	return current;
}

/** 取单例（没初始化就现场初始化，方便脚本与单测）。 */
export function getKb(): KbService {
	return current ?? initKb();
}

/** 关掉单例（优雅关闭 / 单测收尾）。 */
export function closeKb(): void {
	if (!current) {
		return;
	}
	try {
		current.close();
	} catch {
		// 已经关了就算了
	}
	current = null;
}
