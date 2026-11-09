/** Enterprise-facing MCP client facade backed by Pi's protocol implementation. */

import {
	McpClient as PiMcpClient,
	McpError as PiMcpError,
	McpTimeoutError,
	type CallToolResult,
	type McpTransport,
	type Tool,
} from "@earendil-works/pi-mcp";
import type { McpTransport as EnterpriseMcpTransport } from "../db/types.js";
import { createPiMcpTransport } from "./piTransport.js";
import { piSseSource } from "./piTransport.js";

export const MCP_PROTOCOL_VERSION = "2025-11-25";
export const MCP_DEFAULT_TIMEOUT_MS = 30_000;

export interface McpToolDescriptor {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

export interface McpInitializeResult {
	protocolVersion: string;
	capabilities: Record<string, unknown>;
	serverInfo: { name: string; version?: string };
}

export interface McpContentBlock {
	type: string;
	text?: string;
	[key: string]: unknown;
}

export interface McpCallToolResult {
	content: McpContentBlock[];
	isError: boolean;
	raw: Record<string, unknown>;
}

export interface McpClientOptions {
	transport: EnterpriseMcpTransport;
	command?: string | null;
	args?: string[];
	env?: Record<string, string>;
	url?: string | null;
	headers?: Record<string, string>;
	timeoutMs?: number;
	onStderr?: (line: string) => void;
}

export interface McpClient {
	readonly transport: EnterpriseMcpTransport;
	initialize(): Promise<McpInitializeResult>;
	listTools(): Promise<McpToolDescriptor[]>;
	callTool(name: string, args: Record<string, unknown>): Promise<McpCallToolResult>;
	close(): Promise<void>;
}

export class McpClientError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "McpClientError";
	}
}

function errorMessage(error: unknown, method: string): string {
	if (error instanceof McpTimeoutError) return `MCP 请求超时（${Math.round(error.timeoutMs / 1000)} 秒）：${method}`;
	if (error instanceof PiMcpError) return `MCP 返回错误${error.code}（${method}）：${error.message}`;
	const detail = error instanceof Error ? error.message : String(error);
	if (/client is closed|connection closed/i.test(detail)) return "MCP 连接已关闭";
	if (/fetch failed|ECONNREFUSED|ENOTFOUND|network/i.test(detail)) {
		return `连接 MCP ${method === "initialize" ? "HTTP" : "服务"}失败：${detail}`;
	}
	return detail;
}

function normalizeTool(tool: Tool): McpToolDescriptor {
	return {
		name: tool.name.trim(),
		description: tool.description ?? "",
		inputSchema: tool.inputSchema,
	};
}

function normalizeResult(result: CallToolResult): McpCallToolResult {
	return {
		content: result.content.map((block) => ({ ...block, type: block.type })),
		isError: result.isError === true,
		raw: result as unknown as Record<string, unknown>,
	};
}

function piTransportOf(options: McpClientOptions): McpTransport {
	const source = options.transport === "sse" ? piSseSource("registry") : "biz-agent:registry";
	const config = options.transport === "stdio"
		? {
			type: "stdio" as const,
			command: options.command ?? "",
			args: options.args ?? [],
			env: options.env ?? {},
			exposure: "deferred" as const,
		}
		: {
			type: "http" as const,
			url: options.url ?? "",
			headers: options.headers ?? {},
			exposure: "deferred" as const,
		};
	const entry = { name: "registry", source, scope: "extension" as const, config } as Parameters<typeof createPiMcpTransport>[0];
	return createPiMcpTransport(entry, process.cwd(), undefined);
}

class PiBackedMcpClient implements McpClient {
	readonly transport: EnterpriseMcpTransport;
	private readonly client: PiMcpClient;
	private readonly piTransport: McpTransport;
	private readonly timeoutMs: number;
	private closedMessage = "MCP 连接已关闭";
	private explicitlyClosed = false;

	constructor(options: McpClientOptions) {
		this.transport = options.transport;
		this.timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : MCP_DEFAULT_TIMEOUT_MS;
		this.piTransport = piTransportOf(options);
		this.piTransport.onClose(() => {
			if (!this.explicitlyClosed && options.transport === "stdio") this.closedMessage = "MCP 子进程已退出";
		});
		this.client = new PiMcpClient({ name: "biz-agent", version: "0.1.0", requestTimeoutMs: this.timeoutMs });
	}

	async initialize(): Promise<McpInitializeResult> {
		try {
			const result = await this.client.connect(this.piTransport);
			const { name, version } = result.serverInfo;
			return {
				protocolVersion: result.protocolVersion,
				capabilities: { ...result.capabilities },
				serverInfo: version ? { name, version } : { name },
			};
		} catch (error) {
			throw new McpClientError(this.messageOf(error, "initialize"), { cause: error });
		}
	}

	async listTools(): Promise<McpToolDescriptor[]> {
		try {
			return (await this.client.listTools({ timeoutMs: this.timeoutMs })).map(normalizeTool);
		} catch (error) {
			throw new McpClientError(this.messageOf(error, "tools/list"), { cause: error });
		}
	}

	async callTool(name: string, args: Record<string, unknown>): Promise<McpCallToolResult> {
		try {
			return normalizeResult(await this.client.callTool(name, args, { timeoutMs: this.timeoutMs }));
		} catch (error) {
			throw new McpClientError(this.messageOf(error, "tools/call"), { cause: error });
		}
	}

	private messageOf(error: unknown, method: string): string {
		let message = errorMessage(error, method).replace("MCP 连接已关闭", this.closedMessage);
		if (this.transport === "sse") message = message.replace("连接 MCP HTTP失败", "连接 MCP SSE 服务失败");
		return message;
	}

	async close(): Promise<void> {
		this.explicitlyClosed = true;
		this.closedMessage = "MCP 连接已关闭";
		await this.client.close();
	}
}

export function mcpResultText(result: McpCallToolResult): string {
	const parts: string[] = [];
	for (const block of result.content) {
		if (block.type === "text" && block.text) parts.push(block.text);
		else if (block.type === "image") parts.push("[图片结果]");
		else if (block.type === "resource") {
			const resource = block.resource;
			const uri = resource && typeof resource === "object" && "uri" in resource && typeof resource.uri === "string" ? resource.uri : "";
			parts.push(uri ? `[资源：${uri}]` : "[资源结果]");
		} else if (block.type !== "text") parts.push(`[${block.type} 结果]`);
	}
	if (parts.length === 0 && result.raw.structuredContent !== undefined) return JSON.stringify(result.raw.structuredContent, null, 2);
	return parts.join("\n");
}

export function createMcpClient(options: McpClientOptions): McpClient {
	if (options.transport !== "stdio" && options.transport !== "http" && options.transport !== "sse") {
		throw new McpClientError(`不支持的 MCP 传输类型：${String(options.transport)}`);
	}
	return new PiBackedMcpClient(options);
}
