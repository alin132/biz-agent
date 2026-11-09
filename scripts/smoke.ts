/**
 * 端到端冒烟测试：走真实 HTTP + SSE，验证 Web 链路完整可用。
 *
 * 前置：先跑 `npm run dev` 把服务起来。`.env` 里配了真 key 时建议带
 *       `LLM_DISABLE=1` 起服务（强制模拟模型），否则断言会随模型输出漂移。
 * 跑法：npm run smoke
 *
 * 覆盖九条主链路：
 *   A. 工单流程 —— 四个工具依次执行，流程走完
 *   B. 审批流程 —— 高风险工具触发审批事件，人工同意后继续并归档
 *   C. 健康检查与会话重命名 —— /api/health 探针（含模型与存储后端）+ PATCH 标题的各类边界
 *   D. 运行时流程 —— 查工具目录、建自定义流程、用它建会话跑完，再改/删/校验边界
 *   E. 会话归档 —— 归档/取消归档、非法入参、以及"收到新消息自动取消归档"
 *   F. 技能 —— 技能目录、加载/退出技能后的工具集与步骤条、会话列表与 SSE 事件、非法入参，
 *      以及技能区 CRUD（自定义流程带技能文案：新建 → 目录 → 改 → 清空回落兜底 → 删除）
 *   G. 知识库 RAG —— 建库/重名/空名、上传中文 Markdown、文档与库列表、关键词检索、
 *      技能绑定（含非法 id 与清空）、删文档/删库的级联计数
 *   H. 审批中心 —— 跨会话的全局待办：GET 列表字段、在中心里放行、放行后待办清空，
 *      以及 409（已处理）/404（会话不存在）/400（参数非法）
 *   J. 会话级模型 —— POST /api/sessions/:id/model 只换这一条会话（全局当前模型一动不动）、
 *      选中的模型行 id 落库并在重建会话后仍解析回同一个模型、异常入参；模拟实例如实拒绝
 */

import { flowToolName } from "../src/core/flowTools.js";

const BASE = process.env.SMOKE_BASE ?? "http://127.0.0.1:4317";

interface Wire {
	type: string;
	[key: string]: unknown;
}

function fail(message: string): never {
	console.error(`✗ ${message}`);
	process.exit(1);
}

/** 已通过的断言总数，末尾汇总打印，README 的项数以它为准。 */
let assertions = 0;

function assert(condition: boolean, message: string): void {
	if (!condition) fail(message);
	assertions += 1;
	console.log(`  ✓ ${message}`);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

interface StreamHandle {
	events: Wire[];
	waitFor: (predicate: (event: Wire) => boolean, timeoutMs?: number) => Promise<Wire>;
}

async function openStream(sessionId: string): Promise<StreamHandle> {
	const response = await fetch(`${BASE}/api/sessions/${sessionId}/events`);
	if (!response.ok) fail("SSE 连接建立失败");
	const reader = response.body?.getReader();
	if (!reader) fail("SSE 无响应体");

	const events: Wire[] = [];
	void (async () => {
		const decoder = new TextDecoder();
		let buffer = "";
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
						events.push(JSON.parse(line.slice(6)) as Wire);
					} catch {
						// 忽略注释行与无法解析的内容
					}
				}
				index = buffer.indexOf("\n\n");
			}
		}
	})();

	const waitFor = async (predicate: (event: Wire) => boolean, timeoutMs = 20000): Promise<Wire> => {
		const started = Date.now();
		while (Date.now() - started < timeoutMs) {
			const hit = events.find(predicate);
			if (hit) return hit;
			await sleep(50);
		}
		fail(`等待事件超时，已收到: ${events.map((event) => event.type).join(", ")}`);
	};

	return { events, waitFor };
}

async function createSession(
	workflowId: string,
): Promise<{ id: string; title: string | null; archived: boolean; tools: string[]; steps: { status: string }[] }> {
	const response = await fetch(`${BASE}/api/sessions`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ workflowId }),
	});
	if (!response.ok) fail(`创建会话失败: ${workflowId}`);
	return (await response.json()) as {
		id: string;
		title: string | null;
		archived: boolean;
		tools: string[];
		steps: { status: string }[];
	};
}

async function sendMessage(sessionId: string, text: string): Promise<void> {
	const response = await fetch(`${BASE}/api/sessions/${sessionId}/messages`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ text }),
	});
	if (response.status !== 202) fail("消息未被接受");
}

/* ---------------- 场景 A：工单流程 ---------------- */

async function scenarioTicket(): Promise<void> {
	console.log("\n[A] 工单流程");

	const session = await createSession("ticket-flow");
	assert(session.steps[0]?.status === "active", "初始时第 1 步为 active");

	const stream = await openStream(session.id);
	await stream.waitFor((event) => event.type === "ready");
	assert(true, "收到 ready 事件");

	await sendMessage(session.id, "把支付回调超时的工单处理掉，并通知客户");

	const doneEvent = await stream.waitFor((event) => event.type === "done");
	assert(String(doneEvent.text ?? "").length > 0, "最终回复非空");

	const textDeltas = stream.events.filter((event) => event.type === "text");
	assert(textDeltas.length > 0, `收到流式文本（${textDeltas.length} 段）`);

	const toolStarts = stream.events.filter((event) => event.type === "tool_start");
	assert(toolStarts.length === 4, `触发 4 次工具调用（实际 ${toolStarts.length}）`);

	const toolEnds = stream.events.filter((event) => event.type === "tool_end");
	assert(toolEnds.every((event) => event.ok === true), "所有工具调用成功");

	const lastWorkflow = [...stream.events].reverse().find((event) => event.type === "workflow");
	const steps = lastWorkflow?.steps as { status: string }[] | undefined;
	assert(Array.isArray(steps) && steps.every((step) => step.status === "done"), "流程 4 步全部完成");

	const snapshot = (await (await fetch(`${BASE}/api/sessions/${session.id}`)).json()) as {
		done: boolean;
		audit: { toolName: string }[];
		transcript: { role: string }[];
	};
	assert(snapshot.done === true, "会话快照显示流程已完成");
	assert(snapshot.audit.length === 4, `审计记录 4 条（实际 ${snapshot.audit.length}）`);
	assert(snapshot.transcript.length === 2, "transcript 有一问一答");
}

/* ---------------- 场景 B：审批流程（同意） ---------------- */

async function scenarioApproval(): Promise<void> {
	console.log("\n[B] 审批流程（人工同意）");

	const session = await createSession("approval-flow");
	const stream = await openStream(session.id);
	await stream.waitFor((event) => event.type === "ready");

	await sendMessage(session.id, "帮张明提交一笔 3200 元的报销，客户拜访差旅费");

	const approval = await stream.waitFor((event) => event.type === "approval");
	assert(String(approval.toolName ?? "") === "approval_submit", "高风险工具触发审批事件");
	assert(String(approval.risk ?? "") === "high", "审批事件带 high 风险等级");
	assert(typeof approval.requestId === "string", "审批事件带 requestId");

	const approveResponse = await fetch(`${BASE}/api/sessions/${session.id}/approve`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ requestId: approval.requestId, approved: true }),
	});
	assert(approveResponse.ok, "审批决定被接受");

	const doneEvent = await stream.waitFor((event) => event.type === "done", 25000);
	assert(String(doneEvent.text ?? "").length > 0, "审批通过后流程继续并产出回复");

	const lastWorkflow = [...stream.events].reverse().find((event) => event.type === "workflow");
	const steps = lastWorkflow?.steps as { status: string }[] | undefined;
	assert(Array.isArray(steps) && steps.every((step) => step.status === "done"), "审批流程 3 步全部完成");

	const toolNames = stream.events
		.filter((event) => event.type === "tool_end")
		.map((event) => String(event.name));
	assert(
		toolNames.includes("approval_submit") && toolNames.includes("approval_archive"),
		`提交与归档均已执行（${toolNames.join(" → ")}）`,
	);
}

/* ---------------- 场景 C：健康检查与会话重命名 ---------------- */

interface HealthView {
	ok: boolean;
	uptimeMs: number;
	sessions: number;
	model: { mode: string; id: string | null; label: string };
	storage?: { kind?: string; detail?: string };
}

interface SessionView {
	id: string;
	title: string | null;
	archived: boolean;
}

/** 发一次 PATCH /api/sessions/:id，返回状态码与响应里的 title / archived（400/404 时为 undefined）。 */
async function patchSession(
	sessionId: string,
	body: unknown,
): Promise<{ status: number; title: unknown; archived: unknown }> {
	const response = await fetch(`${BASE}/api/sessions/${sessionId}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	const payload = (await response.json().catch(() => ({}))) as { title?: unknown; archived?: unknown };
	return { status: response.status, title: payload.title, archived: payload.archived };
}

/** 发一次重命名请求，返回状态码与响应里的 title。 */
async function patchTitle(sessionId: string, body: unknown): Promise<{ status: number; title: unknown }> {
	const result = await patchSession(sessionId, body);
	return { status: result.status, title: result.title };
}

async function scenarioHealthAndRename(): Promise<void> {
	console.log("\n[C] 健康检查与会话重命名");

	const healthResponse = await fetch(`${BASE}/api/health`);
	assert(healthResponse.ok, "/api/health 返回 200");
	const health = (await healthResponse.json()) as HealthView;
	assert(health.ok === true, "health 里 ok 为 true");
	assert(
		health.model?.mode === "simulated" || health.model?.mode === "live",
		`模型模式为 simulated 或 live（实际 ${String(health.model?.mode)}）`,
	);
	assert(typeof health.sessions === "number", `health 带会话数（${String(health.sessions)}）`);
	assert(typeof health.uptimeMs === "number" && health.uptimeMs > 0, `health 带运行时长（${String(health.uptimeMs)} ms）`);
	// 存储后端可能是 SQLite（默认，DB_PATH）或 Postgres（DATABASE_URL）；两种都算对，kind 只认这两个值
	const storageKind = String(health.storage?.kind ?? "");
	assert(Boolean(health.storage), "health 带存储后端信息（storage）");
	assert(
		(storageKind === "sqlite" || storageKind === "postgres") &&
			typeof health.storage?.detail === "string" &&
			health.storage.detail.length > 0,
		`存储后端为 sqlite 或 postgres 且 detail 非空（kind=${storageKind}，detail=${String(health.storage?.detail)}）`,
	);

	const session = await createSession("ticket-flow");
	assert(session.title === null, "新会话初始没有自定义标题（title 为 null）");
	const piStats = await api<{ sessionId?: string; sessionFile?: string; userMessages: number; assistantMessages: number; toolCalls: number; tokens: { total: number }; cost: number }>("GET", `/api/sessions/${session.id}/pi-stats`);
	assert(piStats.status === 200 && typeof piStats.data.userMessages === "number" && typeof piStats.data.assistantMessages === "number" && typeof piStats.data.toolCalls === "number" && typeof piStats.data.tokens?.total === "number" && typeof piStats.data.cost === "number", "Pi 原生会话统计返回消息、工具、token 与费用数字（HTTP 200）");
	assert(!("sessionId" in piStats.data) && !("sessionFile" in piStats.data), "Pi 统计响应不暴露内部会话标识或文件路径");
	const piTree = await api<{ leafId: string | null; nodes: { id: string; active: boolean; children: unknown[] }[] }>("GET", `/api/sessions/${session.id}/pi-tree`);
	assert(piTree.status === 200 && Array.isArray(piTree.data.nodes) && (piTree.data.leafId === null || typeof piTree.data.leafId === "string"), "Pi 会话树接口返回节点与活动叶节点（HTTP 200）");
	assert(!JSON.stringify(piTree.data).includes("sessionFile"), "Pi 会话树视图不暴露内部会话文件字段");

	const customTitle = "报修工单：支付回调超时";
	const renamed = await patchTitle(session.id, { title: customTitle });
	assert(renamed.status === 200 && renamed.title === customTitle, `重命名返回 200 且 title 与入参一致（${String(renamed.title)}）`);

	const detail = (await (await fetch(`${BASE}/api/sessions/${session.id}`)).json()) as SessionView;
	assert(detail.title === customTitle, "会话详情里的 title 已更新");

	const listResponse = await fetch(`${BASE}/api/sessions`);
	const list = (await listResponse.json()) as SessionView[];
	assert(list.find((item) => item.id === session.id)?.title === customTitle, "会话列表里的 title 已更新");

	const cleared = await patchTitle(session.id, { title: "  \t  " });
	assert(cleared.status === 200 && cleared.title === null, "提交纯空白标题 → 清空为 null");

	const rejected = await patchTitle(session.id, { title: 123 });
	assert(rejected.status === 400, `非字符串标题被拒绝（HTTP ${rejected.status}）`);

	const missing = await patchTitle("qa-no-such-session", { title: "任意标题" });
	assert(missing.status === 404, `未知会话重命名返回 404（实际 ${missing.status}）`);

	const longTitle = "长".repeat(200);
	const truncated = await patchTitle(session.id, { title: longTitle });
	const truncatedText = String(truncated.title ?? "");
	assert(truncated.status === 200 && truncatedText.length === 80, `200 字符标题被截断到 80（实际 ${truncatedText.length}）`);
}

/* ---------------- 场景 D：运行时流程（自定义流程 CRUD + 流程即工具） ---------------- */

interface ToolSummaryView {
	name: string;
	description: string;
	category: string;
	risk: string;
}

interface WorkflowSummaryView {
	id: string;
	name: string;
	builtin: boolean;
	steps: { id: string; title: string; via: string[] }[];
}

interface WorkflowDetailView extends WorkflowSummaryView {
	systemPrompt: string;
	steps: { id: string; title: string; via: string[]; hint: string }[];
	/** 技能文案（技能区「查看」用；两段都空时 detail 里没有这个字段）。 */
	skill?: { description?: string; instructions?: string };
}

/** 发一次 JSON 请求，返回状态码与解析后的 body（404 等错误也照常解析）。 */
async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
	const response = await fetch(`${BASE}${path}`, {
		method,
		headers: body === undefined ? undefined : { "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const data = (await response.json().catch(() => ({}))) as T;
	return { status: response.status, data };
}

async function scenarioRuntimeWorkflow(): Promise<void> {
	console.log("\n[D] 运行时流程（自定义流程 CRUD + 流程即工具）");

	// --- 工具目录：业务能力都在，且不掺流程工具（flow_ 是会话级动态装的）---
	const tools = await api<ToolSummaryView[]>("GET", "/api/tools");
	assert(tools.status === 200 && Array.isArray(tools.data) && tools.data.length > 0, `GET /api/tools 返回业务工具目录（${tools.data.length} 个）`);
	const toolNames = tools.data.map((tool) => tool.name);
	for (const expected of ["ticket_search", "data_query", "approval_submit"]) {
		assert(toolNames.includes(expected), `工具目录里有 ${expected}`);
	}
	assert(toolNames.every((name) => !name.startsWith("flow_")), "工具目录不掺流程工具（flow_ 不进目录）");
	assert(
		tools.data.every((tool) => tool.description.length > 0 && tool.category.length > 0 && tool.risk.length > 0),
		"每个工具都带描述/分类/风险等级",
	);

	// 上一轮失败留下的一次性流程先清掉，避免重名与脏数据
	const existing = await api<WorkflowSummaryView[]>("GET", "/api/workflows");
	const leftovers = existing.data.filter((item) => !item.builtin && item.name.startsWith("冒烟自定义流程-"));
	for (const leftover of leftovers) {
		await api("DELETE", `/api/workflows/${leftover.id}`);
	}

	// --- 建自定义流程（两步，用目录里带 example 的真实工具，模拟模型才演得完）---
	const runId = Date.now().toString(36);
	const customName = `冒烟自定义流程-${runId}`;
	const created = await api<WorkflowDetailView>("POST", "/api/workflows", {
		name: customName,
		systemPrompt: "你是工单助手：先查工单，再通知客户。",
		steps: [
			{ title: "查询工单", via: ["ticket_search"], hint: "先定位目标工单" },
			{ title: "通知客户", via: ["ticket_notify"] },
		],
	});
	assert(created.status === 201, `POST /api/workflows 返回 201（实际 ${created.status}）`);
	assert(created.data.builtin === false, "新建流程 builtin 为 false");
	assert(created.data.name === customName, "新建流程名称与入参一致");
	assert(created.data.steps.length === 2, `新建流程保留 2 个步骤（实际 ${created.data.steps.length}）`);
	assert(created.data.steps[0]?.title === "查询工单", "步骤标题与入参一致");
	const customId = created.data.id;
	assert(/^flow-[0-9a-f]{8}$/.test(customId), `自定义流程 id 形如 flow-xxxxxxxx（实际 ${customId}）`);

	// --- 列表与详情 ---
	const list = await api<WorkflowSummaryView[]>("GET", "/api/workflows");
	const listed = list.data.find((item) => item.id === customId);
	assert(list.status === 200 && Boolean(listed), "GET /api/workflows 列表里出现新建流程");
	assert(listed?.builtin === false, "列表项 builtin 为 false");
	assert(Array.isArray(listed?.steps) && listed.steps.length === 2, "列表项带 2 个步骤");
	assert(list.data.filter((item) => item.builtin).length >= 4, "四条内置流程（自动编排 + 三个切片）仍在列表里");

	const detail = await api<WorkflowDetailView>("GET", `/api/workflows/${customId}`);
	assert(detail.status === 200 && detail.data.systemPrompt.includes("工单助手"), "详情带 systemPrompt");
	assert(detail.data.steps[1]?.via.includes("ticket_notify"), "详情里步骤 via 是工具名");
	assert(detail.data.steps.every((step) => typeof step.hint === "string"), "详情里每步都带 hint（可为空串）");

	// --- 流程即工具：任何会话都能看到别的流程，但不是自己 ---
	const ticketSession = await createSession("ticket-flow");
	assert(
		ticketSession.tools.includes("ticket_search") && ticketSession.tools.includes("ticket_notify"),
		"工单会话装配了自己的业务工具",
	);
	assert(ticketSession.tools.includes("flow_approval_flow"), "工单会话里能挑审批流程（flow_approval_flow）");
	assert(ticketSession.tools.includes(flowToolName(customId)), "工单会话里能挑刚建的自定义流程");
	assert(!ticketSession.tools.includes("flow_ticket_flow"), "不把自己包成流程工具（防自递归）");

	// --- 用自定义流程 id 建会话并跑完 ---
	const customSession = await createSession(customId);
	assert(customSession.steps.length === 2, `自定义流程会话有 2 步（实际 ${customSession.steps.length}）`);
	assert(customSession.tools.includes(flowToolName(customId)) === false, "自定义流程会话里不出现自己的流程工具");
	assert(
		customSession.tools.includes("flow_ticket_flow") && customSession.tools.includes("flow_data_flow"),
		"自定义流程会话里也能挑内置流程",
	);

	const stream = await openStream(customSession.id);
	await stream.waitFor((event) => event.type === "ready");
	await sendMessage(customSession.id, "把支付回调超时的工单处理掉，并通知客户");
	const doneEvent = await stream.waitFor((event) => event.type === "done");
	assert(String(doneEvent.text ?? "").length > 0, "自定义流程会话产出最终回复");

	const snapshot = (await (await fetch(`${BASE}/api/sessions/${customSession.id}`)).json()) as {
		done: boolean;
		steps: { status: string }[];
	};
	assert(snapshot.done === true, "自定义流程两步全部走完（done=true）");
	assert(snapshot.steps.length === 2 && snapshot.steps.every((step) => step.status === "done"), "自定义流程 2 步状态均为 done");

	// --- PATCH：改名生效且 id 不变；内置流程不可改 ---
	const renamedName = `${customName}-改名`;
	const patched = await api<WorkflowDetailView>("PATCH", `/api/workflows/${customId}`, { name: renamedName });
	assert(patched.status === 200 && patched.data.name === renamedName, "PATCH 改名返回 200 且名称已更新");
	assert(patched.data.id === customId, "改名不改变流程 id");
	assert(patched.data.steps.length === 2, "只改名字时步骤保留");
	const reloaded = await api<WorkflowDetailView>("GET", `/api/workflows/${customId}`);
	assert(reloaded.data.name === renamedName, "改名后重新取详情仍是新名称");

	const builtinPatch = await api("PATCH", "/api/workflows/ticket-flow", { name: "试图改内置流程" });
	assert(builtinPatch.status === 403, `PATCH 内置流程返回 403（实际 ${builtinPatch.status}）`);
	const builtinDelete = await api("DELETE", "/api/workflows/ticket-flow");
	assert(builtinDelete.status === 403, `DELETE 内置流程返回 403（实际 ${builtinDelete.status}）`);
	const builtinDetail = await api<WorkflowDetailView>("GET", "/api/workflows/ticket-flow");
	assert(builtinDetail.status === 200 && builtinDetail.data.builtin === true, "内置流程详情标 builtin=true 且未被改动");

	// --- 纯技能（零步骤）：只写"什么时候用 + 正文"，不预设任何工具 ---
	const pureSkill = await api<WorkflowDetailView>("POST", "/api/workflows", {
		name: `冒烟纯技能-${runId}`,
		systemPrompt: "你是客服：按指导书处理退款。",
		steps: [],
		skill: {
			description: "用户要退货退款或查退款进度时用我",
			instructions: "先核对订单状态，再说明下一步，最后告诉用户预计到账时间。",
		},
	});
	assert(pureSkill.status === 201, `零步骤技能可以建（HTTP ${pureSkill.status}）`);
	assert(pureSkill.data.steps.length === 0, "零步骤技能 steps 为空数组");
	const pureSkillSession = await createSession(pureSkill.data.id);
	assert(pureSkillSession.steps.length === 0, "零步骤技能建出来的会话没有预设步骤");
	assert(
		pureSkillSession.tools.length > 0 && !pureSkillSession.tools.includes(flowToolName(pureSkill.data.id)),
		"零步骤技能会装上工具目录（交给模型自己挑），但不含自己的 flow 工具",
	);
	const pureSkills = await api<SkillView[]>("GET", "/api/skills");
	assert(
		pureSkills.data.find((skill) => skill.id === pureSkill.data.id)?.steps === 0,
		"技能目录里这条技能是 0 步",
	);
	await api("DELETE", `/api/workflows/${pureSkill.data.id}`);

	// --- 校验边界：未知工具、重名、未知流程、未知 id ---
	const invalid = await api<{ error?: string }>("POST", "/api/workflows", {
		name: `冒烟非法流程-${runId}`,
		systemPrompt: "系统提示",
		steps: [{ title: "查询", via: ["no_such_tool"] }],
	});
	assert(invalid.status === 400, `引用未知工具的流程被拒绝（HTTP ${invalid.status}）`);
	assert(
		typeof invalid.data.error === "string" && invalid.data.error.includes("no_such_tool"),
		`400 的错误文案指出具体工具名（${String(invalid.data.error)}）`,
	);

	const duplicated = await api<{ error?: string }>("POST", "/api/workflows", {
		name: renamedName,
		systemPrompt: "系统提示",
		steps: [{ title: "查询", via: ["ticket_search"] }],
	});
	assert(duplicated.status === 400, `流程重名被拒绝（HTTP ${duplicated.status}）`);

	const unknownSession = await api<{ error?: string }>("POST", "/api/sessions", { workflowId: "no-such-workflow" });
	assert(unknownSession.status === 400, `未知流程建会话返回 400（实际 ${unknownSession.status}）`);

	const unknownDetail = await api("GET", "/api/workflows/no-such-workflow");
	assert(unknownDetail.status === 404, `未知流程详情返回 404（实际 ${unknownDetail.status}）`);

	// --- DELETE：删干净后再取 404 ---
	const removed = await api<{ removed?: boolean }>("DELETE", `/api/workflows/${customId}`);
	assert(removed.status === 200 && removed.data.removed === true, "DELETE 自定义流程返回 200 且 removed=true");

	const afterDelete = await api("GET", `/api/workflows/${customId}`);
	assert(afterDelete.status === 404, `删除后再取详情返回 404（实际 ${afterDelete.status}）`);
	const gonePatch = await api("PATCH", `/api/workflows/${customId}`, { name: "已删除的流程" });
	assert(gonePatch.status === 404, `PATCH 已删除的流程返回 404（实际 ${gonePatch.status}）`);
}

/* ---------------- 场景 E：会话归档 ---------------- */

async function scenarioArchive(): Promise<void> {
	console.log("\n[E] 会话归档");

	const session = await createSession("ticket-flow");
	assert(session.archived === false, "新会话初始未归档（archived 为 false）");

	const archived = await patchSession(session.id, { archived: true });
	assert(archived.status === 200 && archived.archived === true, "归档返回 200 且 archived 为 true");

	const detail = (await (await fetch(`${BASE}/api/sessions/${session.id}`)).json()) as SessionView;
	assert(detail.archived === true, "会话详情里 archived 已更新");

	const list = (await (await fetch(`${BASE}/api/sessions`)).json()) as SessionView[];
	assert(list.find((item) => item.id === session.id)?.archived === true, "会话列表里该会话 archived 为 true");

	const notBoolean = await patchSession(session.id, { archived: "yes" });
	assert(notBoolean.status === 400, `非布尔 archived 被拒绝（HTTP ${notBoolean.status}）`);

	const emptyPatch = await patchSession(session.id, {});
	assert(emptyPatch.status === 400, `空 PATCH 被拒绝（HTTP ${emptyPatch.status}）`);

	// 重命名与归档共用 PATCH：一次传两个字段，两个都要生效
	const both = await patchSession(session.id, { title: "归档演示会话", archived: false });
	assert(
		both.status === 200 && both.title === "归档演示会话" && both.archived === false,
		"一次 PATCH 同时改 title 与 archived 都生效",
	);

	const reArchived = await patchSession(session.id, { archived: true });
	assert(reArchived.status === 200 && reArchived.archived === true, "再次归档成功");

	const unknown = await patchSession("qa-no-such-session", { archived: true });
	assert(unknown.status === 404, `未知会话归档返回 404（实际 ${unknown.status}）`);

	// SSE 的 ready 快照里也带 archived；往归档会话发消息会自动取消归档
	const stream = await openStream(session.id);
	const ready = await stream.waitFor((event) => event.type === "ready");
	const readySession = ready.session as { archived?: unknown } | undefined;
	assert(readySession?.archived === true, "SSE ready 快照里 archived 为 true");

	await sendMessage(session.id, "把支付回调超时的工单处理掉，并通知客户");
	await stream.waitFor((event) => event.type === "done");
	const revived = (await (await fetch(`${BASE}/api/sessions/${session.id}`)).json()) as SessionView;
	assert(revived.archived === false, "已归档会话收到新消息后自动取消归档（archived 置回 false）");
}

/* ---------------- 场景 F：技能（加载 / 退出 / 接线） ---------------- */

interface SkillView {
	id: string;
	name: string;
	description: string;
	/** 0 = 没有预设步骤（自动编排那种） */
	steps: number;
	tools: string[];
	builtin: boolean;
}

/** POST /api/sessions/:id/skills 的响应：换成技能之后的会话快照片段。 */
interface SkillActivateView {
	activeSkillId: string | null;
	tools: string[];
	skills: { id: string; name: string; active: boolean; builtin: boolean; steps: number }[];
	steps: { title: string; status: string }[];
	current: number;
	done: boolean;
}

interface SkillSessionView extends SessionView {
	tools: string[];
	skills: { id: string; active: boolean }[];
	activeSkillId: string | null;
	steps: { title: string; status: string }[];
}

async function scenarioSkills(): Promise<void> {
	console.log("\n[F] 技能");

	// --- 技能目录：四条内置流程都能当技能 ---
	// 注意：库里可能已经有自定义流程（它们也会进技能目录），所以这里按 builtin 过滤，别断言总条数
	const catalog = await api<SkillView[]>("GET", "/api/skills");
	assert(catalog.status === 200 && Array.isArray(catalog.data), `GET /api/skills 返回技能目录（HTTP ${catalog.status}）`);
	const builtinSkills = catalog.data.filter((skill) => skill.builtin);
	assert(builtinSkills.length === 4, `四条内置流程都能当技能（实际 ${builtinSkills.length} 条）`);
	assert(
		builtinSkills.every((skill) => skill.description.length > 0),
		"技能项都标 builtin 且带一句话描述（进系统提示的技能目录）",
	);
	const autoSkill = catalog.data.find((skill) => skill.id === "auto-flow");
	assert(autoSkill?.steps === 0, `自动编排作为技能没有预设步骤（steps=${String(autoSkill?.steps)}）`);
	const dataSkill = catalog.data.find((skill) => skill.id === "data-flow");
	assert(
		dataSkill?.steps === 4 && dataSkill.tools.length === 4,
		`data-flow 技能 4 步 4 个工具（实际 ${String(dataSkill?.steps)} 步 / ${String(dataSkill?.tools.length)} 个工具）`,
	);

	// --- 新会话：默认没加载技能，但工具里已经装着 use_skill 与 flow_* ---
	const session = await createSession("ticket-flow");
	const detail = await api<SkillSessionView>("GET", `/api/sessions/${session.id}`);
	assert(detail.status === 200 && detail.data.activeSkillId === null, "新会话 activeSkillId 为 null（没加载技能）");
	const builtinIds = ["auto-flow", "ticket-flow", "data-flow", "approval-flow"];
	assert(
		detail.data.skills.every((skill) => skill.active === false) &&
			builtinIds.every((id) => detail.data.skills.some((skill) => skill.id === id)),
		"会话视图带四条内置技能目录（自定义技能另算），且都没有标 active",
	);
	assert(detail.data.tools.includes("use_skill"), "会话工具里含技能加载工具 use_skill");
	assert(
		detail.data.tools.includes(flowToolName("data-flow")) && detail.data.tools.includes("ticket_search"),
		"会话工具里含 flow_* 委托入口与本流程步骤工具",
	);

	// SSE 先挂上，才能断言加载/退出技能时的 skill 事件
	const stream = await openStream(session.id);
	await stream.waitFor((event) => event.type === "ready");

	// --- 加载 data-flow 技能 ---
	const loaded = await api<SkillActivateView>("POST", `/api/sessions/${session.id}/skills`, { skillId: "data-flow" });
	assert(
		loaded.status === 200 && loaded.data.activeSkillId === "data-flow",
		`加载技能返回 200 且 activeSkillId=data-flow（实际 ${loaded.status} / ${String(loaded.data.activeSkillId)}）`,
	);
	assert(
		dataSkill !== undefined && dataSkill.tools.every((name) => loaded.data.tools.includes(name)),
		"工具集换成技能声明的 data_* 工具",
	);
	assert(
		loaded.data.tools.includes("use_skill") && !loaded.data.tools.includes("ticket_search"),
		"换技能后保留 use_skill，原流程的工具不再暴露",
	);
	assert(
		loaded.data.steps.length === 4 &&
			loaded.data.steps[0]?.title === "探查数据结构" &&
			loaded.data.steps[3]?.title === "生成报告",
		"步骤条换成技能的 4 步（标题与 data-flow 定义一致）",
	);
	assert(loaded.data.current === 0 && loaded.data.done === false, "加载技能后从第 1 步开始、未完成");
	assert(
		loaded.data.skills.find((skill) => skill.id === "data-flow")?.active === true,
		"技能目录里 data-flow 标 active",
	);

	const skillEvent = await stream.waitFor((event) => event.type === "skill");
	assert(
		skillEvent.skillId === "data-flow" && skillEvent.name === dataSkill?.name,
		"SSE 推送 skill 事件（带技能 id 与名称）",
	);

	const list = await api<SkillSessionView[]>("GET", "/api/sessions");
	assert(
		list.data.find((item) => item.id === session.id)?.activeSkillId === "data-flow",
		"会话列表里也带 activeSkillId（左栏能标出加载了哪条技能）",
	);

	// --- 退出技能：回到会话自己的流程 ---
	const cleared = await api<SkillActivateView>("POST", `/api/sessions/${session.id}/skills`, { skillId: null });
	assert(cleared.status === 200 && cleared.data.activeSkillId === null, "退出技能返回 200 且 activeSkillId=null");
	assert(
		cleared.data.steps.length === 4 && cleared.data.steps[0]?.title === "查询工单",
		"退出后步骤条回到会话原流程（工单 4 步）",
	);
	assert(
		cleared.data.tools.includes("ticket_search") && !cleared.data.tools.includes("data_query"),
		"退出后工具集恢复工单流程",
	);
	await stream.waitFor((event) => event.type === "skill" && event.skillId === null);
	assert(true, "退出技能也推 skill 事件（skillId 为 null）");

	// --- 非法入参 ---
	const unknown = await api<{ error?: string }>("POST", `/api/sessions/${session.id}/skills`, { skillId: "no-such-skill" });
	assert(unknown.status === 400, `未知技能返回 400（实际 ${unknown.status}）`);
	const notString = await api<{ error?: string }>("POST", `/api/sessions/${session.id}/skills`, { skillId: 123 });
	assert(notString.status === 400, `skillId 不是字符串或 null 返回 400（实际 ${notString.status}）`);

	// --- 技能区：自定义流程 = 一份可编辑的技能（新建 → 目录 → 改 → 清空回落 → 删除）---
	const customName = `技能区冒烟 ${Date.now().toString(36)}`;
	const created = await api<WorkflowDetailView>("POST", "/api/workflows", {
		name: customName,
		systemPrompt: "先查工单，再按用户要求处理。",
		steps: [{ title: "查询工单", via: ["ticket_search"], hint: "按用户给的工单号查" }],
		skill: {
			description: "用户要处理某张工单时用我（自定义技能）",
			instructions: "先查工单，再按用户要求处理，最后汇报结果。",
		},
	});
	assert(
		created.status === 201 && created.data.skill?.description === "用户要处理某张工单时用我（自定义技能）",
		`技能区新建流程带技能文案，201 且回显 skill（HTTP ${created.status}）`,
	);
	const customId = created.data.id;

	const catalogWithCustom = await api<SkillView[]>("GET", "/api/skills");
	const customSkill = catalogWithCustom.data.find((skill) => skill.id === customId);
	assert(
		customSkill?.builtin === false && customSkill.description === "用户要处理某张工单时用我（自定义技能）",
		"新流程立刻出现在技能目录里，描述用自定义那句话（builtin=false）",
	);

	const edited = await api<WorkflowDetailView>("PATCH", `/api/workflows/${customId}`, {
		skill: { description: "改过的一句话：查工单时用我" },
	});
	assert(
		edited.status === 200 &&
			edited.data.skill?.description === "改过的一句话：查工单时用我" &&
			edited.data.skill?.instructions === undefined,
		"PATCH 只带 description：描述生效、旧正文被替换掉（技能文案是替换语义）",
	);
	const catalogAfterEdit = await api<SkillView[]>("GET", "/api/skills");
	assert(
		catalogAfterEdit.data.find((skill) => skill.id === customId)?.description === "改过的一句话：查工单时用我",
		"技能目录里的描述跟着 PATCH 结果变",
	);

	// 技能区删除流程的服务端语义：它自己的会话跟着删、别的会话自动退出这条技能
	const customSession = await api<{ id?: string }>("POST", "/api/sessions", { workflowId: customId });
	assert(
		customSession.status === 201 && typeof customSession.data.id === "string",
		`用自定义流程建一个会话（HTTP ${customSession.status}）`,
	);

	// 用一个"技能建好之前就存在"的会话来加载：会话的技能目录是构造时快照的，
	// 这里同时回归"会话开着时新建技能，旧会话也能加载"（`Session.refreshSkills()`）
	const loader = session;
	const loadedCustom = await api<SkillActivateView>("POST", `/api/sessions/${loader.id}/skills`, { skillId: customId });
	assert(
		loadedCustom.status === 200 && loadedCustom.data.activeSkillId === customId,
		"技能建好之前就开着的会话也能加载这条新技能（技能目录运行期刷新）",
	);
	const bStream = await openStream(loader.id);
	await bStream.waitFor((event) => event.type === "ready");

	const clearedSkill = await api<WorkflowDetailView>("PATCH", `/api/workflows/${customId}`, { skill: null });
	assert(clearedSkill.status === 200 && clearedSkill.data.skill === undefined, "PATCH skill:null 清空技能文案（detail 无 skill 字段）");
	const catalogFallback = await api<SkillView[]>("GET", "/api/skills");
	assert(
		catalogFallback.data.find((skill) => skill.id === customId)?.description === `按固定步骤完成「${customName}」。`,
		"清空技能文案后目录描述回落兜底句式（流程仍能当技能用）",
	);

	const builtinDetail = await api<WorkflowDetailView>("GET", "/api/workflows/ticket-flow");
	assert(
		builtinDetail.status === 200 && Boolean(builtinDetail.data.skill?.instructions),
		"内置流程 ticket-flow 的 detail 也带技能文案（技能区「查看」用）",
	);

	const removed = await api<{ removed?: boolean; sessionsRemoved?: number; skillsCleared?: number }>(
		"DELETE",
		`/api/workflows/${customId}`,
	);
	assert(
		removed.status === 200 && removed.data.removed === true && (removed.data.sessionsRemoved ?? 0) >= 1,
		`删流程连带删掉它自己的会话（sessionsRemoved=${String(removed.data.sessionsRemoved)}）`,
	);
	assert(
		(removed.data.skillsCleared ?? 0) >= 1,
		`别的会话正在加载这条技能时自动退出（skillsCleared=${String(removed.data.skillsCleared)}）`,
	);
	await bStream.waitFor((event) => event.type === "skill" && event.skillId === null);
	assert(true, "技能被删除时给加载过它的会话推 skill 事件（skillId 为 null）");

	const sessionsAfterDelete = await api<SkillSessionView[]>("GET", "/api/sessions");
	assert(
		!sessionsAfterDelete.data.some((item) => item.id === customSession.data.id),
		"删流程后它自己的会话从会话列表消失（不会留下找不到流程的孤儿）",
	);
	assert(
		sessionsAfterDelete.data.find((item) => item.id === loader.id)?.activeSkillId === null,
		"技能被删后，加载过它的会话 activeSkillId 回到 null",
	);

	const catalogAfterDelete = await api<SkillView[]>("GET", "/api/skills");
	assert(
		!catalogAfterDelete.data.some((skill) => skill.id === customId),
		"删除流程后技能目录里也没有它了",
	);
	const goneDetail = await api<WorkflowDetailView>("GET", `/api/workflows/${customId}`);
	assert(goneDetail.status === 404, `删掉的技能再查 detail 返回 404（实际 ${goneDetail.status}）`);
}

/* ---------------- 场景 G：知识库 RAG ---------------- */

interface EmbeddingInfoView {
	available: boolean;
	model: string;
	baseUrl: string;
}

interface KnowledgeBaseView {
	id: string;
	name: string;
	docCount: number;
	chunkCount: number;
	embeddedChunkCount: number;
	/** 库里有向量才算 true（没配 EMBEDDING_API_KEY 时恒为 false） */
	embedding: boolean;
	/** 是否设为「对话默认检索」的库（问答不走技能时查它） */
	isDefault?: boolean;
}

interface KbDocumentView {
	id: string;
	kbId: string;
	filename: string;
	status: string;
	chunkCount: number;
	bytes: number;
	mime: string | null;
}

interface KbUploadView {
	document: KbDocumentView;
	chunkCount: number;
	embedded: boolean;
	warning?: string;
}

interface KbSearchView {
	mode: string;
	results: { chunkId: number; docId: string; heading: string | null; snippet: string; score: number }[];
	fallbackReason?: string;
}

interface SkillKbView {
	skillId: string;
	kbIds: string[];
	knowledgeBases: KnowledgeBaseView[];
}

async function scenarioKnowledgeBase(): Promise<void> {
	console.log("\n[G] 知识库 RAG");

	// --- 向量化开关：是否配了 EMBEDDING_API_KEY，检索模式据此如实切换 ---
	const embedding = await api<EmbeddingInfoView>("GET", "/api/kb/embedding");
	assert(
		embedding.status === 200 && typeof embedding.data.available === "boolean",
		`GET /api/kb/embedding 返回 200 且 available 是布尔（HTTP ${embedding.status} / ${String(embedding.data.available)}）`,
	);
	assert(
		typeof embedding.data.model === "string" && embedding.data.model.length > 0,
		`embedding 信息带非空的 model（${String(embedding.data.model)}）`,
	);

	// 上一轮失败留下的库先清掉，避免重名与脏绑定
	const existing = await api<KnowledgeBaseView[]>("GET", "/api/kb");
	for (const leftover of existing.data.filter((kb) => kb.name.startsWith("冒烟知识库-"))) {
		await api("DELETE", `/api/kb/${leftover.id}`);
	}
	// 技能绑定是覆盖式设置：先清空，才能断言"初始没绑定"
	await api("PUT", "/api/skills/ticket-flow/kb", { kbIds: [] });

	// --- 建库 / 重名 / 空名 ---
	const kbName = `冒烟知识库-${Date.now().toString(36)}`;
	const created = await api<KnowledgeBaseView>("POST", "/api/kb", { name: kbName });
	assert(created.status === 201 && typeof created.data.id === "string", `POST /api/kb 返回 201（HTTP ${created.status}）`);
	const kbId = created.data.id;
	assert(
		created.data.name === kbName &&
			created.data.docCount === 0 &&
			created.data.chunkCount === 0 &&
			created.data.embedding === false,
		"新库的 docCount/chunkCount 为 0、embedding 未启用",
	);

	const duplicated = await api<{ error?: string }>("POST", "/api/kb", { name: kbName });
	assert(duplicated.status === 400, `重名建库被拒绝（HTTP ${duplicated.status}）`);

	const blankName = await api<{ error?: string }>("POST", "/api/kb", { name: "   " });
	assert(blankName.status === 400, `空名称建库被拒绝（HTTP ${blankName.status}）`);

	// --- 上传中文 Markdown：正文里同时有「退款」「到账」，供关键词检索命中 ---
	const markdown = [
		"# 售后服务手册",
		"",
		"## 退款到账时间",
		"普通退款在审核通过后 1-3 个工作日原路退回；银行卡退款最长 7 个工作日到账。",
		"超过时限请在工单里催办，客服会核对支付渠道与银行流水。",
	].join("\n");
	const uploaded = await api<KbUploadView>("POST", `/api/kb/${kbId}/documents`, {
		filename: "售后手册.md",
		contentBase64: Buffer.from(markdown, "utf8").toString("base64"),
	});
	assert(
		uploaded.status === 201 && typeof uploaded.data.document.id === "string",
		`上传文档返回 201（HTTP ${uploaded.status}）`,
	);
	const documentId = uploaded.data.document.id;
	assert(uploaded.data.document.status === "ready", `文档状态为 ready（实际 ${String(uploaded.data.document.status)}）`);
	assert(
		uploaded.data.document.chunkCount > 0 && uploaded.data.chunkCount > 0,
		`文档分块数大于 0（${uploaded.data.chunkCount} 块）`,
	);

	// --- 文档列表与库列表里的计数 ---
	const documents = await api<KbDocumentView[]>("GET", `/api/kb/${kbId}/documents`);
	assert(
		documents.status === 200 &&
			documents.data.some((document) => document.id === documentId && document.filename === "售后手册.md"),
		"GET /api/kb/:id/documents 列表里含刚上传的文档",
	);

	const list = await api<KnowledgeBaseView[]>("GET", "/api/kb");
	const listedKb = list.data.find((kb) => kb.id === kbId);
	assert(
		list.status === 200 &&
			listedKb !== undefined &&
			listedKb.docCount === 1 &&
			typeof listedKb.chunkCount === "number" &&
			listedKb.chunkCount > 0 &&
			typeof listedKb.embedding === "boolean",
		`GET /api/kb 的库行带 docCount/chunkCount/embedding（docCount=${String(listedKb?.docCount)}，chunkCount=${String(listedKb?.chunkCount)}，embedding=${String(listedKb?.embedding)}）`,
	);

	// --- 关键词检索：没配 EMBEDDING_API_KEY 时必须如实回 mode=keyword ---
	const search = await api<KbSearchView>("POST", `/api/kb/${kbId}/search`, { query: "退款多久到账" });
	assert(
		search.status === 200 && search.data.mode === "keyword",
		`检索返回 200 且 mode=keyword（实际 ${String(search.data.mode)}）`,
	);
	assert(
		Array.isArray(search.data.results) && search.data.results.length >= 1,
		`检索至少命中 1 条（实际 ${search.data.results.length} 条）`,
	);
	assert(
		search.data.results.every((result) => result.snippet.length > 0),
		"每条命中的 snippet 都非空",
	);
	assert(
		search.data.results.every((result) => result.score > 0),
		`命中结果的分值都大于 0（最高 ${String(search.data.results[0]?.score)}）`,
	);

	// --- 技能绑定：空 → 绑一个 → 再读 → 非法 id → 清空 ---
	const bindingsBefore = await api<SkillKbView>("GET", "/api/skills/ticket-flow/kb");
	assert(
		bindingsBefore.status === 200 && Array.isArray(bindingsBefore.data.kbIds) && bindingsBefore.data.kbIds.length === 0,
		"技能初始没有绑定知识库（kbIds 为空）",
	);

	const bound = await api<SkillKbView>("PUT", "/api/skills/ticket-flow/kb", { kbIds: [kbId] });
	assert(
		bound.status === 200 && bound.data.kbIds.length === 1 && bound.data.kbIds[0] === kbId,
		`PUT 绑定知识库返回 200 且回显 kbIds（HTTP ${bound.status}）`,
	);

	const bindingsAfter = await api<SkillKbView>("GET", "/api/skills/ticket-flow/kb");
	assert(
		bindingsAfter.data.kbIds.includes(kbId) && bindingsAfter.data.knowledgeBases.some((kb) => kb.id === kbId),
		"再 GET 能读到绑定关系与知识库详情",
	);

	const badBinding = await api<{ error?: string }>("PUT", "/api/skills/ticket-flow/kb", { kbIds: ["no_such_kb"] });
	assert(badBinding.status === 400, `绑定不存在的知识库返回 400（实际 ${badBinding.status}）`);

	const clearedBindings = await api<SkillKbView>("PUT", "/api/skills/ticket-flow/kb", { kbIds: [] });
	assert(
		clearedBindings.status === 200 && clearedBindings.data.kbIds.length === 0,
		"PUT { kbIds: [] } 清空技能绑定",
	);

	// --- 删文档：chunksRemoved 应等于上传时的分块数 ---
	const removedDocument = await api<{ removed?: boolean; chunksRemoved?: number }>(
		"DELETE",
		`/api/kb/documents/${documentId}`,
	);
	assert(
		removedDocument.status === 200 &&
			removedDocument.data.removed === true &&
			removedDocument.data.chunksRemoved === uploaded.data.chunkCount,
		`删文档返回 200 且带 chunksRemoved（${String(removedDocument.data.chunksRemoved)} 块）`,
	);

	// --- 再传一份，验证删库时 documentsRemoved/chunksRemoved 的级联计数 ---
	const second = await api<KbUploadView>("POST", `/api/kb/${kbId}/documents`, {
		filename: "退款说明.txt",
		contentBase64: Buffer.from("退款到账说明：审核通过后 1-3 个工作日到账。", "utf8").toString("base64"),
	});
	assert(second.status === 201, `补传第二份文档返回 201（HTTP ${second.status}）`);

	const removedKb = await api<{ removed?: boolean; documentsRemoved?: number; chunksRemoved?: number }>(
		"DELETE",
		`/api/kb/${kbId}`,
	);
	assert(
		removedKb.status === 200 &&
			removedKb.data.removed === true &&
			removedKb.data.documentsRemoved === 1 &&
			removedKb.data.chunksRemoved === second.data.chunkCount,
		`删库返回 200 且带 documentsRemoved/chunksRemoved（文档 ${String(removedKb.data.documentsRemoved)} 份 / 分块 ${String(removedKb.data.chunksRemoved)} 块）`,
	);

	const listAfterDelete = await api<KnowledgeBaseView[]>("GET", "/api/kb");
	assert(
		listAfterDelete.status === 200 && !listAfterDelete.data.some((kb) => kb.id === kbId),
		"删库后 GET /api/kb 列表里没有它",
	);

	// --- 对话默认检索：不加载技能，问答也能查到资料（RAG 主路径） ---
	const defaultsBefore = await api<{ kbIds: string[] }>("GET", "/api/kb/defaults");
	const pausedDefaults = defaultsBefore.data.kbIds ?? [];
	const ragKb = await api<KnowledgeBaseView>("POST", "/api/kb", { name: `冒烟对话检索库-${Date.now().toString(36)}` });
	assert(ragKb.status === 201, `建「对话检索」用库返回 201（HTTP ${ragKb.status}）`);
	await api("POST", `/api/kb/${ragKb.data.id}/documents`, {
		filename: "差旅报销规则.md",
		contentBase64: Buffer.from("# 差旅报销规则\n\n住宿费上限每晚 600 元，超出的部分需要总经理审批。", "utf8").toString("base64"),
	});
	const setDefaults = await api<{ kbIds: string[] }>("PUT", "/api/kb/defaults", { kbIds: [ragKb.data.id] });
	assert(
		setDefaults.status === 200 && setDefaults.data.kbIds.length === 1,
		`PUT /api/kb/defaults 设为对话默认检索（HTTP ${setDefaults.status}）`,
	);
	const listWithDefault = await api<KnowledgeBaseView[]>("GET", "/api/kb");
	assert(
		listWithDefault.data.find((item) => item.id === ragKb.data.id)?.isDefault === true,
		"GET /api/kb 的行带 isDefault（页面开关据此回显）",
	);

	// 不加载技能 → 直接在 auto-flow 会话里问；模拟模型会按 example 调 kb_search，
	// 会话视角断言工具集里带着 kb_search（真正的检索逻辑由 kb:selftest 覆盖）
	const ragSession = await createSession("auto-flow");
	const ragDetail = await api<{ tools: string[]; activeSkillId: string | null }>("GET", `/api/sessions/${ragSession.id}`);
	assert(
		ragDetail.status === 200 &&
			ragDetail.data.activeSkillId === null &&
			ragDetail.data.tools.includes("kb_search"),
		`没有加载技能的新会话也带着 kb_search（技能 ${String(ragDetail.data.activeSkillId)}）`,
	);

	// 收尾：恢复场景开始前的默认库设置，再删掉临时库
	await api("PUT", "/api/kb/defaults", { kbIds: pausedDefaults });
	await api("DELETE", `/api/kb/${ragKb.data.id}`);
	const defaultsAfter = await api<{ kbIds: string[] }>("GET", "/api/kb/defaults");
	assert(
		defaultsAfter.data.kbIds.length === pausedDefaults.length,
		`收尾恢复默认库设置（${defaultsAfter.data.kbIds.length} 个）`,
	);
}

/* ---------------- 场景 G2：模型页的「向量模型」接通知识库 ---------------- */

interface ProviderView {
	id: string;
	name: string;
	kind: string;
	enabled: boolean;
}

interface ModelView {
	id: string;
	providerId: string;
	name: string;
	modelId: string;
	kind: string;
	enabled: boolean;
}

interface EmbeddingView {
	modelKey: string | null;
	options: ModelView[];
}

interface EmbeddingInfoView2 {
	available: boolean;
	model: string;
	baseUrl: string;
	source: "model" | "env" | "none";
	modelKey: string | null;
	problem: string | null;
}

/**
 * 模型页新加的「向量模型」要真能驱动知识库的向量化。
 * 放在 G 之后单独跑：这一段会把"当前向量模型"临时指向一个假端点，必须在 G 的关键词断言之后，
 * 结束时再清干净（否则后面的 G 复跑会变成 vector 模式、断言全乱）。
 */
async function scenarioEmbeddingModelWiring(): Promise<void> {
	console.log("\n[G2] 向量模型接通知识库");

	// 上一轮失败可能留下"冒烟向量供应商-xxx"：先清掉（删供应商会连带删它的模型），
	// 否则基线断言与"选完变 model"都会变成假通过/假失败
	const providers = await api<{ items: ProviderView[] }>("GET", "/api/models/providers");
	for (const leftover of providers.data.items.filter((item) => item.name.startsWith("冒烟向量供应商-"))) {
		await api("DELETE", `/api/models/providers/${leftover.id}`);
	}
	// 这台实例上可能已经有别人配好的向量模型（手工建的、演示用）：临时停用它们，
	// 让"基线 = 没有向量模型"成立，结束时再按原样恢复（别把用户的配置弄坏）
	const allModels = await api<{ models: ModelView[] }>("GET", "/api/models");
	const paused = allModels.data.models.filter((model) => model.kind === "embedding" && model.enabled);
	for (const model of paused) {
		await api("PATCH", `/api/models/${model.id}`, { enabled: false });
	}

	// 动手之前：这台实例没有可用的向量模型（断言基线，避免残留让下面的"选中后变 model"变成假通过）
	const before = await api<EmbeddingInfoView2>("GET", "/api/kb/embedding");
	assert(
		before.data.source !== "model",
		`场景开始前 source 不是 model（${String(before.data.source)}）`,
	);

	const providerName = `冒烟向量供应商-${Date.now().toString(36)}`;
	const createdProvider = await api<ProviderView>("POST", "/api/models/providers", {
		name: providerName,
		kind: "custom",
		// 故意指向一个关着的端口：这里只验证"配置解析"，不真的打网络
		baseUrl: "http://127.0.0.1:9/v1",
		apiKey: "sk-smoke-embedding",
	});
	assert(
		createdProvider.status === 201 && typeof createdProvider.data.id === "string",
		`POST /api/models/providers 建向量供应商返回 201（HTTP ${createdProvider.status}）`,
	);
	const providerId = createdProvider.data.id;

	const createdModel = await api<ModelView>("POST", "/api/models", {
		providerId,
		name: "冒烟向量模型",
		modelId: "smoke-embedding",
		kind: "embedding",
		enabled: true,
	});
	assert(
		createdModel.status === 201 && createdModel.data.kind === "embedding",
		`POST /api/models 建「向量」类型模型返回 201（HTTP ${createdModel.status}）`,
	);
	const modelRowId = createdModel.data.id;

	const chatModel = await api<ModelView>("POST", "/api/models", {
		providerId,
		name: "冒烟对话模型",
		modelId: "smoke-chat",
		kind: "chat",
		enabled: true,
	});
	assert(chatModel.status === 201, `顺带建一条对话模型（HTTP ${chatModel.status}）`);

	// --- 只能选「向量」类型，选了对话模型要被拒 ---
	const wrongPick = await api<{ error?: string }>("POST", "/api/models/embedding", { modelId: chatModel.data.id });
	assert(
		wrongPick.status === 400 && String(wrongPick.data.error ?? "").includes("向量"),
		`对话模型不能设为向量模型（HTTP ${wrongPick.status} / ${String(wrongPick.data.error)}）`,
	);
	const missing = await api<{ error?: string }>("POST", "/api/models/embedding", { modelId: "model_nope" });
	assert(missing.status === 404, `不存在的模型设为向量模型返回 404（HTTP ${missing.status}）`);

	// --- 选中之后：/api/kb/embedding 立刻反映出来（不用重启） ---
	const picked = await api<EmbeddingView>("POST", "/api/models/embedding", { modelId: modelRowId });
	assert(
		picked.status === 200 && picked.data.modelKey === modelRowId,
		`POST /api/models/embedding 选中向量模型返回 200 且 modelKey 对得上（HTTP ${picked.status}）`,
	);
	const after = await api<EmbeddingInfoView2>("GET", "/api/kb/embedding");
	assert(
		after.status === 200 && after.data.available === true && after.data.source === "model",
		`选完向量模型后知识库立刻可用（available=${String(after.data.available)} / source=${String(after.data.source)}）`,
	);
	assert(
		after.data.model === "smoke-embedding" && after.data.baseUrl === "http://127.0.0.1:9/v1",
		`模型名与端点来自模型页那条模型（${after.data.model} @ ${after.data.baseUrl}）`,
	);
	assert(
		after.data.modelKey === modelRowId && after.data.problem === null,
		"同步带 modelKey、problem 为空（页面据此标「已启用」）",
	);

	// --- 停用这条模型：知识库立刻退回关键词检索，并如实说清原因 ---
	const disabled = await api<ModelView>("PATCH", `/api/models/${modelRowId}`, { enabled: false });
	assert(disabled.status === 200, `PATCH 停用向量模型返回 200（HTTP ${disabled.status}）`);
	const afterDisable = await api<EmbeddingInfoView2>("GET", "/api/kb/embedding");
	assert(
		afterDisable.data.available === false,
		`停用后知识库立刻不可用（available=${String(afterDisable.data.available)}）`,
	);

	// --- 收尾：恢复启用，再删模型与供应商，别把状态留给下一次 ---
	await api("PATCH", `/api/models/${modelRowId}`, { enabled: true });
	await api("DELETE", `/api/models/${chatModel.data.id}`);
	await api("DELETE", `/api/models/${modelRowId}`);
	await api("DELETE", `/api/models/providers/${providerId}`);
	// 收尾断言必须在"恢复先前停用的模型"之前做：那之后 source 可能又变回 model 了
	const cleaned = await api<EmbeddingInfoView2>("GET", "/api/kb/embedding");
	assert(
		cleaned.data.source === before.data.source,
		`清理后回到场景开始前的状态（source ${String(cleaned.data.source)} / 期望 ${String(before.data.source)}）`,
	);
	// 把先前临时停用的向量模型恢复启用（可能已经不存在了，忽略即可）
	for (const model of paused) {
		await api("PATCH", `/api/models/${model.id}`, { enabled: true });
	}
	const restored = await api<EmbeddingInfoView2>("GET", "/api/kb/embedding");
	if (paused.length > 0) {
		assert(
			restored.data.source === "model" && restored.data.available === true,
			`先前就有的向量模型要恢复成可用（source=${String(restored.data.source)} / available=${String(restored.data.available)}）`,
		);
	}
}

/* ---------------- 场景 H：审批中心（全局待办） ---------------- */

interface PendingApprovalItemView {
	sessionId: string;
	sessionTitle: string | null;
	workflowId: string;
	workflowName: string;
	archived: boolean;
	requestId: string;
	toolName: string;
	risk: string;
	args: Record<string, unknown>;
	askedAt: number;
}

interface ApprovalListView {
	items: PendingApprovalItemView[];
	total: number;
}

async function scenarioApprovalCenter(): Promise<void> {
	console.log("\n[H] 审批中心（全局待办）");

	// 上一轮失败可能留下挂起中的审批：先统一拒掉，下面的"待办为空"断言才不被脏数据影响
	const stale = await api<ApprovalListView>("GET", "/api/approvals");
	for (const leftover of stale.data.items ?? []) {
		await api("POST", `/api/approvals/${leftover.sessionId}`, {
			requestId: leftover.requestId,
			approved: false,
		});
	}
	const cleaned = await api<ApprovalListView>("GET", "/api/approvals");
	assert(
		cleaned.status === 200 && Array.isArray(cleaned.data.items) && cleaned.data.total === 0,
		`GET /api/approvals 返回 200 且初始没有待办（total=${String(cleaned.data.total)}）`,
	);

	// approval-flow 的 approval_submit 是 high 风险，会挂起工具调用、等人工决定
	const session = await createSession("approval-flow");
	const title = `审批中心-${Date.now().toString(36)}`;
	await api("PATCH", `/api/sessions/${session.id}`, { title });

	const stream = await openStream(session.id);
	await stream.waitFor((event) => event.type === "ready");
	await sendMessage(session.id, "帮张明提交一笔 3200 元的报销，客户拜访差旅费");
	const approval = await stream.waitFor((event) => event.type === "approval");
	const requestId = String(approval.requestId ?? "");

	// --- 全局待办里能看到它，且字段与会话/审批事件对得上 ---
	const pending = await api<ApprovalListView>("GET", "/api/approvals");
	const item = (pending.data.items ?? []).find((entry) => entry.requestId === requestId);
	assert(
		pending.status === 200 && pending.data.total === 1 && item !== undefined,
		`GET /api/approvals 返回 1 条待办（total=${String(pending.data.total)}）`,
	);
	assert(
		item !== undefined &&
			item.sessionId === session.id &&
			item.toolName === "approval_submit" &&
			item.risk === "high",
		`待办指向该会话与高风险工具（${String(item?.toolName)} / ${String(item?.risk)}）`,
	);
	assert(
		item !== undefined && typeof item.askedAt === "number" && item.askedAt > 0 && item.askedAt <= Date.now(),
		"待办带 askedAt 时间戳（毫秒）",
	);
	assert(
		item !== undefined &&
			item.sessionTitle === title &&
			item.workflowId === "approval-flow" &&
			typeof item.workflowName === "string" &&
			item.workflowName.length > 0 &&
			typeof item.archived === "boolean",
		`待办带会话标题/流程/归档标注（${String(item?.sessionTitle)} / ${String(item?.workflowName)} / archived=${String(item?.archived)}）`,
	);
	assert(
		item !== undefined && item.args !== null && JSON.stringify(item.args) === JSON.stringify(approval.args),
		"待办带工具入参（与 SSE 审批事件一致）",
	);
	assert(
		(pending.data.items ?? []).every((entry, index, all) => index === 0 || all[index - 1]!.askedAt <= entry.askedAt),
		"待办按 askedAt 升序",
	);

	// --- 在审批中心放行：会话继续跑完，待办随之清空 ---
	const decided = await api<{ ok?: boolean; resolved?: boolean; sessionId?: string; requestId?: string }>(
		"POST",
		`/api/approvals/${session.id}`,
		{ requestId, approved: true },
	);
	assert(
		decided.status === 200 &&
			decided.data.ok === true &&
			decided.data.resolved === true &&
			decided.data.sessionId === session.id &&
			decided.data.requestId === requestId,
		`POST /api/approvals/:sessionId 返回 200 { ok, resolved, sessionId, requestId }（HTTP ${decided.status}）`,
	);

	const doneEvent = await stream.waitFor((event) => event.type === "done", 25000);
	assert(String(doneEvent.text ?? "").length > 0, "审批中心放行后会话继续并产出回复");

	const after = await api<ApprovalListView>("GET", "/api/approvals");
	assert(
		after.status === 200 && Array.isArray(after.data.items) && after.data.total === 0,
		`处理完再 GET /api/approvals 已清空（total=${String(after.data.total)}）`,
	);

	// --- 边界：重复处理 / 会话不存在 / 参数非法 ---
	const again = await api<{ error?: string }>("POST", `/api/approvals/${session.id}`, { requestId, approved: true });
	assert(
		again.status === 409 && String(again.data.error ?? "").includes("已经处理过"),
		`重复提交同一条审批返回 409 中文提示（HTTP ${again.status}）`,
	);

	const unknown = await api<{ error?: string }>("POST", "/api/approvals/no-such-session", {
		requestId,
		approved: true,
	});
	assert(unknown.status === 404, `未知会话返回 404（HTTP ${unknown.status}）`);

	const missing = await api<{ error?: string }>("POST", `/api/approvals/${session.id}`, { approved: true });
	assert(missing.status === 400, `缺 requestId 返回 400（HTTP ${missing.status}）`);

	const badApproved = await api<{ error?: string }>("POST", `/api/approvals/${session.id}`, {
		requestId,
		approved: "yes",
	});
	assert(badApproved.status === 400, `approved 非布尔返回 400（HTTP ${badApproved.status}）`);
}

/* ---------------- 场景 J：会话级模型（与全局当前模型隔离） ---------------- */

/** GET /api/models 的形状：`current` 是 modelId 字符串，`models` 是模型行（有内部 id）。 */
interface ModelsView {
	mode: "live" | "simulated";
	current: string;
	label: string;
	options: { id: string; label: string }[];
	providers: ProviderView[];
	models: ModelView[];
}

/** SessionView 里与模型有关的那几个字段（断言只用这几项，免得跟着别的字段一起改）。 */
interface SessionModelView {
	id: string;
	mode: "live" | "simulated";
	modeLabel: string;
	modelId: string | null;
	modelKey?: string | null;
}

interface ModelSwitchView {
	session: SessionModelView;
	modelId: string | null;
	modelKey: string | null;
	mode: "live" | "simulated";
	modeLabel: string;
	models: { id: string; label: string }[];
}

/**
 * 会话级换模型：`POST /api/sessions/:id/model`。
 *
 * 这个场景要守住的核心事实只有一条：**换的是这一条会话，不是全局当前模型**。
 * 全局那个（POST /api/models/current）管的是「之后新建的会话用哪条模型」，
 * 拿它当会话内切换用，会让别的会话下一轮也跟着换——所以这里专门断言
 * 「切换前后 GET /api/models 的 current 一点没变」。
 *
 * 模拟实例（LLM_DISABLE=1）走的是另一条分支：没有真实模型可切，接口必须如实拒绝，
 * 不能回一个 200 让人以为切成功了。两条分支都断言，公共 smoke 实例是哪一种都能跑。
 */
async function scenarioSessionModel(): Promise<void> {
	console.log("\n[J] 会话级模型（与全局当前模型隔离）");

	const models = await api<ModelsView>("GET", "/api/models");
	assert(models.status === 200 && (models.data.mode === "live" || models.data.mode === "simulated"),
		`GET /api/models 返回 200 且带 mode（${String(models.data.mode)}）`);

	// 上一轮跑崩可能留下「冒烟对话模型-xxx」：先清掉，否则第二次跑会因模型名重复而校验失败
	for (const leftover of models.data.models.filter((row) => row.name.startsWith("冒烟对话模型-"))) {
		await api("DELETE", `/api/models/${leftover.id}`);
	}

	// 全局当前模型在整段场景里必须一动不动：它就是「别的会话有没有被串台」的观测点
	const globalBefore = await api<{ current?: string }>("GET", "/api/models/current");

	const session = await createSession("auto-flow");
	const created = await api<SessionModelView>("GET", `/api/sessions/${session.id}`);
	assert(created.status === 200,
		`新建会话可读（HTTP ${created.status}）`);
	assert(created.data.mode === models.data.mode,
		`会话的 mode 与实例一致（${String(created.data.mode)} / ${String(models.data.mode)}）`);

	if (models.data.mode === "simulated") {
		// 未配置的模型标识必须拒绝；模拟实例仍可保存模型页中已配置模型的选择状态。
		const refused = await api<{ error?: string }>("POST", `/api/sessions/${session.id}/model`, {
			modelId: "whatever-model",
		});
		assert(refused.status === 400,
			`模拟实例上换模型返回 400 而不是假装成功（HTTP ${refused.status}）`);
		assert(String(refused.data.error ?? "").includes("模型当前不可用"),
			`拒绝文案说明模型不可用（${String(refused.data.error)}）`);
	} else {
		// 真实实例：临时建两条独立的对话模型（不复用用户已有模型，也不改它们的启用状态）
		const provider = models.data.providers.find((item) => item.enabled !== false);
		assert(provider !== undefined, "有可用的供应商用来建临时模型");
		const stamp = Date.now().toString(36);
		const providers = await api<{ items: ProviderView[] }>("GET", "/api/models/providers");
		const owner = providers.data.items.find((item) => item.id === provider?.id);
		const madeA = await api<ModelView>("POST", "/api/models", {
			providerId: owner?.id,
			modelId: owner?.kind === "deepseek" ? "deepseek-v4-pro" : "smoke-chat-a",
			name: `冒烟对话模型-A-${stamp}`,
			kind: "chat",
			enabled: true,
		});
		const madeB = await api<ModelView>("POST", "/api/models", {
			providerId: owner?.id,
			modelId: owner?.kind === "deepseek" ? "deepseek-chat" : "smoke-chat-b",
			name: `冒烟对话模型-B-${stamp}`,
			kind: "chat",
			enabled: true,
		});
		assert(madeA.status === 201 && madeB.status === 201,
			`临时建出两条对话模型（HTTP ${madeA.status} / ${madeB.status}）`);

		// --- 切到 A：会话记住的是模型行 id（重启后才能按它重新解析） ---
		const toA = await api<ModelSwitchView>("POST", `/api/sessions/${session.id}/model`, {
			modelId: madeA.data.id,
		});
		assert(toA.status === 200 && toA.data.session.modelKey === madeA.data.id,
			`切换后会话记的是模型行 id（${String(toA.data.session.modelKey)}）`);
		assert(toA.data.session.modelId === madeA.data.modelId,
			`切换后会话用的是该模型的 modelId（${String(toA.data.session.modelId)}）`);
		assert(Array.isArray(toA.data.models) && toA.data.models.length > 0,
			`返回体带可选模型列表，页面不用再请求一次（${toA.data.models?.length ?? 0} 条）`);

		// --- 核心：全局当前模型没被动过 ---
		const globalAfter = await api<{ current?: string }>("GET", "/api/models/current");
		assert(globalAfter.data.current === globalBefore.data.current,
			`会话级换模型不动全局当前模型（${String(globalBefore.data.current)} → ${String(globalAfter.data.current)}）`);

		// --- 落库：重新 GET 回来的还是 A（这就是「重启后仍是这个模型」的那一半） ---
		const reget = await api<SessionModelView>("GET", `/api/sessions/${session.id}`);
		assert(reget.data.modelKey === madeA.data.id && reget.data.modelId === madeA.data.modelId,
			`重新读取会话仍是切换后的模型（${String(reget.data.modelKey)}）`);

		// --- 隔离：另一条会话不受影响 ---
		const other = await createSession("auto-flow");
		const otherView = await api<SessionModelView>("GET", `/api/sessions/${other.id}`);
		assert(otherView.data.modelKey !== madeA.data.id,
			`别的会话没有被一起换掉（另一条记的是 ${String(otherView.data.modelKey)}）`);

		// --- 核心：重建会话后仍是切后的模型（= 重启服务后重进对话的口径） ---
		//
		// 为什么单独钉这一条：会话从前是拿 payload 里的 `modelId`(显示名快照) 当解析依据的，
		// 那是个显示用的字符串，重启后会解析回旧模型——「换完重启又变回去」就是这么来的。
		// 走 DELETE 接口的会话级重建会从库里重新 load 会话，正是这条路径的回归口。
		const rebuilt = await api<SessionModelView>("POST", "/api/sessions", {
			workflowId: "auto-flow",
			modelId: madeA.data.id,
		});
		assert(rebuilt.status === 201 && rebuilt.data.modelKey === madeA.data.id,
			`带 modelId 建会话时记的是模型行 id（${String(rebuilt.data.modelKey)}）`);
		const reloaded = await api<SessionModelView>("GET", `/api/sessions/${rebuilt.data.id}`);
		assert(reloaded.data.modelKey === madeA.data.id && reloaded.data.modelId === madeA.data.modelId,
			`重建会话后仍解析回同一个模型（key=${String(reloaded.data.modelKey)} / modelId=${String(reloaded.data.modelId)}）`);
		await api("DELETE", `/api/sessions/${rebuilt.data.id}`);

		// --- 再切到 B：同一条会话可以换第二次，且落库跟上 ---
		const toB = await api<ModelSwitchView>("POST", `/api/sessions/${session.id}/model`, {
			modelId: madeB.data.id,
		});
		assert(toB.status === 200 && toB.data.session.modelKey === madeB.data.id,
			`再次切换后记的是新模型行（${String(toB.data.session.modelKey)}）`);

		// --- 入参校验：不存在的模型 / 空 modelId ---
		const unknownModel = await api<{ error?: string }>("POST", `/api/sessions/${session.id}/model`, {
			modelId: "model-does-not-exist",
		});
		assert(unknownModel.status === 400,
			`库里没有的模型返回 400（HTTP ${unknownModel.status}）`);

		// 清掉两条临时模型（会话模型会退回模拟/当前模型，用例不依赖它们活着）
		await api("DELETE", `/api/models/${madeA.data.id}`);
		await api("DELETE", `/api/models/${madeB.data.id}`);
	}

	// --- 入参校验（两种实例都要过）：空 modelId 400、未知会话 404 ---
	const empty = await api<{ error?: string }>("POST", `/api/sessions/${session.id}/model`, {});
	assert(empty.status === 400, `缺 modelId 返回 400（HTTP ${empty.status}）`);

	const missing = await api<{ error?: string }>("POST", "/api/sessions/no-such-session/model", {
		modelId: "x",
	});
	assert(missing.status === 404, `未知会话返回 404（HTTP ${missing.status}）`);

	await api("DELETE", `/api/sessions/${session.id}`);
}
async function scenarioPlugins(): Promise<void> {
	console.log("\n[I] 插件（清单导入 / 技能注册 / 启停 / 卸载）");
	const manifest = { schemaVersion: "biz-agent.plugin.v1", id: "smoke-plugin", name: "冒烟插件", version: "1.0.0", description: "隔离 smoke 插件", skills: [{ id: "helper", name: "插件助手", systemPrompt: "按插件说明协助用户。", description: "检查插件技能", instructions: "只处理测试请求。", steps: [] }] };
	const imported = await api<{ id?: string; skills?: string[] }>("POST", "/api/plugins/import", { manifest });
	assert(imported.status === 201 && imported.data.id === manifest.id && imported.data.skills?.includes("插件助手") === true, "插件清单导入成功并返回技能名称（HTTP " + imported.status + "）");
	const skillId = "plugin-smoke-plugin-helper";
	const skills = await api<{ id: string }[]>("GET", "/api/skills");
	assert(skills.status === 200 && skills.data.some((skill) => skill.id === skillId), "导入技能进入 /api/skills 技能目录");
	const listed = await api<{ items?: { id: string; enabled: boolean }[] }>("GET", "/api/plugins");
	assert(listed.status === 200 && listed.data.items?.some((plugin) => plugin.id === manifest.id && plugin.enabled) === true, "插件列表返回已启用插件");
	const disabled = await api<{ enabled?: boolean }>("PATCH", "/api/plugins/" + manifest.id, { enabled: false });
	assert(disabled.status === 200 && disabled.data.enabled === false, "停用插件成功");
	const afterDisable = await api<{ id: string }[]>("GET", "/api/skills");
	assert(!afterDisable.data.some((skill) => skill.id === skillId), "停用插件后技能不再出现在目录");
	const enabled = await api<{ enabled?: boolean }>("PATCH", "/api/plugins/" + manifest.id, { enabled: true });
	assert(enabled.status === 200 && enabled.data.enabled === true, "重新启用插件成功");
	const bad = await api<{ error?: string }>("POST", "/api/plugins/import", { manifest: { ...manifest, id: "bad-plugin", mcpServers: [{ name: "unsafe", transport: "stdio", command: "node" }] } });
	assert(bad.status === 400, "插件清单拒绝本地 stdio 命令");
	const removed = await api<{ removed?: boolean }>("DELETE", "/api/plugins/" + manifest.id);
	assert(removed.status === 200 && removed.data.removed === true, "卸载插件成功");
	const afterRemove = await api<{ id: string }[]>("GET", "/api/skills");
	assert(!afterRemove.data.some((skill) => skill.id === skillId), "卸载后移除插件技能");
	const piSkillMarkdown = "---\nname: sales-analysis\ndescription: Analyze sales records and summarize trends\n---\n\nReview relevant sales data, state assumptions, and summarize the observed trends.";
	const piSkill = await api<{ id?: string; skills?: string[] }>("POST", "/api/plugins/import-pi-skill", { markdown: piSkillMarkdown });
	assert(piSkill.status === 201 && piSkill.data.id === "pi-skill-sales-analysis" && piSkill.data.skills?.includes("sales-analysis") === true, "Pi SKILL.md 通过 Pi frontmatter 解析并安装成插件技能");
	const piSkills = await api<{ id: string; name: string; description: string }[]>("GET", "/api/skills");
	assert(piSkills.status === 200 && piSkills.data.some((skill) => skill.id === "plugin-pi-skill-sales-analysis-sales-analysis" && skill.description === "Analyze sales records and summarize trends"), "Pi 技能元数据进入业务技能目录");
	const malformedPiSkill = await api<{ error?: string }>("POST", "/api/plugins/import-pi-skill", { markdown: "---\nname: [invalid\ndescription: broken\n---\nbody" });
	assert(malformedPiSkill.status === 400, "Pi 技能非法 YAML 有明确错误");
	const longPiSkill = await api<{ error?: string }>("POST", "/api/plugins/import-pi-skill", { markdown: "---\nname: too-long\ndescription: long body test\n---\n\n" + "x".repeat(4001) });
	assert(longPiSkill.status === 400, "Pi 技能正文超过技能存储上限时拒绝导入");
	const duplicatePiSkill = await api<{ error?: string }>("POST", "/api/plugins/import-pi-skill", { markdown: piSkillMarkdown });
	assert(duplicatePiSkill.status === 409, "Pi 技能重复安装返回冲突");
	await api("DELETE", "/api/plugins/pi-skill-sales-analysis");
}

async function main(): Promise<void> {
	console.log(`冒烟测试目标: ${BASE}`);
	const summary: string[] = [];
	const runScenario = async (label: string, scenario: () => Promise<void>): Promise<void> => {
		const before = assertions;
		await scenario();
		summary.push(`${label} ${assertions - before} 项`);
	};

	await runScenario("A 工单流程", scenarioTicket);
	await runScenario("B 审批流程", scenarioApproval);
	await runScenario("C 健康检查与重命名", scenarioHealthAndRename);
	await runScenario("D 运行时流程", scenarioRuntimeWorkflow);
	await runScenario("E 会话归档", scenarioArchive);
	await runScenario("F 技能", scenarioSkills);
	await runScenario("G 知识库 RAG", scenarioKnowledgeBase);
	await runScenario("G2 向量模型接通知识库", scenarioEmbeddingModelWiring);
	await runScenario("H 审批中心", scenarioApprovalCenter);
	await runScenario("I 插件", scenarioPlugins);
	await runScenario("J 会话级模型", scenarioSessionModel);

	console.log(`\n冒烟测试全部通过：${assertions} 项断言（${summary.join("、")}）`);
	process.exit(0);
}

main().catch((error: unknown) => {
	fail(error instanceof Error ? error.message : String(error));
});
