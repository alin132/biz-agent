/**
 * 切片 A：工单流转 demo。
 *
 * 跑法：npm run demo:ticket
 *
 * 演示一条完整链路：模型依次调用 4 个工具，流程状态机逐步推进，
 * 权限/审计钩子在每次工具调用时生效。
 */

import { createBusinessAgent } from "../src/core/runtime.js";
import { ToolRegistry } from "../src/core/registry.js";
import { createStore } from "../src/store/memory.js";
import { createTicketTools } from "../src/tools/ticket.js";
import { ticketWorkflow } from "../src/workflows/ticket.js";
import { callTool, createCtx, createFauxRuntime, lastAssistantText, say, section, title } from "./harness.js";

const store = createStore();
const registry = new ToolRegistry().registerAll(createTicketTools(store));
const ctx = createCtx();

const runtime = createFauxRuntime([
	callTool("ticket_search", { keyword: "支付" }),
	callTool("ticket_assign", { ticketId: "TK-1001", assignee: "李工" }),
	callTool("ticket_update_status", { ticketId: "TK-1001", status: "processing" }),
	callTool("ticket_notify", {
		ticketId: "TK-1001",
		channel: "im",
		message: "工单已受理，由李工负责跟进，预计 2 小时内给方案",
	}),
	say("工单 TK-1001「支付回调偶发超时」已处理完毕：已指派给李工，状态置为 processing，并已通过 IM 通知客户云图科技。"),
]);

const { agent, engine } = createBusinessAgent({
	workflow: ticketWorkflow,
	registry,
	ctx,
	model: runtime.model,
	streamFn: runtime.streamFn,
});

title("切片 A：工单流转");
console.log(`流程：${ticketWorkflow.name}`);
console.log("用户输入：支付回调超时的工单帮我处理一下");

await agent.prompt("支付回调超时的工单帮我处理一下");

section("模型最终回复");
console.log(lastAssistantText(agent));

section("流程状态");
console.log(`已完成步骤：${engine.state.completed.join(" → ")}`);
console.log(`完成度：${engine.state.stepIndex}/${ticketWorkflow.steps.length}`);
console.log(`工具调用序列：${engine.state.calls.map((call) => `${call.name}${call.ok ? "" : "(失败)"}`).join(" → ")}`);

section("工单最终数据");
console.log(JSON.stringify(store.tickets[0], null, 2));

section("通知流水");
console.log(JSON.stringify(store.notifications, null, 2));
