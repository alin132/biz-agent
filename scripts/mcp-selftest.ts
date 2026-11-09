/**
 * P7 MCP 集成自检（`npm run mcp:selftest`）——零网络、临时 SQLite、不起服务。
 *
 * 覆盖：
 *   - 工具命名规则（大小写/空格/连字符/中文/前缀/确定性）
 *   - stdio 握手、tools/list 解析、工具调用、内容块 → 文本、UTF-8、环境变量透传
 *   - 工具级 isError、请求超时（中文错误 + 超时后连接仍可用）、close()、子进程退出
 *   - 不可达 HTTP / SSE 的中文错误
 *   - MCP DAO 往返（server/tools 的增删改查、删服务级联删工具）
 *   - registry：注册即发现、ToolDef 的命名/schema/描述/risk、调用、工具启停、
 *     refresh 幂等、失败落库 last_status、删除清空
 *
 * 用临时库 data/g25-mcp-selftest.db，跑完删掉。
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { SqliteStorage } from "../server/db/sqlite.js";
import type { McpClient } from "../server/mcp/client.js";
import { createMcpClient, mcpResultText } from "../server/mcp/client.js";
import { MCP_TOOL_PREFIX, mcpToolName } from "../server/mcp/names.js";
import { McpRegistry } from "../server/mcp/registry.js";
import { piMcpToolName } from "../server/mcp/piNames.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const TMP_DIR = resolve(ROOT, "data");
const DB_PATH = resolve(TMP_DIR, "g25-mcp-selftest.db");
const FIXTURE = resolve(ROOT, "scripts/fixtures/mcp-stdio-server.mjs");

let passed = 0;

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
	try {
		await fn();
		passed += 1;
		console.log(`  ✓ ${name}`);
	} catch (error) {
		console.error(`  ✗ ${name}`);
		console.error(error instanceof Error ? `    ${error.stack ?? error.message}` : `    ${String(error)}`);
		throw error;
	}
}

function removeDbFiles(base: string): void {
	for (const suffix of ["", "-wal", "-shm"]) {
		const file = `${base}${suffix}`;
		if (existsSync(file)) {
			rmSync(file, { force: true });
		}
	}
}

/** 断言一定会抛错，且文案包含中文关键词。 */
async function expectReject(fn: () => Promise<unknown>, contains: string): Promise<string> {
	try {
		await fn();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		assert.ok(
			message.includes(contains),
			`错误文案应包含「${contains}」，实际「${message}」`,
		);
		return message;
	}
	assert.fail(`应当抛错（期望文案包含「${contains}」），但调用成功了`);
}

/* ---------------- 假 HTTP / SSE MCP 服务（验成功链路，不联网） ---------------- */

const FAKE_TOOLS = [
	{
		name: "echo",
		description: "回显 text",
		inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
	},
	{
		name: "add",
		description: "两个数字相加",
		inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
	},
];

/** 造一条 JSON-RPC 响应；通知返回 null（不回包）。 */
function fakeRpcResponse(message: Record<string, unknown>): Record<string, unknown> | null {
	const id = message.id;
	const method = message.method;
	const params = message.params as Record<string, unknown> | undefined;
	if (method === "initialize") {
		return {
			jsonrpc: "2.0",
			id,
			result: {
				protocolVersion: "2024-11-05",
				capabilities: { tools: {} },
				serverInfo: { name: "fake-http", version: "0.1.0" },
			},
		};
	}
	if (method === "notifications/initialized" || method === "notifications/cancelled") {
		return null;
	}
	if (method === "tools/list") {
		return { jsonrpc: "2.0", id, result: { tools: FAKE_TOOLS } };
	}
	if (method === "tools/call") {
		const name = params?.name;
		const args = (params?.arguments ?? {}) as Record<string, unknown>;
		if (name === "echo") {
			return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: String(args.text ?? "") }], isError: false } };
		}
		if (name === "add") {
			const sum = Number(args.a) + Number(args.b);
			return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: String(sum) }], isError: false } };
		}
		return { jsonrpc: "2.0", id, error: { code: -32602, message: `未知工具: ${String(name)}` } };
	}
	return { jsonrpc: "2.0", id, error: { code: -32601, message: `不支持的方法: ${String(method)}` } };
}

interface FakeHttpServer {
	url: string;
	/** 收到过 Mcp-Session-Id 的请求（验 HTTP 会话 id 回传） */
	sessionIds: string[];
	close(): Promise<void>;
}

/**
 * 起一个最小 HTTP / SSE MCP 服务：
 *   - http 模式：POST /mcp 直接回 JSON + `Mcp-Session-Id` 响应头；
 *   - sse  模式：GET /sse 先发 endpoint 事件，POST /messages 回 202，响应写回 SSE 流。
 */
async function startFakeHttpServer(mode: "http" | "sse"): Promise<FakeHttpServer> {
	const sessionIds: string[] = [];
	let stream: ServerResponse | null = null;
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		void (async () => {
			const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
			if (mode === "sse" && req.method === "GET" && requestUrl.pathname === "/sse") {
				res.writeHead(200, {
					"Content-Type": "text/event-stream; charset=utf-8",
					"Cache-Control": "no-cache",
					Connection: "keep-alive",
				});
				stream = res;
				res.write("event: endpoint\ndata: /messages\n\n");
				return;
			}
			const expectedPath = mode === "sse" ? "/messages" : "/mcp";
			if (req.method === "POST" && requestUrl.pathname === expectedPath) {
				const chunks: Buffer[] = [];
				for await (const chunk of req) {
					chunks.push(chunk as Buffer);
				}
				const message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
				const session = req.headers["mcp-session-id"];
				if (typeof session === "string") {
					sessionIds.push(session);
				}
				const response = fakeRpcResponse(message);
				if (mode === "sse") {
					res.writeHead(202, { "Content-Type": "application/json" });
					res.end();
					if (response && stream) {
						stream.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
					}
					return;
				}
				res.writeHead(200, {
					"Content-Type": "application/json",
					"Mcp-Session-Id": "fake-http-session",
				});
				res.end(response === null ? "" : JSON.stringify(response));
				return;
			}
			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "not found" }));
		})().catch(() => {
			try {
				res.writeHead(500);
				res.end();
			} catch {
				// 响应可能已经结束
			}
		});
	});
	await new Promise<void>((resolveListen) => {
		server.listen(0, "127.0.0.1", () => resolveListen());
	});
	const address = server.address();
	const port = typeof address === "object" && address !== null ? address.port : 0;
	return {
		url: `http://127.0.0.1:${port}${mode === "sse" ? "/sse" : "/mcp"}`,
		sessionIds,
		async close(): Promise<void> {
			stream?.end();
			await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
		},
	};
}

async function main(): Promise<void> {
	console.log("P7 MCP 集成自检（不起服务）");
	mkdirSync(TMP_DIR, { recursive: true });
	removeDbFiles(DB_PATH);

	const db = new SqliteStorage(DB_PATH);
	const registry = new McpRegistry(db, { timeoutMs: 1500, onLog: () => {} });
	/** 保持一个 stdio 客户端跨多个用例，最后关闭。 */
	const clients: McpClient[] = [];

	try {
		/* ---------------- 1. 命名规则 ---------------- */

		await check("工具名：大写/空格/连字符归一为小写下划线", () => {
			assert.equal(mcpToolName("CRM Server", "Get-Weather"), "mcp_crm_server_get_weather");
			assert.equal(mcpToolName("a b", "x_y"), "mcp_a_b_x_y");
			assert.equal(mcpToolName("S", "T"), "mcp_s_t");
		});

		await check("工具名：中文与非 ASCII 转下划线，结果只含 [a-z0-9_]", () => {
			const name = mcpToolName("客服", "天气");
			assert.match(name, /^mcp_[a-z0-9_]+$/);
			assert.equal(name, "mcp______", "「客服」+「天气」各 2 个非字母数字，加上分隔符共 6 个下划线");
			assert.equal(name, name.toLowerCase());
		});

		await check("工具名：前缀是唯一真相且结果确定", () => {
			assert.equal(MCP_TOOL_PREFIX, "mcp_");
			const name = mcpToolName("Server", "Tool");
			assert.ok(name.startsWith(MCP_TOOL_PREFIX));
			assert.equal(name, mcpToolName("Server", "Tool"));
			assert.notEqual(name, mcpToolName("Server", "Tool2"));
		});

		/* ---------------- 2. stdio 协议 ---------------- */

		const stdio = createMcpClient({
			transport: "stdio",
			command: process.execPath,
			args: [FIXTURE],
			env: { FIXTURE_GREETING: "你好，MCP" },
			timeoutMs: 5000,
		});
		clients.push(stdio);

		await check("stdio 握手：protocolVersion + capabilities + serverInfo", async () => {
			const init = await stdio.initialize();
			assert.equal(init.protocolVersion, "2024-11-05");
			assert.equal(init.serverInfo.name, "fake-mcp-stdio");
			assert.ok(init.serverInfo.version);
			assert.ok(init.capabilities.tools, "应声明 tools capability");
		});

		await check("tools/list 解析：数量、描述、inputSchema 透传", async () => {
			const tools = await stdio.listTools();
			assert.equal(tools.length, 5);
			const add = tools.find((tool) => tool.name === "add");
			assert.ok(add, "缺少 add 工具");
			assert.equal(add.description, "把两个数字相加");
			assert.deepEqual(add.inputSchema.required, ["a", "b"]);
			assert.equal((add.inputSchema.properties as Record<string, unknown>).a !== undefined, true);
		});

		await check("调用成功：add 返回 3（JSON-RPC id 配对正确）", async () => {
			const result = await stdio.callTool("add", { a: 1, b: 2 });
			assert.equal(result.isError, false);
			assert.equal(mcpResultText(result), "3");
		});

		await check("中文 UTF-8 参数与结果原样往返", async () => {
			const text = "中文回显 ✓（路径 D:\\Agent学习\\企业agent）";
			const result = await stdio.callTool("echo", { text });
			assert.equal(mcpResultText(result), text);
		});

		await check("工具级错误：isError 透传且文本可读", async () => {
			const result = await stdio.callTool("boom", {});
			assert.equal(result.isError, true);
			assert.ok(mcpResultText(result).includes("故意失败"));
		});

		await check("未知工具返回 JSON-RPC error（中文包装）", async () => {
			await expectReject(() => stdio.callTool("no-such-tool", {}), "MCP 返回错误");
		});

		await check("spawn 环境变量透传（Windows 下也走 UTF-8 文本）", async () => {
			const result = await stdio.callTool("env", {});
			assert.equal(mcpResultText(result), "你好，MCP");
		});

		/* ---------------- 3. HTTP / SSE 成功链路（假服务，不联网） ---------------- */

		await check("HTTP 传输：握手/列表/调用成功，并回传 Mcp-Session-Id", async () => {
			const fake = await startFakeHttpServer("http");
			const client = createMcpClient({
				transport: "http",
				url: fake.url,
				headers: { "X-Test": "1" },
				timeoutMs: 3000,
			});
			try {
				const init = await client.initialize();
				assert.equal(init.serverInfo.name, "fake-http");
				const tools = await client.listTools();
				assert.equal(tools.length, 2);
				const result = await client.callTool("echo", { text: "HTTP 你好" });
				assert.equal(mcpResultText(result), "HTTP 你好");
				assert.ok(
					fake.sessionIds.includes("fake-http-session"),
					"后续请求应带回服务端下发的 Mcp-Session-Id",
				);
			} finally {
				await client.close();
				await fake.close();
			}
		});

		await check("SSE 传输：endpoint 事件 → POST 回传 → 流内按 id 配对", async () => {
			const fake = await startFakeHttpServer("sse");
			const client = createMcpClient({ transport: "sse", url: fake.url, timeoutMs: 3000 });
			try {
				const init = await client.initialize();
				assert.equal(init.serverInfo.name, "fake-http");
				const result = await client.callTool("add", { a: 4, b: 6 });
				assert.equal(mcpResultText(result), "10");
			} finally {
				await client.close();
				await fake.close();
			}
		});

		/* ---------------- 4. 超时 / 关闭 / 进程退出 ---------------- */

		await check("请求超时：中文错误，且同一个连接随后仍可用", async () => {
			const fast = createMcpClient({
				transport: "stdio",
				command: process.execPath,
				args: [FIXTURE],
				// 超时阈值要够 initialize 启动，慢工具用环境变量拉长到 6 秒，避免"阈值贴太近"的偶发失败
				timeoutMs: 1500,
				env: { FIXTURE_SLOW_MS: "6000" },
			});
			clients.push(fast);
			await fast.initialize();
			const message = await expectReject(() => fast.callTool("slow", {}), "超时");
			assert.ok(message.includes("tools/call"), `超时文案应指出方法，实际「${message}」`);
			// 超时只拒绝那一个请求；迟到的响应会被丢弃，不能污染后续请求
			const after = await fast.callTool("echo", { text: "超时后仍可用" });
			assert.equal(mcpResultText(after), "超时后仍可用");
		});

		await check("close() 之后调用被中文拒绝", async () => {
			const closed = createMcpClient({
				transport: "stdio",
				command: process.execPath,
				args: [FIXTURE],
				timeoutMs: 2000,
			});
			await closed.initialize();
			await closed.close();
			await expectReject(() => closed.callTool("echo", { text: "x" }), "关闭");
		});

		await check("子进程退出：挂起请求被中文拒绝（不把进程带崩）", async () => {
			const dying = createMcpClient({
				transport: "stdio",
				command: process.execPath,
				args: ["-e", "setTimeout(() => process.exit(3), 120)"],
				timeoutMs: 3000,
			});
			await expectReject(() => dying.initialize(), "退出");
			await dying.close();
		});

		await check("不可达 HTTP：中文错误", async () => {
			const client = createMcpClient({ transport: "http", url: "http://127.0.0.1:1/mcp", timeoutMs: 2000 });
			await expectReject(() => client.initialize(), "MCP HTTP");
			await client.close();
		});

		await check("不可达 SSE：中文错误", async () => {
			const client = createMcpClient({ transport: "sse", url: "http://127.0.0.1:1/sse", timeoutMs: 2000 });
			await expectReject(() => client.initialize(), "MCP SSE");
			await client.close();
		});

		/* ---------------- 5. DAO 往返 ---------------- */

		await check("DAO：MCP 服务增删改查往返（JSON 字段与时间戳）", () => {
			assert.equal(new McpRegistry(db).toolDefs().length, 0, "默认没有服务时工具目录为空");
			const now = Date.now();
			const created = db.createMcpServer({
				id: "mcp-dao-1",
				name: "DAO 服务",
				transport: "sse",
				command: null,
				args: [],
				url: "http://127.0.0.1:9/sse",
				headers: { Authorization: "Bearer x" },
				env: {},
				enabled: false,
				createdAt: now,
				updatedAt: now,
			});
			assert.equal(created.lastStatus, "unknown");
			assert.deepEqual(created.headers, { Authorization: "Bearer x" });
			assert.deepEqual(db.getMcpServer("mcp-dao-1")?.args, []);
			assert.equal(db.listMcpServers().length, 1);

			const updated = db.updateMcpServer("mcp-dao-1", {
				name: "DAO 服务（改）",
				args: ["--flag", "值"],
				env: { TOKEN: "t" },
				lastStatus: "error",
				lastError: "测试错误",
				lastCheckedAt: now + 1,
				updatedAt: now + 1,
			});
			assert.ok(updated);
			assert.equal(updated.name, "DAO 服务（改）");
			assert.deepEqual(updated.args, ["--flag", "值"]);
			assert.deepEqual(updated.env, { TOKEN: "t" });
			assert.equal(updated.lastStatus, "error");
			assert.equal(updated.lastError, "测试错误");
			assert.equal(updated.lastCheckedAt, now + 1);
		});

		await check("DAO：工具 CRUD，删服务连带删工具", () => {
			const now = Date.now();
			db.createMcpServer({
				id: "mcp-dao-2",
				name: "DAO 工具服务",
				transport: "stdio",
				command: "node",
				args: [],
				url: null,
				headers: {},
				env: {},
				enabled: true,
				createdAt: now,
				updatedAt: now,
			});
			const tool = db.createMcpTool({
				id: "mtool-dao-1",
				serverId: "mcp-dao-2",
				name: "query",
				description: "查询",
				inputSchema: { type: "object", properties: { q: { type: "string" } } },
				enabled: true,
				createdAt: now,
			});
			assert.equal(tool.description, "查询");
			assert.equal(db.listMcpTools("mcp-dao-2").length, 1);
			assert.equal(db.getMcpTool("mtool-dao-1")?.name, "query");
			assert.equal(db.updateMcpTool("mtool-dao-1", { enabled: false })?.enabled, false);
			assert.equal(db.removeMcpServer("mcp-dao-2"), true);
			assert.equal(db.getMcpServer("mcp-dao-2"), undefined);
			assert.equal(db.listMcpTools("mcp-dao-2").length, 0, "删服务要连带删工具");
			assert.equal(db.removeMcpTool("mtool-dao-1"), false);
		});

		await check("DAO：删不存在的服务返回 false，并清理 DAO 数据", () => {
			assert.equal(db.removeMcpServer("mcp-none"), false);
			assert.equal(db.removeMcpServer("mcp-dao-1"), true);
			assert.equal(db.listMcpServers().length, 0);
		});

		await check("SQLite 老库自愈：缺 env/last_status 列自动补齐", () => {
			// 模拟"只按 0001 那版建过表"的库：CREATE TABLE IF NOT EXISTS 不会补列，必须靠 PRAGMA + ALTER
			const legacyPath = resolve(TMP_DIR, "g25-mcp-legacy.db");
			removeDbFiles(legacyPath);
			const raw = new DatabaseSync(legacyPath);
			raw.exec(`CREATE TABLE mcp_servers (
				id TEXT PRIMARY KEY,
				workspace_id TEXT NOT NULL DEFAULT 'default',
				name TEXT NOT NULL,
				transport TEXT NOT NULL DEFAULT 'stdio',
				command TEXT,
				args TEXT,
				url TEXT,
				headers TEXT,
				enabled INTEGER NOT NULL DEFAULT 1,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)`);
			raw.exec(`CREATE TABLE mcp_tools (
				id TEXT PRIMARY KEY,
				server_id TEXT NOT NULL,
				name TEXT NOT NULL,
				description TEXT,
				input_schema TEXT,
				enabled INTEGER NOT NULL DEFAULT 1,
				created_at INTEGER NOT NULL,
				UNIQUE (server_id, name)
			)`);
			raw.close();

			const legacy = new SqliteStorage(legacyPath);
			try {
				const now = Date.now();
				const created = legacy.createMcpServer({
					id: "mcp-legacy",
					name: "老库服务",
					transport: "stdio",
					command: "node",
					args: [],
					url: null,
					headers: {},
					env: { FIXTURE_GREETING: "老库" },
					enabled: true,
					createdAt: now,
					updatedAt: now,
				});
				assert.deepEqual(created.env, { FIXTURE_GREETING: "老库" });
				assert.equal(created.lastStatus, "unknown");
				assert.equal(created.lastError, null);
				assert.equal(legacy.listMcpServers().length, 1);
			} finally {
				legacy.close();
				removeDbFiles(legacyPath);
			}
		});

		/* ---------------- 6. registry：注册 / 发现 / 调用 ---------------- */

		let serverId = "";

		await check("注册即发现：落库、工具生成、last_status=ok", async () => {
			const view = await registry.create({
				name: "Selftest MCP",
				transport: "stdio",
				command: process.execPath,
				args: [FIXTURE],
				url: null,
				headers: {},
				env: { FIXTURE_GREETING: "registry" },
				enabled: true,
			});
			serverId = view.id;
			assert.equal(view.lastStatus, "ok");
			assert.equal(view.lastError, null);
			assert.equal(view.toolCount, 5);
			assert.ok(view.tools.some((tool) => tool.toolName === "mcp_selftest_mcp_add"));
			assert.equal(db.getMcpServer(view.id)?.lastStatus, "ok");
			assert.equal(db.listMcpTools(view.id).length, 5);
		});

		await check("ToolDef 透传：名字/schema/description，risk=high 走审批", () => {
			const defs = registry.toolDefs();
			assert.equal(defs.length, 5);
			const add = defs.find((def) => def.name === "mcp_selftest_mcp_add");
			assert.ok(add, "缺少 mcp_selftest_mcp_add");
			assert.equal(add.category, "MCP");
			assert.equal(add.risk, "high");
			assert.equal(add.description, "把两个数字相加");
			assert.deepEqual(add.parameters.required, ["a", "b"]);
			assert.equal(registry.toolNames().includes("mcp_selftest_mcp_add"), true);
		});

		await check("Pi MCP 配置与名称映射：数据库快照保留 legacy alias 和禁用标记", () => {
			const config = registry.piConfigSnapshot();
			const server = config.servers.find((item) => item.name === "Selftest MCP");
			assert.ok(server);
			assert.equal(server.config.type, "stdio");
			assert.equal(server.config.exposure, "deferred");
			const aliases = registry.piToolAliases();
			assert.equal(aliases[piMcpToolName("Selftest MCP", "add")], "mcp_selftest_mcp_add");
			const add = registry.listTools(serverId)?.find((tool) => tool.name === "add");
			assert.ok(add);
			registry.setToolEnabled(add.id, false);
			const disabledServer = registry.piConfigSnapshot().servers.find((item) => item.name === "Selftest MCP");
			assert.ok(disabledServer);
			assert.equal(disabledServer.config.toolExposure.add, "hidden");
			registry.setToolEnabled(add.id, true);
		});

		await check("重启恢复：新 registry 构造时用库里的工具建快照", () => {
			// WorkflowRepo 构造时就要能校验"技能 via 里的 MCP 工具"，所以快照不能等到 start() 才有
			const fresh = new McpRegistry(db, { onLog: () => {} });
			assert.equal(fresh.toolNames().length, 5);
			assert.ok(fresh.toolDefs().some((def) => def.name === "mcp_selftest_mcp_add"));
		});

		await check("registry 调用：成功结果与 isError 都能透传", async () => {
			const ok = await registry.callTool(serverId, "add", { a: 20, b: 22 });
			assert.equal(ok.result.isError, false);
			assert.equal(ok.text, "42");
			assert.equal(ok.toolName, "mcp_selftest_mcp_add");
			const failed = await registry.callTool(serverId, "boom", {});
			assert.equal(failed.result.isError, true);
			assert.ok(failed.text.includes("故意失败"));
		});

		await check("工具启停：禁用后旧会话调用被拒绝，重新启用后恢复", async () => {
			const addTool = registry.listTools(serverId)?.find((tool) => tool.name === "add");
			assert.ok(addTool);
			const disabled = registry.setToolEnabled(addTool.id, false);
			assert.equal(disabled?.enabled, false);
			assert.equal(registry.toolDefs().some((def) => def.name === "mcp_selftest_mcp_add"), false);
			assert.equal(db.getMcpTool(addTool.id)?.enabled, false);
			await assert.rejects(() => registry.callTool(serverId, "add", { a: 1, b: 2 }), /已停用/);
			assert.equal(registry.setToolEnabled(addTool.id, true)?.enabled, true);
			assert.equal(registry.toolDefs().some((def) => def.name === "mcp_selftest_mcp_add"), true);
			assert.equal((await registry.callTool(serverId, "add", { a: 1, b: 2 })).text, "3");
		});

		await check("refresh 幂等：工具数不变、无重名", async () => {
			const refreshed = await registry.refresh(serverId);
			assert.equal(refreshed?.toolCount, 5);
			const names = registry.toolNames();
			assert.equal(new Set(names).size, names.length);
			assert.equal(names.length, 5);
		});

		await check("连接失败也落库：last_status=error + 中文原因（不抛）", async () => {
			const bad = await registry.create({
				name: "Selftest Bad",
				transport: "http",
				command: null,
				args: [],
				url: "http://127.0.0.1:1/mcp",
				headers: {},
				env: {},
				enabled: true,
			});
			assert.equal(bad.lastStatus, "error");
			assert.ok(bad.lastError && bad.lastError.includes("失败"), `实际「${String(bad.lastError)}」`);
			const row = db.getMcpServer(bad.id);
			assert.equal(row?.lastStatus, "error");
			assert.equal(row?.lastError, bad.lastError);
			await registry.remove(bad.id);
		});

		await check("start()：不可用服务只记状态，不抛异常", async () => {
			const now = Date.now();
			db.createMcpServer({
				id: "mcp-badstart",
				name: "坏服务",
				transport: "http",
				command: null,
				args: [],
				url: "http://127.0.0.1:1/mcp",
				headers: {},
				env: {},
				enabled: true,
				createdAt: now,
				updatedAt: now,
			});
			await registry.start();
			assert.equal(db.getMcpServer("mcp-badstart")?.lastStatus, "error");
			assert.ok(db.getMcpServer("mcp-badstart")?.lastError?.includes("失败"));
			await registry.remove("mcp-badstart");
		});

		await check("删除服务：连接关闭、工具清空、快照为空", async () => {
			const removed = await registry.remove(serverId);
			assert.equal(removed, true);
			assert.equal(db.getMcpServer(serverId), undefined);
			assert.equal(db.listMcpTools(serverId).length, 0);
			assert.equal(registry.toolDefs().length, 0);
			assert.equal(registry.listServers().length, 0);
		});
	} finally {
		await registry.close();
		for (const client of clients) {
			await client.close().catch(() => {
				// 有的已经关闭
			});
		}
		db.close();
		removeDbFiles(DB_PATH);
	}

	console.log(`\n全部通过：${passed} 项检查`);
	if (passed < 18) {
		console.error(`自检项数不足：${passed} < 18`);
		process.exit(1);
	}
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
