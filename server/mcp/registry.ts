/**
 * MCP 注册表（P7）：DB 记录 → 客户端 → `tools/list` → 平台 `ToolDef`。
 *
 * 设计要点：
 *   - 工具名**只在这里**由 `mcpToolName()` 生成，库里只存 server 那边的原始名；
 *   - 发现失败（服务没起来 / 命令写错 / 地址不可达）**不抛到启动流程**：落库
 *     `last_status="error"` + 中文原因，工具沿用上次成功的结果；
 *   - 平台工具目录（`/api/tools`、自动编排会话、技能 via 校验）通过 `toolDefs()`
 *     取快照——所以 `/api/tools`、会话工具集、技能编辑器看到的是同一份 MCP 工具；
 *   - 工具默认 `risk: "high"`：平台的 RiskLevel 只有 low/medium/high，没有 `"write"`，
 *     而高风险才会触发 `beforeToolCall` 的人工审批（见 `src/core/permission.ts`），
 *     所以 MCP 工具（默认按写操作看待）用 high 走审批。
 */

import { randomUUID } from "node:crypto";
import type {
	McpServerRecord,
	McpToolRecord,
	McpTransport,
	Storage,
} from "../db/types.js";
import type { ToolDef } from "../../src/core/types.js";
import { createMcpClient, mcpResultText } from "./client.js";
import type { McpCallToolResult, McpClient, McpClientOptions, McpToolDescriptor } from "./client.js";
import { mcpToolName } from "./names.js";

/** 新建/修改服务时路由层校验后的配置（id/时间戳由这里生成）。 */
export interface McpServerDraft {
	name: string;
	transport: McpTransport;
	command: string | null;
	args: string[];
	url: string | null;
	headers: Record<string, string>;
	env: Record<string, string>;
	enabled: boolean;
}

/** PATCH 语义：只带传了的字段。 */
export type McpServerChanges = Partial<McpServerDraft>;

/** 工具出参：带平台侧最终工具名（`mcp_<server>_<tool>`），前端/测试直接看这个。 */
export interface McpToolView extends McpToolRecord {
	serverName: string;
	toolName: string;
}

/** 服务出参：配置 + 发现到的工具 + 最近一次发现状态。 */
export interface McpServerView extends McpServerRecord {
	tools: McpToolView[];
	toolCount: number;
}

/** 注册表业务错误：带 HTTP 状态码，路由层直接映射。 */
export class McpRegistryError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
		this.name = "McpRegistryError";
	}
}

export interface McpRegistryOptions {
	/** 单次 JSON-RPC 超时，默认 30 秒（测试会调小） */
	timeoutMs?: number;
	/** 诊断日志出口（默认 console.log；测试里可以静音） */
	onLog?: (message: string) => void;
}

interface McpToolBinding {
	server: McpServerRecord;
	tool: McpToolRecord;
	toolName: string;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function sameJson(a: unknown, b: unknown): boolean {
	return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export class McpRegistry {
	private readonly clients = new Map<string, McpClient>();
	/** 同一服务的并发「首次连接」合并成一个，避免重复 spawn/重复握手。 */
	private readonly connecting = new Map<string, Promise<McpClient>>();
	/** 当前给平台工具目录用的快照（只含 enabled 服务 + enabled 工具）。 */
	private snapshot: McpToolBinding[] = [];
	private readonly timeoutMs: number | undefined;
	private readonly onLog: (message: string) => void;

	constructor(
		private readonly db: Storage,
		options: McpRegistryOptions = {},
	) {
		this.timeoutMs = options.timeoutMs;
		this.onLog = options.onLog ?? ((message) => console.log(message));
		// 先用库里上次成功发现的工具建一份快照：服务启动校验（WorkflowRepo 构造）需要它，
		// 否则引用过 MCP 工具的技能会在每次重启时被误判成"引用了不存在的工具"。
		this.rebuild();
	}

	/* ---------------- 启动 ---------------- */

	/**
	 * 启动时加载 enabled 服务。单个服务失败只记日志与 `last_status`，
	 * 绝不把异常抛给 `server/index.ts`（否则一个写错的命令能把整个进程带走）。
	 */
	async start(): Promise<void> {
		const servers = this.db.listMcpServers().filter((server) => server.enabled);
		for (const server of servers) {
			await this.discover(server);
		}
		this.rebuild();
		if (servers.length > 0) {
			this.onLog(`MCP: 启动加载 ${servers.length} 个服务，可用工具 ${this.snapshot.length} 个`);
		}
	}

	/** 关闭全部连接/子进程（进程退出时调用，避免留下孤儿 node 进程）。 */
	async close(): Promise<void> {
		const clients = [...this.clients.values()];
		this.clients.clear();
		await Promise.all(clients.map(async (client) => {
			try {
				await client.close();
			} catch {
				// 关闭失败不影响进程退出
			}
		}));
	}

	/* ---------------- 查询 ---------------- */

	listServers(): McpServerView[] {
		const servers = this.db.listMcpServers();
		const toolsByServer = new Map<string, McpToolRecord[]>();
		for (const tool of this.db.listMcpTools()) {
			const list = toolsByServer.get(tool.serverId) ?? [];
			list.push(tool);
			toolsByServer.set(tool.serverId, list);
		}
		return servers.map((server) => this.viewOf(server, toolsByServer.get(server.id) ?? []));
	}

	getServerView(id: string): McpServerView | undefined {
		const server = this.db.getMcpServer(id);
		if (!server) {
			return undefined;
		}
		return this.viewOf(server, this.db.listMcpTools(id));
	}

	/** 某个服务的工具列表（含已禁用的，方便前端切换）。服务不存在返回 undefined。 */
	listTools(serverId: string): McpToolView[] | undefined {
		const server = this.db.getMcpServer(serverId);
		if (!server) {
			return undefined;
		}
		return this.db.listMcpTools(serverId).map((tool) => this.toolViewOf(server, tool));
	}

	/** 平台工具目录用的快照（`ToolDef[]`）。没有 MCP 服务时恒为空数组。 */
	toolDefs(): ToolDef[] {
		return this.snapshot.map((binding) => this.toToolDef(binding));
	}

	/** 会话层用它把 MCP 工具并入初始工具集（命名规则仍只由 mcpToolName 决定）。 */
	toolNames(): string[] {
		return this.snapshot.map((binding) => binding.toolName);
	}

	/* ---------------- 变更 ---------------- */

	/** 新建服务：先落库（失败也要留下记录），再立即 initialize + tools/list。 */
	async create(draft: McpServerDraft): Promise<McpServerView> {
		const now = Date.now();
		const record = this.db.createMcpServer({
			id: this.nextServerId(),
			name: draft.name,
			transport: draft.transport,
			command: draft.command,
			args: draft.args,
			url: draft.url,
			headers: draft.headers,
			env: draft.env,
			enabled: draft.enabled,
			lastStatus: "unknown",
			lastError: null,
			lastCheckedAt: null,
			createdAt: now,
			updatedAt: now,
		});
		if (record.enabled) {
			await this.discover(record);
		} else {
			this.rebuild();
		}
		return this.getServerView(record.id)!;
	}

	/**
	 * 修改配置。连接相关字段变了（名字/传输/命令/地址/头/环境）就重新发现；
	 * 只是停用则断开连接、把工具从快照里拿掉（DB 记录保留，重新启用还能用）。
	 */
	async update(id: string, changes: McpServerChanges): Promise<McpServerView | undefined> {
		const current = this.db.getMcpServer(id);
		if (!current) {
			return undefined;
		}
		const now = Date.now();
		const updated = this.db.updateMcpServer(id, {
			...(changes.name !== undefined ? { name: changes.name } : {}),
			...(changes.transport !== undefined ? { transport: changes.transport } : {}),
			...(changes.command !== undefined ? { command: changes.command } : {}),
			...(changes.args !== undefined ? { args: changes.args } : {}),
			...(changes.url !== undefined ? { url: changes.url } : {}),
			...(changes.headers !== undefined ? { headers: changes.headers } : {}),
			...(changes.env !== undefined ? { env: changes.env } : {}),
			...(changes.enabled !== undefined ? { enabled: changes.enabled } : {}),
			updatedAt: now,
		});
		if (!updated) {
			return undefined;
		}
		const connectionChanged =
			(changes.name !== undefined && changes.name !== current.name) ||
			(changes.transport !== undefined && changes.transport !== current.transport) ||
			(changes.command !== undefined && changes.command !== current.command) ||
			(changes.args !== undefined && !sameJson(changes.args, current.args)) ||
			(changes.url !== undefined && changes.url !== current.url) ||
			(changes.headers !== undefined && !sameJson(changes.headers, current.headers)) ||
			(changes.env !== undefined && !sameJson(changes.env, current.env));

		if (!updated.enabled) {
			await this.closeClient(id);
			this.rebuild();
		} else if (connectionChanged || !this.clients.has(id)) {
			await this.discover(updated);
		} else {
			this.rebuild();
		}
		return this.getServerView(id);
	}

	/** 重新发现（幂等：工具按原始名对齐，enabled 状态保留）。 */
	async refresh(id: string): Promise<McpServerView | undefined> {
		const record = this.db.getMcpServer(id);
		if (!record) {
			return undefined;
		}
		if (record.enabled) {
			await this.discover(record);
		} else {
			this.rebuild();
		}
		return this.getServerView(id);
	}

	/** 删除服务：关闭连接 + 连带删工具 + 重建快照。 */
	async remove(id: string): Promise<boolean> {
		const record = this.db.getMcpServer(id);
		if (!record) {
			return false;
		}
		await this.closeClient(id);
		const removed = this.db.removeMcpServer(id);
		this.rebuild();
		return removed;
	}

	/** 单个工具启停：只影响快照（模型/技能编辑器立刻看不到），DB 记录保留。 */
	setToolEnabled(toolId: string, enabled: boolean): McpToolView | undefined {
		const tool = this.db.getMcpTool(toolId);
		if (!tool) {
			return undefined;
		}
		const updated = this.db.updateMcpTool(toolId, { enabled });
		this.rebuild();
		const server = this.db.getMcpServer(tool.serverId);
		return updated && server ? this.toolViewOf(server, updated) : undefined;
	}

	/* ---------------- 调用 ---------------- */

	/**
	 * 直接调用某个服务的工具（`POST /api/mcp/servers/:id/call`）。
	 * `tool` 既接受原始名（`echo`）也接受平台全名（`mcp_server_echo`），前端两种写法都常见。
	 */
	async callTool(serverId: string, toolName: string, args: Record<string, unknown>): Promise<{
		server: McpServerRecord;
		tool: McpToolRecord;
		toolName: string;
		result: McpCallToolResult;
		text: string;
	}> {
		const server = this.db.getMcpServer(serverId);
		if (!server) {
			throw new McpRegistryError(`MCP 服务不存在: ${serverId}`, 404);
		}
		if (!server.enabled) {
			throw new McpRegistryError(`MCP 服务「${server.name}」已停用，请先启用再调用`, 409);
		}
		const tools = this.db.listMcpTools(serverId);
		const wanted = toolName.trim();
		const tool =
			tools.find((item) => item.name === wanted) ??
			tools.find((item) => mcpToolName(server.name, item.name) === wanted);
		if (!tool) {
			throw new McpRegistryError(`MCP 服务「${server.name}」没有名为「${wanted}」的工具`, 404);
		}
		const client = await this.ensureClient(server);
		try {
			const result = await client.callTool(tool.name, args);
			return {
				server,
				tool,
				toolName: mcpToolName(server.name, tool.name),
				result,
				text: mcpResultText(result),
			};
		} catch (error) {
			this.recordFailure(server, error);
			throw new McpRegistryError(
				`调用 MCP 工具「${tool.name}」失败：${errorMessage(error)}`,
				502,
			);
		}
	}

	/* ---------------- 内部：发现与快照 ---------------- */

	/** 连接 + 握手 + 拉工具列表；任何失败都落库成 error，不向上抛。 */
	private async discover(record: McpServerRecord): Promise<void> {
		await this.closeClient(record.id);
		let client: McpClient | null = null;
		try {
			client = createMcpClient(this.clientOptions(record));
			await client.initialize();
			const tools = await client.listTools();
			this.clients.set(record.id, client);
			this.syncTools(record.id, tools);
			this.db.updateMcpServer(record.id, {
				lastStatus: "ok",
				lastError: null,
				lastCheckedAt: Date.now(),
				updatedAt: Date.now(),
			});
			this.rebuild();
			this.onLog(`MCP: 服务「${record.name}」已连接，发现 ${tools.length} 个工具`);
		} catch (error) {
			if (this.clients.get(record.id) === client) {
				this.clients.delete(record.id);
			}
			if (client) {
				try {
					await client.close();
				} catch {
					// 已经断开
				}
			}
			this.recordFailure(record, error);
		}
	}

	/** 工具按「原始名」对齐：同名保留 id 与 enabled，新增/删除做增量。 */
	private syncTools(serverId: string, descriptors: McpToolDescriptor[]): void {
		const existing = new Map(this.db.listMcpTools(serverId).map((tool) => [tool.name, tool]));
		const seen = new Set<string>();
		const now = Date.now();
		for (const descriptor of descriptors) {
			if (seen.has(descriptor.name)) {
				continue;
			}
			seen.add(descriptor.name);
			const current = existing.get(descriptor.name);
			if (current) {
				if (current.description !== descriptor.description || !sameJson(current.inputSchema, descriptor.inputSchema)) {
					this.db.updateMcpTool(current.id, {
						description: descriptor.description,
						inputSchema: descriptor.inputSchema,
					});
				}
				continue;
			}
			this.db.createMcpTool({
				id: `mtool-${randomUUID().slice(0, 8)}`,
				serverId,
				name: descriptor.name,
				description: descriptor.description,
				inputSchema: descriptor.inputSchema,
				enabled: true,
				createdAt: now,
			});
		}
		for (const tool of existing.values()) {
			if (!seen.has(tool.name)) {
				this.db.removeMcpTool(tool.id);
			}
		}
	}

	/** 重建「给模型看的工具」快照：只收 enabled 服务 + enabled 工具，名字冲突加数字后缀。 */
	private rebuild(): void {
		const servers = new Map(
			this.db.listMcpServers()
				.filter((server) => server.enabled)
				.map((server) => [server.id, server] as const),
		);
		const used = new Set<string>();
		const bindings: McpToolBinding[] = [];
		for (const tool of this.db.listMcpTools()) {
			if (!tool.enabled) {
				continue;
			}
			const server = servers.get(tool.serverId);
			if (!server) {
				continue;
			}
			const base = mcpToolName(server.name, tool.name);
			let name = base;
			let suffix = 2;
			while (used.has(name)) {
				name = `${base}_${suffix}`;
				suffix += 1;
			}
			used.add(name);
			bindings.push({ server, tool, toolName: name });
		}
		this.snapshot = bindings;
	}

	private toToolDef(binding: McpToolBinding): ToolDef {
		const { server, tool, toolName } = binding;
		return {
			name: toolName,
			description:
				tool.description.trim().length > 0
					? tool.description
					: `MCP 服务「${server.name}」提供的工具：${tool.name}（没有描述）`,
			category: "MCP",
			// 平台 RiskLevel 没有 "write"：MCP 工具按写操作看待，用 high 触发人工审批
			risk: "high",
			// 参数 schema 原样透传；缺省时 client 已归一成 { type:"object", properties:{} }
			parameters: tool.inputSchema,
			execute: async (args: Record<string, unknown>) => {
				try {
					const result = await this.callBinding(binding, args);
					return { content: mcpResultText(result), ...(result.isError ? { isError: true } : {}) };
				} catch (error) {
					return {
						content: `MCP 工具「${toolName}」调用失败：${errorMessage(error)}`,
						isError: true,
					};
				}
			},
		};
	}

	private async callBinding(binding: McpToolBinding, args: Record<string, unknown>): Promise<McpCallToolResult> {
		const client = await this.ensureClient(binding.server);
		return client.callTool(binding.tool.name, args);
	}

	/** 拿一个可用连接；没有就现连（服务可能刚启动失败/被重启过）。失败按 502 上抛。 */
	private async ensureClient(server: McpServerRecord): Promise<McpClient> {
		const existing = this.clients.get(server.id);
		if (existing) {
			return existing;
		}
		// 并发请求（SSE/HTTP 都可能同时进来）只允许一次握手
		const pending = this.connecting.get(server.id);
		if (pending) {
			return pending;
		}
		const connecting = this.connectOnce(server).finally(() => {
			this.connecting.delete(server.id);
		});
		this.connecting.set(server.id, connecting);
		return connecting;
	}

	private async connectOnce(server: McpServerRecord): Promise<McpClient> {
		let client: McpClient | null = null;
		try {
			client = createMcpClient(this.clientOptions(server));
			await client.initialize();
			await client.listTools();
			this.clients.set(server.id, client);
			return client;
		} catch (error) {
			if (client) {
				try {
					await client.close();
				} catch {
					// 忽略
				}
			}
			this.recordFailure(server, error);
			throw new McpRegistryError(
				`连接 MCP 服务「${server.name}」失败：${errorMessage(error)}`,
				502,
			);
		}
	}

	private clientOptions(server: McpServerRecord): McpClientOptions {
		return {
			transport: server.transport,
			command: server.command,
			args: server.args,
			env: server.env,
			url: server.url,
			headers: server.headers,
			...(this.timeoutMs !== undefined ? { timeoutMs: this.timeoutMs } : {}),
		};
	}

	private async closeClient(serverId: string): Promise<void> {
		const client = this.clients.get(serverId);
		if (!client) {
			return;
		}
		this.clients.delete(serverId);
		try {
			await client.close();
		} catch {
			// 已经断开
		}
	}

	private recordFailure(server: McpServerRecord, error: unknown): void {
		const message = `连接 MCP 服务「${server.name}」失败：${errorMessage(error)}`;
		this.db.updateMcpServer(server.id, {
			lastStatus: "error",
			lastError: message,
			lastCheckedAt: Date.now(),
			updatedAt: Date.now(),
		});
		this.rebuild();
		this.onLog(`MCP: ${message}`);
	}

	private viewOf(server: McpServerRecord, tools: McpToolRecord[]): McpServerView {
		const views = tools.map((tool) => this.toolViewOf(server, tool));
		return { ...server, tools: views, toolCount: views.length };
	}

	private toolViewOf(server: McpServerRecord, tool: McpToolRecord): McpToolView {
		return {
			...tool,
			serverName: server.name,
			toolName: mcpToolName(server.name, tool.name),
		};
	}

	private nextServerId(): string {
		for (;;) {
			const id = `mcp-${randomUUID().slice(0, 8)}`;
			if (!this.db.getMcpServer(id)) {
				return id;
			}
		}
	}
}
