/**
 * P9 监控与可观测端到端冒烟：`npm run smoke:monitor`
 *
 * 前置（隔离实例，别碰 4317）：
 *   PowerShell:
 *     $env:PORT="4370"; $env:AUTH_MODE="required"; $env:AUTH_BOOTSTRAP_PASSWORD="owner12345"
 *     $env:DB_PATH="$PWD\data\g27-smoke.db"; $env:LLM_DISABLE="1"; npm run dev
 *   然后：
 *     $env:SMOKE_MONITOR_BASE="http://127.0.0.1:4370"; npm run smoke:monitor
 *
 * 为什么用 AUTH_MODE=required：只有 required 实例才有四种真实角色，
 * 才能验「operator 读调用链 403 / auditor 可读 / developer 只能看自己会话」；
 * 脚本自己用 owner 令牌建 operator / auditor / developer 三个账号（同 smoke:auth 的做法）。
 *
 * 覆盖：一轮对话的 trace_id（done 负载 + SessionView.traceIds）→ summary 聚合 → 调用链列表/详情/404
 *       → 角色边界（403 中文）→ 归档/新建不影响已有数据 → range=1h vs 7d（用 SQLite 里一条 2 天前的
 *       种子调用链制造差异）→ /api/audit 的新过滤（actorType / q / from）。
 *
 * range 差异为什么要种一条旧数据：新实例刚跑出来的调用链都在 1h 内，1h 与 7d 的计数天然相同；
 * 脚本从 `/api/health` 拿到 SQLite 库路径，直接写一条 2 天前的 trace + tool 事件做时间窗夹具。
 * 仅 SQLite 支持这种夹具（默认后端）；Postgres 实例会把这一组断言标成跳过。
 */

import { DatabaseSync } from "node:sqlite";

const BASE = (process.env.SMOKE_MONITOR_BASE ?? "http://127.0.0.1:4370").replace(/\/$/, "");
const OWNER_EMAIL = process.env.SMOKE_MONITOR_OWNER_EMAIL ?? "owner@local";
const OWNER_PASSWORD = process.env.SMOKE_MONITOR_OWNER_PASSWORD ?? "owner12345";
const OPERATOR_EMAIL = process.env.SMOKE_MONITOR_OPERATOR_EMAIL ?? "obs-operator@local";
const OPERATOR_PASSWORD = process.env.SMOKE_MONITOR_OPERATOR_PASSWORD ?? "operator12345";
const AUDITOR_EMAIL = process.env.SMOKE_MONITOR_AUDITOR_EMAIL ?? "obs-auditor@local";
const AUDITOR_PASSWORD = process.env.SMOKE_MONITOR_AUDITOR_PASSWORD ?? "auditor12345";
const DEVELOPER_EMAIL = process.env.SMOKE_MONITOR_DEVELOPER_EMAIL ?? "obs-developer@local";
const DEVELOPER_PASSWORD = process.env.SMOKE_MONITOR_DEVELOPER_PASSWORD ?? "developer12345";

const TRACE_ID_PATTERN = /^tr_[0-9a-z]{12}$/;

let assertions = 0;
let skipped = 0;

function fail(message: string): never {
	console.error(`✗ ${message}`);
	process.exit(1);
}

function assert(condition: boolean, message: string): void {
	if (!condition) fail(message);
	assertions += 1;
	console.log(`  ✓ ${message}`);
}

function skip(message: string): void {
	skipped += 1;
	console.log(`  - 跳过：${message}`);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Wire {
	status: number;
	body: Record<string, unknown>;
}

async function request(method: string, path: string, options: { token?: string; body?: unknown } = {}): Promise<Wire> {
	const headers: Record<string, string> = {};
	if (options.token) {
		headers.authorization = `Bearer ${options.token}`;
	}
	if (options.body !== undefined) {
		headers["content-type"] = "application/json";
	}
	const response = await fetch(`${BASE}${path}`, {
		method,
		headers,
		body: options.body === undefined ? undefined : JSON.stringify(options.body),
	});
	const text = await response.text();
	let body: Record<string, unknown> = {};
	if (text.length > 0) {
		try {
			body = JSON.parse(text) as Record<string, unknown>;
		} catch {
			body = { raw: text };
		}
	}
	return { status: response.status, body };
}

async function login(email: string, password: string): Promise<string> {
	const response = await request("POST", "/api/auth/login", { body: { email, password } });
	if (response.status !== 200 || typeof response.body.token !== "string") {
		fail(
			`登录失败（${email} / ${response.status} ${JSON.stringify(response.body)}）。` +
				"请按脚本头部注释用 AUTH_MODE=required + AUTH_BOOTSTRAP_PASSWORD 起实例。",
		);
	}
	return response.body.token as string;
}

async function ensureUser(token: string, email: string, password: string, role: string): Promise<void> {
	const response = await request("POST", "/api/auth/users", { token, body: { email, password, role } });
	if (response.status === 201 || response.status === 409) {
		return;
	}
	fail(`建成员失败（${email} / ${response.status} ${JSON.stringify(response.body)}）`);
}

interface StreamHandle {
	events: Record<string, unknown>[];
	waitFor: (predicate: (event: Record<string, unknown>) => boolean, timeoutMs?: number) => Promise<Record<string, unknown>>;
	close: () => void;
}

async function openStream(sessionId: string, token: string): Promise<StreamHandle> {
	const response = await fetch(`${BASE}/api/sessions/${sessionId}/events`, {
		headers: { authorization: `Bearer ${token}` },
	});
	if (!response.ok) fail("SSE 连接建立失败");
	const reader = response.body?.getReader();
	if (!reader) fail("SSE 无响应体");

	const events: Record<string, unknown>[] = [];
	const abort = new AbortController();
	void (async () => {
		const decoder = new TextDecoder();
		let buffer = "";
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				let index = buffer.indexOf("\n\n");
				while (index >= 0) {
					const chunk = buffer.slice(0, index);
					buffer = buffer.slice(index + 2);
					for (const line of chunk.split("\n")) {
						if (!line.startsWith("data: ")) continue;
						try {
							events.push(JSON.parse(line.slice(6)) as Record<string, unknown>);
						} catch {
							// 忽略注释行
						}
					}
					index = buffer.indexOf("\n\n");
				}
			}
		} catch {
			// 收尾时主动断开会让 read() 抛错，忽略
		}
	})();

	const waitFor = async (
		predicate: (event: Record<string, unknown>) => boolean,
		timeoutMs = 30000,
	): Promise<Record<string, unknown>> => {
		const started = Date.now();
		while (Date.now() - started < timeoutMs) {
			const hit = events.find(predicate);
			if (hit) return hit;
			await sleep(50);
		}
		fail(`等待事件超时，已收到: ${events.map((event) => String(event.type)).join(", ")}`);
	};

	return {
		events,
		waitFor,
		close: () => {
			abort.abort();
			void reader.cancel().catch(() => undefined);
		},
	};
}

async function createSession(token: string, workflowId: string): Promise<{ id: string; traceIds?: string[] }> {
	const response = await request("POST", "/api/sessions", { token, body: { workflowId } });
	if (response.status !== 201) fail(`创建会话失败: ${workflowId} / ${JSON.stringify(response.body)}`);
	return { id: String(response.body.id), traceIds: response.body.traceIds as string[] | undefined };
}

/** 发一条消息并等 done 事件；返回 done 负载（含 traceId）与 SSE 事件列表。 */
async function runTurn(
	token: string,
	sessionId: string,
	text: string,
): Promise<{ done: Record<string, unknown>; events: Record<string, unknown>[] }> {
	const stream = await openStream(sessionId, token);
	try {
		await stream.waitFor((event) => event.type === "ready");
		const response = await request("POST", `/api/sessions/${sessionId}/messages`, { token, body: { text } });
		if (response.status !== 202) fail(`消息未被接受：${JSON.stringify(response.body)}`);
		const done = await stream.waitFor(
			(event) => event.type === "done" || event.type === "error",
		);
		if (done.type === "error") fail(`这一轮对话失败：${String(done.message)}`);
		// done 事件先发给 SSE，会话的 finally（trace 收尾 + 持久化）随后才跑完；
		// 留一点时间再返回，避免紧接着的 summary / 详情查询读到 running 状态。
		await sleep(300);
		return { done, events: [...stream.events] };
	} finally {
		stream.close();
	}
}

async function summary(token: string, range: string): Promise<Record<string, unknown>> {
	const response = await request("GET", `/api/monitor/summary?range=${encodeURIComponent(range)}`, { token });
	if (response.status !== 200) fail(`summary(${range}) 失败：${response.status} ${JSON.stringify(response.body)}`);
	return response.body;
}

async function traces(token: string, query = ""): Promise<{ total: number; items: Record<string, unknown>[] }> {
	const response = await request("GET", `/api/monitor/traces${query}`, { token });
	if (response.status !== 200) fail(`traces 失败：${response.status} ${JSON.stringify(response.body)}`);
	return { total: Number(response.body.total ?? 0), items: (response.body.items ?? []) as Record<string, unknown>[] };
}

/** 往 SQLite 里种一条 2 天前的调用链（只用于制造 range 差异）；Postgres 返回 null。 */
async function seedOldTrace(token: string): Promise<string | null> {
	const health = await request("GET", "/api/health", { token });
	const storage = health.body.storage as { kind?: string; detail?: string } | undefined;
	if (storage?.kind !== "sqlite" || typeof storage.detail !== "string") {
		return null;
	}
	const traceId = "tr_seedoldtrace";
	const startedAt = Date.now() - 2 * 24 * 60 * 60 * 1000;
	const finishedAt = startedAt + 1234;
	const db = new DatabaseSync(storage.detail);
	try {
		db.prepare(
			`INSERT OR REPLACE INTO traces (id, workspace_id, session_id, workflow_id, skill_id, started_at, finished_at, status, error)
			 VALUES (?, 'default', NULL, 'auto-flow', NULL, ?, ?, 'ok', NULL)`,
		).run(traceId, startedAt, finishedAt);
		db.prepare(
			`INSERT OR REPLACE INTO trace_events (trace_id, seq, kind, name, ok, ms, payload, created_at)
			 VALUES (?, 1, 'tool', 'seed_old_tool', 1, 5000, '{"args":"seed"}', ?)`,
		).run(traceId, finishedAt);
	} catch (error) {
		fail(`种子调用链写入失败：${error instanceof Error ? error.message : String(error)}`);
	} finally {
		db.close();
	}
	return traceId;
}

async function main(): Promise<void> {
	console.log(`P9 监控冒烟：${BASE}`);

	// ---------- 0. 前置 ----------
	const health = await request("GET", "/api/health");
	if (health.status !== 200 || health.body.auth !== "required") {
		fail(
			`实例不是 AUTH_MODE=required（auth=${String(health.body.auth)}）。` +
				"请按脚本头部注释起一个 required + LLM_DISABLE=1 的隔离实例。",
		);
	}
	assert(health.body.auth === "required", "健康探针可访问，实例是 AUTH_MODE=required");
	const model = health.body.model as { mode?: string } | undefined;
	assert(model?.mode === "simulated", "实例跑的是模拟模型（LLM_DISABLE=1），结果可复现");

	const ownerToken = await login(OWNER_EMAIL, OWNER_PASSWORD);
	await ensureUser(ownerToken, OPERATOR_EMAIL, OPERATOR_PASSWORD, "operator");
	await ensureUser(ownerToken, AUDITOR_EMAIL, AUDITOR_PASSWORD, "auditor");
	await ensureUser(ownerToken, DEVELOPER_EMAIL, DEVELOPER_PASSWORD, "developer");
	const operatorToken = await login(OPERATOR_EMAIL, OPERATOR_PASSWORD);
	const auditorToken = await login(AUDITOR_EMAIL, AUDITOR_PASSWORD);
	const developerToken = await login(DEVELOPER_EMAIL, DEVELOPER_PASSWORD);

	// ---------- 1. 每轮消息一条 trace（auto-flow + 带工具的 ticket-flow） ----------
	console.log("\n[1] 调用链采集");
	const autoSession = await createSession(ownerToken, "auto-flow");
	const autoTurn = await runTurn(ownerToken, autoSession.id, "你好");
	assert(
		typeof autoTurn.done.traceId === "string" && TRACE_ID_PATTERN.test(String(autoTurn.done.traceId)),
		`done 事件带 trace_id（实际：${String(autoTurn.done.traceId)}）`,
	);
	const autoTraceId = String(autoTurn.done.traceId);
	const autoView = await request("GET", `/api/sessions/${autoSession.id}`, { token: ownerToken });
	const autoTraceIds = (autoView.body.traceIds ?? []) as string[];
	assert(autoTraceIds[0] === autoTraceId, "SessionView.traceIds 最新一条就是这一轮的 trace_id");

	const ticketSession = await createSession(ownerToken, "ticket-flow");
	const ticketTurn = await runTurn(ownerToken, ticketSession.id, "把支付回调超时的工单处理掉，并通知客户");
	const ticketTraceId = String(ticketTurn.done.traceId ?? "");
	assert(TRACE_ID_PATTERN.test(ticketTraceId), "工单会话这一轮也有独立 trace_id");
	assert(ticketTraceId !== autoTraceId, "两轮对话的 trace_id 不重复");
	const toolEnds = ticketTurn.events.filter((event) => event.type === "tool_end");
	assert(toolEnds.length === 4, `工单会话触发 4 次工具调用（实际 ${toolEnds.length}）`);
	assert(toolEnds.every((event) => event.ok === true), "4 次工具调用都成功");
	const ticketView = await request("GET", `/api/sessions/${ticketSession.id}`, { token: ownerToken });
	const ticketTraceIds = (ticketView.body.traceIds ?? []) as string[];
	assert(ticketTraceIds.length === 1 && ticketTraceIds[0] === ticketTraceId, "会话视图只保留自己的 trace_id");

	// ---------- 2. 聚合 summary ----------
	console.log("\n[2] GET /api/monitor/summary");
	const summary24h = await summary(ownerToken, "24h");
	const sessions = summary24h.sessions as { total?: number; active24h?: number } | undefined;
	const toolCalls = summary24h.toolCalls as { total?: number; ok?: number; failed?: number; avgMs?: number } | undefined;
	assert(Number(sessions?.total ?? 0) >= 2, `summary.sessions.total ≥ 2（实际 ${String(sessions?.total)}）`);
	assert(Number(sessions?.active24h ?? 0) >= 2, "summary.sessions.active24h 统计最近 24h 活跃会话");
	assert(Number(summary24h.messages24h ?? 0) >= 2, `summary.messages24h ≥ 2（实际 ${String(summary24h.messages24h)}）`);
	assert(Number(toolCalls?.total ?? 0) >= 4, `summary.toolCalls.total ≥ 4（实际 ${String(toolCalls?.total)}）`);
	assert(Number(toolCalls?.ok ?? 0) >= 4 && Number(toolCalls?.failed ?? 0) >= 0, "summary.toolCalls 有成功/失败拆分");
	assert(typeof toolCalls?.avgMs === "number" && Number(toolCalls.avgMs) >= 0, "summary.toolCalls.avgMs 是数字");
	assert(typeof summary24h.p95Ms === "number" && Number(summary24h.p95Ms) >= 0, "summary.p95Ms 是数字");
	assert(Array.isArray(summary24h.model) && (summary24h.model as unknown[]).length >= 1, "summary.model 至少一条（LLM 事件已落库）");

	// ---------- 3. 调用链列表 / 详情 ----------
	console.log("\n[3] GET /api/monitor/traces");
	const list = await traces(ownerToken, "?limit=50");
	assert(list.total >= 2 && list.items.length >= 2, `调用链列表 ≥ 2 条（total=${list.total}）`);
	const sorted = list.items.every(
		(item, index) => index === 0 || Number(item.startedAt) <= Number(list.items[index - 1]!.startedAt),
	);
	assert(sorted, "调用链列表按 startedAt 倒序");
	const ticketItem = list.items.find((item) => item.traceId === ticketTraceId);
	assert(Boolean(ticketItem), "列表里能找到工单会话的调用链");
	assert(Number(ticketItem?.toolCount ?? 0) === 4, `列表项 toolCount = 4（实际 ${String(ticketItem?.toolCount)}）`);
	assert(typeof ticketItem?.model === "string" && String(ticketItem.model).length > 0, "列表项带 model");

	const filtered = await traces(ownerToken, `?limit=10&sessionId=${encodeURIComponent(ticketSession.id)}`);
	assert(filtered.total === 1 && filtered.items[0]?.traceId === ticketTraceId, "traces 支持 sessionId 过滤");

	const detail = await request("GET", `/api/monitor/traces/${ticketTraceId}`, { token: ownerToken });
	assert(detail.status === 200, "调用链详情 → 200");
	const detailTrace = detail.body.trace as Record<string, unknown> | undefined;
	const detailEvents = (detail.body.events ?? []) as Record<string, unknown>[];
	assert(detailTrace?.traceId === ticketTraceId && detailTrace?.status === "ok", "详情 trace 状态为 ok");
	assert(detailEvents.length >= 5, `详情事件 ≥ 5 条（实际 ${detailEvents.length}）`);
	const seqs = detailEvents.map((event) => Number(event.seq));
	assert(seqs.every((seq, index) => index === 0 || seq > seqs[index - 1]!), "详情事件按 seq 升序");
	const kinds = new Set(detailEvents.map((event) => event.kind));
	assert(kinds.has("llm") && kinds.has("tool"), "详情事件顺序里同时有 llm 与 tool");
	assert(
		detailEvents.filter((event) => event.kind === "tool").length === 4,
		"详情里 4 条 tool 事件",
	);
	const toolEvent = detailEvents.find((event) => event.kind === "tool");
	assert(
		typeof (toolEvent?.payload as { args?: unknown } | undefined)?.args === "string",
		"tool 事件带参数摘要（≤200 字）",
	);

	const missing = await request("GET", "/api/monitor/traces/tr_missing00000", { token: ownerToken });
	assert(missing.status === 404, "不存在的调用链 → 404");

	// ---------- 4. 角色边界 ----------
	console.log("\n[4] 权限：operator 只读 summary / auditor 可读 / developer 只看自己会话");
	const operatorSummary = await request("GET", "/api/monitor/summary", { token: operatorToken });
	assert(operatorSummary.status === 200, "operator 能读 /api/monitor/summary");
	const operatorTraces = await request("GET", "/api/monitor/traces", { token: operatorToken });
	assert(operatorTraces.status === 403, "operator 读 /api/monitor/traces → 403");
	assert(
		String(operatorTraces.body.error).includes("运营"),
		`operator 的 403 文案是中文且带角色名（实际：${String(operatorTraces.body.error)}）`,
	);
	const auditorTraces = await request("GET", "/api/monitor/traces?limit=5", { token: auditorToken });
	assert(auditorTraces.status === 200, "auditor 能读调用链列表");
	const auditorSummary = await request("GET", "/api/monitor/summary", { token: auditorToken });
	assert(auditorSummary.status === 200, "auditor 能读 summary");

	const developerSession = await createSession(developerToken, "ticket-flow");
	const developerTurn = await runTurn(developerToken, developerSession.id, "把支付回调超时的工单处理掉，并通知客户");
	const developerTraceId = String(developerTurn.done.traceId ?? "");
	const developerList = await traces(developerToken, "?limit=50");
	assert(
		developerList.items.length >= 1 && developerList.items.every((item) => item.sessionId === developerSession.id),
		"developer 的调用链列表只剩自己创建的会话",
	);
	const developerOwnDetail = await request("GET", `/api/monitor/traces/${developerTraceId}`, { token: developerToken });
	assert(developerOwnDetail.status === 200, "developer 能看自己会话的调用链详情");
	const developerOtherDetail = await request("GET", `/api/monitor/traces/${ticketTraceId}`, { token: developerToken });
	assert(developerOtherDetail.status === 403, "developer 看别人的调用链详情 → 403");
	const developerOtherList = await request(
		"GET",
		`/api/monitor/traces?sessionId=${encodeURIComponent(ticketSession.id)}`,
		{ token: developerToken },
	);
	assert(developerOtherList.status === 403, "developer 按别人的 sessionId 过滤 → 403");

	// ---------- 5. 归档 / 新建不影响已有聚合 ----------
	console.log("\n[5] 归档与新建对聚合的影响");
	const beforeArchive = await summary(ownerToken, "24h");
	const archived = await request("PATCH", `/api/sessions/${autoSession.id}`, {
		token: ownerToken,
		body: { archived: true },
	});
	assert(archived.status === 200 && archived.body.archived === true, "归档测试会话成功");
	const afterArchive = await summary(ownerToken, "24h");
	assert(
		JSON.stringify(beforeArchive.sessions) === JSON.stringify(afterArchive.sessions) &&
			beforeArchive.messages24h === afterArchive.messages24h &&
			JSON.stringify(beforeArchive.toolCalls) === JSON.stringify(afterArchive.toolCalls),
		"归档不改变会话总数 / 消息数 / 工具调用聚合",
	);
	const beforeCreate = await summary(ownerToken, "24h");
	const extraSession = await createSession(ownerToken, "auto-flow");
	assert(extraSession.id.length > 0, "新建一个不发言的会话");
	const afterCreate = await summary(ownerToken, "24h");
	assert(
		Number((afterCreate.sessions as { total?: number }).total) ===
			Number((beforeCreate.sessions as { total?: number }).total) + 1,
		"新建会话让 sessions.total +1",
	);

	// ---------- 6. range=1h 与 range=7d ----------
	console.log("\n[6] range 过滤（SQLite 种子数据制造时间差）");
	const seeded = await seedOldTrace(ownerToken);
	if (seeded === null) {
		skip("Postgres 后端不写 SQLite 种子数据，range 差异断言跳过");
	} else {
		const oneHour = await summary(ownerToken, "1h");
		const sevenDays = await summary(ownerToken, "7d");
		const oneHourCalls = Number((oneHour.toolCalls as { total?: number }).total);
		const sevenDayCalls = Number((sevenDays.toolCalls as { total?: number }).total);
		assert(sevenDayCalls > oneHourCalls, `range=7d 的工具调用数多于 1h（${sevenDayCalls} > ${oneHourCalls}）`);
		assert(
			Number(sevenDays.messages24h) > Number(oneHour.messages24h),
			"range=7d 的消息数多于 1h（2 天前的种子调用链只在 7d 内）",
		);
		const seededDetail = await request("GET", `/api/monitor/traces/${seeded}`, { token: ownerToken });
		assert(seededDetail.status === 200, "种子调用链详情可读（DAO 往返）");
	}

	// ---------- 7. /api/audit 新过滤 ----------
	console.log("\n[7] GET /api/audit 过滤增强");
	const auditAll = await request("GET", "/api/audit?limit=200", { token: ownerToken });
	assert(auditAll.status === 200 && Array.isArray(auditAll.body.items), "审计列表仍是 { total, items } 形状");
	const auditItems = (auditAll.body.items ?? []) as Record<string, unknown>[];
	assert(auditItems.length > 0 && auditItems.every((item) => typeof item.actorType === "string"), "每条审计都带 actorType");
	assert(typeof auditAll.body.total === "number", "审计返回 total");

	const actorFiltered = await request("GET", "/api/audit?limit=200&actorType=user&q=auth", { token: ownerToken });
	const actorItems = (actorFiltered.body.items ?? []) as Record<string, unknown>[];
	assert(actorFiltered.status === 200, "actorType + q 组合过滤 → 200");
	assert(actorItems.length > 0 && actorItems.every((item) => item.actorType === "user"), "actorType=user 只返回 user");
	assert(
		actorItems.every((item) => String(item.action).includes("auth")),
		"q=auth 只命中 action 含 auth 的记录",
	);
	const fromMs = Date.now() - 10 * 60 * 1000;
	const windowed = await request("GET", `/api/audit?limit=200&from=${fromMs}`, { token: ownerToken });
	assert(windowed.status === 200, `from 毫秒时间戳过滤 → 200`);
	const badTime = await request("GET", "/api/audit?from=not-a-time", { token: ownerToken });
	assert(badTime.status === 400, "非法 from → 400（中文错误）");
	const operatorAudit = await request("GET", "/api/audit", { token: operatorToken });
	assert(operatorAudit.status === 403, "operator 读审计 → 403");
	const auditorAudit = await request("GET", "/api/audit?limit=5", { token: auditorToken });
	assert(auditorAudit.status === 200, "auditor 能读审计");

	// ---------- 8. 收尾 ----------
	console.log("\n[8] 收尾");
	for (const sessionId of [autoSession.id, ticketSession.id, developerSession.id, extraSession.id]) {
		const removed = await request("DELETE", `/api/sessions/${sessionId}`, { token: ownerToken });
		assert(removed.status === 200, `删除测试会话 ${sessionId.slice(0, 8)}…`);
	}

	console.log(`\n全部通过：${assertions} 项检查${skipped > 0 ? `（另有 ${skipped} 项按后端跳过）` : ""}`);
}

await main();
