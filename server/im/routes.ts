/**
 * IM Bot 网关的 HTTP 入口（P8），挂载在 `server/index.ts` 的 `/api/im*`。
 *
 * 接口清单：
 *   GET    /api/im/bots                    机器人列表（凭证只回掩码 + enabled + 最近回调时间 + 会话数）
 *   POST   /api/im/bots                    新建 { name, appKey, appSecret, robotCode, callbackToken, aesKey? } → 201
 *   GET    /api/im/bots/:id                单个机器人（同列表字段）
 *   PATCH  /api/im/bots/:id                改属性 / 换凭证（appSecret / callbackToken 传了就必须非空）
 *   DELETE /api/im/bots/:id                删除（连带删会话映射）→ { removed, sessionsRemoved }
 *   POST   /api/im/bots/:id/ping           发一条测试消息（fake 传输时进 outbox）
 *   POST   /api/im/dingtalk/callback       钉钉回调（**免登录**，见 auth/service.ts 的公开路径）
 *   GET    /api/im/outbox                  仅 DINGTALK_TRANSPORT=fake 可用；真实传输 404
 *
 * 权限矩阵在 `server/auth/roles.ts` 映射（读 workflow.read、写 workflow.write、outbox audit.read），
 * 这里只做二次兜底与参数校验。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { ImError } from "./errors.js";
import { json, methodNotAllowed, readJsonBody } from "./http.js";
import type { OutboundService } from "./outbound.js";
import type { DingTalkGateway } from "./dingtalk.js";
import type { ImStore } from "./store.js";

const IM_PREFIX = "/api/im";

export interface ImRouteDeps {
	store: ImStore;
	outbound: OutboundService;
	gateway: DingTalkGateway;
}

function decodeSegment(raw: string): string {
	try {
		return decodeURIComponent(raw);
	} catch {
		throw new ImError(400, "路径里的 id 不是合法的 URL 编码");
	}
}

function optionalBodyString(body: Record<string, unknown>, name: string): string | undefined {
	const value = body[name];
	if (value === undefined || value === null) {
		return undefined;
	}
	if (typeof value !== "string") {
		throw new ImError(400, `${name} 必须是字符串`);
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

async function route(
	req: IncomingMessage,
	res: ServerResponse,
	url: URL,
	deps: ImRouteDeps,
): Promise<void> {
	const pathname = url.pathname;
	const method = req.method ?? "GET";

	if (pathname === `${IM_PREFIX}/dingtalk/callback`) {
		if (method !== "POST") {
			methodNotAllowed(res, method, "POST");
			return;
		}
		await deps.gateway.handleCallback(req, res, url);
		return;
	}

	if (pathname === `${IM_PREFIX}/outbox`) {
		if (method !== "GET") {
			methodNotAllowed(res, method, "GET");
			return;
		}
		if (!deps.outbound.fake) {
			// 真实传输下没有 outbox：别让调试接口在生产里泄露回复内容
			json(res, 404, { error: "outbox 只在 DINGTALK_TRANSPORT=fake 时可用" });
			return;
		}
		const items = deps.outbound.outbox();
		json(res, 200, { transport: "fake", count: items.length, items });
		return;
	}

	if (pathname === `${IM_PREFIX}/bots`) {
		if (method === "GET") {
			json(res, 200, { items: deps.store.list() });
			return;
		}
		if (method === "POST") {
			const body = await readJsonBody(req);
			json(res, 201, deps.store.create(body));
			return;
		}
		methodNotAllowed(res, method, "GET / POST");
		return;
	}

	const pingMatch = new RegExp(`^${IM_PREFIX}/bots/([^/]+)/ping$`).exec(pathname);
	if (pingMatch) {
		if (method !== "POST") {
			methodNotAllowed(res, method, "POST");
			return;
		}
		const botId = decodeSegment(pingMatch[1]!);
		const body = await readJsonBody(req);
		const row = deps.store.requireRow(botId);
		const conversationId = optionalBodyString(body, "conversationId");
		const staffId = optionalBodyString(body, "staffId");
		let target: { conversationId?: string; staffId?: string } = { conversationId, staffId };
		if (!target.conversationId && !target.staffId) {
			if (!deps.outbound.fake) {
				throw new ImError(400, "请提供 conversationId 或 staffId（真实钉钉要知道发给谁）");
			}
			// fake 模式没有真实会话：给一个稳定的假会话 id，方便在 outbox 里认出是哪次 ping
			target = { conversationId: `fake-${row.id}` };
		}
		const result = await deps.outbound.send(
			deps.store.outboundOf(row),
			target,
			"这是一条来自 biz-agent 的测试消息。",
		);
		json(res, 200, { id: row.id, name: row.name, ...result });
		return;
	}

	const botMatch = new RegExp(`^${IM_PREFIX}/bots/([^/]+)$`).exec(pathname);
	if (botMatch) {
		const botId = decodeSegment(botMatch[1]!);
		if (method === "GET") {
			json(res, 200, deps.store.view(botId));
			return;
		}
		if (method === "PATCH") {
			const body = await readJsonBody(req);
			json(res, 200, deps.store.update(botId, body));
			return;
		}
		if (method === "DELETE") {
			const result = deps.store.remove(botId);
			json(res, 200, result);
			return;
		}
		methodNotAllowed(res, method, "GET / PATCH / DELETE");
		return;
	}

	throw new ImError(404, "接口不存在");
}

/** 返回 true = 这个请求被 IM 网关接管了。 */
export async function handleImRoute(
	req: IncomingMessage,
	res: ServerResponse,
	url: URL,
	deps: ImRouteDeps,
): Promise<boolean> {
	const pathname = url.pathname;
	if (pathname !== IM_PREFIX && !pathname.startsWith(`${IM_PREFIX}/`)) {
		return false;
	}
	try {
		await route(req, res, url, deps);
	} catch (error) {
		if (error instanceof ImError) {
			json(res, error.status, { error: error.message });
		} else {
			console.error(`IM 网关接口出错: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
			json(res, 500, { error: error instanceof Error ? error.message : String(error) });
		}
	}
	return true;
}
