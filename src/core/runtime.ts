/** Business runtime composition: workflows, skills, tools, and turn policy. */

import type { ToolRegistry } from "./registry.js";
import type { ToolDef, WorkflowDef, WorkflowState } from "./types.js";
import { WorkflowEngine } from "./workflow.js";
import { createWorkflowTurnPolicy } from "./workflowPolicy.js";
import type { WorkflowToolResult } from "./workflowPolicy.js";
import { skillCatalogPrompt } from "./skill.js";
import type { SkillDef } from "./skill.js";

export interface CreateBusinessRuntimeOptions {
	workflow: WorkflowDef;
	registry: ToolRegistry;
	maxTurns?: number;
	engine?: WorkflowEngine;
	baseWorkflowState?: WorkflowState;
	toolNames?: string[];
	skills?: SkillDef[];
	keepToolNames?: string[];
	systemPromptExtras?: string[];
}

export interface BusinessRuntime {
	engine: WorkflowEngine;
	systemPrompt: string;
	activeSkill(): SkillDef | null;
	skillContext(): { name: string; instructions: string } | null;
	activateSkill(target: string | SkillDef): SkillDef;
	clearSkill(): void;
	toolNames(): string[];
	toolDefinitions(): ToolDef[];
	limitReached(): boolean;
	startRun(): void;
	finishTurn(toolResults: WorkflowToolResult[]): { continue: boolean; terminateTools: boolean };
	nextPrompt(): string;
	baseWorkflowState(): WorkflowState;
}

/** Build business policy and loadout without creating a model agent or session. */
export function createBusinessRuntime(options: CreateBusinessRuntimeOptions): BusinessRuntime {
	const { workflow, registry } = options;
	const maxTurns = options.maxTurns ?? 20;
	const engine = options.engine ?? new WorkflowEngine(workflow);
	const toolNames = options.toolNames ?? [...new Set(workflow.steps.flatMap((step) => step.via))];
	const skills = options.skills ?? [];
	const skillById = new Map(skills.map((skill) => [skill.id, skill]));
	const keepToolNames = options.keepToolNames ?? [];
	const systemPrompt = buildBusinessSystemPrompt(workflow, skills, options.systemPromptExtras ?? []);
	const turnPolicy = createWorkflowTurnPolicy(engine, maxTurns);
	let savedWorkflowState = options.baseWorkflowState ? structuredClone(options.baseWorkflowState) : undefined;
	let activeSkill: SkillDef | null = null;
	let currentToolNames = [...toolNames];

	const resolveToolNames = (names: string[]): void => {
		currentToolNames = [...new Set([...names, ...keepToolNames])].filter((name) => registry.has(name));
	};

	const activateSkill = (target: string | SkillDef): SkillDef => {
		const skill = typeof target === "string" ? skillById.get(target) : target;
		if (!skill) throw new Error(`未注册的技能: ${String(target)}`);
		if (activeSkill === null && savedWorkflowState === undefined) {
			savedWorkflowState = structuredClone(engine.state);
		}
		activeSkill = skill;
		engine.reset(skill.workflow);
		resolveToolNames(skill.tools.length > 0 ? skill.tools : toolNames);
		return skill;
	};

	const clearSkill = (): void => {
		if (activeSkill === null) return;
		activeSkill = null;
		engine.reset(workflow, savedWorkflowState);
		savedWorkflowState = undefined;
		resolveToolNames(toolNames);
	};

	return {
		engine,
		systemPrompt,
		activeSkill: () => activeSkill,
		skillContext: () => activeSkill ? { name: activeSkill.name, instructions: activeSkill.instructions } : null,
		activateSkill,
		clearSkill,
		toolNames: () => [...currentToolNames],
		toolDefinitions: () => registry.select(currentToolNames),
		limitReached: turnPolicy.limitReached,
		startRun: turnPolicy.startRun,
		finishTurn: turnPolicy.finishTurn,
		nextPrompt: turnPolicy.nextPrompt,
		baseWorkflowState: () => structuredClone(savedWorkflowState ?? engine.state),
	};
}

/** Render workflow instructions and the progressively disclosed skill catalog. */
export function buildBusinessSystemPrompt(workflow: WorkflowDef, skills: SkillDef[], extras: string[] = []): string {
	const catalog = skillCatalogPrompt(skills);
	const extraBlock = extras.length > 0 ? ["", ...extras].join("\n") : "";
	if (workflow.steps.length === 0) {
		return [
			workflow.systemPrompt,
			"",
			"# 工作模式：自动编排（不预设流程）",
			"",
			"你没有被写死的步骤。每次先判断用户到底要什么，再决定用哪些工具：",
			"- 需求属于某条完整业务流程（多步、要按顺序做）→ 先调 `use_skill` 加载那条技能，再按它的说明逐步执行；",
			"  这是默认做法，不要为了省几次调用就改调 `flow_xxx`——那样用户看不到中间过程。",
			"- 只是单步操作或查询 → 直接调用具体业务工具，不用加载技能；",
			"- 只有用户明确说「整条丢出去 / 不用我看过程 / 交给流程跑」时，才调 `flow_xxx` 委托执行；",
			"- 需要人工确认的高风险操作会由系统拦截并等待用户，不要自己模拟审批结果。",
			"- 调用流程工具之后，它返回的就是这条流程的执行结果：把它整理成面向用户的回答（可以提炼要点），",
			'  不要只回「好的」「收到」「已完成」这类客套话。',
			"- 做完后用一段话汇报结果；不要停在半路，也不要重复调用同一个工具。",
			catalog + extraBlock,
		].join("\n");
	}

	const steps = workflow.steps.map((step, index) => `${index + 1}. ${step.title}（工具：${step.via.join(" / ")}）`);
	return [
		workflow.systemPrompt,
		"",
		`# 业务流程：${workflow.name}`,
		"",
		"必须按以下顺序推进，每一步用一个工具完成：",
		...steps,
		"",
		"规则：",
		"- 一次只推进一个步骤，不要跳步。",
		"- 上一步成功后立刻进行下一步，不要停下来问用户。",
		"- 全部步骤完成后，用一段话汇报结果，不要再调用任何工具。",
		"- 如果用户这次问的事和本流程无关（例如在工单会话里问数据分析），不要硬套步骤：",
		"  属于别的完整业务流程就先用 `use_skill` 换成那条技能，单步的事直接调业务工具，",
		"  只是想整条丢出去才用 `flow_xxx` 委托；无论哪种，都要把结果整理成回答。",
		'- 调用流程工具（flow_xxx）之后，它返回的就是执行结果：整理成面向用户的回答，不要只回「好的」这类客套话。',
		catalog + extraBlock,
	].join("\n");
}
