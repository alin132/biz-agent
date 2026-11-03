/**
 * 真实模型对话检查：发一条指令，把 agent 的完整决策过程打出来。
 *
 * 跑法：
 *   npm run live-check                        # 默认指令
 *   npm run live-check -- 把 TK-1003 处理掉
 *   npm run live-check -- --flow data-flow 看看华南的销售情况
 *
 * 用途：区分"模型真的在推理"和"按脚本演"。
 * 脚本模型只会固定查「支付」并处理 TK-1001；真实模型会按你说的工单号去查。
 */

const BASE = process.env.SMOKE_BASE ?? "http://127.0.0.1:4317";

interface Wire {
	type: string;
	[key: string]: unknown;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	let flowId = "ticket-flow";
	const messageParts: string[] = [];

	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index]!;
		if (arg === "--flow") {
			flowId = argv[++index] ?? "ticket-flow";
		} else {
			messageParts.push(arg);
		}
	}
	const message = messageParts.join(" ") || "把支付回调超时的工单处理掉，并通知客户";

	console.log(`流程: ${flowId}`);
	console.log(`指令: ${message}`);
	console.log("-".repeat(72));

	const created = (await (
		await fetch(`${BASE}/api/sessions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ workflowId: flowId }),
		})
	).json()) as { id: string; mode: string; modeLabel: string };

	if (created.mode !== "live") {
		console.log(`⚠ 当前仍是模拟模型（${created.modeLabel}），结果不代表真实推理`);
	}
	console.log(`模型: ${created.modeLabel}`);
	console.log("-".repeat(72));

	// 事件收集
	const events: Wire[] = [];
	const stream = await fetch(`${BASE}/api/sessions/${created.id}/events`);
	const reader = stream.body?.getReader();
	if (!reader) throw new Error("SSE 无响应体");

	void (async () => {
		const decoder = new TextDecoder();
		let buffer = "";
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let at = buffer.indexOf("\n\n");
			while (at >= 0) {
				const chunk = buffer.slice(0, at);
				buffer = buffer.slice(at + 2);
				for (const line of chunk.split("\n")) {
					if (!line.startsWith("data: ")) continue;
					try {
						events.push(JSON.parse(line.slice(6)) as Wire);
					} catch {
						// 忽略非 JSON 行
					}
				}
				at = buffer.indexOf("\n\n");
			}
		}
	})();

	const waitFor = async (predicate: (event: Wire) => boolean, timeoutMs: number): Promise<Wire | null> => {
		const started = Date.now();
		while (Date.now() - started < timeoutMs) {
			const hit = events.find(predicate);
			if (hit) return hit;
			await sleep(80);
		}
		return null;
	};

	// 等 SSE 就绪再发消息，避免丢早期事件
	if (!(await waitFor((event) => event.type === "ready", 5000))) {
		throw new Error("SSE 未就绪");
	}

	await fetch(`${BASE}/api/sessions/${created.id}/messages`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ text: message }),
	});

	// 边等边打日志
	let printed = 0;
	const flushLog = () => {
		while (printed < events.length) {
			const event = events[printed++]!;
			if (event.type === "tool_start") {
				console.log(`▶ ${String(event.name)}  ${JSON.stringify(event.args ?? {})}`);
			} else if (event.type === "tool_end") {
				const prefix = event.ok ? "  ← 成功" : "  ← 失败";
				console.log(`${prefix}  ${String(event.result ?? "").slice(0, 160)}`);
			} else if (event.type === "approval") {
				console.log(`⚠ 需要审批: ${String(event.toolName)}`);
			} else if (event.type === "error") {
				console.log(`✗ 错误: ${String(event.message)}`);
			}
		}
	};

	const started = Date.now();
	let done = false;
	while (Date.now() - started < 180000) {
		flushLog();
		if (events.some((event) => event.type === "done")) {
			done = true;
			break;
		}
		await sleep(150);
	}
	flushLog();

	if (!done) {
		console.log("✗ 等待超时（180 秒）");
		process.exit(1);
	}

	const doneEvent = events.find((event) => event.type === "done");
	const finalSnapshot = (await (await fetch(`${BASE}/api/sessions/${created.id}`)).json()) as {
		steps: { title: string; status: string }[];
		audit: { toolName: string; ok: boolean }[];
	};

	console.log("-".repeat(72));
	console.log("最终回复:");
	console.log(String(doneEvent?.text ?? "").trim() || "（无）");
	console.log("-".repeat(72));
	console.log(`流程: ${finalSnapshot.steps.map((step) => `${step.title}[${step.status}]`).join(" → ")}`);
	console.log(
		`审计: ${finalSnapshot.audit.map((entry) => `${entry.toolName}${entry.ok ? "" : "(失败)"}`).join(" → ")}`,
	);
	process.exit(0);
}

main().catch((error: unknown) => {
	console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
