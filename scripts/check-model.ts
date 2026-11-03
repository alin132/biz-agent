/**
 * 模型连通性检查：确认 .env 里的 key 真的能跑通。
 *
 * 跑法：npm run check-model
 *
 * 会发一次极短的请求，打印模型回复与耗时。失败会打印原因（通常是 key 无效或额度不足）。
 */

import { Agent } from "@earendil-works/pi-agent-core";
import { loadEnvFile } from "../server/env.js";
import { resolveLlm, supportedKeyEnvs } from "../server/llm.js";

loadEnvFile();

const llm = resolveLlm();
if (!llm) {
	console.error("✗ 未检测到任何 API key");
	console.error(`  请在 biz-agent/.env 里配置其中之一：${supportedKeyEnvs().join(" / ")}`);
	console.error("  或用 LLM_PROVIDER + LLM_MODEL + LLM_BASE_URL + LLM_API_KEY 自定义");
	process.exit(1);
}

console.log(`模型: ${llm.label}`);
console.log(`provider: ${llm.provider}   model: ${llm.modelId}`);
console.log("发起测试请求…");

const agent = new Agent({
	initialState: {
		systemPrompt: "你是连通性测试助手，只回答用户要求的内容，不要多说。",
		model: llm.model,
	},
	streamFn: llm.streamFn,
});

const started = Date.now();

try {
	await agent.prompt("只回复两个字：可用");
	const elapsed = Date.now() - started;

	let text = "";
	for (let index = agent.state.messages.length - 1; index >= 0; index--) {
		const message = agent.state.messages[index];
		if (message?.role === "assistant") {
			text = message.content
				.filter((block) => block.type === "text")
				.map((block) => (block as { text: string }).text)
				.join("");
			break;
		}
	}

	if (text.trim().length === 0) {
		console.error(`✗ 请求结束但没有文本回复（${elapsed}ms），检查模型是否支持该接口`);
		process.exit(1);
	}

	console.log(`✓ 模型可用，耗时 ${elapsed}ms`);
	console.log(`  回复: ${text.trim().slice(0, 120)}`);
} catch (error) {
	console.error(`✗ 请求失败: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
}
