/**
 * 自检：验证三个 demo 覆盖不到的边界能力。
 *
 * 跑法：npm run verify
 *
 * 覆盖：
 *   1. 工具结果超长截断（afterToolCall）
 *   2. 上下文滑动窗口压缩（transformContext）
 *   3. 流程状态机推进规则
 *   4. 注册表拒绝未注册工具
 *   5. 权限钩子阻断越权工具、审批结果复用
 */

import assert from "node:assert/strict";
import type { AfterToolCallContext, AgentMessage, BeforeToolCallContext } from "@earendil-works/pi-agent-core";
import { createAuditHook, MAX_RESULT_CHARS } from "../src/core/audit.js";
import { createContextTransformer } from "../src/core/context.js";
import { createPermissionHook } from "../src/core/permission.js";
import { ToolRegistry } from "../src/core/registry.js";
import { WorkflowEngine } from "../src/core/workflow.js";
import type { AuditEntry, BizContext } from "../src/core/types.js";
import { createTicketTools } from "../src/tools/ticket.js";
import { createStore } from "../src/store/memory.js";
import { ticketWorkflow } from "../src/workflows/ticket.js";

let passed = 0;

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
	await fn();
	passed++;
	console.log(`  ✓ ${name}`);
}

function baseCtx(overrides: Partial<BizContext> = {}): BizContext {
	return {
		tenantId: "tenant-test",
		userId: "u-test",
		traceId: "trace-test",
		allow: ["*"],
		requireApproval: [],
		...overrides,
	};
}

function asAfter(ctx: {
	toolCallName: string;
	result: { content: { type: "text"; text: string }[]; details: undefined };
	isError: boolean;
}): AfterToolCallContext {
	return {
		assistantMessage: {},
		toolCall: { type: "toolCall", id: "c1", name: ctx.toolCallName, arguments: {} },
		args: {},
		result: ctx.result,
		isError: ctx.isError,
		context: { messages: [] },
	} as unknown as AfterToolCallContext;
}

function asBefore(toolName: string, id: string): BeforeToolCallContext {
	return {
		assistantMessage: {},
		toolCall: { type: "toolCall", id, name: toolName, arguments: {} },
		args: {},
		context: { messages: [] },
	} as unknown as BeforeToolCallContext;
}

// ---------- 1. 工具结果截断 ----------
{
	const entries: AuditEntry[] = [];
	const hook = createAuditHook(baseCtx({ audit: (entry) => entries.push(entry) }));
	const huge = "字".repeat(MAX_RESULT_CHARS * 3);

	const overridden = await hook(
		asAfter({ toolCallName: "big_tool", result: { content: [{ type: "text", text: huge }], details: undefined }, isError: false }),
	);
	const text = (overridden?.content?.[0] as { text: string }).text;

	await check("超长工具结果被截断并带标记", () => {
		assert.ok(text.length < huge.length, "结果应被截断");
		assert.ok(text.includes("结果已截断"), "应带截断标记");
		assert.ok(text.startsWith("字".repeat(10)), "应保留开头内容");
	});

	await check("审计记录标记截断与原始长度", () => {
		assert.equal(entries.length, 1);
		assert.equal(entries[0]!.truncated, true);
		assert.equal(entries[0]!.outputChars, huge.length);
		assert.equal(entries[0]!.ok, true);
	});
}

// ---------- 2. 上下文滑动窗口 ----------
{
	const transformer = createContextTransformer({ maxMessages: 4 });
	const messages: AgentMessage[] = [
		{ role: "system", content: "sys", timestamp: 0 },
		...Array.from(
			{ length: 10 },
			(_, index) => ({ role: "user", content: `m${index}`, timestamp: index + 1 }) as AgentMessage,
		),
	];

	const out = await transformer(messages);

	await check("保留 system + 最近 N 条 + 一条压缩提示", () => {
		assert.equal(out[0]!.role, "system");
		assert.equal(out.length, 1 + 1 + 4);
		assert.equal(out[1]!.role, "system");
		assert.ok(String(out[1]!.content).includes("已省略 6 条"));
	});

	await check("窗口内消息顺序保持原样", () => {
		assert.deepEqual(
			out.slice(2).map((message) => String(message.content)),
			["m6", "m7", "m8", "m9"],
		);
	});

	await check("未超限时原样返回（不复制）", async () => {
		const small: AgentMessage[] = [{ role: "user", content: "only", timestamp: 1 }];
		assert.equal(await transformer(small), small);
	});
}

// ---------- 3. 流程状态机 ----------
{
	const engine = new WorkflowEngine(ticketWorkflow);

	await check("初始未完成", () => {
		assert.equal(engine.done, false);
		assert.equal(engine.state.stepIndex, 0);
	});

	await check("只有命中步骤声明的工具才推进", () => {
		engine.recordToolResult("unrelated_tool", true);
		assert.equal(engine.state.stepIndex, 0, "无关工具不应推进");
		engine.recordToolResult("ticket_search", true);
		assert.equal(engine.state.stepIndex, 1);
	});

	await check("失败的工具调用不推进步骤", () => {
		engine.recordToolResult("ticket_assign", false);
		assert.equal(engine.state.stepIndex, 1, "失败不应推进");
	});

	await check("走完全部步骤后 done 为 true", () => {
		engine.recordToolResult("ticket_assign", true);
		engine.recordToolResult("ticket_update_status", true);
		engine.recordToolResult("ticket_notify", true);
		assert.equal(engine.done, true);
		assert.deepEqual(engine.state.completed, ["search", "assign", "update", "notify"]);
		assert.ok(engine.nextPrompt().includes("已完成"));
	});
}

// ---------- 4. 注册表 ----------
{
	const registry = new ToolRegistry().registerAll(createTicketTools(createStore()));

	await check("注册后可按名字取到工具", () => {
		assert.equal(registry.has("ticket_search"), true);
		assert.equal(registry.all().length, 4);
	});

	await check("引用未注册工具时立即抛错", () => {
		assert.throws(() => registry.select(["ghost_tool"]), /未注册的工具/);
	});

	await check("重复注册同一个工具会抛错", () => {
		assert.throws(() => registry.register(registry.all()[0]!), /重复注册/);
	});
}

// ---------- 5. 权限钩子 ----------
{
	const registry = new ToolRegistry().registerAll(createTicketTools(createStore()));

	const denied = createPermissionHook(baseCtx({ allow: ["ticket_search"] }), registry);
	const blocked = await denied(asBefore("ticket_assign", "c1"));

	await check("越权工具被阻断", () => {
		assert.equal(blocked?.block, true);
		assert.ok(blocked?.reason?.includes("无权调用"));
	});

	const allowed = createPermissionHook(baseCtx({ allow: ["*"] }), registry);
	await check("白名单内工具直接放行", async () => {
		assert.equal(await allowed(asBefore("ticket_search", "c2")), undefined);
	});

	let asked = 0;
	const approvalHook = createPermissionHook(
		baseCtx({
			requireApproval: ["ticket_search"],
			requestApproval: async () => {
				asked++;
				return true;
			},
		}),
		registry,
	);
	await approvalHook(asBefore("ticket_search", "c3"));
	await approvalHook(asBefore("ticket_search", "c4"));

	await check("同会话同一工具只确认一次", () => {
		assert.equal(asked, 1, "不应重复询问");
	});
}

console.log(`\n全部通过：${passed} 项检查`);
