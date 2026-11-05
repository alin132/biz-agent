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
 *   6. 流程注册：流程自带工具装配、id 唯一、新增流程无需改 server
 *   7. 工具目录：自定义流程只能按名字挑内置工具，未知名立即抛错
 *   8. 自定义流程定义校验（长度/步骤/via/重名/部分更新），错误文案可直接上界面
 *   9. 流程即工具：flow_<id> 命名规则、与业务工具名不冲突
 *  10. 流程即工具的执行内核：子流程整条跑完，且与父会话共用审计/审批/业务数据
 *  11. 技能：流程 → 技能派生（正文/工具集）、渐进式披露的技能目录、use_skill 参数、
 *      激活技能后工具集与状态机切换、退出后恢复原流程进度
 */

import assert from "node:assert/strict";
import type { AfterToolCallContext, AgentMessage, BeforeToolCallContext } from "@earendil-works/pi-agent-core";
import { createAuditHook, MAX_RESULT_CHARS } from "../src/core/audit.js";
import { createToolCatalog } from "../src/core/catalog.js";
import { createContextTransformer } from "../src/core/context.js";
import {
	FLOW_TOOL_PREFIX,
	flowToolDescription,
	flowToolName,
	flowToolParameters,
	isFlowToolName,
} from "../src/core/flowTools.js";
import { createPermissionHook } from "../src/core/permission.js";
import { ToolRegistry } from "../src/core/registry.js";
import { createBusinessAgent } from "../src/core/runtime.js";
import { SKILL_TOOL_NAME, skillCatalogPrompt, skillFromWorkflow, skillToolParameters } from "../src/core/skill.js";
import { WorkflowEngine } from "../src/core/workflow.js";
import { mergeWorkflowInput, validateWorkflowInput, WORKFLOW_LIMITS, WorkflowSpecError } from "../src/core/workflowSpec.js";
import type { WorkflowInput } from "../src/core/workflowSpec.js";
import { runSubWorkflow } from "../src/core/subFlow.js";
import type { AuditEntry, BizContext, WorkflowDef } from "../src/core/types.js";
import { createTicketTools } from "../src/tools/ticket.js";
import { createStore } from "../src/store/memory.js";
import { approvalWorkflow } from "../src/workflows/approval.js";
import { ticketWorkflow } from "../src/workflows/ticket.js";
import { builtinToolFactories, indexWorkflows, workflowList } from "../src/workflows/index.js";
import { callTool, createFauxRuntime, say } from "../examples/harness.js";

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

// ---------- 3b. 流程状态机：模型半路去调别的流程 ----------
// 场景：会话开在「工单处理」上，用户问的却是一句数据分析，模型直接调 flow_data_flow。
// 这时候还催"第 1 步：查询工单"，模型只会挤出一句"好的"——必须放它按结果收尾。
{
	const offTrack = new WorkflowEngine(ticketWorkflow);

	await check("别的流程工具（flow_xxx）不推进本流程，但会被记为跑偏", () => {
		offTrack.recordToolResult("flow_data_flow", true);
		assert.equal(offTrack.done, false, "别的流程不该推进本流程步骤");
		assert.equal(offTrack.state.stepIndex, 0);
		assert.equal(offTrack.lastCallOffTrack, true);
	});

	await check("跑偏后不再催第 1 步，而是要求把结果整理成回答", () => {
		const prompt = offTrack.nextPrompt();
		assert.ok(prompt.includes("整理"), "应提示把结果整理成回答");
		assert.ok(!prompt.includes("第 1/"), "不应再催第一步");
		assert.ok(!prompt.includes("ticket_search"), "不应点名本流程的步骤工具");
	});

	await check("本流程自己的步骤工具不算跑偏，仍然按步骤提示", () => {
		offTrack.recordToolResult("ticket_search", true);
		assert.equal(offTrack.lastCallOffTrack, false);
		assert.ok(offTrack.nextPrompt().includes("第 2/4 步"));
	});

	await check("步骤工具重复调用（没推进）也不算跑偏", () => {
		const repeat = new WorkflowEngine(ticketWorkflow);
		repeat.recordToolResult("ticket_search", true);
		repeat.recordToolResult("ticket_search", true);
		assert.equal(repeat.lastCallOffTrack, false, "同一步骤工具重复调用不属于跑偏");
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

// ---------- 6. 流程注册与工具自动装配 ----------
{
	await check("每个流程的步骤工具都由自己的 createTools 提供", () => {
		for (const workflow of workflowList) {
			const names = new Set(workflow.createTools(createStore()).map((tool) => tool.name));
			for (const step of workflow.steps) {
				for (const tool of step.via) {
					assert.ok(names.has(tool), `${workflow.id} 的步骤 ${step.id} 引用了自己没装配的工具 ${tool}`);
				}
			}
		}
	});

	await check("有必填参数的工具都带演示参数（模拟模型靠它演流程）", () => {
		for (const workflow of workflowList) {
			for (const tool of workflow.createTools(createStore())) {
				const required = (tool.parameters as { required?: string[] }).required ?? [];
				if (required.length > 0) {
					assert.ok(tool.example, `${workflow.id} 的工具 ${tool.name} 缺少 example`);
				}
			}
		}
	});

	await check("流程 id 重复时立即抛错", () => {
		const duplicated: WorkflowDef = { ...ticketWorkflow, name: "重复的工单流程" };
		assert.throws(() => indexWorkflows([ticketWorkflow, duplicated]), /流程 id 重复/);
	});

	await check("新增流程只进列表即可，无需改 server 层", () => {
		// 一个从零写的流程：自带工具，不碰任何既有文件即可被索引、装配、推进
		const scratch: WorkflowDef = {
			id: "scratch-flow",
			name: "临时演示流程",
			systemPrompt: "测试用流程",
			createTools: () => [
				{
					name: "scratch_ping",
					description: "测试工具",
					category: "测试",
					risk: "low",
					parameters: { type: "object", properties: {}, required: [] },
					execute: async () => ({ content: "pong" }),
				},
			],
			steps: [{ id: "ping", title: "ping", via: ["scratch_ping"], hint: "调用 scratch_ping" }],
		};

		const index = indexWorkflows([...workflowList, scratch]);
		assert.equal(Object.keys(index).length, workflowList.length + 1);
		assert.equal(index["scratch-flow"]?.name, "临时演示流程");

		const registry = new ToolRegistry().registerAll(scratch.createTools(createStore()));
		registry.select(scratch.steps[0]!.via);
		const engine = new WorkflowEngine(scratch);
		engine.recordToolResult("scratch_ping", true);
		assert.equal(engine.done, true);
	});
}

// ---------- 7. 工具目录：自定义流程只能按名字挑内置工具 ----------
{
	const catalog = createToolCatalog(builtinToolFactories);

	await check("工具目录聚合了三个切片的全部业务工具", () => {
		const names = catalog.names(createStore());
		for (const expected of ["ticket_search", "data_query", "approval_submit"]) {
			assert.ok(names.includes(expected), `目录里缺少 ${expected}`);
		}
		assert.equal(new Set(names).size, names.length, "目录里不应有重名工具");
	});

	await check("按名字挑工具保持顺序，未知工具名立即抛错", () => {
		const store = createStore();
		const picked = catalog.pick(store, ["ticket_notify", "ticket_search"]);
		assert.deepEqual(
			picked.map((tool) => tool.name),
			["ticket_notify", "ticket_search"],
		);
		assert.throws(() => catalog.pick(store, ["no_such_tool"]), /不存在的工具: no_such_tool/);
	});

	await check("概要信息够控制台挑工具（名称/分类/风险/有无演示参数）", () => {
		const summaries = catalog.summaries(createStore());
		const search = summaries.find((item) => item.name === "ticket_search");
		assert.ok(search, "应能取到 ticket_search 的概要");
		assert.equal(search?.category, "工单");
		assert.equal(search?.risk, "low");
		assert.equal(search?.hasExample, true, "有演示参数才能在模拟模型下演完流程");
	});
}

// ---------- 8. 自定义流程定义校验（纯函数，server 与前端共用） ----------
{
	const store = createStore();
	const knownTools = createToolCatalog(builtinToolFactories).names(store);
	const legalSteps = [
		{ title: "查询工单", via: ["ticket_search"], hint: "先定位目标工单" },
		{ title: "通知客户", via: ["ticket_notify"] },
	];

	await check("合法自定义流程通过校验并补齐 step id 与 hint", () => {
		const input = validateWorkflowInput(
			{ name: "  我的工单流程  ", systemPrompt: "你是工单处理助手", steps: legalSteps },
			{ knownTools },
		);
		assert.equal(input.name, "我的工单流程", "名称应去掉首尾空白");
		assert.deepEqual(
			input.steps.map((step) => step.id),
			["step-1", "step-2"],
		);
		assert.equal(input.steps[0]?.hint, "先定位目标工单");
		assert.equal(input.steps[1]?.hint, "", "没给 hint 时补空串，WorkflowStep.hint 是必填");
	});

	await check("非法流程定义被拒绝，错误文案可直接展示给用户", () => {
		const base = { name: "合法名字", systemPrompt: "系统提示", steps: legalSteps };
		assert.throws(() => validateWorkflowInput({ ...base, name: "" }, { knownTools }), /流程名称.*不能为空/);
		assert.throws(
			() => validateWorkflowInput({ ...base, name: "长".repeat(WORKFLOW_LIMITS.name + 1) }, { knownTools }),
			new RegExp(`流程名称\\s*最多\\s*${WORKFLOW_LIMITS.name}\\s*个字符`),
		);
		assert.throws(() => validateWorkflowInput({ ...base, systemPrompt: "" }, { knownTools }), /系统提示.*不能为空/);
		// 零步骤是合法形态（技能只写指导书，工具交给模型挑），不再报错
		assert.deepEqual(validateWorkflowInput({ ...base, steps: [] }, { knownTools }).steps, []);
		assert.throws(
			() => validateWorkflowInput({ ...base, steps: [{ title: "查询", via: [] }] }, { knownTools }),
			/第 1 步至少要选一个工具/,
		);
		assert.throws(
			() => validateWorkflowInput({ ...base, steps: [{ title: "查询", via: ["no_such_tool"] }] }, { knownTools }),
			/第 1 步引用了不存在的工具: no_such_tool/,
		);
	});

	await check("流程名称重复被拒绝，改流程时可排除自身", () => {
		const base = { name: "已存在的流程", systemPrompt: "系统提示", steps: legalSteps };
		assert.throws(() => validateWorkflowInput(base, { knownTools, takenNames: ["已存在的流程"] }), /流程名称已存在/);
		assert.doesNotThrow(() => validateWorkflowInput(base, { knownTools, takenNames: ["别的流程"] }));
	});

	await check("via 里重复的工具名会被合并，顺序不变", () => {
		const input = validateWorkflowInput(
			{ name: "去重演示", systemPrompt: "系统提示", steps: [{ title: "查询", via: ["ticket_search", "ticket_search"] }] },
			{ knownTools },
		);
		assert.deepEqual(input.steps[0]?.via, ["ticket_search"]);
	});

	await check("PATCH 只校验传了的字段，其余沿用旧值", () => {
		const current = validateWorkflowInput(
			{ name: "旧名字", systemPrompt: "旧提示", steps: legalSteps },
			{ knownTools },
		);
		const patched = mergeWorkflowInput(current, { name: "新名字" }, { knownTools });
		assert.equal(patched.name, "新名字");
		assert.equal(patched.systemPrompt, "旧提示", "没传 systemPrompt 时应沿用旧值");
		assert.equal(patched.steps.length, 2);
		assert.deepEqual(mergeWorkflowInput(current, { steps: [] }, { knownTools }).steps, [], "PATCH 也能把步骤清空");
	});
}

// ---------- 9. 流程即工具：flow_<id> 命名规则 ----------
{
	await check("流程 id → 工具名：非法字符换成下划线且带 flow_ 前缀", () => {
		assert.equal(flowToolName("ticket-flow"), "flow_ticket_flow");
		assert.equal(flowToolName("data_flow"), "flow_data_flow");
		const weird = flowToolName("审批 流程/1");
		assert.ok(weird.startsWith(FLOW_TOOL_PREFIX));
		assert.match(weird.slice(FLOW_TOOL_PREFIX.length), /^[a-zA-Z0-9_]+$/, "工具名只允许字母数字下划线");
	});

	await check("isFlowToolName 只认 flow_ 前缀，业务工具不会被误判", () => {
		assert.equal(isFlowToolName(flowToolName("approval-flow")), true);
		assert.equal(isFlowToolName("ticket_search"), false);
		assert.equal(isFlowToolName(FLOW_TOOL_PREFIX), true);
	});

	await check("内置流程的流程工具名互不重复，也不与业务工具撞名", () => {
		const names = createToolCatalog(builtinToolFactories).names(createStore());
		const flowNames = workflowList.map((workflow) => flowToolName(workflow.id));
		assert.equal(new Set(flowNames).size, flowNames.length, "流程工具名不应重复");
		for (const name of flowNames) {
			assert.ok(!names.includes(name), `业务工具目录里不该出现流程工具名 ${name}`);
		}
		assert.ok(names.every((name) => !isFlowToolName(name)), "业务工具不应使用 flow_ 前缀");
	});

	await check("流程工具的参数与描述够模型自己挑流程", () => {
		const parameters = flowToolParameters() as { required?: string[] };
		assert.deepEqual(parameters.required, ["task"], "流程工具只需要一个自然语言任务参数");
		for (const workflow of workflowList) {
			const description = flowToolDescription(workflow);
			assert.ok(description.includes(workflow.name), `描述里应带流程名：${workflow.name}`);
			// 没有步骤的流程（自动编排）没法列步骤标题，只要求描述带上流程名
			const firstStep = workflow.steps[0];
			if (firstStep) {
				assert.ok(description.includes(firstStep.title), "描述里应带第一步标题，模型才知道该不该挑它");
			}
		}
	});

	await check("自动编排不预设步骤，但手上有整个工具目录", () => {
		const auto = workflowList.find((workflow) => workflow.id === "auto-flow");
		assert.ok(auto, "自动编排应作为内置流程存在");
		assert.equal(auto!.steps.length, 0, "自动编排不该有写死的步骤");
		const autoTools = auto!.createTools(createStore()).map((tool) => tool.name).sort();
		const catalogTools = createToolCatalog(builtinToolFactories).names(createStore()).sort();
		assert.deepEqual(autoTools, catalogTools, "自动编排应能调用工具目录里的全部工具");
		assert.ok(flowToolDescription(auto!).includes("自动编排"), "流程工具描述里要有它的名字");
	});
}

// ---------- 10. 流程即工具的执行内核：子流程 ----------
{
	const store = createStore();
	const audits: AuditEntry[] = [];
	let approvalAsked = 0;
	// faux 模型按队列演：校验 → 提交（高风险，触发审批）→ 归档 → 汇报
	const runtime = createFauxRuntime([
		callTool("approval_check_rules", { type: "报销", amount: 3200 }),
		callTool("approval_submit", { applicant: "张明", type: "报销", amount: 3200, reason: "客户拜访差旅" }),
		callTool("approval_archive", { approvalId: "AP-1" }),
		say("已按审批流程完成提交与归档。"),
	]);
	const ctx = baseCtx({
		audit: (entry) => audits.push(entry),
		requestApproval: async () => {
			approvalAsked++;
			return true;
		},
	});

	const result = await runSubWorkflow({
		workflow: approvalWorkflow,
		store,
		ctx,
		model: runtime.model,
		streamFn: runtime.streamFn,
		task: "帮张明提交一笔 3200 元的报销，客户拜访差旅费",
	});

	await check("子流程按目标流程的步骤整条跑完并返回汇报文本", () => {
		assert.equal(result.done, true, "内层流程应走完全部步骤");
		assert.deepEqual(result.engine.state.completed, ["check", "submit", "archive"]);
		assert.equal(result.text, "已按审批流程完成提交与归档。");
	});

	await check("子流程与父会话共用 ctx：审计 3 条、高风险审批 1 次、业务数据落库", () => {
		assert.deepEqual(
			audits.map((entry) => entry.toolName),
			["approval_check_rules", "approval_submit", "approval_archive"],
			"三次工具调用都应进同一条审计流水",
		);
		assert.equal(approvalAsked, 1, "高风险工具只应触发一次人工确认");
		assert.equal(store.approvals.find((item) => item.id === "AP-1")?.status, "archived", "归档状态应写回业务数据");
	});
}

// ---------- 11. 技能：流程 → 技能（渐进式披露） ----------
{
	const skills = workflowList.map(skillFromWorkflow);

	await check("四条内置流程都能派生成技能：文案非空、正文含每个步骤标题", () => {
		assert.equal(skills.length, 4, "内置流程都应派生出技能");
		for (const skill of skills) {
			assert.ok(skill.description.length > 0, `${skill.id} 应有技能描述`);
			assert.ok(skill.instructions.length > 0, `${skill.id} 应有技能正文`);
			for (const step of skill.steps) {
				assert.ok(skill.instructions.includes(step.title), `${skill.id} 的正文应含步骤标题「${step.title}」`);
			}
		}
	});

	await check("技能工具集 = 步骤 via 去重（顺序不变）", () => {
		const ticket = skills.find((skill) => skill.id === "ticket-flow");
		assert.deepEqual(ticket?.tools, ["ticket_search", "ticket_assign", "ticket_update_status", "ticket_notify"]);
		assert.equal(new Set(ticket?.tools).size, ticket?.tools.length, "同一工具不该重复声明");
		const duplicated = skillFromWorkflow({
			id: "dup-flow",
			name: "重复工具流程",
			systemPrompt: "系统提示",
			steps: [{ id: "step-1", title: "查询", via: ["ticket_search", "ticket_search"], hint: "" }],
			createTools: () => [],
		});
		assert.deepEqual(duplicated.tools, ["ticket_search"], "同一工具在多个步骤里出现只保留一份");
	});

	await check("自动编排（无步骤）的技能：正文说明不必按步骤、工具集为空", () => {
		const auto = skills.find((skill) => skill.id === "auto-flow");
		assert.ok(auto, "自动编排应能当技能用");
		assert.deepEqual(auto!.tools, [], "没有步骤 = 不声明工具，加载后沿用会话现有工具");
		assert.equal(auto!.steps.length, 0);
		assert.ok(auto!.instructions.includes("没有预设步骤"), "正文要说明这条技能没有写死的步骤");
	});

	await check("use_skill 的参数只暴露技能 id（enum）且必填", () => {
		const parameters = skillToolParameters(skills) as {
			properties: { skillId: { enum: string[] } };
			required: string[];
		};
		assert.deepEqual(parameters.required, ["skillId"]);
		assert.deepEqual(parameters.properties.skillId.enum, workflowList.map((workflow) => workflow.id));
	});

	await check("技能目录一条技能一行，只露 id/名称/描述，不泄漏正文", () => {
		assert.equal(skillCatalogPrompt([]), "", "没有技能时目录为空串");
		const catalog = skillCatalogPrompt(skills);
		const lines = catalog.split("\n").filter((line) => line.startsWith("- `"));
		assert.equal(lines.length, skills.length, "每条技能只占一行");
		for (const skill of skills) {
			const line = lines.find((item) => item.includes(`\`${skill.id}\``));
			assert.ok(line, `${skill.id} 应出现在技能目录里`);
			assert.ok(line!.includes(skill.name) && line!.includes(skill.description), `${skill.id} 那行应带名称与描述`);
			const bodyLine = skill.instructions.split("\n").find((item) => item.includes("技能工作"));
			assert.ok(bodyLine, `${skill.id} 的正文应说明"以某技能工作"`);
			assert.ok(!catalog.includes(bodyLine!), `${skill.id} 的正文不该进技能目录（渐进式披露）`);
		}
	});

	// 装配一个和会话层同构的 agent：全套工具进注册表，技能目录传进去，use_skill 永远保留
	const store = createStore();
	const registry = new ToolRegistry();
	for (const workflow of workflowList) {
		for (const tool of workflow.createTools(store)) {
			if (!registry.has(tool.name)) {
				registry.registerAll([tool]);
			}
		}
	}
	registry.registerAll([
		{
			name: SKILL_TOOL_NAME,
			description: "加载技能",
			category: "技能",
			risk: "low",
			parameters: { type: "object", properties: { skillId: { type: "string" } }, required: ["skillId"] },
			execute: async () => ({ content: "已加载技能" }),
		},
	]);
	// 会话层还会把其他流程的 flow_xxx 装成工具（委托执行入口），这里用桩代替，行为不影响断言
	for (const workflow of workflowList) {
		const name = flowToolName(workflow.id);
		if (!registry.has(name)) {
			registry.registerAll([
				{
					name,
					description: "流程工具",
					category: "流程",
					risk: "low",
					parameters: { type: "object", properties: { task: { type: "string" } }, required: ["task"] },
					execute: async () => ({ content: "已执行流程" }),
				},
			]);
		}
	}
	const runtime = createFauxRuntime([say("演示不用真的跑模型")]);
	const engine = new WorkflowEngine(ticketWorkflow);
	// 和会话层一样：初始 toolNames 已含 use_skill 与 flow_*，keepToolNames 只负责换技能时别丢
	const initialToolNames = [
		...new Set([...ticketWorkflow.steps.flatMap((step) => step.via), SKILL_TOOL_NAME, flowToolName("data-flow")]),
	];
	const built = createBusinessAgent({
		workflow: ticketWorkflow,
		registry,
		ctx: baseCtx(),
		model: runtime.model,
		streamFn: runtime.streamFn,
		engine,
		skills,
		toolNames: initialToolNames,
		keepToolNames: [SKILL_TOOL_NAME, flowToolName("data-flow")],
	});
	const originalTools = built.toolNames();

	await check("初始没有技能：跑的是会话原流程，工具集含 use_skill 与 flow_*", () => {
		assert.equal(built.activeSkill(), null);
		assert.equal(engine.definition.id, "ticket-flow");
		assert.deepEqual(
			[...built.toolNames()].sort(),
			[
				SKILL_TOOL_NAME,
				"flow_data_flow",
				"ticket_assign",
				"ticket_notify",
				"ticket_search",
				"ticket_update_status",
			].sort(),
			"工具集 = 本流程步骤工具 + 保留的 use_skill/flow_*",
		);
		assert.deepEqual(
			built.agent.state.tools.map((tool) => tool.name).sort(),
			[...built.toolNames()].sort(),
			"真正挂到 agent 上的工具与 toolNames() 一致",
		);
	});

	await check("激活 data-flow：换工具集 + 换状态机，但不重建 agent", () => {
		const before = built.agent;
		const skill = built.activateSkill("data-flow");
		assert.equal(skill.id, "data-flow");
		assert.equal(built.activeSkill()?.id, "data-flow");
		assert.equal(engine.definition.id, "data-flow", "状态机切到技能的流程");
		assert.equal(engine.currentStep?.title, "探查数据结构", "从技能第 1 步开始");
		assert.equal(engine.state.workflowId, "data-flow");
		for (const name of ["data_describe", "data_query", "data_aggregate", "report_save"]) {
			assert.ok(built.toolNames().includes(name), `技能工具 ${name} 应被装上`);
		}
		assert.ok(built.toolNames().includes(SKILL_TOOL_NAME), "加载器永远保留");
		assert.ok(built.toolNames().includes(flowToolName("data-flow")), "flow_* 委托入口永远保留");
		assert.ok(!built.toolNames().includes("ticket_search"), "原流程的工具不再暴露");
		assert.equal(built.agent, before, "换技能只改 state.tools，不重建 Agent");
	});

	await check("退出技能：恢复会话原流程与工具集", () => {
		built.clearSkill();
		assert.equal(built.activeSkill(), null);
		assert.equal(engine.definition.id, "ticket-flow");
		assert.deepEqual([...built.toolNames()].sort(), [...originalTools].sort());
	});

	await check("退出技能恢复原流程进度（加载前的快照）", () => {
		engine.recordToolResult("ticket_search", true);
		assert.equal(engine.state.stepIndex, 1, "先推进到第 2 步");
		built.activateSkill("data-flow");
		built.clearSkill();
		assert.equal(engine.definition.id, "ticket-flow");
		assert.equal(engine.state.stepIndex, 1, "退出后回到加载技能前的步骤");
	});

	await check("加载「无声明工具」的技能（自动编排）时沿用会话现有工具集", () => {
		built.activateSkill("auto-flow");
		assert.equal(engine.definition.id, "auto-flow");
		assert.equal(engine.done, true, "没有步骤的技能视为流程已走完，不逼模型按步推进");
		assert.deepEqual([...built.toolNames()].sort(), [...originalTools].sort());
		built.clearSkill();
		assert.equal(engine.definition.id, "ticket-flow");
	});

	await check("加载不存在的技能直接抛错（会话层转成 400）", () => {
		assert.throws(() => built.activateSkill("no-such-skill"), /未注册的技能: no-such-skill/);
	});
}

// ---------- 12. 技能文案校验：自定义流程也能带技能（技能区后端） ----------
{
	const knownTools = ["ticket_search", "ticket_notify"];
	const base = {
		name: "带技能文案的流程",
		systemPrompt: "按工单流程处理",
		steps: [{ id: "step-1", title: "查询工单", via: ["ticket_search"], hint: "" }],
	};

	await check("技能文案合法：description + instructions 通过且回显（首尾空白被裁掉）", () => {
		const input = validateWorkflowInput(
			{
				...base,
				skill: { description: "  用户说要处理工单时用我  ", instructions: "  先查工单，再按用户要求处理。  " },
			},
			{ knownTools },
		);
		assert.deepEqual(input.skill, {
			description: "用户说要处理工单时用我",
			instructions: "先查工单，再按用户要求处理。",
		});
	});

	await check("只写一句话说明也能过：instructions 缺省", () => {
		const input = validateWorkflowInput({ ...base, skill: { description: "只在需要工单时用" } }, { knownTools });
		assert.deepEqual(input.skill, { description: "只在需要工单时用" });
		assert.ok(!("instructions" in input.skill!), "没写的正文不该凭空补一个空串");
	});

	await check("技能文案两段都空 = 视为没写（返回的 input 里没有 skill）", () => {
		for (const skill of [{ description: "", instructions: "   " }, {}]) {
			const input = validateWorkflowInput({ ...base, skill }, { knownTools });
			assert.ok(!("skill" in input), "两段都空时不该带 skill 字段");
		}
	});

	await check("技能文案超长：一句话说明 >200、正文 >4000 都抛中文错误", () => {
		assert.throws(
			() =>
				validateWorkflowInput(
					{ ...base, skill: { description: "长".repeat(WORKFLOW_LIMITS.skillDescription + 1) } },
					{ knownTools },
				),
			(error) => error instanceof WorkflowSpecError && /技能的一句话说明 最多 200 个字符/.test(error.message),
		);
		assert.throws(
			() =>
				validateWorkflowInput(
					{ ...base, skill: { instructions: "长".repeat(WORKFLOW_LIMITS.skillInstructions + 1) } },
					{ knownTools },
				),
			(error) => error instanceof WorkflowSpecError && /技能正文 最多 4000 个字符/.test(error.message),
		);
	});

	await check("skill 不是对象时直接抛错（错误文案可上界面）", () => {
		assert.throws(
			() => validateWorkflowInput({ ...base, skill: "写错了" }, { knownTools }),
			(error) => error instanceof WorkflowSpecError && /技能说明 必须是对象/.test(error.message),
		);
	});

	await check("PATCH 合并：不传 skill 沿用旧值，null 清空，只带 description 时正文被替换掉", () => {
		const current: WorkflowInput = { ...base, skill: { description: "旧的一句话", instructions: "旧正文" } };

		const kept = mergeWorkflowInput(current, { name: "改个名" }, { knownTools });
		assert.deepEqual(kept.skill, { description: "旧的一句话", instructions: "旧正文" }, "不改 skill 时应沿用旧值");

		const cleared = mergeWorkflowInput(current, { skill: null }, { knownTools });
		assert.ok(!("skill" in cleared), "skill: null 应该清空技能文案");

		const replaced = mergeWorkflowInput(current, { skill: { description: "新的一句话" } }, { knownTools });
		assert.deepEqual(replaced.skill, { description: "新的一句话" }, "只带 description 是替换语义，旧正文不该留下");
	});
}

console.log(`\n全部通过：${passed} 项检查`);
