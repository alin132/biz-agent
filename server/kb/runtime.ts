/**
 * 知识库模块的进程内单例。
 *
 * 为什么不把单例塞进 `routes.ts`：`initKb()` 要在服务启动时主动建好表（而不是等第一个请求），
 * 而路由模块只该负责 HTTP 解析。`handleKb` 里再兜一次懒加载，防止宿主忘了调 `initKb()`
 * 时整个知识库模块报 500。
 */

import { createKbService } from "./service.js";
import type { KbService } from "./service.js";
import { createKbStore } from "./store.js";

let current: KbService | null = null;

export interface InitKbOptions {
	/** 库文件路径；不传按 `DB_PATH` → 仓库默认位置（与宿主同一套语义） */
	dbPath?: string | null;
}

/**
 * 建表 + 建单例。幂等：重复调用直接返回同一个实例。
 * 只做 SQLite：配了 `DATABASE_URL` 时打一条警告，知识库仍落在本地库文件里（PG/pgvector 留到下一轮）。
 */
export function initKb(options: InitKbOptions = {}): KbService {
	if (current) {
		return current;
	}
	const store = createKbStore(options.dbPath ? { path: options.dbPath } : {});
	current = createKbService({ store });
	if ((process.env.DATABASE_URL ?? "").trim().length > 0) {
		console.warn("[kb] 知识库这一轮只支持 SQLite：表建在 DB_PATH 指定的库文件里（Postgres/pgvector 检索尚未接入）");
	}
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
