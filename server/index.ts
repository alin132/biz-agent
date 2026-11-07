/**
 * 极简 HTTP 服务：只依赖 node 标准库，无框架、无构建步骤。
 *
 * 路由：
 *   GET    /api/health                  存活探针 { ok, uptimeMs, sessions, model, storage }
 *   GET    /api/workflows               流程清单（内置 + 自定义）
 *   GET    /api/workflows/:id           流程详情（流程编辑器用）
 *   POST   /api/workflows               新建自定义流程 { name, systemPrompt, steps, skill? }
 *   PATCH  /api/workflows/:id           编辑自定义流程（内置流程 403）
 *   DELETE /api/workflows/:id           删除自定义流程（内置流程 403）
 *                                       连带删除它的会话（`sessionsRemoved`），
 *                                       并让别的会话退出这条技能（`skillsCleared`）
 *   （skill? = { description, instructions }，给「技能区」写的一句话触发条件与正文；
 *     不传也能当技能用，正文回落 systemPrompt。传 null 表示清空技能文案。）
 *   GET    /api/tools                   工具目录（步骤里 via 可选的工具）
 *   GET    /api/models                  当前模型 + 可用模型 + 供应商/模型（P6）
 *   GET/POST/PATCH/DELETE /api/models/providers[/:id]   供应商（API Key 只回掩码）
 *   POST   /api/models/:id/ping          连通性探测 { ok, latencyMs, error? }
 *   GET/POST /api/models/current         读/切当前模型 { modelId }
 *   POST/PATCH/DELETE /api/models[/:id] 模型（P6）
 *   GET/POST /api/api-keys              开放 API 的 Key（POST 只返回一次明文 bk_）
 *   PATCH/DELETE /api/api-keys/:id       改属性 / 吊销（P4）
 *   GET/POST /api/mcp/servers            MCP 服务列表 / 注册（P7，注册即 initialize + tools/list）
 *   GET/PATCH/DELETE /api/mcp/servers/:id
 *   POST   /api/mcp/servers/:id/refresh  重新发现工具
 *   GET    /api/mcp/servers/:id/tools    发现到的工具（含启停状态）
 *   POST   /api/mcp/servers/:id/call     直接调用一次 MCP 工具
 *   PATCH  /api/mcp/tools/:id            工具启停 { enabled }
 *   GET/POST /api/im/bots                IM 机器人（凭证只回掩码）
 *   GET/PATCH/DELETE /api/im/bots/:id    机器人详情 / 改 / 删（连带删会话映射）
 *   POST   /api/im/bots/:id/ping         发一条测试消息（fake 传输时进 outbox）
 *   POST   /api/im/dingtalk/callback     钉钉回调（免登录：加签或 AES 加密）
 *   GET    /api/im/outbox                仅 DINGTALK_TRANSPORT=fake 可用
 *   GET    /v1/health                   开放 API 探针（免鉴权）
 *   POST   /v1/chat                     开放 API 对话（Bearer API Key；非流式 + SSE 流式）
 *   POST   /api/sessions                创建会话 { workflowId, modelId? }
 *   GET    /api/sessions                会话列表（含 SQLite 历史）
 *   DELETE /api/sessions                清空全部会话
 *   GET    /api/sessions/:id            会话快照（必要时从 SQLite 恢复）
 *   PATCH  /api/sessions/:id            重命名会话 { title }
 *   DELETE /api/sessions/:id            删除会话
 *   GET    /api/sessions/:id/events     SSE 事件流
 *   POST   /api/sessions/:id/messages   发送消息 { text }
 *   POST   /api/sessions/:id/approve    审批决定 { requestId, approved }
 *   GET    /api/approvals               审批中心：全局挂起中的审批 { items, total }
 *   POST   /api/approvals/:sessionId    在审批中心处理某条审批 { requestId, approved }
 *   POST   /api/sessions/:id/model       会话级换模型 { modelId }（不动全局当前模型）
 *   POST   /api/sessions/:id/permissions 权限模式 { mode }
 *   POST   /api/sessions/:id/skills      加载/退出技能 { skillId: string | null }
 *   POST   /api/sessions/:id/model       会话级换模型 { modelId }
 *   POST   /api/sessions/:id/plan        计划模式开关 { enabled }
 *   POST   /api/sessions/:id/compact     压缩上下文（旧消息总结成摘要）
 *   GET    /api/skills                  技能目录（内置流程 + 自定义流程都能当技能）
 *   POST   /api/auth/login              登录 { email, password } → { token, user }
 *   POST   /api/auth/logout             退出（无状态 JWT，仅语义端点）→ { ok: true }
 *   GET    /api/auth/me                 当前用户 + 权限矩阵（AUTH_MODE=off 返回演示所有者）
 *   GET    /api/auth/users              成员列表（owner）｜POST 建成员 { email, password, role, name? }
 *   GET    /api/audit                   审计倒序列表 ?limit&offset&action&actor&actorType&targetType&from&to&q
 *   GET    /api/monitor/summary         监控首页聚合 ?range=24h（会话/消息/工具/技能/MCP/模型/p95）
 *   GET    /api/monitor/traces          调用链倒序列表 ?limit&offset&sessionId
 *   GET    /api/monitor/traces/:id      调用链详情（trace + events，不存在 404）
 *   其余                                静态资源（web/）
 */

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { handleAuthRoute } from "./auth/routes.js";
import { initAuth } from "./auth/service.js";
import { createApiKeyService } from "./apiKeys/service.js";
import { handleApiKeysRoute } from "./apiKeys/routes.js";
import { openStore } from "./db/index.js";
import { loadEnvFile } from "./env.js";
import { initIm } from "./im/index.js";
import { handleKb, initKb } from "./kb/index.js";
import { supportedKeyEnvs } from "./llm.js";
import { initMcp } from "./mcp/index.js";
import { handleModelsRoute } from "./models/routes.js";
import { handleAgents } from "./agents/routes.js";
import { AgentService } from "./agents/service.js";
import { initModels } from "./models/service.js";
import { PluginService, handlePluginRoute } from "./plugins/service.js";
import { createObservability, handleMonitorRoute } from "./observability/index.js";
import { handleOpenApiRoute } from "./openapi/routes.js";
import { SessionHub } from "./session.js";
import { WorkflowHttpError, WorkflowRepo } from "./workflows.js";

loadEnvFile();

/**
 * 静态资源根：优先用 Vite 构建产物（client/dist），没有就回落到旧的原生控制台（web/）。
 *
 * 为什么这样做：前端正在从「原生 JS 零构建」迁到 Vue + Naive UI，
 * 两种形态要能长期共存——构建产物不在（没跑 build、或回退排查）时服务照样能开，
 * 不会因为缺一个 dist 就把整个控制台变 404。
 */
const WEB_LEGACY_DIR = resolve(fileURLToPath(new URL("../web/", import.meta.url)));
const WEB_DIST_DIR = resolve(fileURLToPath(new URL("../client/dist/", import.meta.url)));
const WEB_DIR = existsSync(join(WEB_DIST_DIR, "index.html")) ? WEB_DIST_DIR : WEB_LEGACY_DIR;
const PORT = Number(process.env.PORT ?? 4317);
const DATA_DIR = resolve(fileURLToPath(new URL("../data/", import.meta.url)));
const DB_PATH = process.env.DB_PATH ? resolve(process.env.DB_PATH) : join(DATA_DIR, "biz-agent.db");

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".json": "application/json; charset=utf-8",
};

const startedAt = Date.now();
// 存储后端由 DATABASE_URL 决定（有则 Postgres，无则 SQLite）；DB_PATH 只在 SQLite 分支生效
const db = openStore({ dbPath: DB_PATH });
// MCP 集成（P7）：把 MCP 工具接进平台工具目录（/api/tools、自动编排会话、技能 via 校验同一份）。
// 必须在 WorkflowRepo 之前初始化：注册表会先用库里"上次发现到的工具"重建快照，
// 这样已有的技能引用 MCP 工具时不会在启动校验里被误判成 broken（真正的握手随后异步做）。
// 初始化只建注册表，真正的 initialize + tools/list 在监听之后异步做，避免卡死的 MCP 服务拖住启动。
const mcp = initMcp({
	db,
	onLog: (message) => console.log(message),
});
const repo = new WorkflowRepo(db);
// 多模型管理（P6）：首次启动用 .env 的 key 兜底建 default 供应商；当前模型注入给会话构造
const models = initModels({ storage: db });
// 开放 API 的 API Key（P4）：库 + 令牌桶
const apiKeys = createApiKeyService(db);
// Agent 实体（P10）：六维配置 + 状态机。只依赖存储层，不碰会话——Agent 是"配置"，
// 会话是"运行实例"，两者解耦，别把会话搬进来。
const agents = new AgentService({ storage: db });
// 监控与可观测（P9）：每轮消息一条调用链 + 批量落 trace_events；不传存储以外的东西，
// MCP 服务名解析通过注册表查（可观测模块本身不依赖 MCP）。
const observability = createObservability({
	storage: db,
	// 调用链保留天数（默认 30 天；0 = 永不清理）
	retentionDays: Number(process.env.TRACE_RETENTION_DAYS ?? 30),
	resolveMcpServer: (toolName) => {
		for (const server of mcp.registry.listServers()) {
			if (server.tools.some((tool) => tool.toolName === toolName)) {
				return server.name;
			}
		}
		return undefined;
	},
});
// 会话级模型：resolveRuntime 决定这一轮到底用哪个真实模型，resolveModelKey 决定会话记的是哪一行。
// 两者都交给 models 模块，会话层不自己去认模型表。
const hub = new SessionHub(
	db,
	repo,
	(modelId) => models.resolveRuntime(modelId),
	observability,
	(modelId) => models.modelKeyOf(modelId),
);
const plugins = new PluginService(db, repo, mcp.registry, hub);
const storage = db.info();
// 鉴权：AUTH_MODE 未设置时是 off（全部放行，行为与 P2 一致）；required 时验 Bearer 令牌 + 四角色矩阵
const auth = initAuth(db);
// IM Bot 网关（P8）：机器人凭证（AES 加密）+ 钉钉回调（加签/AES）+ 出站（fake outbox / 真 https）
const im = initIm({ storage: db, hub });
// 知识库：启动时建表（幂等），表与会话库同一个 SQLite 文件。
// 向量模型优先用模型页那条「向量」模型，没配才回落到 EMBEDDING_* 环境变量（每次调用现读，改完即时生效）
initKb({
	dbPath: DB_PATH,
	resolveEmbedding: () => {
		const config = models.embeddingConfig();
		return config ? { modelKey: config.modelKey, config: { baseUrl: config.baseUrl, model: config.modelId, apiKey: config.apiKey } } : null;
	},
});

function json(res: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(payload),
	});
	res.end(payload);
}

/** 请求体不合法（目前只有 JSON 解析失败）：由路由层统一转成 400，而不是 500。 */
class BadRequestError extends Error {}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		chunks.push(chunk as Buffer);
	}
	const raw = Buffer.concat(chunks).toString("utf8");
	if (raw.length === 0) {
		return {};
	}
	try {
		return JSON.parse(raw) as Record<string, unknown>;
	} catch {
		throw new BadRequestError("请求体不是合法 JSON");
	}
}

async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
	const relative = pathname === "/" ? "index.html" : pathname.slice(1);
	const target = resolve(join(WEB_DIR, normalize(relative)));
	if (!target.startsWith(WEB_DIR)) {
		json(res, 403, { error: "forbidden" });
		return;
	}
	try {
		const data = await readFile(target);
		res.writeHead(200, {
			"Content-Type": MIME[extname(target)] ?? "application/octet-stream",
			// 控制台没有构建步骤，前端文件改完要能被浏览器立刻拿到；不做缓存协商，省一次 hard refresh
			"Cache-Control": "no-cache",
		});
		res.end(data);
	} catch {
		json(res, 404, { error: "not found" });
	}
}

function handleEvents(session: ReturnType<SessionHub["get"]>, req: IncomingMessage, res: ServerResponse): void {
	if (!session) {
		json(res, 404, { error: "session not found" });
		return;
	}

	res.writeHead(200, {
		"Content-Type": "text/event-stream; charset=utf-8",
		"Cache-Control": "no-cache, no-transform",
		Connection: "keep-alive",
		"X-Accel-Buffering": "no",
	});

	const write = (event: unknown) => {
		res.write(`data: ${JSON.stringify(event)}\n\n`);
	};

	write({ type: "ready", session: session.view() });
	const unsubscribe = session.subscribe(write);
	const ping = setInterval(() => res.write(": ping\n\n"), 15000);

	req.on("close", () => {
		clearInterval(ping);
		unsubscribe();
	});
}

const server = createServer((req, res) => {
	// 路径与方法在 IIFE 外取一次：请求收尾落审计时还要用（只读，不影响下面的路由分派）
	const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
	const pathname = url.pathname;
	const method = req.method ?? "GET";

	void (async () => {
		// ---- 开放 API（/v1/*）：自带走 Bearer API Key 鉴权，必须在静态资源分支之前接管 ----
		if (
			await handleOpenApiRoute(req, res, url, {
				storage: db,
				auth,
				hub,
				models,
				apiKeys,
				startedAt,
				storageInfo: storage,
			})
		) {
			return;
		}

		// ---- 静态资源 ----
		if (!pathname.startsWith("/api/")) {
			await serveStatic(pathname, res);
			return;
		}

		// ---- 鉴权：AUTH_MODE=off 时挂演示所有者直接放行；required 时验令牌 + 角色矩阵 ----
		const denied = auth.guard(req, method, pathname);
		if (denied) {
			json(res, denied.status, { error: denied.error });
			return;
		}

		// ---- IM Bot 网关（/api/im*）：机器人凭证 + 钉钉回调 + fake outbox ----
		// 钉钉回调在 auth.guard 的公开白名单里（外部服务器没有内部令牌），其余接口照常过权限矩阵。
		if (await im.handle(req, res, url)) {
			return;
		}

		// ---- 认证与审计接口（/api/auth/*、/api/audit） ----
		if (await handleAuthRoute(req, res, url, auth)) {
			return;
		}

		// ---- 监控与可观测（/api/monitor*）：summary / 调用链列表 / 详情 ----
		if (await handleMonitorRoute(req, res, url, { observability, storage: db, auth })) {
			return;
		}

		// ---- 知识库接口（/api/kb*）：模块自包含，内部自己解析 URL 与请求体 ----
		if (await handleKb(req, res)) {
			return;
		}

		// ---- 多模型管理（/api/models*）：供应商 / 模型 / 当前模型 / 连通性探测 ----
		if (await handleModelsRoute(req, res, url, models)) {
			return;
		}

		// ---- Agent 实体（/api/agents*）：六维配置 CRUD + 状态机动作 ----
		if (await handleAgents(req, res, agents)) {
			return;
		}

		// ---- 开放 API 的 Key 管理（/api/api-keys*） ----
		if (await handleApiKeysRoute(req, res, url, apiKeys)) {
			return;
		}

		// ---- MCP 集成（/api/mcp*）：注册 / 发现 / 调用 / 工具启停 ----
		if (await mcp.handle(req, res, url, auth)) {
			return;
		}
		if (await handlePluginRoute(req, res, url, plugins, auth)) {
			return;
		}

		// ---- API ----
		if (pathname === "/api/health" && method === "GET") {
			// model 的形状与 P2 完全一致（{ mode, id, label }），只是现在可能来自库里的当前模型
			json(res, 200, {
				ok: true,
				uptimeMs: Date.now() - startedAt,
				sessions: hub.count(),
				model: models.healthModel(),
				// 存储后端观测字段：kind 决定"跑的是哪条 DAO"，detail 是库文件路径或 host:port/db
				storage,
				// 鉴权模式观测字段：off = 全部放行（默认），required = 要 Bearer 令牌
				auth: auth.mode,
			});
			return;
		}

		if (pathname === "/api/workflows" && method === "GET") {
			json(res, 200, repo.list());
			return;
		}

		if (pathname === "/api/tools" && method === "GET") {
			json(res, 200, repo.toolSummaries());
			return;
		}

		if (pathname === "/api/skills" && method === "GET") {
			// 技能目录：内置流程与自定义流程都能当技能加载，控制台用它画技能选择器
			json(
				res,
				200,
				repo.skills().map((skill) => ({
					id: skill.id,
					name: skill.name,
					description: skill.description,
					steps: skill.steps.length,
					tools: skill.tools,
					builtin: repo.isBuiltin(skill.id),
					readonly: repo.isReadOnly(skill.id),
				})),
			);
			return;
		}

		if (pathname === "/api/workflows" && method === "POST") {
			const body = await readBody(req);
			json(res, 201, repo.create(body));
			return;
		}

		const workflowMatch = /^\/api\/workflows\/([^/]+)$/.exec(pathname);
		if (workflowMatch) {
			let workflowId: string;
			try {
				workflowId = decodeURIComponent(workflowMatch[1]!);
			} catch {
				json(res, 400, { error: "流程 id 不是合法的 URL 编码" });
				return;
			}
			if (method === "GET") {
				json(res, 200, repo.detail(workflowId));
				return;
			}
			if (method === "PATCH") {
				const body = await readBody(req);
				json(res, 200, repo.update(workflowId, body));
				return;
			}
			if (method === "DELETE") {
				// 删流程 = 连它的会话一起删（否则这些会话找不到流程，会从列表里凭空消失）；
				// 再清掉别的会话里"正挂着这条技能"的引用，让它们退回自己的流程
				repo.remove(workflowId);
				const sessionsRemoved = hub.removeByWorkflow(workflowId);
				const skillsCleared = hub.detachSkill(workflowId);
				json(res, 200, { removed: true, sessionsRemoved, skillsCleared });
				return;
			}
		}

		if (pathname === "/api/sessions" && method === "GET") {
			json(res, 200, hub.list());
			return;
		}

		if (pathname === "/api/sessions" && method === "POST") {
			const body = await readBody(req);
			const workflowId = String(body.workflowId ?? "");
			// 不指定就用"当前模型"（P6）；指定时既可以是库里的模型行 id，也可以是供应商的 modelId
			let modelId =
				typeof body.modelId === "string" && body.modelId.trim() ? body.modelId.trim() : models.currentModelKey();
			// 跟某个 Agent 对话：六维配置在这里落地成一次真实会话（模型 / 人格 / 能力绑定）
			const agentId = typeof body.agentId === "string" && body.agentId.trim() ? body.agentId.trim() : "";
			let agent: import("./session.js").SessionAgent | undefined;
			if (agentId) {
				const record = db.getAgent(agentId);
				if (!record) {
					json(res, 404, { error: `未知 Agent: ${agentId}` });
					return;
				}
				// 状态机硬规则：停用的 Agent 不能对话（与 service.assertChattable 同一语义，不重复实现）
				try {
					agents.assertChattable(record.id);
				} catch (error) {
					json(res, 409, {
						error: error instanceof Error ? error.message : String(error),
						code: "stopped_not_chattable",
					});
					return;
				}
				agent = {
					id: record.id,
					name: record.name,
					prompt: record.agentsMd,
					skillIds: record.skillIds,
					kbIds: record.kbIds,
					modelConfig: record.modelConfig,
					memoryConfig: record.memoryConfig,
					advancedConfig: record.advancedConfig,
				};
				// 未显式指定模型时，用 Agent 自己的模型策略（这就是"配置生效"的地方）
				if (!(typeof body.modelId === "string" && body.modelId.trim()) && record.modelConfig.chatModelId) {
					modelId = record.modelConfig.chatModelId;
				}
			}
			try {
				// ownerId 落进会话 payload：developer 在监控页只能看到自己创建的会话调用链
				const session = hub.create(workflowId, {
					modelId,
					ownerId: auth.userOf(req)?.id ?? null,
					agent,
				});
				json(res, 201, session.view());
			} catch (error) {
				json(res, 400, { error: error instanceof Error ? error.message : String(error) });
			}
			return;
		}

		if (pathname === "/api/sessions" && method === "DELETE") {
			json(res, 200, { removed: hub.clear() });
			return;
		}

		const sessionMatch = /^\/api\/sessions\/([^/]+)(\/[a-z]+)?$/.exec(pathname);
		if (sessionMatch) {
			const session = hub.get(sessionMatch[1]!);
			const action = sessionMatch[2] ?? "";

			if (action === "" && method === "DELETE") {
				json(res, hub.remove(sessionMatch[1]!) ? 200 : 404, { removed: Boolean(session) });
				return;
			}

			if (!session) {
				json(res, 404, { error: "session not found" });
				return;
			}

			if (action === "" && method === "GET") {
				json(res, 200, session.view());
				return;
			}

			if (action === "" && method === "PATCH") {
				const body = await readBody(req);
				// 重命名与归档共用这个入口：传哪个改哪个，两个都能不传就算错误请求。
				const hasTitle = "title" in body;
				const hasArchived = "archived" in body;
				if (!hasTitle && !hasArchived) {
					json(res, 400, { error: "至少要传 title 或 archived" });
					return;
				}
				if (hasTitle && typeof body.title !== "string") {
					json(res, 400, { error: "title must be a string" });
					return;
				}
				if (hasArchived && typeof body.archived !== "boolean") {
					json(res, 400, { error: "archived must be a boolean" });
					return;
				}
				const title = hasTitle ? session.setTitle(body.title as string) : session.view().title;
				const archived = hasArchived
					? session.setArchived(body.archived as boolean)
					: session.view().archived;
				json(res, 200, { title, archived });
				return;
			}

			if (action === "/events" && method === "GET") {
				handleEvents(session, req, res);
				return;
			}

			if (action === "/messages" && method === "POST") {
				try { session.assertChattable(); } catch (error) {
					json(res, 409, { error: error instanceof Error ? error.message : String(error), code: "stopped_not_chattable" });
					return;
				}
				const body = await readBody(req);
				const text = String(body.text ?? "").trim();
				if (text.length === 0) {
					json(res, 400, { error: "text is required" });
					return;
				}
				// 立即返回，正文通过 SSE 推送
				json(res, 202, { accepted: true });
				void session.send(text);
				return;
			}

			if (action === "/stop" && method === "POST") {
				json(res, 200, { stopped: session.stop() });
				return;
			}

			if (action === "/approve" && method === "POST") {
				const body = await readBody(req);
				const requestId = String(body.requestId ?? "");
				const approved = body.approved === true;
				const ok = session.resolveApproval(requestId, approved);
				json(res, ok ? 200 : 404, { resolved: ok });
				return;
			}

			// 会话级换模型：只影响这一条会话。全局「当前模型」（POST /api/models/current）管的是
			// 「之后新建的会话用哪条模型」，拿它当会话内切换会把别的会话一起换掉，是另一件事。
			if (action === "/model" && method === "POST") {
				const body = await readBody(req);
				const modelId = typeof body.modelId === "string" ? body.modelId.trim() : "";
				if (modelId.length === 0) {
					json(res, 400, { error: "modelId 必须是非空字符串" });
					return;
				}
				try {
					const view = session.setModel(modelId);
					json(res, 200, {
						session: view,
						modelId: view.modelId,
						modelKey: view.modelKey ?? null,
						mode: view.mode,
						modeLabel: view.modeLabel,
						// 列表一起回：页面切完模型正好用它重画下拉，省一次往返
						models: models.options(),
					});
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					// 这一轮还在跑（换模型会让同一轮前后两次请求用不同模型）：409，让界面提示稍后再试
					json(res, message.includes("正在执行中") ? 409 : 400, { error: message });
				}
				return;
			}

			if (action === "/permissions" && method === "POST") {
				const body = await readBody(req);
				const mode = body.mode === "readonly" ? "readonly" : "full";
				json(res, 200, { permissionMode: session.setPermissionMode(mode) });
				return;
			}

			if (action === "/plan" && method === "POST") {
				// 计划模式：会话级开关，落进 payload 才能跨重启保持
				const body = await readBody(req);
				if (typeof body.enabled !== "boolean") {
					json(res, 400, { error: "enabled 必须是布尔值" });
					return;
				}
				try {
					json(res, 200, session.setPlanMode(body.enabled));
				} catch (error) {
					json(res, 409, { error: error instanceof Error ? error.message : String(error) });
				}
				return;
			}

			if (action === "/compact" && method === "POST") {
				// 压缩上下文：把旧消息总结成一段，历史换成「摘要 + 最近 N 条」
				try {
					json(res, 200, await session.compact());
				} catch (error) {
					json(res, 409, { error: error instanceof Error ? error.message : String(error) });
				}
				return;
			}

			if (action === "/skills" && method === "POST") {
				// 加载技能（skillId 是字符串）或退出技能（skillId: null）
				const body = await readBody(req);
				if (!("skillId" in body) || (body.skillId !== null && typeof body.skillId !== "string")) {
					json(res, 400, { error: "skillId 必须是字符串或 null" });
					return;
				}
				try {
					if (body.skillId === null) {
						session.clearSkill();
					} else {
						session.activateSkill(body.skillId as string);
					}
				} catch (error) {
					json(res, 400, { error: error instanceof Error ? error.message : String(error) });
					return;
				}
				const view = session.view();
				json(res, 200, {
					activeSkillId: view.activeSkillId,
					tools: view.tools,
					skills: view.skills,
					steps: view.steps,
					current: view.current,
					done: view.done,
				});
				return;
			}
		}

		// 审批中心（全局待办）：跨会话合并挂起中的审批。
		// 会话级 POST /api/sessions/:id/approve 保留不动（向后兼容），两条入口最终都走 resolveApproval。
		if (pathname === "/api/approvals" && method === "GET") {
			const items = hub.pendingApprovals();
			json(res, 200, { items, total: items.length });
			return;
		}

		const approvalMatch = /^\/api\/approvals\/([^/]+)$/.exec(pathname);
		if (approvalMatch && method === "POST") {
			// 先确认会话存在（404），再校验入参（400），最后才看这条审批还活着没（409）
			const session = hub.get(approvalMatch[1]!);
			if (!session) {
				json(res, 404, { error: "会话不存在" });
				return;
			}
			const body = await readBody(req);
			const requestId = body.requestId;
			if (typeof requestId !== "string" || requestId.length === 0) {
				json(res, 400, { error: "requestId 必须是非空字符串" });
				return;
			}
			if (typeof body.approved !== "boolean") {
				json(res, 400, { error: "approved 必须是布尔值" });
				return;
			}
			if (!session.resolveApproval(requestId, body.approved)) {
				// 不存在 / 已批 / 已拒：统一按"处理过了"回 409，让界面刷新待办而不是报错
				json(res, 409, { error: "这条审批已经处理过了" });
				return;
			}
			json(res, 200, { ok: true, resolved: true, sessionId: session.id, requestId });
			return;
		}

		json(res, 404, { error: "not found" });
	})().then(
		// 请求收尾：写操作统一落一条审计（成功与被拦都记，状态码进 detail）
		() => auth.recordWriteAudit(req, method, pathname, res.statusCode),
		(error: unknown) => {
			const status =
				error instanceof BadRequestError
					? 400
					: error instanceof WorkflowHttpError
						? error.status
						: 500;
			json(res, status, { error: error instanceof Error ? error.message : String(error) });
			auth.recordWriteAudit(req, method, pathname, status);
		},
	);
});

server.listen(PORT, () => {
	const llm = models.currentRuntime();
	console.log(`biz-agent web 已启动: http://127.0.0.1:${PORT}`);
	console.log(`会话库: ${storage.kind === "postgres" ? "Postgres" : "SQLite"}（${storage.detail}）`);
	console.log(
		`鉴权: ${auth.mode === "required" ? "AUTH_MODE=required（登录 + Bearer 令牌 + 四角色）" : "AUTH_MODE=off（默认，全部放行）"}`,
	);
	if (llm) {
		console.log(`模型: ${llm.label}（真实模型）`);
	} else {
		console.log(`模型: 模拟模型（未检测到 API key）`);
		console.log(`      支持的环境变量: ${supportedKeyEnvs().join(" / ")}`);
		console.log(`      也可用 LLM_PROVIDER + LLM_MODEL + LLM_BASE_URL + LLM_API_KEY 自由指定`);
	}
	const current = models.currentView();
	console.log(
		`模型管理: ${models.providerCount()} 个供应商 / ${models.modelCount()} 个模型（当前: ${current.current ?? "模拟模型"}）`,
	);
});

// MCP 启动加载：异步做，失败只落库 last_status（registry 内部处理），不阻塞监听、不崩进程
void mcp.start().catch((error: unknown) => {
	console.error(`MCP 启动加载失败: ${error instanceof Error ? error.message : String(error)}`);
});

/** 优雅关闭：停止接受新连接，关闭 MCP 子进程与 SQLite，避免 WAL/句柄未落盘。 */
function shutdown(signal: string): void {
	console.log(`\n收到 ${signal}，正在关闭…`);
	// 先杀 MCP 子进程：SSE/keep-alive 连接可能让 server.close 等一会儿，别留下孤儿 node 进程
	void mcp.close();
	server.close(() => {
		void mcp.close().finally(() => {
			try {
				// 先把调用链队列刷完，再关库（顺序反了会丢最后几轮的事件）
				observability.close();
				db.close();
			} catch {
				// 忽略关闭时可能的已关闭错误
			}
			process.exit(0);
		});
	});
	// 兜底：5 秒内没关完就强制退出
	setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
