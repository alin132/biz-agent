/**
 * 切片 C：审批流 demo。
 *
 * 跑法：npm run demo:approval
 *
 * 这是三个切片里最能说明"为什么要在 Pi 之上加权限层"的例子：
 * 同一个流程、同一批工具，只换 requestApproval 的返回值，结果完全不同——
 * 拒绝时 approval_submit 被 beforeToolCall 阻断，流程卡在第二步，审批单不落库；
 * 放行时流程完整走完并归档。
 */

import { createBusinessAgent } from "../src/core/runtime.js";
import { ToolRegistry } from "../src/core/registry.js";
import { createStore } from "../src/store/memory.js";
import { createApprovalTools } from "../src/tools/approval.js";
import { approvalWorkflow } from "../src/workflows/approval.js";
import type { BizContext } from "../src/core/types.js";
import type { FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import { callTool, createCtx, createFauxRuntime, lastAssistantText, say, section, title } from "./harness.js";

function buildAgent(steps: FauxResponseStep[], ctx: BizContext, maxTurns: number) {
	const store = createStore();
	const registry = new ToolRegistry().registerAll(createApprovalTools(store));
	const runtime = createFauxRuntime(steps);

	const built = createBusinessAgent({
		workflow: approvalWorkflow,
		registry,
		ctx,
		model: runtime.model,
		streamFn: runtime.streamFn,
		maxTurns,
	});

	return { ...built, store };
}

function report(built: ReturnType<typeof buildAgent>): void {
	const { agent, engine, store } = built;

	section("模型最终回复");
	console.log(lastAssistantText(agent) || "（无回复）");

	section("流程状态");
	console.log(`已完成步骤：${engine.state.completed.join(" → ") || "（无）"}`);
	console.log(`完成度：${engine.state.stepIndex}/${approvalWorkflow.steps.length}`);
	console.log(
		`工具调用序列：${engine.state.calls.map((call) => `${call.name}${call.ok ? "" : "(被阻断)"}`).join(" → ")}`,
	);

	section("落库的审批单");
	console.log(store.approvals.length === 0 ? "（没有审批单落库——提交被拦下了）" : JSON.stringify(store.approvals, null, 2));
}

// ---------- 场景 1：审批被拒 ----------
{
	const ctx = createCtx({
		requestApproval: async (request) => {
			console.log(`[审批] 收到请求：${request.toolName} ${JSON.stringify(request.args)}（风险 ${request.risk}）`);
			console.log("[审批] 审批人拒绝");
			return false;
		},
	});

	const built = buildAgent(
		[
			callTool("approval_check_rules", { type: "报销", amount: 3200 }),
			callTool("approval_submit", { applicant: "张明", type: "报销", amount: 3200, reason: "客户拜访差旅" }),
			// 提交被阻断后，模型转而向用户说明失败原因
			say("审批未完成：提交操作需要人工审批，审批人已拒绝，因此审批单没有落库。请补充材料后重新提交。"),
		],
		ctx,
		3,
	);

	title("切片 C：审批流（场景 1 —— 人工审批被拒）");
	await built.agent.prompt("帮张明提交一笔 3200 元的报销，客户拜访差旅费");
	report(built);
}

// ---------- 场景 2：审批通过 ----------
{
	const ctx = createCtx({
		requestApproval: async (request) => {
			console.log(`[审批] 收到请求：${request.toolName} ${JSON.stringify(request.args)}（风险 ${request.risk}）`);
			console.log("[审批] 审批人同意");
			return true;
		},
	});

	const built = buildAgent(
		[
			callTool("approval_check_rules", { type: "报销", amount: 3200 }),
			callTool("approval_submit", { applicant: "张明", type: "报销", amount: 3200, reason: "客户拜访差旅" }),
			callTool("approval_archive", { approvalId: "AP-1" }),
			say("审批流程已完成：报销 ¥3,200 符合自动审批规则，单据 AP-1 已归档。"),
		],
		ctx,
		20,
	);

	title("切片 C：审批流（场景 2 —— 人工审批通过）");
	await built.agent.prompt("帮张明提交一笔 3200 元的报销，客户拜访差旅费");
	report(built);
}
