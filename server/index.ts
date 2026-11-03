/**
 * 极简 HTTP 服务：只依赖 node 标准库，无框架、无构建步骤。
 *
 * 路由：
 *   GET  /api/workflows                 可选流程清单
 *   GET  /api/models                    当前模型与可用模型
 *   POST /api/sessions                  创建会话 { workflowId, modelId? }
 *   GET  /api/sessions                  会话列表（含 SQLite 历史）
 *   DELETE /api/sessions                清空全部会话
 *   GET  /api/sessions/:id              会话快照（必要时从 SQLite 恢复）
 *   DELETE /api/sessions/:id            删除会话
 *   GET  /api/sessions/:id/events       SSE 事件流
 *   POST /api/sessions/:id/messages     发送消息 { text }
 *   POST /api/sessions/:id/approve      审批决定 { requestId, approved }
 *   POST /api/sessions/:id/permissions  权限模式 { mode }
 *   其余                                 静态资源（web/）
 */

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionDb } from "./db.js";
import { loadEnvFile } from "./env.js";
import { currentModelId, listModelOptions, resolveLlm, supportedKeyEnvs } from "./llm.js";
import { SessionHub } from "./session.js";

loadEnvFile();

const WEB_DIR = resolve(fileURLToPath(new URL("../web/", import.meta.url)));
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

const hub = new SessionHub(new SessionDb(DB_PATH));

function json(res: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(payload),
	});
	res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		chunks.push(chunk as Buffer);
	}
	const raw = Buffer.concat(chunks).toString("utf8");
	return raw.length === 0 ? {} : (JSON.parse(raw) as Record<string, unknown>);
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
		res.writeHead(200, { "Content-Type": MIME[extname(target)] ?? "application/octet-stream" });
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
	void (async () => {
		const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
		const pathname = url.pathname;
		const method = req.method ?? "GET";

		// ---- 静态资源 ----
		if (!pathname.startsWith("/api/")) {
			await serveStatic(pathname, res);
			return;
		}

		// ---- API ----
		if (pathname === "/api/workflows" && method === "GET") {
			json(res, 200, SessionHub.catalog());
			return;
		}

		if (pathname === "/api/sessions" && method === "GET") {
			json(res, 200, hub.list());
			return;
		}

		if (pathname === "/api/models" && method === "GET") {
			const options = listModelOptions();
			const current = currentModelId();
			json(res, 200, {
				mode: current ? "live" : "simulated",
				current,
				options,
			});
			return;
		}

		if (pathname === "/api/sessions" && method === "POST") {
			const body = await readBody(req);
			const workflowId = String(body.workflowId ?? "");
			const modelId = typeof body.modelId === "string" && body.modelId.trim() ? body.modelId.trim() : undefined;
			try {
				const session = hub.create(workflowId, { modelId });
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

			if (action === "/events" && method === "GET") {
				handleEvents(session, req, res);
				return;
			}

			if (action === "/messages" && method === "POST") {
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

			if (action === "/approve" && method === "POST") {
				const body = await readBody(req);
				const requestId = String(body.requestId ?? "");
				const approved = body.approved === true;
				const ok = session.resolveApproval(requestId, approved);
				json(res, ok ? 200 : 404, { resolved: ok });
				return;
			}

			if (action === "/permissions" && method === "POST") {
				const body = await readBody(req);
				const mode = body.mode === "readonly" ? "readonly" : "full";
				json(res, 200, { permissionMode: session.setPermissionMode(mode) });
				return;
			}
		}

		json(res, 404, { error: "not found" });
	})().catch((error: unknown) => {
		json(res, 500, { error: error instanceof Error ? error.message : String(error) });
	});
});

server.listen(PORT, () => {
	const llm = resolveLlm();
	console.log(`biz-agent web 已启动: http://127.0.0.1:${PORT}`);
	console.log(`会话库: ${DB_PATH}`);
	if (llm) {
		console.log(`模型: ${llm.label}（真实模型）`);
	} else {
		console.log(`模型: 模拟模型（未检测到 API key）`);
		console.log(`      支持的环境变量: ${supportedKeyEnvs().join(" / ")}`);
		console.log(`      也可用 LLM_PROVIDER + LLM_MODEL + LLM_BASE_URL + LLM_API_KEY 自由指定`);
	}
});
