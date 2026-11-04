/**
 * 技能（skill）：把一条流程当"作业指导书"装进当前会话，由模型自己照着做。
 *
 * 和「流程即工具」（`flow_xxx`，起子 agent 整条跑完只回一段文本）互补：
 *   - 工具 = 委托执行：省上下文、定序强、过程不可见（适合"整条丢出去，只要结论"）
 *   - 技能 = 指令注入：过程可见、中途能插话、能换技能，代价是正文要占上下文
 *
 * 渐进式披露是这里的关键：系统提示里只放 `id + name + description`（技能目录），
 * 模型调 `use_skill` 之后才把 `instructions` 正文塞进上下文、把工具集换成技能声明的工具。
 * 这样加 10 条技能也只是提示词里多 10 行，不是多 10 份正文。
 *
 * 技能不是新的一套定义：它就是「流程 + 技能文案」，步骤仍由 `WorkflowEngine` 推进。
 */

import type { WorkflowDef, WorkflowStep } from "./types.js";

/** 加载技能的工具体；会话固定暴露这一个，不按技能数量膨胀工具列表。 */
export const SKILL_TOOL_NAME = "use_skill";

export interface SkillDef {
	/** 与流程 id 相同（内置流程与运行时自定义流程都能变成技能）。 */
	id: string;
	name: string;
	/** 一句话触发条件：只有它进系统提示的技能目录。 */
	description: string;
	/** 正文：加载之后模型照着做（含步骤清单）。 */
	instructions: string;
	/** 加载后这个技能能用的工具；空数组 = 保留会话现有工具（自动编排就是这种）。 */
	tools: string[];
	/** 技能内部步骤；非空时交给 `WorkflowEngine` 推进。 */
	steps: WorkflowStep[];
	/** 技能背后的流程定义：换技能时要拿它重置状态机。 */
	workflow: WorkflowDef;
}

/** 把步骤清单渲染成正文里的一段，保证"加载即知道该按什么顺序做"。 */
function renderSteps(steps: WorkflowStep[]): string {
	if (steps.length === 0) return "";
	return [
		"",
		"执行顺序（`WorkflowEngine` 会按成功调用的工具推进，不要跳步）：",
		...steps.map((step, index) => `${index + 1}. ${step.title}（工具：${step.via.join(" / ")}）——${step.hint}`),
	].join("\n");
}

/** 流程 → 技能：正文 = 技能文案（缺省回落 systemPrompt）+ 步骤清单。 */
export function skillFromWorkflow(workflow: WorkflowDef): SkillDef {
	// 空字符串要当"没写"处理：控制台允许只填正文或只填一句话，缺的那半走兜底
	const description = workflow.skill?.description?.trim() || `按固定步骤完成「${workflow.name}」。`;
	const base = workflow.skill?.instructions?.trim() || workflow.systemPrompt;
	const instructions =
		workflow.steps.length > 0
			? [base, renderSteps(workflow.steps)].join("\n")
			: [base, "", "这条技能没有预设步骤：先判断缺什么信息，再用工具补齐，能回答了就直接回复用户。"].join("\n");

	return {
		id: workflow.id,
		name: workflow.name,
		description,
		instructions,
		tools: [...new Set(workflow.steps.flatMap((step) => step.via))],
		steps: workflow.steps,
		workflow: workflow,
	};
}

export function findSkill(skills: SkillDef[], id: string): SkillDef | undefined {
	return skills.find((skill) => skill.id === id);
}

/** 系统提示里的技能目录：渐进式披露的第一层，只说"有什么、什么时候用"。 */
export function skillCatalogPrompt(skills: SkillDef[]): string {
	if (skills.length === 0) return "";
	return [
		"",
		"# 可用技能",
		"",
		"下面每条技能 = 一份作业指导书 + 一组工具。先判断用户这次的需求属于哪条技能，再决定要不要加载：",
		`- 属于某条技能 → 调 \`${SKILL_TOOL_NAME}\` 加载它（参数 skillId 用括号前的 id），加载后严格照它的说明执行；`,
		"- 只需要一次查询或一次修改 → 直接调业务工具，别为了简单事加载技能；",
		"- 想把整条流程丢出去、不需要看到中间过程 → 调对应的 `flow_xxx` 工具委托执行。",
		"",
		...skills.map((skill) => `- \`${skill.id}\`（${skill.name}）：${skill.description}`),
	].join("\n");
}

/** `use_skill` 的工具描述：把技能目录也带上，模型不用先查一次列表。 */
export function skillToolDescription(skills: SkillDef[]): string {
	const names = skills.map((skill) => `${skill.id}（${skill.name}）`).join("、");
	return `加载一条技能：把它的完整说明注入当前会话，并把工具集换成它需要的那几个。可用技能：${names}。只做一次查询/修改时不要用它，直接调业务工具。`;
}

export function skillToolParameters(skills: SkillDef[]): Record<string, unknown> {
	return {
		type: "object",
		properties: {
			skillId: {
				type: "string",
				enum: skills.map((skill) => skill.id),
				description: "要加载的技能 id",
			},
		},
		required: ["skillId"],
	};
}
