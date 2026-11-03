/**
 * 流程状态机。
 *
 * 每个步骤声明自己由哪个工具调用完成（`via`）。每当一轮工具执行结束，
 * runtime 把结果喂进来，引擎据此推进步骤。它不调用 LLM——
 * 只是把"业务流程走到哪了"这件事从模型手里拿回到代码里。
 */

import type { ToolCallRecord, WorkflowDef, WorkflowState, WorkflowStep } from "./types.js";

export class WorkflowEngine {
	private readonly def: WorkflowDef;
	readonly state: WorkflowState;

	constructor(def: WorkflowDef, restored?: WorkflowState) {
		this.def = def;
		this.state = restored ?? {
			workflowId: def.id,
			stepIndex: 0,
			completed: [],
			calls: [],
		};
	}

	get definition(): WorkflowDef {
		return this.def;
	}

	get currentStep(): WorkflowStep | undefined {
		return this.def.steps[this.state.stepIndex];
	}

	get done(): boolean {
		return this.state.stepIndex >= this.def.steps.length;
	}

	/** 记录一次工具结果并尝试推进步骤。 */
	recordToolResult(toolName: string, ok: boolean): void {
		const record: ToolCallRecord = { name: toolName, ok };
		this.state.calls.push(record);
		this.advance();
	}

	/** 连续推进：一个工具可能同时满足多个步骤（理论上），或者上一步已完成但没及时推进。 */
	private advance(): void {
		while (!this.done) {
			const step = this.def.steps[this.state.stepIndex]!;
			const satisfied = this.state.calls.some((call) => call.ok && step.via.includes(call.name));
			if (!satisfied) {
				break;
			}
			this.state.completed.push(step.id);
			this.state.stepIndex++;
		}
	}

	/** 给模型的下一步指令；全部完成时要求它收尾汇报。 */
	nextPrompt(): string {
		if (this.done) {
			return "所有流程步骤已完成。请用一段话向用户汇报执行结果，不要再调用任何工具。";
		}
		const step = this.currentStep!;
		const position = `${this.state.stepIndex + 1}/${this.def.steps.length}`;
		return `流程「${this.def.name}」当前进行到第 ${position} 步：${step.title}。${step.hint}`;
	}
}
