/**
 * MCP 管理接口（P7），挂载在 `server/index.ts` 的 `/api/mcp*` 上。
 *
 * 接口清单：
 *   GET    /api/mcp/servers                     → { items: [...] }（每个服务带发现到的工具）
 *   POST   /api/mcp/servers                     { name, transport, command?, args?, url?, headers?, env?, enabled? } → 201
 *   GET    /api/mcp/servers/:id                 → 服务详情（含工具与最近一次发现状态）
 *   PATCH  /api/mcp/servers/:id                 改配置；连接相关字段变了会立刻重新发现
 *   DELETE /api/mcp/servers/:id                 删服务（连带删工具、关闭连接）
 *   POST   /api/mcp/servers/:id/refresh         重新 initialize + tools/list（幂等）
 *   GET    /api/mcp/servers/:id/tools           工具列表（含已禁用的，前端要能切换）
 *   POST   /api/mcp/servers/:id/call            { tool, arguments? } → 直接调一次工具
 *   PATCH  /api/mcp/tools/:id                   { enabled } → 工具启停
 *
 * 权限：**读用 workflow.read，写用 workflow.write**（与 /api/workflows 同一组权限点）。
 * 映射写在这里而不是 `roles.permissionFor()`：`server/auth/**` 不在 P7 的改动边界内，
 * 但权限点仍然是 `server/auth/roles.ts` 那份矩阵的唯一真相（`can()` / `denyMessage()` 复用）。
 * 守卫在 `server/index.ts` 里先跑（AUTH_MODE=off 会挂演示所有者），这里是第二道。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { can, denyMessage } from "../auth/roles.js";
import type { AuthRuntime } from "../auth/service.js";
import type { McpTransport } from "../db/types.js";
import { McpClientError } from "./client.js";
import { McpRegistry, McpRegistryError } from "./registry.js";
import type { McpServerChanges, McpServerDraft } from "./registry.js";

const MCP_PREFIX = "/api/mcp";
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
			throw new McpRegistryError("请求体超过 1 MB", 413);
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
		throw new McpRegistryError("请求体不是合法 JSON", 400);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new McpRegistryError("请求体必须是 JSON 对象", 400);
	}
	return parsed as Record<string, unknown>;
}

function decodeSegment(raw: string): string {
	try {
		return decodeURIComponent(raw);
	} catch {
		throw new McpRegistryError("路径里的 id 不是合法的 URL 编码", 400);
	}
}

function methodNotAllowed(res: ServerResponse, method: string, allowed: string): void {
	json(res, 405, { error: `不支持 ${method}，这个接口只接受 ${allowed}` });
}

/* ---------------- 入参校验（中文文案，直接上界面） ---------------- */

function readName(value: unknown): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new McpRegistryError("MCP 服务名称不能为空", 400);
	}
	const name = value.trim();
	if (name.length > 80) {
		throw new McpRegistryError("MCP 服务名称最多 80 个字符", 400);
	}
	return name;
}

function readTransport(value: unknown): McpTransport {
	if (value === undefined || value === null) {
		return "stdio";
	}
	if (value === "stdio" || value === "http" || value === "sse") {
		return value;
	}
	throw new McpRegistryError("transport 只能是 stdio / http / sse", 400);
}

function readEnabled(value: unknown, fallback: boolean): boolean {
	if (value === undefined) {
		return fallback;
	}
	if (typeof value !== "boolean") {
		throw new McpRegistryError("enabled 必须是布尔值", 400);
	}
	return value;
}

function readStringList(value: unknown, field: string): string[] {
	if (value === undefined || value === null) {
		return [];
	}
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		throw new McpRegistryError(`${field} 必须是字符串数组`, 400);
	}
	return value as string[];
}

function readStringMap(value: unknown, field: string): Record<string, string> {
	if (value === undefined || value === null) {
		return {};
	}
	if (typeof value !== "object" || Array.isArray(value)) {
		throw new McpRegistryError(`${field} 必须是字符串键值对象`, 400);
	}
	const entries = Object.entries(value as Record<string, unknown>);
	if (entries.some((entry) => typeof entry[1] !== "string")) {
		throw new McpRegistryError(`${field} 的值必须是字符串`, 400);
	}
	return Object.fromEntries(entries as [string, string][]);
}

function readCommand(value: unknown): string | null {
	if (value === undefined || value === null) {
		return null;
	}
	if (typeof value !== "string") {
		throw new McpRegistryError("command 必须是字符串", 400);
	}
	const command = value.trim();
	if (command.length === 0) {
		throw new McpRegistryError("stdio 传输必须填写启动命令（command）", 400);
	}
	return command;
}

function readUrl(value: unknown): string | null {
	if (value === undefined || value === null) {
		return null;
	}
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new McpRegistryError("http / sse 传输必须填写服务地址（url）", 400);
	}
	const url = value.trim();
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new McpRegistryError("服务地址（url）不是合法的 URL", 400);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new McpRegistryError("服务地址（url）只支持 http / https", 400);
	}
	return url;
}

/** 把（合并后的）完整配置校验成草案；stdio 与 http/sse 各自只保留有用字段。 */
function parseDraft(body: Record<string, unknown>, fallback?: McpServerDraft): McpServerDraft {
	const name = body.name === undefined && fallback ? fallback.name : readName(body.name);
	const transport = body.transport === undefined && fallback ? fallback.transport : readTransport(body.transport);
	const enabled = readEnabled(body.enabled, fallback?.enabled ?? true);
	const headers =
		body.headers === undefined && fallback ? fallback.headers : readStringMap(body.headers, "headers");
	const env = body.env === undefined && fallback ? fallback.env : readStringMap(body.env, "env");

	if (transport === "stdio") {
		const command =
			body.command === undefined && fallback && fallback.transport === "stdio" ? fallback.command : readCommand(body.command);
		if (!command) {
			throw new McpRegistryError("stdio 传输必须填写启动命令（command）", 400);
		}
		const args =
			body.args === undefined && fallback && fallback.transport === "stdio" ? fallback.args : readStringList(body.args, "args");
		return { name, transport, command, args, url: null, headers, env, enabled };
	}

	const url = body.url === undefined && fallback ? fallback.url : readUrl(body.url);
	if (!url) {
		throw new McpRegistryError("http / sse 传输必须填写服务地址（url）", 400);
	}
	return { name, transport, command: null, args: [], url, headers, env, enabled };
}

/* ---------------- 权限 ---------------- */

function authorize(
	auth: AuthRuntime,
	req: IncomingMessage,
	method: string,
): { status: number; error: string } | null {
	const user = auth.userOf(req) ?? auth.authenticate(req);
	if (!user) {
		return { status: 401, error: "未登录或登录已过期" };
	}
	// 读接口 workflow.read，写接口 workflow.write：MCP 是技能的一种，沿用技能权限点
	const permission = method === "GET" ? "workflow.read" : "workflow.write";
	if (!can(user.role, permission)) {
		return { status: 403, error: denyMessage(user.role, permission) };
	}
	return null;
}

/* ---------------- 路由 ---------------- */

async function route(
	req: IncomingMessage,
	res: ServerResponse,
	pathname: string,
	registry: McpRegistry,
): Promise<void> {
	const method = req.method ?? "GET";

	/* ---------------- /api/mcp/servers ---------------- */
	if (pathname === `${MCP_PREFIX}/servers`) {
		if (method === "GET") {
			json(res, 200, { items: registry.listServers() });
			return;
		}
		if (method === "POST") {
			const body = await readJsonBody(req);
			const draft = parseDraft(body);
			const server = await registry.create(draft);
			json(res, 201, server);
			return;
		}
		methodNotAllowed(res, method, "GET / POST");
		return;
	}

	/* ---------------- /api/mcp/servers/:id/refresh ---------------- */
	const refreshMatch = new RegExp(`^${MCP_PREFIX}/servers/([^/]+)/refresh$`).exec(pathname);
	if (refreshMatch) {
		const id = decodeSegment(refreshMatch[1]!);
		if (method !== "POST") {
			methodNotAllowed(res, method, "POST");
			return;
		}
		const server = await registry.refresh(id);
		if (!server) {
			throw new McpRegistryError(`MCP 服务不存在: ${id}`, 404);
		}
		json(res, 200, server);
		return;
	}

	/* ---------------- /api/mcp/servers/:id/tools ---------------- */
	const toolsMatch = new RegExp(`^${MCP_PREFIX}/servers/([^/]+)/tools$`).exec(pathname);
	if (toolsMatch) {
		const id = decodeSegment(toolsMatch[1]!);
		if (method !== "GET") {
			methodNotAllowed(res, method, "GET");
			return;
		}
		const tools = registry.listTools(id);
		if (!tools) {
			throw new McpRegistryError(`MCP 服务不存在: ${id}`, 404);
		}
		json(res, 200, { items: tools });
		return;
	}

	/* ---------------- /api/mcp/servers/:id/call ---------------- */
	const callMatch = new RegExp(`^${MCP_PREFIX}/servers/([^/]+)/call$`).exec(pathname);
	if (callMatch) {
		const id = decodeSegment(callMatch[1]!);
		if (method !== "POST") {
			methodNotAllowed(res, method, "POST");
			return;
		}
		const body = await readJsonBody(req);
		const tool = typeof body.tool === "string" ? body.tool.trim() : "";
		if (!tool) {
			throw new McpRegistryError("tool 不能为空（可以是原始工具名或 mcp_<server>_<tool>）", 400);
		}
		const args =
			body.arguments === undefined || body.arguments === null
				? {}
				: typeof body.arguments === "object" && !Array.isArray(body.arguments)
					? (body.arguments as Record<string, unknown>)
					: null;
		if (args === null) {
			throw new McpRegistryError("arguments 必须是 JSON 对象", 400);
		}
		const result = await registry.callTool(id, tool, args);
		json(res, 200, {
			serverId: result.server.id,
			serverName: result.server.name,
			tool: result.tool.name,
			toolName: result.toolName,
			isError: result.result.isError,
			text: result.text,
			content: result.result.content,
		});
		return;
	}

	/* ---------------- /api/mcp/servers/:id ---------------- */
	const serverMatch = new RegExp(`^${MCP_PREFIX}/servers/([^/]+)$`).exec(pathname);
	if (serverMatch) {
		const id = decodeSegment(serverMatch[1]!);
		if (method === "GET") {
			const server = registry.getServerView(id);
			if (!server) {
				throw new McpRegistryError(`MCP 服务不存在: ${id}`, 404);
			}
			json(res, 200, server);
			return;
		}
		if (method === "PATCH") {
			const current = registry.getServerView(id);
			if (!current) {
				throw new McpRegistryError(`MCP 服务不存在: ${id}`, 404);
			}
			const body = await readJsonBody(req);
			// 用「当前配置 + 这次改动」做整体校验：只改 enabled 时也要保证原有必填项仍然成立
			const draft: McpServerDraft = parseDraft(body, {
				name: current.name,
				transport: current.transport,
				command: current.command,
				args: current.args,
				url: current.url,
				headers: current.headers,
				env: current.env,
				enabled: current.enabled,
			});
			const changes: McpServerChanges = { ...draft };
			const server = await registry.update(id, changes);
			if (!server) {
				throw new McpRegistryError(`MCP 服务不存在: ${id}`, 404);
			}
			json(res, 200, server);
			return;
		}
		if (method === "DELETE") {
			const removed = await registry.remove(id);
			if (!removed) {
				throw new McpRegistryError(`MCP 服务不存在: ${id}`, 404);
			}
			json(res, 200, { removed: true });
			return;
		}
		methodNotAllowed(res, method, "GET / PATCH / DELETE");
		return;
	}

	/* ---------------- /api/mcp/tools/:id ---------------- */
	const toolMatch = new RegExp(`^${MCP_PREFIX}/tools/([^/]+)$`).exec(pathname);
	if (toolMatch) {
		const id = decodeSegment(toolMatch[1]!);
		if (method !== "PATCH") {
			methodNotAllowed(res, method, "PATCH");
			return;
		}
		const body = await readJsonBody(req);
		if (typeof body.enabled !== "boolean") {
			throw new McpRegistryError("enabled 必须是布尔值", 400);
		}
		const tool = registry.setToolEnabled(id, body.enabled);
		if (!tool) {
			throw new McpRegistryError(`MCP 工具不存在: ${id}`, 404);
		}
		json(res, 200, tool);
		return;
	}

	throw new McpRegistryError("MCP 接口不存在", 404);
}

/** 返回 true = 这个请求已被 MCP 管理接口接管。 */
export async function handleMcpRoute(
	req: IncomingMessage,
	res: ServerResponse,
	url: URL,
	registry: McpRegistry,
	auth: AuthRuntime,
): Promise<boolean> {
	const pathname = url.pathname;
	if (pathname !== MCP_PREFIX && !pathname.startsWith(`${MCP_PREFIX}/`)) {
		return false;
	}
	try {
		const denied = authorize(auth, req, req.method ?? "GET");
		if (denied) {
			json(res, denied.status, { error: denied.error });
			return true;
		}
		await route(req, res, pathname, registry);
	} catch (error) {
		if (error instanceof McpRegistryError) {
			json(res, error.status, { error: error.message });
			return true;
		}
		if (error instanceof McpClientError) {
			// 传输层失败（连不上/超时）：502 比 500 更准确地表达「上游 MCP 服务不可用」
			json(res, 502, { error: error.message });
			return true;
		}
		console.error(`MCP 接口出错: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
		json(res, 500, { error: error instanceof Error ? error.message : String(error) });
	}
	return true;
}
