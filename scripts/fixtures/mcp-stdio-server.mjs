#!/usr/bin/env node
/**
 * 零依赖假 MCP Server（P7 测试夹具）：stdio 传输，stdin/stdout 按换行分隔的 JSON-RPC 2.0。
 *
 * 给 `scripts/mcp-selftest.ts` 与 `scripts/smoke-mcp.ts` 用，别当生产代码。
 * 支持：initialize / notifications/initialized / ping / tools/list / tools/call。
 *
 * 工具：
 *   echo  —— 回显 text 参数（验参数透传与 UTF-8）
 *   add   —— 两个数字相加（验调用成功）
 *   boom  —— 永远返回 isError: true（验工具级错误）
 *   slow  —— 2 秒后才回包（验客户端超时后连接仍可用，测试把超时调小）
 *   env   —— 返回环境变量 FIXTURE_GREETING（验 Windows 下 spawn env 透传）
 *
 * 退出：stdin 关闭（父进程 close/退出）时退出，不留孤儿进程。
 */

import { createInterface } from "node:readline";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "fake-mcp-stdio", version: "0.1.0" };

const TOOLS = [
	{
		name: "echo",
		description: "回显传入的 text 参数（测试用）",
		inputSchema: {
			type: "object",
			properties: { text: { type: "string", description: "要回显的文本" } },
			required: ["text"],
		},
	},
	{
		name: "add",
		description: "把两个数字相加",
		inputSchema: {
			type: "object",
			properties: { a: { type: "number" }, b: { type: "number" } },
			required: ["a", "b"],
		},
	},
	{
		name: "boom",
		description: "总是返回错误（isError: true）的工具",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "slow",
		description: "2 秒后才返回，用于验证客户端超时",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "env",
		description: "返回进程环境变量 FIXTURE_GREETING，用于验证 spawn 的环境变量透传",
		inputSchema: { type: "object", properties: {} },
	},
];

function send(message) {
	// 显式 UTF-8：Windows 管道里 Node 默认就是 UTF-8，别让控制台代码页影响子进程
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
	send({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message) {
	send({ jsonrpc: "2.0", id, error: { code, message } });
}

function textResult(text, isError = false) {
	return { content: [{ type: "text", text }], isError };
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function handle(message) {
	const id = message?.id;
	const method = message?.method;
	const params = message?.params ?? {};
	if (typeof method !== "string") {
		return;
	}

	switch (method) {
		case "initialize":
			reply(id, {
				protocolVersion: PROTOCOL_VERSION,
				capabilities: { tools: { listChanged: false } },
				serverInfo: SERVER_INFO,
			});
			return;
		case "notifications/initialized":
		case "notifications/cancelled":
			// 通知没有 id，不回包
			return;
		case "ping":
			reply(id, {});
			return;
		case "tools/list":
			reply(id, { tools: TOOLS });
			return;
		case "tools/call": {
			const name = params?.name;
			const args = params?.arguments ?? {};
			if (name === "echo") {
				reply(id, textResult(typeof args.text === "string" ? args.text : JSON.stringify(args)));
				return;
			}
			if (name === "add") {
				const a = Number(args.a);
				const b = Number(args.b);
				if (!Number.isFinite(a) || !Number.isFinite(b)) {
					reply(id, textResult("参数 a / b 必须是数字", true));
					return;
				}
				reply(id, textResult(String(a + b)));
				return;
			}
			if (name === "boom") {
				reply(id, textResult("故意失败：这个工具永远返回错误", true));
				return;
			}
			if (name === "slow") {
				// 延迟可用环境变量调大：自检里要"稳超时"，别让 2 秒和超时阈值贴太近
				const slowMs = Number(process.env.FIXTURE_SLOW_MS ?? 2000) || 2000;
				await sleep(slowMs);
				reply(id, textResult("慢工具完成"));
				return;
			}
			if (name === "env") {
				reply(id, textResult(process.env.FIXTURE_GREETING ?? "（未设置 FIXTURE_GREETING）"));
				return;
			}
			replyError(id, -32602, `未知工具: ${String(name)}`);
			return;
		}
		default:
			if (id !== undefined && id !== null) {
				replyError(id, -32601, `不支持的方法: ${method}`);
			}
	}
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
	const trimmed = line.trim();
	if (!trimmed) {
		return;
	}
	let message;
	try {
		message = JSON.parse(trimmed);
	} catch {
		process.stderr.write(`假 MCP Server 收到非 JSON 行: ${trimmed.slice(0, 200)}\n`);
		return;
	}
	void handle(message);
});

lines.on("close", () => {
	// 父进程关闭 stdin / 退出：这里也退出，避免 Windows 上留下孤儿 node 进程
	process.exit(0);
});

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
