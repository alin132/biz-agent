/**
 * 知识库 HTTP 路由：自包含，宿主只需要在 `server/index.ts` 里加三行挂载
 * （见文件末尾注释）。**不要**改 `server/index.ts` 的路由表来接入知识库，
 * 这样知识库整块可以独立演进、独立测试。
 *
 * 接口清单：
 *   GET    /api/kb                             知识库列表（带 docCount/chunkCount/embedding）
 *   POST   /api/kb                             { name, description?, chunkSize?, ... } → 201
 *   DELETE /api/kb/:id                         → { removed, documentsRemoved, chunksRemoved }
 *   GET    /api/kb/:id/documents               文档列表（status/chunkCount/error）
 *   POST   /api/kb/:id/documents               { filename, contentBase64 | content, mime? } → 201
 *   DELETE /api/kb/documents/:docId            → { removed, chunksRemoved }
 *   POST   /api/kb/:id/search                  { query, topK?, threshold? } → { mode, results }
 *   GET    /api/kb/embedding                   { available, model, baseUrl }
 *   GET    /api/skills/:skillId/kb             技能绑定的知识库
 *   PUT    /api/skills/:skillId/kb             { kbIds: string[] } 覆盖式设置
 *
 * 错误：400 入参不对 / 404 不存在 / 405 方法不支持 / 413 文件太大；全部中文文案。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { badRequest, errorMessage, KbError, notFound } from "./errors.js";
import { getKb } from "./runtime.js";
import type { KbService } from "./service.js";

/** 请求体上限：20 MB 文件转 Base64 约 27 MB，留一点余量给 JSON 外壳。 */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

const KB_PREFIX = "/api/kb";
const SKILL_KB_PATTERN = /^\/api\/skills\/([^/]+)\/kb$/;

function json(res: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(payload),
	});
	res.end(payload);
}

/** 读 JSON 请求体；空 body 当 `{}`（DELETE 之类不需要 body）。 */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of req) {
		const buffer = chunk as Buffer;
		total += buffer.length;
		if (total > MAX_BODY_BYTES) {
			throw new KbError(413, "请求体超过 32 MB（单个文件上限 20 MB），请拆分后再上传");
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
		throw badRequest("请求体不是合法 JSON");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw badRequest("请求体必须是 JSON 对象");
	}
	return parsed as Record<string, unknown>;
}

/** 路径里的 id 要 decode 一次；坏编码给 400 而不是 500。 */
function decodeSegment(raw: string): string {
	try {
		return decodeURIComponent(raw);
	} catch {
		throw badRequest("路径里的 id 不是合法的 URL 编码");
	}
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
	const value = body[key];
	if (value === undefined || value === null) {
		return undefined;
	}
	if (typeof value !== "string") {
		throw badRequest(`${key} 必须是字符串`);
	}
	return value;
}

function optionalNumber(body: Record<string, unknown>, key: string): number | undefined {
	const value = body[key];
	if (value === undefined || value === null) {
		return undefined;
	}
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw badRequest(`${key} 必须是数字`);
	}
	return value;
}

/** Base64 解码：允许带 `data:...;base64,` 前缀（前端 FileReader 直接给的就是这种）。 */
function decodeBase64(raw: string): Buffer {
	const cleaned = raw.replace(/^data:[^;]+;base64,/, "").replace(/\s+/g, "");
	if (cleaned.length === 0) {
		throw badRequest("contentBase64 是空的");
	}
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned) || cleaned.length % 4 !== 0) {
		throw badRequest("contentBase64 不是合法的 Base64 字符串");
	}
	return Buffer.from(cleaned, "base64");
}

function methodNotAllowed(res: ServerResponse, method: string): void {
	json(res, 405, { error: `不支持 ${method} 这个知识库接口，请检查请求方法` });
}

/** 知识库列表：GET /api/kb；建库：POST /api/kb */
async function handleBases(service: KbService, req: IncomingMessage, res: ServerResponse): Promise<void> {
	if (req.method === "GET") {
		json(res, 200, service.listKnowledgeBases());
		return;
	}
	if (req.method === "POST") {
		const body = await readJsonBody(req);
		const knowledgeBase = service.createKnowledgeBase({
			name: typeof body.name === "string" ? body.name : "",
			description: optionalString(body, "description") ?? null,
			chunkSize: optionalNumber(body, "chunkSize"),
			chunkOverlap: optionalNumber(body, "chunkOverlap"),
			similarityThreshold: optionalNumber(body, "similarityThreshold"),
		});
		json(res, 201, knowledgeBase);
		return;
	}
	methodNotAllowed(res, req.method ?? "GET");
}

function respondError(res: ServerResponse, error: unknown): void {
	const status = error instanceof KbError ? error.status : 500;
	json(res, status, { error: errorMessage(error) });
}

/** 上传：POST /api/kb/:id/documents —— 解析 + 分块 + 落库同步做完再返回（20 MB 内可接受）。 */
async function handleUpload(service: KbService, kbId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
	const body = await readJsonBody(req);
	const filename = (optionalString(body, "filename") ?? "").trim();
	if (filename.length === 0) {
		throw badRequest("filename 不能为空（要带扩展名，例如 员工手册.pdf）");
	}
	if (filename.length > 200) {
		throw badRequest("filename 最多 200 个字符");
	}
	let data: Buffer;
	if (typeof body.contentBase64 === "string") {
		data = decodeBase64(body.contentBase64);
	} else if (typeof body.content === "string") {
		// 纯文本走 content 更省事（curl 调试、脚本导入）；二进制请用 contentBase64
		data = Buffer.from(body.content, "utf8");
	} else {
		throw badRequest("缺少文件内容：传 contentBase64（推荐，二进制安全）或 content（纯文本）");
	}
	const result = await service.ingestDocument({
		kbId,
		filename,
		data,
		mime: optionalString(body, "mime") ?? null,
	});
	json(res, 201, {
		document: result.document,
		chunkCount: result.chunkCount,
		embedded: result.embedded,
		...(result.warning ? { warning: result.warning } : {}),
	});
}

/**
 * 知识库路由总入口。
 * @returns true 表示本请求已经处理（含错误响应）；false 表示不是知识库的路径，交给宿主继续匹配。
 */
export async function handleKb(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
	const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
	const rawPath = url.pathname;
	const pathname = rawPath.length > 1 ? rawPath.replace(/\/+$/, "") : rawPath;
	const isSkillKb = SKILL_KB_PATTERN.test(pathname);
	// 严格前缀：别把宿主的 /api/kbxxx 之类的路由吞掉
	const isKbPath = pathname === KB_PREFIX || pathname.startsWith(`${KB_PREFIX}/`);
	if (!isKbPath && !isSkillKb) {
		return false;
	}
	const method = (req.method ?? "GET").toUpperCase();

	try {
		const service = getKb();

		if (pathname === KB_PREFIX) {
			await handleBases(service, req, res);
			return true;
		}

		if (pathname === `${KB_PREFIX}/embedding`) {
			if (method !== "GET") {
				methodNotAllowed(res, method);
				return true;
			}
			json(res, 200, service.embeddingInfo());
			return true;
		}

		// 注意顺序：/api/kb/documents/:docId 必须比 /api/kb/:id 先匹配
		const documentDeleteMatch = /^\/api\/kb\/documents\/([^/]+)$/.exec(pathname);
		if (documentDeleteMatch) {
			if (method !== "DELETE") {
				methodNotAllowed(res, method);
				return true;
			}
			const docId = decodeSegment(documentDeleteMatch[1]!);
			const result = service.removeDocument(docId);
			json(res, result.removed ? 200 : 404, result.removed ? result : { error: `文档不存在：${docId}` });
			return true;
		}

		const documentsMatch = /^\/api\/kb\/([^/]+)\/documents$/.exec(pathname);
		if (documentsMatch) {
			const kbId = decodeSegment(documentsMatch[1]!);
			if (method === "GET") {
				json(res, 200, service.listDocuments(kbId));
				return true;
			}
			if (method === "POST") {
				await handleUpload(service, kbId, req, res);
				return true;
			}
			methodNotAllowed(res, method);
			return true;
		}

		const searchMatch = /^\/api\/kb\/([^/]+)\/search$/.exec(pathname);
		if (searchMatch) {
			if (method !== "POST") {
				methodNotAllowed(res, method);
				return true;
			}
			const kbId = decodeSegment(searchMatch[1]!);
			const body = await readJsonBody(req);
			const query = (optionalString(body, "query") ?? "").trim();
			if (query.length === 0) {
				throw badRequest("query 不能为空");
			}
			const result = await service.search(kbId, query, {
				topK: optionalNumber(body, "topK"),
				threshold: optionalNumber(body, "threshold"),
			});
			json(res, 200, result);
			return true;
		}

		const skillMatch = SKILL_KB_PATTERN.exec(pathname);
		if (skillMatch) {
			const skillId = decodeSegment(skillMatch[1]!);
			if (method === "GET") {
				json(res, 200, service.getSkillBindings(skillId));
				return true;
			}
			if (method === "PUT") {
				const body = await readJsonBody(req);
				const raw = body.kbIds;
				if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string")) {
					throw badRequest("kbIds 必须是字符串数组（知识库 id 列表）");
				}
				if (raw.length > 50) {
					throw badRequest("一个技能最多绑定 50 个知识库");
				}
				json(res, 200, service.setSkillBindings(skillId, raw as string[]));
				return true;
			}
			methodNotAllowed(res, method);
			return true;
		}

		const baseMatch = /^\/api\/kb\/([^/]+)$/.exec(pathname);
		if (baseMatch) {
			if (method !== "DELETE") {
				methodNotAllowed(res, method);
				return true;
			}
			const kbId = decodeSegment(baseMatch[1]!);
			const result = service.removeKnowledgeBase(kbId);
			json(res, result.removed ? 200 : 404, result.removed ? result : { error: `知识库不存在：${kbId}` });
			return true;
		}

		throw notFound(`知识库接口不存在：${method} ${pathname}`);
	} catch (error) {
		respondError(res, error);
		return true;
	}
}

/*
 * 宿主挂载（`server/index.ts`，三行）：
 *
 *   import { handleKb, initKb } from "./kb/index.js";
 *   initKb({ dbPath: DB_PATH });
 *   // createServer 回调里、静态资源分支之前：
 *   if (await handleKb(req, res)) return;
 */
