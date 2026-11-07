/**
 * Agent HTTP 路由：自包含模块，宿主只需在 server/index.ts 里挂一行。
 *
 * 接口清单：
 *   GET    /api/agents                 列表（按 updatedAt 倒序）
 *   POST   /api/agents                 新建（一律 draft）→ 201
 *   GET    /api/agents/:id             详情
 *   PATCH  /api/agents/:id             改配置（published 拒绝，409 published_locked）
 *   DELETE /api/agents/:id             删除 → { removed: true }
 *   POST   /api/agents/:id/actions     { action: "test" | "publish" | "stop" | "revert" } 走状态机
 *
 * 错误：400 入参 / 404 不存在 / 409 状态机不允许（含已发布不可编辑、已停用不可对话）；全部中文文案。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentAction, AgentPatch } from "../db/types.js";
import { AgentError, AgentService, statusLabel } from "./service.js";

const PREFIX = "/api/agents";
const ACTIONS: AgentAction[] = ["test", "publish", "stop", "revert"];

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	const text = JSON.stringify(body);
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(text);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	if (chunks.length === 0) return {};
	const text = Buffer.concat(chunks).toString("utf8");
	if (text.trim().length === 0) return {};
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new AgentError("请求体不是合法 JSON", 400);
	}
}

function asObject(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new AgentError("请求体必须是 JSON 对象", 400);
	}
	return value as Record<string, unknown>;
}

/** 判断是不是本模块要处理的路：宿主据此决定是否继续往下走 */
export function isAgentPath(pathname: string): boolean {
	return pathname === PREFIX || pathname.startsWith(`${PREFIX}/`);
}

/**
 * 挂载入口：返回 true 表示已处理（宿主别再往下走）。
 * 只认 /api/agents 前缀，别在这里处理别的路径。
 */
export async function handleAgents(
	req: IncomingMessage,
	res: ServerResponse,
	service: AgentService,
): Promise<boolean> {
	const url = new URL(req.url ?? "/", "http://localhost");
	const pathname = url.pathname;
	if (!isAgentPath(pathname)) return false;
	const method = req.method ?? "GET";
	const rest = pathname.slice(PREFIX.length); // "" | "/:id" | "/:id/actions"

	try {
		if (rest === "" || rest === "/") {
			if (method === "GET") {
				sendJson(res, 200, { items: service.list().map(toView) });
				return true;
			}
			if (method === "POST") {
				const body = asObject(await readBody(req));
				if (typeof body.name !== "string") throw new AgentError("请填写 Agent 名称", 400);
				const created = service.create({
					name: body.name,
					description: typeof body.description === "string" ? body.description : undefined,
					category: typeof body.category === "string" ? body.category : undefined,
					icon: typeof body.icon === "string" ? body.icon : undefined,
					agentsMd: typeof body.agentsMd === "string" ? body.agentsMd : undefined,
					modelConfig: body.modelConfig as Record<string, unknown> | undefined,
					memoryConfig: body.memoryConfig as Record<string, unknown> | undefined,
					advancedConfig: body.advancedConfig as Record<string, unknown> | undefined,
					skillIds: Array.isArray(body.skillIds) ? (body.skillIds as string[]) : undefined,
					kbIds: Array.isArray(body.kbIds) ? (body.kbIds as string[]) : undefined,
					createdBy: typeof body.createdBy === "string" ? body.createdBy : null,
				});
				sendJson(res, 201, toView(created));
				return true;
			}
			sendJson(res, 405, { error: "这个接口只支持 GET / POST" });
			return true;
		}

		const segments = rest.slice(1).split("/");
		const id = decodeURIComponent(segments[0] ?? "");
		const suffix = segments[1];
		if (id.length === 0) {
			sendJson(res, 404, { error: "Agent 不存在" });
			return true;
		}

		if (suffix === undefined) {
			if (method === "GET") {
				sendJson(res, 200, toView(service.get(id)));
				return true;
			}
			if (method === "PATCH") {
				const body = asObject(await readBody(req));
				// PATCH 语义：字段不传 = 不改（与流程/模型一致）
				const patch: Record<string, unknown> = {};
				for (const key of ["name", "description", "category", "icon", "agentsMd"]) {
					if (typeof body[key] === "string") patch[key] = body[key];
				}
				for (const key of ["modelConfig", "memoryConfig", "advancedConfig"]) {
					if (body[key] !== undefined) patch[key] = body[key];
				}
				for (const key of ["skillIds", "kbIds"]) {
					if (Array.isArray(body[key])) patch[key] = body[key];
				}
				// service 会补 updatedAt，这里只负责"哪些字段传了"
				sendJson(res, 200, toView(service.update(id, patch as unknown as AgentPatch)));
				return true;
			}
			if (method === "DELETE") {
				service.remove(id);
				sendJson(res, 200, { removed: true });
				return true;
			}
			sendJson(res, 405, { error: "这个接口只支持 GET / PATCH / DELETE" });
			return true;
		}

		if (suffix === "actions") {
			if (method !== "POST") {
				sendJson(res, 405, { error: "状态机动作只支持 POST" });
				return true;
			}
			const body = asObject(await readBody(req));
			const action = body.action;
			if (typeof action !== "string" || !ACTIONS.includes(action as AgentAction)) {
				sendJson(res, 400, { error: `action 只能是 ${ACTIONS.join(" / ")}` });
				return true;
			}
			sendJson(res, 200, toView(service.applyAction(id, action as AgentAction)));
			return true;
		}

		sendJson(res, 404, { error: "接口不存在" });
		return true;
	} catch (cause) {
		if (cause instanceof AgentError) {
			// code 一起回：前端要区分"已发布锁定"和"别的 409"，别让它去匹配中文
			sendJson(res, cause.status, cause.code ? { error: cause.message, code: cause.code } : { error: cause.message });
			return true;
		}
		const message = cause instanceof Error ? cause.message : String(cause);
		sendJson(res, 500, { error: `Agent 操作失败：${message}` });
		return true;
	}
}

/** 出参加一个中文状态名：前端不用再维护一份 status → 中文的映射 */
function toView(record: ReturnType<AgentService["get"]>): Record<string, unknown> {
	return { ...record, statusLabel: statusLabel(record.status) };
}
