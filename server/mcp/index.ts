/**
 * MCP 模块入口（P7）：把「注册表 + HTTP 路由 + 平台工具目录」接起来。
 *
 * `server/index.ts` 只做两件事：`initMcp({ db })` 挂载、启动后 `void runtime.start()`。
 * 启动加载失败不会抛到这里（registry 内部落 `last_status="error"` 并继续），
 * 所以一个写错的 MCP 命令不会把整个进程带走。
 */

import { builtinToolFactories } from "../../src/workflows/index.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthRuntime } from "../auth/service.js";
import type { Storage } from "../db/index.js";
import { McpRegistry } from "./registry.js";
import { handleMcpRoute } from "./routes.js";

export type { McpClient } from "./client.js";
export type { McpServerView, McpToolView } from "./registry.js";

export interface McpRuntime {
	registry: McpRegistry;
	/** 启动时加载 enabled 服务；单个失败只记状态，不抛 */
	start(): Promise<void>;
	/** 关闭全部子进程/连接（进程退出时调用） */
	close(): Promise<void>;
	/** 返回 true = 请求已被 MCP 管理接口接管 */
	handle(req: IncomingMessage, res: ServerResponse, url: URL, auth: AuthRuntime): Promise<boolean>;
}

/**
 * 每个进程只注册一次工具目录工厂：MCP 工具是运行期从 DB/外部服务发现的，
 * 不能写死进 `src/workflows/index.ts` 的静态清单；而 `WorkflowRepo` 的工具目录
 * 就是那个数组（引用共享），所以 push 一个动态工厂后，`/api/tools`、自动编排会话、
 * 技能 `via` 校验都会立刻看到同一份 MCP 工具——这正是"技能编辑器能挑"的前提。
 */
let catalogFactoryRegistered = false;

export function initMcp(options: { db: Storage; timeoutMs?: number; onLog?: (message: string) => void }): McpRuntime {
	const registry = new McpRegistry(options.db, { timeoutMs: options.timeoutMs, onLog: options.onLog });
	if (!catalogFactoryRegistered) {
		builtinToolFactories.push(() => registry.toolDefs());
		catalogFactoryRegistered = true;
	}
	return {
		registry,
		start: () => registry.start(),
		close: () => registry.close(),
		handle: (req, res, url, auth) => handleMcpRoute(req, res, url, registry, auth),
	};
}
