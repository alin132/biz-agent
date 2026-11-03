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
import type { WorkflowDef } from "../src/core/types.js";
import type { WorkflowEngine } from "../src/core/workflow.js";

/** 每个工具在演示时使用的参数。 */
const DEMO_ARGS: Record<string, Record<string, unknown>> = {
	ticket_search: { keyword: "支付" },
	ticket_assign: { ticketId: "TK-1001", assignee: "李工" },
	ticket_update_status: { ticketId: "TK-1001", status: "processing" },
	ticket_notify: { ticketId: "TK-1001", channel: "im", message: "工单已受理，由李工负责跟进" },

	data_describe: {},
	data_query: { status: "paid" },
	data_aggregate: { groupBy: "region", metric: "sum_amount" },
	report_save: {
		title: "区域销售分析",
		content: "# 区域销售分析\n\n华南 ¥215,000 居首，华东 ¥204,000 次之，华北 ¥98,000。",
	},

	approval_check_rules: { type: "报销", amount: 3200 },
	approval_submit: { applicant: "张明", type: "报销", amount: 3200, reason: "客户拜访差旅" },
	approval_archive: { approvalId: "AP-1" },
};

/** 每个流程走完后的总结语（markdown，用于演示排版效果）。 */
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

export function createSimulatedRuntime(workflow: WorkflowDef, engine: WorkflowEngine): SimulatedRuntime {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);

	const factory: FauxResponseFactory = (context) => {
		const messages = context.messages;
		const last = messages[messages.length - 1];

		// 上一步工具失败或被阻断 → 改为说明原因，不要死循环重试。
		if (last?.role === "toolResult" && last.isError) {
			return fauxAssistantMessage("执行中断：上一步工具调用未成功，流程没有走完。右侧审计流水里有失败原因。");
		}

		if (engine.done) {
			return fauxAssistantMessage(DEMO_SUMMARY[workflow.id] ?? "流程已完成。");
		}

		const step = engine.currentStep;
		const tool = step?.via[0];
		if (!tool) {
			return fauxAssistantMessage("流程定义里没有可执行步骤。");
		}

		const args = (DEMO_ARGS[tool] ?? {}) as Parameters<typeof fauxToolCall>[1];
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
