/**
 * 模拟模型：没有 API key 时，用 Pi 的 faux provider 按流程定义"演"一遍。
 *
 * 关键点是 FauxResponseFactory 每轮都会收到当前 transcript，
 * 所以它可以：
 *   1. 读流程引擎状态，决定下一步该调哪个工具；
 *   2. 发现上一步工具失败/被阻断，就改为输出说明文字，不再硬重试。
 *
 * 接真实模型后这套脚本完全不需要，但它是演示和回归测试的底座。
 */

import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { FauxResponseFactory, FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import type { ToolRegistry } from "../src/core/registry.js";
import type { WorkflowDef } from "../src/core/types.js";
import type { WorkflowEngine } from "../src/core/workflow.js";

/**
 * 每个流程走完后的总结语（markdown，用于演示排版效果）。
 *
 * 只是"包装"，不是流程的一部分：没配到的流程会退化成按步骤自动生成的总结，
 * 所以新增流程不写这里也能演示，只是文案朴素一点。
 */
const DEMO_SUMMARY: Record<string, string> = {
	"ticket-flow": [
		"### 工单处理完成",
		"",
		"**TK-1001**「支付回调偶发超时」已按流程处理完毕。",
		"",
		"1. 查询并定位工单：`TK-1001`，客户云图科技",
		"2. 指派处理人：李工",
		"3. 状态更新：`processing`",
		"4. 已通过 IM 通知客户工单受理",
		"",
		"> 建议 2 小时内回访客户，确认回调超时是否复现。",
	].join("\n"),

	"data-flow": [
		"### 结论先行",
		"",
		"已回款订单共 **4 单**，华南贡献最高。",
		"",
		"### 区域分布",
		"",
		"- 华南：¥215,000",
		"- 华东：¥204,000",
		"- 华北：¥98,000",
		"",
		"### 口径说明",
		"",
		"华北有 1 单 `pending` 尚未回款，华东有 1 单 `refunded` 已退款，两种情况均未计入统计。",
		"",
		"报告已保存为《区域销售分析》。",
	].join("\n"),

	"approval-flow": [
		"### 审批已完成",
		"",
		"- 单据：`AP-1`",
		"- 申请人：张明",
		"- 金额：¥3,200",
		"- 状态：`archived`",
		"",
		"金额在自动审批阈值（¥5,000）以内，规则校验通过后已自动通过并完成归档。",
	].join("\n"),
};

export interface SimulatedRuntime {
	model: Model<any>;
	streamFn: StreamFn;
	mode: "simulated";
}

/** 流程没写专属台词时的兜底总结：按步骤自动列一遍，新流程不用配也能看到结果。 */
function fallbackSummary(workflow: WorkflowDef): string {
	const lines = [`### ${workflow.name}已完成`, ""];
	workflow.steps.forEach((step, index) => {
		lines.push(`${index + 1}. ${step.title}`);
	});
	lines.push("", "> 当前是模拟模型（未配置 API key），总结文案由流程定义自动生成。");
	return lines.join("\n");
}

/** 自动编排没有步骤，模拟模型没法定；直接说清"这一档要真模型"。 */
const AUTO_SIMULATED_TEXT = [
	"### 自动编排（当前是模拟模型）",
	"",
	"这一档没有写死的步骤，需要模型自己判断该用哪些工具、该加载哪条技能——模拟模型做不到这件事。",
	"",
	"两种办法：",
	"- 在 `.env` 里配一个 API key（或用 `LLM_PROVIDER` 系列变量自定义模型），重启后这一档就会真的自己挑技能；",
	"- 或者在右侧「技能」里接上一条具体技能再问，模拟模型能按步骤把它演完。",
].join("\n");

export function createSimulatedRuntime(
	engine: WorkflowEngine,
	registry: ToolRegistry,
): SimulatedRuntime {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);

	const factory: FauxResponseFactory = (context) => {
		const messages = context.messages;
		const last = messages[messages.length - 1];

		// 上一步工具失败或被阻断 → 改为说明原因，不要死循环重试。
		if (last?.role === "toolResult" && last.isError) {
			return fauxAssistantMessage("执行中断：上一步工具调用未成功，这次没走完。右侧审计流水里有失败原因。");
		}

		const workflow = engine.definition;

		// 技能切换会就地重置引擎，模拟模型必须读取当前定义，而非建会话时的流程快照。
		if (workflow.steps.length === 0) {
			return fauxAssistantMessage(AUTO_SIMULATED_TEXT);
		}

		if (engine.done) {
			return fauxAssistantMessage(DEMO_SUMMARY[workflow.id] ?? fallbackSummary(workflow));
		}

		const step = engine.currentStep;
		const tool = step?.via[0];
		if (!tool) {
			return fauxAssistantMessage("流程定义里没有可执行步骤。");
		}

		// 演示参数挂在工具定义上（ToolDef.example）：新增流程填了它就能被"演"完
		const args = (registry.get(tool)?.example ?? {}) as Parameters<typeof fauxToolCall>[1];
		return fauxAssistantMessage(fauxToolCall(tool, args));
	};

	// 队列长度够用即可：工厂本身会根据引擎状态自适应，不依赖队列顺序。
	const responses: FauxResponseStep[] = Array.from({ length: 32 }, () => factory);
	faux.setResponses(responses);

	return {
		model: faux.getModel() as Model<any>,
		streamFn: models.streamSimple.bind(models) as StreamFn,
		mode: "simulated",
	};
}
