/**
 * MCP 协议客户端（P7）：手写 JSON-RPC 2.0，零第三方依赖。
 *
 * 三种传输统一成同一个接口（initialize / listTools / callTool / close）：
 *   - stdio：spawn 子进程，stdin/stdout 按**换行分隔的 JSON**分帧（MCP 的 stdio 传输规范）；
 *   - http ：POST JSON-RPC，响应可以是 JSON 或 `text/event-stream`；支持 `Mcp-Session-Id` 回传；
 *   - sse  ：GET 建流 → 等 `endpoint` 事件拿回传 URL → POST 到该 URL，响应从流里按 id 配对。
 *
 * 请求/响应按 id 配对，默认 30 秒超时；进程退出 / 流断开 / close() 都会把挂起的请求
 * 用**中文原因**拒绝掉，上层（registry / 路由）不需要知道底层是哪一种传输。
 *
 * Windows 注意：stdio 用 `spawn(command, args)` 且不开 shell，参数原样交给 CreateProcess，
 * 路径里有空格/中文都不需要自己加引号；反过来，一旦开 shell 就得自己转义，容易出安全与引号问题。
 */

import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { McpTransport } from "../db/types.js";

/** 客户端声明支持的 MCP 版本；服务端回什么版本以服务端为准（协商结果放进 initialize 结果里）。 */
export const MCP_PROTOCOL_VERSION = "2024-11-05";
/** 单次请求的默认超时。MCP server 卡死时不能把会话/HTTP 请求一起拖死。 */
export const MCP_DEFAULT_TIMEOUT_MS = 30_000;
const MAX_STDIO_BUFFER = 8 * 1024 * 1024;
const STDERR_TAIL_LINES = 20;

/** MCP 的工具描述（`tools/list` 的一项）。 */
export interface McpToolDescriptor {
	name: string;
	description: string;
	/** MCP 的 inputSchema，原样透传给模型。 */
	inputSchema: Record<string, unknown>;
}

export interface McpInitializeResult {
	protocolVersion: string;
	capabilities: Record<string, unknown>;
	serverInfo: { name: string; version?: string };
}

/** MCP `tools/call` 返回的内容块（text / image / resource ...）。 */
export interface McpContentBlock {
	type: string;
	text?: string;
	[key: string]: unknown;
}

export interface McpCallToolResult {
	content: McpContentBlock[];
	/** 工具自身报告失败（不是协议错误）：模型与前端都会看到 isError。 */
	isError: boolean;
	/** 原始 result，排查用。 */
	raw: Record<string, unknown>;
}

export interface McpClientOptions {
	transport: McpTransport;
	/** stdio：启动命令（通常是 node / npx / 可执行文件绝对路径） */
	command?: string | null;
	args?: string[];
	/** stdio：显式覆盖的环境变量（其余继承服务进程） */
	env?: Record<string, string>;
	/** http / sse：服务地址 */
	url?: string | null;
	/** http / sse：请求头（鉴权、租户等） */
	headers?: Record<string, string>;
	/** 单次请求超时，默认 30 秒；测试会调小它来验超时。 */
	timeoutMs?: number;
	/** stdio 子进程的 stderr 行（诊断用；默认不打印，避免污染控制台）。 */
	onStderr?: (line: string) => void;
}

export interface McpClient {
	readonly transport: McpTransport;
	initialize(): Promise<McpInitializeResult>;
	listTools(): Promise<McpToolDescriptor[]>;
	callTool(name: string, args: Record<string, unknown>): Promise<McpCallToolResult>;
	close(): Promise<void>;
}

/** MCP 客户端错误：所有文案都是中文，直接可以进 API 响应/界面。 */
export class McpClientError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "McpClientError";
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function emptyInputSchema(): Record<string, unknown> {
	return { type: "object", properties: {} };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 把服务端返回的 initialize 结果归一成固定形状（缺字段给安全的默认值）。 */
function normalizeInitialize(raw: unknown): McpInitializeResult {
	if (!isPlainObject(raw)) {
		throw new McpClientError("MCP initialize 返回格式不对：不是 JSON 对象");
	}
	const capabilities = isPlainObject(raw.capabilities) ? raw.capabilities : {};
	const info = isPlainObject(raw.serverInfo) ? raw.serverInfo : {};
	const name = typeof info.name === "string" && info.name.trim() ? info.name : "未知 MCP 服务";
	const version = typeof info.version === "string" ? info.version : undefined;
	return {
		protocolVersion:
			typeof raw.protocolVersion === "string" && raw.protocolVersion.trim()
				? raw.protocolVersion
				: MCP_PROTOCOL_VERSION,
		capabilities,
		serverInfo: version ? { name, version } : { name },
	};
}

/** 把 `tools/list` 的原始项归一；名字不合法的项直接丢掉（模型没法调一个空名字）。 */
function normalizeTools(raw: unknown): McpToolDescriptor[] {
	if (!isPlainObject(raw) || !Array.isArray(raw.tools)) {
		throw new McpClientError("MCP tools/list 返回格式不对：缺少 tools 数组");
	}
	const tools: McpToolDescriptor[] = [];
	for (const item of raw.tools) {
		if (!isPlainObject(item)) {
			continue;
		}
		const name = typeof item.name === "string" ? item.name.trim() : "";
		if (!name) {
			continue;
		}
		tools.push({
			name,
			description: typeof item.description === "string" ? item.description : "",
			inputSchema: isPlainObject(item.inputSchema) ? item.inputSchema : emptyInputSchema(),
		});
	}
	return tools;
}

/** 把 `tools/call` 的原始结果归一；服务端偶尔直接给字符串 content，这里兜一下。 */
function normalizeCallResult(raw: unknown): McpCallToolResult {
	if (!isPlainObject(raw)) {
		throw new McpClientError("MCP tools/call 返回格式不对：不是 JSON 对象");
	}
	let content: McpContentBlock[] = [];
	if (Array.isArray(raw.content)) {
		content = raw.content.filter(isPlainObject).map((block) => {
			const type = typeof block.type === "string" ? block.type : "text";
			return { ...block, type } as McpContentBlock;
		});
	} else if (typeof raw.content === "string") {
		content = [{ type: "text", text: raw.content }];
	}
	return { content, isError: raw.isError === true, raw };
}

/** 工具结果 → 模型能读的文本：文本块直接拼，图片/资源给中文占位，别把 base64 灌进上下文。 */
export function mcpResultText(result: McpCallToolResult): string {
	const parts: string[] = [];
	for (const block of result.content) {
		if (block.type === "text") {
			if (block.text) {
				parts.push(block.text);
			}
			continue;
		}
		if (block.type === "image") {
			parts.push("[图片结果]");
			continue;
		}
		if (block.type === "resource") {
			const resource = block.resource;
			const uri = isPlainObject(resource) && typeof resource.uri === "string" ? resource.uri : "";
			parts.push(uri ? `[资源：${uri}]` : "[资源结果]");
			continue;
		}
		parts.push(`[${block.type} 结果]`);
	}
	if (parts.length > 0) {
		return parts.join("\n");
	}
	return result.isError ? "MCP 工具调用失败（服务端没有返回错误说明）" : "（MCP 工具没有返回文本内容）";
}

/* ---------------- JSON-RPC 公共层 ---------------- */

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
	method: string;
}

interface SseEvent {
	event: string;
	data: string;
}

/** 一行 SSE 事件块 → { event, data }（data 多行按规范用换行拼接）。 */
function parseSseEvent(block: string): SseEvent {
	let event = "message";
	const data: string[] = [];
	for (const rawLine of block.split(/\r?\n/)) {
		if (rawLine.length === 0 || rawLine.startsWith(":")) {
			continue;
		}
		const colon = rawLine.indexOf(":");
		const field = colon < 0 ? rawLine : rawLine.slice(0, colon);
		let value = colon < 0 ? "" : rawLine.slice(colon + 1);
		if (value.startsWith(" ")) {
			value = value.slice(1);
		}
		if (field === "event") {
			event = value;
		} else if (field === "data") {
			data.push(value);
		}
	}
	return { event, data: data.join("\n") };
}

/** 从一段完整的 SSE 文本里取出所有事件（HTTP 分支一次性响应时用）。 */
function parseSseText(text: string): SseEvent[] {
	const events: SseEvent[] = [];
	const normalized = text.replace(/\r\n/g, "\n");
	for (const block of normalized.split("\n\n")) {
		if (block.trim().length === 0) {
			continue;
		}
		events.push(parseSseEvent(block));
	}
	return events;
}

/**
 * JSON-RPC 公共实现：id 配对、30 秒超时、关闭清理。
 * 子类只负责「怎么把一条消息发出去」与「怎么释放自己的资源」。
 */
abstract class JsonRpcClient implements McpClient {
	abstract readonly transport: McpTransport;
	protected readonly timeoutMs: number;
	private readonly pending = new Map<number, PendingRequest>();
	private nextId = 1;
	private closed = false;
	private closeReason = "MCP 连接已关闭";
	private shutdownStarted = false;

	constructor(options: McpClientOptions) {
		this.timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : MCP_DEFAULT_TIMEOUT_MS;
	}

	async initialize(): Promise<McpInitializeResult> {
		const result = await this.request("initialize", {
			protocolVersion: MCP_PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: { name: "biz-agent", version: "0.1.0" },
		});
		await this.notify("notifications/initialized");
		return normalizeInitialize(result);
	}

	async listTools(): Promise<McpToolDescriptor[]> {
		return normalizeTools(await this.request("tools/list", {}));
	}

	async callTool(name: string, args: Record<string, unknown>): Promise<McpCallToolResult> {
		if (!name || typeof name !== "string") {
			throw new McpClientError("MCP 工具名不能为空");
		}
		return normalizeCallResult(await this.request("tools/call", { name, arguments: args ?? {} }));
	}

	async close(): Promise<void> {
		this.markClosed("MCP 连接已关闭");
		if (this.shutdownStarted) {
			return;
		}
		this.shutdownStarted = true;
		try {
			await this.shutdown();
		} catch {
			// 关闭失败不能影响调用方（进程可能已经自己退了）
		}
	}

	/** 发出消息；错误在 request() 里统一转成中文。 */
	protected abstract send(message: Record<string, unknown>): void | Promise<void>;

	/** 释放连接/子进程。 */
	protected abstract shutdown(): Promise<void> | void;

	/**
	 * 发一个 JSON-RPC 请求并等响应。
	 *
	 * 注意：send() 不阻塞在本函数里（`void` 掉），否则 HTTP/SSE 的发送失败会绕过超时计时器。
	 */
	protected request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
		if (this.closed) {
			return Promise.reject(new McpClientError(this.closeReason));
		}
		const id = this.nextId++;
		const promise = new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				const seconds = Math.round(this.timeoutMs / 1000);
				reject(new McpClientError(`MCP 请求超时（${seconds} 秒）：${method}`));
			}, this.timeoutMs);
			this.pending.set(id, {
				resolve: resolve as (value: unknown) => void,
				reject,
				timer,
				method,
			});
		});
		void Promise.resolve()
			.then(() => this.send({ jsonrpc: "2.0", id, method, params }))
			.catch((error: unknown) => {
				const pending = this.pending.get(id);
				if (!pending) {
					return;
				}
				clearTimeout(pending.timer);
				this.pending.delete(id);
				pending.reject(
					error instanceof McpClientError
						? error
						: new McpClientError(`MCP 请求发送失败（${method}）：${errorMessage(error)}`, { cause: error }),
				);
			});
		return promise;
	}

	/** 发通知（没有 id，不等响应）。 */
	protected async notify(method: string, params?: Record<string, unknown>): Promise<void> {
		if (this.closed) {
			throw new McpClientError(this.closeReason);
		}
		await this.send(params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params });
	}

	/** 收到一行/一段 JSON：按 id 配对已挂起的请求。 */
	protected dispatch(raw: string): void {
		let message: unknown;
		try {
			message = JSON.parse(raw) as unknown;
		} catch {
			// MCP server 偶尔往 stdout 打日志；不是 JSON 的行忽略即可
			return;
		}
		if (!isPlainObject(message)) {
			return;
		}
		// 服务端主动请求/通知（带 method）：本客户端不需要 sampling/roots，回 -32601 免得对面一直等
		if (typeof message.method === "string") {
			if (message.id !== undefined && message.id !== null) {
				void Promise.resolve()
					.then(() =>
						this.send({
							jsonrpc: "2.0",
							id: message.id,
							error: { code: -32601, message: "客户端不支持服务端主动请求" },
						}),
					)
					.catch(() => {
						// 连接已断时忽略
					});
			}
			return;
		}
		const id = typeof message.id === "number" ? message.id : Number(message.id);
		const pending = Number.isFinite(id) ? this.pending.get(id) : undefined;
		if (!pending) {
			// 超时之后服务端才回包：丢弃即可，不能影响后续请求
			return;
		}
		clearTimeout(pending.timer);
		this.pending.delete(id);
		if (message.error !== undefined && message.error !== null) {
			const error = isPlainObject(message.error) ? message.error : {};
			const detail =
				typeof error.message === "string" && error.message.trim() ? error.message : JSON.stringify(message.error);
			const code = typeof error.code === "number" ? `（code ${error.code}）` : "";
			pending.reject(new McpClientError(`MCP 返回错误${code}（${pending.method}）：${detail}`));
			return;
		}
		pending.resolve(message.result ?? {});
	}

	/** 连接断开/进程退出：拒绝全部挂起请求，并把原因留给后续调用。 */
	protected markClosed(reason: string): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		this.closeReason = reason;
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new McpClientError(reason));
		}
		this.pending.clear();
	}

	/** 传输层自己判断是否已关闭（避免把正常 close 当成异常退出）。 */
	protected isClosed(): boolean {
		return this.closed;
	}
}

/* ---------------- stdio ---------------- */

class StdioMcpClient extends JsonRpcClient {
	readonly transport = "stdio" as const;
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly onStderr?: (line: string) => void;
	private buffer = "";
	private readonly stderrTail: string[] = [];

	constructor(options: McpClientOptions) {
		super(options);
		const command = (options.command ?? "").trim();
		if (!command) {
			throw new McpClientError("stdio 传输缺少启动命令（command），请在 MCP 服务配置里填写");
		}
		this.onStderr = options.onStderr;
		let child: ChildProcessWithoutNullStreams;
		try {
			child = spawn(command, options.args ?? [], {
				stdio: ["pipe", "pipe", "pipe"],
				env: { ...process.env, ...(options.env ?? {}) },
				windowsHide: true,
			});
		} catch (error) {
			throw new McpClientError(`MCP 子进程启动失败：${errorMessage(error)}`, { cause: error });
		}
		this.child = child;

		// 统一按 UTF-8 解码：Windows 管道里 Node 写的是 UTF-8，与 PowerShell 控制台代码页无关
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => this.consume(chunk));
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => this.consumeStderr(chunk));
		child.stdin.on("error", (error: Error) => this.markClosed(`MCP 子进程写入失败：${error.message}`));
		child.on("error", (error: Error) => this.markClosed(`MCP 子进程启动失败：${error.message}`));
		child.on("exit", (code, signal) => {
			if (this.isClosed()) {
				return;
			}
			const status = signal ? `signal=${signal}` : `code=${code ?? "null"}`;
			const tail = this.stderrTail.length > 0 ? `；stderr：${this.stderrTail.slice(-3).join(" | ")}` : "";
			this.markClosed(`MCP 子进程已退出（${status}）${tail}`);
		});
	}

	protected send(message: Record<string, unknown>): void {
		if (this.isClosed()) {
			throw new McpClientError("MCP 连接已关闭，无法发送请求");
		}
		if (this.child.exitCode !== null) {
			throw new McpClientError(`MCP 子进程已退出（code=${this.child.exitCode}），无法发送请求`);
		}
		const line = `${JSON.stringify(message)}\n`;
		this.child.stdin.write(line, (error) => {
			if (error) {
				this.markClosed(`MCP 子进程写入失败：${error.message}`);
			}
		});
	}

	protected async shutdown(): Promise<void> {
		const child = this.child;
		try {
			child.stdin.end();
		} catch {
			// 已经关了
		}
		if (child.exitCode !== null) {
			return;
		}
		try {
			child.kill();
		} catch {
			// 已经退了
		}
		await new Promise<void>((resolve) => {
			if (child.exitCode !== null) {
				resolve();
				return;
			}
			const timer = setTimeout(() => {
				child.removeListener("exit", onExit);
				resolve();
			}, 500);
			const onExit = (): void => {
				clearTimeout(timer);
				resolve();
			};
			child.once("exit", onExit);
		});
		if (child.exitCode === null) {
			try {
				child.kill("SIGKILL");
			} catch {
				// Windows 上 SIGKILL 等价于 TerminateProcess；失败也没别的办法了
			}
		}
	}

	/** 按换行切帧；MCP 规范要求 stdout 上每行一个 JSON，不能有裸换行。 */
	private consume(chunk: string): void {
		this.buffer += chunk;
		for (;;) {
			const index = this.buffer.indexOf("\n");
			if (index < 0) {
				break;
			}
			const line = this.buffer.slice(0, index).replace(/\r$/, "");
			this.buffer = this.buffer.slice(index + 1);
			if (line.trim().length > 0) {
				this.dispatch(line);
			}
		}
		if (this.buffer.length > MAX_STDIO_BUFFER) {
			this.buffer = "";
			this.markClosed("MCP 子进程输出异常（超过 8 MB 没有换行），连接已断开");
		}
	}

	private consumeStderr(chunk: string): void {
		for (const line of chunk.split(/\r?\n/)) {
			if (line.trim().length === 0) {
				continue;
			}
			this.stderrTail.push(line);
			if (this.stderrTail.length > STDERR_TAIL_LINES) {
				this.stderrTail.shift();
			}
			this.onStderr?.(line);
		}
	}
}

/* ---------------- HTTP（Streamable HTTP） ---------------- */

class HttpMcpClient extends JsonRpcClient {
	readonly transport = "http" as const;
	private readonly url: string;
	private readonly headers: Record<string, string>;
	private sessionId: string | null = null;

	constructor(options: McpClientOptions) {
		super(options);
		const url = (options.url ?? "").trim();
		if (!url) {
			throw new McpClientError("http 传输缺少服务地址（url），请在 MCP 服务配置里填写");
		}
		this.url = url;
		this.headers = options.headers ?? {};
	}

	protected async send(message: Record<string, unknown>): Promise<void> {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			// 新版 MCP 允许服务端用 SSE 回一条请求的响应
			Accept: "application/json, text/event-stream",
			...this.headers,
		};
		if (this.sessionId) {
			headers["Mcp-Session-Id"] = this.sessionId;
		}
		let response: Response;
		try {
			response = await fetch(this.url, {
				method: "POST",
				headers,
				body: JSON.stringify(message),
				signal: AbortSignal.timeout(this.timeoutMs),
			});
		} catch (error) {
			if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
				throw new McpClientError(
					`MCP HTTP 请求超时（${Math.round(this.timeoutMs / 1000)} 秒）：${String(message.method ?? "")}`,
					{ cause: error },
				);
			}
			throw new McpClientError(`连接 MCP HTTP 服务失败（${this.url}）：${errorMessage(error)}`, { cause: error });
		}
		// 新版 Streamable HTTP 的会话 id：服务端在响应头里给，后续请求要原样带回
		const session = response.headers.get("mcp-session-id");
		if (session) {
			this.sessionId = session;
		}
		if (!response.ok) {
			const detail = await readTextSafely(response);
			throw new McpClientError(
				`MCP HTTP 服务返回 ${response.status}${detail ? `：${truncate(detail)}` : ""}`,
			);
		}
		// 通知没有 id，服务端通常回 202 空体，不需要读响应
		if (!("id" in message)) {
			await discardBody(response);
			return;
		}
		const contentType = response.headers.get("content-type") ?? "";
		const text = await response.text();
		if (contentType.includes("text/event-stream")) {
			const events = parseSseText(text);
			const payloads = events
				.filter((event) => event.event === "message" || event.event === "" || event.event === "endpoint")
				.map((event) => event.data)
				.filter((data) => data.trim().length > 0);
			if (payloads.length === 0) {
				throw new McpClientError("MCP HTTP 服务返回了空的 SSE 响应");
			}
			for (const payload of payloads) {
				this.dispatch(payload);
			}
			return;
		}
		if (text.trim().length === 0) {
			throw new McpClientError("MCP HTTP 服务返回了空响应体");
		}
		this.dispatch(text);
	}

	protected shutdown(): void {
		// HTTP 是短连接，没有需要释放的东西
	}
}

/* ---------------- SSE（旧版 HTTP+SSE） ---------------- */

class SseMcpClient extends JsonRpcClient {
	readonly transport = "sse" as const;
	private readonly url: string;
	private readonly headers: Record<string, string>;
	private endpoint: string | null = null;
	private controller: AbortController | null = null;
	private sessionId: string | null = null;
	/** 等 `endpoint` 事件；连接建立阶段只有一个初始化请求，够用。 */
	private endpointResolve: (() => void) | null = null;
	private endpointReject: ((error: Error) => void) | null = null;
	private connecting: Promise<void> | null = null;
	private streamBuffer = "";

	constructor(options: McpClientOptions) {
		super(options);
		const url = (options.url ?? "").trim();
		if (!url) {
			throw new McpClientError("sse 传输缺少服务地址（url），请在 MCP 服务配置里填写");
		}
		this.url = url;
		this.headers = options.headers ?? {};
	}

	protected async send(message: Record<string, unknown>): Promise<void> {
		await this.ensureConnected();
		const endpoint = this.endpoint;
		if (!endpoint) {
			throw new McpClientError("MCP SSE 连接还没有就绪（未收到 endpoint 事件）");
		}
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			...this.headers,
		};
		if (this.sessionId) {
			headers["Mcp-Session-Id"] = this.sessionId;
		}
		let response: Response;
		try {
			response = await fetch(endpoint, {
				method: "POST",
				headers,
				body: JSON.stringify(message),
				signal: this.controller?.signal,
			});
		} catch (error) {
			throw new McpClientError(`连接 MCP SSE 回传接口失败（${endpoint}）：${errorMessage(error)}`, { cause: error });
		}
		const session = response.headers.get("mcp-session-id");
		if (session) {
			this.sessionId = session;
		}
		if (!response.ok) {
			const detail = await readTextSafely(response);
			throw new McpClientError(`MCP SSE 回传接口返回 ${response.status}${detail ? `：${truncate(detail)}` : ""}`);
		}
		await discardBody(response);
	}

	protected shutdown(): void {
		this.rejectEndpoint(new McpClientError("MCP 连接已关闭"));
		if (this.controller) {
			this.controller.abort();
			this.controller = null;
		}
	}

	private ensureConnected(): Promise<void> {
		if (this.endpoint) {
			return Promise.resolve();
		}
		if (!this.connecting) {
			this.connecting = this.connect();
		}
		return this.connecting;
	}

	/** GET 建流，等第一个 `endpoint` 事件；超时按 30 秒算（与请求超时一致）。 */
	private async connect(): Promise<void> {
		const controller = new AbortController();
		this.controller = controller;
		let response: Response;
		try {
			response = await fetch(this.url, {
				method: "GET",
				headers: { Accept: "text/event-stream", ...this.headers },
				signal: controller.signal,
			});
		} catch (error) {
			this.connecting = null;
			if (controller.signal.aborted) {
				throw new McpClientError("MCP SSE 连接已关闭");
			}
			throw new McpClientError(`连接 MCP SSE 服务失败（${this.url}）：${errorMessage(error)}`, { cause: error });
		}
		if (!response.ok || !response.body) {
			this.connecting = null;
			throw new McpClientError(`MCP SSE 服务返回 ${response.status}（${this.url}）`);
		}
		const ready = new Promise<void>((resolve, reject) => {
			this.endpointResolve = resolve;
			this.endpointReject = reject;
		});
		const timer = setTimeout(() => {
			this.rejectEndpoint(
				new McpClientError(`MCP SSE 连接超时（${Math.round(this.timeoutMs / 1000)} 秒）：没有收到 endpoint 事件`),
			);
		}, this.timeoutMs);
		void this.pump(response.body, controller);
		try {
			await ready;
		} catch (error) {
			this.connecting = null;
			controller.abort();
			throw error;
		} finally {
			clearTimeout(timer);
		}
	}

	/** 持续读 SSE 流：`endpoint` 决定回传地址，`message` 是 JSON-RPC 响应。 */
	private async pump(body: ReadableStream<Uint8Array>, controller: AbortController): Promise<void> {
		const reader = body.getReader();
		const decoder = new TextDecoder();
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) {
					break;
				}
				this.streamBuffer += decoder.decode(value, { stream: true });
				this.drainEvents();
			}
		} catch (error) {
			if (!controller.signal.aborted && !this.isClosed()) {
				this.rejectEndpoint(
					new McpClientError(`MCP SSE 连接中断：${errorMessage(error)}`, { cause: error }),
				);
				this.markClosed(`MCP SSE 连接中断：${errorMessage(error)}`);
			}
			return;
		}
		if (!this.isClosed()) {
			if (!this.endpoint) {
				this.rejectEndpoint(new McpClientError("MCP SSE 连接在收到 endpoint 事件前就关闭了"));
			}
			this.markClosed("MCP SSE 连接已断开");
		}
	}

	private drainEvents(): void {
		for (;;) {
			const match = /\r?\n\r?\n/.exec(this.streamBuffer);
			if (!match || match.index === undefined) {
				break;
			}
			const block = this.streamBuffer.slice(0, match.index);
			this.streamBuffer = this.streamBuffer.slice(match.index + match[0].length);
			if (block.trim().length === 0) {
				continue;
			}
			const event = parseSseEvent(block);
			if (event.event === "endpoint") {
				const raw = event.data.trim();
				if (!raw) {
					continue;
				}
				try {
					this.endpoint = new URL(raw, this.url).toString();
				} catch {
					this.rejectEndpoint(new McpClientError(`MCP SSE 的 endpoint 不是合法地址：${raw}`));
					continue;
				}
				this.endpointResolve?.();
				this.endpointResolve = null;
				this.endpointReject = null;
				continue;
			}
			if (event.event === "message" || event.event === "") {
				if (event.data.trim().length > 0) {
					this.dispatch(event.data);
				}
			}
		}
	}

	private rejectEndpoint(error: Error): void {
		const reject = this.endpointReject;
		this.endpointResolve = null;
		this.endpointReject = null;
		reject?.(error);
	}
}

/** 安全读响应体：错误详情只用于文案，读不出来就算了。 */
async function readTextSafely(response: Response): Promise<string> {
	try {
		return await response.text();
	} catch {
		return "";
	}
}

/** 丢掉不需要读的响应体，避免 keep-alive 连接泄漏。 */
async function discardBody(response: Response): Promise<void> {
	try {
		await response.body?.cancel();
	} catch {
		// 忽略
	}
}

function truncate(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
}

/** 按配置创建客户端（transport 决定具体实现）。 */
export function createMcpClient(options: McpClientOptions): McpClient {
	switch (options.transport) {
		case "stdio":
			return new StdioMcpClient(options);
		case "http":
			return new HttpMcpClient(options);
		case "sse":
			return new SseMcpClient(options);
		default:
			throw new McpClientError(`不支持的 MCP 传输类型：${String(options.transport)}`);
	}
}
