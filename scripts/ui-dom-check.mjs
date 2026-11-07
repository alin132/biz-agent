/**
 * 前端接线自检（DOM 桩）：把真实的 web/markdown.js + web/app.js 跑在一个最小 DOM 桩里。
 *
 * 为什么不用 jsdom：仓库不引第三方依赖，控制台本身也没有构建步骤；这份桩只实现 app.js
 * 真正用到的那点 DOM（createElement / appendChild / classList / innerHTML / querySelector /
 * closest / 事件冒泡），所以断言的是**接线**而不是观感——视觉与布局仍然只能靠人眼。
 *
 * innerHTML 故意做成"赋值即清空并重建子树"（和真实 DOM 一致），markdown 产出的表格、
 * 代码块、复制按钮因此是**真的节点**，事件委托也是真的从按钮冒泡到 #thread-inner，
 * 断言才不是对着一串字符串自说自话。
 *
 * 覆盖：引导页、finalizeAnswer、复制（含 execCommand 兜底）、工具卡折叠与键盘、
 * 回到底部阈值、Ctrl + K、会话归档、流程管理器、技能 chip / 菜单 / SSE 的关键路径、
 * IM 机器人凭证 / 回调说明 / ping / fake outbox 的接线。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const webDir = join(here, "..", "web");
const html = readFileSync(join(webDir, "index.html"), "utf8");
const appJs = readFileSync(join(webDir, "app.js"), "utf8");
const markdownJs = readFileSync(join(webDir, "markdown.js"), "utf8");
const css = readFileSync(join(webDir, "style.css"), "utf8");

/* ================= 结果输出（风格对齐 scripts/ui-check.mjs） ================= */

const results = [];
let sectionTitle = "";

/** 中文按两列宽算，分节横线才对得齐。 */
function displayWidth(text) {
	return [...text].reduce((width, char) => width + (/[\u2e80-\u9fff\u3000-\u303f\uff00-\uffef]/.test(char) ? 2 : 1), 0);
}

function section(title) {
	sectionTitle = title;
	const label = `── ${title} `;
	console.log(`\n${label}${"─".repeat(Math.max(4, 64 - displayWidth(label)))}`);
}

async function check(name, run) {
	try {
		await run();
		results.push({ name, ok: true, section: sectionTitle });
		console.log(`  ✓ ${name}`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		results.push({ name, ok: false, message, section: sectionTitle });
		console.log(`  ✗ ${name}\n      ${message}`);
	}
}

/* ================= 最小 DOM 桩 ================= */

const VOID_TAGS = new Set(["br", "hr", "img", "input", "path", "circle", "rect", "polyline", "line"]);
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " };
const decodeEntities = (text) => text.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_match, name) => ENTITIES[name]);

let focusedElement = null;
let docListeners = {};

class TextNode {
	constructor(text) {
		this.nodeType = 3;
		this.tagName = "#text";
		this._text = String(text);
		this.children = [];
		this.parentNode = null;
		this.attributes = {};
		this.classList = { add() {}, remove() {}, toggle: () => false, contains: () => false };
	}
	get textContent() {
		return this._text;
	}
	set textContent(value) {
		this._text = String(value ?? "");
	}
	contains() {
		return false;
	}
	traverse() {}
	querySelectorAll() {
		return [];
	}
	querySelector() {
		return null;
	}
	closest() {
		return null;
	}
	remove() {
		if (this.parentNode) this.parentNode.removeChild(this);
	}
	addEventListener() {}
}

class El {
	constructor(tag) {
		this.tagName = String(tag).toUpperCase();
		this.nodeType = 1;
		this._classes = new Set();
		this.children = [];
		this.parentNode = null;
		this._text = "";
		this._innerHTML = "";
		this.listeners = {};
		this.style = {};
		this.attributes = {};
		this.hidden = false;
		this.disabled = false;
		this.checked = false;
		this.value = "";
		this.title = "";
		this.type = "";
		this.scrollTop = 0;
		this.scrollHeight = 0;
		this.clientHeight = 0;
		this.scrollCalls = [];
		// dataset 走 Proxy：赋值即反射成 data-* 属性，和真实 DOM 一致（app.js 用 status.dataset.role = "status"）
		this.dataset = new Proxy(
			{},
			{
				get: (target, key) => target[key],
				set: (target, key, value) => {
					target[key] = String(value);
					this.attributes[`data-${String(key).replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}`] = String(value);
					return true;
				},
			},
		);
		this.classList = {
			add: (...names) => names.forEach((name) => this._classes.add(name)),
			remove: (...names) => names.forEach((name) => this._classes.delete(name)),
			toggle: (name, force) => {
				const next = force === undefined ? !this._classes.has(name) : Boolean(force);
				if (next) this._classes.add(name);
				else this._classes.delete(name);
				return next;
			},
			contains: (name) => this._classes.has(name),
		};
	}
	get className() {
		return [...this._classes].join(" ");
	}
	set className(value) {
		this._classes = new Set(String(value ?? "").split(/\s+/).filter(Boolean));
	}
	get textContent() {
		if (this._text) return this._text;
		return this.children.map((child) => child.textContent).join("");
	}
	set textContent(value) {
		this._text = String(value ?? "");
		this.children = [];
	}
	get innerHTML() {
		return this._innerHTML;
	}
	set innerHTML(value) {
		this._innerHTML = String(value ?? "");
		this._text = "";
		this.children = [];
		if (this._innerHTML) parseHtmlInto(this, this._innerHTML);
	}
	appendChild(child) {
		if (child.parentNode) child.parentNode.removeChild(child);
		child.parentNode = this;
		this.children.push(child);
		return child;
	}
	append(...nodes) {
		for (const node of nodes) if (node) this.appendChild(node);
	}
	removeChild(node) {
		const index = this.children.indexOf(node);
		if (index >= 0) this.children.splice(index, 1);
		node.parentNode = null;
		return node;
	}
	remove() {
		if (this.parentNode) this.parentNode.removeChild(this);
	}
	addEventListener(type, fn) {
		(this.listeners[type] ??= []).push(fn);
	}
	removeEventListener(type, fn) {
		this.listeners[type] = (this.listeners[type] ?? []).filter((item) => item !== fn);
	}
	dispatch(type, extra = {}) {
		const event = {
			type,
			target: this,
			currentTarget: this,
			key: "",
			ctrlKey: false,
			metaKey: false,
			shiftKey: false,
			defaultPrevented: false,
			stopPropagation() {},
			preventDefault() {
				this.defaultPrevented = true;
			},
			...extra,
		};
		for (const fn of [...(this.listeners[type] ?? [])]) fn(event);
		return event;
	}
	click() {
		return bubble(this, "click");
	}
	dispatchEvent(event) {
		return bubble(this, event.type ?? "event", { detail: event });
	}
	focus() {
		focusedElement = this;
	}
	blur() {
		if (focusedElement === this) focusedElement = null;
	}
	select() {}
	scrollTo(options) {
		this.scrollCalls.push(options);
		this.scrollTop = options?.top ?? this.scrollTop;
	}
	setAttribute(name, value) {
		const text = String(value);
		this.attributes[name] = text;
		if (name === "class") this.className = text;
		else if (name === "hidden") this.hidden = true;
		else if (name.startsWith("data-")) this.dataset[name.slice(5).replace(/-(\w)/g, (_m, char) => char.toUpperCase())] = text;
	}
	removeAttribute(name) {
		delete this.attributes[name];
	}
	getAttribute(name) {
		return this.attributes[name] ?? null;
	}
	contains(node) {
		if (node === this) return true;
		return this.children.some((child) => child.contains(node));
	}
	closest(selector) {
		let current = this;
		while (current) {
			if (current.nodeType === 1 && matchesSimple(current, selector)) return current;
			current = current.parentNode;
		}
		return null;
	}
	scrollIntoView() {}
	getBoundingClientRect() {
		return { left: 10, top: 10, right: 210, bottom: 34, width: 200, height: 24 };
	}
	traverse(callback) {
		for (const child of this.children) {
			callback(child);
			child.traverse(callback);
		}
	}
	querySelectorAll(selector) {
		const hits = [];
		this.traverse((node) => {
			if (node.nodeType === 1 && matchesSelector(node, selector)) hits.push(node);
		});
		// 真浏览器里这是 NodeList：有 length / item() / forEach / 迭代器，**没有** map/filter/find/at。
		// 桩里如果直接返回数组，app.js 误用数组方法就只有真浏览器才炸（踩过：skillMenuItems 的 .filter）。
		return nodeList(hits);
	}
	querySelector(selector) {
		return this.querySelectorAll(selector)[0] ?? null;
	}
}

/** 造一个和真浏览器 NodeList 同形的只读列表：length / item() / forEach / 迭代器，没有数组方法。 */
function nodeList(nodes) {
	const list = {
		length: nodes.length,
		item: (index) => nodes[index] ?? null,
		forEach: (callback, thisArg) => nodes.forEach(callback, thisArg),
		entries: () => nodes.entries(),
		keys: () => nodes.keys(),
		values: () => nodes.values(),
	};
	nodes.forEach((node, index) => {
		list[index] = node;
	});
	list[Symbol.iterator] = () => nodes[Symbol.iterator]();
	return list;
}

/** 单段选择器：.class / #id / tag / tag.class / [attr="v"]。 */
function matchesSimple(node, selector) {
	const token = selector.trim();
	if (token.startsWith("[")) {
		const parsed = /^\[([^\]=~^$*|]+)(?:([~^$*|]?=)"?([^"\]]*)"?)?\]$/.exec(token);
		if (!parsed) return false;
		const [, name, operator, expected] = parsed;
		const actual = node.attributes[name];
		if (actual === undefined) return false;
		if (!operator) return true;
		if (operator === "=") return actual === expected;
		if (operator === "~=") return actual.split(/\s+/).includes(expected);
		return false;
	}
	if (token.startsWith(".")) return token.split(".").filter(Boolean).every((cls) => node.classList.contains(cls));
	if (token.startsWith("#")) return node.attributes.id === token.slice(1);
	const [tag, ...rest] = token.split(".");
	if (tag && node.tagName !== tag.toUpperCase()) return false;
	return rest.filter(Boolean).every((cls) => node.classList.contains(cls));
}

/** 支持后代组合（".empty h2"）——app.js 里确实用了这种写法。 */
function matchesSelector(node, selector) {
	const parts = selector.trim().split(/\s+/);
	if (parts.length === 1) return matchesSimple(node, parts[0]);
	if (!matchesSimple(node, parts[parts.length - 1])) return false;
	let ancestor = node.parentNode;
	for (const part of parts.slice(0, -1).reverse()) {
		let found = false;
		while (ancestor && ancestor.nodeType === 1) {
			if (matchesSimple(ancestor, part)) {
				found = true;
				ancestor = ancestor.parentNode;
				break;
			}
			ancestor = ancestor.parentNode;
		}
		if (!found) return false;
	}
	return true;
}

/** 真实浏览器里 click / keydown 会冒泡，事件委托（#thread-inner 上的复制按钮）靠这个。 */
function bubble(node, type, extra = {}) {
	let current = node;
	let stopped = false;
	// 一个事件对象走完整个冒泡过程：stopPropagation 才拦得住上层（
	// 「⋯」按钮必须挡住技能行的加载，这条在真浏览器里是硬要求）
	const event = {
		type,
		target: node,
		currentTarget: node,
		key: "",
		ctrlKey: false,
		metaKey: false,
		shiftKey: false,
		defaultPrevented: false,
		stopPropagation() {
			stopped = true;
		},
		preventDefault() {
			this.defaultPrevented = true;
		},
		...extra,
	};
	while (current && !stopped) {
		event.currentTarget = current;
		const handlers = current.listeners?.[type];
		if (handlers && handlers.length > 0) {
			for (const fn of [...handlers]) fn(event);
		}
		current = current.parentNode;
	}
	return event;
}

function appendText(container, text) {
	if (text === "") return;
	container.appendChild(new TextNode(text));
}

/** 迷你 HTML 解析：markdown.js 的输出（标签 + class/data-* + 文本）够用。 */
function parseHtmlInto(container, source) {
	const stack = [container];
	let index = 0;
	const tagPattern = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^\s=/>]+(?:="[^"]*")?)*)\s*(\/?)>/g;
	let match;
	while ((match = tagPattern.exec(source)) !== null) {
		if (match.index > index) appendText(stack[stack.length - 1], decodeEntities(source.slice(index, match.index)));
		index = tagPattern.lastIndex;
		const [, closing, rawTag, rawAttrs, selfClose] = match;
		const tag = rawTag.toLowerCase();
		if (closing) {
			for (let depth = stack.length - 1; depth > 0; depth -= 1) {
				if (stack[depth].tagName === tag.toUpperCase()) {
					stack.length = depth;
					break;
				}
			}
			continue;
		}
		const node = new El(tag);
		const attrPattern = /([^\s=/>]+)(?:="([^"]*)")?/g;
		let attr;
		while ((attr = attrPattern.exec(rawAttrs)) !== null) node.setAttribute(attr[1].toLowerCase(), decodeEntities(attr[2] ?? ""));
		stack[stack.length - 1].appendChild(node);
		if (!selfClose && !VOID_TAGS.has(tag)) stack.push(node);
	}
	if (index < source.length) appendText(stack[stack.length - 1], decodeEntities(source.slice(index)));
}

const registry = new Map();
// 桩元素要继承 index.html 里的 hidden 属性（浏览器里 #to-bottom 一开始就是 hidden）
const hiddenIds = new Set(
	[...html.matchAll(/<[^>]*\sid="([^"]+)"[^>]*>/g)].filter((match) => /\shidden(\s|>|=)/.test(match[0])).map((match) => match[1]),
);
function getEl(id) {
	if (!registry.has(id)) {
		const node = new El("div");
		node.setAttribute("id", id);
		if (hiddenIds.has(id)) node.hidden = true;
		registry.set(id, node);
	}
	return registry.get(id);
}

const body = new El("body");
const documentStub = {
	getElementById: getEl,
	createElement: (tag) => new El(tag),
	createElementNS: (_ns, tag) => new El(tag),
	createTextNode: (text) => new TextNode(text),
	addEventListener(type, fn) {
		(docListeners[type] ??= []).push(fn);
	},
	removeEventListener(type, fn) {
		docListeners[type] = (docListeners[type] ?? []).filter((item) => item !== fn);
	},
	querySelector: () => null,
	querySelectorAll: () => [],
	execCommand: null,
	body,
};
Object.defineProperty(documentStub, "activeElement", {
	get: () => focusedElement,
	set: (value) => {
		focusedElement = value;
	},
});

function fireDocument(type, extra = {}) {
	const event = {
		type,
		target: body,
		currentTarget: documentStub,
		key: "",
		ctrlKey: false,
		metaKey: false,
		shiftKey: false,
		defaultPrevented: false,
		stopPropagation() {},
		preventDefault() {
			this.defaultPrevented = true;
		},
		...extra,
	};
	for (const fn of [...(docListeners[type] ?? [])]) fn(event);
	return event;
}

/* ================= 假服务端 + 环境 ================= */

const calls = [];
const clipboardWrites = [];
const execCommands = [];
const alerts = [];
const confirms = [];
let clipboardDenied = false;

let workflows = [
	{ id: "ticket-flow", name: "工单处理", builtin: true, steps: [{ id: "search", title: "查询工单", via: ["searchTickets"] }] },
	{
		id: "report-flow",
		name: "周报助手",
		builtin: false,
		systemPrompt: "每周汇总数据并写成周报",
		steps: [
			{ id: "step-1", title: "拉数", via: ["queryOrders"] },
			{ id: "step-2", title: "成文", via: ["queryOrders"] },
		],
		skill: { description: "每周五汇总本周数据", instructions: "先拉数据，再按模板写周报。" },
	},
	{
		id: "calc-flow",
		name: "提成核算",
		builtin: false,
		systemPrompt: "核算销售提成",
		steps: [{ id: "step-1", title: "拉业绩", via: ["queryOrders"] }],
		skill: { description: "需要核算提成时用它", instructions: "按业绩表算提成。" },
	},
];
const tools = [
	{ name: "searchTickets", description: "查询工单", category: "工单", risk: "low" },
	{ name: "notifyCustomer", description: "通知客户", category: "工单", risk: "low" },
	{ name: "queryOrders", description: "查询订单", category: "数据", risk: "low" },
	{ name: "submitApproval", description: "提交审批", category: "审批", risk: "high" },
];
// 技能目录的形状照 server/session.ts 的 SkillView：steps 是"步骤数"（数字），不是步骤数组
const SKILL_CATALOG = [
	// 「自动编排」= 默认聊天模式：技能列表里要过滤掉，但它也可能被模型当成技能加载
	{
		id: "auto-flow",
		name: "自动编排",
		description: "没有预设步骤，模型按你的话自己挑工具",
		active: false,
		builtin: true,
		steps: 0,
		stepTitles: [],
	},
	{ id: "ticket-flow", name: "工单处理", description: "查询工单、指派责任人", active: false, builtin: true, steps: 1, stepTitles: ["查询工单"] },
	{
		id: "data-flow",
		name: "销售数据分析",
		description: "按区域汇总销售额并给出结论",
		active: false,
		builtin: true,
		steps: 3,
		stepTitles: ["拉取订单", "按区域汇总", "生成结论"],
	},
	{
		id: "approval-flow",
		name: "费用审批",
		description: "报销/费用审批：规则校验 → 提交审批",
		active: false,
		builtin: true,
		steps: 3,
		stepTitles: ["收集单据", "规则校验", "提交审批"],
	},
	{ id: "report-flow", name: "周报助手", description: "每周五汇总本周数据", active: false, builtin: false, steps: 2, stepTitles: ["拉数", "成文"] },
	{ id: "calc-flow", name: "提成核算", description: "需要核算提成时用它", active: false, builtin: false, steps: 1, stepTitles: ["拉业绩"] },
];
// 技能目录（GET /api/skills）与会话视图里的 skills 是同一份数据：新建/删除技能都会改动它
let skillStore = SKILL_CATALOG.map((skill) => ({ ...skill }));
const skillCatalog = () => skillStore.map((skill) => ({ ...skill }));
let sessionStore = [];

// ---- 知识库（P5）夹具：形状照任务书契约 ----
// 默认 false = 后端还没接 /api/kb，既有的 87 项就在这个现实下跑（知识库页是「未接入」空态）；
// 知识库那一段自己打开它。
let kbAvailable = false;
let kbStore = [
	{ id: "kb-1", name: "产品文档", description: "产品手册、FAQ、发布说明", docCount: 2, chunkCount: 14, embedding: null },
	{ id: "kb-2", name: "客服话术", description: "", docCount: 1, chunkCount: 5, embedding: null },
];
const kbDocs = {
	"kb-1": [
		{ id: "doc-1", filename: "产品手册.md", bytes: 2048, status: "ready", chunkCount: 9 },
		{ id: "doc-2", filename: "FAQ.pdf", bytes: 51200, status: "failed", chunkCount: 0, error: "扫描件没有文字层，解析不出内容" },
	],
	"kb-2": [{ id: "doc-3", filename: "话术.txt", bytes: 512, status: "ready", chunkCount: 5 }],
};
let kbEmbedding = { available: false, model: null, baseUrl: null };
// 「对话默认检索」（PUT /api/kb/defaults）：后台真实实现是按 kbIds 覆盖式设置，
// 每行的 isDefault 由它派生——桩也这么做，断言才不会对着"前端自己算的"自说自话。
let kbDefaultIds = [];
// 强制失败：验后端 400/403 的中文 { error } 会原样显示在页面上
let kbDefaultsError = null;

// resetModelFixtures 时把语义检索夹具也复原（用例会把它改成"启用了 bge-m3"）
const KB_EMBEDDING_SEED = { ...kbEmbedding };
let kbSearchMode = "keyword";
let kbDeleteResult = { removed: true, documentsRemoved: 2, chunksRemoved: 14 };
const skillKbBindings = { "report-flow": ["kb-1"] };

// ---- 登录（P3）夹具：默认 off = 后端不要求登录（既有 105 项都走这条） ----
let authMode = "off";
let authUser = { id: "u-1", name: "李工", email: "le@biz-agent.dev", role: "owner" };
let authPermissions = ["workflow:write", "kb:write"];
let loginStatus = 200;

// ---- 成员 / 审计 / 设置（P4）夹具 ----
// 默认 available=false：既有断言仍然在"后端还没接"的现实下跑（成员/审计是「未接入」空态）；
// 新加的那一段自己打开开关。设置页用 healthFixture 覆盖个别字段。
let membersAvailable = false;
let membersStatus = 200;
let memberCreateError = null;
// 成员写接口（PATCH / DELETE）的强制失败：验后端 400/404 文案原样上界面
let memberMutationError = null;
let auditAvailable = false;
let auditStatus = 200;

// ---- 审批中心（这次新增）夹具 ----
// 默认 false：既有的模块遍历与「未接入」断言仍按"后端还没接"的现实跑；
// 审批那段自己打开开关，并对真实形状的待办做渲染 / 批准 / 拒绝 / 降级断言。
let approvalsAvailable = false;
let approvalsStatus = 200;
let approvalPostStatus = 200;
let approvalPostError = null;
const APPROVAL_SEED = [
	{
		sessionId: "s-approval-0001",
		sessionTitle: "差旅报销",
		workflowId: "approval-flow",
		workflowName: "费用审批",
		archived: false,
		requestId: "apv-1",
		toolName: "approval_submit",
		risk: "high",
		args: {
			applicant: "张明",
			type: "报销",
			amount: 3200,
			reason: "客户拜访差旅",
			memo: "金额较大，需要部门经理与财务复核，附发票三张与行程单",
		},
		askedAt: 0,
	},
	{
		sessionId: "s-approval-0002-very-long",
		sessionTitle: null,
		workflowId: "approval-flow",
		workflowName: "费用审批",
		archived: true,
		requestId: "apv-2",
		toolName: "mcp_files_delete",
		risk: "medium",
		args: { path: "C:\\data\\reports\\2026-10.csv", dryRun: false },
		askedAt: 0,
	},
];
let approvalStore = APPROVAL_SEED.map((item) => ({ ...item, args: { ...item.args } }));

// ---- 模型管理（P6）夹具 ----
// 默认 false = 老后端只回 { mode, current, options }（既有断言仍走旧版只读页）；
// 模型页那一段自己打开开关，验证真接口形态下的供应商 / 模型 / 当前模型。
let modelsAvailable = false;
let modelsStatus = 200;
const MODEL_SEED = [
	{
		id: "prov-deepseek",
		name: "DeepSeek 官方",
		kind: "deepseek",
		baseUrl: "https://api.deepseek.com/v1",
		enabled: true,
		hasApiKey: true,
		apiKeyMasked: "sk-d…cdef",
		apiKeyBroken: false,
		modelCount: 1,
	},
	{
		id: "prov-local",
		name: "本地 Ollama",
		kind: "ollama",
		baseUrl: "http://127.0.0.1:11434/v1",
		enabled: true,
		hasApiKey: false,
		apiKeyMasked: null,
		apiKeyBroken: false,
		modelCount: 1,
	},
];
const MODEL_ROW_SEED = [
	{
		id: "model-chat",
		providerId: "prov-deepseek",
		providerName: "DeepSeek 官方",
		name: "DeepSeek Chat",
		modelId: "deepseek-chat",
		kind: "chat",
		enabled: true,
		contextWindow: 128000,
	},
	{
		id: "model-embed",
		providerId: "prov-local",
		providerName: "本地 Ollama",
		name: "本地向量",
		modelId: "nomic-embed-text",
		kind: "embedding",
		enabled: false,
		contextWindow: 8192,
	},
];
let modelProviderStore = MODEL_SEED.map((item) => ({ ...item }));
let modelRowStore = MODEL_ROW_SEED.map((item) => ({ ...item }));
let modelCurrent = "deepseek-chat";
// 向量模型（知识库语义检索用）：模型页的「设为向量模型」写这里
let modelEmbeddingKey = null;

// 探测结果按模型 id 覆盖；默认成功 120ms
let modelPingResults = {};

// ---- API Key（P4）夹具 ----
// 默认 false = 设置页这一块显示「接口未接入」；新加的一段自己打开。
let apiKeysAvailable = false;
let apiKeysStatus = 200;
const API_KEY_SEED = [
	{
		id: "key-1",
		name: "报表机器人",
		prefix: "bk_ab12",
		role: "operator",
		rateLimitPerMin: 60,
		disabled: false,
		revoked: false,
		revokedAt: null,
		lastUsedAt: Date.now() - 5 * 60_000,
		createdAt: Date.now() - 86_400_000,
	},
	{
		id: "key-2",
		name: "旧脚本",
		prefix: "bk_cd34",
		role: "developer",
		rateLimitPerMin: 600,
		disabled: true,
		revoked: false,
		revokedAt: null,
		lastUsedAt: null,
		createdAt: Date.now() - 172_800_000,
	},
];
let apiKeyStore = API_KEY_SEED.map((item) => ({ ...item }));

// 相对时间在加载时算一次：5 分 30 秒前 → 渲染成「5 分钟前」（留 30 秒余量，免得跨分钟抖）
const FIXTURE_NOW = Date.now();
const MEMBER_SEED = [
	{
		id: "u-1",
		email: "le@biz-agent.dev",
		name: "李工",
		role: "owner",
		// 后端现役会带 roleLabel；其余用户故意不带，验证前端自己的四角色映射
		roleLabel: "所有者",
		disabled: false,
		lastLoginAt: FIXTURE_NOW - 5 * 60_000 - 30_000,
	},
	{
		id: "u-2",
		email: "wang@biz-agent.dev",
		name: "王运营",
		role: "operator",
		disabled: false,
		lastLoginAt: FIXTURE_NOW - 3 * 3_600_000 - 600_000,
	},
	// 没有姓名、已停用、从没登录过
	{ id: "u-3", email: "chen@biz-agent.dev", name: null, role: "auditor", disabled: true, lastLoginAt: null },
	// 后端没返回 lastLoginAt 字段：不能编成「从未登录」
	{ id: "u-4", email: "zhao@biz-agent.dev", name: "赵开发", role: "developer", disabled: false },
];
let memberStore = MEMBER_SEED.map((user) => ({ ...user }));

// ---- 插件 UI（首版）夹具 ----
let pluginsAvailable = false;
let pluginsStatus = 200;
let pluginStore = [];
const clonePlugins = () => cloneJson(pluginStore);

// ---- MCP（P7）夹具 ----
// 默认 false = 后端还没接 /api/mcp/servers，既有断言继续在「未接入」空态下跑；
// MCP 那一段自己打开开关，验证真接口形态下的服务卡 / 注册 / 工具开关 / 调试调用。
let mcpAvailable = false;
let mcpStatus = 200;
const MCP_LONG_DESC =
	"把一段很长的工具说明写在这里，用来验证前端会在六十个字符之后截断，并且把完整内容挂在 title 上，避免表格被一条超长的描述撑破；描述列固定限宽并用省略号收尾。";
const MCP_SERVER_SEED = [
	{
		id: "mcp-fs",
		name: "文件助手",
		transport: "stdio",
		command: "node",
		args: ["server.mjs"],
		url: null,
		headers: {},
		env: {},
		enabled: true,
		lastStatus: "ok",
		lastError: null,
		lastCheckedAt: FIXTURE_NOW,
		createdAt: FIXTURE_NOW,
		updatedAt: FIXTURE_NOW,
		toolCount: 3,
		tools: [
			{ id: "mtool-add", serverId: "mcp-fs", name: "add", description: "把两个数字相加", inputSchema: { type: "object" }, enabled: true, createdAt: FIXTURE_NOW },
			{ id: "mtool-desc", serverId: "mcp-fs", name: "describe", description: MCP_LONG_DESC, inputSchema: { type: "object" }, enabled: true, createdAt: FIXTURE_NOW },
			{ id: "mtool-boom", serverId: "mcp-fs", name: "boom", description: "总是失败", inputSchema: { type: "object" }, enabled: true, createdAt: FIXTURE_NOW },
		],
	},
	{
		id: "mcp-remote",
		name: "远程检索",
		transport: "http",
		command: null,
		args: [],
		url: "https://mcp.example.test/mcp",
		headers: { Authorization: "Bearer demo" },
		env: {},
		enabled: true,
		lastStatus: "error",
		lastError: "连接 MCP 服务「远程检索」失败：connect ECONNREFUSED 127.0.0.1:9",
		lastCheckedAt: FIXTURE_NOW,
		createdAt: FIXTURE_NOW,
		updatedAt: FIXTURE_NOW,
		toolCount: 0,
		tools: [],
	},
	{
		id: "mcp-sse",
		name: "旧版事件流",
		transport: "sse",
		command: null,
		args: [],
		url: "https://mcp.example.test/sse",
		headers: {},
		env: {},
		enabled: false,
		lastStatus: "unknown",
		lastError: null,
		lastCheckedAt: null,
		createdAt: FIXTURE_NOW,
		updatedAt: FIXTURE_NOW,
		toolCount: 1,
		tools: [
			{ id: "mtool-ping", serverId: "mcp-sse", name: "ping", description: "探活", inputSchema: { type: "object" }, enabled: false, createdAt: FIXTURE_NOW },
		],
	},
];
const cloneJson = (value) => JSON.parse(JSON.stringify(value));
const cloneMcpServers = () => cloneJson(MCP_SERVER_SEED);
let mcpServerStore = cloneMcpServers();

// ---- IM 机器人（P8）夹具 ----
// 默认 false = 后端还没接 /api/im/bots，既有断言继续在「未接入」空态下跑；
// IM 那一段自己打开开关，验证真接口形态下的机器人卡片 / 弹窗 / ping / 删除 / outbox。
let imAvailable = false;
let imStatus = 200;
let imOutboxAvailable = true;
let imOutboxStatus = 200;
let imPingFailures = {};
const IM_BOT_SEED = [
	{
		id: "imb-1",
		name: "客服机器人",
		platform: "dingtalk",
		appKey: "ding-app-key-1",
		hasAppSecret: true,
		appSecretMasked: "se******12",
		hasCallbackToken: true,
		callbackTokenMasked: "to******34",
		hasAesKey: true,
		robotCode: "ding_robot_1",
		workflowId: "auto-flow",
		enabled: true,
		lastCallbackAt: FIXTURE_NOW - 5 * 60_000 - 30_000,
		sessionCount: 3,
		createdAt: FIXTURE_NOW - 86_400_000,
		updatedAt: FIXTURE_NOW,
	},
	{
		id: "imb-2",
		name: "告警机器人",
		platform: "dingtalk",
		appKey: "ding-app-key-2",
		hasAppSecret: true,
		appSecretMasked: "se******56",
		hasCallbackToken: true,
		callbackTokenMasked: "to******78",
		hasAesKey: false,
		robotCode: "ding_robot_2",
		workflowId: "auto-flow",
		enabled: false,
		lastCallbackAt: null,
		sessionCount: 0,
		createdAt: FIXTURE_NOW - 3_600_000,
		updatedAt: FIXTURE_NOW - 3_600_000,
	},
];
const IM_OUTBOX_LONG =
	"这是一条超过六十个字符的测试出站消息，用来验证 outbox 表格会把内容截断并把完整内容挂在 title 上，避免一条长回复把表格撑破。";
const IM_OUTBOX_SEED = [
	{
		id: "out-1",
		botId: "imb-1",
		botName: "客服机器人",
		target: { conversationId: "cid-group-1" },
		content: "这是一条来自 biz-agent 的测试消息。",
		at: FIXTURE_NOW - 120_000,
		attempts: 1,
	},
	{
		id: "out-2",
		botId: "imb-1",
		botName: "客服机器人",
		target: { staffId: "staff-9" },
		content: IM_OUTBOX_LONG,
		at: FIXTURE_NOW - 60_000,
		attempts: 1,
	},
];
let imBotStore = IM_BOT_SEED.map((bot) => ({ ...bot }));
let imOutboxStore = cloneJson(IM_OUTBOX_SEED);

// ---- 监控（P9）夹具 ----
// 默认 false：既有断言仍在「未接入」空态下跑；监控那一段自己打开开关。
let monitorAvailable = false;
let monitorSummaryStatus = 200;
let monitorTracesStatus = 200;
let monitorDetailStatus = 200;
const MONITOR_LONG_PAYLOAD =
	"这是一段很长的调用参数摘要，用来验证时间轴会把 payload 截断到一百二十个字以内，完整内容挂在 title 上：" +
	"一二三四五六七八九十".repeat(12);
const MONITOR_SUMMARY_SEED = {
	sessions: { total: 42, active24h: 3 },
	messages24h: 128,
	toolCalls: { total: 100, ok: 97, failed: 3, avgMs: 320 },
	// 故意乱序：界面要按调用次数倒序排，不能照接口顺序画
	skills: [
		{ id: "data-flow", calls: 12 },
		{ id: "ticket-flow", calls: 30 },
		{ id: "calc-flow", calls: 5 },
	],
	mcp: [
		{ server: "远程检索", calls: 8, failed: 2 },
		{ server: "文件助手", calls: 20, failed: 0 },
	],
	model: [
		{ model: "deepseek-chat", calls: 40, avgMs: 1500 },
		{ model: "模拟模型", calls: 60, avgMs: 900 },
	],
	errors: 3,
	p95Ms: 1500,
};
let monitorSummaryStore = cloneJson(MONITOR_SUMMARY_SEED);

/** 25 条调用链：首页 20 + 第二页 5，够验 offset 追加与「加载更多」到底。 */
function seedMonitorTraces() {
	const items = [];
	for (let index = 0; index < 25; index += 1) {
		const startedAt = FIXTURE_NOW - index * 60_000;
		if (index === 0) {
			items.push({
				traceId: "tr_aaaaaaaaaaaa",
				sessionId: "sess-1234abcd",
				startedAt,
				finishedAt: startedAt + 1200,
				ms: 1200,
				status: "ok",
				model: "deepseek-chat",
				toolCount: 3,
			});
		} else if (index === 1) {
			items.push({
				traceId: "tr_bbbbbbbbbbbb",
				sessionId: "sess-5678efgh",
				startedAt,
				finishedAt: startedAt + 800,
				ms: 800,
				status: "error",
				model: "模拟模型",
				toolCount: 1,
				error: "工具调用失败：连接超时",
			});
		} else if (index === 2) {
			items.push({
				traceId: "tr_cccccccccccc",
				sessionId: "sess-90abijkl",
				startedAt,
				finishedAt: null,
				ms: null,
				status: "running",
				model: null,
				toolCount: 0,
			});
		} else {
			items.push({
				traceId: `tr_${String(index).padStart(12, "0")}`,
				sessionId: `sess-bulk-${index}`,
				startedAt,
				finishedAt: startedAt + 100,
				ms: 100,
				status: "ok",
				model: "模拟模型",
				toolCount: 2,
			});
		}
	}
	return items;
}
let monitorTraceStore = seedMonitorTraces();

/** 详情事件故意乱序返回：前端要按 seq 升序排时间轴。 */
const MONITOR_EVENTS = [
	{ seq: 1, kind: "llm", name: "deepseek-chat", ok: true, ms: 320, payload: { model: "deepseek-chat", totalTokens: 128 } },
	{
		seq: 2,
		kind: "tool",
		name: "queryOrders",
		ok: true,
		ms: 480,
		payload: { args: { month: "2026-10", region: "华东", query: MONITOR_LONG_PAYLOAD } },
	},
	{ seq: 3, kind: "skill", name: "data-flow", ok: true, ms: null, payload: { action: "load", name: "销售数据分析" } },
	{ seq: 4, kind: "mcp", name: "远程检索", ok: false, ms: 1200, payload: { server: "远程检索", tool: "mcp_search" } },
	{ seq: 5, kind: "approval", name: "submitApproval", ok: null, ms: null, payload: { phase: "waiting", requestId: "apv-1" } },
];
const MONITOR_DETAIL_EVENTS = {
	"tr_aaaaaaaaaaaa": [MONITOR_EVENTS[3], MONITOR_EVENTS[2], MONITOR_EVENTS[0], MONITOR_EVENTS[4], MONITOR_EVENTS[1]],
};

// 审计夹具：120 条 → 首页 50 + 第二页 50 + 第三页 20，够验 offset 与「加载更多」
const AUDIT_LONG_DETAIL =
	"这是一段很长的审计详情，用来验证摘要会在六十个字以内截断：一二三四五六七八九十，一二三四五六七八九十，一二三四五六七八九十。";
function seedAudit(count) {
	const items = [];
	for (let index = 0; index < count; index += 1) {
		const id = count - index;
		const createdAt = FIXTURE_NOW - index * 60_000;
		if (index === 0) {
			items.push({
				id,
				actorType: "user",
				actorId: "u-1",
				action: "user.create",
				targetType: "user",
				targetId: "u-5",
				detail: { email: "new@biz-agent.dev", role: "developer" },
				traceId: "trace-user",
				createdAt,
			});
		} else if (index === 1) {
			items.push({
				id,
				actorType: "system",
				actorId: null,
				action: "http.post",
				targetType: null,
				targetId: null,
				detail: { method: "POST", pathname: "/api/kb", status: 400, note: AUDIT_LONG_DETAIL },
				traceId: "trace-http",
				createdAt,
			});
		} else {
			items.push({
				id,
				actorType: "system",
				actorId: null,
				action: index % 2 === 0 ? "http.get" : "tool.call",
				targetType: "session",
				targetId: `s-${id}`,
				detail: { status: 200 },
				traceId: `trace-${id}`,
				createdAt,
			});
		}
	}
	return items;
}
let auditStore = seedAudit(120);
let healthFixture = {};

// confirm 默认同意；删除库的"取消"用例要能改
let confirmAnswer = true;

/** 技能加载后步骤条要显示技能那条流程的步骤；0 步技能（自动编排）= 空步骤条。 */
function stepsForSkill(skill) {
	const titles = skill.stepTitles ?? [];
	return titles.map((title, index) => ({ id: `step-${index + 1}`, title, status: index === 0 ? "active" : "pending" }));
}

const jsonResponse = (data, ok = true, status = 200) => ({ ok, status, json: async () => data });

function view(id) {
	const base = sessionStore.find((item) => item.id === id);
	if (!base) return null;
	return {
		mode: "simulated",
		modeLabel: "模拟模型",
		modelId: "faux",
		permissionMode: "full",
		current: 0,
		done: false,
		audit: [],
		transcript: [],
		running: false,
		...base,
	};
}

async function fakeFetch(url, options = {}) {
	const method = options.method ?? "GET";
	const payload = options.body ? JSON.parse(options.body) : null;
	// headers 也要记：登录后所有请求都得带 Authorization，断言靠它
	calls.push({ url, method, body: payload, headers: options.headers ?? {} });

	if (url === "/api/workflows" && method === "GET") return jsonResponse(workflows);

	// ---- 登录（P3） ----
	if (url === "/api/auth/me" && method === "GET") {
		// required = 后端要求登录，且这次没带有效 token
		if (authMode === "required") return jsonResponse({ error: "未登录" }, false, 401);
		return jsonResponse({ user: authUser, permissions: authPermissions, authMode });
	}
	if (url === "/api/auth/login" && method === "POST") {
		if (loginStatus !== 200) return jsonResponse({ error: "登录失败" }, false, loginStatus);
		return jsonResponse({ token: "tok-123", user: authUser, permissions: authPermissions, authMode: "required" });
	}

	// ---- 知识库（P5） ----
	if (url === "/api/kb" && method === "GET") {
		if (!kbAvailable) return jsonResponse({ error: "未接入" }, false, 404);
		const defaultIds = new Set(kbDefaultIds);
		return jsonResponse(kbStore.map((lib) => ({ ...lib, isDefault: defaultIds.has(lib.id) })));
	}
	if (url === "/api/kb/defaults") {
		if (kbDefaultsError) return jsonResponse({ error: kbDefaultsError.message }, false, kbDefaultsError.status);
		if (method === "PUT") {
			// 覆盖式：以 body.kbIds 为准，返回生效后的 id 与库对象（契约 200 { kbIds, knowledgeBases }）
			if (!payload || !Array.isArray(payload.kbIds)) return jsonResponse({ error: "kbIds 必须是字符串数组" }, false, 400);
			const unknown = payload.kbIds.filter((id) => !kbStore.some((lib) => lib.id === id));
			if (unknown.length > 0) return jsonResponse({ error: `知识库不存在：${unknown.join("、")}` }, false, 400);
			kbDefaultIds = [...new Set(payload.kbIds)];
		}
		return jsonResponse({
			kbIds: [...kbDefaultIds],
			knowledgeBases: kbStore.filter((lib) => kbDefaultIds.includes(lib.id)).map((lib) => ({ ...lib })),
		});
	}
	if (url === "/api/kb" && method === "POST") {
		const created = {
			id: `kb-${kbStore.length + 1}`,
			name: payload.name,
			description: payload.description ?? "",
			docCount: 0,
			chunkCount: 0,
			embedding: null,
		};
		kbStore.push(created);
		return jsonResponse(created, true, 201);
	}
	if (url === "/api/kb/embedding" && method === "GET") return jsonResponse(kbEmbedding);
	if (/^\/api\/kb\/documents\/[^/]+$/.test(url) && method === "DELETE") {
		return jsonResponse({ removed: true });
	}
	if (/^\/api\/kb\/[^/]+\/documents$/.test(url)) {
		const kbId = decodeURIComponent(url.slice("/api/kb/".length, -"/documents".length));
		if (method === "GET") return jsonResponse(kbDocs[kbId] ?? []);
		const doc = {
			id: `doc-${Object.values(kbDocs).flat().length + 1}`,
			filename: payload.filename,
			bytes: 1024,
			status: "ready",
			chunkCount: 4,
		};
		kbDocs[kbId] = [...(kbDocs[kbId] ?? []), doc];
		return jsonResponse(doc, true, 201);
	}
	if (/^\/api\/kb\/[^/]+\/reindex$/.test(url) && method === "POST") {
		return jsonResponse({ chunks: 12, embedded: true });
	}
	if (/^\/api\/kb\/[^/]+\/search$/.test(url)) {
		return jsonResponse({
			mode: kbSearchMode,
			results: [
				{ heading: "退款时效", snippet: "退款申请提交后 1-3 个工作日到账。", score: kbSearchMode === "vector" ? 0.87 : 12.5, docId: "doc-1" },
				{ heading: "发票下载", snippet: "电子发票在订单详情页右上角下载。", score: 0.42, docId: "doc-1" },
			],
		});
	}
	if (/^\/api\/kb\/[^/]+$/.test(url) && method === "DELETE") {
		const kbId = decodeURIComponent(url.slice("/api/kb/".length));
		kbStore = kbStore.filter((lib) => lib.id !== kbId);
		return jsonResponse(kbDeleteResult);
	}
	if (/^\/api\/skills\/[^/]+\/kb$/.test(url)) {
		const skillId = decodeURIComponent(url.slice("/api/skills/".length, -"/kb".length));
		if (method === "GET") return jsonResponse({ kbIds: skillKbBindings[skillId] ?? [] });
		skillKbBindings[skillId] = payload.kbIds ?? [];
		return jsonResponse({ kbIds: skillKbBindings[skillId] });
	}

	// ---- 成员 / 审计（P4） ----
	if (url === "/api/auth/users") {
		if (!membersAvailable) return jsonResponse({ error: "未接入" }, false, 404);
		if (membersStatus === 403) return jsonResponse({ error: "当前角色是运营，不能管理成员" }, false, 403);
		if (method === "GET") return jsonResponse({ items: memberStore.map((user) => ({ ...user })) });
		if (method === "POST") {
			// 409 = 邮箱已存在：弹窗要把后端的 { error } 原样显示出来
			if (memberCreateError) return jsonResponse({ error: memberCreateError }, false, 409);
			const created = {
				id: `u-${memberStore.length + 1}`,
				email: payload.email,
				name: payload.name ?? null,
				role: payload.role,
				disabled: false,
				lastLoginAt: null,
			};
			memberStore = [...memberStore, created];
			return jsonResponse({ user: created }, true, 201);
		}
	}
	const memberMutationMatch = /^\/api\/auth\/users\/([^/]+)$/.exec(url);
	if (memberMutationMatch) {
		const userId = decodeURIComponent(memberMutationMatch[1]);
		const found = memberStore.find((user) => user.id === userId);
		if (!found) return jsonResponse({ error: "成员不存在" }, false, 404);
		// 强制失败：验 400/404 的中文文案在界面原样显示
		if (memberMutationError) {
			return jsonResponse({ error: memberMutationError.message }, false, memberMutationError.status);
		}
		if (method === "PATCH") {
			if ("role" in payload) {
				found.role = payload.role;
				delete found.roleLabel;
			}
			if ("disabled" in payload) found.disabled = Boolean(payload.disabled);
			if ("name" in payload) found.name = payload.name;
			return jsonResponse({ user: cloneJson(found) });
		}
		if (method === "DELETE") {
			memberStore = memberStore.filter((user) => user.id !== userId);
			return jsonResponse({ removed: true });
		}
	}

	// ---- 审批中心（跨会话待办） ----
	if (url === "/api/approvals" && method === "GET") {
		if (!approvalsAvailable) return jsonResponse({ error: "未接入" }, false, 404);
		if (approvalsStatus === 403) return jsonResponse({ error: "当前角色不能查看审批队列" }, false, 403);
		if (approvalsStatus !== 200) return jsonResponse({ error: "审批队列读取失败" }, false, approvalsStatus);
		return jsonResponse({ items: cloneJson(approvalStore), total: approvalStore.length });
	}
	const approvalDecideMatch = /^\/api\/approvals\/([^/]+)$/.exec(url);
	if (approvalDecideMatch && method === "POST") {
		if (approvalPostStatus !== 200) {
			return jsonResponse({ error: approvalPostError ?? "这条审批已经处理过了" }, false, approvalPostStatus);
		}
		const sessionId = decodeURIComponent(approvalDecideMatch[1]);
		if (!sessionStore.some((session) => session.id === sessionId)) {
			return jsonResponse({ error: "会话不存在" }, false, 404);
		}
		if (!payload || typeof payload.requestId !== "string" || typeof payload.approved !== "boolean") {
			return jsonResponse({ error: "requestId 与 approved 都要给" }, false, 400);
		}
		const index = approvalStore.findIndex(
			(item) => item.sessionId === sessionId && item.requestId === payload.requestId,
		);
		// 不存在 / 已批 / 已拒：真实接口统一按"处理过了"回 409
		if (index < 0) return jsonResponse({ error: "这条审批已经处理过了" }, false, 409);
		approvalStore = approvalStore.filter((_item, at) => at !== index);
		return jsonResponse({ ok: true, resolved: true, sessionId, requestId: payload.requestId });
	}
	if (url.startsWith("/api/audit") && method === "GET") {
		if (!auditAvailable) return jsonResponse({ error: "未接入" }, false, 404);
		if (auditStatus === 403) return jsonResponse({ error: "当前角色是开发者，不能查看审计记录" }, false, 403);
		const query = new URLSearchParams(url.slice(url.indexOf("?") + 1));
		const limit = Number(query.get("limit") ?? 50);
		const offset = Number(query.get("offset") ?? 0);
		const action = query.get("action") ?? "";
		const actor = query.get("actor") ?? "";
		const matched = auditStore.filter(
			(item) =>
				(!action || String(item.action).includes(action)) &&
				(!actor || String(item.actorId ?? "").includes(actor)),
		);
		return jsonResponse({ total: matched.length, limit, offset, items: matched.slice(offset, offset + limit) });
	}

	if (url === "/api/tools" && method === "GET") return jsonResponse(tools);

	// ---- 模型管理（P6） ----
	if (url === "/api/models" && method === "GET") {
		if (modelsStatus === 403) return jsonResponse({ error: "当前角色是运营，不能查看模型配置" }, false, 403);
		if (!modelsAvailable) {
			// 老后端形态：只有 mode / current / options（旧版只读页的回归就靠它）
			return jsonResponse({
				mode: "simulated",
				current: "faux",
				options: [
					{ id: "faux", label: "模拟模型" },
					{ id: "deepseek-chat", label: "DeepSeek Chat" },
				],
			});
		}
		return jsonResponse({
			mode: "live",
			current: modelCurrent,
			options: modelRowStore
				.filter((item) => item.kind === "chat" && item.enabled)
				.map((item) => ({ id: item.modelId, label: item.name })),
			providers: modelProviderStore.map((item) => ({ ...item })),
			models: modelRowStore.map((item) => ({ ...item })),
		});
	}
	if (url === "/api/models" && method === "POST") {
		const provider = modelProviderStore.find((item) => item.id === payload.providerId);
		const created = {
			id: `model-${modelRowStore.length + 1}`,
			providerId: payload.providerId,
			providerName: provider?.name ?? "",
			name: payload.name,
			modelId: payload.modelId,
			kind: payload.kind ?? "chat",
			enabled: payload.enabled !== false,
			contextWindow: payload.contextWindow ?? null,
		};
		modelRowStore = [...modelRowStore, created];
		return jsonResponse(created, true, 201);
	}
	if (url === "/api/models/embedding") {
		// 与后端一致：只有启用且供应商启用的向量模型才算"可选"
		const options = modelRowStore.filter((item) => item.kind === "embedding" && item.enabled);
		if (method === "GET") return jsonResponse({ modelKey: modelEmbeddingKey, options: options.map((item) => ({ ...item })) });
		const row = modelRowStore.find((item) => item.id === payload.modelId);
		if (!row) return jsonResponse({ error: "模型不存在" }, false, 404);
		if (row.kind !== "embedding") return jsonResponse({ error: "只有「向量」类型的模型能设为向量模型" }, false, 400);
		if (!row.enabled) return jsonResponse({ error: "模型已停用，不能设为向量模型" }, false, 400);
		modelEmbeddingKey = row.id;
		return jsonResponse({ modelKey: modelEmbeddingKey, options: options.map((item) => ({ ...item })) });
	}
	if (url === "/api/models/current") {
		if (method === "GET") {
			const row = modelRowStore.find((item) => item.modelId === modelCurrent || item.id === modelCurrent) ?? null;
			return jsonResponse({ current: modelCurrent, model: row, mode: "live" });
		}
		const row = modelRowStore.find((item) => item.id === payload.modelId || item.modelId === payload.modelId);
		if (!row) return jsonResponse({ error: "模型不存在" }, false, 404);
		modelCurrent = row.modelId;
		return jsonResponse({ current: modelCurrent, model: { ...row }, mode: "live" });
	}
	if (url === "/api/models/providers") {
		if (method === "GET") return jsonResponse({ items: modelProviderStore.map((item) => ({ ...item })) });
		const key = payload.apiKey ? String(payload.apiKey) : "";
		const created = {
			id: `prov-${modelProviderStore.length + 1}`,
			name: payload.name,
			kind: payload.kind ?? "openai",
			baseUrl: payload.baseUrl || null,
			enabled: payload.enabled !== false,
			hasApiKey: Boolean(key),
			apiKeyMasked: key ? `sk-…${key.slice(-4)}` : null,
			modelCount: 0,
		};
		modelProviderStore = [...modelProviderStore, created];
		return jsonResponse(created, true, 201);
	}
	const providerMatch = /^\/api\/models\/providers\/([^/]+)$/.exec(url);
	if (providerMatch) {
		const providerId = decodeURIComponent(providerMatch[1]);
		const found = modelProviderStore.find((item) => item.id === providerId);
		if (!found) return jsonResponse({ error: "供应商不存在" }, false, 404);
		if (method === "PATCH") {
			if ("name" in payload) found.name = payload.name;
			if ("kind" in payload) found.kind = payload.kind;
			if ("baseUrl" in payload) found.baseUrl = payload.baseUrl || null;
			if ("enabled" in payload) found.enabled = payload.enabled;
			if ("apiKey" in payload) {
				const key = String(payload.apiKey ?? "");
				found.hasApiKey = Boolean(key);
				found.apiKeyMasked = key ? `sk-…${key.slice(-4)}` : null;
			}
			return jsonResponse({ ...found });
		}
		if (method === "DELETE") {
			const modelsRemoved = modelRowStore.filter((item) => item.providerId === providerId).length;
			modelRowStore = modelRowStore.filter((item) => item.providerId !== providerId);
			modelProviderStore = modelProviderStore.filter((item) => item.id !== providerId);
			return jsonResponse({ removed: true, modelsRemoved });
		}
	}
	const pingMatch = /^\/api\/models\/([^/]+)\/ping$/.exec(url);
	if (pingMatch && method === "POST") {
		const modelId = decodeURIComponent(pingMatch[1]);
		return jsonResponse({ id: modelId, ...(modelPingResults[modelId] ?? { ok: true, latencyMs: 120 }) });
	}
	const modelMatch = /^\/api\/models\/([^/]+)$/.exec(url);
	if (modelMatch) {
		const rowId = decodeURIComponent(modelMatch[1]);
		const found = modelRowStore.find((item) => item.id === rowId);
		if (!found) return jsonResponse({ error: "模型不存在" }, false, 404);
		if (method === "PATCH") {
			if ("providerId" in payload) {
				found.providerId = payload.providerId;
				found.providerName = modelProviderStore.find((item) => item.id === payload.providerId)?.name ?? "";
			}
			for (const field of ["name", "modelId", "kind", "enabled", "contextWindow"]) {
				if (field in payload) found[field] = payload[field];
			}
			return jsonResponse({ ...found });
		}
		if (method === "DELETE") {
			modelRowStore = modelRowStore.filter((item) => item.id !== rowId);
			return jsonResponse({ removed: true });
		}
	}

	// ---- API Key（P4） ----
	if (url === "/api/api-keys") {
		if (!apiKeysAvailable) return jsonResponse({ error: "未接入" }, false, 404);
		if (apiKeysStatus === 403) return jsonResponse({ error: "当前角色是运营，不能管理 API Key" }, false, 403);
		if (method === "GET") return jsonResponse({ items: apiKeyStore.map((item) => ({ ...item })) });
		const created = {
			id: `key-${apiKeyStore.length + 1}`,
			name: payload.name ?? "未命名 API Key",
			prefix: "bk_new123",
			role: payload.role ?? "operator",
			rateLimitPerMin: payload.rateLimitPerMin ?? 60,
			disabled: false,
			revoked: false,
			revokedAt: null,
			lastUsedAt: null,
			createdAt: Date.now(),
		};
		apiKeyStore = [...apiKeyStore, created];
		// 明文只在这个响应里出现一次；列表里永远只有 prefix
		return jsonResponse({ item: created, key: "bk_plaintext_once_9f3a2b" }, true, 201);
	}
	const apiKeyMatch = /^\/api\/api-keys\/([^/]+)$/.exec(url);
	if (apiKeyMatch) {
		const keyId = decodeURIComponent(apiKeyMatch[1]);
		const found = apiKeyStore.find((item) => item.id === keyId);
		if (!found) return jsonResponse({ error: "API Key 不存在" }, false, 404);
		if (method === "PATCH") {
			if (typeof payload.disabled === "boolean") found.disabled = payload.disabled;
			if (typeof payload.rateLimitPerMin === "number") found.rateLimitPerMin = payload.rateLimitPerMin;
			return jsonResponse({ item: { ...found } });
		}
		if (method === "DELETE") {
			found.revoked = true;
			found.disabled = true;
			found.revokedAt = Date.now();
			return jsonResponse({ removed: true, item: { ...found } });
		}
	}
	// ---- 插件管理（UI 首版） ----
	if (url === "/api/plugins" && method === "GET") {
		if (!pluginsAvailable) return jsonResponse({ error: "未接入" }, false, 404);
		if (pluginsStatus === 403) return jsonResponse({ error: "当前角色不能查看插件" }, false, 403);
		return jsonResponse({ items: clonePlugins() });
	}
	if (url === "/api/plugins/import" && method === "POST") {
		const manifest = payload?.manifest ?? {};
		const item = { ...manifest, id: manifest.id ?? "plugin-" + (pluginStore.length + 1), enabled: true };
		pluginStore.push(item);
		return jsonResponse({ item: cloneJson(item) }, true, 201);
	}
	const pluginMatch = /^\/api\/plugins\/([^/]+)$/.exec(url);
	if (pluginMatch) {
		const id = decodeURIComponent(pluginMatch[1]);
		const item = pluginStore.find((plugin) => plugin.id === id);
		if (!item) return jsonResponse({ error: "插件不存在" }, false, 404);
		if (method === "PATCH") { item.enabled = payload.enabled; return jsonResponse({ item: cloneJson(item) }); }
		if (method === "DELETE") { pluginStore = pluginStore.filter((plugin) => plugin.id !== id); return jsonResponse({ removed: true }); }
	}
	// ---- MCP（P7） ----
	if (url === "/api/mcp/servers" && method === "GET") {
		if (!mcpAvailable) return jsonResponse({ error: "未接入" }, false, 404);
		if (mcpStatus === 403) return jsonResponse({ error: "当前角色是运营，不能查看 MCP 配置" }, false, 403);
		return jsonResponse({ items: mcpServerStore.map((server) => cloneJson(server)) });
	}
	if (url === "/api/mcp/servers" && method === "POST") {
		const created = {
			id: `mcp-${mcpServerStore.length + 1}`,
			name: payload.name,
			transport: payload.transport ?? "stdio",
			command: payload.command ?? null,
			args: payload.args ?? [],
			url: payload.url ?? null,
			headers: payload.headers ?? {},
			env: payload.env ?? {},
			enabled: payload.enabled !== false,
			lastStatus: "ok",
			lastError: null,
			lastCheckedAt: FIXTURE_NOW,
			createdAt: FIXTURE_NOW,
			updatedAt: FIXTURE_NOW,
			toolCount: 0,
			tools: [],
		};
		mcpServerStore = [...mcpServerStore, created];
		return jsonResponse(cloneJson(created), true, 201);
	}
	const mcpRefreshMatch = /^\/api\/mcp\/servers\/([^/]+)\/refresh$/.exec(url);
	if (mcpRefreshMatch && method === "POST") {
		const serverId = decodeURIComponent(mcpRefreshMatch[1]);
		const found = mcpServerStore.find((item) => item.id === serverId);
		if (!found) return jsonResponse({ error: "MCP 服务不存在" }, false, 404);
		found.lastStatus = "ok";
		found.lastError = null;
		found.lastCheckedAt = FIXTURE_NOW;
		return jsonResponse(cloneJson(found));
	}
	const mcpCallMatch = /^\/api\/mcp\/servers\/([^/]+)\/call$/.exec(url);
	if (mcpCallMatch && method === "POST") {
		const serverId = decodeURIComponent(mcpCallMatch[1]);
		const found = mcpServerStore.find((item) => item.id === serverId);
		if (!found) return jsonResponse({ error: "MCP 服务不存在" }, false, 404);
		const toolName = String(payload.tool ?? "");
		const tool = (found.tools ?? []).find((item) => item.name === toolName);
		if (!tool) return jsonResponse({ error: `MCP 服务「${found.name}」没有名为「${toolName}」的工具` }, false, 404);
		const isError = toolName === "boom";
		const text = isError
			? "故意失败：这个工具永远返回错误"
			: toolName === "add"
				? String(Number(payload.arguments?.a ?? 0) + Number(payload.arguments?.b ?? 0))
				: "工具执行完成";
		return jsonResponse({
			serverId: found.id,
			serverName: found.name,
			tool: tool.name,
			toolName: `mcp_${found.name}_${tool.name}`,
			isError,
			text,
			content: [{ type: "text", text }],
		});
	}
	const mcpServerMatch = /^\/api\/mcp\/servers\/([^/]+)$/.exec(url);
	if (mcpServerMatch) {
		const serverId = decodeURIComponent(mcpServerMatch[1]);
		const found = mcpServerStore.find((item) => item.id === serverId);
		if (!found) return jsonResponse({ error: "MCP 服务不存在" }, false, 404);
		if (method === "PATCH") {
			for (const field of ["name", "transport", "command", "args", "url", "headers", "env", "enabled"]) {
				if (field in payload) found[field] = payload[field];
			}
			// 只改 enabled 时工具与 lastStatus 原样保留（真实后端也是这个语义）
			return jsonResponse(cloneJson(found));
		}
		if (method === "DELETE") {
			mcpServerStore = mcpServerStore.filter((item) => item.id !== serverId);
			return jsonResponse({ removed: true });
		}
	}
	const mcpToolMatch = /^\/api\/mcp\/tools\/([^/]+)$/.exec(url);
	if (mcpToolMatch && method === "PATCH") {
		const toolId = decodeURIComponent(mcpToolMatch[1]);
		for (const server of mcpServerStore) {
			const tool = (server.tools ?? []).find((item) => item.id === toolId);
			if (!tool) continue;
			tool.enabled = Boolean(payload.enabled);
			return jsonResponse(cloneJson(tool));
		}
		return jsonResponse({ error: "MCP 工具不存在" }, false, 404);
	}

	// ---- IM 机器人（P8） ----
	if (url === "/api/im/bots" && method === "GET") {
		if (!imAvailable) return jsonResponse({ error: "未接入" }, false, 404);
		if (imStatus === 403) return jsonResponse({ error: "当前角色是运营，不能查看 IM 配置" }, false, 403);
		return jsonResponse({ items: imBotStore.map((bot) => cloneJson(bot)) });
	}
	if (url === "/api/im/bots" && method === "POST") {
		const created = {
			id: `imb-${imBotStore.length + 1}`,
			name: payload.name,
			platform: "dingtalk",
			appKey: payload.appKey,
			hasAppSecret: true,
			appSecretMasked: "se******99",
			hasCallbackToken: true,
			callbackTokenMasked: "to******99",
			hasAesKey: Boolean(payload.aesKey),
			robotCode: payload.robotCode,
			workflowId: "auto-flow",
			enabled: payload.enabled !== false,
			lastCallbackAt: null,
			sessionCount: 0,
			createdAt: FIXTURE_NOW,
			updatedAt: FIXTURE_NOW,
		};
		imBotStore = [...imBotStore, created];
		return jsonResponse(cloneJson(created), true, 201);
	}
	if (url === "/api/im/outbox" && method === "GET") {
		if (!imOutboxAvailable) {
			return jsonResponse({ error: "outbox 只在 DINGTALK_TRANSPORT=fake 时可用" }, false, 404);
		}
		if (imOutboxStatus !== 200) {
			return jsonResponse({ error: "当前角色不能查看审计记录" }, false, imOutboxStatus);
		}
		return jsonResponse({ transport: "fake", count: imOutboxStore.length, items: cloneJson(imOutboxStore) });
	}
	const imPingMatch = /^\/api\/im\/bots\/([^/]+)\/ping$/.exec(url);
	if (imPingMatch && method === "POST") {
		const botId = decodeURIComponent(imPingMatch[1]);
		const found = imBotStore.find((bot) => bot.id === botId);
		if (!found) return jsonResponse({ error: "机器人不存在" }, false, 404);
		if (imPingFailures[botId]) {
			// 真实传输的投递失败也是 200 + ok:false + 中文 error
			return jsonResponse({
				id: found.id,
				name: found.name,
				ok: false,
				transport: "real",
				attempts: 3,
				error: imPingFailures[botId],
			});
		}
		const item = {
			id: `out-${imOutboxStore.length + 1}`,
			botId: found.id,
			botName: found.name,
			target: { conversationId: `fake-${found.id}` },
			content: "这是一条来自 biz-agent 的测试消息。",
			at: FIXTURE_NOW,
			attempts: 1,
		};
		imOutboxStore = [...imOutboxStore, item];
		return jsonResponse({
			id: found.id,
			name: found.name,
			ok: true,
			transport: "fake",
			attempts: 1,
			messageId: item.id,
		});
	}
	const imBotMatch = /^\/api\/im\/bots\/([^/]+)$/.exec(url);
	if (imBotMatch) {
		const botId = decodeURIComponent(imBotMatch[1]);
		const found = imBotStore.find((bot) => bot.id === botId);
		if (!found) return jsonResponse({ error: "机器人不存在" }, false, 404);
		if (method === "PATCH") {
			for (const field of ["name", "appKey", "robotCode", "enabled"]) {
				if (field in payload) found[field] = payload[field];
			}
			if ("appSecret" in payload) found.appSecretMasked = `se******${String(payload.appSecret).slice(-2)}`;
			if ("callbackToken" in payload) found.callbackTokenMasked = `to******${String(payload.callbackToken).slice(-2)}`;
			if ("aesKey" in payload) found.hasAesKey = Boolean(payload.aesKey);
			return jsonResponse(cloneJson(found));
		}
		if (method === "DELETE") {
			const sessionsRemoved = found.sessionCount ?? 0;
			imBotStore = imBotStore.filter((bot) => bot.id !== botId);
			return jsonResponse({ removed: true, sessionsRemoved });
		}
	}

	// ---- 监控（P9） ----
	if (url.startsWith("/api/monitor/summary") && method === "GET") {
		if (!monitorAvailable) return jsonResponse({ error: "未接入" }, false, 404);
		if (monitorSummaryStatus === 403) return jsonResponse({ error: "当前角色不能查看监控数据" }, false, 403);
		if (monitorSummaryStatus !== 200) return jsonResponse({ error: "监控读取失败" }, false, monitorSummaryStatus);
		return jsonResponse(cloneJson(monitorSummaryStore));
	}
	if (url.startsWith("/api/monitor/traces?") && method === "GET") {
		if (!monitorAvailable) return jsonResponse({ error: "未接入" }, false, 404);
		if (monitorTracesStatus === 403) {
			return jsonResponse({ error: "当前角色是运营，不能查看审计记录" }, false, 403);
		}
		if (monitorTracesStatus !== 200) return jsonResponse({ error: "调用链读取失败" }, false, monitorTracesStatus);
		const query = new URLSearchParams(url.slice(url.indexOf("?") + 1));
		const limit = Number(query.get("limit") ?? 20);
		const offset = Number(query.get("offset") ?? 0);
		return jsonResponse({
			total: monitorTraceStore.length,
			items: cloneJson(monitorTraceStore.slice(offset, offset + limit)),
		});
	}
	const monitorDetailMatch = /^\/api\/monitor\/traces\/([^/?]+)$/.exec(url);
	if (monitorDetailMatch && method === "GET") {
		if (!monitorAvailable) return jsonResponse({ error: "未接入" }, false, 404);
		if (monitorDetailStatus === 403) {
			return jsonResponse({ error: "当前角色是开发者，只能查看自己创建的会话的调用链" }, false, 403);
		}
		if (monitorDetailStatus !== 200) {
			return jsonResponse({ error: "调用链读取失败" }, false, monitorDetailStatus);
		}
		const traceId = decodeURIComponent(monitorDetailMatch[1]);
		const trace = monitorTraceStore.find((item) => item.traceId === traceId);
		if (!trace) return jsonResponse({ error: "调用链不存在" }, false, 404);
		return jsonResponse({
			trace: { ...cloneJson(trace), workflowId: "auto-flow", skillId: null },
			events: cloneJson(MONITOR_DETAIL_EVENTS[traceId] ?? []),
		});
	}

	// 设置页要读的存活探针（storage 是后端 P3 才有的字段，这里先给出来验证展示）
	if (url === "/api/health" && method === "GET") {
		return jsonResponse({
			ok: true,
			uptimeMs: 125000,
			sessions: sessionStore.length,
			model: { mode: "simulated", id: null, label: "模拟模型" },
			storage: { kind: "sqlite", detail: "data/scratch.db" },
			// 后面几条用例可以覆盖个别字段（auth / uptimeMs / model / storage）
			...healthFixture,
		});
	}
	// 技能目录：形状照 server/index.ts 的 GET /api/skills
	if (url === "/api/skills" && method === "GET") {
		return jsonResponse(
			skillStore.map((skill) => ({
				id: skill.id,
				name: skill.name,
				description: skill.description,
				steps: skill.steps,
				tools: [],
				builtin: skill.builtin,
			})),
		);
	}

	if (url === "/api/workflows" && method === "POST") {
		const created = {
			id: "refund-flow",
			name: payload.name,
			systemPrompt: payload.systemPrompt,
			builtin: false,
			steps: payload.steps,
			...(payload.skill ? { skill: payload.skill } : {}),
		};
		workflows = [...workflows.filter((item) => item.id !== created.id), created];
		return jsonResponse(created, true, 201);
	}
	if (url.startsWith("/api/workflows/") && method === "GET") {
		const id = decodeURIComponent(url.slice("/api/workflows/".length));
		const found = workflows.find((item) => item.id === id);
		if (!found) return jsonResponse({ error: "流程不存在" }, false, 404);
		return jsonResponse({
			id: found.id,
			name: found.name,
			systemPrompt: found.systemPrompt ?? "系统提示",
			builtin: found.builtin,
			steps: found.steps.map((step) => ({ ...step, hint: step.hint ?? "提示" })),
			// 内置流程也有 skill 文案（写在 src/workflows/*.ts），detail 里带上才做得了只读展示
			...(found.skill ? { skill: { ...found.skill } } : {}),
		});
	}
	if (url.startsWith("/api/workflows/") && method === "PATCH") {
		const id = decodeURIComponent(url.slice("/api/workflows/".length));
		workflows = workflows.map((item) =>
			item.id === id ? { ...item, ...payload, ...(payload.skill ? {} : { skill: undefined }) } : item,
		);
		skillStore = skillStore.map((item) =>
			item.id === id
				? { ...item, name: payload.name, description: payload.skill?.description ?? "" }
				: item,
		);
		return jsonResponse({ ...workflows.find((item) => item.id === id), builtin: false });
	}
	if (url.startsWith("/api/workflows/") && method === "DELETE") {
		const id = decodeURIComponent(url.slice("/api/workflows/".length));
		// 契约照 server/index.ts：删流程 = 连它的会话一起删，并摘掉别处"正挂着这条技能"的引用
		const sessionsRemoved = sessionStore.filter((item) => item.workflowId === id).length;
		sessionStore = sessionStore.filter((item) => item.workflowId !== id);
		let skillsCleared = 0;
		for (const item of sessionStore) {
			if (item.activeSkillId !== id) continue;
			item.activeSkillId = null;
			item.skills = (item.skills ?? []).map((skill) => ({ ...skill, active: false }));
			item.steps = item.baseSteps ?? [];
			skillsCleared += 1;
		}
		workflows = workflows.filter((item) => item.id !== id);
		skillStore = skillStore.filter((item) => item.id !== id);
		return jsonResponse({ removed: true, sessionsRemoved, skillsCleared });
	}

	if (url === "/api/sessions" && method === "GET") return jsonResponse(sessionStore.map((item) => ({ ...item })));
	if (url === "/api/sessions" && method === "POST") {
		const created = {
			id: "s-new",
			workflowId: payload.workflowId,
			workflowName: workflows.find((item) => item.id === payload.workflowId)?.name ?? "自动编排",
			title: null,
			archived: false,
			steps: [],
			skills: skillCatalog(),
			activeSkillId: null,
		};
		sessionStore = [...sessionStore, created];
		return jsonResponse(view("s-new"), true, 201);
	}
	if (/^\/api\/sessions\/[^/]+\/messages$/.test(url)) return jsonResponse({ ok: true });
	if (/^\/api\/sessions\/[^/]+\/permissions$/.test(url)) return jsonResponse({ ok: true });
	if (/^\/api\/sessions\/[^/]+\/skills$/.test(url) && method === "POST") {
		// 契约照 server/index.ts：body { skillId: string | null }，未知技能 400
		const id = decodeURIComponent(url.slice("/api/sessions/".length, url.length - "/skills".length));
		const target = sessionStore.find((item) => item.id === id);
		if (!target) return jsonResponse({ error: "会话不存在" }, false, 404);
		if (!("skillId" in payload) || (payload.skillId !== null && typeof payload.skillId !== "string")) {
			return jsonResponse({ error: "skillId 必须是字符串或 null" }, false, 400);
		}
		const skillId = payload.skillId;
		const skill = skillId === null ? null : (target.skills ?? []).find((item) => item.id === skillId);
		if (skillId !== null && !skill) return jsonResponse({ error: `未注册的技能: ${skillId}` }, false, 400);
		target.activeSkillId = skillId;
		target.skills = (target.skills ?? []).map((item) => ({ ...item, active: item.id === skillId }));
		target.steps = skill ? stepsForSkill(skill) : (target.baseSteps ?? []);
		target.current = 0;
		return jsonResponse({
			activeSkillId: skillId,
			tools: ["use_skill"],
			skills: target.skills,
			steps: target.steps,
			current: 0,
			done: false,
		});
	}
	if (/^\/api\/sessions\/[^/]+$/.test(url)) {
		const id = decodeURIComponent(url.slice("/api/sessions/".length));
		if (method === "PATCH") {
			const target = sessionStore.find((item) => item.id === id);
			if (!target) return jsonResponse({ error: "会话不存在" }, false, 404);
			if (typeof payload.archived === "boolean") target.archived = payload.archived;
			if (typeof payload.title === "string") target.title = payload.title || null;
			return jsonResponse({ title: target.title, archived: target.archived });
		}
		const found = view(id);
		return found ? jsonResponse(found) : jsonResponse({ error: "会话不存在" }, false, 404);
	}
	return jsonResponse({ error: `未预期请求 ${method} ${url}` }, false, 500);
}

class FakeEventSource {
	constructor(url) {
		this.url = url;
	}
	close() {}
}

// window 就是全局对象本身：markdown.js 用 window.renderMarkdown = ... 挂上去，
// app.js 里裸写的 renderMarkdown(...) 才能解析到。
const sandbox = {
	document: documentStub,
	navigator: {
		clipboard: {
			async writeText(text) {
				if (clipboardDenied) throw new Error("浏览器拒绝了剪贴板");
				clipboardWrites.push(text);
			},
		},
	},
	localStorage: {
		store: new Map(),
		getItem(key) {
			return this.store.get(key) ?? null;
		},
		setItem(key, value) {
			this.store.set(key, String(value));
		},
		removeItem(key) {
			this.store.delete(key);
		},
	},
	// 上传走 FileReader.readAsDataURL（浏览器原生），桩里按 base64 编码 file.content
	FileReader: class FakeFileReader {
		readAsDataURL(file) {
			const base64 = Buffer.from(String(file?.content ?? ""), "utf8").toString("base64");
			this.result = `data:${file?.type ?? "text/plain"};base64,${base64}`;
			setTimeout(() => this.onload?.(), 0);
		}
	},
	Event: class Event {
		constructor(type) {
			this.type = type;
		}
	},
	EventSource: FakeEventSource,
	fetch: fakeFetch,
	alert: (message) => alerts.push(message),
	confirm: (message) => {
		confirms.push(message);
		return confirmAnswer;
	},
	requestAnimationFrame: (fn) => setTimeout(fn, 0),
	setTimeout,
	clearTimeout,
	// 审批中心的自动刷新用真实定时器计时；用例结束会切走模块，轮询自己停掉
	setInterval,
	clearInterval,
	console,
	innerWidth: 1440,
	innerHeight: 900,
	SpeechRecognition: undefined,
	webkitSpeechRecognition: undefined,
	addEventListener() {},
	removeEventListener() {},
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
documentStub.execCommand = (command) => {
	const area = body.children.find((node) => node.classList?.contains("copy-fallback"));
	execCommands.push({ command, value: area?.value ?? null });
	return true;
};

vm.createContext(sandbox);
vm.runInContext(markdownJs, sandbox, { filename: "web/markdown.js" });
vm.runInContext(appJs, sandbox, { filename: "web/app.js" });
vm.runInContext(
	`globalThis.__t = { state, els, handle, addUserMessage, appendText, finalizeAnswer, addNotice, addToolStart, finishTool,
		renderSidebar, refreshSessions, openSession, setSessionArchived, sessionMenuItems,
		openFlowEditor, saveFlow, addFlowStep, deleteFlow, closeFlowEditor, refreshWorkflows,
		refreshSkillCatalog, renderSkillList, renderSkillCurrent, renderSkillChip, loadSkillFromRow, skillRowMenuItems,
		refreshPlugins, setPluginEnabled, uninstallPlugin, importPluginFile,
		setSkill, MODULES, switchModule, renderModuleView, renderModuleNav, modulePageNode, visibleSkills,
		// P5 / P3：知识库 + 登录
		bootstrap, submitLogin, logout, openIdentityMenu, refreshKb, selectKbLibrary, deleteKbLibrary, reindexKbLibrary,
		openNewKbDialog, openSkillKbDialog, submitKbDialog, closeKbDialog, uploadKbDocument, handleKbFilePicked,
		canWriteWorkflow, canLogout, roleLabel,
		// P4：成员 / 审计 / 设置
		refreshMembers, canManageMembers, openNewMemberDialog, formatRelativeTime, formatUptime,
		refreshAudit, loadMoreAudit, auditDetailFull,
		// 审批中心（本次新增）：待办队列 / 批准 / 拒绝 / 去会话 / 自动刷新
		refreshApprovals, refreshApprovalsPage, decideApproval, openApprovalSession, approvalsTick,
		setApprovalsAuto, refreshApprovalWaitNodes, canRunSessions,
		// 成员写操作（本次新增）：改角色 / 停用启用 / 删除
		openMemberRoleDialog, toggleMember, deleteMember, memberActionTitle, memberIsSelf,
		// P6 / P4：模型管理 + API Key
		refreshModelAdmin, refreshApiKeys, openProviderDialog, openModelDialog, openSwitchModelDialog,
		deleteProvider, deleteModel, setCurrentModel, openNewApiKeyDialog, formatKeyUsed,
		// P7：MCP 服务注册 / 工具开关 / 调试调用
		refreshMcp, openMcpServerDialog, openMcpDebugDialog, parseMcpArgs, parseMcpHeaders,
		// P8：IM 机器人凭证 / 启停 / ping / 回调说明 / outbox
		refreshIm, openImBotDialog, formatImCallbackAt,
		// P9：监控聚合 / 调用链 / 时间轴
		refreshMonitor, refreshMonitorSummary, refreshMonitorTraces, setMonitorRange, loadMoreMonitorTraces,
		openTraceDetail, formatDurationMs, formatPercent, tracePayloadFull };`,
	sandbox,
);

const flush = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));
await flush();

// 夹具开关与观测数组：测试里改夹具再让页面重画，比造第二套 DOM 干净
Object.assign(sandbox.__t, {
	setKbAvailable: (value) => {
		kbAvailable = value;
	},
	setKbEmbedding: (value) => {
		kbEmbedding = value;
	},
	setKbSearchMode: (mode) => {
		kbSearchMode = mode;
	},
	setKbStore: (value) => {
		kbStore = value;
	},
	setKbDeleteResult: (value) => {
		kbDeleteResult = value;
	},
	setKbDefaultIds: (ids) => {
		kbDefaultIds = Array.isArray(ids) ? [...ids] : [];
	},
	setKbDefaultsError: (status, message) => {
		kbDefaultsError = message ? { status: status ?? 400, message } : null;
	},
	setAuthMode: (mode) => {
		authMode = mode;
	},
	setAuthUser: (user) => {
		authUser = user;
	},
	setAuthPermissions: (permissions) => {
		authPermissions = permissions;
	},
	setLoginStatus: (status) => {
		loginStatus = status;
	},
	setMembersAvailable: (value) => {
		membersAvailable = value;
	},
	setMembersStatus: (status) => {
		membersStatus = status;
	},
	setMemberCreateError: (message) => {
		memberCreateError = message;
	},
	resetMemberStore: () => {
		memberStore = MEMBER_SEED.map((user) => ({ ...user }));
	},
	setMemberMutationError: (status, message) => {
		memberMutationError = message ? { status: status ?? 400, message } : null;
	},
	resetApprovalStore: () => {
		const now = Date.now();
		approvalStore = [
			{ ...APPROVAL_SEED[0], args: { ...APPROVAL_SEED[0].args }, askedAt: now - 42_000 },
			{ ...APPROVAL_SEED[1], args: { ...APPROVAL_SEED[1].args }, askedAt: now - 125_000 },
		];
		approvalPostStatus = 200;
		approvalPostError = null;
	},
	setApprovalsAvailable: (value) => {
		approvalsAvailable = value;
	},
	setApprovalsStatus: (status) => {
		approvalsStatus = status;
	},
	setApprovalPostStatus: (status, message) => {
		approvalPostStatus = status;
		approvalPostError = message ?? null;
	},
	setApprovalStore: (items) => {
		approvalStore = cloneJson(items);
	},
	setAuditAvailable: (value) => {
		auditAvailable = value;
	},
	setAuditStatus: (status) => {
		auditStatus = status;
	},
	resetAuditStore: () => {
		auditStore = seedAudit(120);
	},
	setHealthFixture: (patch) => {
		healthFixture = patch ?? {};
	},
	setModelsAvailable: (value) => {
		modelsAvailable = value;
	},
	setModelsStatus: (status) => {
		modelsStatus = status;
	},
	resetModelFixtures: () => {
		kbEmbedding = { ...KB_EMBEDDING_SEED };
		modelsAvailable = true;
		modelsStatus = 200;
		modelProviderStore = MODEL_SEED.map((item) => ({ ...item }));
		// 深拷贝：用例里改过模型行（启用/停用）不能污染别的用例
		modelRowStore = MODEL_ROW_SEED.map((item) => ({ ...item }));
		modelCurrent = "deepseek-chat";
		modelEmbeddingKey = null;
		modelPingResults = {};
	},
	setModelPingResult: (modelId, result) => {
		modelPingResults[modelId] = result;
	},
	setModelCurrent: (modelId) => {
		modelCurrent = modelId;
	},
	setModelEmbedding: (modelKey) => {
		modelEmbeddingKey = modelKey;
	},
	clearNotices: () => {
		els.threadInner.querySelectorAll(".notice").forEach((node) => node.remove());
	},
	setApiKeysAvailable: (value) => {
		apiKeysAvailable = value;
	},
	setApiKeysStatus: (status) => {
		apiKeysStatus = status;
	},
	resetApiKeyStore: () => {
		apiKeysAvailable = true;
		apiKeysStatus = 200;
		apiKeyStore = API_KEY_SEED.map((item) => ({ ...item }));
	},
	setPluginsAvailable: (value) => { pluginsAvailable = value; },
	setPluginsStatus: (status) => { pluginsStatus = status; },
	resetPluginFixtures: () => { pluginsAvailable = true; pluginsStatus = 200; pluginStore = []; },
	setMcpAvailable: (value) => {
		mcpAvailable = value;
	},
	setMcpStatus: (status) => {
		mcpStatus = status;
	},
	resetMcpFixtures: () => {
		mcpAvailable = true;
		mcpStatus = 200;
		mcpServerStore = cloneMcpServers();
	},
	setImAvailable: (value) => {
		imAvailable = value;
	},
	setImStatus: (status) => {
		imStatus = status;
	},
	setImOutboxAvailable: (value) => {
		imOutboxAvailable = value;
	},
	setImOutboxStatus: (status) => {
		imOutboxStatus = status;
	},
	setImPingError: (botId, message) => {
		if (message) imPingFailures[botId] = message;
		else delete imPingFailures[botId];
	},
	resetImFixtures: () => {
		imAvailable = true;
		imStatus = 200;
		imOutboxAvailable = true;
		imOutboxStatus = 200;
		imPingFailures = {};
		imBotStore = IM_BOT_SEED.map((bot) => ({ ...bot }));
		imOutboxStore = cloneJson(IM_OUTBOX_SEED);
	},
	setMonitorAvailable: (value) => {
		monitorAvailable = value;
	},
	setMonitorSummaryStatus: (status) => {
		monitorSummaryStatus = status;
	},
	setMonitorTracesStatus: (status) => {
		monitorTracesStatus = status;
	},
	setMonitorDetailStatus: (status) => {
		monitorDetailStatus = status;
	},
	setMonitorSummaryStore: (value) => {
		monitorSummaryStore = cloneJson(value);
	},
	setMonitorTraceStore: (value) => {
		monitorTraceStore = cloneJson(value);
	},
	resetMonitorFixtures: () => {
		monitorAvailable = true;
		monitorSummaryStatus = 200;
		monitorTracesStatus = 200;
		monitorDetailStatus = 200;
		monitorSummaryStore = cloneJson(MONITOR_SUMMARY_SEED);
		monitorTraceStore = seedMonitorTraces();
	},
	setConfirmAnswer: (value) => {
		confirmAnswer = value;
	},
	resetKbFixtures: () => {
		kbDefaultIds = [];
		kbDefaultsError = null;
		kbStore = [
			{ id: "kb-1", name: "产品文档", description: "产品手册、FAQ、发布说明", docCount: 2, chunkCount: 14, embedding: null },
			{ id: "kb-2", name: "客服话术", description: "", docCount: 1, chunkCount: 5, embedding: null },
		];
		kbDocs["kb-1"] = [
			{ id: "doc-1", filename: "产品手册.md", bytes: 2048, status: "ready", chunkCount: 9 },
			{ id: "doc-2", filename: "FAQ.pdf", bytes: 51200, status: "failed", chunkCount: 0, error: "扫描件没有文字层，解析不出内容" },
		];
	},
	calls,
	confirms,
	alerts,
	clipboardWrites,
	kbBindings: skillKbBindings,
	localStorageStore: sandbox.localStorage.store,
});

const t = sandbox.__t;
const els = t.els;
// 启动默认停在哪个模块（模块导航的初始值断言要用）
const initialModule = t.state.module;

/* ================= 1. 静态接线 ================= */

section("静态接线：文件与 DOM 对得上");

const htmlIds = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));
const usedIds = [...new Set([...appJs.matchAll(/getElementById\("([^"]+)"\)/g)].map((match) => match[1]))];

await check("app.js 引用的 DOM id 全部存在于 index.html", () => {
	const missing = usedIds.filter((id) => !htmlIds.has(id));
	assert.deepEqual(missing, [], `index.html 缺少：${missing.join(", ")}`);
});

await check("index.html 先加载 markdown.js 再加载 app.js", () => {
	const markdownAt = html.indexOf('src="/markdown.js"');
	const appAt = html.indexOf('src="/app.js"');
	assert.ok(markdownAt > 0 && appAt > markdownAt, `markdown.js@${markdownAt}, app.js@${appAt}`);
	assert.equal(typeof sandbox.renderMarkdown, "function", "markdown.js 应挂上 window.renderMarkdown");
});

await check("app.js 不再自带 markdown 实现，改为调用全局 renderMarkdown", () => {
	assert.ok(!/function renderMarkdown/.test(appJs), "渲染实现应只在 web/markdown.js 里");
	assert.ok((appJs.match(/renderMarkdown\(/g) ?? []).length >= 2, "finalizeAnswer 与历史会话都要走 renderMarkdown");
});

await check("关键 CSS 规则都在", () => {
	for (const rule of [
		".answer.streaming::after",
		".copy-fallback {",
		".code-block {",
		".table-wrap {",
		".tool:not(.open) .tool-body",
		".tool-head:focus-visible",
		".answer-actions {",
		".to-bottom[hidden]",
		".thread-foot {",
		".empty-chip {",
		".skill-chip {",
		".skill-side {",
		".skill-current {",
		".skill-list {",
		".skill-row.active {",
		".flow-tag.on {",
	]) {
		assert.ok(css.includes(rule), `style.css 缺少 ${rule}`);
	}
	assert.match(css, /\.table-wrap \{[^}]*overflow-x: auto/s, "宽表格要自己横向滚动");
	assert.match(css, /\.thread-foot \{[^}]*height: 0/s, "回到底部的锚点应是 0 高度");
});

await check("对话页已撤掉右侧技能栏：网格回到三列，DOM 仅保留（display: none）", () => {
	assert.match(css, /\.shell \{[^}]*grid-template-columns: 76px 258px minmax\(0, 1fr\);/s, "对话页就是三列");
	assert.match(css, /\.skill-side \{[^}]*display: none/s, "常驻技能栏视觉上彻底隐藏");
	assert.ok(!css.includes("56px 0 minmax(0, 1fr)"), "隐藏会话栏后不能保留零宽度列，否则主区会被挤进该列");
	assert.match(css, /\.skill-list \{[^}]*overflow-y: auto/s, "技能列表仍能自己滚（模块页复用同一套行）");
	assert.match(css, /\.skill-list \{[^}]*min-height: 0/s, "min-height:0 才滚得起来（否则撑破网格）");
});

await check("页头的技能胶囊只是状态显示：没有下拉菜单的接线", () => {
	for (const needle of ['id="skill-chip"', 'id="skill-chip-label"']) {
		assert.ok(html.includes(needle), `index.html 缺少 ${needle}`);
	}
	assert.match(html, /<span class="skill-chip" id="skill-chip"/, "胶囊应该是 span（不可点），不是 button");
	for (const gone of ['id="skill-menu"', 'id="skill-picker"', 'aria-haspopup="menu"', 'role="menu"']) {
		assert.ok(!html.includes(gone), `index.html 不该再有 ${gone}`);
	}
});

/* ================= 2. 空会话引导页 ================= */

section("空会话引导页");

await check("启动后铺出引导页（含 3 条示例 chip）", () => {
	assert.equal(els.threadInner.querySelectorAll(".empty").length, 1);
	assert.equal(els.threadInner.querySelectorAll(".empty-chip").length, 3);
	assert.equal(els.threadInner.querySelector(".empty-mark")?.textContent, "B");
	assert.equal(els.threadInner.querySelector(".empty h2")?.textContent, "今天想处理什么？");
});

await check("点示例 chip 只把文案填进输入框（不替用户发送）", async () => {
	const chips = els.threadInner.querySelectorAll(".empty-chip");
	assert.equal(chips[1].querySelector(".empty-chip-label") !== null, true, "chip 要有 label");
	assert.equal(chips[1].querySelector(".empty-chip-hint") !== null, true, "chip 要有领域提示");
	const messagesBefore = calls.filter((call) => /\/messages$/.test(call.url)).length;
	focusedElement = null;
	els.input.value = "";
	chips[1].click();
	assert.equal(els.input.value, "TK-1001 支付回调超时，指派李工并通知客户");
	assert.equal(focusedElement, els.input, "点完应把焦点给输入框");
	assert.equal(calls.filter((call) => /\/messages$/.test(call.url)).length, messagesBefore, "不该自动发消息");
	assert.equal(els.threadInner.querySelectorAll(".empty-chip").length, 3, "引导页不该被误清");
});

/* ================= 3. 流式输出与 finalizeAnswer ================= */

section("流式输出与 finalizeAnswer");

const MARKDOWN_ANSWER = [
	"## 汇总",
	"",
	"下面是结果：",
	"",
	"| 区域 | 金额 |",
	"| --- | --- |",
	"| 华东 | 12800 |",
	"| 华南 | 9600 |",
	"",
	"```js",
	"const total = 12800 + 9600;",
	'console.log("<b>&amp; done</b>", total);',
	"```",
	"",
	"行内 `code` 与 **粗体**。",
].join("\n");

await check("流式阶段按纯文本追加并带 streaming 类", () => {
	t.addUserMessage("把已支付订单按区域汇总金额");
	t.handle({ type: "text", delta: "正在" });
	t.handle({ type: "text", delta: "汇总…" });
	assert.equal(t.state.answerEl.classList.contains("streaming"), true, "流式期间要有方块光标");
	assert.equal(t.state.answerEl.textContent, "正在汇总…");
	assert.equal(els.threadInner.querySelectorAll(".empty").length, 0, "有消息后引导页应移除");
});

await check("finalizeAnswer 渲染 markdown 并去掉 streaming", () => {
	t.handle({ type: "done", text: MARKDOWN_ANSWER });
	const answer = els.threadInner.querySelectorAll(".answer")[0];
	assert.equal(answer.classList.contains("streaming"), false, "收尾要去掉 streaming");
	assert.equal(answer.style.whiteSpace, "", "收尾要清掉流式期的 pre-wrap");
	assert.ok(answer.innerHTML.includes("<table>"), "应渲染出表格");
	assert.equal(answer.querySelectorAll("td").length, 4, "两个数据行各两列");
	assert.equal(answer.querySelectorAll(".code-block").length, 1, "应渲染出围栏代码块");
	assert.equal(answer.querySelector(".code-lang")?.textContent, "js", "语言标签");
	assert.equal(answer.querySelectorAll('[data-role="copy-code"]').length, 1, "代码块复制按钮");
	assert.equal(answer.querySelector(".answer-actions .msg-action")?.textContent, "复制", "回答复制按钮");
	assert.equal(answer.querySelector("h2")?.textContent, "汇总", "标题成了真节点");
	assert.equal(answer.querySelector("strong")?.textContent, "粗体");
});

await check("模型输出的 HTML 只当文本（转义没被绕过）", () => {
	const answer = els.threadInner.querySelectorAll(".answer")[0];
	assert.ok(answer.innerHTML.includes("&lt;b&gt;"), "代码里的 <b> 应是转义后的文本");
	assert.equal(answer.querySelectorAll("b").length, 0, "不该冒出真实 <b> 标签");
	assert.equal(answer.querySelectorAll(".answer-actions").length, 1, ".answer-actions 只该有一份");
});

/* ================= 4. 复制 ================= */

section("复制：回答 / 代码块 / execCommand 兜底");

await check("点回答「复制」写入完整回答原文", async () => {
	const answer = els.threadInner.querySelectorAll(".answer")[0];
	const button = answer.querySelector(".answer-actions .msg-action");
	const before = clipboardWrites.length;
	button.click();
	await flush(10);
	assert.equal(clipboardWrites.length, before + 1, "应调用 clipboard.writeText");
	assert.equal(clipboardWrites[clipboardWrites.length - 1], MARKDOWN_ANSWER, "复制的应是 markdown 原文");
	assert.equal(button.textContent, "已复制", "按钮文案要临时变");
	assert.equal(button.classList.contains("copied"), true);
});

await check("点代码块「复制」经事件委托拿到代码原文", async () => {
	const answer = els.threadInner.querySelectorAll(".answer")[0];
	const button = answer.querySelector('[data-role="copy-code"]');
	const before = clipboardWrites.length;
	button.click();
	await flush(10);
	assert.equal(clipboardWrites.length, before + 1, "事件应从按钮冒泡到 #thread-inner");
	assert.equal(
		clipboardWrites[clipboardWrites.length - 1],
		'const total = 12800 + 9600;\nconsole.log("<b>&amp; done</b>", total);',
		"复制的应是代码原文（去围栏、还原转义）",
	);
	assert.equal(button.textContent, "已复制");
});

await check("剪贴板被拒时退回 execCommand 且清理临时 textarea", async () => {
	const answer = els.threadInner.querySelectorAll(".answer")[0];
	const button = answer.querySelector('[data-role="copy-code"]');
	clipboardDenied = true;
	const execBefore = execCommands.length;
	const writesBefore = clipboardWrites.length;
	button.click();
	await flush(10);
	clipboardDenied = false;
	assert.equal(execCommands.length, execBefore + 1, "应调用一次 document.execCommand");
	assert.equal(execCommands[execCommands.length - 1].command, "copy");
	assert.ok(execCommands[execCommands.length - 1].value?.includes("const total = 12800 + 9600;"), "兜底也要带上正确文本");
	assert.equal(body.children.filter((node) => node.classList?.contains("copy-fallback")).length, 0, "临时 textarea 要移除");
	assert.equal(clipboardWrites.length, writesBefore, "被拒时不该写成");
	assert.equal(els.threadInner.querySelectorAll(".notice.err").length, 0, "兜底成功不该报错");
});

await check("连点两次复制，按钮文案不会永久卡在「已复制」", async () => {
	const answer = els.threadInner.querySelectorAll(".answer")[0];
	const button = answer.querySelector(".answer-actions .msg-action");
	button.click();
	await flush(10);
	button.click();
	await flush(10);
	await flush(1300);
	assert.equal(button.textContent, "复制", "第二次点击不该把「已复制」记成原始文案");
	assert.equal(button.classList.contains("copied"), false);
});

/* ================= 5. 工具卡片：折叠阈值 + 键盘 ================= */

section("工具卡片：折叠阈值与键盘可达");

const LONG_OUTPUT = `查询结果：${"工单明细行 ".repeat(60)}`;

await check("tool_start 渲染运行中的卡片（默认展开）", () => {
	t.addUserMessage("查一下工单");
	t.handle({ type: "tool_start", id: "call-1", name: "ticket_search", args: { keyword: "TK-1001" } });
	const card = t.state.runEl.querySelectorAll(".tool")[0];
	assert.equal(card.classList.contains("open"), true);
	assert.equal(card.querySelector(".tool-status")?.textContent, "运行中");
	assert.equal(card.querySelector(".tool-caret")?.textContent, "›");
	assert.ok(card.querySelector(".tool-args")?.textContent.includes("TK-1001"), "参数摘要");
});

await check("标题行带按钮语义（role / tabindex / aria-expanded）", () => {
	const head = t.state.runEl.querySelectorAll(".tool")[0].querySelector(".tool-head");
	assert.equal(head.getAttribute("role"), "button");
	assert.equal(head.getAttribute("tabindex"), "0");
	assert.equal(head.getAttribute("aria-expanded"), "true");
	assert.equal(head.querySelectorAll("button").length, 0, "标题行里不该再塞真按钮（保持委托）");
});

await check("长输出（>320）默认收起，阈值边界 320 展开 / 321 收起", () => {
	assert.ok(LONG_OUTPUT.length > 320, "样本要比阈值长");
	t.handle({ type: "tool_end", id: "call-1", name: "ticket_search", ok: true, result: LONG_OUTPUT, durationMs: 42 });
	const card = t.state.runEl.querySelectorAll(".tool")[0];
	assert.equal(card.classList.contains("open"), false, "长输出应收起");
	assert.equal(card.querySelector(".tool-output")?.textContent, LONG_OUTPUT, "输出内容要完整");
	assert.equal(card.querySelector(".tool-status")?.textContent, "完成 · 42ms");
	assert.equal(card.querySelector(".tool-foot .msg-action")?.textContent, "复制输出");
	assert.equal(card.querySelector(".tool-head").getAttribute("aria-expanded"), "false", "aria-expanded 要跟着收起");

	t.handle({ type: "tool_start", id: "call-2", name: "ticket_search", args: {} });
	t.handle({ type: "tool_end", id: "call-2", name: "ticket_search", ok: true, result: "x".repeat(320) });
	assert.equal(Array.from(t.state.runEl.querySelectorAll(".tool")).at(-1).classList.contains("open"), true, "恰好 320 还算短输出");
	t.handle({ type: "tool_start", id: "call-3", name: "ticket_search", args: {} });
	t.handle({ type: "tool_end", id: "call-3", name: "ticket_search", ok: true, result: "x".repeat(321) });
	assert.equal(Array.from(t.state.runEl.querySelectorAll(".tool")).at(-1).classList.contains("open"), false, "321 就该收起");
});

await check("点标题行能来回 toggle，aria-expanded 同步", () => {
	const card = Array.from(t.state.runEl.querySelectorAll(".tool")).at(-1);
	const head = card.querySelector(".tool-head");
	head.click();
	assert.equal(card.classList.contains("open"), true);
	assert.equal(head.getAttribute("aria-expanded"), "true");
	head.click();
	assert.equal(card.classList.contains("open"), false);
	assert.equal(head.getAttribute("aria-expanded"), "false");
});

await check("键盘 Enter / Space 也能折叠，其他键不动", () => {
	const card = Array.from(t.state.runEl.querySelectorAll(".tool")).at(-1);
	const head = card.querySelector(".tool-head");
	focusedElement = head;
	head.focus();
	assert.equal(focusedElement, head, "先聚焦到标题行");

	const enter = head.dispatch("keydown", { key: "Enter" });
	assert.equal(card.classList.contains("open"), true, "Enter 应展开");
	assert.equal(head.getAttribute("aria-expanded"), "true");
	assert.equal(enter.defaultPrevented, true, "Enter 不该再触发别的默认行为");

	const space = head.dispatch("keydown", { key: " " });
	assert.equal(card.classList.contains("open"), false, "Space 应收起");
	assert.equal(head.getAttribute("aria-expanded"), "false");
	assert.equal(space.defaultPrevented, true, "Space 要阻止页面滚动");

	head.dispatch("keydown", { key: "a" });
	assert.equal(card.classList.contains("open"), false, "无关按键不该切换");
});

await check("「复制输出」写入完整工具结果", async () => {
	const card = t.state.runEl.querySelectorAll(".tool")[0];
	const button = card.querySelector(".tool-foot .msg-action");
	const before = clipboardWrites.length;
	button.click();
	await flush(10);
	assert.equal(clipboardWrites.length, before + 1);
	assert.equal(clipboardWrites[clipboardWrites.length - 1], LONG_OUTPUT);
});

/* ================= 6. 回到底部 ================= */

section("回到底部：阈值与滚动");

await check("按离底距离切 #to-bottom.hidden（0 / 239 / 240 / 1200）", () => {
	const messages = els.messages;
	messages.scrollHeight = 2000;
	messages.clientHeight = 600;
	messages.scrollTop = 1400;
	messages.dispatch("scroll");
	assert.equal(els.toBottom.hidden, true, "gap=0 隐藏");
	messages.scrollTop = 1161;
	messages.dispatch("scroll");
	assert.equal(els.toBottom.hidden, true, "gap=239 还在阈值内");
	messages.scrollTop = 1160;
	messages.dispatch("scroll");
	assert.equal(els.toBottom.hidden, false, "gap=240 该露出");
	messages.scrollTop = 200;
	messages.dispatch("scroll");
	assert.equal(els.toBottom.hidden, false, "gap=1200 当然露出");
});

await check("点 #to-bottom 平滑滚到底", () => {
	els.toBottom.click();
	const last = els.messages.scrollCalls.at(-1);
	assert.equal(last?.top, 2000);
	assert.equal(last?.behavior, "smooth");
});

await check("自己发消息强制滚到底，翻历史时流式输出不抢滚动", () => {
	const messages = els.messages;
	messages.scrollHeight = 5000;
	messages.clientHeight = 600;
	messages.scrollTop = 1000;
	t.appendText("新的流式片段");
	assert.equal(messages.scrollTop, 1000, "用户在往上翻时不该被拽回去");
	messages.scrollTop = 4400;
	t.appendText("又一段");
	assert.equal(messages.scrollTop, 5000, "在底部附近时要跟着走");
	messages.scrollTop = 1200;
	t.addUserMessage("自己发出去的一句");
	assert.equal(messages.scrollTop, 5000, "自己发消息一定到底");
});

await check("思考过程单独一块：先显示「思考中…」，正文一来改「思考过程」，不混进正文", () => {
	// 推理模型会先吐 thinking 再吐正文；以前前端只认 text，思考内容会被整段丢掉
	t.handle({ type: "thinking", delta: "我需要先检索知识库" });
	const box = t.state.runEl.querySelectorAll(".thinking")[0];
	assert.ok(box, "要有思考块");
	const toggle = box.querySelectorAll(".thinking__toggle")[0];
	assert.equal(toggle.textContent, "思考中…", "还没出正文时是「思考中…」");
	assert.equal(box.querySelectorAll(".thinking__body")[0].textContent, "我需要先检索知识库");

	t.handle({ type: "thinking", delta: "，再算一下。" });
	assert.equal(
		box.querySelectorAll(".thinking__body")[0].textContent,
		"我需要先检索知识库，再算一下。",
		"思考增量要累加",
	);

	t.handle({ type: "text", delta: "答案是 42。" });
	assert.equal(toggle.textContent, "思考过程", "正文开始后标题改为「思考过程」");
	const answer = t.state.answerEl.textContent;
	assert.equal(answer.includes("答案是 42。"), true);
	assert.equal(answer.includes("检索知识库"), false, "思考内容不能混进正文");
});

await check("普通提示不抢滚动，报错提示一定滚到底", () => {
	const messages = els.messages;
	messages.scrollTop = 1200;
	t.addNotice("已切换为完全访问模式。", false);
	assert.equal(messages.scrollTop, 1200, "普通提示不该打断阅读");
	t.addNotice("复制失败：浏览器不允许访问剪贴板。", true);
	assert.equal(messages.scrollTop, 5000, "报错必须让人看见");
});

/* ================= 7. Ctrl / ⌘ + K ================= */

section("Ctrl / ⌘ + K 搜索");

await check("Ctrl+K 打开搜索行、聚焦并阻止默认行为", () => {
	els.searchRow.hidden = true;
	focusedElement = null;
	const event = fireDocument("keydown", { key: "k", ctrlKey: true });
	assert.equal(els.searchRow.hidden, false);
	assert.equal(focusedElement, els.searchInput);
	assert.equal(event.defaultPrevented, true);
});

await check("⌘+K（大小写不敏感）同样生效", () => {
	els.searchRow.hidden = true;
	focusedElement = null;
	fireDocument("keydown", { key: "K", metaKey: true });
	assert.equal(els.searchRow.hidden, false);
	assert.equal(focusedElement, els.searchInput);
});

await check("裸 k 不触发；技能编辑器开着时也不抢焦点", () => {
	els.searchRow.hidden = true;
	focusedElement = null;
	fireDocument("keydown", { key: "k" });
	assert.equal(els.searchRow.hidden, true);

	els.flowModal.hidden = false;
	fireDocument("keydown", { key: "k", ctrlKey: true });
	assert.equal(els.searchRow.hidden, true, "弹窗里的输入焦点不该被抢走");
	assert.equal(focusedElement, null);
	els.flowModal.hidden = true;
});

await check("Esc 仍然关抽屉（回归）", () => {
	els.drawer.classList.add("open");
	fireDocument("keydown", { key: "Escape" });
	assert.equal(els.drawer.classList.contains("open"), false);
});

/* ================= 8. 会话归档 UI ================= */

section("会话归档 UI");

const ARCHIVED = {
	id: "archived-1",
	workflowId: "ticket-flow",
	workflowName: "工单处理",
	title: "归档掉的会话",
	archived: true,
	steps: [],
	updatedAt: 3,
};
const NORMAL = {
	id: "normal-1",
	workflowId: "ticket-flow",
	workflowName: "工单处理",
	title: "普通会话",
	archived: false,
	steps: [],
	updatedAt: 2,
};

await check("有归档会话时才出现「已归档」区，默认收起并显示计数", async () => {
	sessionStore = [NORMAL, ARCHIVED];
	await t.refreshSessions();
	assert.equal(els.archivedGroup.hidden, false);
	assert.equal(els.archivedCount.textContent, "1");
	assert.equal(els.archivedToggle.getAttribute("aria-expanded"), "false");
	assert.equal(els.archivedList.hidden, true, "默认收起");
});

await check("归档会话不进「会话」区，点折叠区才展开", () => {
	assert.equal(els.sessionList.querySelectorAll(".item").length, 1, "会话区只剩未归档会话");
	assert.equal(els.pinnedList.querySelectorAll(".item").length, 0);
	els.archivedToggle.click();
	assert.equal(els.archivedList.hidden, false);
	assert.equal(els.archivedToggle.getAttribute("aria-expanded"), "true");
	const items = Array.from(els.archivedList.querySelectorAll(".item"));
	assert.equal(items.length, 1);
	assert.equal(items[0].classList.contains("archived"), true, "归档项要弱化");
	assert.equal(items[0].querySelector(".label").textContent, "归档掉的会话");
});

await check("搜索命中归档会话时自动展开折叠区", () => {
	t.state.searchQuery = "归档";
	t.renderSidebar();
	assert.equal(els.archivedList.hidden, false);
	assert.equal(els.archivedList.querySelectorAll(".item").length, 1);
	t.state.searchQuery = "";
	t.state.archivedOpen = false;
	t.renderSidebar();
	assert.equal(els.archivedList.hidden, true);
});

await check("菜单项按归档状态切换「归档 / 取消归档」", () => {
	const labelsOf = (items) => items.filter((item) => item.label).map((item) => item.label).join("|");
	const normalLabels = labelsOf(t.sessionMenuItems(sessionStore[0], new El("div")));
	const archivedLabels = labelsOf(t.sessionMenuItems(sessionStore[1], new El("div")));
	assert.ok(normalLabels.includes("归档"), `未归档应有「归档」：${normalLabels}`);
	assert.ok(!normalLabels.includes("取消归档"));
	assert.ok(archivedLabels.includes("取消归档"), `已归档应有「取消归档」：${archivedLabels}`);
	assert.ok(!archivedLabels.includes("置顶"), "已归档不再显示置顶");
});

await check("取消归档发 PATCH {archived:false} 并同步头部/会话区", async () => {
	await t.openSession("archived-1");
	assert.equal(els.archivedBadge.hidden, false, "头部应出现「已归档」标记");
	assert.equal(els.unarchiveBtn.hidden, false, "头部应出现「取消归档」按钮");
	els.unarchiveBtn.click();
	await flush(15);
	const patchCall = calls.filter((call) => call.method === "PATCH").at(-1);
	assert.equal(patchCall?.url, "/api/sessions/archived-1");
	assert.deepEqual(patchCall?.body, { archived: false }, "PATCH body 只带 archived");
	assert.equal(sessionStore.find((item) => item.id === "archived-1").archived, false);
	assert.equal(els.archivedBadge.hidden, true, "取消归档后标记要消失");
	assert.equal(els.sessionList.querySelectorAll(".item").length, 2, "会话回到会话区");
});

await check("归档区里的会话行也带技能徽标", async () => {
	sessionStore = [
		NORMAL,
		{ ...ARCHIVED, archived: true, activeSkillId: "data-flow", skills: skillCatalog() },
	];
	t.state.archivedOpen = true;
	await t.refreshSessions();
	const archivedRow = Array.from(els.archivedList.querySelectorAll(".item")).find(
		(node) => node.dataset.sessionId === "archived-1",
	);
	assert.ok(archivedRow, "归档区应有这一行");
	assert.equal(archivedRow.querySelector(".skill-tag")?.textContent, "销售数据分析");
	t.state.archivedOpen = false;
});

/* ================= 9. 左栏：会话平铺、没有「流程」入口 ================= */

section("左栏：会话平铺、没有「流程」入口");

// 断言用的是"用户能看到的 HTML"：注释里提到「流程」不算，去掉注释再看
const visibleHtml = html.replace(/<!--[\s\S]*?-->/g, "");

await check("左栏没有流程区与「新建流程」入口，改成平铺的「会话」区", () => {
	assert.ok(!htmlIds.has("flow-groups"), "不该再有 #flow-groups");
	assert.ok(!htmlIds.has("btn-new-flow"), "不该再有「新建流程」按钮");
	assert.ok(!htmlIds.has("skill-groups"), "技能区从左栏搬走了");
	assert.ok(htmlIds.has("session-list"), "会话区要在左栏");
	assert.ok(html.includes('<div class="group-label">会话</div>'), "小节标题叫「会话」");
	const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((match) => match[1]);
	assert.deepEqual(scripts, ["/markdown.js", "/app.js"], "脚本加载顺序没变");
});

await check("index.html 里一个「流程」字样都没有（去掉注释后）", () => {
	assert.ok(!visibleHtml.includes("流程"), "用户看到的文案不该再出现「流程」");
	assert.ok(!visibleHtml.includes("新建流程"));
	assert.ok(!visibleHtml.includes("流程进度"), "抽屉小节也不再叫「流程进度」");
	assert.ok(visibleHtml.includes("技能名称"), "编辑器字段叫「技能名称」");
	assert.ok(visibleHtml.includes("新建技能"));
});

await check("会话平铺：不同来源的会话都进同一个列表，没有嵌套/分组", async () => {
	sessionStore = [
		{ id: "s-auto", workflowId: "auto-flow", workflowName: "自动编排", title: "自由聊天", archived: false, steps: [], updatedAt: 10 },
		{ id: "s-ticket", workflowId: "ticket-flow", workflowName: "工单处理", title: "工单会话", archived: false, steps: [], updatedAt: 20 },
		{ id: "s-data", workflowId: "data-flow", workflowName: "销售数据分析", title: "数据会话", archived: false, steps: [], updatedAt: 30 },
	];
	t.state.pinned = new Set();
	await t.refreshSessions();
	const rows = Array.from(els.sessionList.querySelectorAll(".item"));
	assert.equal(rows.length, 3, "三条会话都该平铺出来");
	assert.deepEqual(
		rows.map((row) => row.dataset.sessionId),
		["s-data", "s-ticket", "s-auto"],
		"按 updatedAt 倒序：最近的排最上面",
	);
	assert.equal(els.sessionList.querySelectorAll(".item.nested").length, 0, "不再有嵌套行");
	assert.equal(els.sessionList.querySelectorAll(".flow-row").length, 0, "不再有分组标题行");
});

await check("置顶会话只出现在置顶区，不在「会话」区重复", async () => {
	t.state.pinned = new Set(["s-ticket"]);
	t.renderSidebar();
	const pinnedRows = Array.from(els.pinnedList.querySelectorAll(".item")).map((row) => row.dataset.sessionId);
	const restRows = Array.from(els.sessionList.querySelectorAll(".item")).map((row) => row.dataset.sessionId);
	assert.deepEqual(pinnedRows, ["s-ticket"]);
	assert.deepEqual(restRows, ["s-data", "s-auto"], "置顶的那条从会话区拿掉");
	t.state.pinned = new Set();
});

await check("没有会话时「会话」区给占位文案", async () => {
	sessionStore = [];
	await t.refreshSessions();
	const placeholder = els.sessionList.querySelector(".placeholder");
	assert.ok(placeholder, "空列表要有占位");
	assert.ok(placeholder.textContent.includes("新聊天"), `占位要引导用户新建：${placeholder.textContent}`);
});

/* ================= 10. 右栏常驻技能面板 ================= */

section("右栏常驻技能面板");

const skillListRequestCount = () => calls.filter((call) => call.method === "GET" && call.url === "/api/skills").length;
const skillPosts = () => calls.filter((call) => call.method === "POST" && /\/skills$/.test(call.url));
const skillRowOf = (id) =>
	Array.from(els.skillList.querySelectorAll(".skill-row")).find((row) => row.dataset.skillId === id) ?? null;
const activeSkillRows = () => Array.from(els.skillList.querySelectorAll(".skill-row.active"));

const SKILL_SESSION = {
	id: "skill-1",
	workflowId: "auto-flow",
	workflowName: "自动编排",
	title: "技能自检会话",
	archived: false,
	skills: skillCatalog(),
	activeSkillId: null,
	steps: [],
	updatedAt: 5,
};

await check("右栏技能列表渲染 5 行：内置 3 条 + 自定义 2 条（自动编排不列）", async () => {
	sessionStore = [{ ...SKILL_SESSION, skills: skillCatalog() }];
	await t.refreshSessions();
	await t.openSession("skill-1");
	await t.refreshSkillCatalog();
	const rows = Array.from(els.skillList.querySelectorAll(".skill-row"));
	assert.equal(rows.length, 5, "技能目录 6 条，去掉「自动编排」应剩 5 条");
	assert.equal(skillRowOf("auto-flow"), null, "「自动编排」是默认模式，不该出现在技能列表里");
	assert.deepEqual(
		rows.map((row) => row.dataset.skillId),
		["ticket-flow", "data-flow", "approval-flow", "report-flow", "calc-flow"],
		"按目录顺序渲染",
	);
	assert.equal(skillRowOf("ticket-flow").querySelector(".flow-tag")?.textContent, "内置", "内置技能要带角标");
	assert.equal(skillRowOf("report-flow").querySelectorAll(".flow-tag").length, 0, "自定义技能不加角标");
});

await check("技能行：一行名字 + 一行说明（悬停能看到全文），整行键盘可达", () => {
	const row = skillRowOf("data-flow");
	assert.equal(row.querySelector(".skill-row-name").textContent, "销售数据分析");
	assert.equal(row.querySelector(".skill-row-desc").textContent, "按区域汇总销售额并给出结论");
	assert.ok(row.title.includes("销售数据分析") && row.title.includes("按区域汇总"), `title 要带说明：${row.title}`);
	assert.equal(row.getAttribute("role"), "button", "整行可点，语义要是 button");
	assert.equal(row.tabIndex, 0, "键盘能聚焦");
	assert.equal(row.querySelectorAll(".more").length, 1, "每行一个「⋯」");
});

await check("点技能行：发 POST {skillId}，行高亮 + 当前技能块 + 页头胶囊 + 步骤条一起变", async () => {
	const before = skillPosts().length;
	skillRowOf("data-flow").click();
	await flush(25);
	const posts = skillPosts();
	assert.equal(posts.length, before + 1, "点一次只发一次请求");
	assert.equal(posts.at(-1).url, "/api/sessions/skill-1/skills");
	assert.deepEqual(posts.at(-1).body, { skillId: "data-flow" });
	assert.equal(activeSkillRows()[0]?.dataset.skillId, "data-flow", "当前技能行要高亮");
	assert.equal(skillRowOf("data-flow").querySelector(".flow-tag.on")?.textContent, "使用中");
	assert.equal(els.skillCurrentName.textContent, "销售数据分析");
	assert.equal(els.skillCurrentName.classList.contains("on"), true);
	assert.equal(els.skillCurrentMeta.textContent, "当前技能 · 3 步");
	assert.equal(els.skillCurrentExit.hidden, false, "加载后才有「退出技能」");
	assert.equal(els.skillChipLabel.textContent, "技能：销售数据分析");
	assert.equal(els.skillChip.classList.contains("on"), true);
	assert.equal(els.stepbar.querySelectorAll(".step-chip").length, 3, "步骤条换成技能的 3 个步骤");
});

await check("换一条技能：「使用中」跟着搬走，旧行不再高亮", async () => {
	skillRowOf("ticket-flow").click();
	await flush(25);
	assert.equal(activeSkillRows().length, 1, "同时只能有一条在使用");
	assert.equal(activeSkillRows()[0].dataset.skillId, "ticket-flow");
	assert.equal(skillRowOf("data-flow").classList.contains("active"), false);
	assert.equal(els.skillCurrentName.textContent, "工单处理");
	assert.equal(els.stepbar.querySelectorAll(".step-chip").length, 1);
});

await check("重复点同一个技能：不再发请求，也不重复提示", async () => {
	const before = skillPosts().length;
	const notices = els.threadInner.querySelectorAll(".notice").length;
	skillRowOf("ticket-flow").click();
	await flush(20);
	assert.equal(skillPosts().length, before, "已经是当前技能就别再请求");
	assert.equal(els.threadInner.querySelectorAll(".notice").length, notices, "也别重复弹提示");
});

await check("键盘 Enter / Space 也能加载技能（不必用鼠标）", async () => {
	const before = skillPosts().length;
	const row = skillRowOf("approval-flow");
	row.dispatch("keydown", { key: "Enter" });
	await flush(20);
	assert.equal(skillPosts().length, before + 1, "Enter 应触发加载");
	assert.equal(els.skillCurrentName.textContent, "费用审批");
});

await check("没有当前会话时点技能行：提示先开会话，不发请求", async () => {
	const view = t.state.currentView;
	const id = t.state.currentId;
	const before = skillPosts().length;
	t.state.currentView = null;
	t.state.currentId = null;
	skillRowOf("data-flow").click();
	await flush(20);
	const notice = Array.from(els.threadInner.querySelectorAll(".notice.err")).at(-1);
	const posts = skillPosts().length;
	// 先把状态放回去再断言：断言失败也不能把后面的用例带崩
	t.state.currentView = view;
	t.state.currentId = id;
	assert.ok(notice && notice.textContent.includes("先新建聊天"), `要提示先开会话：${notice?.textContent}`);
	assert.equal(posts, before, "没有会话就不该发请求");
});

await check("切换失败时有可见错误提示（未知技能 400）", async () => {
	const savedCatalog = [...t.state.skillCatalog];
	t.state.skillCatalog = [...savedCatalog, { id: "ghost-skill", name: "幽灵技能", description: "", steps: 1, builtin: false }];
	t.renderSkillList();
	skillRowOf("ghost-skill").click();
	await flush(20);
	const notice = Array.from(els.threadInner.querySelectorAll(".notice.err")).at(-1);
	assert.ok(notice && notice.textContent.includes("未注册的技能"), `400 要显示出来：${notice?.textContent}`);
	assert.equal(els.skillChipLabel.textContent, "技能：费用审批", "失败不该改掉当前技能");
	t.state.skillCatalog = savedCatalog;
	t.renderSkillList();
	await t.refreshSkillCatalog();
});

await check("SSE skill 事件：右栏高亮与当前技能块同步（skillId:null 复位）", () => {
	t.handle({ type: "skill", skillId: "report-flow", name: "周报助手", description: "每周五汇总本周数据" });
	assert.equal(activeSkillRows()[0]?.dataset.skillId, "report-flow", "模型自己加载技能，右栏也要跟上");
	assert.equal(els.skillCurrentName.textContent, "周报助手");
	assert.equal(els.skillCurrentExit.hidden, false);
	assert.equal(els.skillChipLabel.textContent, "技能：周报助手");

	t.handle({ type: "skill", skillId: null, name: "", description: "" });
	assert.equal(activeSkillRows().length, 0);
	assert.equal(els.skillCurrentName.textContent, "未加载技能");
	assert.equal(els.skillCurrentExit.hidden, true);
	assert.equal(els.skillCurrentMeta.textContent, "模型会按你的话自己挑；也可以在这里点一条装进来");
	assert.equal(els.skillChipLabel.textContent, "技能：无");
});

await check("「退出技能」发 {skillId:null} 并复位胶囊 / 当前技能块", async () => {
	await t.setSkill("data-flow");
	await flush(20);
	const before = skillPosts().length;
	els.skillCurrentExit.click();
	await flush(20);
	const posts = skillPosts();
	assert.equal(posts.length, before + 1);
	assert.deepEqual(posts.at(-1).body, { skillId: null });
	assert.equal(els.skillChipLabel.textContent, "技能：无");
	assert.equal(els.skillCurrentName.textContent, "未加载技能");
	assert.equal(els.skillCurrentExit.hidden, true);
	assert.equal(activeSkillRows().length, 0);
});

await check("技能目录为空时列表给占位文案", async () => {
	const saved = t.state.skillCatalog;
	t.state.skillCatalog = [];
	t.renderSkillList();
	assert.equal(els.skillList.querySelectorAll(".skill-row").length, 0);
	const placeholder = els.skillList.querySelector(".placeholder");
	assert.ok(placeholder && placeholder.textContent.includes("新建"), `空目录要引导新建：${placeholder?.textContent}`);
	t.state.skillCatalog = saved;
	t.renderSkillList();
});

/* ================= 11. 技能编辑器（新建 / 编辑 / 只读） ================= */

section("技能编辑器（复用同一个弹窗）");

await check("右栏「＋」打开编辑器：标题「新建技能」、默认没有步骤、高级区收起", async () => {
	documentStub.getElementById("btn-new-skill").click();
	await flush(20);
	assert.equal(els.flowModal.hidden, false);
	assert.equal(els.flowModalTitle.textContent, "新建技能");
	assert.equal(els.flowSkillDesc.disabled, false, "新建时「什么时候用它」可以填");
	assert.equal(documentStub.activeElement, els.flowSkillDesc, "焦点直接送到「什么时候用它」");
	assert.equal(els.flowStepsBox.querySelectorAll(".flow-step").length, 0, "技能默认不给步骤：工具由模型自己挑");
	assert.equal(
		els.flowStepsBox.querySelector(".placeholder")?.textContent.includes("自己决定"),
		true,
		"没有步骤时要说清：模型自己决定调哪些工具",
	);
	const advanced = documentStub.getElementById("flow-advanced");
	assert.equal(advanced.open, false, "高级区（步骤 + 系统提示）默认收起");
	els.flowAddStep.click();
	assert.equal(els.flowStepsBox.querySelectorAll(".flow-step").length, 1, "点「＋ 添加步骤」才出现步骤");
	assert.equal(els.flowStepsBox.querySelectorAll(".tool-group").length, 3, "工具目录 3 个分类");
	assert.equal(els.flowStepsBox.querySelectorAll(".tool-chip").length, 4, "4 个工具");
	const removeBtn = els.flowStepsBox.querySelector(".flow-step .mini-btn.danger");
	removeBtn.click();
	assert.equal(els.flowStepsBox.querySelectorAll(".flow-step").length, 0, "删到零步是允许的（不是错误）");
});

await check("只写说明和正文（零步骤）就能保存：steps 传空数组", async () => {
	const beforeCatalog = skillListRequestCount();
	els.flowName.value = "退款处理";
	els.flowName.dispatch("input");
	els.flowSkillDesc.value = "用户要退货退款或查退款进度时用它";
	els.flowSkillDesc.dispatch("input");
	els.flowSkillInst.value = "先核对订单，再发起退款，最后告诉用户预计到账时间。";
	els.flowSkillInst.dispatch("input");
	await t.saveFlow();
	await flush(20);
	const postCall = calls.filter((call) => call.method === "POST" && call.url === "/api/workflows").at(-1);
	assert.ok(postCall, "应发出 POST /api/workflows");
	assert.deepEqual(postCall.body.steps, [], "没有步骤就是空数组，不是报错");
	assert.deepEqual(postCall.body.skill, {
		description: "用户要退货退款或查退款进度时用它",
		instructions: "先核对订单，再发起退款，最后告诉用户预计到账时间。",
	});
	assert.equal(
		postCall.body.systemPrompt,
		"先核对订单，再发起退款，最后告诉用户预计到账时间。",
		"没填系统提示时用指导书正文兜底（服务端必填）",
	);
	assert.equal(els.flowModal.hidden, true);
	assert.ok(skillListRequestCount() > beforeCatalog, "保存后要重新拉技能目录");
});

await check("填表 + 勾工具 + 加步骤 + 技能文案后保存：POST 带 skill，右栏重新拉目录", async () => {
	const beforeCatalog = skillListRequestCount();
	documentStub.getElementById("btn-new-skill").click();
	await flush(20);
	els.flowName.value = "退款处理";
	els.flowName.dispatch("input");
	els.flowSkillDesc.value = "需要退货退款时用它";
	els.flowSkillDesc.dispatch("input");
	els.flowSkillInst.value = "先核对订单，再发起退款。";
	els.flowSkillInst.dispatch("input");
	els.flowAddStep.click();
	const firstStep = els.flowStepsBox.querySelectorAll(".flow-step")[0];
	const titleInput = firstStep.querySelectorAll(".field-input")[0];
	titleInput.value = "核对订单";
	titleInput.dispatch("input");
	const firstChip = Array.from(firstStep.querySelectorAll("input")).filter((node) => node.type === "checkbox")[0];
	firstChip.checked = true;
	firstChip.dispatch("change");
	assert.equal(firstChip.parentNode.classList.contains("checked"), true, "勾选后 chip 要高亮");

	assert.equal(els.flowStepsBox.querySelectorAll(".flow-step").length, 1);
	els.flowAddStep.click();
	assert.equal(els.flowStepsBox.querySelectorAll(".flow-step").length, 2);
	const secondStep = els.flowStepsBox.querySelectorAll(".flow-step")[1];
	secondStep.querySelectorAll(".field-input")[0].value = "发起退款";
	secondStep.querySelectorAll(".field-input")[0].dispatch("input");
	const secondChip = Array.from(secondStep.querySelectorAll("input")).filter((node) => node.type === "checkbox")[0];
	secondChip.checked = true;
	secondChip.dispatch("change");

	await t.saveFlow();
	await flush(20);
	const postCall = calls.filter((call) => call.method === "POST" && call.url === "/api/workflows").at(-1);
	assert.ok(postCall, "应发出 POST /api/workflows");
	assert.equal(postCall.body.name, "退款处理");
	assert.equal(postCall.body.steps.length, 2, "两个步骤都带上了");
	assert.deepEqual(postCall.body.skill, { description: "需要退货退款时用它", instructions: "先核对订单，再发起退款。" });
	assert.equal(els.flowModal.hidden, true, "保存成功应关窗");
	assert.ok(skillListRequestCount() > beforeCatalog, "保存后右栏要重新拉一次技能目录");
});

await check("不填「什么时候用它」直接拦下：不发请求，焦点回到该字段", async () => {
	documentStub.getElementById("btn-new-skill").click();
	await flush(20);
	const before = calls.filter((call) => call.method === "POST" && call.url === "/api/workflows").length;
	els.flowName.value = "没有说明的技能";
	els.flowName.dispatch("input");
	els.flowSkillInst.value = "正文写了但不说是啥时候用。";
	els.flowSkillInst.dispatch("input");
	await t.saveFlow();
	await flush(20);
	assert.equal(
		calls.filter((call) => call.method === "POST" && call.url === "/api/workflows").length,
		before,
		"说明必填：不满足就不发请求",
	);
	assert.ok(els.flowError.textContent.includes("什么时候用它"), `错误要指出缺哪个字段：${els.flowError.textContent}`);
	assert.equal(documentStub.activeElement, els.flowSkillDesc, "焦点回到「什么时候用它」");
	assert.equal(els.flowModal.hidden, false, "弹窗不关，用户可以接着补");
});

await check("说明填了但正文与系统提示都空：拦下并提示补正文", async () => {
	// 上个用例停在"缺说明"上：这里补上说明、并把正文与系统提示显式清空
	els.flowName.value = "缺正文的技能";
	els.flowName.dispatch("input");
	els.flowSkillInst.value = "";
	els.flowSkillInst.dispatch("input");
	els.flowPrompt.value = "";
	els.flowPrompt.dispatch("input");
	els.flowSkillDesc.value = "只写了触发条件";
	els.flowSkillDesc.dispatch("input");
	await t.saveFlow();
	await flush(20);
	assert.ok(
		els.flowError.textContent.includes("指导书正文") || els.flowError.textContent.includes("系统提示"),
		`要提示补正文或系统提示：${els.flowError.textContent}`,
	);
	assert.equal(els.flowModal.hidden, false);
	t.closeFlowEditor(true);
});
await check("正文留空时 skill 只带说明（不编造 instructions）", async () => {
	documentStub.getElementById("btn-new-skill").click();
	await flush(20);
	els.flowName.value = "只有步骤的技能";
	els.flowName.dispatch("input");
	els.flowPrompt.value = "只当步骤用";
	els.flowPrompt.dispatch("input");
	els.flowSkillDesc.value = "临时说明";
	els.flowSkillDesc.dispatch("input");
	els.flowAddStep.click();
	const step = els.flowStepsBox.querySelectorAll(".flow-step")[0];
	step.querySelectorAll(".field-input")[0].value = "跑一步";
	step.querySelectorAll(".field-input")[0].dispatch("input");
	const chip = Array.from(step.querySelectorAll("input")).filter((node) => node.type === "checkbox")[0];
	chip.checked = true;
	chip.dispatch("change");
	await t.saveFlow();
	await flush(20);
	const postCall = calls.filter((call) => call.method === "POST" && call.url === "/api/workflows").at(-1);
	// 说明是必填的（服务端保持可选是为了兼容老数据），所以这里只可能缺正文
	assert.deepEqual(
		postCall.body.skill,
		{ description: "临时说明" },
		`正文空时不带 instructions：${JSON.stringify(postCall.body.skill)}`,
	);
});

await check("编辑技能：回填技能文案与步骤，PATCH 回同一个 id", async () => {
	await t.openFlowEditor({ id: "report-flow", name: "周报助手", builtin: false }, { title: "编辑技能" });
	assert.equal(els.flowModalTitle.textContent, "编辑技能");
	assert.equal(els.flowSkillDesc.value, "每周五汇总本周数据");
	assert.equal(els.flowSkillInst.value, "先拉数据，再按模板写周报。");
	assert.equal(els.flowStepsBox.querySelectorAll(".flow-step").length, 2, "步骤也要回填");
	assert.equal(els.flowSave.hidden, false);
	t.closeFlowEditor(true);
});

await check("内置技能只读：标题「查看技能」，字段与步骤都不能改", async () => {
	await t.openFlowEditor({ id: "ticket-flow", name: "工单处理", builtin: true });
	assert.equal(els.flowModalTitle.textContent, "查看技能", "内置技能默认就是只读查看");
	assert.equal(els.flowName.disabled, true);
	assert.equal(els.flowSkillDesc.disabled, true);
	assert.equal(els.flowSave.hidden, true, "只读模式隐藏保存");
	assert.equal(els.flowAddStep.hidden, true, "只读模式不能加步骤");
	assert.equal(els.flowCancel.textContent, "关闭");
	els.flowCancel.click();
	assert.equal(els.flowModal.hidden, true);
});

await check("编辑器字段叫「技能名称」，两个技能文案字段有长度上限", () => {
	assert.ok(visibleHtml.includes("技能名称"), "字段标签要是「技能名称」");
	assert.ok(!visibleHtml.includes("流程名称"), "不该再有「流程名称」");
	assert.match(html, /id="flow-skill-desc"[^>]*maxlength="200"/, "一句话说明上限 200");
	assert.match(html, /id="flow-skill-inst"[^>]*maxlength="4000"/, "技能正文上限 4000");
	assert.ok(visibleHtml.includes("什么时候用它"), "说明字段要叫「什么时候用它」");
	assert.ok(visibleHtml.includes("高级：固定步骤与工具"), "步骤与系统提示收进高级区");
	assert.ok(!visibleHtml.includes("技能一句话说明"), "别再叫「技能一句话说明」（用户看不懂这句话管什么）");
});

await check("保存失败时把服务端的错误显示在弹窗里（不用 alert）", async () => {
	documentStub.getElementById("btn-new-skill").click();
	await flush(20);
	els.flowName.value = "";
	els.flowName.dispatch("input");
	await t.saveFlow();
	assert.ok(els.flowError.textContent.includes("技能名称"), `要提示技能名称：${els.flowError.textContent}`);
	assert.equal(els.flowError.hidden, false);
	assert.equal(alerts.length, 0, "整轮自检不该弹任何 alert");
	t.closeFlowEditor(true);
});

/* ================= 12. 技能行菜单 + 删除 ================= */

section("技能行菜单与删除");

await check("「⋯」菜单：内置只有「查看技能」，自定义给查看 / 编辑 / 删除", () => {
	const labelsOf = (items) => items.filter((item) => item.label).map((item) => item.label).join("|");
	// P5 起每行都多一项「绑定知识库」（内置技能也能绑）
	assert.equal(
		labelsOf(t.skillRowMenuItems({ id: "data-flow", name: "销售数据分析", builtin: true, steps: 3 })),
		"查看技能|绑定知识库",
	);
	assert.equal(
		labelsOf(t.skillRowMenuItems({ id: "report-flow", name: "周报助手", builtin: false, steps: 2 })),
		"查看技能|绑定知识库|编辑技能|删除技能",
	);
});

await check("模型选择菜单：异步取模型列表后仍贴着按钮弹出（currentTarget 不能在 await 之后读）", async () => {
	// 真浏览器里事件派发一结束 currentTarget 就是 null；以前在 await 之后才读，
	// getBoundingClientRect() 直接抛错，菜单落到左上角
	// 不碰 modelsAvailable：后面的模型页/设置页用例依赖当前夹具形态
	// 点开菜单只是"看选项"：它读 state.currentView.modelId 决定打勾，
	// 所以先确保有一个当前会话，避免用例受前文时序影响（点选项才新建会话）
	const sessionsBefore = t.state.sessions.length;
	els.modelSelect.click();
	await flush(30);
	assert.equal(t.state.sessions.length, sessionsBefore, "点开菜单不该新建会话");
	assert.equal(els.menu.hidden, false, "菜单要打开");
	assert.equal(Array.from(els.menu.querySelectorAll(".menu-item")).length > 0, true, "菜单里要有模型项");
	// 定位必须基于按钮矩形（桩里 left=10/top=10/bottom=34），不能是空值或 NaN
	assert.equal(els.menu.style.left, "10px", `菜单左边缘贴按钮（实际 ${els.menu.style.left}）`);
	assert.equal(els.menu.style.top, "40px", `菜单在按钮下方 6px（实际 ${els.menu.style.top}）`);
	els.menu.hidden = true;
});

/* 斜杠命令面板：输入框敲 / 弹出可执行命令 */

await check("敲 / 弹出命令面板，列出压缩 / 计划模式 / 技能等命令", async () => {
	els.input.value = "/";
	els.input.dispatch("input");
	await flush(20);
	assert.equal(els.slash.hidden, false, "面板要展开");
	const labels = Array.from(els.slash.querySelectorAll(".slash-item")).map((node) =>
		node.querySelector(".slash-item__label").textContent,
	);
	for (const expected of ["压缩", "计划模式", "加载技能", "退出技能", "设定目标", "归档当前对话", "新建对话"]) {
		assert.equal(labels.includes(expected), true, `命令列表里要有「${expected}」：${labels.join("|")}`);
	}
});

await check("继续输入就过滤命令（中文与拼音都能命中）", async () => {
	els.input.value = "/压";
	els.input.dispatch("input");
	await flush(10);
	let labels = Array.from(els.slash.querySelectorAll(".slash-item")).map((node) =>
		node.querySelector(".slash-item__label").textContent,
	);
	assert.equal(labels.length, 1, `「/压」只剩压缩：${labels.join("|")}`);
	assert.equal(labels[0], "压缩");

	els.input.value = "/yasuo";
	els.input.dispatch("input");
	await flush(10);
	labels = Array.from(els.slash.querySelectorAll(".slash-item")).map((node) =>
		node.querySelector(".slash-item__label").textContent,
	);
	assert.equal(labels[0], "压缩", `拼音 alias 也要能命中：${labels.join("|")}`);
});

await check("上下键换高亮，回车执行命令并把输入框清空（不把斜杠发出去）", async () => {
	els.input.value = "/";
	els.input.dispatch("input");
	await flush(10);
	const before = els.menu.hidden;
	els.input.dispatch("keydown", { key: "ArrowDown" });
	await flush(10);
	const activeId = els.slash.querySelectorAll(".slash-item.active")[0]?.dataset.slashId;
	assert.equal(activeId, "plan", `下键把高亮移到第二项：${String(activeId)}`);

	const noticesBefore = els.threadInner.querySelectorAll(".notice").length;
	els.input.dispatch("keydown", { key: "Enter" });
	await flush(20);
	assert.equal(els.input.value, "", "执行命令后输入框要清空，不能把 / 当消息发出去");
	assert.equal(els.slash.hidden, true, "执行后收起面板");
	before;
	// 计划模式需要当前会话；没有会话时给中文提示而不是静默失败
	assert.ok(
		els.threadInner.querySelectorAll(".notice").length >= noticesBefore,
		"执行命令不该抛错",
	);
});

await check("按空格/写正文后收起面板；Esc 收起", async () => {
	els.input.value = "/压缩 这段";
	els.input.dispatch("input");
	await flush(10);
	assert.equal(els.slash.hidden, true, "敲了空格说明在写正文，面板要收起");

	els.input.value = "/xiangqing";
	els.input.dispatch("input");
	await flush(10);
	assert.equal(els.slash.hidden, false, "重新输入斜杠要能再打开");
	els.input.dispatch("keydown", { key: "Escape" });
	await flush(10);
	assert.equal(els.slash.hidden, true, "Esc 收起");
	els.input.value = "";
	els.input.dispatch("input");
});

await check("技能目录里的技能也进命令面板，选中即加载", async () => {
	els.input.value = "/";
	els.input.dispatch("input");
	await flush(10);
	const labels = Array.from(els.slash.querySelectorAll(".slash-item")).map((node) =>
		node.querySelector(".slash-item__label").textContent,
	);
	// 左边四条是五项命令 + 技能目录（自动编排被过滤掉，和服务端面板一致）
	assert.equal(labels.includes("销售数据分析"), true, `技能要出现在面板里：${labels.join("|")}`);
	assert.equal(labels.includes("自动编排"), false, "自动编排不该出现在面板里");
	els.input.dispatch("keydown", { key: "Escape" });
	els.input.value = "";
	els.input.dispatch("input");
});

await check("「⋯」不会顺带把技能加载进会话（事件不外溢）", async () => {
	const before = skillPosts().length;
	skillRowOf("data-flow").querySelector(".more").click();
	await flush(20);
	assert.equal(skillPosts().length, before, "点「⋯」只开菜单，不该加载技能");
	assert.equal(els.menu.hidden, false, "菜单要打开");
	els.menu.hidden = true;
});

await check("菜单里的「查看技能」打开只读编辑器", async () => {
	const item = t.skillRowMenuItems({ id: "report-flow", name: "周报助手", builtin: false, steps: 2 }).find(
		(entry) => entry.label === "查看技能",
	);
	await item.onClick();
	await flush(20);
	assert.equal(els.flowModal.hidden, false);
	assert.equal(els.flowModalTitle.textContent, "查看技能");
	assert.equal(els.flowSave.hidden, true);
	assert.equal(els.flowSkillDesc.value, "每周五汇总本周数据");
	t.closeFlowEditor(true);
});

await check("删除技能（不是当前技能）：二次确认 + DELETE，右栏少一行，不发退出请求", async () => {
	await t.refreshSkillCatalog();
	const beforeConfirms = confirms.length;
	const beforePosts = skillPosts().length;
	const beforeRows = els.skillList.querySelectorAll(".skill-row").length;
	await t.deleteFlow({ id: "report-flow", name: "周报助手", builtin: false });
	await flush(25);
	assert.equal(confirms.length, beforeConfirms + 1, "删除要二次确认");
	assert.ok(confirms.at(-1).includes("会话"), `确认文案要说清会话会一起删：${confirms.at(-1)}`);
	assert.ok(calls.some((call) => call.method === "DELETE" && call.url === "/api/workflows/report-flow"), "要发 DELETE");
	assert.equal(skillPosts().length, beforePosts, "删的不是当前技能，不必退出");
	assert.equal(els.skillList.querySelectorAll(".skill-row").length, beforeRows - 1, "右栏少一行");
	assert.equal(skillRowOf("report-flow"), null, "被删的技能不该还留在列表里");
});

await check("删除的正是当前技能：胶囊与右栏都回「未加载」，且不补发退出请求", async () => {
	await t.setSkill("calc-flow");
	await flush(25);
	assert.equal(els.skillCurrentName.textContent, "提成核算");

	const beforePosts = skillPosts().length;
	await t.deleteFlow({ id: "calc-flow", name: "提成核算", builtin: false });
	await flush(30);
	assert.equal(skillPosts().length, beforePosts, "服务端已替你退出，不要再补发 POST /skills");
	assert.equal(els.skillChipLabel.textContent, "技能：无", "页头胶囊要复位");
	assert.equal(els.skillCurrentName.textContent, "未加载技能");
	assert.equal(els.skillCurrentExit.hidden, true);
	assert.equal(activeSkillRows().length, 0);
});

/* ================= 13. 页头胶囊纯状态 + 新建聊天直达 ================= */

section("页头胶囊纯状态 + 新建聊天直达");

await check("点页头技能胶囊不会展开菜单、也不发请求（它只是状态显示）", async () => {
	const before = calls.length;
	els.skillChip.click();
	await flush(20);
	assert.equal(calls.length, before, "点胶囊不该触发任何请求");
	assert.equal(els.menu.hidden, true, "也不该弹浮层菜单");
	assert.equal(htmlIds.has("skill-menu"), false, "DOM 里根本不该有技能菜单");
});

await check("退出技能的提示不提「流程」", () => {
	t.handle({ type: "skill", skillId: "data-flow", name: "销售数据分析", description: "" });
	const loaded = Array.from(els.threadInner.querySelectorAll(".notice")).at(-1)?.textContent ?? "";
	assert.ok(loaded.includes("已加载技能"), `加载要有提示：${loaded}`);
	t.handle({ type: "skill", skillId: null, name: "", description: "" });
	const exited = Array.from(els.threadInner.querySelectorAll(".notice")).at(-1)?.textContent ?? "";
	assert.ok(exited.includes("已退出技能"), `退出要有提示：${exited}`);
	assert.ok(!exited.includes("流程"), `退出提示别再说「流程」：${exited}`);
});

await check("「运行详情」抽屉只剩进度与审计两块", () => {
	// 静态 HTML 断言：抽屉里的静态节点在桩里没有挂到树上，直接看源码更可靠
	const drawerAt = html.indexOf('<aside class="drawer"');
	const drawerHtml = html.slice(drawerAt, html.indexOf("</aside>", drawerAt));
	const headings = [...drawerHtml.matchAll(/<h4>([^<]+)<\/h4>/g)].map((match) => match[1]);
	assert.deepEqual(headings, ["当前进度", "审计流水"], "抽屉只留这两块");
	assert.ok(!drawerHtml.includes("drawer-sessions"), "抽屉里不再有「全部会话」");
	assert.ok(!drawerHtml.includes("drawer-skill"), "抽屉里不再有「当前技能」（搬到右栏了）");
});

const newSessionPosts = () => calls.filter((call) => call.method === "POST" && call.url === "/api/sessions");
const btnNew = documentStub.getElementById("btn-new");

await check("点「新聊天」直接建 auto-flow 会话：只发一次 POST，不弹任何菜单", async () => {
	els.menu.hidden = true;
	const before = newSessionPosts().length;
	btnNew.click();
	await flush(40);
	const fresh = newSessionPosts();
	assert.equal(fresh.length, before + 1, "一次点击只该发一次建会话请求");
	assert.deepEqual(fresh.at(-1).body, { workflowId: "auto-flow" }, "不给「选技能」这一步");
	assert.equal(els.menu.hidden, true, "不出现选择菜单");
	assert.equal(t.state.currentId, "s-new");
});

await check("新聊天入口只在会话栏（图标栏已换成模块导航）；点工作区名/正文不会建会话", async () => {
	els.menu.hidden = true;
	const before = newSessionPosts().length;
	// 图标栏现在是模块入口，点它只切模块，不该顺手建会话
	els.railNav.querySelectorAll(".rail-btn").forEach((node) => node.click());
	await flush(40);
	assert.equal(newSessionPosts().length, before, "点图标栏只切模块，不许建会话");
	els.railNav.querySelectorAll(".rail-btn").item(0).click();
	await flush(30);
	assert.equal(t.state.module, "chat", "点完一圈切回对话，别把后面的用例留在别的模块");

	documentStub.getElementById("workspace").click();
	els.threadInner.click();
	await flush(20);
	assert.equal(newSessionPosts().length, before, "点正文也不该顺手建会话");
});
await check("会话行的技能徽标跟着技能出现 / 消失（含 SSE 退出）", async () => {
	sessionStore = [
		{
			id: "s-plain",
			workflowId: "ticket-flow",
			workflowName: "工单处理",
			title: "普通会话",
			archived: false,
			activeSkillId: null,
			skills: skillCatalog(),
			steps: [],
			updatedAt: 1,
		},
	];
	t.state.pinned = new Set();
	await t.refreshSessions();
	await t.openSession("s-plain");
	const rowIn = (id) => Array.from(els.sessionList.querySelectorAll(".item")).find((node) => node.dataset.sessionId === id) ?? null;

	assert.equal(rowIn("s-plain")?.querySelectorAll(".skill-tag").length, 0, "还没加载技能，不该有徽标");
	await t.setSkill("ticket-flow");
	await flush(25);
	assert.equal(rowIn("s-plain")?.querySelector(".skill-tag")?.textContent, "工单处理", "加载后要挂上徽标");
	assert.ok(rowIn("s-plain").title.includes("技能：工单处理"), "title 里也写技能名");

	t.handle({ type: "skill", skillId: null, name: "", description: "" });
	assert.equal(rowIn("s-plain")?.querySelectorAll(".skill-tag").length, 0, "SSE 退出后徽标要摘掉");
	assert.ok(!rowIn("s-plain").title.includes("技能："), "提示也要收干净");
});

await check("切换会话后右栏高亮按该会话的技能重算", async () => {
	sessionStore = [
		{ id: "s-a", workflowId: "auto-flow", workflowName: "自动编排", title: "会话 A", archived: false, activeSkillId: "data-flow", skills: skillCatalog(), steps: [], updatedAt: 2 },
		{ id: "s-b", workflowId: "auto-flow", workflowName: "自动编排", title: "会话 B", archived: false, activeSkillId: null, skills: skillCatalog(), steps: [], updatedAt: 1 },
	];
	await t.refreshSessions();
	await t.openSession("s-a");
	assert.equal(activeSkillRows()[0]?.dataset.skillId, "data-flow", "会话 A 在用数据分析");
	assert.equal(els.skillChipLabel.textContent, "技能：销售数据分析");

	await t.openSession("s-b");
	assert.equal(activeSkillRows().length, 0, "会话 B 没加载技能");
	assert.equal(els.skillCurrentName.textContent, "未加载技能");
	assert.equal(els.skillChipLabel.textContent, "技能：无");
});

/* ================= 14. 模块导航壳 ================= */

section("模块导航壳（图标栏 = 模块入口）");

const moduleButtons = () => Array.from(els.railNav.querySelectorAll(".rail-btn"));
const moduleButton = (id) => moduleButtons().find((node) => node.dataset.module === id) ?? null;
const currentModules = () =>
	moduleButtons()
		.filter((node) => node.getAttribute("aria-current") === "true")
		.map((node) => node.dataset.module);
const pageTitle = () => els.modulePage.querySelector(".module-page__title")?.textContent ?? "";

await check("图标栏渲染全部模块按钮：12 个，顺序与规格表一致", () => {
	assert.deepEqual(
		moduleButtons().map((node) => node.dataset.module),
		["chat", "knowledge", "skills", "plugins", "models", "mcp", "im", "approvals", "audit", "members", "monitor", "settings"],
	);
	// 临时按钮全下线：新聊天只剩会话栏入口，运行详情走头部图标
	for (const gone of ["rail-new", "rail-history", "rail-audit", "rail-more"]) {
		assert.equal(htmlIds.has(gone), false, `不该再有 #${gone}`);
	}
});

await check("每个模块按钮都有悬停提示与无障碍名，且只高亮当前一个", () => {
	for (const node of moduleButtons()) {
		assert.ok(node.title.length > 0, `${node.dataset.module} 缺 title`);
		assert.equal(node.getAttribute("aria-label"), node.title, "aria-label 与 title 一致");
		assert.equal(node.getAttribute("type"), "button");
		assert.equal(node.querySelector(".rail-label")?.textContent, node.title, `${node.dataset.module} 图标下方应显示中文名称`);
	}
	assert.deepEqual(currentModules(), ["chat"], "启动后默认停在对话");
	assert.equal(initialModule, "chat", "state.module 初始值就是 chat");
});

await check("对话模块 = 三列：会话栏在，右侧技能栏不再常驻", () => {
	assert.equal(els.shell.classList.contains("module-view"), false);
	assert.equal(els.modulePage.querySelectorAll(".module-page").length, 0, "对话模块不画模块页");
	assert.equal(els.sessionList.querySelectorAll(".item").length > 0, true, "会话栏有内容");
	assert.match(css, /\.skill-side \{[^}]*display: none/s, "右栏技能栏只保留 DOM，不再显示");
});
await check("style.css 注释成对：注释吞掉规则曾经让右栏技能栏漏到对话页左下角", () => {
	// 只做文本正则没法发现「规则被写在注释里」——就踩过一次：
	// `.skill-side { display: none }` 整条被未闭合的注释吞掉，断言照常通过，
	// 但浏览器里右栏技能面板作为网格第 4 个子项掉到下一行，变成左下角 76px 的一条。
	const opens = (css.match(/\/\*/g) ?? []).length;
	const closes = (css.match(/\*\//g) ?? []).length;
	assert.equal(opens, closes, `注释不成对：/* 有 ${opens} 个，*/ 有 ${closes} 个`);
});

await check("关键隐藏规则不在注释里：.skill-side 的 display:none 必须是真规则", () => {
	// 去掉所有注释后再找：注释里的文字不算数
	const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
	assert.match(withoutComments, /\.skill-side \{[^}]*display: none/s, ".skill-side 的隐藏规则被注释掉了");
});

await check("点「知识库」：壳切成模块视图，标题/说明/未接入徽标/接口清单都在", async () => {
	moduleButton("knowledge").click();
	await flush(30);
	assert.equal(t.state.module, "knowledge");
	assert.equal(els.shell.classList.contains("module-view"), true, "非对话模块切到整宽布局");
	assert.equal(pageTitle(), "知识库");
	const summary = els.modulePage.querySelector(".module-empty__text")?.textContent ?? "";
	assert.ok(summary.includes("向量"), `说明要讲清做什么：${summary}`);
	assert.equal(els.modulePage.querySelector(".module-badge")?.textContent, "未接入");
	const codes = Array.from(els.modulePage.querySelectorAll(".module-api__code")).map((node) => node.textContent);
	assert.deepEqual(codes, ["POST /api/kb", "POST /api/kb/:id/documents", "POST /api/kb/:id/search", "POST /api/kb/:id/reindex"]);
	assert.deepEqual(currentModules(), ["knowledge"], "aria-current 只留在知识库上");
});

await check("「审计」页说清现在能看什么，再标未接入", async () => {
	moduleButton("audit").click();
	await flush(20);
	const note = els.modulePage.querySelector(".module-note__text")?.textContent ?? "";
	assert.ok(note.includes("运行详情"), `要先说明现有能力：${note}`);
	assert.equal(moduleButton("knowledge").getAttribute("aria-current"), null, "切走就摘掉 aria-current");
	assert.equal(els.modulePage.querySelector(".module-badge")?.textContent, "未接入");
});


await check("插件页未接入状态与 API 清单明确", async () => {
	t.setPluginsAvailable(false);
	await t.switchModule("plugins");
	assert.equal(pageTitle(), "插件");
	assert.equal(els.modulePage.querySelector(".module-badge")?.textContent, "未接入");
	assert.deepEqual(Array.from(els.modulePage.querySelectorAll(".module-api__code")).map((node) => node.textContent), ["GET /api/plugins", "POST /api/plugins/import", "PATCH /api/plugins/:id", "DELETE /api/plugins/:id"]);
});

await check("插件管理：导入 JSON、启停与卸载走约定接口", async () => {
	t.resetPluginFixtures();
	await t.switchModule("plugins");
	const fileInput = els.modulePage.querySelector(".plugin-import-input");
	const importButton = els.modulePage.querySelector(".plugin-import");
	assert.ok(fileInput && importButton, "页面提供 JSON 文件选择器与导入按钮");
	const manifest = { id: "sales-tools", name: "销售助手", version: "1.2.0", description: "客户分析工具", skills: [{ name: "总结" }], tools: [{ name: "lookup" }] };
	fileInput.files = [{ name: "plugin.json", text: async () => JSON.stringify(manifest) }];
	fileInput.dispatchEvent({ type: "change" });
	await flush(25);
	const post = t.calls.find((call) => call.url === "/api/plugins/import" && call.method === "POST");
	assert.deepEqual(post?.body, { manifest });
	assert.equal(els.modulePage.querySelector(".plugin-row__name")?.textContent, "销售助手");
	assert.ok(els.modulePage.querySelector(".plugin-row__contents")?.textContent.includes("1 个技能"));
	els.modulePage.querySelector(".plugin-toggle").click();
	await flush(20);
	const patch = t.calls.find((call) => call.url === "/api/plugins/sales-tools" && call.method === "PATCH");
	assert.deepEqual(patch?.body, { enabled: false });
	assert.equal(els.modulePage.querySelector(".plugin-toggle")?.textContent, "启用");
	t.setConfirmAnswer(false);
	els.modulePage.querySelector(".plugin-uninstall").click();
	await flush(10);
	assert.equal(t.calls.some((call) => call.url === "/api/plugins/sales-tools" && call.method === "DELETE"), false, "取消确认不发卸载请求");
	t.setConfirmAnswer(true);
	els.modulePage.querySelector(".plugin-uninstall").click();
	await flush(20);
	assert.ok(t.calls.some((call) => call.url === "/api/plugins/sales-tools" && call.method === "DELETE"));
	assert.equal(els.modulePage.querySelectorAll(".plugin-row").length, 0);
});

await check("插件写入按钮受 workflow.write 权限控制", async () => {
	t.resetPluginFixtures();
	t.setAuthPermissions(["workflow.read"]);
	t.state.permissions = ["workflow.read"];
	await t.refreshPlugins();
	t.renderModuleView();
	assert.equal(els.modulePage.querySelector(".plugin-import").disabled, true);
	assert.equal(els.modulePage.querySelector(".plugin-perm-hint")?.textContent.includes("workflow.write"), true);
	t.setAuthPermissions(["workflow:write", "workflow.read"]);
	t.state.permissions = ["workflow:write", "workflow.read"];
});

await check("每个模块都能渲染出页面标题（不会点出空白页）", async () => {
	for (const module of t.MODULES) {
		await t.switchModule(module.id);
		if (module.id === "chat") {
			assert.equal(els.modulePage.querySelectorAll(".module-page").length, 0, "对话模块不画模块页");
			continue;
		}
		assert.equal(pageTitle(), module.label, `${module.id} 的标题应是「${module.label}」`);
	}
	await t.switchModule("chat");
});

await check("空态模块页的文案里没有「流程」二字", async () => {
	for (const id of ["knowledge", "mcp", "im", "approvals", "audit", "members", "monitor", "plugins"]) {
		await t.switchModule(id);
		const text = els.modulePage.textContent;
		assert.ok(!text.includes("流程"), `${id} 页出现「流程」：${text.slice(0, 80)}`);
	}
	await t.switchModule("chat");
});

await check("点「技能」：真实目录（过滤自动编排）+ 内置角标 + 技能说明", async () => {
	// §12 的删除用例把自定义技能删掉了：恢复夹具，别让前一条用例的副作用带偏这条
	skillStore = SKILL_CATALOG.map((skill) => ({ ...skill }));
	await t.refreshSkillCatalog();
	moduleButton("skills").click();
	await flush(40);
	assert.equal(pageTitle(), "技能");
	const rows = Array.from(els.modulePage.querySelectorAll(".skill-row"));
	assert.equal(rows.length, 5, "目录 6 条，去掉自动编排剩 5 条");
	assert.equal(
		rows.map((row) => row.dataset.skillId).join(","),
		"ticket-flow,data-flow,approval-flow,report-flow,calc-flow",
	);
	assert.equal(rows[0].querySelector(".flow-tag")?.textContent, "内置");
	assert.equal(rows[3].querySelector(".skill-row-desc")?.textContent, "每周五汇总本周数据");
	// 和右栏同一套行结构（同一个 skillRowNode），不搞两套渲染
	assert.equal(rows[3].getAttribute("role"), "button");
	assert.equal(els.modulePage.querySelectorAll(".skill-module-filter").length, 4);
});

await check("技能目录可按名称说明搜索与类型筛选，空结果可清除", () => {
	let search = els.modulePage.querySelector(".skill-module-search");
	search.value = "每周五";
	search.dispatch("input");
	let rows = Array.from(els.modulePage.querySelectorAll(".skill-row"));
	assert.deepEqual(rows.map((row) => row.dataset.skillId), ["report-flow"]);
	assert.equal(els.modulePage.querySelector(".skill-module-count").textContent, "显示 1 / 5 项技能");
	const custom = Array.from(els.modulePage.querySelectorAll(".skill-module-filter")).find((button) => button.textContent === "自定义");
	custom.click();
	rows = Array.from(els.modulePage.querySelectorAll(".skill-row"));
	assert.deepEqual(rows.map((row) => row.dataset.skillId), ["report-flow"]);
	search = els.modulePage.querySelector(".skill-module-search");
	search.value = "完全没有这项";
	search.dispatch("input");
	assert.ok(els.modulePage.querySelector(".skill-module-empty"));
	els.modulePage.querySelector(".skill-module-empty button").click();
	assert.equal(els.modulePage.querySelectorAll(".skill-row").length, 5, "清除筛选后恢复完整目录");
});

await check("技能页装进/退出：点一条出现「当前技能」条，点「退出技能」能摘掉", async () => {
	const row = Array.from(els.modulePage.querySelectorAll(".skill-row")).find(
		(node) => node.dataset.skillId === "ticket-flow",
	);
	assert.ok(row, "技能页要能点行装进当前会话");
	row.click();
	await flush(80);
	assert.equal(t.state.activeSkill?.name, "工单处理");
	assert.ok(els.modulePage.querySelector(".skill-module-current"), "装进后要显示「当前技能」条");
	assert.equal(els.modulePage.querySelector(".skill-module-current__name").textContent, "工单处理");
	els.modulePage.querySelector(".skill-module-exit").click();
	await flush(80);
	assert.equal(t.state.activeSkill, null, "点退出后不能还挂着技能");
	assert.equal(els.modulePage.querySelector(".skill-module-current"), null, "退出后当前技能条要消失");
});

await check("技能页的「⋯」菜单与右栏完全一致（查看 / 编辑 / 删除）", () => {
	const custom = els.modulePage
		.querySelectorAll(".skill-row")
		.item(3)
		.querySelector(".more");
	custom.click();
	const labels = Array.from(els.menu.querySelectorAll(".menu-item"))
		.map((node) => node.textContent)
		.filter((text) => text.length > 0);
	const menuOpen = els.menu.hidden === false;
	els.menu.hidden = true;
	assert.equal(menuOpen, true, "点 ⋯ 要能开菜单");
	assert.ok(labels.some((text) => text.includes("编辑技能")), `自定义技能要能编辑：${labels.join("|")}`);
	assert.ok(labels.some((text) => text.includes("删除技能")), `自定义技能要能删除：${labels.join("|")}`);
});

await check("技能页「＋ 新建技能」打开同一个编辑器（沿用现有保存路径）", async () => {
	const add = Array.from(els.modulePage.querySelectorAll(".btn-ghost")).find(
		(node) => node.textContent.includes("新建技能"),
	);
	assert.ok(add, "技能页头部要有「＋ 新建技能」");
	add.click();
	await flush(30);
	assert.equal(els.flowModal.hidden, false);
	assert.equal(els.flowModalTitle.textContent, "新建技能");
	assert.equal(els.flowStepsBox.querySelectorAll(".flow-step").length, 0, "技能默认不带步骤");
	assert.equal(els.flowSkillDesc.disabled, false, "「什么时候用它」可以直接填");
	t.closeFlowEditor(true);
});

await check("点「模型」：当前模型来自 /api/health，可用列表来自 /api/models", async () => {
	moduleButton("models").click();
	await flush(60);
	assert.equal(pageTitle(), "模型");
	const values = Array.from(els.modulePage.querySelectorAll(".module-kv__value")).map((node) => node.textContent);
	assert.ok(values[0].includes("模拟模型"), `当前模型要取 health.model：${values[0]}`);
	const rows = Array.from(els.modulePage.querySelectorAll(".module-model-row"));
	assert.equal(rows.length, 2, "夹具给了 2 个可用模型");
	assert.equal(rows[0].querySelector(".module-model-row__name").textContent, "模拟模型");
	assert.equal(rows[1].querySelector(".module-model-row__name").textContent, "DeepSeek Chat");
	assert.equal(rows[0].querySelector(".module-tag")?.textContent, "当前默认", "默认那项要标出来");
	assert.equal(rows[1].querySelectorAll(".module-tag").length, 0);
	// 页面本身有真数据，只把「供应商管理/连通性检测」这一段标成未接入
	const badges = Array.from(els.modulePage.querySelectorAll(".module-badge"));
	assert.equal(badges.length, 1, "只有需要补的接口那一段挂「未接入」");
	assert.equal(badges[0].textContent, "未接入");
	assert.ok(els.modulePage.textContent.includes("连通性"), "供应商管理/连通性检测要标未接入");
});

await check("点「设置」：存储后端 / 会话数 / 技能数 / 当前模型都摊开", async () => {
	moduleButton("settings").click();
	await flush(60);
	assert.equal(pageTitle(), "设置");
	const pairs = Array.from(els.modulePage.querySelectorAll(".module-kv__row")).map((row) => [
		row.querySelector(".module-kv__label").textContent,
		row.querySelector(".module-kv__value").textContent,
	]);
	const kv = new Map(pairs);
	assert.equal(kv.get("存储后端"), "SQLite（scratch.db）", "存储后端读 health.storage 的对象形状，只显示库文件名");
	assert.equal(kv.get("会话数"), String(t.state.sessions.length));
	assert.equal(kv.get("技能数"), "5", "技能数 = 目录去掉自动编排");
	assert.ok(kv.get("当前模型").includes("模拟模型"), `当前模型：${kv.get("当前模型")}`);
});

await check("health 没有 storage 字段时设置页回落显示 SQLite", () => {
	const saved = t.state.health;
	t.state.health = { ok: true, model: { mode: "simulated", label: "模拟模型" } };
	t.renderModuleView();
	const rows = Array.from(els.modulePage.querySelectorAll(".module-kv__row"));
	const row = rows.find((node) => node.querySelector(".module-kv__label")?.textContent === "存储后端");
	const value = row?.querySelector(".module-kv__value")?.textContent ?? "";
	assert.equal(value, "SQLite", `没有 storage 就写 SQLite，实际：${value}`);
	t.state.health = saved;
	t.renderModuleView();
});

await check("health.storage 是字符串时原样显示（后端两种形状都认）", () => {
	const saved = t.state.health;
	t.state.health = { ok: true, model: { mode: "simulated", label: "模拟模型" }, storage: "PostgreSQL 16" };
	t.renderModuleView();
	const rows = Array.from(els.modulePage.querySelectorAll(".module-kv__row"));
	const row = rows.find((node) => node.querySelector(".module-kv__label")?.textContent === "存储后端");
	assert.equal(row?.querySelector(".module-kv__value")?.textContent, "PostgreSQL 16");
	t.state.health = saved;
	t.renderModuleView();
});

await check("点回「对话」：会话栏原样恢复、当前会话没变（右栏技能栏已撤）", async () => {
	const beforeId = t.state.currentId;
	const beforeSessions = t.state.sessions.length;
	moduleButton("chat").click();
	await flush(40);
	assert.equal(t.state.module, "chat");
	assert.equal(els.shell.classList.contains("module-view"), false, "回到对话的三列布局");
	assert.equal(els.modulePage.querySelectorAll(".module-page").length, 0, "模块页清空");
	assert.equal(t.state.currentId, beforeId, "当前会话不该被切模块改掉");
	assert.equal(t.state.sessions.length, beforeSessions);
	assert.equal(els.sessionList.querySelectorAll(".item").length, 2, "会话列表还在");
	assert.equal(els.skillList.querySelectorAll(".skill-row").length, 5, "右栏技能列表还在");
	assert.deepEqual(currentModules(), ["chat"]);
});

await check("Ctrl+K 在模块页里会先切回对话再打开搜索行", async () => {
	await t.switchModule("models");
	assert.equal(t.state.module, "models");
	els.searchRow.hidden = true;
	fireDocument("keydown", { key: "k", ctrlKey: true, metaKey: false });
	await flush(30);
	assert.equal(t.state.module, "chat", "搜索行在会话栏里，得先回对话");
	assert.equal(els.searchRow.hidden, false, "搜索行要打开");
	els.searchRow.hidden = true;
});

await check("模块视图的 CSS 接线：两列 + 收三块 + 模块页默认不显示", () => {
	assert.match(css, /\.shell\.module-view \{[^}]*grid-template-columns: 76px minmax\(0, 1fr\)/s, "模块视图两列");
	// 三条收起规则写在同一个选择器列表里
	const hiddenRule = css.match(/\.shell\.module-view \.sidebar,[\s\S]*?\}/)?.[0] ?? "";
	for (const selector of [".sidebar", ".main", ".skill-side"]) {
		assert.ok(hiddenRule.includes(`.shell.module-view ${selector}`), `${selector} 要收起来：${hiddenRule}`);
	}
	assert.match(hiddenRule, /display: none/, "收起来 = display: none");
	assert.match(css, /\.module-main \{[^}]*display: none/s, "模块页在对话模块下不显示");
	assert.match(css, /\.shell\.module-view \.module-main \{[^}]*display: block/s, "模块视图下才显示");
	assert.match(css, /\.rail-btn\.active \{[^}]*background: #1c1d21/s, "当前模块要有明显高亮");
});

/* ================= 15. 知识库（P5） ================= */

section("知识库（P5）：库列表 / 文档 / 上传 / 检索");

const kbItems = () => Array.from(els.modulePage.querySelectorAll(".kb-item"));
const kbDocsRows = () => Array.from(els.modulePage.querySelectorAll(".kb-doc-row"));
const lastNotice = () => Array.from(els.threadInner.querySelectorAll(".notice")).at(-1)?.textContent ?? "";

await check("点「知识库」：/api/kb 有数据时画真页面（库列表 + 文档数/块数 + 默认选中第一个）", async () => {
	t.setKbAvailable(true);
	t.resetKbFixtures();
	moduleButton("knowledge").click();
	await flush(80);
	assert.equal(pageTitle(), "知识库");
	const items = kbItems();
	assert.equal(items.length, 2, "夹具给了 2 个库");
	assert.equal(items[0].querySelector(".kb-item-name").textContent, "产品文档");
	assert.equal(items[0].querySelector(".kb-item-meta").textContent, "2 文档 · 14 块");
	assert.equal(items[0].classList.contains("active"), true, "默认选中第一个库");
	assert.equal(els.modulePage.querySelectorAll(".module-badge").length, 0, "有真数据就不再挂「未接入」");
});

await check("embedding 没配：顶上写「语义检索未启用」，徽标是「关键词检索」", () => {
	assert.equal(els.modulePage.querySelector(".kb-status__badge").textContent, "关键词检索");
	assert.ok(
		els.modulePage.textContent.includes("语义检索未启用：按字面词匹配"),
		"要明确告诉用户当前是关键词检索",
	);
});

await check("选中的库：文档表格画出文件名 / 大小 / 状态徽标 / 块数，失败带原因", () => {
	const rows = kbDocsRows();
	assert.equal(rows.length, 2);
	assert.equal(rows[0].querySelector(".kb-td-name").textContent, "产品手册.md");
	assert.equal(rows[0].querySelector(".kb-td-size").textContent, "2.0 KB");
	assert.equal(rows[0].querySelector(".kb-badge").textContent, "已就绪");
	assert.equal(rows[0].querySelector(".kb-td-chunks").textContent, "9");
	assert.equal(rows[1].querySelector(".kb-badge").textContent, "解析失败");
	assert.equal(rows[1].querySelector(".kb-doc-error").textContent, "扫描件没有文字层，解析不出内容");
	// 危险操作单独成组：删除知识库在操作区里、带 .kb-danger；标题区不带按钮
	assert.equal(
		els.modulePage.querySelector(".kb-main-actions .danger")?.textContent,
		"删除知识库",
		"删除知识库要放进操作区并标成危险动作",
	);
	assert.equal(els.modulePage.querySelector(".kb-main-title button"), null, "标题区不该塞按钮（窄屏会把标题挤坏）");
});

await check("＋新建知识库：弹窗填名字 → POST /api/kb（JSON），成功后关弹窗并刷新列表", async () => {
	const add = els.modulePage.querySelector(".kb-list-add");
	assert.ok(add, "列表头要有「＋」");
	add.click();
	await flush(20);
	assert.equal(els.kbModal.hidden, false);
	assert.equal(els.kbModalTitle.textContent, "新建知识库");
	assert.equal(els.kbModalBody.querySelectorAll(".kb-field").length, 2, "名称 + 说明两个字段");
	els.kbModalBody.querySelectorAll(".kb-field-input").item(0).value = "运维手册";
	const before = t.calls.filter((call) => call.url === "/api/kb" && call.method === "POST").length;
	await t.submitKbDialog();
	await flush(80);
	const posts = t.calls.filter((call) => call.url === "/api/kb" && call.method === "POST");
	assert.equal(posts.length, before + 1);
	assert.equal(posts.at(-1).body.name, "运维手册");
	assert.equal(posts.at(-1).headers["Content-Type"], "application/json");
	assert.equal(els.kbModal.hidden, true, "保存成功要关弹窗");
	assert.equal(kbItems().length, 3, "列表刷新后 3 个库");
});

await check("上传文档：FileReader 读成 base64，POST 的是 JSON（不是 multipart）", async () => {
	await t.selectKbLibrary("kb-1");
	await flush(40);
	const before = t.calls.filter((call) => /\/documents$/.test(call.url) && call.method === "POST").length;
	els.kbFile.files = [{ name: "退款政策.txt", type: "text/plain", content: "退款 1-3 个工作日到账" }];
	await t.handleKbFilePicked();
	await flush(80);
	const posts = t.calls.filter((call) => /\/documents$/.test(call.url) && call.method === "POST");
	assert.equal(posts.length, before + 1);
	const body = posts.at(-1).body;
	assert.equal(posts.at(-1).url, "/api/kb/kb-1/documents", "传到选中的那个库");
	assert.equal(body.filename, "退款政策.txt");
	assert.equal(body.contentBase64, Buffer.from("退款 1-3 个工作日到账", "utf8").toString("base64"));
	assert.equal(posts.at(-1).headers["Content-Type"], "application/json", "后端只收 JSON base64，绝不能是 multipart");
	assert.ok(typeof body === "object" && body !== null, "body 是 JSON.parse 出来的对象，说明发的是 JSON 字符串");
	const names = Array.from(els.modulePage.querySelectorAll(".kb-td-name")).map((node) => node.textContent);
	assert.ok(names.includes("退款政策.txt"), `表格要刷新出新文件：${names.join("|")}`);
	assert.ok(lastNotice().includes("已上传「退款政策.txt」"), `上传成功要给提示：${lastNotice()}`);
});

await check("检索试跑（mode=keyword）：结果列表 + 「关键词检索」徽标 + 请求带 query/topK", async () => {
	t.setKbSearchMode("keyword");
	const input = els.modulePage.querySelector(".kb-search-input");
	input.value = "退款要多久到账";
	els.modulePage.querySelector(".kb-search-run").click();
	await flush(80);
	assert.equal(els.modulePage.querySelector(".kb-search-badge").textContent, "关键词检索");
	const results = Array.from(els.modulePage.querySelectorAll(".kb-result"));
	assert.equal(results.length, 2);
	assert.equal(results[0].querySelector(".kb-result-heading").textContent, "退款时效");
	assert.ok(results[0].querySelector(".kb-result-snippet").textContent.includes("1-3 个工作日"));
	assert.equal(results[0].querySelector(".kb-result-score").textContent, "12.50");
	const posts = t.calls.filter((call) => /\/search$/.test(call.url));
	assert.equal(posts.at(-1).body.query, "退款要多久到账");
	assert.equal(posts.at(-1).body.topK, 5);
});

await check("语义检索开着但有块没向量：库详情出现「待补齐」横幅，点它就是整库重算", async () => {
	t.setKbEmbedding({ available: true, model: "bge-m3", baseUrl: "http://127.0.0.1:11434" });
	await t.refreshKb();
	t.renderModuleView();
	const banner = els.modulePage.querySelector(".kb-reembed");
	assert.ok(banner, "有块没向量时要有一条显眼的提醒");
	assert.ok(banner.textContent.includes("还没有向量"), banner.textContent);
	assert.equal(banner.querySelector(".kb-reembed__badge").textContent, "待补齐");
	// 夹具：kb-1 共 14 块、embeddedChunkCount 缺失 = 0 → 14 块待补齐
	assert.ok(banner.textContent.includes("14 个块"), `要写清待补块数：${banner.textContent}`);
	const fix = banner.querySelector(".kb-reembed__fix");
	assert.equal(fix.textContent, "补齐向量（14 块）");
	const before = t.calls.filter((call) => /\/reindex$/.test(call.url)).length;
	fix.click();
	await flush(80);
	assert.equal(t.calls.filter((call) => /\/reindex$/.test(call.url)).length, before + 1, "点横幅就是整库重算");
	assert.equal(t.calls.filter((call) => /\/reindex$/.test(call.url)).at(-1).url, "/api/kb/kb-1/reindex");
});

await check("配了 embedding：顶上写「语义检索：<model>」，mode=vector 时徽标变「语义检索」", async () => {
	t.setKbEmbedding({ available: true, model: "bge-m3", baseUrl: "http://127.0.0.1:11434" });
	t.setKbSearchMode("vector");
	await t.refreshKb();
	t.renderModuleView();
	assert.equal(els.modulePage.querySelector(".kb-status__badge").textContent, "语义检索");
	assert.ok(els.modulePage.textContent.includes("语义检索：bge-m3"), "要显示 embedding 模型名");
	const input = els.modulePage.querySelector(".kb-search-input");
	input.value = "退款多久到账";
	els.modulePage.querySelector(".kb-search-run").click();
	await flush(80);
	const badge = els.modulePage.querySelector(".kb-search-badge");
	assert.equal(badge.textContent, "语义检索");
	assert.equal(badge.classList.contains("on"), true);
});

const kbReindexButton = () =>
	Array.from(els.modulePage.querySelectorAll("button")).find((node) => node.textContent === "重新向量化");

await check("重新向量化：配了 embedding 时按钮可点 → POST /reindex，提示重算块数", async () => {
	const button = kbReindexButton();
	assert.ok(button, "库详情里要有「重新向量化」按钮");
	assert.equal(button.disabled, false);
	const before = t.calls.filter((call) => /\/reindex$/.test(call.url)).length;
	button.click();
	await flush(80);
	const posts = t.calls.filter((call) => /\/reindex$/.test(call.url));
	assert.equal(posts.length, before + 1);
	assert.equal(posts.at(-1).url, "/api/kb/kb-1/reindex", "重算选中的那个库");
	assert.equal(posts.at(-1).method, "POST");
	assert.ok(lastNotice().includes("重新向量化"), lastNotice());
});

await check("重新向量化：没配 embedding 时按钮禁用", async () => {
	t.setKbEmbedding({ available: false, model: null, baseUrl: null });
	await t.refreshKb();
	t.renderModuleView();
	assert.equal(kbReindexButton().disabled, true, "没有向量化服务就不该让人点");
});

await check("删库取消：确认文案带文档/块数，取消就一个请求都不发", async () => {
	t.setConfirmAnswer(false);
	const before = t.calls.filter((call) => call.method === "DELETE").length;
	const confirmsBefore = t.confirms.length;
	await t.deleteKbLibrary({ id: "kb-2", name: "客服话术", docCount: 1, chunkCount: 5 });
	assert.equal(t.confirms.length, confirmsBefore + 1, "先二次确认");
	const message = t.confirms.at(-1);
	assert.ok(message.includes("客服话术") && message.includes("1 篇文档") && message.includes("5 个分块"), message);
	assert.equal(t.calls.filter((call) => call.method === "DELETE").length, before, "取消不该发 DELETE");
	assert.equal(kbItems().length, 3, "列表不该变");
});

await check("删库确认：DELETE → 列表少一个，提示用后端返回的删除数量", async () => {
	t.setConfirmAnswer(true);
	t.setKbDeleteResult({ removed: true, documentsRemoved: 1, chunksRemoved: 5 });
	const before = kbItems().length;
	await t.deleteKbLibrary({ id: "kb-2", name: "客服话术", docCount: 1, chunkCount: 5 });
	await flush(80);
	const deletes = t.calls.filter((call) => call.method === "DELETE" && call.url === "/api/kb/kb-2");
	assert.equal(deletes.length, 1);
	assert.equal(kbItems().length, before - 1);
	const notice = lastNotice();
	assert.ok(notice.includes("已删除知识库「客服话术」"), notice);
	assert.ok(notice.includes("1 篇文档") && notice.includes("5 个分块"), `用响应里的数：${notice}`);
});

await check("一个库都没有：不摆两栏占位，给一张「新建知识库」空态卡", async () => {
	t.setKbStore([]);
	await t.refreshKb();
	t.renderModuleView();
	assert.equal(kbItems().length, 0, "没有库就不画列表");
	const empty = els.modulePage.querySelector(".kb-empty");
	assert.ok(empty, "要有空态卡");
	assert.ok(empty.textContent.includes("资料夹"), `空态要讲清知识库是干什么的：${empty.textContent}`);
	const addBtn = Array.from(empty.querySelectorAll("button")).find((node) => node.textContent === "新建知识库");
	assert.ok(addBtn, "空态卡里要有一个主按钮");
	addBtn.click();
	await flush(20);
	assert.equal(els.kbModal.hidden, false, "点它要打开新建弹窗");
	assert.equal(els.kbModalTitle.textContent, "新建知识库");
	t.closeKbDialog();
	// 恢复夹具，后面的用例还要用两个库
	t.resetKbFixtures();
	await t.refreshKb();
	t.renderModuleView();
	assert.equal(kbItems().length, 2, "恢复夹具后回到两个库");
});

await check("GET /api/kb 404：整页回落「未接入」空态（旧文案 + 接口清单），不弹错误", async () => {
	t.setKbAvailable(false);
	await t.refreshKb();
	t.renderModuleView();
	assert.equal(kbItems().length, 0, "降级后不该画库列表");
	const badge = els.modulePage.querySelector(".module-badge");
	assert.equal(badge?.textContent, "未接入");
	assert.ok(els.modulePage.textContent.includes("/api/kb"), "空态要列出需要的接口");
	assert.equal(t.alerts.length, 0, "降级不该弹 alert");
	assert.equal(
		Array.from(els.threadInner.querySelectorAll(".notice.err")).length,
		0,
		"降级不该弹错误提示（用户没做错什么）",
	);
});

/* ================= 15b. 对话默认检索（不经过技能） ================= */

section("对话默认检索（不经过技能）：状态条 / 开关 / PUT 覆盖式 / 权限与失败文案");

const kbDefaultBoxes = () => Array.from(els.modulePage.querySelectorAll(".kb-default__box"));
const kbDefaultsStatus = () => els.modulePage.querySelector(".kb-status__defaults");
// 后台「按库行」找到它那颗开关（rows 与 libs 同序）
const kbBoxOf = (index) => kbDefaultBoxes()[index];

await check("状态条：「对话检索」单独一句，与语义检索分开写；没开时说明怎么开", async () => {
	t.setKbAvailable(true);
	t.resetKbFixtures();
	await t.refreshKb();
	t.renderModuleView();
	const status = kbDefaultsStatus();
	assert.ok(status, "状态条里要有对话检索那句");
	assert.ok(status.textContent.includes("对话检索：未启用"), status.textContent);
	assert.ok(
		status.textContent.includes("设为对话默认"),
		`没开时要告诉用户怎么开：${status.textContent}`,
	);
	// 语义检索与对话检索是两件事：前一句保持原样，不能被合并掉
	assert.ok(els.modulePage.textContent.includes("语义检索未启用：按字面词匹配"), "原来的语义检索那句还要在");
	assert.equal(status.classList.contains("on"), false, "没开就不高亮");
});

await check("每个库一行都画出「设为对话默认」开关：勾选状态直接读 /api/kb 的 isDefault", async () => {
	t.setKbDefaultIds(["kb-2"]);
	await t.refreshKb();
	t.renderModuleView();
	const boxes = kbDefaultBoxes();
	assert.equal(boxes.length, kbItems().length, "每个库一颗开关");
	assert.equal(boxes.length, 2);
	assert.equal(boxes.map((box) => box.value).join("|"), "kb-1|kb-2");
	assert.equal(boxes[0].type, "checkbox");
	assert.equal(boxes[0].checked, false);
	assert.equal(boxes[1].checked, true, "kb-2 的 isDefault=true → 已勾选");
	assert.equal(boxes[0].disabled, false, "有 workflow.write 就能点");
	assert.ok(Array.from(kbItems()[0].querySelectorAll(".kb-default__text")).some((node) => node.textContent === "设为对话默认"));
	assert.ok(kbDefaultsStatus().textContent.includes("已启用 1 个库"), kbDefaultsStatus().textContent);
});

await check("勾选一个库：PUT /api/kb/defaults 提交的是「所有勾选的完整 id 数组」，成功后列表重拉", async () => {
	const getsBefore = t.calls.filter((call) => call.url === "/api/kb" && call.method === "GET").length;
	kbBoxOf(0).checked = true;
	kbBoxOf(0).dispatch("change");
	await flush(60);
	const puts = t.calls.filter((call) => call.url === "/api/kb/defaults" && call.method === "PUT");
	assert.equal(puts.length, 1, "勾一次只发一次 PUT");
	assert.deepEqual(puts[0].body, { kbIds: ["kb-1", "kb-2"] }, "覆盖式：已勾的 kb-2 也要带上，不能只提 kb-1");
	assert.equal(puts[0].headers["Content-Type"], "application/json");
	const getsAfter = t.calls.filter((call) => call.url === "/api/kb" && call.method === "GET").length;
	assert.ok(getsAfter > getsBefore, "成功后要 refreshKb() 重拉列表");
	// 重拉后两行都是勾上的（状态以接口为准，不是前端自己记的）
	assert.equal(kbDefaultBoxes().map((box) => box.checked).join("|"), "true|true");
	assert.ok(kbDefaultsStatus().textContent.includes("已启用 2 个库"), kbDefaultsStatus().textContent);
	assert.ok(kbDefaultsStatus().textContent.includes("不加载技能时"), "要说清它的语义：不加载技能时也查");
	const notice = els.modulePage.querySelector(".kb-defaults-notice");
	assert.ok(notice, "成功要有页面内提示（不用 alert）");
	assert.ok(notice.textContent.includes("已设为对话默认检索"), notice.textContent);
	assert.equal(notice.classList.contains("err"), false);
	assert.equal(t.alerts.length, 0, "不许用 alert");
});

await check("取消勾选：PUT 只带剩下的库；全部取消就是空数组（= 关闭对话检索）", async () => {
	const before = t.calls.filter((call) => call.url === "/api/kb/defaults" && call.method === "PUT").length;
	kbBoxOf(0).checked = false;
	kbBoxOf(0).dispatch("change");
	await flush(60);
	let puts = t.calls.filter((call) => call.url === "/api/kb/defaults" && call.method === "PUT");
	assert.equal(puts.length, before + 1);
	assert.deepEqual(puts.at(-1).body, { kbIds: ["kb-2"] }, "取消 kb-1 后只剩 kb-2");
	assert.equal(kbDefaultBoxes()[0].checked, false);
	assert.equal(kbDefaultBoxes()[1].checked, true);

	kbBoxOf(1).checked = false;
	kbBoxOf(1).dispatch("change");
	await flush(60);
	puts = t.calls.filter((call) => call.url === "/api/kb/defaults" && call.method === "PUT");
	assert.deepEqual(puts.at(-1).body, { kbIds: [] }, "全取消 = 覆盖成空数组");
	assert.ok(kbDefaultsStatus().textContent.includes("对话检索：未启用"), kbDefaultsStatus().textContent);
});

await check("设为默认的库那行：勾上后行名加粗、开关文字变色（视觉上认得出哪几个库在生效）", async () => {
	t.setKbDefaultIds(["kb-1"]);
	await t.refreshKb();
	t.renderModuleView();
	t.renderModuleView();
	// 样式断言放在 CSS 文本里：DOM 桩不跑选择器，只能确认规则确实存在
	assert.match(css, /\.kb-item:has\(\.kb-default__box:checked\) \.kb-item-name \{[^}]*font-weight: 600/s);
	assert.match(css, /\.kb-default:has\(\.kb-default__box:checked\) \{[^}]*#1f7a44/s);
	assert.match(css, /\.kb-default__box:disabled \{[^}]*cursor: not-allowed/s);
});

await check("没有 workflow.write：开关全部置灰 + title 说明「需要 workflow.write」，连点也不发请求", async () => {
	t.state.permissions = ["kb:write"];
	t.renderModuleView();
	const boxes = kbDefaultBoxes();
	assert.equal(boxes.length, 2);
	assert.equal(boxes[0].disabled, true, "没权限要置灰");
	assert.equal(boxes[1].disabled, true);
	assert.equal(boxes[0].title, "当前角色不能修改知识库（需要 workflow.write）", "title 要说清缺哪个权限点");
	const before = t.calls.filter((call) => call.url === "/api/kb/defaults").length;
	boxes[0].checked = true;
	boxes[0].dispatch("change");
	await flush(40);
	assert.equal(t.calls.filter((call) => call.url === "/api/kb/defaults").length, before, "置灰还发了请求就是接线错了");
	assert.equal(kbBoxOf(1).checked, false);
	// 收尾：把权限还回去（后面的用例还要点开关）
	t.state.permissions = ["workflow:write", "kb:write"];
});

await check("PUT 失败（400 中文）：后端 { error } 原样显示在页面上，开关回到服务端的真实状态", async () => {
	t.setKbDefaultIds([]);
	t.setKbDefaultsError(400, "知识库不存在：kb-9");
	await t.refreshKb();
	t.renderModuleView();
	kbBoxOf(0).checked = true;
	kbBoxOf(0).dispatch("change");
	await flush(80);
	const notice = els.modulePage.querySelector(".kb-defaults-notice");
	assert.ok(notice, "失败也要有页面内提示");
	assert.equal(notice.classList.contains("err"), true, "失败要标红");
	assert.equal(notice.textContent, "知识库不存在：kb-9", "后端文案原样显示，不自己编一句");
	assert.equal(t.alerts.length, 0);
	assert.equal(kbBoxOf(0).checked, false, "保存失败后不能显示成已开");
	assert.ok(kbDefaultsStatus().textContent.includes("对话检索：未启用"));
	t.setKbDefaultsError(null);
});

await check("PUT 403：显示后端权限文案，不当成「未接入」也不弹错误弹窗", async () => {
	t.setKbDefaultIds([]);
	t.setKbDefaultsError(403, "当前角色不能修改知识库");
	await t.refreshKb();
	t.renderModuleView();
	kbBoxOf(1).checked = true;
	kbBoxOf(1).dispatch("change");
	await flush(80);
	const notice = els.modulePage.querySelector(".kb-defaults-notice");
	assert.equal(notice?.textContent, "当前角色不能修改知识库");
	assert.equal(notice.classList.contains("err"), true);
	// 页面仍然是真页面（库列表 + 状态条），没有掉进「未接入」空态
	assert.equal(kbItems().length, 2);
	assert.equal(els.modulePage.querySelector(".module-badge"), null);
	t.setKbDefaultsError(null);
	// 恢复夹具，别把错误夹具留给后面的用例
	t.resetKbFixtures();
	await t.refreshKb();
	t.renderModuleView();
	assert.equal(kbDefaultBoxes().length, 2);
});

/* ================= 16. 技能绑定知识库 ================= */

section("技能 ↔ 知识库绑定（P5）");

await check("「⋯」菜单里的「绑定知识库」：列出全部库、预勾选已绑的，保存 PUT 回 kbIds", async () => {
	t.setKbAvailable(true);
	t.resetKbFixtures();
	await t.openSkillKbDialog({ id: "report-flow", name: "周报助手" });
	await flush(60);
	assert.equal(els.kbModal.hidden, false);
	assert.equal(els.kbModalTitle.textContent, "绑定知识库 · 周报助手");
	const rows = Array.from(els.kbModalBody.querySelectorAll(".kb-bind-row"));
	assert.equal(rows.length, 2, "列出全部知识库");
	const boxes = Array.from(els.kbModalBody.querySelectorAll(".kb-bind-box"));
	assert.equal(boxes.map((box) => box.value).join("|"), "kb-1|kb-2");
	assert.equal(boxes[0].checked, true, "report-flow 已绑 kb-1（GET /api/skills/:id/kb 预勾选）");
	assert.equal(boxes[1].checked, false);
	boxes[1].checked = true;
	await t.submitKbDialog();
	await flush(60);
	const puts = t.calls.filter((call) => call.method === "PUT" && call.url === "/api/skills/report-flow/kb");
	assert.equal(puts.length, 1);
	assert.equal(puts[0].body.kbIds.join("|"), "kb-1|kb-2");
	assert.equal(els.kbModal.hidden, true, "保存成功关弹窗");
});

/* ================= 17. 登录 / 角色（P3） ================= */

section("登录 / 角色（P3）");

const authHeaders = () => t.calls.filter((call) => call.url === "/api/sessions").at(-1)?.headers ?? {};

await check("GET /api/auth/me 401：挡出登录页，控制台不渲染也不拉会话", async () => {
	t.setAuthMode("required");
	t.localStorageStore.clear();
	t.state.sessions = [];
	const sessionsBefore = t.calls.filter((call) => call.url === "/api/sessions").length;
	await t.bootstrap();
	await flush(40);
	assert.equal(t.state.loginVisible, true);
	assert.equal(els.loginGate.hidden, false);
	assert.equal(els.loginError.hidden, true, "首次进登录页不该带错误文案");
	assert.equal(documentStub.body.classList.contains("auth-required"), true, "样式上要挡住控制台");
	assert.equal(t.calls.filter((call) => call.url === "/api/sessions").length, sessionsBefore, "没登录不该拉会话");
	assert.equal(t.state.sessions.length, 0);
});

await check("登录成功：POST /api/auth/login → token 存 localStorage → 进控制台拉数据", async () => {
	t.setLoginStatus(200);
	els.loginEmail.value = "le@biz-agent.dev";
	els.loginPassword.value = "s3cret";
	const before = t.calls.filter((call) => call.url === "/api/auth/login").length;
	await t.submitLogin();
	await flush(80);
	const posts = t.calls.filter((call) => call.url === "/api/auth/login");
	assert.equal(posts.length, before + 1);
	assert.equal(posts.at(-1).body.email, "le@biz-agent.dev");
	assert.equal(t.localStorageStore.get("biz.token"), "tok-123", "token 存 biz.token");
	assert.equal(t.state.loginVisible, false);
	assert.equal(els.loginGate.hidden, true);
	assert.equal(documentStub.body.classList.contains("auth-required"), false);
	assert.ok(t.state.sessions.length > 0, "登录后要拉会话");
	assert.equal(els.loginPassword.value, "", "密码框要清掉");
});

await check("登录失败文案：401 → 「邮箱或密码不对」，429 → 「尝试太频繁，稍后再试」", async () => {
	await t.logout();
	t.setLoginStatus(401);
	els.loginEmail.value = "le@biz-agent.dev";
	els.loginPassword.value = "wrong";
	await t.submitLogin();
	await flush(40);
	assert.equal(els.loginError.textContent, "邮箱或密码不对");
	assert.equal(els.loginError.hidden, false);
	assert.equal(t.state.loginVisible, true, "失败要停在登录页");
	t.setLoginStatus(429);
	await t.submitLogin();
	await flush(40);
	assert.equal(els.loginError.textContent, "尝试太频繁，稍后再试");
	t.setLoginStatus(200);
});

await check("进控制台后请求都带 Authorization: Bearer <token>", async () => {
	await t.submitLogin();
	await flush(80);
	assert.equal(t.localStorageStore.get("biz.token"), "tok-123");
	assert.equal(authHeaders().Authorization, "Bearer tok-123", "会话接口要带上 token");
	assert.ok(authHeaders().Authorization.startsWith("Bearer "), "必须是 Bearer 头");
});

await check("角色与权限：operator 显示「运营」；没有 workflow:write 时「＋新建技能」置灰并说明原因", async () => {
	t.setAuthMode("off");
	t.setAuthUser({ id: "u-2", name: "王运营", email: "wang@biz-agent.dev", role: "operator" });
	t.setAuthPermissions(["kb:write"]);
	await t.bootstrap();
	await flush(60);
	assert.equal(t.state.loginVisible, false, "AUTH_MODE=off 不出登录页");
	assert.equal(els.railAvatar.textContent, "王", "头像用名字首字");
	assert.equal(els.railRole.textContent, "运营");
	assert.equal(els.railRole.hidden, false);
	assert.equal(t.canWriteWorkflow(), false);
	await t.switchModule("chat");
	await t.switchModule("skills");
	await flush(60);
	const add = Array.from(els.modulePage.querySelectorAll(".btn-ghost")).find((node) =>
		node.textContent.includes("新建技能"),
	);
	assert.ok(add, "技能页头部要有「＋ 新建技能」");
	assert.equal(add.disabled, true, "没权限要置灰");
	assert.ok(add.title.includes("workflow"), `要说明原因：${add.title}`);
	// 后端现役权限是点号（workflow.write），任务书契约写的是冒号（workflow:write）：两种都得认
	// 这里直接改 state.permissions：夹具里的 authPermissions 只在 bootstrap 那一下灌进 state
	t.state.permissions = ["workflow.write"];
	assert.equal(t.canWriteWorkflow(), true, "点号写法也要放行");
	t.state.permissions = ["workflow:write"];
	assert.equal(t.canWriteWorkflow(), true, "冒号写法也要放行");
	t.state.permissions = ["session.read"];
	assert.equal(t.canWriteWorkflow(), false, "没有写权限就置灰");
	t.state.permissions = [];
	assert.equal(t.canWriteWorkflow(), true, "没有权限清单（后端没上登录）不限制");
});

await check("退出登录：清 token 回登录页；免登录模式（builtin）菜单里没有「退出登录」", async () => {
	t.setAuthUser({ id: "owner", name: "所有者", email: "owner@local", role: "owner", builtin: true });
	t.setAuthPermissions(["workflow:write", "kb:write"]);
	await t.bootstrap();
	await flush(40);
	assert.equal(t.canLogout(), false, "builtin 伪用户不该能退出");
	t.openIdentityMenu();
	const labels = Array.from(els.menu.querySelectorAll(".menu-item")).map((node) => node.textContent);
	els.menu.hidden = true;
	assert.ok(!labels.some((line) => line.includes("退出登录")), `免登录模式不给退出：${labels.join("|")}`);
	// 换回真登录态再退一次
	t.setAuthUser({ id: "u-1", name: "李工", email: "le@biz-agent.dev", role: "owner" });
	t.setAuthMode("required");
	await t.bootstrap();
	await flush(40);
	assert.equal(els.loginGate.hidden, false);
	els.loginEmail.value = "le@biz-agent.dev";
	els.loginPassword.value = "s3cret";
	await t.submitLogin();
	await flush(80);
	assert.equal(t.localStorageStore.get("biz.token"), "tok-123");
	await t.logout();
	await flush(40);
	assert.equal(t.localStorageStore.has("biz.token"), false, "退出要清掉 token");
	assert.equal(t.state.loginVisible, true);
	assert.equal(els.loginGate.hidden, false);
	assert.equal(t.state.sessions.length, 0, "退出后不该留着上一个身份的会话");
});

await check("登录页与知识库页的文案里都没有「流程」", async () => {
	t.setAuthPermissions(["workflow:write", "kb:write"]);
	assert.ok(!els.loginGate.textContent.includes("流程"), els.loginGate.textContent.slice(0, 80));
	els.loginEmail.value = "le@biz-agent.dev";
	els.loginPassword.value = "s3cret";
	await t.submitLogin();
	await flush(80);
	t.setKbAvailable(true);
	t.resetKbFixtures();
	await t.switchModule("knowledge");
	await flush(80);
	assert.equal(t.state.module, "knowledge");
	const kbText = els.modulePage.textContent;
	assert.ok(!kbText.includes("流程"), `知识库页出现「流程」：${kbText.slice(0, 80)}`);
	await t.switchModule("chat");
	await flush(40);
	assert.equal(t.state.loginVisible, false, "收尾：仍处于登录态");
});

/* ================= 18. 成员 / 审计 / 设置（P4） ================= */

section("成员 / 审计 / 设置（P4）：真接口 + 权限不足");

const memberRows = () => Array.from(els.modulePage.querySelectorAll(".member-row"));
const auditRows = () => Array.from(els.modulePage.querySelectorAll(".audit-row"));
const kvMap = () =>
	new Map(
		Array.from(els.modulePage.querySelectorAll(".module-kv__row")).map((row) => [
			row.querySelector(".module-kv__label").textContent,
			row.querySelector(".module-kv__value").textContent,
		]),
	);
const memberAddButton = () =>
	Array.from(els.modulePage.querySelectorAll(".btn-ghost")).find((node) => node.textContent.includes("新建成员")) ?? null;
const auditCalls = () => t.calls.filter((call) => call.url.startsWith("/api/audit"));
const memberCalls = () => t.calls.filter((call) => call.url === "/api/auth/users");

await check("成员页懒加载：切到别的模块不拉，切到「成员」才拉一次", async () => {
	t.setMembersAvailable(true);
	t.resetMemberStore();
	await t.switchModule("chat");
	const before = memberCalls().length;
	await t.switchModule("models");
	assert.equal(memberCalls().length, before, "切到「模型」不该顺带拉成员");
	await t.switchModule("members");
	await flush(60);
	assert.equal(memberCalls().length, before + 1, "切到「成员」拉一次 /api/auth/users");
	assert.equal(t.state.module, "members");
});

await check("成员表格：4 行，姓名 / 邮箱 / 中文角色 / 状态 / 人性化最近登录", async () => {
	t.state.permissions = ["member.manage"];
	await t.refreshMembers();
	t.renderModuleView();
	assert.equal(pageTitle(), "成员");
	const rows = memberRows();
	assert.equal(rows.length, 4, "夹具给了 4 位成员");
	assert.equal(rows[0].querySelector(".member-name").textContent, "李工");
	assert.equal(rows[0].querySelector(".member-email").textContent, "le@biz-agent.dev");
	assert.equal(rows[0].querySelector(".member-role").textContent, "所有者", "后端给了 roleLabel 就用它");
	assert.equal(rows[1].querySelector(".member-role").textContent, "运营", "没 roleLabel 就用本地四角色映射");
	assert.equal(rows[2].querySelector(".member-name").textContent, "—", "没有姓名就写破折号，别拿邮箱冒充姓名");
	assert.equal(rows[1].querySelector(".member-badge").textContent, "正常");
	assert.equal(rows[2].querySelector(".member-badge").textContent, "已停用");
	assert.equal(rows[0].querySelector(".member-login").textContent, "5 分钟前");
	assert.equal(rows[1].querySelector(".member-login").textContent, "3 小时前");
	assert.equal(rows[2].querySelector(".member-login").textContent, "从未登录");
	assert.equal(rows[3].querySelector(".member-login").textContent, "—", "接口没给 lastLoginAt 就不能编一个时间");
	assert.ok(els.modulePage.textContent.includes("共 4 位成员"));
});

await check("「＋ 新建成员」：有 member.manage 时可点，弹窗四个字段 + 四角色中文下拉", async () => {
	const add = memberAddButton();
	assert.ok(add, "成员页头部要有「＋ 新建成员」");
	assert.equal(add.disabled, false);
	add.click();
	await flush(20);
	assert.equal(els.kbModal.hidden, false);
	assert.equal(els.kbModalTitle.textContent, "新建成员");
	assert.equal(els.kbSave.textContent, "创建");
	assert.equal(els.kbModalBody.querySelectorAll(".kb-field").length, 4, "邮箱 / 密码 / 姓名 / 角色");
	assert.equal(els.kbModalBody.querySelectorAll("input").item(1).type, "password", "密码框必须是 password");
	const select = els.kbModalBody.querySelector("select");
	assert.deepEqual(
		Array.from(select.querySelectorAll("option")).map((node) => node.textContent),
		["所有者", "开发者", "运营", "审计员"],
	);
	assert.equal(select.value, "developer", "默认给权限最小的开发者");
});

await check("新建成员：POST /api/auth/users 的体是 邮箱+密码+姓名+角色（JSON），成功后刷新列表", async () => {
	const inputs = els.kbModalBody.querySelectorAll("input");
	inputs.item(0).value = "new.person@demo.local";
	inputs.item(1).value = "demo123456";
	inputs.item(2).value = "新同学";
	els.kbModalBody.querySelector("select").value = "auditor";
	const before = t.calls.filter((call) => call.url === "/api/auth/users" && call.method === "POST").length;
	await t.submitKbDialog();
	await flush(80);
	const posts = t.calls.filter((call) => call.url === "/api/auth/users" && call.method === "POST");
	assert.equal(posts.length, before + 1);
	assert.deepEqual(posts.at(-1).body, {
		email: "new.person@demo.local",
		password: "demo123456",
		role: "auditor",
		name: "新同学",
	});
	assert.equal(posts.at(-1).headers["Content-Type"], "application/json");
	assert.equal(els.kbModal.hidden, true, "创建成功要关弹窗");
	assert.equal(memberRows().length, 5, "列表刷新出新成员");
	assert.equal(memberRows().at(-1).querySelector(".member-name").textContent, "新同学");
	assert.equal(memberRows().at(-1).querySelector(".member-role").textContent, "审计员");
});

await check("新建成员失败：后端 {error} 文案原样显示在弹窗里（不 alert、不关弹窗）", async () => {
	t.setMemberCreateError("邮箱已被使用");
	memberAddButton().click();
	await flush(20);
	const inputs = els.kbModalBody.querySelectorAll("input");
	inputs.item(0).value = "dup@demo.local";
	inputs.item(1).value = "demo123456";
	const alertsBefore = t.alerts.length;
	await t.submitKbDialog();
	await flush(80);
	assert.equal(els.kbModal.hidden, false, "失败不该关弹窗");
	assert.equal(els.kbError.hidden, false);
	assert.equal(els.kbError.textContent, "邮箱已被使用", "把后端的中文文案原样给用户");
	assert.equal(t.alerts.length, alertsBefore, "不能用 alert 弹");
	t.setMemberCreateError(null);
	t.closeKbDialog();
});

await check("没有 member.manage：按钮置灰并说明「当前角色不能管理成员」，弹窗也打不开", async () => {
	t.state.permissions = ["workflow.read", "session.read"];
	t.renderModuleView();
	const add = memberAddButton();
	assert.equal(add.disabled, true, "没权限要置灰");
	assert.equal(add.title, "当前角色不能管理成员");
	assert.equal(t.canManageMembers(), false);
	t.openNewMemberDialog();
	assert.equal(els.kbModal.hidden, true, "没权限时弹窗都不该打开");
	// 点号 / 冒号两种写法都认；没有权限清单（后端没上登录）不限制
	t.state.permissions = ["member.manage"];
	assert.equal(t.canManageMembers(), true);
	t.state.permissions = ["member:manage"];
	assert.equal(t.canManageMembers(), true);
	t.state.permissions = [];
	assert.equal(t.canManageMembers(), true);
	t.state.permissions = ["member.manage"];
});

await check("成员接口 403：整页「当前角色不能管理成员」，不画表格也不冒充「未接入」", async () => {
	t.setMembersStatus(403);
	await t.refreshMembers();
	t.renderModuleView();
	assert.equal(t.state.members.status, "forbidden");
	assert.equal(els.modulePage.querySelectorAll(".member-row").length, 0);
	assert.equal(els.modulePage.querySelector(".module-denied__text")?.textContent, "当前角色不能管理成员");
	assert.equal(els.modulePage.querySelector(".module-badge"), null, "403 不是「未接入」");
	assert.equal(t.alerts.length, 0, "403 不该弹 alert");
	t.setMembersStatus(200);
});

await check("成员接口 404：回落「未接入」空态（说明 + 接口清单），不弹错", async () => {
	t.setMembersAvailable(false);
	await t.refreshMembers();
	t.renderModuleView();
	assert.equal(memberRows().length, 0, "降级后不该画表格");
	assert.equal(els.modulePage.querySelector(".module-badge")?.textContent, "未接入");
	assert.deepEqual(
		Array.from(els.modulePage.querySelectorAll(".module-api__code")).map((node) => node.textContent),
		["GET /api/auth/users", "POST /api/auth/users"],
	);
	assert.equal(Array.from(els.threadInner.querySelectorAll(".notice.err")).length, 0, "降级不该弹错误提示");
	t.setMembersAvailable(true);
});

await check("成员空态：后端返回空数组时写「还没有成员」，不编假数据", async () => {
	await t.switchModule("chat");
	await t.switchModule("members");
	await flush(60);
	const saved = t.state.members.items;
	t.state.members.items = [];
	t.renderModuleView();
	assert.ok(els.modulePage.textContent.includes("还没有成员"));
	assert.equal(memberRows().length, 0);
	assert.equal(els.modulePage.querySelector(".module-badge"), null, "空列表不是「未接入」");
	t.state.members.items = saved;
});

await check("审计页：真接口拉第一页 50 条，表格画出时间 / 操作者 / 动作 / 目标 / 详情 / traceId", async () => {
	t.setAuditAvailable(true);
	t.resetAuditStore();
	t.state.audit.action = "";
	t.state.audit.actor = "";
	await t.switchModule("chat");
	await t.switchModule("audit");
	await flush(80);
	assert.equal(pageTitle(), "审计");
	assert.equal(auditCalls().at(-1).url, "/api/audit?limit=50&offset=0", "首页从 offset=0 拉 50 条");
	assert.equal(auditRows().length, 50, "第一页 50 条");
	const first = auditRows()[0];
	assert.equal(first.querySelector(".audit-actor").textContent, "所有者 · u-1", "用户操作者显示「角色 · id」");
	assert.equal(first.querySelector(".audit-action").textContent, "user.create");
	assert.equal(first.querySelector(".audit-target").textContent, "user · u-5");
	assert.equal(first.querySelector(".audit-time").textContent.length, 19, "时间精确到秒");
	assert.equal(auditRows()[1].querySelector(".audit-actor").textContent, "系统", "系统动作没有角色");
	assert.equal(auditRows()[1].querySelector(".audit-target").textContent, "—", "没有目标就写破折号");
	assert.ok(els.modulePage.textContent.includes("已显示 50 / 120 条"));
});

await check("审计详情摘要：超过 60 字截断加省略号，完整内容挂在 title 上", () => {
	const detail = auditRows()[1].querySelector(".audit-detail");
	assert.equal(detail.textContent.length, 61, "60 字 + 一个省略号");
	assert.ok(detail.textContent.endsWith("…"), detail.textContent);
	assert.ok(detail.title.length > 60, "完整内容留在 title 里给人 hover 看");
	assert.equal(
		auditRows()[0].querySelector(".audit-detail").textContent,
		"email=new@biz-agent.dev · role=developer",
		"不到 60 字就原样显示（对象摘要写成 key=value，便于断行）",
	);
	assert.equal(auditRows()[0].querySelector(".audit-detail").title, "", "没截断就不要 title");
});

await check("审计筛选防抖：动作关键字停手后只发一次请求，action 进 query", async () => {
	const before = auditCalls().length;
	const input = els.modulePage.querySelectorAll(".audit-field").item(0).querySelector("input");
	input.value = "user";
	input.dispatch("input");
	input.value = "user.c";
	input.dispatch("input");
	assert.equal(auditCalls().length, before, "防抖期间不该立刻发请求");
	await flush(400);
	const calls = auditCalls();
	assert.equal(calls.length, before + 1, "连着改两次只发一次");
	assert.ok(calls.at(-1).url.includes("action=user.c"), `动作关键字要进 query：${calls.at(-1).url}`);
	assert.equal(auditRows().length, 1, "只剩匹配动作的那一条");
	assert.equal(auditRows()[0].querySelector(".audit-action").textContent, "user.create");
	assert.ok(els.modulePage.textContent.includes("已显示 1 / 1 条"));
	assert.equal(els.modulePage.querySelector(".audit-more").disabled, true, "一页就装下了，不该再给加载更多");
});

await check("审计操作者筛选：actor 进 query，叠加动作关键字后结果只剩该操作者", async () => {
	const before = auditCalls().length;
	const input = els.modulePage.querySelectorAll(".audit-field").item(1).querySelector("input");
	input.value = "u-1";
	input.dispatch("input");
	await flush(400);
	const calls = auditCalls();
	assert.equal(calls.length, before + 1);
	assert.ok(calls.at(-1).url.includes("actor=u-1"), `操作者要进 query：${calls.at(-1).url}`);
	assert.ok(calls.at(-1).url.includes("action=user.c"), "两个筛选同时生效");
	assert.equal(auditRows().length, 1);
	assert.equal(auditRows()[0].querySelector(".audit-actor").textContent, "所有者 · u-1");
});

await check("审计分页：「加载更多」按 offset=50/100 追加，到底后按钮置灰", async () => {
	t.state.audit.action = "";
	t.state.audit.actor = "";
	await t.refreshAudit({ reset: true });
	t.renderModuleView();
	assert.equal(auditRows().length, 50);
	assert.equal(auditCalls().at(-1).url, "/api/audit?limit=50&offset=0", "清空筛选后回到第一页");
	const more = els.modulePage.querySelector(".audit-more");
	assert.equal(more.disabled, false);
	more.click();
	await flush(80);
	assert.equal(auditCalls().at(-1).url, "/api/audit?limit=50&offset=50", "第二页从 50 开始");
	assert.equal(auditRows().length, 100, "追加而不是替换");
	assert.ok(els.modulePage.textContent.includes("已显示 100 / 120 条"));
	els.modulePage.querySelector(".audit-more").click();
	await flush(80);
	assert.equal(auditCalls().at(-1).url, "/api/audit?limit=50&offset=100");
	assert.equal(auditRows().length, 120);
	assert.equal(els.modulePage.querySelector(".audit-more").disabled, true, "全加载完就置灰");
});

await check("审计 traceId 可点复制：写进剪贴板，按钮短暂变「已复制」", async () => {
	const button = els.modulePage.querySelector(".audit-trace-btn");
	assert.equal(button.textContent, "trace-user");
	assert.equal(button.title, "点击复制 traceId");
	button.click();
	await flush(20);
	assert.ok(clipboardWrites.includes("trace-user"), `剪贴板要拿到 traceId：${clipboardWrites.join("|")}`);
	assert.equal(button.textContent, "已复制");
});

await check("审计空态：还没有审计记录（不是「未接入」）", async () => {
	const saved = t.state.audit.items;
	t.state.audit.status = "ready";
	t.state.audit.items = [];
	t.state.audit.total = 0;
	t.renderModuleView();
	assert.ok(els.modulePage.textContent.includes("还没有审计记录"));
	assert.equal(els.modulePage.querySelectorAll(".module-badge").length, 0);
	assert.equal(els.modulePage.querySelector(".audit-more"), null, "没记录就不给「加载更多」");
	t.state.audit.items = saved;
	t.state.audit.total = 120;
});

await check("审计筛选没匹配上：提示「没有匹配的审计记录」，不冒充「还没有审计记录」", () => {
	t.state.audit.status = "ready";
	t.state.audit.items = [];
	t.state.audit.total = 0;
	t.state.audit.action = "definitely-not-an-action";
	t.renderModuleView();
	assert.ok(els.modulePage.textContent.includes("没有匹配的审计记录"));
	assert.ok(!els.modulePage.textContent.includes("还没有审计记录"), "有筛选时不能暗示整个审计是空的");
	t.state.audit.action = "";
	t.state.audit.actor = "";
});

await check("审计接口 403：整页「当前角色不能查看审计记录」，不留筛选框与假表格", async () => {
	t.setAuditStatus(403);
	await t.refreshAudit({ reset: true });
	t.renderModuleView();
	assert.equal(t.state.audit.status, "forbidden");
	assert.equal(els.modulePage.querySelector(".module-denied__text")?.textContent, "当前角色不能查看审计记录");
	assert.equal(els.modulePage.querySelector(".audit-filter"), null, "403 还留着筛选框只会让人白试");
	assert.equal(auditRows().length, 0);
	t.setAuditStatus(200);
});

await check("审计接口 404：回落「未接入」空态，仍说明「运行详情」这个现有入口", async () => {
	t.setAuditAvailable(false);
	await t.refreshAudit({ reset: true });
	t.renderModuleView();
	assert.equal(els.modulePage.querySelector(".module-badge")?.textContent, "未接入");
	assert.ok((els.modulePage.querySelector(".module-note__text")?.textContent ?? "").includes("运行详情"));
	assert.equal(Array.from(els.threadInner.querySelectorAll(".notice.err")).length, 0);
	t.setAuditAvailable(true);
});

await check("设置页：存储 / 鉴权 / 模型 / 会话数 / 运行时长 / 语义检索都从真接口来", async () => {
	// health + embedding 都用夹具覆盖成"另一台机器"的样子：证明这一页不是写死的
	t.setHealthFixture({
		auth: "required",
		uptimeMs: (2 * 3600 + 5 * 60) * 1000 + 5000,
		storage: { kind: "postgres", detail: "db.internal:5432/biz" },
		model: { mode: "live", id: "deepseek-chat", label: "DeepSeek Chat" },
	});
	t.setKbEmbedding({ available: true, model: "bge-m3", baseUrl: "http://127.0.0.1:11434" });
	await t.switchModule("chat");
	await t.switchModule("settings");
	await flush(80);
	assert.equal(pageTitle(), "设置");
	const kv = kvMap();
	assert.equal(kv.get("存储后端"), "PostgreSQL（db.internal:5432/biz）", "存储后端 = 类型 + 定位串");
	assert.ok(kv.get("鉴权模式").includes("需要登录") && kv.get("鉴权模式").includes("required"), kv.get("鉴权模式"));
	assert.equal(kv.get("当前模型"), "DeepSeek Chat（live）", "模型名 + 模式");
	assert.equal(kv.get("可用模型"), "2 个", "可用模型数来自 /api/models");
	assert.equal(kv.get("会话数"), String(t.state.sessions.length));
	assert.equal(kv.get("运行时长"), "2 小时 5 分", "uptimeMs → x 小时 y 分");
	assert.equal(kv.get("语义检索"), "已启用 · bge-m3");
	assert.equal(kv.get("技能数"), "5", "技能数照旧从目录来");
	assert.ok(!els.modulePage.textContent.includes("模拟模型"), "模型不是写死的模拟模型");
});

await check("设置页语义检索未启用：写「未启用（用关键词检索）」并提示 EMBEDDING_* 环境变量", async () => {
	t.setHealthFixture({ auth: "off" });
	t.setKbEmbedding({ available: false, model: "text-embedding-3-small", baseUrl: null });
	await t.switchModule("chat");
	await t.switchModule("settings");
	await flush(80);
	const kv = kvMap();
	assert.equal(kv.get("语义检索"), "未启用（用关键词检索）");
	assert.ok(kv.get("鉴权模式").includes("免登录"), kv.get("鉴权模式"));
	for (const env of ["EMBEDDING_BASE_URL", "EMBEDDING_MODEL", "EMBEDDING_API_KEY"]) {
		assert.ok(els.modulePage.textContent.includes(env), `要提示配置 ${env}`);
	}
	// 写操作还没接：只标这一段未接入，不整页挂空态
	assert.equal(els.modulePage.querySelectorAll(".module-badge").length, 1);
	assert.equal(els.modulePage.querySelector(".module-badge")?.textContent, "未接入");
	assert.ok(els.modulePage.textContent.includes("PATCH /api/settings"));
});

await check("设置页的数据来自 /api/health + /api/kb/embedding + /api/models 三个真接口", async () => {
	await t.switchModule("chat");
	const before = t.calls.length;
	await t.switchModule("settings");
	await flush(80);
	const urls = t.calls.slice(before).map((call) => call.url);
	for (const url of ["/api/health", "/api/kb/embedding", "/api/models"]) {
		assert.ok(urls.includes(url), `切到设置页要拉 ${url}：${urls.join(" | ")}`);
	}
});

await check("成员 / 审计 / 设置三页都不出现「流程」二字", async () => {
	t.setHealthFixture({});
	for (const id of ["members", "audit", "settings"]) {
		await t.switchModule("chat");
		await t.switchModule(id);
		await flush(60);
		const text = els.modulePage.textContent;
		assert.ok(!text.includes("流程"), `${id} 页出现「流程」：${text.slice(0, 80)}`);
	}
	await t.switchModule("chat");
});

/* ================= 19. 模型 / API Key（P6 + P4） ================= */

section("模型 / API Key（P6 + P4）：真接口 + 权限");

const providerRows = () => Array.from(els.modulePage.querySelectorAll(".provider-row"));
const modelAdminRows = () => Array.from(els.modulePage.querySelectorAll(".model-admin-row"));
const apiKeyRows = () => Array.from(els.modulePage.querySelectorAll(".apikey-row"));
const btnByText = (scope, selector, text) =>
	Array.from(scope.querySelectorAll(selector)).find((node) => node.textContent.includes(text)) ?? null;
const providerRowByName = (name) => providerRows().find((row) => row.querySelector(".provider-name")?.textContent === name) ?? null;
const modelRowByModelId = (modelId) =>
	modelAdminRows().find((row) => row.querySelector(".model-admin-modelid")?.textContent === modelId) ?? null;
const setModelRowEnabled = (rowId, enabled) => {
	modelRowStore = modelRowStore.map((row) => (row.id === rowId ? { ...row, enabled } : row));
};
const keyOne = () => t.calls.filter((call) => call.url === "/api/api-keys" || call.url.startsWith("/api/api-keys/"));

await check("模型页：切到「模型」才拉接口，ready 时画当前模型 / 模式徽标 / 供应商与模型表", async () => {
	t.state.permissions = ["workflow.write", "workflow.read"];
	t.resetModelFixtures();
	await t.switchModule("chat");
	const before = t.calls.filter((call) => call.url === "/api/models").length;
	await t.switchModule("models");
	await flush(80);
	assert.equal(t.calls.filter((call) => call.url === "/api/models").length, before + 1, "切到模型页拉一次 /api/models");
	assert.equal(t.state.modelAdmin.status, "ready");
	assert.equal(pageTitle(), "模型");
	assert.equal(els.modulePage.querySelector(".model-status__current")?.textContent, "DeepSeek Chat");
	assert.equal(els.modulePage.querySelector(".model-mode-badge")?.textContent, "真实模型");
	assert.equal(providerRows().length, 2, "夹具给了 2 个供应商");
	assert.equal(modelAdminRows().length, 2, "夹具给了 2 个模型");
});

await check("供应商 Key 解不开：页面给解释与重填入口，填好后提示消失", async () => {
	assert.equal(els.modulePage.querySelector(".model-key-warn"), null, "正常状态不该有这条警告");
	t.state.modelAdmin.providers[0].apiKeyBroken = true;
	t.state.modelAdmin.providers[0].apiKeyMasked = "****（无法解密，请重新填写）";
	t.renderModuleView();
	const warn = els.modulePage.querySelector(".model-key-warn");
	assert.ok(warn, "解不开时要在页面上给提示，不能只在表格里一行红字");
	assert.ok(warn.textContent.includes("SECRET_KEY"), "要说明原因（没配 SECRET_KEY / 换过密钥）");
	assert.ok(warn.textContent.includes("重新填写"), "要给恢复办法");
	warn.querySelector(".model-key-warn__fix").click();
	assert.equal(els.kbModal.hidden, false);
	assert.equal(els.kbModalTitle.textContent, "编辑供应商", "点按钮直接打开该供应商的编辑弹窗");
	els.kbModalClose.click();
	t.state.modelAdmin.providers[0].apiKeyBroken = false;
	t.state.modelAdmin.providers[0].apiKeyMasked = "sk-d…cdef";
	t.renderModuleView();
	assert.equal(els.modulePage.querySelector(".model-key-warn"), null, "Key 恢复正常后提示要消失");
});

await check("当前模型卡说明「选择会保存，运行中会话不切换」", () => {
	const note = els.modulePage.querySelector(".model-status__note")?.textContent ?? "";
	assert.ok(note.includes("保存"), `要写清选择会保存：${note}`);
	assert.ok(note.includes("运行中的会话不会切换"), `要写清对现有会话的影响：${note}`);
	assert.ok(els.modulePage.querySelector(".model-switch")?.title.includes("保存"), "切换按钮也要有悬停说明");
});

await check("供应商表：中文类型 / 端点 / Key 掩码或未配置 / 启用状态", () => {
	const first = providerRows()[0];
	assert.equal(first.querySelector(".provider-name").textContent, "DeepSeek 官方");
	assert.equal(first.querySelector(".provider-kind").textContent, "DeepSeek");
	assert.equal(first.querySelector(".provider-endpoint").textContent, "https://api.deepseek.com/v1");
	assert.equal(first.querySelector(".provider-key").textContent, "sk-d…cdef", "Key 只能显示后端给的掩码");
	assert.equal(first.querySelector(".model-badge").textContent, "启用");
	const second = providerRows()[1];
	assert.equal(second.querySelector(".provider-kind").textContent, "Ollama");
	assert.equal(second.querySelector(".provider-key").textContent, "未配置");
});

await check("模型表：供应商名 / modelId / 中文类型 / 上下文窗口 / 启用 / 当前标记", () => {
	const chat = modelRowByModelId("deepseek-chat");
	assert.equal(chat.querySelector(".model-admin-name-text").textContent, "DeepSeek Chat");
	assert.equal(chat.querySelector(".model-admin-provider").textContent, "DeepSeek 官方");
	assert.equal(chat.querySelector(".model-admin-kind").textContent, "对话");
	assert.equal(chat.querySelector(".model-admin-context").textContent, "128000");
	assert.equal(chat.querySelector(".model-badge").textContent, "启用");
	assert.equal(chat.querySelector(".model-current-tag")?.textContent, "当前");
	const embed = modelRowByModelId("nomic-embed-text");
	assert.equal(embed.querySelector(".model-admin-kind").textContent, "向量");
	assert.equal(embed.querySelector(".model-badge").textContent, "停用");
	assert.equal(embed.querySelector(".model-current-tag"), null);
});

await check("「＋ 新建供应商」：弹窗字段齐全（name / kind 下拉 / baseUrl / password Key / 启用）", () => {
	const add = btnByText(els.modulePage.querySelector(".module-page__actions"), "button", "新建供应商");
	assert.ok(add, "模型页头部要有「＋ 新建供应商」");
	add.click();
	assert.equal(els.kbModal.hidden, false);
	assert.equal(els.kbModalTitle.textContent, "新建供应商");
	assert.ok(els.kbModalBody.querySelector(".provider-form-name"), "名称输入框");
	assert.equal(els.kbModalBody.querySelector(".provider-form-kind").tagName, "SELECT");
	assert.equal(els.kbModalBody.querySelector(".provider-form-key").type, "password", "API Key 必须是 password");
	assert.deepEqual(
		Array.from(els.kbModalBody.querySelectorAll(".provider-form-kind option")).map((node) => node.textContent),
		["OpenAI", "DeepSeek", "Ollama", "Anthropic", "自定义"],
	);
});

await check("新建供应商：POST body 含明文 Key，之后列表只回显掩码（页面里没有明文）", async () => {
	const inputs = els.kbModalBody.querySelectorAll(".kb-field-input");
	els.kbModalBody.querySelector(".provider-form-name").value = "本地测试供应商";
	els.kbModalBody.querySelector(".provider-form-kind").value = "custom";
	els.kbModalBody.querySelector(".provider-form-base").value = "https://example.test/v1";
	els.kbModalBody.querySelector(".provider-form-key").value = "sk-test-plain-1234";
	els.kbModalBody.querySelector(".kb-check").checked = true;
	const before = t.calls.filter((call) => call.url === "/api/models/providers" && call.method === "POST").length;
	await t.submitKbDialog();
	await flush(80);
	const posts = t.calls.filter((call) => call.url === "/api/models/providers" && call.method === "POST");
	assert.equal(posts.length, before + 1);
	assert.deepEqual(posts.at(-1).body, {
		name: "本地测试供应商",
		kind: "custom",
		baseUrl: "https://example.test/v1",
		enabled: true,
		apiKey: "sk-test-plain-1234",
	});
	assert.equal(posts.at(-1).headers["Content-Type"], "application/json");
	assert.equal(els.kbModal.hidden, true, "创建成功要关弹窗");
	const created = providerRowByName("本地测试供应商");
	assert.ok(created, "列表要刷新出新供应商");
	assert.equal(created.querySelector(".provider-key").textContent, "sk-…1234", "只回显掩码");
	assert.ok(!els.modulePage.textContent.includes("sk-test-plain-1234"), "页面里不许出现明文 Key");
	assert.equal(inputs.length > 0, true);
});

await check("编辑供应商：apiKey 留空时 PATCH body 不带 apiKey（保持原值）", async () => {
	providerRowByName("本地测试供应商").querySelector(".provider-edit").click();
	assert.equal(els.kbModalTitle.textContent, "编辑供应商");
	assert.equal(els.kbModalBody.querySelector(".provider-form-key").value, "", "编辑时密码框永远从空开始");
	els.kbModalBody.querySelector(".provider-form-name").value = "本地测试供应商（改）";
	await t.submitKbDialog();
	await flush(80);
	const patches = t.calls.filter((call) => /^\/api\/models\/providers\/[^/]+$/.test(call.url) && call.method === "PATCH");
	const body = patches.at(-1).body;
	assert.ok(!("apiKey" in body), `留空不能把 Key 清掉：${JSON.stringify(body)}`);
	assert.equal(body.name, "本地测试供应商（改）");
	assert.ok(providerRowByName("本地测试供应商（改）"), "名称已更新");
});

await check("模型连通性检测成功：按钮旁显示「✓ 120ms」，按钮恢复可点", async () => {
	const row = modelRowByModelId("deepseek-chat");
	const button = row.querySelector(".model-ping");
	button.click();
	await flush(60);
	assert.equal(row.querySelector(".ping-result").textContent, "✓ 120ms");
	assert.equal(row.querySelector(".ping-result").classList.contains("ok"), true);
	assert.equal(button.textContent, "连通性检测", "检测完按钮文案要恢复");
	assert.equal(button.disabled, false);
	assert.ok(
		t.calls.some((call) => call.url === "/api/models/model-chat/ping" && call.method === "POST"),
		"探测走 POST /api/models/:id/ping",
	);
});

await check("模型连通性检测失败：显示「✗ 中文错误」，错误原样来自服务端", async () => {
	t.setModelPingResult("model-embed", {
		ok: false,
		latencyMs: 0,
		error: "连接模型端点失败：ECONNREFUSED",
	});
	const row = modelRowByModelId("nomic-embed-text");
	row.querySelector(".model-ping").click();
	await flush(60);
	const text = row.querySelector(".ping-result").textContent;
	assert.ok(text.startsWith("✗ "), `失败要标 ✗：${text}`);
	assert.ok(text.includes("连接模型端点失败：ECONNREFUSED"), `错误文案要原样显示：${text}`);
	assert.equal(row.querySelector(".ping-result").classList.contains("err"), true);
});

await check("设为当前：POST /api/models/current（modelId 用模型行 id），状态行跟着换", async () => {
	const before = t.calls.filter((call) => call.url === "/api/models/current" && call.method === "POST").length;
	modelRowByModelId("deepseek-chat").querySelector(".model-current").click();
	await flush(80);
	const posts = t.calls.filter((call) => call.url === "/api/models/current" && call.method === "POST");
	assert.equal(posts.length, before + 1);
	assert.deepEqual(posts.at(-1).body, { modelId: "model-chat" });
	assert.equal(t.state.modelAdmin.current, "deepseek-chat");
	assert.equal(els.modulePage.querySelector(".model-status__current").textContent, "DeepSeek Chat");
});

// 种子里的向量模型是停用的（既有的模型表断言依赖「停用」）：这两条用例自己打开它
await check("向量模型区块：没选时显示「未启用」+ 引导，按钮叫「新建向量模型」", () => {
	const section = els.modulePage.querySelector(".model-embedding");
	assert.ok(section, "模型页要有「向量模型」区块");
	assert.ok(section.textContent.includes("向量模型"), section.textContent);
	assert.equal(section.querySelector(".model-embedding__badge").textContent, "未启用");
	// 种子里唯一那条向量模型是停用的 → 一条可选都没有 → 按钮是"新建"而不是"选择"
	const pick = section.querySelector(".model-embedding__pick");
	assert.equal(pick.textContent, "新建向量模型");
	assert.ok(
		section.querySelector(".model-embedding__hint").textContent.includes("向量接口"),
		"没有可选模型时要写清下一步（建供应商 + 向量模型，DeepSeek/Anthropic 没有向量接口）",
	);
});

await check("向量模型和「当前模型」同一套操作：模型表里点行内「设为向量模型」→ POST /api/models/embedding", async () => {
	setModelRowEnabled("model-embed", true);
	await t.switchModule("chat");
	await t.switchModule("models");
	await flush(80);
	// 对话模型行不该有这个动作（只有「向量」类型才有）
	assert.equal(modelRowByModelId("deepseek-chat").querySelector(".model-embedding-pick"), null, "对话模型不能设为向量模型");
	const embedRow = modelRowByModelId("nomic-embed-text");
	const pick = embedRow.querySelector(".model-embedding-pick");
	assert.ok(pick, "向量模型行要有「设为向量模型」");
	assert.equal(pick.textContent, "设为向量模型");
	assert.equal(pick.disabled, false);
	const before = t.calls.filter((call) => call.url === "/api/models/embedding" && call.method === "POST").length;
	pick.click();
	await flush(80);
	const posts = t.calls.filter((call) => call.url === "/api/models/embedding" && call.method === "POST");
	assert.equal(posts.length, before + 1);
	assert.deepEqual(posts.at(-1).body, { modelId: "model-embed" });
	assert.equal(els.kbModal.hidden, true, "行内动作不该弹窗");
	// 选中后：名字旁有「向量模型」标签、动作置灰、上方区块变已启用
	assert.equal(modelRowByModelId("nomic-embed-text").querySelector(".model-current-tag").textContent, "向量模型");
	const currentPick = modelRowByModelId("nomic-embed-text").querySelector(".model-embedding-pick");
	assert.equal(currentPick.disabled, true, "已经是当前向量模型就置灰");
	assert.ok(currentPick.title.includes("已经是当前向量模型"), currentPick.title);
	const after = els.modulePage.querySelector(".model-embedding");
	assert.equal(after.querySelector(".model-embedding__badge").textContent, "已启用");
	assert.ok(after.querySelector(".model-embedding__name").textContent.includes("本地向量"), after.textContent);
	assert.equal(after.querySelector(".model-embedding__pick"), null, "有候选模型时区块不再放按钮，改为指向表格");
	assert.ok(after.querySelector(".model-embedding__hint").textContent.includes("设为向量模型"), after.textContent);
	assert.ok(lastNotice().includes("设为向量模型"), lastNotice());
});

await check("一条向量模型都没有：区块直接给「新建向量模型」入口，点了打开新建模型弹窗", async () => {
	// 场景：种子里的向量模型停用了 → 一条可选的都没有
	setModelRowEnabled("model-embed", false);
	await t.switchModule("chat");
	await t.switchModule("models");
	await flush(80);
	assert.equal(t.state.modelAdmin.embeddingOptions.length, 0, "停用的模型不能出现在可选项里");
	const section = els.modulePage.querySelector(".model-embedding");
	const pick = section.querySelector(".model-embedding__pick");
	assert.equal(pick.textContent, "新建向量模型", "没有可选模型时按钮要变成新建入口");
	assert.ok(
		section.querySelector(".model-embedding__hint").textContent.includes("没有向量接口"),
		"引导里要说清 DeepSeek/Anthropic 没有向量接口（不然用户会白建一条）",
	);
	pick.click();
	await flush(20);
	assert.equal(els.kbModal.hidden, false, "点了要直接打开新建模型弹窗");
	assert.equal(els.kbModalTitle.textContent, "新建模型");
	// 类型预选成「向量」，省得用户再挑一次
	assert.equal(els.kbModalBody.querySelector(".model-form-kind").value, "chat");
	t.closeKbDialog();
	// 只把向量模型恢复成种子的"停用"，别整个 reset——后面的用例还要用这一步之前建好的供应商
	setModelRowEnabled("model-embed", false);
	await t.switchModule("chat");
	await t.switchModule("models");
	await flush(80);
});

await check("「＋ 新建模型」：providerId 下拉来自供应商表；POST body 带正确的 providerId", async () => {
	const add = btnByText(els.modulePage.querySelector(".module-page__actions"), "button", "新建模型");
	add.click();
	assert.equal(els.kbModalTitle.textContent, "新建模型");
	const providerSelect = els.kbModalBody.querySelector(".model-form-provider");
	const providerIds = Array.from(providerSelect.querySelectorAll("option")).map((node) => node.value);
	assert.ok(providerIds.includes("prov-3"), `下拉要来自 GET /api/models 的 providers：${providerIds.join(",")}`);
	providerSelect.value = "prov-3";
	els.kbModalBody.querySelector(".model-form-name").value = "本地小模型";
	els.kbModalBody.querySelector(".model-form-modelid").value = "local-small";
	els.kbModalBody.querySelector(".model-form-kind").value = "chat";
	els.kbModalBody.querySelector(".model-form-context").value = "64000";
	await t.submitKbDialog();
	await flush(80);
	const posts = t.calls.filter((call) => call.url === "/api/models" && call.method === "POST");
	assert.deepEqual(posts.at(-1).body, {
		providerId: "prov-3",
		name: "本地小模型",
		modelId: "local-small",
		kind: "chat",
		enabled: true,
		contextWindow: 64000,
	});
	console.log("DEBUG ROWS", JSON.stringify(modelAdminRows().map((row) => [row.querySelector(".model-admin-modelid")?.textContent, row.querySelector(".model-admin-provider")?.textContent])));
	assert.equal(modelAdminRows().length, 3, "列表刷新出新模型");
	assert.equal(modelRowByModelId("local-small").querySelector(".model-admin-provider").textContent, "本地测试供应商（改）");
});

await check("把新模型设为当前：状态行显示新模型名（选项 label 优先）", async () => {
	modelRowByModelId("local-small").querySelector(".model-current").click();
	await flush(80);
	assert.equal(t.state.modelAdmin.current, "local-small");
	assert.equal(els.modulePage.querySelector(".model-status__current").textContent, "本地小模型");
	assert.equal(modelRowByModelId("local-small").querySelector(".model-current-tag")?.textContent, "当前");
});

await check("删除模型：先二次确认，再 DELETE /api/models/:id，列表少一行", async () => {
	const row = modelRowByModelId("local-small");
	row.querySelector(".model-delete").click();
	await flush(80);
	assert.ok(confirms.at(-1)?.includes("删除模型"), `删除前要确认：${confirms.at(-1)}`);
	assert.ok(confirms.at(-1)?.includes("本地小模型"));
	assert.ok(
		t.calls.some((call) => call.url === "/api/models/model-3" && call.method === "DELETE"),
		"要真的发 DELETE",
	);
	assert.equal(modelRowByModelId("local-small"), null);
	assert.equal(modelAdminRows().length, 2);
});

await check("删除供应商：确认文案写清连带删模型，DELETE 后供应商与它的模型一起消失", async () => {
	const row = providerRowByName("本地测试供应商（改）");
	row.querySelector(".provider-delete").click();
	await flush(80);
	assert.ok(confirms.at(-1)?.includes("供应商"), `删除前要确认：${confirms.at(-1)}`);
	assert.ok(confirms.at(-1)?.includes("模型"));
	assert.ok(
		t.calls.some((call) => call.url === "/api/models/providers/prov-3" && call.method === "DELETE"),
		"要真的发 DELETE",
	);
	assert.equal(providerRowByName("本地测试供应商（改）"), null);
	assert.equal(providerRows().length, 2);
});

await check("没有 workflow.write：模型页所有写按钮置灰并写明「当前角色不能修改模型配置」", () => {
	t.state.permissions = ["workflow.read"];
	t.renderModuleView();
	const buttons = [
		els.modulePage.querySelector(".model-switch"),
		...Array.from(els.modulePage.querySelectorAll(".provider-edit")),
		...Array.from(els.modulePage.querySelectorAll(".provider-delete")),
		...Array.from(els.modulePage.querySelectorAll(".provider-ping")),
		...Array.from(els.modulePage.querySelectorAll(".model-current")),
		...Array.from(els.modulePage.querySelectorAll(".model-edit")),
		...Array.from(els.modulePage.querySelectorAll(".model-delete")),
		...Array.from(els.modulePage.querySelectorAll(".model-ping")),
	];
	assert.ok(buttons.length >= 8, "写按钮都要在");
	for (const button of buttons) {
		assert.equal(button.disabled, true, `没权限要置灰：${button.className}`);
		assert.equal(button.title, "当前角色不能修改模型配置", `置灰要说明原因：${button.className}`);
	}
	const headButtons = Array.from(els.modulePage.querySelectorAll(".module-page__actions button"));
	assert.equal(headButtons.length, 2);
	for (const button of headButtons) assert.equal(button.disabled, true);
	t.openProviderDialog(null);
	assert.equal(els.kbModal.hidden, true, "没权限时弹窗都打不开");
	t.state.permissions = ["workflow.write"];
	t.renderModuleView();
});

await check("模型接口 403：整页「当前角色不能查看模型配置」，不冒充「未接入」", async () => {
	t.setModelsStatus(403);
	await t.refreshModelAdmin();
	t.renderModuleView();
	assert.equal(t.state.modelAdmin.status, "forbidden");
	assert.equal(els.modulePage.querySelector(".module-denied__text")?.textContent, "当前角色不能查看模型配置");
	assert.equal(els.modulePage.querySelector(".module-badge"), null, "403 不是「未接入」");
	assert.equal(providerRows().length, 0);
	t.setModelsStatus(200);
});

await check("老后端（没有 providers/models 字段）：回落旧版只读页 + 「未接入」接口清单", async () => {
	t.setModelsAvailable(false);
	await t.refreshModelAdmin();
	t.renderModuleView();
	assert.equal(t.state.modelAdmin.status, "unavailable");
	assert.equal(els.modulePage.querySelector(".module-badge")?.textContent, "未接入");
	assert.ok(els.modulePage.textContent.includes("连通性"), "旧版页仍说明连通性检测这条待接接口");
	assert.equal(providerRows().length, 0, "没有真数据就不画供应商表");
	assert.equal(Array.from(els.threadInner.querySelectorAll(".notice.err")).length, 0, "降级不该弹错");
	t.resetModelFixtures();
});

await check("设置页 API Key 列表：名称 / 前缀 / 中文角色 / 限流 / 最近使用 / 状态", async () => {
	t.state.permissions = ["workflow.write"];
	t.resetApiKeyStore();
	await t.switchModule("chat");
	await t.switchModule("settings");
	await flush(80);
	assert.equal(pageTitle(), "设置");
	assert.equal(apiKeyRows().length, 2, "夹具给了 2 把 Key");
	const first = apiKeyRows()[0];
	assert.equal(first.querySelector(".apikey-name").textContent, "报表机器人");
	assert.equal(first.querySelector(".apikey-prefix").textContent, "bk_ab12…");
	assert.equal(first.querySelector(".apikey-role").textContent, "运营", "角色显示中文");
	assert.equal(first.querySelector(".apikey-rate").textContent, "60 次/分");
	assert.equal(first.querySelector(".apikey-used").textContent, "5 分钟前");
	assert.equal(first.querySelector(".apikey-state-badge").textContent, "启用");
	const second = apiKeyRows()[1];
	assert.equal(second.querySelector(".apikey-role").textContent, "开发者");
	assert.equal(second.querySelector(".apikey-rate").textContent, "600 次/分");
	assert.equal(second.querySelector(".apikey-used").textContent, "从未使用");
	assert.equal(second.querySelector(".apikey-state-badge").textContent, "已停用");
});

await check("「＋ 新建 API Key」：弹窗有 name / 角色下拉 / 限流数字，默认运营 + 60", () => {
	els.modulePage.querySelector(".apikey-add").click();
	assert.equal(els.kbModal.hidden, false);
	assert.equal(els.kbModalTitle.textContent, "新建 API Key");
	assert.ok(els.kbModalBody.querySelector(".apikey-form-name"));
	assert.equal(els.kbModalBody.querySelector(".apikey-form-role").value, "operator");
	assert.equal(els.kbModalBody.querySelector(".apikey-form-rate").value, "60");
	assert.deepEqual(
		Array.from(els.kbModalBody.querySelectorAll(".apikey-form-role option")).map((node) => node.textContent),
		["所有者", "开发者", "运营", "审计员"],
	);
});

await check("新建 API Key：POST body 正确，成功后弹出只显示一次的明文卡片", async () => {
	els.kbModalBody.querySelector(".apikey-form-name").value = "测试 Key";
	els.kbModalBody.querySelector(".apikey-form-role").value = "auditor";
	els.kbModalBody.querySelector(".apikey-form-rate").value = "30";
	await t.submitKbDialog();
	await flush(80);
	const posts = keyOne().filter((call) => call.url === "/api/api-keys" && call.method === "POST");
	assert.deepEqual(posts.at(-1).body, { name: "测试 Key", role: "auditor", rateLimitPerMin: 30 });
	assert.equal(els.kbModal.hidden, false, "创建后不能直接关掉：要先给用户看明文");
	assert.equal(els.kbModalTitle.textContent, "API Key 已创建");
	assert.equal(els.kbModalBody.querySelector(".apikey-reveal-input").value, "bk_plaintext_once_9f3a2b");
	assert.ok(els.kbModalBody.textContent.includes("只显示这一次，请现在保存"), "必须写清只显示一次");
	assert.ok(!els.modulePage.textContent.includes("bk_plaintext_once_9f3a2b"), "列表里不能回显明文");
	assert.equal(apiKeyRows().length, 3, "列表刷新出第 3 把 Key");
	assert.equal(apiKeyRows()[2].querySelector(".apikey-prefix").textContent, "bk_new123…");
});

await check("关掉明文卡片后 DOM 里不再有明文（只留前缀）", () => {
	t.closeKbDialog();
	assert.equal(els.kbModal.hidden, true);
	assert.equal(els.kbModalBody.textContent, "", "关弹窗要清空内容");
	assert.ok(!els.modulePage.textContent.includes("bk_plaintext_once_9f3a2b"));
	assert.ok(!JSON.stringify(t.state.apiKeys.items).includes("bk_plaintext_once_9f3a2b"), "状态里也不留明文");
});

await check("停用 API Key：PATCH body 是 { disabled: true }，状态变「已停用」", async () => {
	const row = apiKeyRows().find((item) => item.querySelector(".apikey-name").textContent === "测试 Key");
	row.querySelector(".apikey-toggle").click();
	await flush(80);
	const patches = keyOne().filter((call) => call.method === "PATCH");
	assert.deepEqual(patches.at(-1).body, { disabled: true });
	const updated = apiKeyRows().find((item) => item.querySelector(".apikey-name").textContent === "测试 Key");
	assert.equal(updated.querySelector(".apikey-state-badge").textContent, "已停用");
});

await check("吊销 API Key：确认文案写清「调用会立刻 401」，DELETE 后状态变「已吊销」", async () => {
	const row = apiKeyRows().find((item) => item.querySelector(".apikey-name").textContent === "报表机器人");
	row.querySelector(".apikey-revoke").click();
	await flush(80);
	assert.ok(confirms.at(-1)?.includes("401"), `吊销必须讲清后果：${confirms.at(-1)}`);
	assert.ok(confirms.at(-1)?.includes("吊销后使用该 Key 的调用会立刻 401"));
	assert.ok(
		keyOne().some((call) => call.url === "/api/api-keys/key-1" && call.method === "DELETE"),
		"吊销走 DELETE（软删除）",
	);
	const updated = apiKeyRows().find((item) => item.querySelector(".apikey-name").textContent === "报表机器人");
	assert.equal(updated.querySelector(".apikey-state-badge").textContent, "已吊销");
});

await check("没有 workflow.write：API Key 的新建 / 停用 / 吊销全部置灰", () => {
	t.state.permissions = ["workflow.read"];
	t.renderModuleView();
	const add = els.modulePage.querySelector(".apikey-add");
	assert.equal(add.disabled, true);
	assert.equal(add.title, "当前角色不能管理 API Key");
	const actions = [
		...Array.from(els.modulePage.querySelectorAll(".apikey-toggle")),
		...Array.from(els.modulePage.querySelectorAll(".apikey-revoke")),
	];
	assert.ok(actions.length >= 4);
	for (const button of actions) {
		assert.equal(button.disabled, true, `没权限要置灰：${button.className}`);
	}
	t.openNewApiKeyDialog();
	assert.equal(els.kbModal.hidden, true, "没权限时弹窗都打不开");
	t.state.permissions = ["workflow.write"];
	t.renderModuleView();
});

await check("API Key 接口 403：只在这一块显示权限文案，不冒充「未接入」", async () => {
	t.setApiKeysStatus(403);
	await t.refreshApiKeys();
	t.renderModuleView();
	assert.equal(t.state.apiKeys.status, "forbidden");
	assert.equal(els.modulePage.querySelector(".apikey-section .module-denied__text")?.textContent, "当前角色不能管理 API Key");
	assert.equal(apiKeyRows().length, 0);
	assert.ok(!els.modulePage.textContent.includes("API Key 接口未接入"));
	t.setApiKeysStatus(200);
});

await check("API Key 接口 404：这一块回落「接口未接入」，不编假表格也不弹错", async () => {
	t.setApiKeysAvailable(false);
	await t.refreshApiKeys();
	t.renderModuleView();
	assert.equal(t.state.apiKeys.status, "unavailable");
	assert.ok(els.modulePage.querySelector(".apikey-empty")?.textContent.includes("未接入"));
	assert.equal(apiKeyRows().length, 0);
	assert.equal(Array.from(els.threadInner.querySelectorAll(".notice.err")).length, 0);
	t.setApiKeysAvailable(true);
});

await check("模型页与设置页的文案里都没有「流程」二字", async () => {
	t.state.permissions = ["workflow.write"];
	t.resetModelFixtures();
	t.setApiKeysStatus(200);
	await t.switchModule("chat");
	await t.switchModule("models");
	await flush(60);
	assert.ok(!els.modulePage.textContent.includes("流程"), `模型页出现「流程」：${els.modulePage.textContent.slice(0, 80)}`);
	await t.switchModule("chat");
	await t.switchModule("settings");
	await flush(60);
	assert.ok(!els.modulePage.textContent.includes("流程"), `设置页出现「流程」：${els.modulePage.textContent.slice(0, 80)}`);
	await t.switchModule("chat");
});

/* ================= 20. MCP（P7） ================= */

section("MCP（P7）：服务列表 / 注册 / 工具开关 / 调试调用 / 权限");

const mcpCards = () => Array.from(els.modulePage.querySelectorAll(".mcp-server-card"));
const mcpCard = (name) => mcpCards().find((card) => card.querySelector(".mcp-server-name")?.textContent === name) ?? null;
const mcpPosts = () => t.calls.filter((call) => call.url === "/api/mcp/servers" && call.method === "POST");
const mcpCallRecords = () => t.calls.filter((call) => /^\/api\/mcp\/servers\/[^/]+\/call$/.test(call.url) && call.method === "POST");

await check("MCP 页：ready 时画服务卡（名称 / 传输 / 状态 / 工具数 / 启用徽标）", async () => {
	t.state.permissions = ["workflow.write", "workflow.read"];
	t.resetMcpFixtures();
	await t.switchModule("chat");
	await t.switchModule("mcp");
	await flush(80);
	assert.equal(pageTitle(), "MCP");
	assert.equal(t.state.mcp.status, "ready");
	assert.equal(mcpCards().length, 3, "夹具给了 3 个服务");
	const fileServer = mcpCard("文件助手");
	assert.equal(fileServer.querySelector(".mcp-transport-badge").textContent, "stdio");
	assert.equal(fileServer.querySelector(".mcp-status-badge").textContent, "正常");
	assert.equal(fileServer.querySelector(".mcp-status-badge").classList.contains("on"), true);
	assert.equal(fileServer.querySelector(".mcp-tool-count").textContent, "3 个工具");
	assert.equal(fileServer.querySelector(".mcp-enabled-badge").textContent, "启用");
	const remote = mcpCard("远程检索");
	assert.equal(remote.querySelector(".mcp-transport-badge").textContent, "HTTP");
	assert.equal(remote.querySelector(".mcp-status-badge").textContent, "异常");
	assert.equal(remote.querySelector(".mcp-status-badge").classList.contains("error"), true);
	assert.equal(remote.querySelector(".mcp-tool-count").textContent, "0 个工具");
	const sse = mcpCard("旧版事件流");
	assert.equal(sse.querySelector(".mcp-transport-badge").textContent, "SSE");
	assert.equal(sse.querySelector(".mcp-status-badge").textContent, "未知");
	assert.equal(sse.querySelector(".mcp-status-badge").classList.contains("unknown"), true);
	assert.equal(sse.querySelector(".mcp-enabled-badge").textContent, "停用");
});

await check("连接失败的 lastError 原样展示；正常服务不显示错误行", () => {
	const remote = mcpCard("远程检索");
	assert.equal(
		remote.querySelector(".mcp-server-error")?.textContent,
		"连接 MCP 服务「远程检索」失败：connect ECONNREFUSED 127.0.0.1:9",
	);
	assert.equal(mcpCard("文件助手").querySelector(".mcp-server-error"), null);
});

await check("页头有「＋ 注册 MCP 服务」，说明讲清 stdio / HTTP / SSE 三种传输", () => {
	const add = els.modulePage.querySelector(".mcp-add");
	assert.ok(add, "页头要能注册服务");
	assert.equal(add.textContent, "＋ 注册 MCP 服务");
	assert.equal(add.getAttribute("type"), "button");
	const lead = els.modulePage.querySelector(".module-page__lead")?.textContent ?? "";
	for (const word of ["stdio", "HTTP", "SSE"]) assert.ok(lead.includes(word), `说明要讲清 ${word}：${lead}`);
});

await check("注册 stdio：POST body 带 command 与 args 数组（逗号 / 换行都拆）", async () => {
	els.modulePage.querySelector(".mcp-add").click();
	assert.equal(els.kbModal.hidden, false);
	assert.equal(els.kbModalTitle.textContent, "注册 MCP 服务");
	assert.equal(els.kbModalBody.querySelector(".mcp-form-transport").value, "stdio");
	assert.equal(els.kbModalBody.querySelector(".mcp-form-stdio").hidden, false, "stdio 字段要显示");
	assert.equal(els.kbModalBody.querySelector(".mcp-form-http").hidden, true, "http 字段先收起");
	els.kbModalBody.querySelector(".mcp-form-name").value = "本地计算器";
	els.kbModalBody.querySelector(".mcp-form-command").value = "D:\\nodejs\\node.exe";
	els.kbModalBody.querySelector(".mcp-form-args").value = "D:\\repo\\calc.mjs, --verbose\n--port 0";
	const before = mcpPosts().length;
	await t.submitKbDialog();
	await flush(80);
	const posts = mcpPosts();
	assert.equal(posts.length, before + 1);
	assert.deepEqual(posts.at(-1).body, {
		name: "本地计算器",
		transport: "stdio",
		enabled: true,
		command: "D:\\nodejs\\node.exe",
		args: ["D:\\repo\\calc.mjs", "--verbose", "--port 0"],
	});
	assert.equal(els.kbModal.hidden, true, "保存成功要关弹窗");
	assert.ok(mcpCard("本地计算器"), "列表要刷新出新服务");
	assert.equal(mcpCards().length, 4);
});

await check("注册 http：切换传输只显示 URL / 请求头，POST body 用 headers 对象", async () => {
	els.modulePage.querySelector(".mcp-add").click();
	els.kbModalBody.querySelector(".mcp-form-name").value = "远程知识源";
	const transport = els.kbModalBody.querySelector(".mcp-form-transport");
	transport.value = "http";
	transport.dispatch("change");
	assert.equal(els.kbModalBody.querySelector(".mcp-form-stdio").hidden, true, "切到 http 后命令 / 参数收起");
	assert.equal(els.kbModalBody.querySelector(".mcp-form-http").hidden, false);
	els.kbModalBody.querySelector(".mcp-form-url").value = "https://mcp.example.test/mcp";
	els.kbModalBody.querySelector(".mcp-form-headers").value = "Authorization: Bearer demo\nX-Trace: 1";
	const before = mcpPosts().length;
	await t.submitKbDialog();
	await flush(80);
	const posts = mcpPosts();
	assert.equal(posts.length, before + 1);
	assert.deepEqual(posts.at(-1).body, {
		name: "远程知识源",
		transport: "http",
		enabled: true,
		url: "https://mcp.example.test/mcp",
		headers: { Authorization: "Bearer demo", "X-Trace": "1" },
	});
	assert.ok(mcpCard("远程知识源"), "http 服务也要出现在列表里");
});

await check("请求头格式不对：弹窗给中文提示，不发注册请求", async () => {
	els.modulePage.querySelector(".mcp-add").click();
	els.kbModalBody.querySelector(".mcp-form-name").value = "写错头的服务";
	const transport = els.kbModalBody.querySelector(".mcp-form-transport");
	transport.value = "sse";
	transport.dispatch("change");
	els.kbModalBody.querySelector(".mcp-form-url").value = "https://mcp.example.test/sse";
	els.kbModalBody.querySelector(".mcp-form-headers").value = "这不是一行请求头";
	const before = mcpPosts().length;
	await t.submitKbDialog();
	await flush(40);
	assert.equal(mcpPosts().length, before, "格式不对不该发请求");
	assert.ok(els.kbError.textContent.includes("Key: Value"), `要提示正确格式：${els.kbError.textContent}`);
	assert.equal(els.kbModal.hidden, false, "出错时弹窗要留着");
	t.closeKbDialog();
});

await check("刷新服务：POST /api/mcp/servers/:id/refresh，卡片与工具都还在", async () => {
	mcpCard("文件助手").querySelector(".mcp-refresh").click();
	await flush(80);
	assert.ok(
		t.calls.some((call) => call.url === "/api/mcp/servers/mcp-fs/refresh" && call.method === "POST"),
		"刷新走 POST refresh",
	);
	assert.ok(mcpCard("文件助手"), "刷新后卡片还在");
	assert.equal(mcpCard("文件助手").querySelector(".mcp-status-badge").textContent, "正常");
});

await check("展开服务：工具表显示工具名 / 描述截断 / 启用开关（已禁用的不勾选）", () => {
	const card = mcpCard("文件助手");
	assert.equal(card.querySelector(".mcp-expand").getAttribute("aria-expanded"), "false");
	card.querySelector(".mcp-expand").click();
	const opened = mcpCard("文件助手");
	assert.equal(opened.querySelector(".mcp-expand").getAttribute("aria-expanded"), "true");
	assert.equal(opened.querySelector(".mcp-expand").textContent, "收起工具");
	const rows = Array.from(opened.querySelectorAll(".mcp-tool-row"));
	assert.equal(rows.length, 3);
	assert.deepEqual(rows.map((row) => row.querySelector(".mcp-tool-name").textContent), ["add", "describe", "boom"]);
	const desc = rows[1].querySelector(".mcp-tool-desc");
	assert.ok(desc.textContent.endsWith("…"), `长描述要截断：${desc.textContent}`);
	assert.ok(desc.textContent.length <= 61, "截断到 60 字 + 省略号");
	assert.ok(desc.title.length > desc.textContent.length, "完整描述放 title");
	const toggles = rows.map((row) => row.querySelector(".mcp-tool-toggle"));
	assert.equal(toggles.every((box) => box.checked), true, "默认都是勾选");
	// 停用服务的工具开关初始不勾选
	mcpCard("旧版事件流").querySelector(".mcp-expand").click();
	assert.equal(mcpCard("旧版事件流").querySelector(".mcp-tool-toggle").checked, false);
});

await check("工具开关：PATCH /api/mcp/tools/:id body { enabled: false }，行不消失", async () => {
	const row = mcpCard("文件助手").querySelectorAll(".mcp-tool-row").item(0);
	const checkbox = row.querySelector(".mcp-tool-toggle");
	checkbox.checked = false;
	checkbox.dispatch("change");
	await flush(60);
	const patches = t.calls.filter((call) => call.url === "/api/mcp/tools/mtool-add" && call.method === "PATCH");
	assert.equal(patches.length, 1);
	assert.deepEqual(patches.at(-1).body, { enabled: false });
	assert.ok(mcpCard("文件助手").querySelectorAll(".mcp-tool-row").item(0), "只改一行，不整表重画");
	assert.equal(t.state.mcp.servers.find((server) => server.id === "mcp-fs").tools[0].enabled, false);
	// 再打开，给后面的调试调用用
	checkbox.checked = true;
	checkbox.dispatch("change");
	await flush(40);
	const reopened = t.calls.filter((call) => call.url === "/api/mcp/tools/mtool-add" && call.method === "PATCH");
	assert.deepEqual(reopened.at(-1).body, { enabled: true });
});

await check("停用 / 启用服务：PATCH body 只有 { enabled }，徽标与按钮文案跟着变", async () => {
	let card = mcpCard("文件助手");
	card.querySelector(".mcp-toggle").click();
	await flush(80);
	let patches = t.calls.filter((call) => call.url === "/api/mcp/servers/mcp-fs" && call.method === "PATCH");
	assert.deepEqual(patches.at(-1).body, { enabled: false });
	card = mcpCard("文件助手");
	assert.equal(card.querySelector(".mcp-enabled-badge").textContent, "停用");
	assert.equal(card.querySelector(".mcp-toggle").textContent, "启用");
	card.querySelector(".mcp-toggle").click();
	await flush(80);
	patches = t.calls.filter((call) => call.url === "/api/mcp/servers/mcp-fs" && call.method === "PATCH");
	assert.deepEqual(patches.at(-1).body, { enabled: true });
	assert.equal(mcpCard("文件助手").querySelector(".mcp-enabled-badge").textContent, "启用");
});

await check("调试调用：POST body 用 tool + 解析后的 arguments，结果显示在弹窗里", async () => {
	mcpCard("文件助手").querySelector(".mcp-debug").click();
	assert.equal(els.kbModalTitle.textContent, "调试调用 MCP 工具");
	assert.deepEqual(
		Array.from(els.kbModalBody.querySelectorAll(".mcp-call-tool option")).map((node) => node.textContent),
		["add", "describe", "boom"],
	);
	const args = els.kbModalBody.querySelector(".mcp-call-args");
	assert.equal(args.value, "{}");
	args.value = '{"a": 2, "b": 3}';
	await t.submitKbDialog();
	await flush(60);
	assert.deepEqual(mcpCallRecords().at(-1).body, { tool: "add", arguments: { a: 2, b: 3 } });
	assert.equal(els.kbModal.hidden, false, "调用完要留着结果给用户看");
	assert.equal(els.kbModalBody.querySelector(".mcp-call-text").textContent, "5");
	assert.equal(els.kbModalBody.querySelector(".mcp-call-text").classList.contains("err"), false);
});

await check("调试调用 isError：text 用红字显示", async () => {
	// 复用上一条还开着的弹窗：换工具再调一次
	els.kbModalBody.querySelector(".mcp-call-tool").value = "boom";
	els.kbModalBody.querySelector(".mcp-call-args").value = "{}";
	await t.submitKbDialog();
	await flush(60);
	assert.deepEqual(mcpCallRecords().at(-1).body, { tool: "boom", arguments: {} });
	const text = els.kbModalBody.querySelector(".mcp-call-text");
	assert.ok(text.textContent.includes("故意失败"), `要显示后端 text：${text.textContent}`);
	assert.equal(text.classList.contains("err"), true);
	assert.ok(els.kbModalBody.querySelector(".mcp-call-meta").textContent.includes("调用返回错误"));
	t.closeKbDialog();
});

await check("非法 JSON 参数：中文提示，不发 call 请求", async () => {
	mcpCard("文件助手").querySelector(".mcp-debug").click();
	els.kbModalBody.querySelector(".mcp-call-args").value = "{bad";
	const before = mcpCallRecords().length;
	await t.submitKbDialog();
	await flush(40);
	assert.equal(mcpCallRecords().length, before, "解析失败不该发请求");
	assert.ok(els.kbError.textContent.includes("JSON"), `要提示 JSON 错误：${els.kbError.textContent}`);
	assert.equal(els.kbModal.hidden, false, "出错时弹窗要留着改参数");
	t.closeKbDialog();
});

await check("删除：确认文案写清连带删工具 / 会话调用失败，DELETE 后卡片消失", async () => {
	mcpCard("远程知识源").querySelector(".mcp-delete").click();
	await flush(80);
	const message = confirms.at(-1) ?? "";
	assert.ok(message.includes("连带"), `要提示连带删工具：${message}`);
	assert.ok(message.includes("工具"));
	assert.ok(message.includes("会话"));
	assert.ok(message.includes("失败"));
	assert.ok(
		t.calls.some((call) => /^\/api\/mcp\/servers\/[^/]+$/.test(call.url) && call.method === "DELETE"),
		"要真的发 DELETE",
	);
	assert.equal(mcpCard("远程知识源"), null);
	assert.equal(mcpCards().length, 4, "3 个夹具服务 + 本地计算器，删掉远程知识源后剩 4 个");
});

await check("MCP 接口 403：整页「当前角色不能查看 MCP 配置」，不冒充「未接入」", async () => {
	t.setMcpStatus(403);
	await t.refreshMcp();
	t.renderModuleView();
	assert.equal(t.state.mcp.status, "forbidden");
	assert.equal(els.modulePage.querySelector(".module-denied__text")?.textContent, "当前角色不能查看 MCP 配置");
	assert.equal(els.modulePage.querySelector(".module-badge"), null, "403 不是「未接入」");
	assert.equal(mcpCards().length, 0);
	assert.equal(els.modulePage.querySelector(".mcp-add"), null, "没权限也不摆注册按钮");
	t.setMcpStatus(200);
});

await check("MCP 接口 404：回落「未接入」空态 + 接口清单，不弹错", async () => {
	t.setMcpAvailable(false);
	await t.refreshMcp();
	t.renderModuleView();
	assert.equal(t.state.mcp.status, "unavailable");
	assert.equal(els.modulePage.querySelector(".module-badge")?.textContent, "未接入");
	const codes = Array.from(els.modulePage.querySelectorAll(".module-api__code")).map((node) => node.textContent);
	assert.ok(codes.includes("GET /api/mcp/servers"), `接口清单要有 GET /api/mcp/servers：${codes.join("|")}`);
	assert.equal(mcpCards().length, 0);
	assert.equal(Array.from(els.threadInner.querySelectorAll(".notice.err")).length, 0, "降级不该弹错");
	t.setMcpAvailable(true);
	await t.refreshMcp();
	t.renderModuleView();
});

await check("没有 workflow.write：注册 / 刷新 / 编辑 / 启停 / 删除 / 调试 / 工具开关全部置灰", () => {
	t.state.permissions = ["workflow.read"];
	t.renderModuleView();
	const add = els.modulePage.querySelector(".mcp-add");
	assert.equal(add.disabled, true);
	assert.equal(add.title, "当前角色不能修改 MCP 配置");
	const buttons = [
		...Array.from(els.modulePage.querySelectorAll(".mcp-refresh")),
		...Array.from(els.modulePage.querySelectorAll(".mcp-edit")),
		...Array.from(els.modulePage.querySelectorAll(".mcp-toggle")),
		...Array.from(els.modulePage.querySelectorAll(".mcp-delete")),
		...Array.from(els.modulePage.querySelectorAll(".mcp-debug")),
	];
	assert.ok(buttons.length >= 12, `写操作按钮都要在：${buttons.length}`);
	for (const button of buttons) {
		assert.equal(button.disabled, true, `没权限要置灰：${button.className}`);
		assert.equal(button.title, "当前角色不能修改 MCP 配置", `置灰要说明原因：${button.className}`);
	}
	const toggles = Array.from(els.modulePage.querySelectorAll(".mcp-tool-toggle"));
	assert.ok(toggles.length > 0, "展开的工具表还在");
	for (const toggle of toggles) {
		assert.equal(toggle.disabled, true);
		assert.equal(toggle.title, "当前角色不能修改 MCP 配置");
	}
	t.openMcpServerDialog(null);
	assert.equal(els.kbModal.hidden, true, "没权限时注册弹窗打不开");
	t.openMcpDebugDialog(t.state.mcp.servers[0]);
	assert.equal(els.kbModal.hidden, true, "没权限时调试弹窗也打不开");
	t.state.permissions = ["workflow.write", "workflow.read"];
	t.renderModuleView();
});

await check("MCP 页的文案里没有「流程」二字", () => {
	const text = els.modulePage.textContent;
	assert.ok(!text.includes("流程"), `MCP 页出现「流程」：${text.slice(0, 120)}`);
});

await check("参数解析：逗号 / 换行拆数组，请求头按第一个冒号切分", () => {
	assert.equal(JSON.stringify(t.parseMcpArgs("a, b\nc,, d ")), JSON.stringify(["a", "b", "c", "d"]));
	assert.equal(JSON.stringify(t.parseMcpHeaders("A: 1\nB: x:y")), JSON.stringify({ A: "1", B: "x:y" }));
	assert.equal(t.parseMcpHeaders("oops"), null, "没有冒号要返回 null 交给中文提示");
});

/* ================= IM 机器人（P8） ================= */

section("IM 机器人（P8）：机器人卡片 / 弹窗 / 启停 / ping / 删除 / outbox / 权限");

const imCards = () => Array.from(els.modulePage.querySelectorAll(".im-bot-card"));
const imCard = (name) => imCards().find((card) => card.querySelector(".im-bot-name")?.textContent === name) ?? null;
const imPosts = () => t.calls.filter((call) => call.url === "/api/im/bots" && call.method === "POST");
const imPatches = (botId) => t.calls.filter((call) => call.url === `/api/im/bots/${botId}` && call.method === "PATCH");
const imPings = () => t.calls.filter((call) => /^\/api\/im\/bots\/[^/]+\/ping$/.test(call.url) && call.method === "POST");

await check("IM 页：ready 时画机器人卡片（名称 / 状态 / 掩码 / AES / 最近回调 / 会话数）", async () => {
	t.state.permissions = ["workflow.write", "workflow.read"];
	t.resetImFixtures();
	await t.switchModule("chat");
	await t.switchModule("im");
	await flush(80);
	assert.equal(pageTitle(), "IM 机器人");
	assert.equal(t.state.im.status, "ready");
	assert.equal(imCards().length, 2, "夹具给了 2 个机器人");
	const first = imCard("客服机器人");
	assert.equal(first.querySelector(".im-bot-appkey").textContent, "ding-app-key-1");
	assert.equal(first.querySelector(".im-bot-robotcode").textContent, "ding_robot_1");
	assert.equal(first.querySelector(".im-bot-secret").textContent, "se******12", "只显示后端给的掩码");
	assert.equal(first.querySelector(".im-state-badge").textContent, "启用");
	assert.equal(first.querySelector(".im-state-badge").classList.contains("on"), true);
	assert.equal(first.querySelector(".im-aes-badge").textContent, "AES 已配置");
	assert.equal(first.querySelector(".im-aes-badge").classList.contains("on"), true);
	assert.equal(first.querySelector(".im-bot-callback").textContent, "最近回调：5 分钟前");
	assert.equal(first.querySelector(".im-bot-sessions").textContent, "会话 3 个");
	const second = imCard("告警机器人");
	assert.equal(second.querySelector(".im-state-badge").textContent, "停用");
	assert.equal(second.querySelector(".im-state-badge").classList.contains("off"), true);
	assert.equal(second.querySelector(".im-aes-badge").textContent, "未配置 AES");
	assert.equal(second.querySelector(".im-aes-badge").classList.contains("on"), false);
	assert.equal(second.querySelector(".im-bot-callback").textContent, "最近回调：从未回调");
	assert.equal(second.querySelector(".im-bot-sessions").textContent, "会话 0 个");
});

await check("页头：添加与刷新在同一组里，主说明不出现实现细节", () => {
	const actions = els.modulePage.querySelector(".module-page__actions");
	assert.ok(actions, "两个按钮要成组，别被 space-between 摊到页头两端");
	const add = actions.querySelector(".im-add");
	assert.equal(add.textContent, "＋ 添加机器人");
	assert.equal(add.getAttribute("type"), "button");
	assert.equal(actions.querySelector(".im-refresh").textContent, "刷新");
	const lead = els.modulePage.querySelector(".module-page__lead")?.textContent ?? "";
	assert.ok(lead.includes("专属回调地址"), `说明要提示专属回调地址：${lead}`);
	assert.ok(!lead.includes("outbox") && !lead.includes("fake"), `主说明用用户能懂的话，别出现 outbox / fake：${lead}`);
});

await check("配置说明默认收起，点一下展开、再点收起", () => {
	const toggle = els.modulePage.querySelector(".im-guide__toggle");
	const panel = els.modulePage.querySelector(".im-guide__panel");
	assert.equal(toggle.getAttribute("aria-expanded"), "false");
	assert.equal(panel.hidden, true, "默认收起：主页面留给机器人列表");
	toggle.click();
	assert.equal(panel.hidden, false);
	assert.equal(toggle.getAttribute("aria-expanded"), "true");
	assert.ok(panel.textContent.includes("EncodingAESKey"), "展开后能看到两个平台的配置说明");
	toggle.click();
	assert.equal(panel.hidden, true);
	assert.equal(toggle.getAttribute("aria-expanded"), "false");
});

await check("一个机器人都没有时给空态引导，并可就地打开添加弹窗", async () => {
	t.state.im.bots = [];
	t.state.im.outbox = null;
	t.renderModuleView();
	const empty = els.modulePage.querySelector(".im-empty");
	assert.ok(empty, "没有机器人时要给空态，别只剩一句「点右上角」");
	assert.ok(empty.textContent.includes("钉钉") && empty.textContent.includes("企业微信"), "空态要说清支持哪两个平台");
	empty.querySelector(".im-empty__add").click();
	assert.equal(els.kbModal.hidden, false, "空态里的按钮直接打开添加弹窗");
	els.kbModalClose.click();
	// 恢复夹具：后面的用例继续按「两个机器人」跑
	t.resetImFixtures();
	await t.switchModule("chat");
	await t.switchModule("im");
	await flush(80);
	assert.equal(imCards().length, 2);
});

await check("回调说明卡：回调地址 / timestamp + sign / 1 小时 / 5 分钟 / 消息转会话", () => {
	const text = els.modulePage.querySelector(".im-callback")?.textContent ?? "";
	for (const word of ["/api/im/dingtalk/callback", "timestamp", "sign", "1 小时", "5 分钟", "conversationId", "AES"]) {
		assert.ok(text.includes(word), `回调说明要讲清 ${word}：${text.slice(0, 160)}`);
	}
	assert.ok(text.includes("被 @"), "要说明群里被 @ 才转内部会话");
});

await check("添加弹窗：字段齐全、appSecret 是 password，POST body 含 aesKey", async () => {
	els.modulePage.querySelector(".im-add").click();
	assert.equal(els.kbModal.hidden, false);
	assert.equal(els.kbModalTitle.textContent, "添加机器人");
	assert.equal(els.kbModalBody.querySelector(".im-form-secret").type, "password", "appSecret 不能明文展示");
	assert.equal(els.kbModalBody.querySelector(".im-form-token").type, "password");
	assert.equal(els.kbModalBody.querySelector(".im-form-aeskey")?.type, "password");
	assert.equal(els.kbModalBody.querySelector(".im-form-enabled").checked, true);
	els.kbModalBody.querySelector(".im-form-name").value = "值班机器人";
	els.kbModalBody.querySelector(".im-form-appkey").value = "ding-key-3";
	els.kbModalBody.querySelector(".im-form-secret").value = "secret-3";
	els.kbModalBody.querySelector(".im-form-robotcode").value = "robot-3";
	els.kbModalBody.querySelector(".im-form-token").value = "token-3";
	els.kbModalBody.querySelector(".im-form-aeskey").value = "AesKeyForUnitTest_1234567890";
	const before = imPosts().length;
	await t.submitKbDialog();
	await flush(80);
	const posts = imPosts();
	assert.equal(posts.length, before + 1);
	assert.deepEqual(posts.at(-1).body, {
		platform: "dingtalk",
		name: "值班机器人",
		appKey: "ding-key-3",
		robotCode: "robot-3",
		enabled: true,
		appSecret: "secret-3",
		callbackToken: "token-3",
		aesKey: "AesKeyForUnitTest_1234567890",
	});
	assert.equal(els.kbModal.hidden, true, "保存成功要关弹窗");
	assert.ok(imCard("值班机器人"), "列表要刷新出新机器人");
	assert.equal(imCards().length, 3);
});

await check("企业微信平台表单使用 CorpID 与 AgentId，并支持专属回调地址", () => {
	els.modulePage.querySelector(".im-add").click();
	const platform = els.kbModalBody.querySelector(".im-form-platform");
	platform.value = "wecom";
	platform.dispatch("change");
	assert.ok(els.kbModalBody.textContent.includes("CorpID"));
	assert.ok(els.kbModalBody.textContent.includes("AgentId"));
	assert.ok(els.kbModalBody.textContent.includes("EncodingAESKey（必填）"));
	els.kbModalClose.click();
	assert.ok(els.modulePage.querySelector(".im-wecom-guide").textContent.includes("可信 IP"));
	assert.ok(els.modulePage.querySelector(".im-bot-callback-url").textContent.includes("botId="));
});

await check("编辑：appSecret / callbackToken / aesKey 留空都不进 PATCH body", async () => {
	imCard("客服机器人").querySelector(".im-edit").click();
	assert.equal(els.kbModalTitle.textContent, "编辑机器人");
	assert.equal(els.kbModalBody.querySelector(".im-form-secret").value, "", "编辑时 appSecret 默认空白");
	els.kbModalBody.querySelector(".im-form-name").value = "客服机器人（改）";
	const before = imPatches("imb-1").length;
	await t.submitKbDialog();
	await flush(80);
	const patches = imPatches("imb-1");
	assert.equal(patches.length, before + 1);
	assert.deepEqual(patches.at(-1).body, {
		name: "客服机器人（改）",
		appKey: "ding-app-key-1",
		robotCode: "ding_robot_1",
		enabled: true,
	});
	assert.equal(els.kbModal.hidden, true);
	assert.ok(imCard("客服机器人（改）"));
});

await check("启用 / 停用：PATCH 只有 { enabled }，徽标与按钮文案跟着变", async () => {
	let card = imCard("告警机器人");
	assert.equal(card.querySelector(".im-toggle").textContent, "启用");
	card.querySelector(".im-toggle").click();
	await flush(80);
	assert.deepEqual(imPatches("imb-2").at(-1).body, { enabled: true });
	card = imCard("告警机器人");
	assert.equal(card.querySelector(".im-state-badge").textContent, "启用");
	assert.equal(card.querySelector(".im-toggle").textContent, "停用");
	card.querySelector(".im-toggle").click();
	await flush(80);
	assert.deepEqual(imPatches("imb-2").at(-1).body, { enabled: false });
	assert.equal(imCard("告警机器人").querySelector(".im-state-badge").textContent, "停用");
});

await check("发测试消息成功：弹窗填写群目标，POST ping 并刷新 outbox", async () => {
	const beforeOutbox = t.state.im.outbox.length;
	const beforePings = imPings().length;
	imCard("客服机器人（改）").querySelector(".im-ping").click();
	assert.equal(els.kbModal.hidden, false);
	els.kbModalBody.querySelector(".im-ping-target").value = "cid-test-group";
	els.kbSave.click();
	await flush(100);
	const pings = imPings();
	assert.equal(pings.length, beforePings + 1);
	assert.deepEqual(pings.at(-1).body, { conversationId: "cid-test-group" });
	assert.equal(t.state.im.outbox.length, beforeOutbox + 1, "fake 传输下 ping 要进 outbox");
	const result = imCard("客服机器人（改）").querySelector(".im-ping-result");
	assert.equal(result.hidden, false);
	assert.ok(result.textContent.includes("已发送"), `成功文案：${result.textContent}`);
	assert.equal(result.classList.contains("ok"), true);
	const outboxRows = Array.from(els.modulePage.querySelectorAll(".im-outbox-row"));
	assert.equal(outboxRows.length, 3, "2 条夹具 + 刚 ping 的 1 条");
	assert.ok(outboxRows[0].querySelector(".im-outbox-content").textContent.includes("测试消息"));
});

await check("发测试消息失败：HTTP 200 + ok:false 也显示后端中文原因", async () => {
	t.setImPingError("imb-1", "钉钉返回 HTTP 500：mock 发送失败");
	const beforeOutbox = t.state.im.outbox.length;
	imCard("客服机器人（改）").querySelector(".im-ping").click();
	assert.equal(els.kbModal.hidden, false);
	els.kbModalBody.querySelector(".im-ping-target").value = "cid-test-group";
	els.kbSave.click();
	await flush(100);
	const result = imCard("客服机器人（改）").querySelector(".im-ping-result");
	assert.equal(result.classList.contains("err"), true);
	assert.ok(result.textContent.includes("钉钉返回 HTTP 500"), `失败文案：${result.textContent}`);
	assert.equal(t.state.im.outbox.length, beforeOutbox, "失败不该往 outbox 写消息");
	assert.equal(els.kbModal.hidden, false, "发送失败保留弹窗便于修正");
	els.kbModalClose.click();
	t.setImPingError("imb-1", null);
});

await check("测试发送支持员工目标，停用机器人禁发，刷新重新拉取状态", async () => {
	const before = imPings().length;
	imCard("客服机器人（改）").querySelector(".im-ping").click();
	els.kbModalBody.querySelector(".im-ping-type").value = "staffId";
	els.kbModalBody.querySelector(".im-ping-target").value = "staff-001";
	els.kbSave.click();
	await flush(100);
	assert.equal(imPings().length, before + 1);
	assert.deepEqual(imPings().at(-1).body, { staffId: "staff-001" });
	assert.equal(imCard("告警机器人").querySelector(".im-ping").disabled, true);
	els.modulePage.querySelector(".im-refresh").click();
	await flush(80);
	assert.ok(imCard("客服机器人（改）"));
});

await check("删除：二次确认写清连带会话映射，DELETE 后卡片消失", async () => {
	imCard("告警机器人").querySelector(".im-delete").click();
	await flush(80);
	const message = confirms.at(-1) ?? "";
	assert.ok(message.includes("连带"), `确认文案要提示连带删除：${message}`);
	assert.ok(message.includes("会话映射"), `确认文案要提到会话映射：${message}`);
	assert.ok(message.includes("404"), "要说明钉钉侧再回调会 404");
	assert.ok(
		t.calls.some((call) => call.url === "/api/im/bots/imb-2" && call.method === "DELETE"),
		"要真的发 DELETE",
	);
	assert.equal(imCard("告警机器人"), null);
	assert.equal(imCards().length, 2, "2 个夹具 + 新增 1 个 - 删除 1 个");
});

await check("IM 接口 403：整页「当前角色不能查看 IM 配置」，不冒充「未接入」", async () => {
	t.setImStatus(403);
	await t.refreshIm();
	t.renderModuleView();
	assert.equal(t.state.im.status, "forbidden");
	assert.equal(els.modulePage.querySelector(".module-denied__text")?.textContent, "当前角色不能查看 IM 配置");
	assert.ok(els.modulePage.querySelector(".module-denied__hint")?.textContent.includes("workflow.read"));
	assert.equal(els.modulePage.querySelector(".module-badge"), null, "403 不是「未接入」");
	assert.equal(els.modulePage.querySelector(".im-add"), null, "没权限也不摆添加按钮");
	assert.equal(imCards().length, 0);
	t.setImStatus(200);
});

await check("IM 接口 404：回落「未接入」空态 + 接口清单，不弹错、不显示 outbox", async () => {
	t.setImAvailable(false);
	await t.refreshIm();
	t.renderModuleView();
	assert.equal(t.state.im.status, "unavailable");
	assert.equal(els.modulePage.querySelector(".module-badge")?.textContent, "未接入");
	const codes = Array.from(els.modulePage.querySelectorAll(".module-api__code")).map((node) => node.textContent);
	assert.ok(codes.includes("GET /api/im/bots"), `接口清单要有 GET /api/im/bots：${codes.join("|")}`);
	assert.ok(codes.includes("POST /api/im/dingtalk/callback"), `接口清单要有钉钉回调：${codes.join("|")}`);
	assert.equal(els.modulePage.querySelector(".im-outbox"), null);
	assert.equal(Array.from(els.threadInner.querySelectorAll(".notice.err")).length, 0, "降级不该弹错");
	t.setImAvailable(true);
	await t.refreshIm();
	t.renderModuleView();
});

await check("outbox 200：最新消息排最前，时间 / 会话 / 内容截断 + title", async () => {
	t.resetImFixtures();
	await t.refreshIm();
	t.renderModuleView();
	assert.equal(t.state.im.outbox.length, 2);
	const rows = Array.from(els.modulePage.querySelectorAll(".im-outbox-row"));
	assert.equal(rows.length, 2);
	assert.equal(rows[0].dataset.outboxId, "out-2", "最新一条排最上面");
	const content = rows[0].querySelector(".im-outbox-content");
	assert.ok(content.textContent.endsWith("…"), "超长内容要截断");
	assert.equal(content.textContent.length, 61, "截断到 60 字 + 省略号");
	assert.ok(content.title.length > 60, "完整内容挂在 title 上");
	assert.equal(rows[0].querySelector(".im-outbox-target").textContent, "staff-9");
	assert.equal(rows[1].querySelector(".im-outbox-target").textContent, "cid-group-1");
	assert.ok(rows[0].querySelector(".im-outbox-time").textContent.includes("-"), "时间用本地时间展示");
	assert.equal(rows[0].querySelector(".im-outbox-bot").textContent, "客服机器人");
});

await check("outbox 404：整块隐藏，页面仍 ready，不显示「未接入」", async () => {
	t.setImOutboxAvailable(false);
	await t.refreshIm();
	t.renderModuleView();
	assert.equal(t.state.im.outbox, null);
	assert.equal(els.modulePage.querySelector(".im-outbox"), null, "outbox 整块隐藏");
	assert.equal(els.modulePage.querySelector(".module-badge"), null, "不是整页「未接入」");
	assert.equal(imCards().length, 2, "机器人列表不受 outbox 影响");
	assert.equal(els.modulePage.querySelector(".im-outbox-empty"), null);
	t.setImOutboxAvailable(true);
	await t.refreshIm();
	t.renderModuleView();
});

await check("没有 workflow.write：添加 / 编辑 / 启停 / ping / 删除全部置灰", () => {
	t.state.permissions = ["workflow.read"];
	t.renderModuleView();
	const add = els.modulePage.querySelector(".im-add");
	assert.equal(add.disabled, true);
	assert.equal(add.title, "当前角色不能修改 IM 配置");
	const buttons = [
		...Array.from(els.modulePage.querySelectorAll(".im-edit")),
		...Array.from(els.modulePage.querySelectorAll(".im-toggle")),
		...Array.from(els.modulePage.querySelectorAll(".im-ping")),
		...Array.from(els.modulePage.querySelectorAll(".im-delete")),
	];
	assert.ok(buttons.length >= 8, `写操作按钮都要在：${buttons.length}`);
	for (const button of buttons) {
		assert.equal(button.disabled, true, `没权限要置灰：${button.className}`);
		assert.equal(button.title, "当前角色不能修改 IM 配置");
	}
	t.openImBotDialog(t.state.im.bots[0]);
	assert.equal(els.kbModal.hidden, true, "没权限时添加/编辑弹窗打不开");
	t.state.permissions = ["workflow.write", "workflow.read"];
	t.renderModuleView();
});

await check("最近回调文案：null = 从未回调，缺字段 = —，相对时间人性化", () => {
	assert.equal(t.formatImCallbackAt(null), "从未回调");
	assert.equal(t.formatImCallbackAt(undefined), "—");
	assert.equal(t.formatImCallbackAt(FIXTURE_NOW - 5 * 60_000 - 30_000), "5 分钟前");
});

await check("IM 页的文案里没有「流程」二字", () => {
	const text = els.modulePage.textContent;
	assert.ok(!text.includes("流程"), `IM 页出现「流程」：${text.slice(0, 120)}`);
});

/* ================= 监控（P9） ================= */

section("监控（P9）：KPI / 范围切换 / 分组表 / 调用链 / 时间轴 / 权限");

const monitorKpiCard = (id) => els.modulePage.querySelector(`[data-kpi="${id}"]`);
const monitorKpiValue = (id) => monitorKpiCard(id)?.querySelector(".monitor-kpi-value")?.textContent ?? "";
const monitorSummaryCalls = () => t.calls.filter((call) => call.url.startsWith("/api/monitor/summary"));
const monitorTraceCalls = () => t.calls.filter((call) => call.url.startsWith("/api/monitor/traces?"));
const monitorDetailCalls = () => t.calls.filter((call) => /^\/api\/monitor\/traces\/[^/?]+$/.test(call.url));
const monitorTraceRows = () => Array.from(els.modulePage.querySelectorAll(".trace-row"));
const monitorTraceRow = (traceId) => monitorTraceRows().find((row) => row.dataset.traceId === traceId) ?? null;

await check("监控页：summary 拉取成功，渲染 7 张带中文说明的 KPI 卡", async () => {
	t.resetMonitorFixtures();
	t.state.monitor.range = "24h";
	await t.switchModule("chat");
	await t.switchModule("monitor");
	await flush(120);
	assert.equal(t.state.monitor.status, "ready");
	assert.equal(els.modulePage.querySelectorAll(".monitor-kpi-card").length, 7, "KPI 至少 6 张，这里 7 张");
	assert.equal(monitorKpiValue("sessions"), "42 个");
	assert.ok(
		monitorKpiCard("sessions").querySelector(".monitor-kpi-note").textContent.includes("24h 活跃 3 个"),
		"会话卡要说明 24h 活跃数",
	);
	assert.equal(monitorKpiValue("messages"), "128 条");
	assert.equal(monitorKpiValue("tools"), "100 次");
	assert.ok(
		monitorKpiCard("tools").querySelector(".monitor-kpi-note").textContent.includes("成功 97 · 失败 3"),
		"工具卡要摊开成功 / 失败",
	);
	assert.equal(monitorKpiValue("errors"), "3 次");
});

await check("KPI 格式化：成功率 / 平均耗时 / p95 都带单位", () => {
	assert.equal(monitorKpiValue("success"), "97%");
	assert.equal(monitorKpiValue("avg"), "320 毫秒");
	assert.equal(monitorKpiValue("p95"), "1.5 秒");
	assert.equal(t.formatDurationMs(0), "0 毫秒");
	assert.equal(t.formatDurationMs(65000), "1 分 5 秒");
	assert.equal(t.formatPercent(0, 0), "—", "没有调用时成功率不能写 0%");
});

await check("范围切换：点 7d 重拉 summary 并把 range 带进 query", async () => {
	const before = monitorSummaryCalls().length;
	els.modulePage.querySelector('[data-range="7d"]').click();
	await flush(100);
	const calls = monitorSummaryCalls();
	assert.equal(calls.length, before + 1, "切范围要重拉一次 summary");
	assert.ok(calls.at(-1).url.includes("range=7d"), calls.at(-1).url);
	assert.equal(els.modulePage.querySelector('[data-range="7d"]').getAttribute("aria-pressed"), "true");
	assert.equal(els.modulePage.querySelector('[data-range="24h"]').getAttribute("aria-pressed"), "false");
	assert.ok(els.modulePage.querySelector(".monitor-toolbar__hint").textContent.includes("最近 7 天"));
	// 复位成默认窗口，后面的断言按 24h 算
	await t.setMonitorRange("24h");
	await flush(80);
});

await check("分组表按调用次数倒序：技能 / MCP 服务 / 模型", () => {
	const skills = Array.from(els.modulePage.querySelectorAll(".monitor-skill-row"));
	assert.deepEqual(
		skills.map((row) => row.querySelector(".monitor-skill-id").textContent),
		["ticket-flow", "data-flow", "calc-flow"],
	);
	assert.equal(skills[0].querySelector(".monitor-skill-calls").textContent, "30 次");
	const mcps = Array.from(els.modulePage.querySelectorAll(".monitor-mcp-row"));
	assert.deepEqual(
		mcps.map((row) => row.querySelector(".monitor-mcp-server").textContent),
		["文件助手", "远程检索"],
	);
	assert.equal(mcps[1].querySelector(".monitor-mcp-failed").textContent, "2 次");
	const models = Array.from(els.modulePage.querySelectorAll(".monitor-model-row"));
	assert.deepEqual(
		models.map((row) => row.querySelector(".monitor-model-name").textContent),
		["模拟模型", "deepseek-chat"],
	);
	assert.equal(models[0].querySelector(".monitor-model-avg").textContent, "900 毫秒");
	assert.equal(models[1].querySelector(".monitor-model-avg").textContent, "1.5 秒");
});

await check("分组表空数据：三组都写「还没有数据」", async () => {
	t.setMonitorSummaryStore({ ...MONITOR_SUMMARY_SEED, skills: [], mcp: [], model: [] });
	await t.refreshMonitorSummary();
	t.renderModuleView();
	const empties = Array.from(els.modulePage.querySelectorAll(".monitor-group-empty"));
	assert.equal(empties.length, 3);
	for (const node of empties) assert.equal(node.textContent, "还没有数据");
	t.setMonitorSummaryStore(MONITOR_SUMMARY_SEED);
	await t.refreshMonitorSummary();
	t.renderModuleView();
});

await check("调用链列表：时间 / 前 8 位 traceId / 会话 / 状态徽标 / 耗时", () => {
	assert.equal(monitorTraceRows().length, 20, "首页 limit=20");
	const first = monitorTraceRow("tr_aaaaaaaaaaaa");
	assert.ok(first.querySelector(".trace-copy").textContent.length === 8, "traceId 只露前 8 位");
	assert.equal(first.querySelector(".trace-copy").textContent, "tr_aaaaa");
	assert.equal(first.querySelector(".trace-session").textContent, "sess-123");
	assert.equal(first.querySelector(".trace-status-badge").textContent, "成功");
	assert.equal(first.querySelector(".trace-status-badge").classList.contains("ok"), true);
	assert.equal(first.querySelector(".trace-ms").textContent, "1.2 秒");
	assert.equal(first.querySelector(".trace-model").textContent, "deepseek-chat");
	assert.equal(first.querySelector(".trace-tools").textContent, "3 个");
	const failed = monitorTraceRow("tr_bbbbbbbbbbbb");
	assert.equal(failed.querySelector(".trace-status-badge").textContent, "失败");
	assert.equal(failed.querySelector(".trace-status-badge").classList.contains("error"), true);
	assert.equal(failed.querySelector(".trace-ms").textContent, "800 毫秒");
	const running = monitorTraceRow("tr_cccccccccccc");
	assert.equal(running.querySelector(".trace-status-badge").textContent, "进行中");
	assert.equal(running.querySelector(".trace-ms").textContent, "进行中");
	assert.equal(running.querySelector(".trace-model").textContent, "—");
});

await check("点行加载详情：请求详情接口，时间轴按 seq 升序且 kind 有颜色类", async () => {
	const before = monitorDetailCalls().length;
	monitorTraceRow("tr_aaaaaaaaaaaa").click();
	await flush(100);
	const details = monitorDetailCalls();
	assert.equal(details.length, before + 1);
	assert.equal(details.at(-1).url, "/api/monitor/traces/tr_aaaaaaaaaaaa");
	assert.equal(t.state.monitor.detail.status, "ready");
	assert.ok(els.modulePage.querySelector(".trace-detail"), "详情页内展开");
	const events = Array.from(els.modulePage.querySelectorAll(".trace-event"));
	assert.deepEqual(
		events.map((node) => node.dataset.seq),
		["1", "2", "3", "4", "5"],
		"事件乱序返回也要按 seq 排",
	);
	assert.deepEqual(
		events.map((node) => node.querySelector(".trace-kind").textContent),
		["llm", "tool", "skill", "mcp", "approval"],
	);
	assert.equal(events[0].querySelector(".trace-kind").classList.contains("kind-llm"), true);
	assert.equal(events[1].querySelector(".trace-kind").classList.contains("kind-tool"), true);
	assert.equal(events[2].querySelector(".trace-kind").classList.contains("kind-skill"), true);
	assert.equal(events[3].querySelector(".trace-kind").classList.contains("kind-mcp"), true);
	assert.equal(events[4].querySelector(".trace-kind").classList.contains("kind-approval"), true);
	assert.equal(events[1].querySelector(".trace-event-ok").textContent, "成功");
	assert.equal(events[3].querySelector(".trace-event-ok").textContent, "失败");
	assert.equal(monitorTraceRow("tr_aaaaaaaaaaaa").classList.contains("active"), true, "选中行高亮");
});

await check("payload：压成 key=value，超 120 字截断，完整内容挂 title", () => {
	const event = Array.from(els.modulePage.querySelectorAll(".trace-event")).find((node) => node.dataset.seq === "2");
	const payload = event.querySelector(".trace-event-payload");
	assert.ok(payload.textContent.startsWith("args="), payload.textContent);
	assert.ok(payload.textContent.endsWith("…"), "超长要截断");
	assert.ok(payload.textContent.length <= 121, `截断到 120 字 + 省略号：${payload.textContent.length}`);
	assert.ok(payload.title.length > 120, "完整 payload 要挂在 title 上");
	assert.ok(payload.title.includes("这是一段很长"));
	assert.equal(t.tracePayloadFull({ a: null, b: 2 }), "b=2", "空值不写进摘要");
});

await check("traceId 复制：复制完整 id，且不会误开详情", async () => {
	const before = monitorDetailCalls().length;
	const copy = monitorTraceRow("tr_bbbbbbbbbbbb").querySelector(".trace-copy");
	copy.click();
	await flush(40);
	assert.equal(clipboardWrites.at(-1), "tr_bbbbbbbbbbbb", "复制的是完整 traceId");
	assert.ok(copy.title.includes("tr_bbbbbbbbbbbb"));
	assert.equal(monitorDetailCalls().length, before, "复制不触发详情请求");
});

await check("加载更多：offset 从当前条数继续，追加完到底置灰", async () => {
	const before = monitorTraceCalls().length;
	const more = els.modulePage.querySelector(".monitor-more");
	assert.equal(more.disabled, false);
	more.click();
	await flush(100);
	const calls = monitorTraceCalls();
	assert.equal(calls.length, before + 1);
	assert.ok(calls.at(-1).url.includes("limit=20"));
	assert.ok(calls.at(-1).url.includes("offset=20"), calls.at(-1).url);
	assert.equal(monitorTraceRows().length, 25, "20 + 5 追加");
	assert.equal(els.modulePage.querySelector(".monitor-more").disabled, true);
	assert.equal(els.modulePage.querySelector(".monitor-traces-foot__hint").textContent, "已显示 25 / 25 条");
});

await check("详情 404：后端 { error }（调用链不存在）原样显示，可关闭", async () => {
	await t.openTraceDetail("tr_missing");
	assert.equal(t.state.monitor.detail.status, "error");
	assert.equal(els.modulePage.querySelector(".trace-detail-error").textContent, "调用链不存在");
	assert.equal(els.modulePage.querySelectorAll(".trace-event").length, 0);
	els.modulePage.querySelector(".trace-detail-close").click();
	assert.equal(els.modulePage.querySelector(".trace-detail"), null);
});

await check("详情 403：显示后端权限文案，不混成通用失败", async () => {
	t.setMonitorDetailStatus(403);
	await t.openTraceDetail("tr_aaaaaaaaaaaa");
	assert.equal(t.state.monitor.detail.status, "forbidden");
	assert.ok(
		els.modulePage.querySelector(".trace-detail-error").textContent.includes("只能查看自己创建的会话"),
		els.modulePage.querySelector(".trace-detail-error").textContent,
	);
	t.setMonitorDetailStatus(200);
	els.modulePage.querySelector(".trace-detail-close").click();
});

await check("traces 403：KPI 仍在，调用链区说清权限并提示联系所有者", async () => {
	t.setMonitorTracesStatus(403);
	await t.refreshMonitorSummary();
	await t.refreshMonitorTraces({ reset: true });
	t.renderModuleView();
	assert.equal(t.state.monitor.tracesStatus, "forbidden");
	assert.equal(els.modulePage.querySelectorAll(".monitor-kpi-card").length, 7, "KPI 不能被 traces 的 403 带走");
	assert.equal(els.modulePage.querySelector(".module-denied__text").textContent, "当前角色不能查看审计记录");
	assert.ok(els.modulePage.querySelector(".module-denied__hint").textContent.includes("联系所有者"));
	assert.equal(monitorTraceRows().length, 0);
	assert.equal(els.modulePage.querySelector(".module-badge"), null, "403 不是「未接入」");
	t.setMonitorTracesStatus(200);
	await t.refreshMonitorTraces({ reset: true });
	t.renderModuleView();
});

await check("summary 404：整页回落「未接入」空态 + 接口清单，不弹错", async () => {
	t.setMonitorAvailable(false);
	await t.refreshMonitor();
	t.renderModuleView();
	assert.equal(t.state.monitor.status, "unavailable");
	assert.equal(els.modulePage.querySelector(".module-badge").textContent, "未接入");
	assert.equal(els.modulePage.querySelectorAll(".monitor-kpi-card").length, 0);
	const codes = Array.from(els.modulePage.querySelectorAll(".module-api__code")).map((node) => node.textContent);
	assert.ok(codes.includes("GET /api/monitor/summary"), codes.join("|"));
	assert.ok(codes.includes("GET /api/monitor/traces"));
	assert.equal(Array.from(els.threadInner.querySelectorAll(".notice.err")).length, 0, "降级不该弹错");
	t.setMonitorAvailable(true);
	await t.refreshMonitor();
	t.renderModuleView();
});

await check("空数据态：KPI 写 0、成功率与耗时写「—」、调用链提示先发消息", async () => {
	t.setMonitorSummaryStore({
		sessions: { total: 0, active24h: 0 },
		messages24h: 0,
		toolCalls: { total: 0, ok: 0, failed: 0, avgMs: 0 },
		skills: [],
		mcp: [],
		model: [],
		errors: 0,
		p95Ms: 0,
	});
	t.setMonitorTraceStore([]);
	await t.refreshMonitor();
	t.renderModuleView();
	assert.equal(monitorKpiValue("sessions"), "0 个");
	assert.equal(monitorKpiValue("messages"), "0 条");
	assert.equal(monitorKpiValue("tools"), "0 次");
	assert.equal(monitorKpiValue("success"), "—");
	assert.equal(monitorKpiValue("avg"), "—");
	assert.equal(monitorKpiValue("p95"), "—");
	assert.equal(monitorKpiValue("errors"), "0 次");
	assert.ok(els.modulePage.querySelector(".monitor-traces-empty").textContent.includes("还没有调用链"));
	assert.equal(els.modulePage.querySelectorAll(".monitor-group-empty").length, 3);
	t.resetMonitorFixtures();
	await t.refreshMonitor();
	t.renderModuleView();
});

await check("刷新按钮：同时重拉 summary 与调用链，并收起详情", async () => {
	await t.openTraceDetail("tr_aaaaaaaaaaaa");
	assert.ok(els.modulePage.querySelector(".trace-detail"));
	const summariesBefore = monitorSummaryCalls().length;
	const tracesBefore = monitorTraceCalls().length;
	els.modulePage.querySelector(".monitor-refresh").click();
	await flush(140);
	assert.equal(monitorSummaryCalls().length, summariesBefore + 1);
	assert.equal(monitorTraceCalls().length, tracesBefore + 1);
	assert.equal(t.state.monitor.detail, null);
	assert.equal(els.modulePage.querySelector(".trace-detail"), null);
});

await check("监控页的文案里没有「流程」二字", () => {
	const text = els.modulePage.textContent;
	assert.ok(!text.includes("流程"), `监控页出现「流程」：${text.slice(0, 120)}`);
});

/* ================= 审批中心 / 成员写操作（本次新增） ================= */

section("审批中心：待办列表 / 批准与拒绝 / 自动刷新 / 权限与降级");

// 审批挂在两个真实形状的会话上：空标题那条同时验 sessionId 前 8 位回落
const approvalSessionFixtures = () => [
	{
		id: "s-approval-0001",
		workflowId: "approval-flow",
		workflowName: "费用审批",
		title: "差旅报销",
		archived: false,
		steps: [],
		skills: skillCatalog(),
		activeSkillId: null,
	},
	{
		id: "s-approval-0002-very-long",
		workflowId: "approval-flow",
		workflowName: "费用审批",
		title: null,
		archived: true,
		steps: [],
		skills: skillCatalog(),
		activeSkillId: null,
	},
];

const approvalRows = () => Array.from(els.modulePage.querySelectorAll(".approval-row"));
const approvalRowByRequest = (requestId) =>
	approvalRows().find((row) => row.dataset.requestId === requestId) ?? null;
const approvalCalls = () => t.calls.filter((call) => call.url === "/api/approvals");
const approvalPosts = () =>
	t.calls.filter((call) => call.method === "POST" && call.url.startsWith("/api/approvals/"));
const pageNotice = () => els.modulePage.querySelector(".module-notice");
const memberRowById = (id) => memberRows().find((row) => row.dataset.userId === id) ?? null;
const memberButtons = (id) =>
	Array.from(memberRowById(id)?.querySelectorAll(".member-actions .link-btn") ?? []);

/** 重置审批夹具并进入审批页：默认两个待办、权限齐全、自动刷新开着。 */
async function showApprovalsPage() {
	t.setApprovalsAvailable(true);
	t.setApprovalsStatus(200);
	t.setApprovalPostStatus(200);
	t.resetApprovalStore();
	sessionStore = approvalSessionFixtures();
	t.state.permissions = ["session.read", "session.run", "member.manage"];
	t.state.approvals.notice = null;
	if (t.state.module !== "approvals") {
		await t.switchModule("chat");
		await t.switchModule("approvals");
	} else {
		await t.refreshApprovals();
		t.renderModuleView();
	}
	await flush(80);
}

await check("审批页：进入时拉一次队列，默认自动刷新开、两个待办都画出来", async () => {
	const before = approvalCalls().length;
	await showApprovalsPage();
	assert.equal(pageTitle(), "审批");
	assert.equal(t.state.approvals.status, "ready");
	const auto = els.modulePage.querySelector(".approval-auto__input");
	assert.ok(auto, "页头要有自动刷新开关");
	assert.equal(auto.checked, true, "默认开");
	assert.equal(t.state.approvals.auto, true);
	assert.notEqual(t.state.approvals.timer, null, "开着自动刷新要有定时器");
	assert.ok(approvalCalls().length > before, "进入审批页要拉一次 /api/approvals");
	assert.equal(approvalRows().length, 2);
	assert.ok(!els.modulePage.textContent.includes("流程"), "审批页文案不许出现「流程」");
});

await check("待办行：会话标题 / 空标题回落 sessionId 前 8 位 / 技能 / 工具 / 已归档标记", () => {
	const first = approvalRowByRequest("apv-1");
	assert.equal(first.querySelector(".approval-session-title").textContent, "差旅报销");
	assert.equal(first.querySelector(".approval-skill").textContent, "费用审批");
	assert.equal(first.querySelector(".approval-tool").textContent, "approval_submit");
	assert.equal(first.querySelectorAll(".approval-archived").length, 0, "没归档就不挂标记");
	const second = approvalRowByRequest("apv-2");
	assert.equal(second.querySelector(".approval-session-title").textContent, "s-approv", "空标题显示 sessionId 前 8 位");
	assert.equal(second.querySelector(".approval-archived").textContent, "已归档");
});

await check("风险徽标：high 红 / medium 黄，文案用中文且 title 保留原始等级", () => {
	const high = approvalRowByRequest("apv-1").querySelector(".approval-risk");
	assert.equal(high.textContent, "高风险");
	assert.equal(high.classList.contains("high"), true);
	assert.ok(high.title.includes("high"));
	const medium = approvalRowByRequest("apv-2").querySelector(".approval-risk");
	assert.equal(medium.textContent, "中风险");
	assert.equal(medium.classList.contains("medium"), true);
});

await check("参数摘要：JSON 压成 key=value，超 80 字截断并把完整内容挂 title", () => {
	const args = approvalRowByRequest("apv-1").querySelector(".approval-args");
	assert.ok(args.textContent.startsWith("applicant=张明 · type=报销 · amount=3200"), args.textContent);
	assert.ok(args.textContent.endsWith("…"), "超长要截断");
	assert.equal(args.textContent.length, 81, "80 字 + 省略号");
	assert.ok(args.title.length > 80, "完整参数留在 title 里");
	assert.ok(args.title.includes("memo=金额较大"));
	const short = approvalRowByRequest("apv-2").querySelector(".approval-args");
	assert.equal(short.title, "", "没截断就不要 title");
	assert.ok(short.textContent.includes("path=C:\\data\\reports\\2026-10.csv"));
});

await check("等待时长：42 秒写「已等待 42 秒」，超 60 秒标红", () => {
	t.resetApprovalStore();
	return (async () => {
		await t.refreshApprovals();
		t.renderModuleView();
		const fresh = approvalRowByRequest("apv-1").querySelector(".approval-wait");
		assert.match(fresh.textContent, /^已等待 4[0-9] 秒$/, fresh.textContent);
		assert.equal(fresh.classList.contains("over"), false, "没到 60 秒不标红");
		assert.ok(fresh.title.startsWith("请求时间："));
		const stale = approvalRowByRequest("apv-2").querySelector(".approval-wait");
		assert.match(stale.textContent, /^已等待 12[0-9] 秒$/, stale.textContent);
		assert.equal(stale.classList.contains("over"), true, "超过 60 秒标红");
	})();
});

await check("自动刷新开关：关掉清定时器，打开重新计时；切走模块立即停", async () => {
	const off = els.modulePage.querySelector(".approval-auto__input");
	off.checked = false;
	off.dispatch("change");
	assert.equal(t.state.approvals.auto, false);
	assert.equal(t.state.approvals.timer, null, "关掉要清定时器");
	const on = els.modulePage.querySelector(".approval-auto__input");
	on.checked = true;
	on.dispatch("change");
	assert.equal(t.state.approvals.auto, true);
	assert.notEqual(t.state.approvals.timer, null);
	await t.switchModule("chat");
	assert.equal(t.state.approvals.timer, null, "切走审批页轮询必须停");
	await t.switchModule("approvals");
	await flush(80);
	assert.notEqual(t.state.approvals.timer, null, "回到审批页恢复轮询");
});

await check("批准：POST body { requestId, approved:true }，成功后该条从列表移除并提示", async () => {
	await showApprovalsPage();
	const before = approvalPosts().length;
	approvalRowByRequest("apv-1").querySelector(".approval-approve").click();
	await flush(80);
	const posts = approvalPosts();
	assert.equal(posts.length, before + 1);
	assert.equal(posts.at(-1).url, "/api/approvals/s-approval-0001");
	assert.deepEqual(posts.at(-1).body, { requestId: "apv-1", approved: true });
	assert.equal(approvalRows().length, 1, "批完从列表移除");
	assert.equal(approvalRowByRequest("apv-1"), null);
	assert.ok(pageNotice().textContent.includes("已批准"), pageNotice().textContent);
	assert.equal(pageNotice().classList.contains("err"), false);
});

await check("拒绝：POST body { requestId, approved:false }，成功后同样移除并提示", async () => {
	await showApprovalsPage();
	const before = approvalPosts().length;
	approvalRowByRequest("apv-1").querySelector(".approval-reject").click();
	await flush(80);
	const posts = approvalPosts();
	assert.equal(posts.length, before + 1);
	assert.equal(posts.at(-1).url, "/api/approvals/s-approval-0001");
	assert.deepEqual(posts.at(-1).body, { requestId: "apv-1", approved: false });
	assert.equal(approvalRows().length, 1);
	assert.equal(approvalRowByRequest("apv-1"), null);
	assert.ok(pageNotice().textContent.includes("已拒绝"), pageNotice().textContent);
});

await check("409：提示「这条审批已经处理过了」并刷新队列，不当成失败报错", async () => {
	await showApprovalsPage();
	t.setApprovalPostStatus(409);
	const before = approvalCalls().length;
	approvalRowByRequest("apv-1").querySelector(".approval-approve").click();
	await flush(100);
	assert.equal(pageNotice().textContent, "这条审批已经处理过了");
	assert.equal(pageNotice().classList.contains("err"), true);
	assert.equal(approvalCalls().length, before + 1, "409 之后要刷新队列");
	assert.equal(approvalRows().length, 2, "刷新后仍以服务端为准");
	t.setApprovalPostStatus(200);
});

await check("审批 POST 403：显示后端权限文案，行还留着等人处理", async () => {
	await showApprovalsPage();
	t.setApprovalPostStatus(403, "当前角色是审计员，不能处理审批");
	approvalRowByRequest("apv-1").querySelector(".approval-approve").click();
	await flush(80);
	assert.equal(pageNotice().textContent, "当前角色是审计员，不能处理审批");
	assert.equal(pageNotice().classList.contains("err"), true);
	assert.equal(approvalRows().length, 2, "没批成功就不能把行拿掉");
	t.setApprovalPostStatus(200);
});

await check("没有 session.run：批准 / 拒绝置灰并说明，去会话仍然可用", async () => {
	await showApprovalsPage();
	t.state.permissions = ["session.read"];
	await t.refreshApprovals();
	t.renderModuleView();
	const approve = approvalRowByRequest("apv-1").querySelector(".approval-approve");
	const reject = approvalRowByRequest("apv-1").querySelector(".approval-reject");
	assert.equal(approve.disabled, true);
	assert.equal(reject.disabled, true);
	assert.equal(approve.title, "当前角色不能处理审批（需要 session.run）");
	assert.equal(approvalRowByRequest("apv-1").querySelector(".approval-open").disabled, false);
	assert.ok(els.modulePage.textContent.includes("当前角色不能处理审批"));
	t.state.permissions = ["session.read", "session.run", "member.manage"];
});

await check("审批空态：「当前没有待处理的审批」+ 高风险说明，不冒充「未接入」", async () => {
	await showApprovalsPage();
	t.setApprovalStore([]);
	await t.refreshApprovals();
	t.renderModuleView();
	assert.equal(approvalRows().length, 0);
	assert.equal(els.modulePage.querySelector(".approval-empty__title").textContent, "当前没有待处理的审批");
	assert.ok(els.modulePage.querySelector(".approval-empty__text").textContent.includes("高风险工具调用需要人工放行"));
	assert.equal(els.modulePage.querySelector(".module-badge"), null, "空列表不是「未接入」");
});

await check("审批接口 404：回落「未接入」空态 + 接口清单，不弹错误", async () => {
	await showApprovalsPage();
	t.setApprovalsAvailable(false);
	await t.refreshApprovals();
	t.renderModuleView();
	assert.equal(t.state.approvals.status, "unavailable");
	assert.equal(els.modulePage.querySelector(".module-badge").textContent, "未接入");
	assert.deepEqual(
		Array.from(els.modulePage.querySelectorAll(".module-api__code")).map((node) => node.textContent),
		["GET /api/approvals", "POST /api/approvals/:sessionId"],
	);
	assert.equal(Array.from(els.threadInner.querySelectorAll(".notice.err")).length, 0);
	t.setApprovalsAvailable(true);
});

await check("审批队列 403：整页「权限不足」，不混进「未接入」，也不摆假行", async () => {
	await showApprovalsPage();
	t.setApprovalsStatus(403);
	await t.refreshApprovals();
	t.renderModuleView();
	assert.equal(t.state.approvals.status, "forbidden");
	assert.equal(els.modulePage.querySelector(".module-denied__text").textContent, "当前角色不能查看审批队列");
	assert.equal(els.modulePage.querySelector(".module-badge"), null, "403 不是「未接入」");
	assert.equal(approvalRows().length, 0);
	t.setApprovalsStatus(200);
});

await check("「去会话」：切回对话模块并打开这条审批所在的会话", async () => {
	await showApprovalsPage();
	approvalRowByRequest("apv-1").querySelector(".approval-open").click();
	await flush(140);
	assert.equal(t.state.module, "chat", "点了要切回对话");
	assert.equal(t.state.currentId, "s-approval-0001");
	assert.equal(els.title.textContent, "差旅报销");
});

section("成员写操作：改角色 / 停用启用 / 删除 / 权限与错误文案");

await check("成员表格补上操作列：每人三个按钮，自己那行置灰并说清原因", async () => {
	t.setMembersAvailable(true);
	t.resetMemberStore();
	t.setMemberMutationError(null);
	sessionStore = approvalSessionFixtures();
	t.state.permissions = ["member.manage"];
	t.state.members.notice = null;
	await t.switchModule("chat");
	await t.switchModule("members");
	await flush(80);
	assert.equal(pageTitle(), "成员");
	const headers = Array.from(els.modulePage.querySelectorAll(".module-th")).map((node) => node.textContent);
	assert.ok(headers.includes("操作"), headers.join("|"));
	assert.equal(memberRows().length, 4);
	for (const row of memberRows()) {
		assert.equal(row.querySelectorAll(".member-actions .link-btn").length, 3, "每行三个操作");
	}
	const self = memberButtons("u-1");
	assert.equal(self.length, 3);
	for (const button of self) {
		assert.equal(button.disabled, true, "自己那行不能操作");
		assert.equal(button.title, "不能修改自己的角色或状态");
	}
	const other = memberButtons("u-2");
	assert.equal(other[0].disabled, false);
	assert.equal(other[1].textContent, "停用", "当前正常 → 按钮是「停用」");
	assert.equal(memberButtons("u-3")[1].textContent, "启用", "当前停用 → 按钮是「启用」");
});

await check("没有 member.manage：操作按钮全部置灰，title 说清原因", () => {
	t.state.permissions = ["session.read"];
	t.renderModuleView();
	const buttons = Array.from(els.modulePage.querySelectorAll(".member-actions .link-btn"));
	assert.equal(buttons.length, 12, "4 行 × 3 个");
	for (const button of buttons) {
		assert.equal(button.disabled, true);
		assert.equal(button.title, "当前角色不能管理成员");
	}
	t.state.permissions = ["member.manage"];
	t.renderModuleView();
});

await check("改角色：弹窗四角色中文，PATCH body { role }，成功后刷新列表并提示", async () => {
	const before = t.calls.filter((call) => call.method === "PATCH" && call.url === "/api/auth/users/u-2").length;
	memberRowById("u-2").querySelector(".member-role-btn").click();
	await flush(20);
	assert.equal(els.kbModal.hidden, false);
	assert.equal(els.kbModalTitle.textContent, "修改角色 · 王运营");
	const select = els.kbModalBody.querySelector("select");
	assert.deepEqual(
		Array.from(select.querySelectorAll("option")).map((node) => node.textContent),
		["所有者", "开发者", "运营", "审计员"],
	);
	select.value = "auditor";
	await t.submitKbDialog();
	await flush(80);
	const patches = t.calls.filter((call) => call.method === "PATCH" && call.url === "/api/auth/users/u-2");
	assert.equal(patches.length, before + 1);
	assert.deepEqual(patches.at(-1).body, { role: "auditor" });
	assert.equal(els.kbModal.hidden, true, "成功要关弹窗");
	assert.equal(memberRowById("u-2").querySelector(".member-role").textContent, "审计员");
	assert.ok(pageNotice().textContent.includes("已把 王运营 的角色改为「审计员」"));
});

await check("停用：PATCH body { disabled:true }，状态变「已停用」按钮变「启用」", async () => {
	const before = t.calls.filter((call) => call.method === "PATCH" && call.url === "/api/auth/users/u-2").length;
	memberRowById("u-2").querySelector(".member-toggle").click();
	await flush(80);
	const patches = t.calls.filter((call) => call.method === "PATCH" && call.url === "/api/auth/users/u-2");
	assert.equal(patches.length, before + 1);
	assert.deepEqual(patches.at(-1).body, { disabled: true });
	assert.equal(memberRowById("u-2").querySelector(".member-badge").textContent, "已停用");
	assert.equal(memberRowById("u-2").querySelector(".member-toggle").textContent, "启用");
	assert.ok(pageNotice().textContent.includes("已停用 王运营"));
});

await check("启用：PATCH body { disabled:false }，状态回到「正常」", async () => {
	const before = t.calls.filter((call) => call.method === "PATCH" && call.url === "/api/auth/users/u-2").length;
	memberRowById("u-2").querySelector(".member-toggle").click();
	await flush(80);
	const patches = t.calls.filter((call) => call.method === "PATCH" && call.url === "/api/auth/users/u-2");
	assert.equal(patches.length, before + 1);
	assert.deepEqual(patches.at(-1).body, { disabled: false });
	assert.equal(memberRowById("u-2").querySelector(".member-badge").textContent, "正常");
	assert.equal(memberRowById("u-2").querySelector(".member-toggle").textContent, "停用");
});

await check("删除：二次确认写清不可恢复，确认后 DELETE 并刷新列表", async () => {
	t.setConfirmAnswer(true);
	const before = t.calls.filter((call) => call.method === "DELETE" && call.url === "/api/auth/users/u-4").length;
	memberRowById("u-4").querySelector(".member-delete").click();
	await flush(80);
	const message = t.confirms.at(-1) ?? "";
	assert.ok(message.includes("删除后不可恢复"), message);
	assert.ok(message.includes("zhao@biz-agent.dev"), message);
	const deletes = t.calls.filter((call) => call.method === "DELETE" && call.url === "/api/auth/users/u-4");
	assert.equal(deletes.length, before + 1);
	assert.equal(memberRows().length, 3, "删完列表少一行");
	assert.equal(memberRowById("u-4"), null);
	assert.ok(pageNotice().textContent.includes("已删除成员 赵开发"));
});

await check("成员写接口 400：后端中文文案原样显示在页面（不 alert），行不消失", async () => {
	t.setMemberMutationError(400, "至少要保留一个启用的所有者");
	const alertsBefore = t.alerts.length;
	memberRowById("u-3").querySelector(".member-toggle").click();
	await flush(80);
	const notice = els.modulePage.querySelector(".module-notice.err");
	assert.ok(notice, "要有错误提示");
	assert.equal(notice.textContent, "至少要保留一个启用的所有者");
	assert.equal(t.alerts.length, alertsBefore, "不能用 alert");
	assert.equal(memberRowById("u-3").querySelector(".member-badge").textContent, "已停用", "失败不能改行");
	t.setMemberMutationError(null);
});

await check("改角色弹窗 404：后端文案显示在弹窗里，弹窗不关", async () => {
	t.setMemberMutationError(404, "成员不存在");
	memberRowById("u-2").querySelector(".member-role-btn").click();
	await flush(20);
	await t.submitKbDialog();
	await flush(80);
	assert.equal(els.kbModal.hidden, false, "失败不该关弹窗");
	assert.equal(els.kbError.hidden, false);
	assert.equal(els.kbError.textContent, "成员不存在");
	t.setMemberMutationError(null);
	t.closeKbDialog();
});

await check("成员页（真实表格）的文案里没有「流程」二字", () => {
	const text = els.modulePage.textContent;
	assert.ok(!text.includes("流程"), `成员页出现「流程」：${text.slice(0, 120)}`);
});

// 收尾：定时器只应该在审批页跑，回到对话把轮询停掉
await t.switchModule("chat");
assert.equal(t.state.approvals.timer, null);

/* ================= 汇总 ================= */

const failed = results.filter((item) => !item.ok);
if (failed.length > 0) {
	console.log(`\n前端 DOM 桩自检失败：${failed.length}/${results.length} 项`);
	for (const item of failed) console.log(`  ✗ [${item.section}] ${item.name}\n      ${item.message}`);
	process.exitCode = 1;
} else {
	console.log(`\n前端 DOM 桩自检全部通过：${results.length} 项`);
}
