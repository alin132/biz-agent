/**
 * 业务工具定义注册表；运行时宿主负责将定义转换成模型工具。
 *
 * 流程定义里只写工具名，注册表负责解析到 ToolDef；缺工具时立即报错。
 */

import type { ToolDef } from "./types.js";

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

}
