/**
 * 多模型管理接口（P6），挂载在 `server/index.ts` 的 `/api/models*` 上。
 *
 * 接口清单：
 *   GET    /api/models                         { mode, current, options, providers, models }
 *   POST   /api/models                         { providerId, modelId, name?, kind?, enabled?, contextWindow? } → 201
 *   PATCH  /api/models/:id                     { name?, modelId?, kind?, enabled?, contextWindow?, providerId? }
 *   DELETE /api/models/:id                     → { removed }
 *   POST   /api/models/:id/ping                → { id, ok, latencyMs, error? }（8 秒超时，失败也是 200）
 *   GET/POST /api/models/current               { modelId } → { current, model, mode }
 *   GET/POST /api/models/embedding             { modelId } → { modelKey, options }（知识库语义检索用的向量模型）
 *   GET    /api/models/providers               → { items: [...] }（key 永远只有掩码）
 *   POST   /api/models/providers               { name, kind, baseUrl?, apiKey?, enabled? } → 201
 *   GET/PATCH/DELETE /api/models/providers/:id
 *
 * 鉴权与权限矩阵在 `server/index.ts` 的 `auth.guard()` 里统一处理（`server/auth/roles.ts` 映射），
 * 这里假设请求已经过守卫。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { ModelError } from "./store.js";
import type { ModelService } from "./service.js";

const MODELS_PREFIX = "/api/models";
const MAX_BODY_BYTES = 1024 * 1024;

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
			throw new ModelError(413, "请求体超过 1 MB");
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
		throw new ModelError(400, "请求体不是合法 JSON");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new ModelError(400, "请求体必须是 JSON 对象");
	}
	return parsed as Record<string, unknown>;
}

function decodeSegment(raw: string): string {
	try {
		return decodeURIComponent(raw);
	} catch {
		throw new ModelError(400, "路径里的 id 不是合法的 URL 编码");
	}
}

function methodNotAllowed(res: ServerResponse, method: string, allowed: string): void {
	json(res, 405, { error: `不支持 ${method}，这个接口只接受 ${allowed}` });
}

async function route(
	req: IncomingMessage,
	res: ServerResponse,
	pathname: string,
	service: ModelService,
): Promise<void> {
	const method = req.method ?? "GET";

	if (pathname === MODELS_PREFIX) {
		if (method === "GET") {
			const view = service.currentView();
			json(res, 200, {
				mode: view.mode,
				current: view.current,
				label: view.label,
				options: service.options(),
				providers: service.store.providers(),
				models: service.store.models(),
			});
			return;
		}
		if (method === "POST") {
			const body = await readJsonBody(req);
			json(res, 201, service.store.createModel(body));
			return;
		}
		methodNotAllowed(res, method, "GET / POST");
		return;
	}

	if (pathname === `${MODELS_PREFIX}/current`) {
		if (method === "GET") {
			json(res, 200, service.currentView());
			return;
		}
		if (method === "POST") {
			const body = await readJsonBody(req);
			json(res, 200, service.setCurrent(body.modelId));
			return;
		}
		methodNotAllowed(res, method, "GET / POST");
		return;
	}

	if (pathname === `${MODELS_PREFIX}/embedding`) {
		if (method === "GET") {
			json(res, 200, service.embeddingView());
			return;
		}
		if (method === "POST") {
			const body = await readJsonBody(req);
			json(res, 200, service.setEmbeddingModel(body.modelId));
			return;
		}
		methodNotAllowed(res, method, "GET / POST");
		return;
	}

	if (pathname === `${MODELS_PREFIX}/providers`) {
		if (method === "GET") {
			json(res, 200, { items: service.store.providers() });
			return;
		}
		if (method === "POST") {
			const body = await readJsonBody(req);
			json(res, 201, service.store.createProvider(body));
			return;
		}
		methodNotAllowed(res, method, "GET / POST");
		return;
	}

	const providerMatch = new RegExp(`^${MODELS_PREFIX}/providers/([^/]+)$`).exec(pathname);
	if (providerMatch) {
		const providerId = decodeSegment(providerMatch[1]!);
		if (method === "GET") {
			const provider = service.store.provider(providerId);
			if (!provider) {
				throw new ModelError(404, "供应商不存在");
			}
			json(res, 200, provider);
			return;
		}
		if (method === "PATCH") {
			const body = await readJsonBody(req);
			json(res, 200, service.store.updateProvider(providerId, body));
			return;
		}
		if (method === "DELETE") {
			json(res, 200, service.store.removeProvider(providerId));
			return;
		}
		methodNotAllowed(res, method, "GET / PATCH / DELETE");
		return;
	}

	const pingMatch = new RegExp(`^${MODELS_PREFIX}/([^/]+)/ping$`).exec(pathname);
	if (pingMatch) {
		const modelId = decodeSegment(pingMatch[1]!);
		if (method !== "POST") {
			methodNotAllowed(res, method, "POST");
			return;
		}
		const result = await service.ping(modelId);
		json(res, 200, { id: modelId, ...result });
		return;
	}

	const modelMatch = new RegExp(`^${MODELS_PREFIX}/([^/]+)$`).exec(pathname);
	if (modelMatch) {
		const modelId = decodeSegment(modelMatch[1]!);
		if (method === "GET") {
			const model = service.store.model(modelId);
			if (!model) {
				throw new ModelError(404, "模型不存在");
			}
			json(res, 200, model);
			return;
		}
		if (method === "PATCH") {
			const body = await readJsonBody(req);
			json(res, 200, service.store.updateModel(modelId, body));
			return;
		}
		if (method === "DELETE") {
			if (!service.store.removeModel(modelId)) {
				throw new ModelError(404, "模型不存在");
			}
			json(res, 200, { removed: true });
			return;
		}
		methodNotAllowed(res, method, "GET / PATCH / DELETE");
		return;
	}

	throw new ModelError(404, "接口不存在");
}

/** 返回 true = 这个请求被模型管理接口接管了。 */
export async function handleModelsRoute(
	req: IncomingMessage,
	res: ServerResponse,
	url: URL,
	service: ModelService,
): Promise<boolean> {
	const pathname = url.pathname;
	if (pathname !== MODELS_PREFIX && !pathname.startsWith(`${MODELS_PREFIX}/`)) {
		return false;
	}
	try {
		await route(req, res, pathname, service);
	} catch (error) {
		if (error instanceof ModelError) {
			json(res, error.status, { error: error.message });
			return true;
		}
		console.error(`模型管理接口出错: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
		json(res, 500, { error: error instanceof Error ? error.message : String(error) });
	}
	return true;
}
