/**
 * P9 监控与可观测自检（**不需要起服务**）：`npm run obs:selftest`
 *
 * 覆盖五块：
 *   1. 纯函数：trace_id 格式/唯一性、token 估算、p95、range 解析、参数摘要
 *   2. 采集器：入队 / 批量 flush / 顺序 / 结束状态 / 写入失败重试与丢弃计数
 *   3. 聚合：range 过滤、工具成功率与均值、技能/MCP/模型分组、errors、p95、会话活跃数
 *   4. DAO 往返：traces 列表/详情/分页/会话过滤，audit_logs 的 actorType/targetType/from/to/q 过滤
 *   5. 权限矩阵：/api/monitor 的 summary / traces 映射，operator 读 traces 的 403 文案
 *
 * 纯进程内、临时 SQLite，不起服务；端到端链路看 `npm run smoke:monitor`。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PersistedSession, TraceEventInput } from "../server/db/types.js";
import { SqliteStorage } from "../server/db/sqlite.js";
import { can, denyMessage, permissionFor } from "../server/auth/roles.js";
import { createStore } from "../src/store/memory.js";
import { Observability } from "../server/observability/collector.js";
import {
	estimateTokens,
	newTraceId,
	parseRange,
	percentile,
	summarizeArgs,
	TRACE_ID_PATTERN,
} from "../server/observability/trace.js";

let passed = 0;

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
	await fn();
	passed++;
	console.log(`  ✓ ${name}`);
}

/** 临时 SQLite 库：每个用例组一份，跑完删掉。 */
function tempStore(): { dir: string; store: SqliteStorage; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "biz-agent-obs-"));
	const store = new SqliteStorage(join(dir, "obs.db"));
	return {
		dir,
		store,
		cleanup: () => {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

/** 注入写失败的 DAO：前 N 次 appendTraceEvents 抛错，用来验证"重试 1 次后丢弃并计数"。 */
class FlakyStorage extends SqliteStorage {
	appendCalls = 0;
	failAppendCount = 0;

	override appendTraceEvents(events: TraceEventInput[]): void {
		this.appendCalls += 1;
		if (this.failAppendCount > 0) {
			this.failAppendCount -= 1;
			throw new Error("注入的写入失败");
		}
		super.appendTraceEvents(events);
	}
}

/** 造一条最小可用会话记录（只需满足 payload 序列化，监控只读 id / updated_at / created_by）。 */
function fakeSession(id: string, updatedAt: number, createdBy: string | null): PersistedSession {
	return {
		id,
		workflowId: "auto-flow",
		modelId: null,
		mode: "simulated",
		modeLabel: "模拟模型",
		permissionMode: "full",
		title: null,
		archived: false,
		createdAt: updatedAt,
		updatedAt,
		done: false,
		transcript: [],
		audit: [],
		workflow: { workflowId: "auto-flow", stepIndex: 0, completed: [], calls: [] },
		store: createStore(),
		agentMessages: [],
		activeSkillId: null,
		createdBy,
		traceIds: [],
	};
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** 固定基准时间：测试里的时间窗都以它为参照，避免跟真实时钟抖动绑在一起。 */
const BASE = 1_700_000_000_000;

async function testPure(): Promise<void> {
	console.log("\n[1] 纯函数");

	await check("trace_id 是 tr_ + 12 位 base36，且 500 条不重复", () => {
		const ids = new Set<string>();
		for (let index = 0; index < 500; index += 1) {
			const id = newTraceId();
			assert.match(id, TRACE_ID_PATTERN, `格式不对: ${id}`);
			ids.add(id);
		}
		assert.equal(ids.size, 500, "trace_id 出现重复");
	});

	await check("token 估算：中文按字、英文按 4 字符 ≈ 1 token，空串为 0", () => {
		assert.equal(estimateTokens(""), 0);
		assert.equal(estimateTokens("你好世界"), 4);
		assert.equal(estimateTokens("abcdefgh"), 2);
		assert.equal(estimateTokens("字a字b"), 2 + 1);
		assert.equal(estimateTokens("  \n\t"), 0);
	});

	await check("p95 最近秩计算：空数组 0、单值原样、1..100 取 95", () => {
		assert.equal(percentile([], 95), 0);
		assert.equal(percentile([42], 95), 42);
		assert.equal(percentile(Array.from({ length: 100 }, (_, index) => index + 1), 95), 95);
		const values = [900, 100, 300, 200];
		assert.equal(percentile(values, 95), 900, "p95 必须是原数组里的值");
		assert.equal(percentile(values, 50), 200);
	});

	await check("range 解析：默认 24h，1h/7d/30m 合法，写错返回 null", () => {
		assert.deepEqual(parseRange(null), { value: "24h", ms: DAY });
		assert.deepEqual(parseRange("1h"), { value: "1h", ms: HOUR });
		assert.deepEqual(parseRange("7d"), { value: "7d", ms: 7 * DAY });
		assert.deepEqual(parseRange("30m"), { value: "30m", ms: 30 * MINUTE });
		assert.deepEqual(parseRange(" 1H "), { value: "1h", ms: HOUR });
		assert.equal(parseRange("abc"), null);
		assert.equal(parseRange("0h"), null);
		assert.equal(parseRange("-1h"), null);
	});

	await check("参数摘要截断到 200 字以内，循环引用不抛错", () => {
		const long = summarizeArgs({ text: "x".repeat(500) });
		assert.ok(long.length <= 201, `摘要过长: ${long.length}`);
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		assert.equal(typeof summarizeArgs(cyclic), "string", "循环引用也要给出字符串而不是抛错");
	});
}

async function testCollector(): Promise<void> {
	console.log("\n[2] 采集器：入队 / 批量 flush / 重试与丢弃");

	const temp = tempStore();
	const clock = { value: BASE };
	const obs = new Observability({
		storage: temp.store,
		autoStart: false,
		now: () => clock.value,
		onLog: () => undefined,
	});
	let traceId = "";
	try {
		await check("begin 只入内存、不落库（写入不阻塞主流程）", () => {
			traceId = obs.begin({ sessionId: "session-1", workflowId: "ticket-flow" });
			assert.match(traceId, TRACE_ID_PATTERN);
			assert.equal(obs.queueSize, 0);
			assert.equal(temp.store.getTrace(traceId), undefined, "flush 之前库里不该有 trace");
		});

		await check("一次 flush 批量写 1 条 trace + 5 条事件（顺序与 payload 往返）", () => {
			obs.record(traceId, { kind: "llm", name: "m1", ms: 500, ok: true, payload: { totalTokens: 42 } });
			obs.record(traceId, {
				kind: "tool",
				name: "ticket_search",
				ok: true,
				ms: 100,
				payload: { args: '{"id":"TK-1"}' },
			});
			obs.record(traceId, { kind: "skill", name: "data-flow", ok: true, payload: { action: "load" } });
			obs.record(traceId, { kind: "mcp", name: "crm", ok: false, ms: 30, payload: { tool: "mcp_crm_x" } });
			obs.record(traceId, { kind: "approval", name: "ticket_refund", ok: true, ms: 1200, payload: { approved: true } });
			assert.equal(obs.queueSize, 5, "5 条事件应都在内存队列里");

			const flushed = obs.flush();
			assert.deepEqual(flushed, { traces: 1, events: 5, dropped: 0 }, "一次 flush 写 1 条 trace + 5 条事件");
			assert.equal(obs.queueSize, 0, "flush 后队列清空");

			const events = temp.store.listTraceEvents(traceId);
			assert.deepEqual(events.map((event) => event.seq), [1, 2, 3, 4, 5], "事件按 seq 升序");
			assert.deepEqual(events.map((event) => event.kind), ["llm", "tool", "skill", "mcp", "approval"]);
			assert.deepEqual(events[1]!.payload, { args: '{"id":"TK-1"}' }, "payload 往返保持对象");
			assert.equal(events[3]!.ok, false);
			assert.equal(events[3]!.ms, 30);
		});

		await check("finish 落库：status / finishedAt / model / toolCount 都对", () => {
			clock.value = BASE + 2_500;
			obs.finish(traceId, "ok");
			obs.flush();
			const trace = temp.store.getTrace(traceId);
			assert.equal(trace?.status, "ok");
			assert.equal(trace?.finishedAt, BASE + 2_500);
			assert.equal(trace?.toolCount, 1, "toolCount 由事件派生");
			assert.equal(trace?.model, "m1", "model 取第一条 llm 事件的 name");
		});

		await check("写入失败重试 1 次就成功：不丢弃", () => {
			const flaky = new FlakyStorage(join(temp.dir, "flaky-retry.db"));
			flaky.failAppendCount = 1;
			const retryObs = new Observability({ storage: flaky, autoStart: false, onLog: () => undefined });
			try {
				const retryId = retryObs.begin({});
				retryObs.record(retryId, { kind: "tool", name: "a", ok: true, ms: 1 });
				retryObs.record(retryId, { kind: "tool", name: "b", ok: true, ms: 2 });
				const result = retryObs.flush();
				assert.equal(result.events, 2, "第一次失败、重试成功应写进 2 条");
				assert.equal(flaky.appendCalls, 2, "appendTraceEvents 应被调用 2 次（首失败 + 重试）");
				assert.equal(retryObs.droppedCount, 0);
				assert.equal(flaky.listTraceEvents(retryId).length, 2);
			} finally {
				flaky.close();
			}
		});

		await check("连续失败 2 次：整批丢弃并计数", () => {
			const dropStore = new FlakyStorage(join(temp.dir, "flaky-drop.db"));
			dropStore.failAppendCount = 2;
			const dropObs = new Observability({ storage: dropStore, autoStart: false, onLog: () => undefined });
			try {
				const dropId = dropObs.begin({});
				dropObs.record(dropId, { kind: "tool", name: "a", ok: true, ms: 1 });
				dropObs.record(dropId, { kind: "tool", name: "b", ok: false, ms: 2 });
				const result = dropObs.flush();
				assert.equal(result.events, 0, "两次都失败 → 本批 0 条写入");
				assert.equal(dropObs.droppedEventCount, 2, "丢弃计数 = 本批事件数");
				assert.equal(dropObs.droppedCount, 2);
				assert.equal(dropStore.listTraceEvents(dropId).length, 0, "丢弃后库里不应有事件");
			} finally {
				dropStore.close();
			}
		});

		await check("DAO 列表：倒序、sessionId 过滤、分页、未知 id 返回 undefined", () => {
			clock.value = BASE - HOUR;
			const older = obs.begin({ sessionId: "session-9" });
			obs.record(older, { kind: "tool", name: "old", ok: true, ms: 5 });
			obs.finish(older, "ok");
			obs.flush();
			const listed = temp.store.listTraces({ limit: 50, offset: 0 });
			assert.ok(listed.length >= 2);
			assert.ok(listed[0]!.startedAt >= listed[1]!.startedAt, "列表按 startedAt 倒序");
			const onlySession9 = temp.store.listTraces({ limit: 50, offset: 0, sessionId: "session-9" });
			assert.equal(onlySession9.length, 1);
			assert.equal(onlySession9[0]!.id, older);
			assert.equal(temp.store.countTraces({ sessionId: "session-9" }), 1);
			const paged = temp.store.listTraces({ limit: 1, offset: 1 });
			assert.equal(paged.length, 1);
			assert.equal(temp.store.getTrace("tr_nonexistent00"), undefined);
		});
	} finally {
		obs.close();
		temp.cleanup();
	}
}

async function testSummary(): Promise<void> {
	console.log("\n[3] 聚合：range / 工具成功率 / 技能 / MCP / 模型 / p95 / 活跃会话");

	const temp = tempStore();
	const clock = { value: BASE };
	const obs = new Observability({ storage: temp.store, autoStart: false, now: () => clock.value, onLog: () => undefined });
	const hourAgo = (offset: number): number => BASE - offset;

	interface Fixture {
		traceId: string;
		startedAt: number;
		events: { kind: "llm" | "tool" | "skill" | "mcp"; name: string; ok?: boolean; ms?: number }[];
		sessionId: string;
		status?: "ok" | "error";
	}

	const fixtures: Fixture[] = [
		{
			traceId: "",
			startedAt: hourAgo(2 * HOUR),
			sessionId: "s-1",
			status: "error",
			events: [
				{ kind: "llm", name: "m1", ms: 500 },
				{ kind: "tool", name: "t1", ok: true, ms: 100 },
				{ kind: "tool", name: "t2", ok: false, ms: 300 },
				{ kind: "skill", name: "data-flow", ok: true },
				{ kind: "mcp", name: "crm", ok: true, ms: 10 },
			],
		},
		{
			traceId: "",
			startedAt: hourAgo(30 * MINUTE),
			sessionId: "s-2",
			events: [
				{ kind: "llm", name: "m1", ms: 150 },
				{ kind: "tool", name: "t1", ok: true, ms: 200 },
				{ kind: "mcp", name: "crm", ok: false, ms: 20 },
			],
		},
		{
			traceId: "",
			startedAt: hourAgo(3 * DAY),
			sessionId: "s-1",
			events: [
				{ kind: "llm", name: "m2", ms: 400 },
				{ kind: "tool", name: "t3", ok: true, ms: 900 },
			],
		},
	];

	try {
		// 会话：一个 24h 内活跃、一个 3 天前
		temp.store.save(fakeSession("s-1", BASE - HOUR, "user-dev"));
		temp.store.save(fakeSession("s-2", BASE - 3 * DAY, "user-other"));

		for (const fixture of fixtures) {
			clock.value = fixture.startedAt;
			fixture.traceId = obs.begin({ sessionId: fixture.sessionId });
			for (const event of fixture.events) {
				obs.record(fixture.traceId, {
					kind: event.kind,
					name: event.name,
					ok: event.ok ?? true,
					ms: event.ms ?? 0,
					payload: null,
				});
			}
			clock.value = fixture.startedAt + 1_000;
			obs.finish(fixture.traceId, fixture.status ?? "ok", fixture.status === "error" ? "模型调用失败" : null);
		}

		clock.value = BASE;
		const oneHour = obs.summary("1h");
		const sevenDays = obs.summary("7d");

		await check("range=1h 只统计 30 分钟前那条（旧调用链被排除）", () => {
			assert.equal(oneHour.messages24h, 1, "1h 窗口只有 30 分钟前那条");
			assert.equal(oneHour.toolCalls.total, 1);
			assert.equal(oneHour.toolCalls.ok, 1);
			assert.equal(oneHour.toolCalls.failed, 0);
			assert.equal(oneHour.toolCalls.avgMs, 200);
			assert.equal(oneHour.p95Ms, 200);
			assert.equal(oneHour.errors, 0);
		});

		await check("range=7d 工具成功率 / 均值 / p95 / errors 正确", () => {
			assert.equal(sevenDays.messages24h, 3, "7d 窗口包含三条调用链");
			assert.equal(sevenDays.toolCalls.total, 4);
			assert.equal(sevenDays.toolCalls.ok, 3);
			assert.equal(sevenDays.toolCalls.failed, 1);
			assert.equal(sevenDays.toolCalls.avgMs, 375, "工具平均耗时 (100+300+200+900)/4");
			assert.equal(sevenDays.p95Ms, 900);
			assert.equal(sevenDays.errors, 1, "status=error 的调用链计入 errors");
			assert.ok(sevenDays.toolCalls.total > oneHour.toolCalls.total, "range=1h 与 range=7d 的数值必须不同");
		});

		await check("技能 / MCP / 模型按事件分组：调用次数与失败数", () => {
			assert.deepEqual(sevenDays.skills, [{ id: "data-flow", calls: 1 }]);
			assert.deepEqual(sevenDays.mcp, [{ server: "crm", calls: 2, failed: 1 }]);
			assert.deepEqual(sevenDays.model, [
				{ model: "m1", calls: 2, avgMs: 325 },
				{ model: "m2", calls: 1, avgMs: 400 },
			]);
		});

		await check("sessions.total / active24h 固定 24h，不随 range 变化", () => {
			assert.equal(sevenDays.sessions.total, 2);
			assert.equal(sevenDays.sessions.active24h, 1);
			assert.equal(oneHour.sessions.active24h, 1, "active24h 不随 range 变化");
		});
	} finally {
		obs.close();
		temp.cleanup();
	}
}

async function testAuditFilters(): Promise<void> {
	console.log("\n[4] 审计查询增强：actorType / targetType / from / to / q");

	const temp = tempStore();
	try {
		const rows = [
			{
				actorType: "user",
				actorId: "u-1",
				action: "session.create",
				targetType: "session",
				targetId: "s-1",
				createdAt: BASE - 3 * DAY,
			},
			{
				actorType: "user",
				actorId: "u-1",
				action: "workflow.update",
				targetType: "workflow",
				targetId: "flow-9",
				createdAt: BASE - 2 * HOUR,
			},
			{
				actorType: "anonymous",
				actorId: null,
				action: "auth.login.failed",
				targetType: null,
				targetId: null,
				createdAt: BASE - HOUR,
			},
			{
				actorType: "system",
				actorId: null,
				action: "session.delete",
				targetType: "session",
				targetId: "s-9",
				createdAt: BASE - 10 * MINUTE,
			},
		] as const;
		for (const row of rows) {
			temp.store.appendAudit({
				workspaceId: "default",
				actorType: row.actorType,
				actorId: row.actorId,
				action: row.action,
				targetType: row.targetType,
				targetId: row.targetId,
				detail: { seeded: true },
				createdAt: row.createdAt,
			});
		}

		await check("actorType + targetType 组合过滤（同时命中才返回）", () => {
			const items = temp.store.listAudit({ limit: 50, offset: 0, actorType: "user", targetType: "session" });
			assert.equal(items.length, 1);
			assert.equal(items[0]!.action, "session.create");
			assert.equal(temp.store.countAudit({ actorType: "user", targetType: "session" }), 1);
			assert.equal(temp.store.listAudit({ limit: 50, offset: 0, actorType: "user" }).length, 2);
		});

		await check("q 模糊匹配 action / targetType / targetId（大小写不敏感）", () => {
			const byAction = temp.store.listAudit({ limit: 50, offset: 0, q: "session" });
			assert.equal(byAction.length, 2, "session.create 与 session.delete");
			const upper = temp.store.listAudit({ limit: 50, offset: 0, q: "WORKFLOW" });
			assert.equal(upper.length, 1, "SQLite LIKE 对 ASCII 大小写不敏感");
			const byTarget = temp.store.listAudit({ limit: 50, offset: 0, q: "flow-9" });
			assert.equal(byTarget.length, 1);
			assert.equal(byTarget[0]!.targetType, "workflow");
		});

		await check("from / to 时间窗过滤（含边界）", () => {
			const items = temp.store.listAudit({
				limit: 50,
				offset: 0,
				from: BASE - 2 * HOUR,
				to: BASE - 11 * MINUTE,
			});
			assert.deepEqual(
				items.map((item) => item.action),
				["auth.login.failed", "workflow.update"],
				"窗口内按时间倒序",
			);
			assert.equal(temp.store.countAudit({ from: BASE - HOUR }), 2);
		});

		await check("多条件组合与 count 一致（分页只影响 items）", () => {
			const filter = { actorType: "user", from: BASE - 3 * DAY, to: BASE - HOUR, q: "s" };
			const items = temp.store.listAudit({ limit: 50, offset: 0, ...filter });
			const total = temp.store.countAudit(filter);
			assert.equal(items.length, total);
			assert.ok(total >= 1);
			const page = temp.store.listAudit({ limit: 1, offset: 1, ...filter });
			assert.ok(page.length <= 1);
		});

		await check("q 里的 % 与 _ 按字面量处理（不是通配符）", () => {
			temp.store.appendAudit({
				workspaceId: "default",
				actorType: "user",
				actorId: "u-2",
				action: "rate%limit_test",
				targetType: "session",
				targetId: "s-100",
				createdAt: BASE,
			});
			const percent = temp.store.listAudit({ limit: 50, offset: 0, q: "rate%" });
			assert.equal(percent.length, 1, "q=rate% 只能命中含字面量 % 的那条");
			const underscore = temp.store.listAudit({ limit: 50, offset: 0, q: "limit_test" });
			assert.equal(underscore.length, 1);
			assert.equal(temp.store.listAudit({ limit: 50, offset: 0, q: "rate_" }).length, 0, "_ 不能当通配符");
		});
	} finally {
		temp.cleanup();
	}
}

async function testPermissions(): Promise<void> {
	console.log("\n[5] 权限矩阵：summary 只读摘要，traces 走审计权限");

	await check("/api/monitor 映射：summary → session.read，traces → audit.read", () => {
		assert.equal(permissionFor("GET", "/api/monitor/summary"), "session.read");
		assert.equal(permissionFor("GET", "/api/monitor/traces"), "audit.read");
		assert.equal(permissionFor("GET", "/api/monitor/traces/tr_abcdefghijkl"), "audit.read");
		assert.equal(permissionFor("GET", "/api/monitor"), "audit.read");
	});

	await check("operator 只能读 summary（有 session.read、没有 audit.read），403 文案中文", () => {
		assert.equal(can("operator", "session.read"), true);
		assert.equal(can("operator", "audit.read"), false);
		assert.equal(can("developer", "audit.read"), true);
		assert.equal(can("auditor", "audit.read"), true);
		assert.equal(can("owner", "audit.read"), true);
		const message = denyMessage("operator", "audit.read");
		assert.ok(message.includes("运营"), `403 文案应带角色名: ${message}`);
		assert.ok(message.includes("审计"), `403 文案应说明不能看审计: ${message}`);
	});
}

async function testRetention(): Promise<void> {
	console.log("\n[4] 保留期清理");

	const temp = tempStore();
	const clock = { value: BASE };
	const obs = new Observability({
		storage: temp.store,
		autoStart: false,
		now: () => clock.value,
		retentionDays: 30,
		onLog: () => undefined,
	});
	try {
		clock.value = BASE - 40 * DAY;
		const oldId = obs.begin({ sessionId: "s-old" });
		obs.record(oldId, { kind: "tool", name: "old", ok: true, ms: 5 });
		obs.finish(oldId, "ok");
		obs.flush();
		clock.value = BASE - DAY;
		const newId = obs.begin({ sessionId: "s-new" });
		obs.record(newId, { kind: "tool", name: "new", ok: true, ms: 5 });
		obs.finish(newId, "ok");
		obs.flush();

		await check("purgeExpired 只删超过保留期的 trace 与事件，新数据保留", () => {
			const removed = obs.purgeExpired(BASE);
			assert.equal(removed.traces, 1);
			assert.equal(removed.events, 1);
			assert.equal(temp.store.getTrace(oldId), undefined, "旧 trace 应被删");
			assert.equal(temp.store.listTraceEvents(oldId).length, 0, "旧事件应一起删");
			assert.ok(temp.store.getTrace(newId), "新 trace 必须保留");
			assert.equal(temp.store.listTraceEvents(newId).length, 1);
		});

		await check("retentionDays=0 关闭清理（不动任何数据）", () => {
			const off = new Observability({ storage: temp.store, autoStart: false, now: () => clock.value, retentionDays: 0, onLog: () => undefined });
			try {
				assert.deepEqual(off.purgeExpired(BASE + 1000 * DAY), { traces: 0, events: 0 });
				assert.ok(temp.store.getTrace(newId), "关闭清理后数据仍在");
			} finally {
				off.close();
			}
		});
	} finally {
		obs.close();
		temp.cleanup();
	}
}

async function main(): Promise<void> {
	console.log("P9 监控与可观测自检（纯进程内，不起服务）");
	await testPure();
	await testCollector();
	await testSummary();
	await testRetention();
	await testAuditFilters();
	await testPermissions();
	console.log(`\n全部通过：${passed} 项检查`);
}

await main();
