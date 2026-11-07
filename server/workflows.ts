/**
 * 运行时流程仓库：把「内置流程（代码）」和「自定义流程（SQLite）」合并成一份索引。
 *
 * 这样调用方（会话层 / 路由层）只认 `repo.get(id)`，不关心这条流程是写在代码里
 * 还是用户在控制台上建的。自定义流程只能按名字引用工具目录里的工具——
 * 副作用永远在代码里，流程只负责编排。
 */

import { randomUUID } from "node:crypto";
import { createToolCatalog } from "../src/core/catalog.js";
import type { ToolSummary } from "../src/core/catalog.js";
import { skillFromWorkflow } from "../src/core/skill.js";
import type { SkillDef } from "../src/core/skill.js";
import { createStore } from "../src/store/memory.js";
import type { WorkflowDef, WorkflowStep } from "../src/core/types.js";
import {
	mergeWorkflowInput,
	validateWorkflowInput,
	WorkflowSpecError,
} from "../src/core/workflowSpec.js";
import type { WorkflowInput } from "../src/core/workflowSpec.js";
import { builtinToolFactories, indexWorkflows, workflowList } from "../src/workflows/index.js";
import type { Storage, WorkflowRow } from "./db/index.js";

/** 带 HTTP 状态码的业务错误；路由层直接映射成响应。 */
export class WorkflowHttpError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

export interface WorkflowStepView {
	id: string;
	title: string;
	via: string[];
}

/** 列表项：控制台左栏与流程管理器用。 */
export interface WorkflowSummary {
	id: string;
	name: string;
	builtin: boolean;
	steps: WorkflowStepView[];
	/** 定义已失效（例如引用的工具被删了）；有值时该流程不可用于建会话。 */
	error?: string;
}

/** 详情：流程编辑器用。 */
export interface WorkflowDetail {
	id: string;
	name: string;
	systemPrompt: string;
	builtin: boolean;
	steps: WorkflowStep[];
	/** 技能文案（内置流程与自定义流程都可能带）：技能区「查看」用它显示作业指导书。 */
	skill?: import("../src/core/types.js").WorkflowSkillText;
	error?: string;
}

/** 自定义流程数量上限，防止控制台被灌爆。 */
const MAX_CUSTOM_WORKFLOWS = 50;

export class WorkflowRepo {
	private readonly catalog = createToolCatalog(builtinToolFactories);
	private readonly builtinIds: Set<string>;
	private readonly builtinDefs: WorkflowDef[];
	private defs: Record<string, WorkflowDef>;
	private custom: WorkflowRow[] = [];
	private plugins: import("./db/types.js").PluginRecord[] = [];
	private broken = new Map<string, string>();

	constructor(private readonly db: Storage) {
		this.builtinDefs = workflowList;
		this.builtinIds = new Set(workflowList.map((workflow) => workflow.id));
		this.defs = indexWorkflows(workflowList);
		this.reload();
	}

	/* ---------------- 查询 ---------------- */

	get(id: string): WorkflowDef | undefined {
		return this.defs[id];
	}

	/** 全部可用流程定义（内置在前，自定义在后）。 */
	all(): WorkflowDef[] {
		return [...this.builtinDefs, ...this.custom.filter((row) => !row.pluginId || this.plugins.some((plugin) => plugin.id === row.pluginId && plugin.enabled)).map((row) => this.defs[row.id]).filter((def): def is WorkflowDef => Boolean(def))];
	}

	list(): WorkflowSummary[] {
		const builtin: WorkflowSummary[] = this.builtinDefs.map((workflow) => ({
			id: workflow.id,
			name: workflow.name,
			builtin: true,
			steps: workflow.steps.map((step) => ({ id: step.id, title: step.title, via: [...step.via] })),
		}));
		const custom: WorkflowSummary[] = this.custom.filter((row) => !row.pluginId || this.plugins.some((plugin) => plugin.id === row.pluginId && plugin.enabled)).map((row) => ({
			id: row.id,
			name: row.name,
			builtin: false,
			steps: row.steps.map((step) => ({ id: step.id, title: step.title, via: [...step.via] })),
			...(this.broken.has(row.id) ? { error: this.broken.get(row.id) } : {}),
		}));
		return [...builtin, ...custom];
	}

	detail(id: string): WorkflowDetail {
		const row = this.custom.find((item) => item.id === id);
		if (row) {
			if (row.pluginId && !this.plugins.some((plugin) => plugin.id === row.pluginId && plugin.enabled)) throw new WorkflowHttpError(`技能不存在: ${id}`, 404);
			return { ...this.detailFromRow(row) };
		}
		const workflow = this.builtinDefs.find((item) => item.id === id);
		if (!workflow) {
			throw new WorkflowHttpError(`流程不存在: ${id}`, 404);
		}
		return {
			id: workflow.id,
			name: workflow.name,
			systemPrompt: workflow.systemPrompt,
			builtin: true,
			steps: workflow.steps.map((step) => ({ ...step, via: [...step.via] })),
			...(workflow.skill ? { skill: { ...workflow.skill } } : {}),
		};
	}

	/** 工具目录，给流程编辑器的"步骤可选用工具"用。 */
	toolSummaries(): ToolSummary[] {
		return this.catalog.summaries(createStore());
	}

	/** 工具目录里的全部工具名；"自动编排"这类不预设工具的流程会全部装上。 */
	toolNames(): string[] {
		return this.catalog.names(createStore());
	}

	/** 工具目录里的全部工具定义（技能加载后要换上一整套别的业务的工具）。 */
	allTools(store: ReturnType<typeof createStore>): import("../src/core/types.js").ToolDef[] {
		return this.catalog.pick(store, this.catalog.names(store));
	}

	/** 全部可用流程对应的技能（内置 + 自定义，顺序同左栏）。 */
	skills(): SkillDef[] {
		return this.all().map(skillFromWorkflow);
	}

	skill(id: string): SkillDef | undefined {
		const workflow = this.defs[id];
		return workflow ? skillFromWorkflow(workflow) : undefined;
	}

	isBuiltin(id: string): boolean {
		return this.builtinIds.has(id);
	}

	isReadOnly(id: string): boolean {
		return this.isBuiltin(id) || Boolean(this.custom.find((row) => row.id === id)?.pluginId);
	}

	/* ---------------- 变更 ---------------- */

	create(raw: unknown): WorkflowDetail {
		if (this.custom.length >= MAX_CUSTOM_WORKFLOWS) {
			throw new WorkflowHttpError(`自定义流程最多 ${MAX_CUSTOM_WORKFLOWS} 个`, 400);
		}
		const input = this.validate(raw, undefined);
		const now = Date.now();
		const row: WorkflowRow = {
			id: this.nextId(),
			name: input.name,
			systemPrompt: input.systemPrompt,
			steps: input.steps,
			...(input.skill ? { skill: input.skill } : {}),
			createdAt: now,
			updatedAt: now,
		};
		this.db.saveWorkflow(row);
		this.reload();
		return this.detailFromRow(row);
	}

	update(id: string, patch: unknown): WorkflowDetail {
		this.assertCustom(id);
		const row = this.custom.find((item) => item.id === id)!;
		const input = this.validate(patch, id);
		const next: WorkflowRow = {
			...row,
			name: input.name,
			systemPrompt: input.systemPrompt,
			steps: input.steps,
			// skill 可能是"清空"：这里要显式覆盖，不能靠展开旧值
			skill: input.skill,
			updatedAt: Date.now(),
		};
		this.db.saveWorkflow(next);
		this.reload();
		return this.detailFromRow(next);
	}

	remove(id: string): void {
		this.assertCustom(id);
		this.db.removeWorkflow(id);
		this.reload();
	}

	/* ---------------- 内部 ---------------- */

	private validate(raw: unknown, currentId: string | undefined): WorkflowInput {
		const knownTools = this.catalog.names(createStore());
		const takenNames = [...this.builtinDefs.map((workflow) => workflow.name)]
			.concat(this.custom.filter((row) => row.id !== currentId).map((row) => row.name));

		try {
			if (currentId === undefined) {
				return validateWorkflowInput(raw, { knownTools, takenNames });
			}
			const current = this.inputOf(currentId);
			return mergeWorkflowInput(current, raw, { knownTools, takenNames });
		} catch (error) {
			if (error instanceof WorkflowSpecError) {
				throw new WorkflowHttpError(error.message, 400);
			}
			throw error;
		}
	}

	private inputOf(id: string): WorkflowInput {
		const row = this.custom.find((item) => item.id === id);
		if (row?.pluginId) throw new WorkflowHttpError("插件管理的技能请通过插件启停和卸载", 403);
		if (!row) {
			throw new WorkflowHttpError(`流程不存在: ${id}`, 404);
		}
		return {
			name: row.name,
			systemPrompt: row.systemPrompt,
			steps: row.steps,
			...(row.skill ? { skill: row.skill } : {}),
		};
	}

	private assertCustom(id: string): void {
		if (this.builtinIds.has(id)) {
			throw new WorkflowHttpError(`「${id}」是内置流程，不能修改或删除`, 403);
		}
		const row = this.custom.find((item) => item.id === id);
		if (row?.pluginId) throw new WorkflowHttpError("插件管理的技能请通过插件启停和卸载", 403);
		if (!row) {
			throw new WorkflowHttpError(`流程不存在: ${id}`, 404);
		}
	}

	private detailFromRow(row: WorkflowRow): WorkflowDetail {
		return {
			id: row.id,
			name: row.name,
			systemPrompt: row.systemPrompt,
			builtin: false,
			steps: row.steps.map((step) => ({ ...step, via: [...step.via] })),
			...(row.skill ? { skill: { ...row.skill } } : {}),
			...(this.broken.has(row.id) ? { error: this.broken.get(row.id) } : {}),
		};
	}

	/** 自定义流程的 id：`flow-` + 8 位短随机，避免和内置 id 撞车。 */
	private nextId(): string {
		for (;;) {
			const id = `flow-${randomUUID().slice(0, 8)}`;
			if (!this.builtinIds.has(id) && !this.custom.some((row) => row.id === id)) {
				return id;
			}
		}
	}

	/**
	 * 从存储层重新加载并重建索引。
	 * 单条流程定义失效（引用的工具已不在目录里）时不阻断启动：记进 broken，
	 * 列表里带 error，建会话时给出可读错误，用户可以去控制台改掉它。
	 */
	private reload(): void {
		this.custom = this.db.listWorkflows();
		this.plugins = this.db.listPlugins();
		const next: Record<string, WorkflowDef> = indexWorkflows(this.builtinDefs);
		this.broken = new Map();

		for (const row of this.custom) {
			if (row.pluginId && !this.plugins.some((plugin) => plugin.id === row.pluginId && plugin.enabled)) continue;
			const viaNames = [...new Set(row.steps.flatMap((step) => step.via))];
			try {
				this.catalog.pick(createStore(), viaNames);
			} catch (error) {
				this.broken.set(row.id, error instanceof Error ? error.message : String(error));
				continue;
			}
			next[row.id] = {
				id: row.id,
				name: row.name,
				systemPrompt: row.systemPrompt,
				steps: row.steps,
				createTools: (store) => this.catalog.pick(store, viaNames),
				...(row.skill ? { skill: row.skill } : {}),
			};
		}

		this.defs = next;
	}

	/** 供路由层判断"这条流程是否可用"（broken 的流程不允许建会话）。 */
	refresh(): void { this.reload(); }

	errorOf(id: string): string | undefined {
		return this.broken.get(id);
	}
}
