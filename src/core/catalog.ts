/**
 * 工具目录：把散在各切片里的业务工具收敛成"平台当前拥有的全部能力"。
 *
 * 为什么要多这一层：内置流程自带工具（工具和流程在同一个 TS 文件里），
 * 而自定义流程是运行时从数据库里读出来的——它不可能 import 代码，
 * 只能按名字从目录里挑。副作用仍然只存在于代码里，流程只负责编排。
 */

import type { Store } from "../store/memory.js";
import type { RiskLevel, ToolDef } from "./types.js";

export type ToolFactory = (store: Store) => ToolDef[];

/** 给控制台的"步骤可选用工具"列表用。 */
export interface ToolSummary {
	name: string;
	description: string;
	category: string;
	risk: RiskLevel;
	/** 演示参数是否存在；没有的话模拟模型只能空参调用。 */
	hasExample: boolean;
}

export interface ToolCatalog {
	/** 目录里的全部工具名（去重，用于校验流程的 via）。 */
	names(store: Store): string[];
	/** 概要信息，给控制台的流程编辑器用。 */
	summaries(store: Store): ToolSummary[];
	/** 按名字取工具定义；出现未知名立即抛错，不留到运行时。 */
	pick(store: Store, names: string[]): ToolDef[];
}

export function createToolCatalog(factories: ToolFactory[]): ToolCatalog {
	const all = (store: Store): ToolDef[] => {
		const defs = factories.flatMap((factory) => factory(store));
		const seen = new Set<string>();
		for (const def of defs) {
			if (seen.has(def.name)) {
				throw new Error(`工具目录出现重名工具: ${def.name}`);
			}
			seen.add(def.name);
		}
		return defs;
	};

	return {
		names(store) {
			return all(store).map((def) => def.name);
		},

		summaries(store) {
			return all(store).map((def) => ({
				name: def.name,
				description: def.description,
				category: def.category,
				risk: def.risk,
				hasExample: def.example !== undefined,
			}));
		},

		pick(store, names) {
			const defs = all(store);
			const byName = new Map(defs.map((def) => [def.name, def]));
			return [...new Set(names)].map((name) => {
				const def = byName.get(name);
				if (!def) {
					throw new Error(`流程引用了工具目录里不存在的工具: ${name}`);
				}
				return def;
			});
		},
	};
}
