/**
 * API Key 管理接口（P4）：`/api/api-keys`。
 *
 * 接口清单：
 *   GET    /api/api-keys              → { items }（只有 prefix，永远不回明文/hash）
 *   POST   /api/api-keys              { name?, role?, rateLimitPerMin? } → 201 { item, key }
 *                                     **key 明文只出现这一次**
 *   PATCH  /api/api-keys/:id          { name?, role?, rateLimitPerMin?, disabled? } → { item }
 *   DELETE /api/api-keys/:id          → { removed, item }（软吊销，不是物理删除）
 *
 * 权限：写与读都要求 `workflow.write`（owner / developer）——在 `server/auth/roles.ts` 映射；
 * 接口这里不再重复判断，避免两处真相。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { ApiKeyError } from "./store.js";
import type { ApiKeyService } from "./service.js";

const API_KEYS_PREFIX = "/api/api-keys";
const MAX_BODY_BYTES = 256 * 1024;

function json(res: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(payload),
	});
	res.end(payload);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of req) {
		const buffer = chunk as Buffer;
		total += buffer.length;
		if (total > MAX_BODY_BYTES) {
			throw new ApiKeyError(413, "请求体超过 256 KB");
		}
		chunks.push(buffer);
	}
	if (total === 0) {
		return {};
	}
	const raw = Buffer.concat(chunks).toString("utf8");
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new ApiKeyError(400, "请求体不是合法 JSON");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new ApiKeyError(400, "请求体必须是 JSON 对象");
	}
	return parsed as Record<string, unknown>;
}

function decodeSegment(raw: string): string {
	try {
		return decodeURIComponent(raw);
	} catch {
		throw new ApiKeyError(400, "路径里的 id 不是合法的 URL 编码");
	}
}

function methodNotAllowed(res: ServerResponse, method: string, allowed: string): void {
	json(res, 405, { error: `不支持 ${method}，这个接口只接受 ${allowed}` });
}

async function route(
	req: IncomingMessage,
	res: ServerResponse,
	pathname: string,
	service: ApiKeyService,
): Promise<void> {
	const method = req.method ?? "GET";

	if (pathname === API_KEYS_PREFIX) {
		if (method === "GET") {
			json(res, 200, { items: service.list() });
			return;
		}
		if (method === "POST") {
			const body = await readJsonBody(req);
			const created = service.create(body);
			json(res, 201, created);
			return;
		}
		methodNotAllowed(res, method, "GET / POST");
		return;
	}

	const match = new RegExp(`^${API_KEYS_PREFIX}/([^/]+)$`).exec(pathname);
	if (match) {
		const id = decodeSegment(match[1]!);
		if (method === "GET") {
			const item = service.list().find((record) => record.id === id);
			if (!item) {
				throw new ApiKeyError(404, "API Key 不存在");
			}
			json(res, 200, { item });
			return;
		}
		if (method === "PATCH") {
			const body = await readJsonBody(req);
			json(res, 200, { item: service.update(id, body) });
			return;
		}
		if (method === "DELETE") {
			const item = service.revoke(id);
			json(res, 200, { removed: true, item });
			return;
		}
		methodNotAllowed(res, method, "GET / PATCH / DELETE");
		return;
	}

	throw new ApiKeyError(404, "接口不存在");
}

/** 返回 true = 这个请求被 API Key 管理接口接管了。 */
export async function handleApiKeysRoute(
	req: IncomingMessage,
	res: ServerResponse,
	url: URL,
	service: ApiKeyService,
): Promise<boolean> {
	const pathname = url.pathname;
	if (pathname !== API_KEYS_PREFIX && !pathname.startsWith(`${API_KEYS_PREFIX}/`)) {
		return false;
	}
	try {
		await route(req, res, pathname, service);
	} catch (error) {
		if (error instanceof ApiKeyError) {
			json(res, error.status, { error: error.message });
			return true;
		}
		console.error(`API Key 接口出错: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
		json(res, 500, { error: error instanceof Error ? error.message : String(error) });
	}
	return true;
}
