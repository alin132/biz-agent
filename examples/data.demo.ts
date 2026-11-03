/**
 * 切片 B：数据查询分析 demo。
 *
 * 跑法：npm run demo:data
 *
 * 演示"自然语言问数"：模型自己决定探查结构、查明细、做聚合，最后落一份报告。
 */

import { createBusinessAgent } from "../src/core/runtime.js";
import { ToolRegistry } from "../src/core/registry.js";
import { createStore } from "../src/store/memory.js";
import { createDataTools } from "../src/tools/data.js";
import { dataWorkflow } from "../src/workflows/data.js";
import { callTool, createCtx, createFauxRuntime, lastAssistantText, say, section, title } from "./harness.js";

const store = createStore();
const registry = new ToolRegistry().registerAll(createDataTools(store));
const ctx = createCtx();

const report = [
	"# 2026 Q4 销售区域分析",
	"",
	"结论：华东贡献最高，华北有 1 单待回款拖累统计口径。",
	"",
	"| 区域 | 已回款金额 |",
	"| --- | --- |",
	"| 华东 | ¥204,000 |",
	"| 华南 | ¥215,000 |",
	"| 华北 | ¥98,000 |",
].join("\n");

const runtime = createFauxRuntime([
	callTool("data_describe", {}),
	callTool("data_query", { status: "paid" }),
	callTool("data_aggregate", { groupBy: "region", metric: "sum_amount" }),
	callTool("report_save", { title: "2026 Q4 销售区域分析", content: report }),
	say("分析完成：已回款订单共 4 单。华南以 ¥215,000 居首，华东 ¥204,000 次之，华北 ¥98,000。报告已保存为《2026 Q4 销售区域分析》。"),
]);

const { agent, engine } = createBusinessAgent({
	workflow: dataWorkflow,
	registry,
	ctx,
	model: runtime.model,
	streamFn: runtime.streamFn,
});

title("切片 B：数据查询分析");
console.log(`流程：${dataWorkflow.name}`);
console.log("用户输入：帮我看看各区域已回款的销售情况，出一份报告");

await agent.prompt("帮我看看各区域已回款的销售情况，出一份报告");

section("模型最终回复");
console.log(lastAssistantText(agent));

section("流程状态");
console.log(`已完成步骤：${engine.state.completed.join(" → ")}`);
console.log(`完成度：${engine.state.stepIndex}/${dataWorkflow.steps.length}`);
console.log(`工具调用序列：${engine.state.calls.map((call) => `${call.name}${call.ok ? "" : "(失败)"}`).join(" → ")}`);

section("已保存报告");
for (const item of store.reports) {
	console.log(`${item.id} ${item.title}（${item.content.length} 字）`);
	console.log(item.content);
}
