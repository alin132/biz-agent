/**
 * MCP 端到端冒烟（`npm run smoke:mcp`）：走真实 HTTP，验证「注册 → 发现 → 会话可见 → 调用 → 启停 → 删除」。
 *
 * 前置：另起一个隔离实例（**别**打 4317 的 live 服务）：
 *   $env:PORT="4350"; $env:DB_PATH="$PWD\data\g25-smoke.db"; $env:LLM_DISABLE="1"; $env:AUTH_MODE="off"; npm run dev
 *   $env:SMOKE_MCP_BASE="http://127.0.0.1:4350"; npm run smoke:mcp
 *
 * 脚本用 `process.execPath` + fixtures 里的假 MCP Server 起一个 stdio 服务，
 * 路径里有中文/空格也能验证 Windows 下的 spawn 行为；所有 "Smoke" 开头的服务会在开始/结束各清一次。
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.env.SMOKE_MCP_BASE ?? "http://127.0.0.1:4317";
const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const FIXTURE = resolve(ROOT, "scripts/fixtures/mcp-stdio-server.mjs");
const SERVER_NAME = "Smoke MCP";

let assertions = 0;

function fail(message: string): never {
	console.error(`✗ ${message}`);
	process.exit(1);
}

function assert(condition: boolean, message: string): void {
	if (!condition) {
		fail(message);
	}
	assertions += 1;
	console.log(`  ✓ ${message}`);
}

interface ToolView {
	id: string;
	serverId: string;
	serverName: string;
	name: string;
	toolName: string;
	description: string;
	inputSchema: Record<string, unknown>;
	enabled: boolean;
}

interface ServerView {
	id: string;
	name: string;
	transport: string;
	command: string | null;
	args: string[];
	url: string | null;
	enabled: boolean;
	lastStatus: string;
	lastError: string | null;
	toolCount: number;
	tools: ToolView[];
}

interface ToolSummary {
	name: string;
	description: string;
	category: string;
	risk: string;
	hasExample: boolean;
}

interface CallView {
	serverId: string;
	serverName: string;
	tool: string;
	toolName: string;
	isError: boolean;
	text: string;
	content: { type: string; text?: string }[];
}

async function request<T>(
	method: string,
	path: string,
	body?: Record<string, unknown>,
): Promise<{ status: number; data: T }> {
	let response: Response;
	try {
		response = await fetch(`${BASE}${path}`, {
			method,
			headers: body === undefined ? undefined : { "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	} catch (error) {
		fail(
			`请求 ${method} ${path} 失败（${error instanceof Error ? error.message : String(error)}）——先起服务并设置 SMOKE_MCP_BASE`,
		);
	}
	const text = await response.text();
	let data: unknown = null;
	if (text.length > 0) {
		try {
			data = JSON.parse(text) as unknown;
		} catch {
			data = text;
		}
	}
	return { status: response.status, data: data as T };
}

/** 取一个成功响应；失败时把状态码与错误文案一起打出来。 */
async function ok<T>(method: string, path: string, body?: Record<string, unknown>): Promise<T> {
	const result = await request<T>(method, path, body);
	if (result.status < 200 || result.status >= 300) {
		fail(`${method} ${path} 期望 2xx，实际 ${result.status}：${JSON.stringify(result.data)}`);
	}
	return result.data;
}

async function listToolsCatalog(): Promise<ToolSummary[]> {
	return ok<ToolSummary[]>("GET", "/api/tools");
}

/** 只清理本脚本起的服务，别误删别人手工注册的 MCP 服务。 */
async function cleanupSmokeServers(): Promise<void> {
	const listed = await ok<{ items: ServerView[] }>("GET", "/api/mcp/servers");
	for (const server of listed.items) {
		if (server.name.startsWith("Smoke")) {
			await request("DELETE", `/api/mcp/servers/${encodeURIComponent(server.id)}`);
		}
	}
}

async function main(): Promise<void> {
	console.log("MCP 端到端冒烟（注册 → 发现 → 会话 → 调用 → 启停 → 删除）");

	const health = await ok<{ ok: boolean }>("GET", "/api/health");
	assert(health.ok === true, "GET /api/health 可用（服务已启动）");

	await cleanupSmokeServers();

	/* ---------------- 1. 初始状态 ---------------- */
	const initial = await ok<{ items: ServerView[] }>("GET", "/api/mcp/servers");
	assert(
		initial.items.every((server) => !server.name.startsWith("Smoke")),
		"清理后没有残留的 Smoke 服务",
	);

	/* ---------------- 2. 注册 stdio 服务：立即 initialize + tools/list ---------------- */
	const created = await ok<ServerView>("POST", "/api/mcp/servers", {
		name: SERVER_NAME,
		transport: "stdio",
		command: process.execPath,
		args: [FIXTURE],
		env: { FIXTURE_GREETING: "冒烟测试" },
	});
	assert(created.lastStatus === "ok", `注册即握手成功（lastStatus=${created.lastStatus}）`);
	assert(created.toolCount === 5, `注册后立即发现 5 个工具（实际 ${created.toolCount}）`);
	assert(
		created.tools.some((tool) => tool.toolName === "mcp_smoke_mcp_add"),
		"工具名按 mcp_<server>_<tool> 生成",
	);
	const serverId = created.id;

	/* ---------------- 3. 列表带工具 ---------------- */
	const listed = await ok<{ items: ServerView[] }>("GET", "/api/mcp/servers");
	const listedServer = listed.items.find((server) => server.id === serverId);
	assert(listedServer !== undefined, "GET /api/mcp/servers 列表里能找到刚注册的服务");
	assert(listedServer?.toolCount === 5, "列表项带工具（toolCount=5）");

	/* ---------------- 4. 工具接口 ---------------- */
	const tools = await ok<{ items: ToolView[] }>("GET", `/api/mcp/servers/${serverId}/tools`);
	assert(tools.items.length === 5, `GET /:id/tools 返回 5 个工具（实际 ${tools.items.length}）`);
	const addTool = tools.items.find((tool) => tool.name === "add");
	assert(addTool !== undefined, "工具列表里有原始名 add");
	assert(
		addTool?.inputSchema.required !== undefined && Array.isArray(addTool.inputSchema.required),
		"inputSchema 原样透传（required 数组）",
	);
	const echoTool = tools.items.find((tool) => tool.name === "echo");
	assert(echoTool !== undefined, "工具列表里有 echo");

	/* ---------------- 5. refresh 幂等 ---------------- */
	const refreshed = await ok<ServerView>("POST", `/api/mcp/servers/${serverId}/refresh`);
	assert(refreshed.toolCount === 5, "refresh 后工具数不变（幂等）");
	assert(
		refreshed.tools.filter((tool) => tool.name === "add").length === 1,
		"refresh 不会把同一个工具重复发现",
	);

	/* ---------------- 6. /api/tools 与会话工具集 ---------------- */
	let catalog = await listToolsCatalog();
	const addSummary = catalog.find((tool) => tool.name === "mcp_smoke_mcp_add");
	assert(addSummary !== undefined, "/api/tools 里能看到 MCP 工具（技能编辑器可挑）");
	assert(addSummary?.category === "MCP", "MCP 工具分类是 MCP");
	assert(addSummary?.risk === "high", "MCP 工具 risk=high（会走人工审批）");

	const session = await ok<{ id: string; tools: string[] }>("POST", "/api/sessions", {
		workflowId: "auto-flow",
	});
	assert(
		session.tools.includes("mcp_smoke_mcp_add"),
		"会话视图 tools 含 mcp_*（MCP 工具已并入会话工具集）",
	);
	const agent = await ok<{ id: string }>("POST", "/api/agents", { name: "Smoke MCP Agent" });
	const agentSession = await ok<{ id: string; agentId: string | null; tools: string[] }>("POST", "/api/sessions", {
		workflowId: "auto-flow",
		agentId: agent.id,
	});
	assert(agentSession.agentId === agent.id, "Agent 会话绑定正确的 Agent");
	assert(agentSession.tools.includes("mcp_smoke_mcp_add"), "Agent 会话自动获得已启用 MCP 工具");

	/* ---------------- 7. 工具启停 ---------------- */
	const addToolId = addTool!.id;
	const disabled = await ok<ToolView>("PATCH", `/api/mcp/tools/${addToolId}`, { enabled: false });
	assert(disabled.enabled === false, "PATCH /api/mcp/tools/:id 关闭工具");
	catalog = await listToolsCatalog();
	assert(
		catalog.every((tool) => tool.name !== "mcp_smoke_mcp_add"),
		"禁用后 /api/tools 里消失",
	);
	const enabled = await ok<ToolView>("PATCH", `/api/mcp/tools/${addToolId}`, { enabled: true });
	assert(enabled.enabled === true, "PATCH 重新启用工具");
	catalog = await listToolsCatalog();
	assert(
		catalog.some((tool) => tool.name === "mcp_smoke_mcp_add"),
		"重新启用后 /api/tools 里回来",
	);

	/* ---------------- 8. 直接调用 ---------------- */
	const called = await ok<CallView>("POST", `/api/mcp/servers/${serverId}/call`, {
		tool: "add",
		arguments: { a: 2, b: 5 },
	});
	assert(called.isError === false, "调用 add 成功（isError=false）");
	assert(called.text === "7", `调用结果文本为 7（实际「${called.text}」）`);
	assert(called.toolName === "mcp_smoke_mcp_add", "调用结果带平台工具名");
	assert(called.content.some((block) => block.type === "text"), "返回 MCP content 内容块");

	const failedCall = await ok<CallView>("POST", `/api/mcp/servers/${serverId}/call`, { tool: "boom" });
	assert(failedCall.isError === true, "isError 工具透传（boom）");
	assert(failedCall.text.includes("故意失败"), "isError 文本原样返回");

	const unknownCall = await request<{ error: string }>("POST", `/api/mcp/servers/${serverId}/call`, {
		tool: "no-such-tool",
	});
	assert(unknownCall.status === 404, `调用未知工具返回 404（实际 ${unknownCall.status}）`);
	assert(String(unknownCall.data.error).includes("没有名为"), "未知工具错误是中文且说明原因");

	/* ---------------- 9. 改配置 / 停用 / 启用 ---------------- */
	const renamed = await ok<ServerView>("PATCH", `/api/mcp/servers/${serverId}`, {
		name: "Smoke MCP Renamed",
	});
	assert(renamed.name === "Smoke MCP Renamed", "PATCH /api/mcp/servers/:id 改名成功");
	assert(
		renamed.tools.some((tool) => tool.toolName === "mcp_smoke_mcp_renamed_add"),
		"改名后工具名跟着重新生成",
	);

	const paused = await ok<ServerView>("PATCH", `/api/mcp/servers/${serverId}`, { enabled: false });
	assert(paused.enabled === false, "停用 MCP 服务");
	catalog = await listToolsCatalog();
	assert(
		catalog.every((tool) => !tool.name.startsWith("mcp_")),
		"停用后 /api/tools 里没有 MCP 工具",
	);

	const resumed = await ok<ServerView>("PATCH", `/api/mcp/servers/${serverId}`, { enabled: true });
	assert(resumed.enabled === true && resumed.lastStatus === "ok", "重新启用后自动重新握手");
	catalog = await listToolsCatalog();
	assert(
		catalog.some((tool) => tool.name === "mcp_smoke_mcp_renamed_add"),
		"重新启用后工具回到 /api/tools",
	);

	/* ---------------- 10. 失败也落库 ---------------- */
	const bad = await ok<ServerView>("POST", "/api/mcp/servers", {
		name: "Smoke Bad",
		transport: "http",
		url: "http://127.0.0.1:1/mcp",
	});
	assert(bad.lastStatus === "error", "不可达的 MCP 服务也落库，lastStatus=error");
	assert(
		typeof bad.lastError === "string" && bad.lastError.length > 0,
		`失败原因写入 lastError（${String(bad.lastError).slice(0, 60)}…）`,
	);
	await ok<{ removed: boolean }>("DELETE", `/api/mcp/servers/${bad.id}`);
	assert(true, "删除失败的服务");

	/* ---------------- 11. 非法入参 ---------------- */
	const invalid = await request<{ error: string }>("POST", "/api/mcp/servers", {
		name: "Smoke Invalid",
		transport: "stdio",
	});
	assert(invalid.status === 400, `stdio 缺 command 返回 400（实际 ${invalid.status}）`);
	assert(String(invalid.data.error).includes("command"), "非法入参错误是中文");

	/* ---------------- 12. 删除：工具清空 ---------------- */
	const removed = await ok<{ removed: boolean }>("DELETE", `/api/mcp/servers/${serverId}`);
	assert(removed.removed === true, "删除 MCP 服务");
	catalog = await listToolsCatalog();
	assert(
		catalog.every((tool) => !tool.name.startsWith("mcp_smoke")),
		"删除后 /api/tools 里的 MCP 工具清空",
	);
	const afterDelete = await ok<{ items: ServerView[] }>("GET", "/api/mcp/servers");
	assert(
		afterDelete.items.every((server) => !server.name.startsWith("Smoke")),
		"删除后服务列表里没有 Smoke 服务",
	);
	const missingTools = await request<{ error: string }>("GET", `/api/mcp/servers/${serverId}/tools`);
	assert(missingTools.status === 404, "删除后访问它的工具列表返回 404");

	/* ---------------- 收尾 ---------------- */
	await request("DELETE", `/api/sessions/${session.id}`);
	assert(true, "清理冒烟会话");

	console.log(`\n全部通过：${assertions} 项断言`);
	if (assertions < 10) {
		console.error(`冒烟断言不足：${assertions} < 10`);
		process.exit(1);
	}
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
