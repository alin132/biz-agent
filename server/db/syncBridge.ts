/**
 * 同步调用工作线程的桥（sync-over-async）。
 *
 * 为什么要它：`pg` 只有异步 API，而存储层契约是同步的（见 `types.ts` 顶部说明）。
 * 做法是主线程把请求 `postMessage` 给工作线程，然后 `Atomics.wait` 阻塞自己；
 * 工作线程用异步 `pg` 干完活，把结果 `postMessage` 回来并 `Atomics.notify` 唤醒主线程。
 * 主线程醒来用 `receiveMessageOnPort` 同步取消息 —— 全程没有 await，调用方感知不到。
 *
 * 已知代价（PG 后端特有，SQLite 走不到这里）：
 *  - 阻塞期间主线程的事件循环停住，其它 HTTP 请求要等这一次存储调用做完（毫秒级，单机够用）；
 *  - 工作线程起不来或卡住时只能靠超时兜底（不会静默当成成功）。
 */

import { MessageChannel, Worker, receiveMessageOnPort } from "node:worker_threads";
import type { MessagePort } from "node:worker_threads";

/** 普通查询超时：超过就当作后端失联，不无限等。 */
const DEFAULT_TIMEOUT_MS = 30_000;
/** init（建连 + 探测）超时；比查询宽松一点，给首次连库留时间。 */
const INIT_TIMEOUT_MS = 20_000;
/** 关闭时等 pool.end() 的时间，等不到就直接 terminate。 */
const CLOSE_TIMEOUT_MS = 5_000;

export interface BridgeTransactionStep {
	sql: string;
	params?: unknown[];
}

/** 主线程 → 工作线程的请求（`id` 由桥自己加）。 */
export type BridgeRequest =
	| { kind: "init"; url: string }
	| { kind: "query"; sql: string; params?: unknown[] }
	| { kind: "transaction"; steps: BridgeTransactionStep[] }
	| { kind: "close" };

export interface BridgeResult {
	rows: Record<string, unknown>[];
	rowCount: number;
}

interface BridgeReply {
	id: number;
	ok: boolean;
	result?: BridgeResult;
	error?: string;
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class SyncWorkerBridge {
	private readonly worker: Worker;
	private readonly port: MessagePort;
	private readonly flag: Int32Array;
	private sequence = 0;
	/** 工作线程抛过的致命错误（例如 `pg` 装不上、DATABASE_URL 解析炸了）；有值就不再发请求。 */
	private fatal: string | null = null;
	private closed = false;

	/**
	 * @param workerUrl 工作线程入口（本仓库是 `.ts`，靠 tsx 的 loader 直接跑）
	 */
	constructor(workerUrl: URL) {
		const { port1, port2 } = new MessageChannel();
		const shared = new SharedArrayBuffer(4);
		this.flag = new Int32Array(shared);
		this.port = port1;

		// 仓库没有构建步骤，工作线程入口也是 TS：tsx 会把 loader 挂在父进程 execArgv 上，
		// 工作线程默认继承；万一父进程不是 tsx 起的（例如将来编译成 js 再跑），这里补一条。
		const execArgv = process.execArgv.some((arg) => arg.includes("tsx"))
			? process.execArgv
			: ["--import", "tsx"];

		this.worker = new Worker(workerUrl, {
			workerData: { port: port2, shared },
			transferList: [port2],
			execArgv,
		});
		this.worker.on("error", (error) => {
			this.fatal = describeError(error);
		});
		// 不阻止主进程退出：真正需要拦住退出的是 HTTP server，不是这条后台线程
		this.worker.unref();
		this.port.unref();
	}

	/** 建连 + 自检；失败就抛（让 openStore 在启动阶段就报错，而不是第一次落库才发现连不上）。 */
	init(url: string): void {
		this.request({ kind: "init", url }, INIT_TIMEOUT_MS);
	}

	query(sql: string, params: unknown[] = []): BridgeResult {
		return this.request({ kind: "query", sql, params });
	}

	/** 一组语句放在同一个事务里执行（迁移用：schema 与记账要么一起成功要么一起回滚）。 */
	transaction(steps: BridgeTransactionStep[]): BridgeResult {
		return this.request({ kind: "transaction", steps });
	}

	close(): void {
		if (!this.closed) {
			this.closed = true;
			try {
				this.send({ kind: "close" }, CLOSE_TIMEOUT_MS);
			} catch {
				// 关不掉就算了（进程本来就要退），下面直接 terminate
			}
		}
		this.port.close();
		void this.worker.terminate();
	}

	private request(request: BridgeRequest, timeoutMs = DEFAULT_TIMEOUT_MS): BridgeResult {
		if (this.closed) {
			throw new Error("存储工作线程已关闭");
		}
		if (this.fatal) {
			throw new Error(`存储工作线程已崩溃：${this.fatal}`);
		}
		return this.send(request, timeoutMs);
	}

	private send(request: BridgeRequest, timeoutMs: number): BridgeResult {
		const id = ++this.sequence;
		Atomics.store(this.flag, 0, 0);
		this.port.postMessage({ id, ...request });

		const status = Atomics.wait(this.flag, 0, 0, timeoutMs);
		if (status === "timed-out") {
			// 卡住的线程没救了：标记关闭，避免后续调用继续等
			this.closed = true;
			void this.worker.terminate();
			throw new Error(
				`存储后端 ${timeoutMs}ms 内没有响应${this.fatal ? `（${this.fatal}）` : ""}；` +
					"请检查 DATABASE_URL 与 Postgres 是否可达（docker compose up -d）",
			);
		}

		const envelope = receiveMessageOnPort(this.port) as { message?: BridgeReply } | undefined;
		const reply = envelope?.message;
		if (!reply || reply.id !== id) {
			// 理论上不会发生（一次只有一个在飞），真发生了说明协议乱了，不能假装成功
			throw new Error("存储工作线程的回复丢失或错位");
		}
		if (!reply.ok) {
			throw new Error(reply.error ?? "存储工作线程返回了未知错误");
		}
		return reply.result ?? { rows: [], rowCount: 0 };
	}
}
