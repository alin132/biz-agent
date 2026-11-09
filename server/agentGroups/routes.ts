import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthRuntime } from "../auth/service.js";
import { AgentGroupError, AgentGroupService } from "./service.js";

const PREFIX = "/api/agent-groups";

function json(res: ServerResponse, status: number, body: unknown): void {
	const content = JSON.stringify(body);
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(content);
}

async function bodyOf(req: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const part = chunk as Buffer;
		size += part.length;
		if (size > 1_000_000) throw new AgentGroupError(413, "请求体不能超过 1 MB");
		chunks.push(part);
	}
	if (size === 0) return {};
	try {
		const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
		return value as Record<string, unknown>;
	} catch {
		throw new AgentGroupError(400, "请求体必须是 JSON 对象");
	}
}

export async function handleAgentGroups(
	req: IncomingMessage,
	res: ServerResponse,
	url: URL,
	service: AgentGroupService,
	auth: AuthRuntime,
): Promise<boolean> {
	if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return false;
	const method = req.method ?? "GET";
	const rest = url.pathname.slice(PREFIX.length).replace(/^\/+|\/+$/g, "");
	try {
		if (!rest) {
			if (method === "GET") { json(res, 200, { items: service.list() }); return true; }
			if (method === "POST") {
				const body = await bodyOf(req);
				json(res, 201, service.create({ name: body.name, agentIds: body.agentIds, createdBy: auth.userOf(req)?.id ?? null }));
				return true;
			}
			json(res, 405, { error: "这个接口只支持 GET / POST" });
			return true;
		}
		const [rawId, action, ...extra] = rest.split("/");
		const id = decodeURIComponent(rawId ?? "");
		if (extra.length > 0 || !id) { json(res, 404, { error: "接口不存在" }); return true; }
		if (action === "turns" && method === "POST") {
			const body = await bodyOf(req);
			json(res, 200, await service.send(id, body.message));
			return true;
		}
		if (action === "cancel" && method === "POST") {
			const cancelled = service.cancel(id);
			json(res, cancelled ? 202 : 409, { cancelled, group: service.get(id) });
			return true;
		}
		if (!action && method === "GET") { json(res, 200, service.get(id)); return true; }
		if (!action && method === "DELETE") { json(res, 200, { removed: service.delete(id) }); return true; }
		json(res, 405, { error: "不支持的群聊操作" });
		return true;
	} catch (error) {
		if (error instanceof AgentGroupError) { json(res, error.status, { error: error.message }); return true; }
		console.error(`部门群聊接口失败: ${error instanceof Error ? error.message : String(error)}`);
		json(res, 500, { error: "部门群聊操作失败" });
		return true;
	}
}
