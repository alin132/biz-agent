/**
 * 流程定义校验：控制台新建/编辑流程时的唯一入口。
 *
 * 刻意做成纯函数（不碰数据库、不碰 fs），这样 `npm run verify` 能直接覆盖所有非法输入，
 * server 层只负责"读出来 → 校验 → 落库"。错误信息直接给界面用，所以写人话。
 */

import type { WorkflowSkillText, WorkflowStep } from "./types.js";

/** 长度等硬限制；前端也有对应的 maxlength，但以后端为准。 */
export const WORKFLOW_LIMITS = {
	name: 40,
	systemPrompt: 4000,
	steps: 10,
	stepTitle: 40,
	stepHint: 200,
	viaPerStep: 8,
	skillDescription: 200,
	skillInstructions: 4000,
} as const;

export class WorkflowSpecError extends Error {}

export interface WorkflowInput {
	name: string;
	systemPrompt: string;
	steps: WorkflowStep[];
	/**
	 * 技能文案（可选）。不填也能当技能用（正文回落系统提示），
	 * 填了才有"什么时候该用我"的一句话进技能目录。
	 */
	skill?: WorkflowSkillText;
}

export interface ValidateOptions {
	/** 工具目录里的全部工具名。 */
	knownTools: string[];
	/** 除自己以外已占用的流程名（改流程时要排除自身）。 */
	takenNames?: string[];
}

function fail(message: string): never {
	throw new WorkflowSpecError(message);
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		fail(`${field} 必须是对象`);
	}
	return value as Record<string, unknown>;
}

function text(value: unknown, field: string, max: number): string {
	if (typeof value !== "string") {
		fail(`${field} 必须是字符串`);
	}
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		fail(`${field} 不能为空`);
	}
	if (trimmed.length > max) {
		fail(`${field} 最多 ${max} 个字符`);
	}
	return trimmed;
}

function optionalText(value: unknown, field: string, max: number): string {
	if (value === undefined || value === null || value === "") {
		return "";
	}
	if (typeof value !== "string") {
		fail(`${field} 必须是字符串`);
	}
	const trimmed = value.trim();
	if (trimmed.length > max) {
		fail(`${field} 最多 ${max} 个字符`);
	}
	return trimmed;
}

function parseSteps(value: unknown, knownTools: string[]): WorkflowStep[] {
	if (!Array.isArray(value)) {
		fail("steps 必须是数组");
	}
	if (value.length === 0) {
		fail("至少要有一个步骤");
	}
	if (value.length > WORKFLOW_LIMITS.steps) {
		fail(`步骤最多 ${WORKFLOW_LIMITS.steps} 个`);
	}

	const known = new Set(knownTools);
	return value.map((raw, index) => {
		const step = asRecord(raw, `第 ${index + 1} 步`);
		const title = text(step.title, `第 ${index + 1} 步的标题`, WORKFLOW_LIMITS.stepTitle);
		const hint = optionalText(step.hint, `第 ${index + 1} 步的提示`, WORKFLOW_LIMITS.stepHint);

		if (!Array.isArray(step.via)) {
			fail(`第 ${index + 1} 步的 via 必须是工具名数组`);
		}
		const via = [...new Set(step.via.map((item) => (typeof item === "string" ? item.trim() : "")))].filter(
			(item) => item.length > 0,
		);
		if (via.length === 0) {
			fail(`第 ${index + 1} 步至少要选一个工具`);
		}
		if (via.length > WORKFLOW_LIMITS.viaPerStep) {
			fail(`第 ${index + 1} 步最多选 ${WORKFLOW_LIMITS.viaPerStep} 个工具`);
		}
		for (const name of via) {
			if (!known.has(name)) {
				fail(`第 ${index + 1} 步引用了不存在的工具: ${name}`);
			}
		}

		return { id: `step-${index + 1}`, title, via, hint };
	});
}

/** 技能文案：两段都空 = 没写（返回 undefined，仍可当技能用，只是目录里用兜底描述）。 */
function parseSkill(value: unknown): WorkflowSkillText | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	const record = asRecord(value, "技能说明");
	const description = optionalText(record.description, "技能的一句话说明", WORKFLOW_LIMITS.skillDescription);
	const instructions = optionalText(record.instructions, "技能正文", WORKFLOW_LIMITS.skillInstructions);
	if (description.length === 0 && instructions.length === 0) {
		return undefined;
	}
	return instructions.length > 0 ? { description, instructions } : { description };
}

/** 校验并规范化一份自定义流程定义；不合法直接抛 WorkflowSpecError（消息可直接展示）。 */
export function validateWorkflowInput(raw: unknown, options: ValidateOptions): WorkflowInput {
	const input = asRecord(raw, "请求体");
	const name = text(input.name, "流程名称", WORKFLOW_LIMITS.name);
	if (options.takenNames?.includes(name)) {
		fail(`流程名称已存在: ${name}`);
	}
	const systemPrompt = text(input.systemPrompt, "系统提示", WORKFLOW_LIMITS.systemPrompt);
	const steps = parseSteps(input.steps, options.knownTools);
	const skill = parseSkill(input.skill);
	return skill ? { name, systemPrompt, steps, skill } : { name, systemPrompt, steps };
}

/** 部分更新：只校验传了的字段，其余沿用旧值。 */
export function mergeWorkflowInput(
	current: WorkflowInput,
	patch: unknown,
	options: ValidateOptions,
): WorkflowInput {
	const input = asRecord(patch, "请求体");
	// skill 传 null / 空对象 = 主动清掉技能文案；不传 = 沿用旧值
	const skill =
		input.skill === undefined ? current.skill : input.skill === null ? undefined : input.skill;
	return validateWorkflowInput(
		{
			name: input.name === undefined ? current.name : input.name,
			systemPrompt: input.systemPrompt === undefined ? current.systemPrompt : input.systemPrompt,
			steps: input.steps === undefined ? current.steps : input.steps,
			skill,
		},
		options,
	);
}
