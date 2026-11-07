/**
 * 运行时装配：把"业务流程配置"翻译成一个 Pi 的 Agent。
 *
 * 这里是全项目唯一接触 Pi 具体 API 的地方——五个能力各挂一个钩子：
 *   工具      → AgentTool[]
 *   权限审批  → beforeToolCall
 *   审计治理  → afterToolCall
 *   上下文    → transformContext
 *   流程编排  → finishTurn + prepareNextTurnWithContext
 *
 * 换业务流程不需要改这里，只换 WorkflowDef 和 ToolRegistry。
 */

import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentLoopTurnUpdate, AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import type { Model, SystemMessage } from "@earendil-works/pi-ai";
import { createAuditHook } from "./audit.js";
import { createContextTransformer } from "./context.js";
import { createPermissionHook } from "./permission.js";
import type { ToolRegistry } from "./registry.js";
import type { BizContext, WorkflowDef, WorkflowState } from "./types.js";
import { WorkflowEngine } from "./workflow.js";
import { skillCatalogPrompt } from "./skill.js";
import type { SkillDef } from "./skill.js";

export interface CreateBusinessAgentOptions {
	workflow: WorkflowDef;
	registry: ToolRegistry;
	ctx: BizContext;
	model: Model<any>;
	streamFn: StreamFn;
	/** 最大工具轮次，防止流程卡死时无限循环。 */
	maxTurns?: number;
	/** 上下文滑动窗口大小。 */
	maxContextMessages?: number;
	maxContextRounds?: number;
	/** 可选的流程引擎；不传则内部创建。 */
	engine?: WorkflowEngine;
	/** 加载技能前的原会话进度，重建和恢复时沿用。 */
	baseWorkflowState?: WorkflowState;
	/** 恢复历史对话时传入已持久化的消息，让模型保留上下文。 */
	messages?: AgentMessage[];
	/**
	 * 覆盖要暴露给模型的工具名（默认只有当前流程步骤里 via 的工具）。
	 * 会话层用它把"流程工具"（flow_xxx）也一并装进去。
	 */
	toolNames?: string[];
	/**
	 * 会话可用的技能目录。只把 `id/name/description` 渲染进系统提示，
	 * 正文与工具集要等模型调 `use_skill` 才生效（渐进式披露）。
	 */
	skills?: SkillDef[];
	/** 换技能时永远保留的工具名（技能加载工具、flow_xxx 流程工具）。 */
	keepToolNames?: string[];
	/**
	 * 额外的系统提示片段（会话层注入）。目前用于「知识库可以直接检索」这类
	 * 不属于流程定义、但模型必须知道的运行时事实。
	 */
	systemPromptExtras?: string[];
}

export interface BusinessAgent {
	agent: Agent;
	engine: WorkflowEngine;
	/** 当前系统提示词（含流程步骤），便于排查。 */
	systemPrompt: string;
	/** 当前加载的技能；null = 没加载技能，跑的是会话原流程。 */
	activeSkill(): SkillDef | null;
	/**
	 * 加载技能：换工具集 + 换状态机，返回技能（正文由调用方写进工具结果）。
	 *
	 * 传 id 时只在构造时那份目录里找；**传 SkillDef 时以传入的为准**——
	 * 会话可能在运行期新建/改动技能，那份定义比构造时的快照新（见 `Session.refreshSkills`）。
	 */
	activateSkill(target: string | SkillDef): SkillDef;
	/** 退出技能，回到会话原流程与它上次的进度。 */
	clearSkill(): void;
	/** 当前实际暴露给模型的工具名（会话视图与落库用）。 */
	toolNames(): string[];
	limitReached(): boolean;
	baseWorkflowState(): WorkflowState;
}

/** 把流程步骤渲染进系统提示词；技能目录（渐进式披露的第一层）附在最后。 */
function buildSystemPrompt(workflow: WorkflowDef, skills: SkillDef[], extras: string[] = []): string {
	const catalog = skillCatalogPrompt(skills);
	// 会话层的运行时事实（例如「知识库可以直接检索」）接在技能目录后面，
	// 不写进流程定义——流程定义是持久的，这类事实可能随库配置变化
	const extraBlock = extras.length > 0 ? ["", ...extras].join("\n") : "";

	// 没有步骤 = 自动编排：不强制顺序，让模型自己在工具与流程工具之间选
	if (workflow.steps.length === 0) {
		return [
			workflow.systemPrompt,
			"",
			`# 工作模式：自动编排（不预设流程）`,
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

	const steps = workflow.steps.map((step, index) => {
		const tools = step.via.join(" / ");
		return `${index + 1}. ${step.title}（工具：${tools}）`;
	});

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

export function createBusinessAgent(options: CreateBusinessAgentOptions): BusinessAgent {
	const { workflow, registry, ctx, model, streamFn } = options;
	const maxTurns = options.maxTurns ?? 20;
	const maxContextMessages = options.maxContextMessages ?? 40;
	const transform = createContextTransformer({ maxMessages: maxContextMessages, maxRounds: options.maxContextRounds });

	// 允许外部传入引擎，便于调用方（如 Web 会话）读取流程状态或给模型脚本注入步骤。
	const engine = options.engine ?? new WorkflowEngine(workflow);
	const toolNames = options.toolNames ?? [...new Set(workflow.steps.flatMap((step) => step.via))];
	const tools = registry.toAgentTools(toolNames, ctx);
	const skills = options.skills ?? [];
	const skillById = new Map(skills.map((skill) => [skill.id, skill]));
	const keepToolNames = options.keepToolNames ?? [];
	const systemPrompt = buildSystemPrompt(workflow, skills, options.systemPromptExtras ?? []);

	// 历史消息里开头那条 system 是"上一次装配时的系统提示"，不是对话内容。
	// 留着它 Pi 就不会采用本次新拼的 systemPrompt（见下面 initialState 的注释），
	// 所以这里先剥掉：真正的"对话历史"从第一条非 system 消息开始。
	const history = options.messages ?? [];
	// 全 system（或没有历史）= 没有真实对话内容，整份丢掉即可，提示完全由本次装配决定
	const firstNonSystem = history.findIndex((message) => message.role !== "system");
	const restored = firstNonSystem >= 0 ? history.slice(firstNonSystem) : [];

	let turns = 0;
	let lastTurnHadError = false;
	let limitReached = false;
	/** 会话原流程的进度：加载技能前存一份，退出技能时恢复回去。 */
	let savedWorkflowState = options.baseWorkflowState ? structuredClone(options.baseWorkflowState) : undefined;
	let activeSkill: SkillDef | null = null;
	let currentToolNames = [...toolNames];

	const agent = new Agent({
		initialState: {
			systemPrompt,
			model,
			tools,
			// 有历史消息就恢复上下文，但**必须剥掉历史开头那条 system 消息**：
			// Pi 的 Agent 只在"历史不以 system 开头"时才采用 initialState.systemPrompt，
			// 否则整份新提示会被丢掉、继续沿用历史里那份旧的。
			// 后果很隐蔽：换模型 / 切计划模式都会重建 agent，提示明明重新拼过，
			// 模型收到的却还是老的（表现就是"开了计划模式，模型照旧直接动手"）。
			// 这里统一让**本次新拼的提示**赢。
			...(restored.length > 0 ? { messages: restored } : {}),
		},
		streamFn,
		transformContext: async (messages) => {
			const context = await transform(messages);
			if (!activeSkill) return context;
			// 临时上下文消息：不写入系统提示和历史，退出技能后立即消失。
			const instruction: AgentMessage = {
				role: "user", timestamp: Date.now(),
				content: `当前技能「${activeSkill.name}」的作业指导书：\n\n${activeSkill.instructions}`,
			};
			const first = context.findIndex((message) => message.role !== "system");
			const index = first < 0 ? context.length : first;
			return [...context.slice(0, index), instruction, ...context.slice(index)];
		},
		beforeToolCall: createPermissionHook(ctx, registry),
		afterToolCall: createAuditHook(ctx),
		finishTurn: (turn) => {
			for (const result of turn.toolResults) {
				engine.recordToolResult(result.toolName, !result.isError);
			}

			const hasToolCalls = turn.toolResults.length > 0;
			const hadError = turn.toolResults.some((result) => result.isError);
			turns++;
			if (hasToolCalls && turns >= maxTurns) {
				limitReached = true;
				return { action: "end" };
			}

			// 这一轮模型没调工具，说明它想收尾了。
			if (!hasToolCalls) {
				// 流程已走完 → 这就是总结，结束。
				if (engine.done) return { action: "end" };
				// 上一步工具失败，模型选择说明原因 → 尊重它，结束。
				if (lastTurnHadError) return { action: "end" };
				// 上一轮调的是本流程之外的工具（典型：整条跑了别的流程），
				// 说明用户这次的问题已经由它回答完了 —— 别再逼它回去推本流程的步骤。
				if (engine.lastCallOffTrack) return { action: "end" };
				// 否则说明模型提前停了，继续逼它推进流程。
			} else if (engine.done) {
				// 刚做完最后一步，再给一轮机会写总结。
				lastTurnHadError = hadError;
				return { action: "continue" };
			}

			lastTurnHadError = hadError;
			if (turns >= maxTurns) {
				limitReached = true;
				return { action: "end" };
			}
			return { action: "continue" };
		},
		prepareNextTurnWithContext: (): AgentLoopTurnUpdate => {
			const nudge: SystemMessage = {
				role: "system",
				content: engine.nextPrompt(),
				timestamp: Date.now(),
			};
			return { messages: [nudge] };
		},
	});
	agent.subscribe((event) => {
		if (event.type === "agent_start") {
			turns = 0;
			lastTurnHadError = false;
			limitReached = false;
		}
	});

	/**
	 * 换工具集：技能声明的工具 + 永远保留的（use_skill / flow_xxx）。
	 *
	 * 只换 `agent.state.tools`，不重建 Agent——历史对话、审批挂起、订阅关系都要保住。
	 * 技能里点名的工具如果会话注册表里没有（例如自定义流程引用了已删的工具），静默跳过，
	 * 真正缺失时有 `flow_xxx` 或报错兜底，不该因为一个名字把整轮对话搞崩。
	 */
	const swapTools = (names: string[]): void => {
		currentToolNames = [...new Set([...names, ...keepToolNames])].filter((name) => registry.has(name));
		agent.state.tools = registry.toAgentTools(currentToolNames, ctx);
	};

	const activateSkill = (target: string | SkillDef): SkillDef => {
		// 传对象 = 调用方刚刚从仓库里取的新定义，不要拿构造时的快照去覆盖它
		const skill = typeof target === "string" ? skillById.get(target) : target;
		if (!skill) {
			throw new Error(`未注册的技能: ${String(target)}`);
		}
		// 只在"从无技能到有技能"时快照原流程进度，技能之间来回切不该覆盖它
		if (activeSkill === null && savedWorkflowState === undefined) {
			savedWorkflowState = structuredClone(engine.state);
		}
		activeSkill = skill;
		engine.reset(skill.workflow);
		// 空 tools = 这条技能不限制工具（自动编排就是这种）
		swapTools(skill.tools.length > 0 ? skill.tools : toolNames);
		return skill;
	};

	const clearSkill = (): void => {
		if (activeSkill === null) return;
		activeSkill = null;
		engine.reset(workflow, savedWorkflowState);
		savedWorkflowState = undefined;
		swapTools(toolNames);
	};

	return {
		agent,
		engine,
		systemPrompt,
		activeSkill: () => activeSkill,
		activateSkill,
		clearSkill,
		toolNames: () => currentToolNames,
		limitReached: () => limitReached,
		baseWorkflowState: () => structuredClone(savedWorkflowState ?? engine.state),
	};
}

/** 订阅 agent 事件，把流式文本打到 stdout。返回取消订阅函数。 */
export function pipeTextToStdout(agent: Agent): () => void {
	return agent.subscribe((event) => {
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			process.stdout.write(event.assistantMessageEvent.delta);
		}
	});
}
