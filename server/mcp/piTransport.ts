import {
	StdioTransport,
	StreamableHttpTransport,
	type JsonRpcMessage,
	type McpTransport,
	type McpTransportSendOptions,
} from "@earendil-works/pi-mcp";
import type { McpTransportFactory } from "@earendil-works/pi-coding-agent";

const SSE_SOURCE_PREFIX = "biz-agent-sse:";

export function piSseSource(serverId: string): string {
	return `${SSE_SOURCE_PREFIX}${serverId}`;
}

export const createPiMcpTransport: McpTransportFactory = (entry, cwd, authProvider) => {
	if (entry.source.startsWith(SSE_SOURCE_PREFIX)) {
		if (!("url" in entry.config)) throw new Error("MCP SSE 配置缺少 url");
		return new LegacySseTransport(entry.config.url, entry.config.headers ?? {});
	}
	if ("command" in entry.config) {
		return new StdioTransport({ command: entry.config.command, args: entry.config.args, env: entry.config.env, cwd, inheritEnv: true });
	}
	return new StreamableHttpTransport({
		url: entry.config.url,
		headers: entry.config.headers,
		authProvider,
	});
};

class LegacySseTransport implements McpTransport {
	private readonly url: URL;
	private readonly controller = new AbortController();
	private readonly sends = new Set<AbortController>();
	private endpoint: string | null = null;
	private sessionId: string | null = null;
	private startPromise: Promise<void> | null = null;
	private closed = false;
	private readonly headers: Record<string, string>;
	private readonly messageListeners = new Set<(message: JsonRpcMessage) => void>();
	private readonly errorListeners = new Set<(error: Error) => void>();
	private readonly closeListeners = new Set<() => void>();
	private closeEmitted = false;

	constructor(url: string, headers: Record<string, string> = {}) {
		this.url = new URL(url);
		this.headers = headers;
	}

	start(): Promise<void> {
		if (!this.startPromise) this.startPromise = this.open();
		return this.startPromise;
	}

	async send(message: JsonRpcMessage, options?: McpTransportSendOptions): Promise<void> {
		if (options?.signal?.aborted) return;
		await this.start();
		if (this.closed || options?.signal?.aborted) return;
		if (!this.endpoint) throw new Error("MCP SSE 连接未收到 endpoint 事件");
		const controller = new AbortController();
		const abort = () => controller.abort();
		options?.signal?.addEventListener("abort", abort, { once: true });
		this.sends.add(controller);
		try {
			if (this.closed || options?.signal?.aborted) return;
			const response = await fetch(this.endpoint, {
				method: "POST",
				headers: { "Content-Type": "application/json", ...this.headers, ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}) },
				body: JSON.stringify(message),
				signal: controller.signal,
			});
			this.captureSession(response);
			if (!response.ok) throw new Error(`MCP SSE 回传接口返回 ${response.status}`);
			await response.body?.cancel().catch(() => {});
		} finally {
			options?.signal?.removeEventListener("abort", abort);
			this.sends.delete(controller);
		}
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.controller.abort();
		for (const controller of this.sends) controller.abort();
		this.sends.clear();
		this.emitClose();
	}

	onMessage(listener: (message: JsonRpcMessage) => void): () => void {
		this.messageListeners.add(listener);
		return () => this.messageListeners.delete(listener);
	}

	onError(listener: (error: Error) => void): () => void {
		this.errorListeners.add(listener);
		return () => this.errorListeners.delete(listener);
	}

	onClose(listener: () => void): () => void {
		this.closeListeners.add(listener);
		return () => this.closeListeners.delete(listener);
	}

	private async open(): Promise<void> {
		const response = await fetch(this.url, {
			headers: { Accept: "text/event-stream", ...this.headers },
			signal: this.controller.signal,
		});
		this.captureSession(response);
		if (!response.ok || !response.body) throw new Error(`MCP SSE 服务返回 ${response.status}`);
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		let resolveEndpoint!: () => void;
		const endpointReady = new Promise<void>((resolve) => { resolveEndpoint = resolve; });
		const pump = (async () => {
			try {
				for (;;) {
					const { value, done } = await reader.read();
					if (done) break;
					buffer += decoder.decode(value, { stream: true });
					for (;;) {
						const match = /\r?\n\r?\n/.exec(buffer);
						if (!match || match.index === undefined) break;
						const block = buffer.slice(0, match.index);
						buffer = buffer.slice(match.index + match[0].length);
						let event = "message";
						const data: string[] = [];
						for (const line of block.split(/\r?\n/)) {
							const colon = line.indexOf(":");
							const field = colon < 0 ? line : line.slice(0, colon);
							const text = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
							if (field === "event") event = text;
							if (field === "data") data.push(text);
						}
						const payload = data.join("\n");
						if (event === "endpoint" && payload.trim()) {
							this.endpoint = new URL(payload.trim(), this.url).toString();
							resolveEndpoint();
						} else if ((event === "message" || event === "") && payload.trim()) {
						try { this.emitMessage(JSON.parse(payload) as JsonRpcMessage); }
						catch (error) { this.emitError(error); }
						}
					}
				}
			} catch (error) {
				if (!this.closed) this.emitError(error);
			} finally {
				if (!this.closed) this.emitClose();
			}
		})();
		let timer: NodeJS.Timeout | undefined;
		try {
			await Promise.race([
			endpointReady,
			pump.then(() => { throw new Error("MCP SSE stream closed before endpoint event"); }),
			new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("MCP SSE endpoint wait timed out")), 30_000); }),
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
		void pump;
	}

	private captureSession(response: Response): void {
		const session = response.headers.get("mcp-session-id");
		if (session) this.sessionId = session;
	}

	private emitMessage(message: JsonRpcMessage): void {
		for (const listener of this.messageListeners) listener(message);
	}

	private emitError(error: unknown): void {
		const normalized = error instanceof Error ? error : new Error(String(error));
		for (const listener of this.errorListeners) listener(normalized);
	}

	private emitClose(): void {
		if (this.closeEmitted) return;
		this.closeEmitted = true;
		for (const listener of this.closeListeners) listener();
	}
}

export function createPiMcpTransportForTest(entry: Parameters<McpTransportFactory>[0], cwd: string): McpTransport {
	return createPiMcpTransport(entry, cwd, undefined);
}
