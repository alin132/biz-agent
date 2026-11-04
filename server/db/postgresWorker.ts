/**
 * Postgres 工作线程：**只有这里**才用异步驱动（`pg`）。
 *
 * 主线程（`SyncWorkerBridge`）把请求 postMessage 过来 —— 这里异步执行 —— 把结果 postMessage 回去，
 * 再用 `Atomics.notify` 唤醒被 `Atomics.wait` 阻塞的主线程。这样存储层对外仍然是同步签名。
 *
 * 协议（主线程 → 这里）：`{ id, kind, ... }`
 *   init        { url }                          建连池 + SELECT 1 探活
 *   query       { sql, params? }                 单条/多条 SQL
 *   transaction { steps: [{ sql, params? }] }    同一连接同一事务里顺序执行
 *   close       {}                               关池
 * 回复：`{ id, ok: true, result? }` 或 `{ id, ok: false, error }` —— 任何异常都要回包，
 * 否则主线程只能撞超时（超时信息远不如真实错误有用）。
 */

import { workerData } from "node:worker_threads";
import type { MessagePort } from "node:worker_threads";
import { Pool } from "pg";
import type { QueryResult, QueryResultRow } from "pg";

interface WorkerInitData {
	port: MessagePort;
	/** 主线程那边的 Int32Array(1) 视图；0 = 等待中，1 = 有回复 */
	shared: SharedArrayBuffer;
}

interface BridgeRequestMessage {
	id: number;
	kind: "init" | "query" | "transaction" | "close";
	url?: string;
	sql?: string;
	params?: unknown[];
	steps?: { sql: string; params?: unknown[] }[];
}

const { port, shared } = workerData as WorkerInitData;
const flag = new Int32Array(shared);

/** 连接池大小：单机控制台并发很低，4 条足够，也避免把本机 PG 连接数吃满。 */
const POOL_SIZE = 4;
/** 建连超时：连不上就赶紧报错，不要在主线程上挂 30 秒。 */
const CONNECT_TIMEOUT_MS = 8_000;

let pool: Pool | null = null;

function reply(id: number, payload: Record<string, unknown>): void {
	port.postMessage({ id, ...payload });
	Atomics.store(flag, 0, 1);
	Atomics.notify(flag, 0);
}

function normalize(result: QueryResult<QueryResultRow> | QueryResult<QueryResultRow>[]): {
	rows: Record<string, unknown>[];
	rowCount: number;
} {
	// 一次发多条语句（迁移文件）时 pg 返回 Result[]，取最后一条的行即可
	const last = Array.isArray(result) ? result[result.length - 1] : result;
	const rows = (last?.rows ?? []) as Record<string, unknown>[];
	return { rows, rowCount: last?.rowCount ?? rows.length };
}

/** 空参数数组要走"简单查询协议"：只有它能一次执行多条语句（迁移文件靠这个）。 */
async function runQuery(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> {
	if (!pool) {
		throw new Error("Postgres 连接池未初始化");
	}
	const result =
		params && params.length > 0
			? await pool.query<QueryResultRow>(sql, params as unknown[])
			: await pool.query<QueryResultRow>(sql);
	return normalize(result);
}

async function handle(message: BridgeRequestMessage): Promise<Record<string, unknown>> {
	switch (message.kind) {
		case "init": {
			const created = new Pool({
				connectionString: String(message.url ?? ""),
				max: POOL_SIZE,
				connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
				idleTimeoutMillis: 30_000,
				application_name: "biz-agent",
			});
			// 立刻探活：DATABASE_URL 写错时在启动阶段就报错，而不是第一次落库才发现
			await created.query("SELECT 1");
			pool = created;
			return { ok: true, result: { rows: [], rowCount: 0 } };
		}
		case "query": {
			const result = await runQuery(String(message.sql ?? ""), message.params);
			return { ok: true, result };
		}
		case "transaction": {
			if (!pool) {
				throw new Error("Postgres 连接池未初始化");
			}
			if (!Array.isArray(message.steps) || message.steps.length === 0) {
				throw new Error("事务里没有语句");
			}
			const client = await pool.connect();
			try {
				await client.query("BEGIN");
				for (const step of message.steps) {
					if (step.params && step.params.length > 0) {
						await client.query(step.sql, step.params);
					} else {
						await client.query(step.sql);
					}
				}
				await client.query("COMMIT");
			} catch (error) {
				await client.query("ROLLBACK").catch(() => undefined);
				throw error;
			} finally {
				client.release();
			}
			return { ok: true, result: { rows: [], rowCount: message.steps.length } };
		}
		case "close": {
			const current = pool;
			pool = null;
			await current?.end();
			return { ok: true, result: { rows: [], rowCount: 0 } };
		}
		default:
			throw new Error(`未知的存储请求类型: ${String((message as { kind?: unknown }).kind)}`);
	}
}

port.on("message", (message: BridgeRequestMessage) => {
	void (async () => {
		try {
			const payload = await handle(message);
			reply(message.id, payload);
		} catch (error) {
			reply(message.id, { ok: false, error: error instanceof Error ? error.message : String(error) });
		}
	})();
});
