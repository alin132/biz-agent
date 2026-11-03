/**
 * 工具注册表：业务能力 → Pi AgentTool 的适配层。
 *
 * 流程定义里只写工具名，注册表负责把名字解析成真正可执行的 AgentTool，
 * 并把 BizContext 绑定进 execute 闭包。缺工具时启动即报错，不留到运行时。
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { BizContext, ToolDef } from "./types.js";

export class ToolRegistry {
	private readonly defs = new Map<string, ToolDef>();

	register(def: ToolDef): this {
		if (this.defs.has(def.name)) {
			throw new Error(`工具重复注册: ${def.name}`);
		}
		this.defs.set(def.name, def);
		return this;
	}

	registerAll(defs: ToolDef[]): this {
		for (const def of defs) {
			this.register(def);
		}
		return this;
	}

	get(name: string): ToolDef | undefined {
		return this.defs.get(name);
	}

	has(name: string): boolean {
		return this.defs.has(name);
	}

	all(): ToolDef[] {
		return [...this.defs.values()];
	}

	/** 按名字取工具定义；缺失即抛错。 */
	select(names: string[]): ToolDef[] {
		return names.map((name) => {
			const def = this.defs.get(name);
			if (!def) {
				throw new Error(`流程引用了未注册的工具: ${name}`);
			}
			return def;
		});
	}

	/**
	 * 适配成 Pi 的 AgentTool。
	 *
	 * 返回 `AgentTool<any>`：参数 schema 是运行期 JSON Schema，静态类型拿不到，
	 * 这正是 Pi 允许自定义 JSON Schema 的场景。
	 */
	toAgentTools(names: string[], ctx: BizContext): AgentTool<any>[] {
		return this.select(names).map((def) => ({
			name: def.name,
			label: def.name,
			description: def.description,
			parameters: def.parameters,
			// 高风险工具串行执行，避免并发触发外部系统的写冲突。
			executionMode: def.risk === "high" ? "sequential" : "parallel",
			execute: async (_toolCallId: string, params: Record<string, unknown>) => {
				const result = await def.execute(params ?? {}, ctx);
				return {
					content: [{ type: "text" as const, text: result.content }],
					details: undefined,
					...(result.isError === true ? { isError: true } : {}),
				};
			},
		}));
	}
}
