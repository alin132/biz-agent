/**
 * 接真实模型的示例（DeepSeek）。
 *
 * 跑法：
 *   Windows:  $env:DEEPSEEK_API_KEY="sk-..."; npm run demo:real
 *   bash:     DEEPSEEK_API_KEY=sk-... npm run demo:real
 *
 * 和 faux demo 的唯一区别就是 model / streamFn 的来源：
 *   faux:  fauxProvider() + 脚本化响应
 *   真实:  builtinModels() + 环境变量里的 API key
 *
 * 其余代码（流程、工具、权限、审计）完全不动——这正是把模型层抽出去的价值。
 */

import type { StreamFn } from "@earendil-works/pi-agent-core";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { createBusinessAgent } from "../src/core/runtime.js";
import { ToolRegistry } from "../src/core/registry.js";
import { createStore } from "../src/store/memory.js";
import { createTicketTools } from "../src/tools/ticket.js";
import { ticketWorkflow } from "../src/workflows/ticket.js";
import { createCtx, lastAssistantText, section, title } from "./harness.js";

if (!process.env.DEEPSEEK_API_KEY) {
	console.error("缺少 DEEPSEEK_API_KEY 环境变量。");
	process.exit(1);
}

const models = builtinModels();
const model = models.getModel("deepseek", "deepseek-v4-pro");
if (!model) {
	throw new Error("找不到 deepseek-v4-pro 模型");
}
const streamFn = models.streamSimple.bind(models) as StreamFn;

const store = createStore();
const registry = new ToolRegistry().registerAll(createTicketTools(store));
const ctx = createCtx();

const { agent, engine } = createBusinessAgent({
	workflow: ticketWorkflow,
	registry,
	ctx,
	model,
	streamFn,
});

title("真实模型：工单流转（DeepSeek V4 Pro）");
await agent.prompt("帮我把「支付回调偶发超时」这条工单处理掉，记得通知客户。");

section("模型最终回复");
console.log(lastAssistantText(agent));

section("流程执行情况");
console.log(`已完成步骤：${engine.state.completed.join(" → ") || "（无）"}`);
console.log(`完成度：${engine.state.stepIndex}/${ticketWorkflow.steps.length}`);
console.log(`工具调用序列：${engine.state.calls.map((call) => `${call.name}${call.ok ? "" : "(失败)"}`).join(" → ")}`);

section("工单最终数据");
console.log(JSON.stringify(store.tickets.find((ticket) => ticket.title.includes("支付回调")), null, 2));
