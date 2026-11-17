import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthRuntime } from "../auth/service.js";
import { MemoryError, MemoryService } from "./service.js";

function json(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(body));
}

async function bodyOf(req: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const data = Buffer.from(chunk);
		size += data.length;
		if (size > 16_384) throw new MemoryError(413, "记忆请求不能超过 16 KB");
		chunks.push(data);
	}
	try {
		const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
		return body as Record<string, unknown>;
	} catch { throw new MemoryError(400, "请求体必须是 JSON 对象"); }
}

export async function handleMemoryRoute(req: IncomingMessage, res: ServerResponse, url: URL, service: MemoryService, auth: AuthRuntime): Promise<boolean> {
	if (url.pathname !== "/api/memories" && !url.pathname.startsWith("/api/memories/")) return false;
	const ownerId = auth.userOf(req)?.id;
	if (!ownerId) { json(res, 401, { error: "请先登录" }); return true; }
	const method = req.method ?? "GET";
	try {
		const rest = url.pathname.slice("/api/memories".length).replace(/^\/|\/$/g, "");
		if (!rest) {
			if (method === "GET") {
				const filter: { agentId?: string | null; sessionId?: string | null } = {};
				for (const key of ["agentId", "sessionId"] as const) if (url.searchParams.has(key)) filter[key] = url.searchParams.get(key) || null;
				json(res, 200, { items: service.list(ownerId, filter) }); return true;
			}
			if (method === "POST") { json(res, 201, service.create(ownerId, await bodyOf(req))); return true; }
		} else if (!rest.includes("/")) {
			const id = decodeURIComponent(rest);
			if (method === "PATCH") { json(res, 200, service.update(ownerId, id, await bodyOf(req))); return true; }
			if (method === "DELETE") { service.remove(ownerId, id); json(res, 200, { removed: true }); return true; }
		}
		json(res, 405, { error: "不支持的记忆操作" });
	} catch (error) {
		if (!(error instanceof MemoryError)) throw error;
		json(res, error.status, { error: error.message });
	}
	return true;
}
