/**
 * 流程状态机。
 *
 * 每个步骤声明自己由哪个工具调用完成（`via`）。每当一轮工具执行结束，
 * runtime 把结果喂进来，引擎据此推进步骤。它不调用 LLM——
 * 只是把"业务流程走到哪了"这件事从模型手里拿回到代码里。
 */

import type { ToolCallRecord, WorkflowDef, WorkflowState, WorkflowStep } from "./types.js";

export class WorkflowEngine {
	private def: WorkflowDef;
	state: WorkflowState;
	/** 本流程声明的步骤工具名，用来区分"跑本流程"和"半路去调了别的工具"。 */
	private stepTools: Set<string>;
	/** 最近一次工具调用：调了谁、有没有推进本流程。 */
	private lastCall: { name: string; advanced: boolean } | null = null;

	constructor(def: WorkflowDef, restored?: WorkflowState) {
		this.def = def;
		this.state = restored ?? {
			workflowId: def.id,
			stepIndex: 0,
			completed: [],
			calls: [],
		};
		this.stepTools = new Set(def.steps.flatMap((step) => step.via));
	}

	/**
	 * 换一条流程跑（加载技能、退出技能时用）。
	 *
	 * 引擎实例被会话层长期持有（`Session.engine`、会话视图都在读它），
	 * 所以换流程是"就地重置"而不是新建实例——否则所有引用都会指向旧状态。
	 * 传 `restored` 可以恢复某条流程上次的进度（退出技能时切回会话原流程的进度）。
	 */
	reset(def: WorkflowDef, restored?: WorkflowState): void {
		this.def = def;
		this.state = restored ?? {
			workflowId: def.id,
			stepIndex: 0,
			completed: [],
			calls: [],
		};
		this.stepTools = new Set(def.steps.flatMap((step) => step.via));
		this.lastCall = null;
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

	/**
	 * 最近一次工具调用是不是"跑偏"了：调的不是本流程步骤里的工具，也没推进流程。
	 *
	 * 典型场景：会话开在「工单处理」上，用户问的却是一句数据分析，模型直接调了
	 * `flow_data_flow` 把另一条流程整条跑完。这时候再催它"第 1 步：查询工单"，
	 * 模型只会挤出一句"好的"——应该让它把刚才那个结果整理成回答并收尾。
	 */
	get lastCallOffTrack(): boolean {
		if (this.lastCall === null) return false;
		if (this.lastCall.advanced) return false;
		return !this.stepTools.has(this.lastCall.name);
	}

	/** 记录一次工具结果并尝试推进步骤。 */
	recordToolResult(toolName: string, ok: boolean): void {
		const record: ToolCallRecord = { name: toolName, ok };
		this.state.calls.push(record);
		const before = this.state.stepIndex;
		this.advance();
		this.lastCall = { name: toolName, advanced: this.state.stepIndex > before };
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
		// 没有步骤（自动编排）：不催流程，只催它别停在半路
		if (this.def.steps.length === 0) {
			return "按需继续：还缺信息就用工具去查，能回答了就直接回复用户。不要停在半路，也不要重复调用同一个工具。";
		}
		if (this.done) {
			return "所有流程步骤已完成。请用一段话向用户汇报执行结果，不要再调用任何工具。";
		}
		// 跑偏了（调了别的流程/别的工具）：别硬把用户的问题塞回本流程的下一步
		if (this.lastCallOffTrack) {
			const called = this.lastCall!.name;
			return `你刚才调用的是本流程之外的工具（${called}），它已经把结果返回了。请把这个结果整理成面向用户的最终回答，不要只回「好的」「收到」这类客套话；本流程「${this.def.name}」剩下的步骤和用户这次的问题无关，不要再继续执行。`;
		}
		const step = this.currentStep!;
		const position = `${this.state.stepIndex + 1}/${this.def.steps.length}`;
		return `流程「${this.def.name}」当前进行到第 ${position} 步：${step.title}。${step.hint}`;
	}
}
