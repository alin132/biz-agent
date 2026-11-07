/* biz-agent 控制台 —— 原生 JS，无构建步骤。 */

const els = {
	shell: document.getElementById("shell"),
	railNav: document.getElementById("rail-nav"),
	modulePage: document.getElementById("module-page"),
	pinnedList: document.getElementById("pinned-list"),
	sessionList: document.getElementById("session-list"),
	title: document.getElementById("session-title"),
	modeChip: document.getElementById("mode-chip"),
	modelName: document.getElementById("model-name"),
	stepbar: document.getElementById("stepbar"),
	threadInner: document.getElementById("thread-inner"),
	messages: document.getElementById("messages"),
	empty: document.getElementById("empty"),
	composer: document.getElementById("composer"),
	input: document.getElementById("input"),
	send: document.getElementById("send"),
	drawer: document.getElementById("drawer"),
	drawerClose: document.getElementById("drawer-close"),
	steps: document.getElementById("steps"),
	audit: document.getElementById("audit"),
	menu: document.getElementById("menu"),
	searchRow: document.getElementById("search-row"),
	searchInput: document.getElementById("search-input"),
	permissionChip: document.getElementById("permission-chip"),
	permissionLabel: document.getElementById("permission-label"),
	modelSelect: document.getElementById("model-select"),
	slash: document.getElementById("slash"),
	attachBtn: document.getElementById("btn-attach"),
	fileInput: document.getElementById("file-input"),
	attachments: document.getElementById("attachments"),
	micBtn: document.getElementById("btn-mic"),
	archivedGroup: document.getElementById("archived-group"),
	archivedToggle: document.getElementById("archived-toggle"),
	archivedCount: document.getElementById("archived-count"),
	archivedList: document.getElementById("archived-list"),
	archivedBadge: document.getElementById("archived-badge"),
	unarchiveBtn: document.getElementById("btn-unarchive"),
	skillChip: document.getElementById("skill-chip"),
	skillChipLabel: document.getElementById("skill-chip-label"),
	skillList: document.getElementById("skill-list"),
	newSkillBtn: document.getElementById("btn-new-skill"),
	skillCurrentName: document.getElementById("skill-current-name"),
	skillCurrentMeta: document.getElementById("skill-current-meta"),
	skillCurrentExit: document.getElementById("skill-current-exit"),
	flowModal: document.getElementById("flow-modal"),
	flowModalTitle: document.getElementById("flow-modal-title"),
	flowModalClose: document.getElementById("flow-modal-close"),
	flowName: document.getElementById("flow-name"),
	flowPrompt: document.getElementById("flow-prompt"),
	flowSkillDesc: document.getElementById("flow-skill-desc"),
	flowSkillInst: document.getElementById("flow-skill-inst"),
	flowStepsBox: document.getElementById("flow-steps"),
	flowAddStep: document.getElementById("flow-add-step"),
	flowCancel: document.getElementById("flow-cancel"),
	flowSave: document.getElementById("flow-save"),
	flowError: document.getElementById("flow-error"),
	toBottom: document.getElementById("to-bottom"),
	// 登录页与身份
	railAvatar: document.getElementById("rail-avatar"),
	railRole: document.getElementById("rail-role"),
	loginGate: document.getElementById("login-gate"),
	loginForm: document.getElementById("login-form"),
	loginEmail: document.getElementById("login-email"),
	loginPassword: document.getElementById("login-password"),
	loginSubmit: document.getElementById("login-submit"),
	loginError: document.getElementById("login-error"),
	// 知识库：通用小弹窗（新建库 / 绑定库）+ 隐藏的上传 input
	kbModal: document.getElementById("kb-modal"),
	kbForm: document.getElementById("kb-form"),
	kbModalTitle: document.getElementById("kb-modal-title"),
	kbModalBody: document.getElementById("kb-modal-body"),
	kbModalClose: document.getElementById("kb-modal-close"),
	kbCancel: document.getElementById("kb-cancel"),
	kbSave: document.getElementById("kb-save"),
	kbError: document.getElementById("kb-error"),
	kbFile: document.getElementById("kb-file"),
};

const PIN_KEY = "biz-agent.pinned";

const state = {
	// 当前模块：chat = 对话（三列布局），其余模块整宽显示模块页
	module: "chat",
	// 模块页只读展示用：模型列表（GET /api/models）与健康信息（GET /api/health）
	models: null,
	health: null,
	// 模型管理（P6）：ready 才画供应商/模型表；老后端（没有 providers/models 字段）或 404 回落旧版只读展示
	modelAdmin: { status: "unknown", providers: [], models: [], current: null, mode: null, options: [] },
	// API Key（P4）：三态与成员/审计一致；items 里永远只有 prefix，没有明文
	apiKeys: { status: "unknown", items: [] },
	workflows: [],
	sessions: [],
	currentId: null,
	currentView: null,
	es: null,
	runEl: null,
	answerEl: null,
	// 思考过程容器（reasoning 模型才有）：折起显示，正文开始时改标题
	thinkingEl: null,
	busy: false,
	pinned: new Set(JSON.parse(localStorage.getItem(PIN_KEY) ?? "[]")),
	searchQuery: "",
	// 已归档折叠区默认收起；搜索时临时展开，让命中的归档会话可见
	archivedOpen: false,
	attachments: [],
	menuAnchor: null,
	// 斜杠命令面板的元素（index.html 里挂在输入框表单内，贴着输入框上方展开）
	titleEditor: null,
	// 当前加载的技能 { id, name }；null = 跑会话自己的流程
	activeSkill: null,
	// 流程管理：工具目录、正在编辑的流程草稿（编辑中的输入直接写回草稿）
	tools: [],
	// 技能目录（GET /api/skills）：左栏技能区画的就是它；会话视图里的 skills 只用来标 active
	skillCatalog: [],
	skillQuery: "",
	skillFilter: "all",
	// 登录态：me = GET /api/auth/me 的响应（后端没有登录功能时为 null）
	me: null,
	permissions: [],
	loginVisible: false,
	loginBusy: false,
	// 知识库（P5）：status = unknown 还没问 | ready 有接口 | unavailable 404/连不上 → 回落「未接入」空态
	kb: {
		status: "unknown",
		libraries: [],
		selectedId: null,
		documents: [],
		embedding: null,
		search: null,
		uploading: false,
		// 「设为对话默认」开关失败时的页面内提示（不往对话区塞，也不 alert）
		notice: null,
		savingDefaults: false,
	},
	// 成员 / 审计（P4）：同样的三态 + forbidden（403 说清"角色不够"，不混进「未接入」）
	members: { status: "unknown", items: [], notice: null },
	audit: { status: "unknown", items: [], total: 0, action: "", actor: "", loading: false },
	// MCP（P7）：三态 + 服务列表；expanded 记住哪几张卡展开了工具表（重画后不折叠）
	mcp: { status: "unknown", servers: [], expanded: new Set() },
	// 插件（UI 首版）：列表由 /api/plugins 提供，页面不解析或执行插件代码。
	plugins: { status: "unknown", items: [], notice: null },
	// IM 机器人（P8）：三态 + 机器人列表 + fake 传输下的 outbox（拿不到就 null，整块隐藏）
	im: { status: "unknown", bots: [], outbox: null },
	// 审批中心：三态 + 跨会话待办；auto = 10 秒轮询开关（默认开，切走模块就停）
	approvals: { status: "unknown", items: [], total: 0, auto: true, loading: false, tick: 0, timer: null, notice: null },
	// 监控（P9）：summary 与调用链各自三态——traces 403 时 KPI 还要照常显示
	monitor: {
		status: "unknown",
		range: "24h",
		summary: null,
		tracesStatus: "unknown",
		traces: [],
		total: 0,
		loading: false,
		detail: null,
	},
	// 设置页的语义检索状态（GET /api/kb/embedding）；单独存，知识库页那份只属于知识库
	embedding: null,
	kbDialog: null,
	flowDraft: null,
	flowReadonly: false,
	flowDirty: false,
	// 斜杠命令面板（输入框里敲 / 弹出的那个）：open + 当前高亮的项下标；
	// query 是 / 后面已经输入的过滤词，只匹配命令名与拼音首词，不匹配整句话
	slash: { open: false, index: 0, query: "" },
};

// markdown 渲染搬到了 web/markdown.js（经典脚本，先于本文件加载；node 侧由 scripts/ui-check.mjs 单测）
/* ---------------- 登录 / 身份（P3 契约） ---------------- */

const AUTH_TOKEN_KEY = "biz.token";
const ROLE_LABELS = { owner: "所有者", developer: "开发者", operator: "运营", auditor: "审计员" };
// 审计页一次拉多少条：后端 limit 上限 200，50 条既够看一屏也不至于一次拖太多
const AUDIT_PAGE_SIZE = 50;
// 详情摘要最多这么多字：审计列表是"扫一眼"用的，完整内容挂在 title 上
const AUDIT_DETAIL_MAX = 60;
// 筛选框防抖：每敲一个字就查一次会把后端打满，停手 300ms 再发
const AUDIT_DEBOUNCE_MS = 300;

// 监控页（P9）：范围选项与调用链分页。默认 24h 是日常排障最常用的窗口。
const MONITOR_RANGES = ["1h", "24h", "7d"];
const MONITOR_TRACE_PAGE_SIZE = 20;
// payload 摘要最多这么多字：列表要能扫，完整 JSON 挂 title
const TRACE_PAYLOAD_MAX = 120;
// traceId / 会话 id 在列表里只露前 8 位，完整值放 title（复制按钮复制完整值）
const TRACE_ID_SHORT = 8;

// 审批中心：10 秒轮询待办；等待超过 60 秒标红（排障时一眼看出卡住的那条）
const APPROVALS_POLL_MS = 10_000;
const APPROVALS_TICK_MS = 1_000;
const APPROVAL_ARGS_MAX = 80;
const APPROVAL_WAIT_WARN_MS = 60_000;
const APPROVAL_DENY_TITLE = "当前角色不能处理审批（需要 session.run）";

// 登录态：token 存 localStorage；启动时问一次 /api/auth/me 决定进控制台还是挡登录页
let authToken = readToken();

function readToken() {
	try {
		return localStorage.getItem(AUTH_TOKEN_KEY) ?? "";
	} catch {
		// 隐私模式下 localStorage 会抛异常：当成没登录，别让整页脚本挂掉
		return "";
	}
}

function saveToken(token) {
	authToken = token ?? "";
	try {
		if (authToken) localStorage.setItem(AUTH_TOKEN_KEY, authToken);
		else localStorage.removeItem(AUTH_TOKEN_KEY);
	} catch {
		// 存不住就只在内存里留一份，刷新后要重新登录
	}
}

/** 所有请求的统一出口：自动带 token；别人的 401 一律当登录过期，回登录页。 */
async function api(url, options = {}) {
	const headers = { ...(options.headers ?? {}) };
	if (authToken) headers.Authorization = `Bearer ${authToken}`;
	const response = await fetch(url, { ...options, headers });
	// /api/auth/* 的 401 由调用方解释（登录失败 / 未登录），别在这里抢着跳转
	if (response.status === 401 && !url.startsWith("/api/auth/")) handleAuthLost();
	return response;
}

/** 拿不到就返回 null：调用方按"没数据"降级，不弹错误弹窗。 */
async function fetchJsonOrNull(url, options) {
	try {
		const response = await api(url, options);
		if (!response.ok) return null;
		return await response.json();
	} catch {
		return null;
	}
}

function roleLabel(role) {
	return ROLE_LABELS[role] ?? (role ? String(role) : "");
}

/** /api/auth/me：200 拿身份；401 = 要登录；404 / 连不上 = 后端没上登录，照老样子进控制台。 */
async function loadMe() {
	let response;
	try {
		response = await api("/api/auth/me");
	} catch {
		return null;
	}
	if (response.status === 401) return { required: true };
	if (!response.ok) return null;
	const data = await response.json().catch(() => null);
	return data?.user ? data : null;
}

function applyIdentity(me) {
	state.me = me;
	state.permissions = Array.isArray(me?.permissions) ? me.permissions : [];
	renderIdentity();
}

/** 免登录模式（AUTH_MODE=off）后端给的是内置 owner 伪用户，退出登录没意义。 */
function canLogout() {
	if (!state.me) return false;
	// mode 是后端 /api/auth/me 的现役字段；authMode / builtin 是契约里可能出现的别名，一起认
	if (state.me.mode === "off" || state.me.authMode === "off") return false;
	if (state.me.builtin === true || state.me.user?.builtin === true) return false;
	return true;
}

/** 前端只做提示：真拦截在后端。没有权限清单（后端没上登录）时不限制。 */
function canWriteWorkflow() {
	if (!Array.isArray(state.permissions) || state.permissions.length === 0) return true;
	// 后端现役是点号（workflow.write），任务书契约写的是冒号（workflow:write）：两种写法都认
	return state.permissions.includes("workflow.write") || state.permissions.includes("workflow:write");
}

function renderIdentity() {
	const user = state.me?.user ?? null;
	els.railAvatar.textContent = user?.name ? Array.from(String(user.name))[0] : "LE";
	els.railAvatar.title = user ? [user.name, user.email].filter(Boolean).join(" · ") : "当前用户";
	const label = roleLabel(user?.role);
	els.railRole.textContent = label;
	els.railRole.hidden = !label;
	els.railRole.title = label ? `当前角色：${label}` : "";
}

function setLoginError(message) {
	els.loginError.textContent = message ?? "";
	els.loginError.hidden = !message;
}

function setLoginBusy(busy) {
	state.loginBusy = Boolean(busy);
	els.loginSubmit.disabled = Boolean(busy);
	els.loginSubmit.textContent = busy ? "登录中…" : "登录";
}

function showLogin(message) {
	state.loginVisible = true;
	// 挡住整个控制台：样式挂在 body.auth-required 上，DOM 状态也方便断言
	document.body.classList.add("auth-required");
	els.loginGate.hidden = false;
	setLoginError(message ?? "");
	setLoginBusy(false);
	// 退出 / 过期后不该还留着上一个身份的会话
	state.sessions = [];
	state.currentId = null;
	state.currentView = null;
	els.loginEmail.focus?.();
}

function hideLogin() {
	state.loginVisible = false;
	document.body.classList.remove("auth-required");
	els.loginGate.hidden = true;
	setLoginError("");
}

/** token 失效（别的接口回 401）：清本地 token，回登录页并说明原因。 */
function handleAuthLost() {
	saveToken("");
	state.me = null;
	state.permissions = [];
	renderIdentity();
	showLogin("登录已过期，请重新登录");
}

async function submitLogin(event) {
	event?.preventDefault?.();
	if (state.loginBusy) return;
	const email = String(els.loginEmail.value ?? "").trim();
	const password = String(els.loginPassword.value ?? "");
	if (!email || !password) {
		setLoginError("邮箱和密码都填一下");
		return;
	}
	setLoginBusy(true);
	let response;
	try {
		response = await api("/api/auth/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email, password }),
		});
	} catch {
		setLoginBusy(false);
		setLoginError("连不上服务，检查一下网络或后端是否在跑");
		return;
	}
	if (response.status === 401) {
		setLoginBusy(false);
		setLoginError("邮箱或密码不对");
		return;
	}
	if (response.status === 429) {
		setLoginBusy(false);
		setLoginError("尝试太频繁，稍后再试");
		return;
	}
	const data = response.ok ? await response.json().catch(() => null) : null;
	const token = data?.token ?? "";
	if (!token) {
		setLoginBusy(false);
		setLoginError(response.ok ? "服务端没有返回 token" : `登录失败（HTTP ${response.status}）`);
		return;
	}
	saveToken(token);
	setLoginBusy(false);
	hideLogin();
	els.loginPassword.value = "";
	applyIdentity(data.user ? data : null);
	await init();
}

function logout() {
	saveToken("");
	closeMenu();
	// 审批页的轮询属于上一个身份：退出时一并停掉
	stopApprovalsPolling();
	// 断开上一个身份的 SSE，别让旧会话继续往界面上推消息
	if (state.es) {
		try {
			state.es.close();
		} catch {
			// 已经断开就算了
		}
		state.es = null;
	}
	state.me = null;
	state.permissions = [];
	state.currentId = null;
	state.currentView = null;
	state.sessions = [];
	renderIdentity();
	showLogin();
}

/** 启动：先问"我是谁"再决定挡不挡登录页。 */
async function bootstrap() {
	hideLogin();
	const me = await loadMe();
	if (me?.required) {
		showLogin();
		return;
	}
	applyIdentity(me);
	await init();
}

/* ---------------- 基础 ---------------- */

function make(tag, className, text) {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

/** 离底部超过这么远就认为用户在翻历史：不抢滚动，并露出「回到底部」。 */
const BOTTOM_GAP = 240;

function scrollToBottom(force = false) {
	const gap = els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight;
	// 流式输出时用户常常正在往上翻，只有自己发消息、打开会话才强行拽到底
	if (!force && gap > BOTTOM_GAP) return;
	els.messages.scrollTop = els.messages.scrollHeight;
}

function clearEmpty() {
	if (els.empty && els.empty.parentNode) els.empty.remove();
}

function sessionTitle(session) {
	// 自定义标题优先；服务端已做过空白折叠与截断，这里只负责回退到派生标题
	if (typeof session.title === "string" && session.title.length > 0) return session.title;
	const first = session.transcript?.find((turn) => turn.role === "user");
	if (first && first.text) {
		return first.text.length > 24 ? `${first.text.slice(0, 24)}…` : first.text;
	}
	return session.workflowName ?? `会话 #${session.id}`;
}

/* ---------------- 会话重命名 ---------------- */

// 与 server/session.ts 的 TITLE_MAX_LENGTH 保持一致：前端只做输入长度限制，规范化交给服务端
const TITLE_MAX_LENGTH = 80;

function currentSession() {
	if (state.currentView?.id === state.currentId) return state.currentView;
	return state.sessions.find((session) => session.id === state.currentId) ?? null;
}

function renderHeaderTitle() {
	// 归档标记跟着当前会话走，别被"正在改名"挡掉
	renderHeaderArchiveState();
	// 输入框接管中栏标题时，别用旧标题覆盖用户正在敲的字
	if (state.titleEditor) return;
	const session = currentSession();
	els.title.textContent = session ? sessionTitle(session) : "新会话";
}

function applySessionTitle(sessionId, title) {
	for (const session of state.sessions) {
		if (session.id === sessionId) session.title = title;
	}
	if (state.currentView?.id === sessionId) state.currentView.title = title;
}

// 行内标题输入框：Enter/失焦提交，Esc 取消；DOM 位置由调用方决定
function makeTitleInput(initial, finish) {
	const input = make("input", "inline-title");
	input.type = "text";
	input.maxLength = TITLE_MAX_LENGTH;
	input.value = initial;
	input.spellcheck = false;
	input.setAttribute("aria-label", "会话标题");

	let done = false;
	const settle = (save) => {
		if (done) return;
		done = true;
		const value = input.value;
		if (input.parentNode) input.parentNode.removeChild(input);
		finish(save, value);
	};

	input.addEventListener("keydown", (event) => {
		if (event.key === "Enter") {
			event.preventDefault();
			event.stopPropagation();
			settle(true);
		} else if (event.key === "Escape") {
			// 别冒泡到全局 Esc 监听，否则会顺手关掉抽屉
			event.preventDefault();
			event.stopPropagation();
			settle(false);
		}
	});
	input.addEventListener("blur", () => settle(true));
	// 输入框嵌在会话项里，点击/右键都不该触发"打开会话"或弹出会话菜单
	input.addEventListener("pointerdown", (event) => event.stopPropagation());
	input.addEventListener("click", (event) => event.stopPropagation());
	input.addEventListener("contextmenu", (event) => event.stopPropagation());
	return input;
}

// 就地重命名：把锚点文本换成行内输入框（中栏头部标题、侧栏会话项共用）
function startInlineTitleEdit(session, anchor) {
	if (state.titleEditor || !session || !anchor) return;
	closeMenu();
	state.titleEditor = makeTitleInput(sessionTitle(session), (save, value) => {
		state.titleEditor = null;
		anchor.hidden = false;
		if (!save || value.trim() === sessionTitle(session).trim()) {
			// 取消或没改动就不打接口：避免把派生标题固化成自定义标题
			renderHeaderTitle();
			renderSidebar();
			return;
		}
		void commitSessionTitle(session.id, value);
	});
	anchor.hidden = true;
	anchor.after(state.titleEditor);
	state.titleEditor.focus();
	state.titleEditor.select();
}

async function commitSessionTitle(sessionId, rawTitle) {
	const title = String(rawTitle ?? "").trim().slice(0, TITLE_MAX_LENGTH);
	try {
		const response = await api(`/api/sessions/${encodeURIComponent(sessionId)}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title }),
		});
		if (response.ok) {
			const data = await response.json();
			// 服务端回的是规范化后的标题；null = 已清除自定义标题，前端回退到派生标题
			applySessionTitle(sessionId, typeof data.title === "string" && data.title.length > 0 ? data.title : null);
		} else if (response.status === 404) {
			addNotice("重命名失败：会话已不存在，请刷新会话列表。", true);
		} else {
			addNotice(`重命名失败（HTTP ${response.status}），请稍后重试。`, true);
		}
	} catch {
		addNotice("重命名失败：无法连接服务，请稍后重试。", true);
	}
	renderHeaderTitle();
	renderSidebar();
}

/* ---------------- 会话归档 ---------------- */

// 归档只是"从主列表收起来"，语义由服务端持有；前端只负责把状态镜像到视图
function renderHeaderArchiveState() {
	const archived = Boolean(currentSession()?.archived);
	els.archivedBadge.hidden = !archived;
	els.unarchiveBtn.hidden = !archived;
}

function applySessionArchived(sessionId, archived) {
	for (const session of state.sessions) {
		if (session.id === sessionId) session.archived = archived;
	}
	if (state.currentView?.id === sessionId) state.currentView.archived = archived;
}

async function setSessionArchived(sessionId, archived) {
	const action = archived ? "归档" : "取消归档";
	try {
		const response = await api(`/api/sessions/${encodeURIComponent(sessionId)}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ archived }),
		});
		const data = await response.json().catch(() => ({}));
		if (!response.ok) {
			addNotice(data.error ?? `${action}失败（HTTP ${response.status}），请稍后重试。`, true);
			return;
		}
		// 服务端回的是"当前值"，以它为准（例如归档后再点取消归档）
		applySessionArchived(sessionId, typeof data.archived === "boolean" ? data.archived : archived);
		// 刚归档的会话会从主列表消失，顺手展开归档区，让用户看到它去哪了
		if (archived) state.archivedOpen = true;
		renderHeaderTitle();
		renderSidebar();
	} catch {
		addNotice(`${action}失败：无法连接服务，请稍后重试。`, true);
	}
}

function toggleArchivedFold() {
	state.archivedOpen = !state.archivedOpen;
	renderSidebar();
}

/* ---------------- 技能（把一个技能装进当前会话） ---------------- */

/** 从视图里还原「当前技能」的 id 与名字：chip 文案要用名字，不是 id。 */
function activeSkillOf(view) {
	const id = view?.activeSkillId ?? null;
	if (!id) return null;
	const found = (view.skills ?? []).find((skill) => skill.id === id);
	return { id, name: found?.name ?? id };
}

/** 页头的技能胶囊只是状态显示：不做入口，加载/退出都在「技能」模块页或由模型触发。 */
function renderSkillChip() {
	const active = state.activeSkill;
	els.skillChipLabel.textContent = active ? `技能：${active.name}` : "技能：无";
	els.skillChip.classList.toggle("on", Boolean(active));
	els.skillChip.title = active ? `当前技能：${active.name}` : "未加载技能";
	// 技能状态的观测点一起刷：隐藏的旧右栏 DOM（保留接线）与页头胶囊（一个入口，别各刷各的）
	renderSkillList();
	renderSkillCurrent();
}

/** 步骤数的口语化说法：0 步 = 不预设步骤（自动编排那种技能）。 */
function skillStepsHint(skill) {
	return skill.steps > 0 ? `${skill.steps} 步` : "不预设步骤";
}

/** 用 POST 返回值把会话视图、步骤条、侧栏进度一次对齐。 */
function applySkillPayload(sessionId, data) {
	const view = state.currentView;
	if (view && view.id === sessionId) {
		view.activeSkillId = data.activeSkillId ?? null;
		if (Array.isArray(data.skills)) view.skills = data.skills;
		if (Array.isArray(data.tools)) view.tools = data.tools;
		if (Array.isArray(data.steps)) {
			view.steps = data.steps;
			view.current = data.current ?? 0;
			view.done = Boolean(data.done);
			// 换技能 = 换步骤：步骤条与抽屉都按新步骤重画
			renderStepbar(view.steps);
			renderSteps(view.steps);
		}
	}
	// 侧栏/抽屉读的是列表里的会话对象，技能与进度文案都要跟着变
	const mine = state.sessions.find((session) => session.id === sessionId);
	if (mine) {
		mine.activeSkillId = data.activeSkillId ?? null;
		if (Array.isArray(data.skills)) mine.skills = data.skills;
		if (Array.isArray(data.steps)) {
			mine.steps = data.steps;
			mine.current = data.current ?? 0;
			mine.done = Boolean(data.done);
		}
	}
	state.activeSkill = activeSkillOf(view);
	renderSkillChip();
	renderSidebar();
}

/** 加载技能（skillId 是字符串）或退出（null）。失败要说人话，别静默。 */
async function setSkill(skillId) {
	const session = currentSession();
	if (!session) return;

	let response;
	let data;
	try {
		response = await api(`/api/sessions/${session.id}/skills`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ skillId }),
		});
		data = await response.json().catch(() => null);
	} catch {
		addNotice("切换技能失败：请求没发出去。", true);
		return;
	}
	if (!response.ok) {
		addNotice(data?.error ? `切换技能失败：${data.error}` : "切换技能失败。", true);
		return;
	}
	applySkillPayload(session.id, data ?? {});
	if (state.module === "skills") renderModuleView();
	// 成功提示交给紧随其后的 SSE skill 事件播报：同一个动作只弹一条，别这里也报一次
}

/**
 * 模型自己调 use_skill 时也会推这条事件（前端不发起请求，只跟状态）。
 * 紧跟其后还有一条 workflow 事件负责重画步骤条，这里只管技能状态与 chip。
 */
function applySkillEvent(event) {
	const view = state.currentView;
	if (view) {
		view.activeSkillId = event.skillId ?? null;
		if (Array.isArray(view.skills)) {
			view.skills = view.skills.map((skill) => ({ ...skill, active: skill.id === event.skillId }));
		}
	}
	const mine = state.sessions.find((session) => session.id === state.currentId);
	if (mine) {
		mine.activeSkillId = event.skillId ?? null;
		if (view && Array.isArray(view.skills)) mine.skills = view.skills;
	}
	state.activeSkill = event.skillId ? { id: event.skillId, name: event.name || event.skillId } : null;
	renderSkillChip();
	// 左栏会话行要立刻挂上（或摘掉）技能徽标
	renderSidebar();
	if (state.module === "skills") renderModuleView();
	const text = event.skillId
		? `已加载技能「${event.name}」${event.description ? `：${event.description}` : ""}`
		: "已退出技能，回到默认模式（模型按你的话自己挑工具）。";
	addNotice(text, false);
}

/* ---------------- 技能行渲染（技能 = 一套说明 + 一组工具 + 它自己的步骤）
   右侧常驻栏已从对话页撤掉：这套行现在只服务「技能」模块页（隐藏 DOM 仅保留接线与回滚）。 ---------------- */

/**
 * 「自动编排」是默认聊天模式：它没有固定步骤、工具是整个目录，模型本来就会按你的话自己挑。
 * 放进技能列表只会让人以为"要手动选它"，点了等于什么都没换，所以列表里过滤掉。
 * 但当前技能真是它时，右上角的「当前技能」块照常显示名字。
 */
const SKILL_LIST_HIDDEN = new Set(["auto-flow"]);

/** 拉技能目录。技能就是流程的投影，所以这里没有第二套数据。 */
async function refreshSkillCatalog() {
	const previousIds = state.skillCatalog.map((skill) => skill.id).join("\0");
	try {
		const response = await api("/api/skills");
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		state.skillCatalog = await response.json();
	} catch {
		// 拉不到不该卡住整页：右栏给占位，页头胶囊仍能按会话视图工作
		state.skillCatalog = [];
	}
	const nextIds = state.skillCatalog.map((skill) => skill.id).join("\0");
	if (previousIds !== nextIds) {
		state.skillQuery = "";
		state.skillFilter = "all";
	}
	renderSkillList();
	renderSkillCurrent();
	if (state.module === "skills") renderModuleView();
}

/** 面板里能看到的技能：自动编排是默认聊天模式，点它等于什么都没换（见 SKILL_LIST_HIDDEN）。 */
function visibleSkills() {
	return (state.skillCatalog ?? []).filter((skill) => !SKILL_LIST_HIDDEN.has(skill.id));
}

/**
 * 一行技能：名字 + 内置角标 + 一句话说明 + ⋯。
 * 「技能」模块页（以及已隐藏的旧右栏）共用这一份，避免两套渲染走样。
 */
function skillRowNode(skill, activeId) {
	const row = make("div", "skill-row");
	row.dataset.skillId = skill.id;
	row.setAttribute("role", "button");
	row.tabIndex = 0;
	row.title = skill.description ? `${skill.name} · ${skill.description}` : skill.name;
	const active = skill.id === activeId;
	row.classList.toggle("active", active);

	const head = make("div", "skill-row-head");
	head.appendChild(make("span", "skill-row-name", skill.name));
	if (skill.builtin) head.appendChild(make("span", "flow-tag", "内置"));
	if (active) head.appendChild(make("span", "flow-tag on", "使用中"));

	// 「⋯」给查看/编辑/删除；内置技能只能查看
	const more = make("button", "more");
	more.title = "技能操作";
	more.innerHTML =
		'<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>';
	more.addEventListener("click", (event) => {
		// 只开菜单，别外溢成"点行加载技能"
		event.stopPropagation();
		openMenu(more, skillRowMenuItems(skill));
	});
	head.appendChild(more);
	row.appendChild(head);

	if (skill.description) row.appendChild(make("div", "skill-row-desc", skill.description));

	row.addEventListener("click", () => void loadSkillFromRow(skill));
	row.addEventListener("keydown", (event) => {
		if (event.key !== "Enter" && event.key !== " ") return;
		event.preventDefault();
		void loadSkillFromRow(skill);
	});
	return row;
}

/** 一行一条技能：名字 + 内置角标 + 一句话说明，点行 = 装进当前会话。 */
function renderSkillList() {
	if (!els.skillList) return;
	els.skillList.innerHTML = "";
	const skills = visibleSkills();
	if (skills.length === 0) {
		els.skillList.appendChild(make("div", "placeholder", "还没有技能，点上面的 ＋ 新建一个"));
		return;
	}
	const activeId = state.currentView?.activeSkillId ?? null;
	for (const skill of skills) els.skillList.appendChild(skillRowNode(skill, activeId));
}

/** 点技能行 = 装进当前会话；已经是当前技能就什么都不做（幂等，别重复发请求/弹提示）。 */
async function loadSkillFromRow(skill) {
	const session = currentSession();
	if (!session) {
		addNotice("先新建聊天或打开一个会话，再加载技能。", true);
		return;
	}
	if (session.activeSkillId === skill.id) return;
	await setSkill(skill.id);
}

/** 技能行菜单：内置只有查看；自定义可编辑、可删（删的是整条技能定义）。 */
function skillRowMenuItems(skill) {
	const items = [{ title: skill.name }];
	const target = { id: skill.id, name: skill.name, builtin: skill.builtin };
	items.push({
		label: "查看技能",
		hint: skill.id === (state.currentView?.activeSkillId ?? null) ? "正在使用" : `${skill.steps} 步`,
		onClick: () => void openFlowEditor(target, { readonly: true, title: "查看技能" }),
	});
	// 技能可以先在知识库里检索，再按说明干活（P5）；没接后端时点它会给出提示
	items.push({ label: "绑定知识库", hint: "让技能先在这几个库里检索", onClick: () => void openSkillKbDialog(skill) });
	if (!skill.builtin) {
		items.push({
			label: "编辑技能",
			hint: "改说明、正文与步骤",
			onClick: () => void openFlowEditor(target, { title: "编辑技能", focusSkill: true }),
		});
		items.push({ separator: true });
		items.push({ label: "删除技能", hint: "说明与步骤一起删", onClick: () => void deleteFlow(target) });
	}
	return items;
}

/** 旧的右栏「当前技能」块（视觉已隐藏）：继续刷新状态，退出入口已挪到「技能」模块页。 */
function renderSkillCurrent() {
	if (!els.skillCurrentName) return;
	const skill = state.activeSkill;
	const steps = state.currentView?.steps?.length ?? 0;
	els.skillCurrentName.textContent = skill ? skill.name : "未加载技能";
	els.skillCurrentName.classList.toggle("on", Boolean(skill));
	els.skillCurrentMeta.textContent = skill
		? steps > 0
			? `当前技能 · ${steps} 步`
			: "当前技能 · 不预设步骤"
		: "模型会按你的话自己挑；也可以在这里点一条装进来";
	// 没有技能 / 没有会话时按钮没有意义，直接藏起来
	els.skillCurrentExit.hidden = !skill || !currentSession();
}

/* ---------------- 浮动菜单 ---------------- */

function closeMenu() {
	els.menu.hidden = true;
	els.menu.innerHTML = "";
	state.menuAnchor = null;
}

function openMenu(anchor, items) {
	// 再次点击同一个触发按钮 = 收起菜单
	if (state.menuAnchor === anchor && !els.menu.hidden) {
		closeMenu();
		return;
	}

	els.menu.innerHTML = "";
	for (const item of items) {
		if (item.separator) {
			els.menu.appendChild(make("div", "menu-sep"));
			continue;
		}
		if (item.title) {
			els.menu.appendChild(make("div", "menu-title", item.title));
			continue;
		}
		const button = make("button", "menu-item");
		if (item.checked) {
			const check = document.createElementNS("http://www.w3.org/2000/svg", "svg");
			check.setAttribute("viewBox", "0 0 24 24");
			check.setAttribute("fill", "none");
			check.setAttribute("stroke", "currentColor");
			check.setAttribute("stroke-width", "2.2");
			check.setAttribute("stroke-linecap", "round");
			check.setAttribute("class", "menu-check");
			check.innerHTML = '<path d="m5 13 4 4L19 7"/>';
			button.appendChild(check);
		}
		button.appendChild(make("span", "menu-label", item.label));
		if (item.hint) button.appendChild(make("span", "menu-hint", item.hint));
		button.addEventListener("click", () => {
			closeMenu();
			item.onClick();
		});
		els.menu.appendChild(button);
	}

	state.menuAnchor = anchor;
	els.menu.hidden = false;
	const rect = anchor.getBoundingClientRect();
	const width = els.menu.offsetWidth;
	const height = els.menu.offsetHeight;
	let left = rect.left;
	if (left + width > window.innerWidth - 8) left = window.innerWidth - width - 8;
	let top = rect.bottom + 6;
	if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 6);
	els.menu.style.left = `${Math.max(8, left)}px`;
	els.menu.style.top = `${top}px`;
}

/* ---------------- 侧边栏 ---------------- */

/**
 * 新建聊天 = 直接给一个「自动编排」会话，不先让人选技能。
 * 发消息后由模型自己判断要不要加载某个技能；想显式加载就去「技能」页点一条。
 */
async function newChat() {
	await createSession("auto-flow");
}

/** 会话行上的技能徽标文案；没加载技能返回 null（不渲染徽标）。 */
function sessionSkillName(session) {
	const id = session?.activeSkillId;
	if (!id) return null;
	const found = (session.skills ?? []).find((skill) => skill.id === id);
	// 目录里找不到就退回 id：宁可难看，也不要因为少个名字就静默不标
	return found?.name ?? id;
}

function matchesSearch(session) {
	if (!state.searchQuery) return true;
	return sessionTitle(session).toLowerCase().includes(state.searchQuery.toLowerCase());
}

function togglePin(sessionId) {
	if (state.pinned.has(sessionId)) state.pinned.delete(sessionId);
	else state.pinned.add(sessionId);
	localStorage.setItem(PIN_KEY, JSON.stringify([...state.pinned]));
	renderSidebar();
}

function sessionMenuItems(session, wrap) {
	const pinned = state.pinned.has(session.id);
	const caption = sessionTitle(session);
	const items = [
		// 菜单标题用截断后的标题，避免 80 字标题把浮窗撑成一张纸
		{ title: caption.length > 20 ? `${caption.slice(0, 20)}…` : caption },
		{ label: "重命名", hint: "就地编辑", onClick: () => startInlineTitleEdit(session, wrap.querySelector(".label")) },
	];
	if (typeof session.title === "string" && session.title.length > 0) {
		items.push({
			label: "清除自定义标题",
			hint: "恢复自动派生",
			onClick: () => void commitSessionTitle(session.id, ""),
		});
	}
	items.push({ separator: true });
	// 已归档会话不在置顶区显示，置顶对它没有意义，索性不给入口
	if (!session.archived) {
		items.push({ label: pinned ? "取消置顶" : "置顶", checked: pinned, onClick: () => togglePin(session.id) });
	}
	items.push({ separator: true });
	items.push(
		session.archived
			? { label: "取消归档", hint: "回到主列表", onClick: () => void setSessionArchived(session.id, false) }
			: { label: "归档", hint: "从主列表收起", onClick: () => void setSessionArchived(session.id, true) },
	);
	return items;
}

function sessionItem(session) {
	const wrap = make("div", "item");
	if (session.archived) wrap.classList.add("archived");
	wrap.dataset.sessionId = session.id;
	wrap.setAttribute("role", "button");
	wrap.tabIndex = 0;
	const skillName = sessionSkillName(session);
	// 标题可能被省略号截断，悬停看全文；技能也写进 title，窄栏截断时还能看到全名
	const skillHint = skillName ? ` · 技能：${skillName}` : "";
	wrap.title = `${sessionTitle(session)}${skillHint}（右键可重命名）`;

	wrap.appendChild(make("span", "dot"));
	wrap.appendChild(make("span", "label", sessionTitle(session)));
	// 加载了技能才出徽标：这是"这条会话在按哪份作业指导书跑"的唯一线索
	if (skillName) {
		const tag = make("span", "skill-tag", skillName);
		tag.title = `当前技能：${skillName}`;
		wrap.appendChild(tag);
	}

	const pin = make("button", "icon-btn");
	pin.title = state.pinned.has(session.id) ? "取消置顶" : "置顶";
	pin.style.marginLeft = "auto";
	pin.style.width = "20px";
	pin.style.height = "20px";
	pin.innerHTML =
		'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" style="width:13px;height:13px"><path d="M12 17v5"/><path d="M9 10.8V4.5"/><path d="M15 10.8V4.5"/><path d="M12 3v4"/><path d="M8 10.8h8v4a4 4 0 0 1-8 0z"/></svg>';
	pin.addEventListener("click", (event) => {
		event.stopPropagation();
		togglePin(session.id);
	});
	// 归档项不显示置顶按钮：置顶区排除了归档会话，留着按钮只会让人以为点了没反应
	if (!session.archived) wrap.appendChild(pin);

	// 重命名入口：悬停时才露出，右键菜单也有同样的入口
	const rename = make("button", "icon-btn rename-btn");
	rename.title = "重命名会话";
	rename.innerHTML =
		'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4l9.5-9.5a2.1 2.1 0 0 0-3-3L5 17z"/><path d="M14 5.5 18.5 10"/></svg>';
	if (session.archived) rename.style.marginLeft = "auto";
	rename.addEventListener("click", (event) => {
		event.stopPropagation();
		startInlineTitleEdit(session, wrap.querySelector(".label"));
	});
	wrap.appendChild(rename);

	if (session.id === state.currentId) wrap.classList.add("active");
	wrap.addEventListener("click", () => void openSession(session.id));
	wrap.addEventListener("contextmenu", (event) => {
		event.preventDefault();
		openMenu(wrap, sessionMenuItems(session, wrap));
	});
	return wrap;
}

function renderSidebar() {
	els.pinnedList.innerHTML = "";
	// 置顶区不显示已归档会话：归档的语义就是"从主列表收起来"
	const pinned = state.sessions.filter(
		(session) => state.pinned.has(session.id) && !session.archived && matchesSearch(session),
	);
	if (pinned.length === 0) {
		els.pinnedList.appendChild(
			make("div", "placeholder", state.searchQuery ? "没有匹配的置顶会话" : "把常看的会话置顶到这里"),
		);
	} else {
		for (const session of pinned) els.pinnedList.appendChild(sessionItem(session));
	}

	// 会话区：平铺，置顶的已经在上面出现过，这里不再重复；最近改过的排前面
	els.sessionList.innerHTML = "";
	const rest = state.sessions
		.filter((session) => !session.archived && !state.pinned.has(session.id) && matchesSearch(session))
		.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
	if (rest.length === 0) {
		els.sessionList.appendChild(
			make(
				"div",
				"placeholder",
				state.searchQuery
					? "没有匹配的会话"
					: state.sessions.length === 0
						? "还没有会话，点上面的新聊天开始"
						: "会话都置顶了",
			),
		);
	} else {
		for (const session of rest) els.sessionList.appendChild(sessionItem(session));
	}

	// 已归档：有内容才出现；默认收起，搜索时自动展开，好让命中的归档会话看得见
	const archived = state.sessions.filter((session) => session.archived && matchesSearch(session));
	els.archivedGroup.hidden = archived.length === 0;
	els.archivedCount.textContent = String(archived.length);
	const archivedOpen = archived.length > 0 && (state.archivedOpen || state.searchQuery !== "");
	els.archivedToggle.setAttribute("aria-expanded", archivedOpen ? "true" : "false");
	els.archivedList.hidden = !archivedOpen;
	els.archivedList.innerHTML = "";
	if (!archivedOpen) return;
	for (const session of archived) els.archivedList.appendChild(sessionItem(session));
}

/* ---------------- 模块导航：左侧图标栏 = 模块入口 ---------------- */

/**
 * 模块清单：数组顺序就是图标栏顺序。
 * 有真接口的（对话/技能/模型/设置）直接读接口；没有的给「未接入」+ 需要哪些接口，
 * 绝不摆假数据——用户会把假表格当成能用的功能。
 */
const MODULES = [
	{ id: "chat", label: "对话", icon: '<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.3-.6L3 21l1.7-4.6A8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4z" />' },
	{
		id: "knowledge",
		label: "知识库",
		icon: '<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H19v16H5.5A1.5 1.5 0 0 1 4 18.5z" /><path d="M8 4v16" />',
	},
	{ id: "skills", label: "技能", icon: '<path d="M12 3.2 14 9l5.8 2-5.8 2-2 5.8-2-5.8L4.2 11 10 9z" />' },
	{ id: "plugins", label: "插件", icon: '<path d="M9 4.5a2.5 2.5 0 1 1 5 0V7h2.5A1.5 1.5 0 0 1 18 8.5V11h2.5a2.5 2.5 0 1 1 0 5H18v2.5a1.5 1.5 0 0 1-1.5 1.5H14v-2.5a2.5 2.5 0 1 0-5 0V20H6.5A1.5 1.5 0 0 1 5 18.5V16H2.5a2.5 2.5 0 1 1 0-5H5V8.5A1.5 1.5 0 0 1 6.5 7H9z" />' },
	{
		id: "models",
		label: "模型",
		icon: '<rect x="7" y="7" width="10" height="10" rx="2" /><path d="M10 3v2M14 3v2M10 19v2M14 19v2M3 10h2M3 14h2M19 10h2M19 14h2" />',
	},
	{
		id: "mcp",
		label: "MCP",
		icon: '<path d="M9 3v4M15 3v4" /><path d="M7 7h10v4a5 5 0 0 1-10 0z" /><path d="M12 16v5" />',
	},
	{
		id: "im",
		label: "IM 机器人",
		icon: '<rect x="4" y="7" width="16" height="12" rx="3" /><path d="M12 3v4" /><circle cx="9.5" cy="13" r="1" /><circle cx="14.5" cy="13" r="1" />',
	},
	{
		id: "approvals",
		label: "审批",
		icon: '<path d="M12 3.5 19 6v6c0 4-3 6.6-7 8-4-1.4-7-4-7-8V6z" /><path d="m9 12 2 2 4-4" />',
	},
	{
		id: "audit",
		label: "审计",
		icon: '<rect x="3.5" y="4.5" width="5" height="15" rx="1.2" /><rect x="10.5" y="4.5" width="5" height="10" rx="1.2" /><rect x="17.5" y="4.5" width="3" height="6" rx="1.2" />',
	},
	{
		id: "members",
		label: "成员",
		icon: '<circle cx="9" cy="8.5" r="3.5" /><path d="M3 20c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5" /><path d="M16 5.5a3.5 3.5 0 0 1 0 7M18 20c0-2.4-.8-4.1-2-5" />',
	},
	{
		id: "monitor",
		label: "监控",
		icon: '<path d="M3 12h4l2.5-6 3.5 12 2.5-6H21" />',
	},
	{
		id: "settings",
		label: "设置",
		icon: '<circle cx="12" cy="12" r="3.2" /><path d="M12 3v2.4M12 18.6V21M4.9 4.9l1.7 1.7M17.4 17.4l1.7 1.7M3 12h2.4M18.6 12H21M4.9 19.1l1.7-1.7M17.4 6.6l1.7-1.7" />',
	},
];

const MODULE_IDS = new Set(MODULES.map((module) => module.id));


/**
 * 模块页的兜底规格：真接口没接上（404 / 连不上）时，用这里的说明 + 「未接入」徽标 + 接口清单。
 * apis 里每项 = [方法, 路径, 干什么]，界面上排成一行 `<code>`。
 */
const MODULE_SPECS = {
	knowledge: {
		title: "知识库",
		summary: "上传 PDF / Word / MD / TXT / CSV，解析分块、向量化后供技能检索；技能可以绑定某个知识库。",
		apis: [
			["POST", "/api/kb", "新建知识库"],
			["POST", "/api/kb/:id/documents", "上传文档并解析分块"],
			["POST", "/api/kb/:id/search", "向量检索（pgvector）"],
			["POST", "/api/kb/:id/reindex", "补 key 后整库重算向量"],
		],
		next: "前端已就绪：/api/kb 一上线，这一页自动换成知识库列表 + 上传区 + 检索试跑。",
	},
	mcp: {
		title: "MCP",
		summary: "把外部 MCP 服务器的工具接进来，模型在会话里就能直接调用。",
		apis: [
			["POST", "/api/mcp/servers", "注册服务（stdio / SSE / HTTP 三种传输）"],
			["GET", "/api/mcp/servers", "服务发现与连通性状态"],
			["DELETE", "/api/mcp/servers/:id", "移除服务并注销它的工具"],
		],
		next: "接入后每个 MCP 工具都会出现在技能编辑器的工具目录里。",
	},
	im: {
		title: "IM 机器人",
		summary:
			"钉钉机器人：群里 @ 它就能起一个会话，执行结果回推群里。机器人凭证只以密文落库，出参只回掩码。",
		apis: [
			["GET", "/api/im/bots", "机器人列表（凭证只回掩码 + 最近回调 + 会话数）"],
			["POST", "/api/im/bots", "添加机器人（appKey / appSecret / robotCode / callbackToken）"],
			["POST", "/api/im/dingtalk/callback", "钉钉回调（免登录，加签或 AES 加密）"],
			["GET", "/api/im/outbox", "fake 传输下的出站队列（真实传输 404）"],
		],
		next: "接口没连上时回到这里：确认后端在跑；本机用 DINGTALK_TRANSPORT=fake 时才有 outbox。",
	},
	approvals: {
		title: "审批",
		summary:
			"跨会话的待处理审批：高风险工具调用会同步挂起，模型停在原地等人工放行；批准后继续执行，拒绝只让这一次调用失败。",
		apis: [
			["GET", "/api/approvals", "待办审批队列（跨会话，按等待时间升序）"],
			["POST", "/api/approvals/:sessionId", "批准或拒绝某条审批 { requestId, approved }"],
		],
		next: "接口没连上时回到这里：确认后端在跑，并且当前角色能查看会话（看队列）与运行会话（提交决定）。",
	},
	audit: {
		title: "审计",
		current: "现在能看的是单会话的审计流水：对话页右上角「运行详情」抽屉里，跟着当前会话走。",
		summary: "跨会话的全局审计查询与 trace 调用链还没接后端。",
		apis: [["GET", "/api/audit", "按动作关键字 / 操作者筛选审计记录（分页倒序）"]],
		next: "接口没连上时回到这里：确认后端在跑，并且当前角色有查看审计记录的权限。",
	},
	members: {
		title: "成员",
		summary: "多用户与 RBAC 四角色：所有者 / 开发者 / 运营 / 审计员，按角色限制工具与审批权限。",
		apis: [
			["GET", "/api/auth/users", "成员列表与角色（需要 member.manage）"],
			["POST", "/api/auth/users", "新建成员并分配角色"],
		],
		next: "接口没连上时回到这里：确认后端在跑，并且当前角色能管理成员。",
	},
	plugins: {
		title: "插件",
		summary: "管理扩展包。插件清单可包含技能和外部工具；导入前请检查来源及声明内容。",
		apis: [
			["GET", "/api/plugins", "插件列表"],
			["POST", "/api/plugins/import", "导入插件清单 { manifest }"],
			["PATCH", "/api/plugins/:id", "启用或停用 { enabled }"],
			["DELETE", "/api/plugins/:id", "卸载插件"],
		],
		next: "插件清单以 JSON 文件导入；当前页面不会执行清单中的代码。",
	},
	models: {
		title: "模型",
		apis: [
			["POST", "/api/models/providers", "配置供应商（key / base URL / 自定义模型名）"],
			["POST", "/api/models/:id/ping", "连通性检测：发一条极短请求验证 key 可用"],
		],
	},
	settings: {
		title: "设置",
		apis: [["PATCH", "/api/settings", "成员 / 通知 / 备份等写入项（未接入）"]],
	},
	monitor: {
		title: "监控",
		summary:
			"按时间范围看会话、消息、工具调用、技能 / MCP / 模型用量与错误；每条调用链都能展开成事件时间轴，排障时先看 KPI 再看慢在哪一步。",
		apis: [
			["GET", "/api/monitor/summary", "范围聚合：会话 / 消息 / 工具成功率 / 平均与 p95 耗时"],
			["GET", "/api/monitor/traces", "调用链列表（limit / offset 分页）"],
			["GET", "/api/monitor/traces/:id", "单条调用链的事件时间轴"],
		],
		next: "接口没连上时回到这里：确认后端在跑，并且当前角色能查看监控与审计记录。",
	},
};

/** 画图标栏：清空重画，保证 active / aria-current 与 state.module 一致。 */
function renderModuleNav() {
	if (!els.railNav) return;
	els.railNav.innerHTML = "";
	for (const module of MODULES) {
		const button = make("button", "rail-btn");
		button.setAttribute("type", "button");
		button.dataset.module = module.id;
		button.title = module.label;
		button.setAttribute("aria-label", module.label);
		// 图标是代码里的常量 SVG（不是用户数据），和别处图标按钮一致用 innerHTML
		button.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${module.icon}</svg><span class="rail-label">${module.label}</span>`;
		button.classList.toggle("active", module.id === state.module);
		if (module.id === state.module) button.setAttribute("aria-current", "true");
		else button.removeAttribute("aria-current");
		button.addEventListener("click", () => void switchModule(module.id));
		els.railNav.appendChild(button);
	}
}

/** 切模块：先同步把壳切过去（用户立刻看到反应），再补这个模块要的数据。 */
async function switchModule(moduleId) {
	if (!MODULE_IDS.has(moduleId) || moduleId === state.module) return;
	// 审批页的轮询只属于审批页：切走就停，别让定时器在别的模块里继续打接口
	if (state.module === "approvals" && moduleId !== "approvals") stopApprovalsPolling();
	state.module = moduleId;
	renderModuleNav();
	renderModuleView();
	await ensureModuleData(moduleId);
	// 数据回来后再画一遍（还在这个模块才画，别把用户切走后的页面覆盖掉）
	if (state.module === moduleId) {
		renderModuleView();
		if (moduleId === "approvals") startApprovalsPolling();
	}
}

/** 模块页要的数据：只有真接口的模块才发请求，失败就当没有（页面写"未接入"，不假装成功）。 */
async function ensureModuleData(moduleId) {
	if (moduleId === "skills") {
		await refreshSkillCatalog();
		return;
	}
	if (moduleId === "knowledge") {
		// 每次进来重拉：上一次的"已设为对话默认"提示不该跨次留着
		state.kb.notice = null;
		await refreshKb();
		return;
	}
	if (moduleId === "members") {
		// 每次进来重新拉：上一次的"已停用 / 已删除"提示不该跨次留着
		state.members.notice = null;
		await refreshMembers();
		return;
	}
	if (moduleId === "audit") {
		// 每次进来都从第一页重拉：别的会话可能刚写了新审计
		await refreshAudit({ reset: true });
		return;
	}
	if (moduleId === "approvals") {
		// 每次进来都重拉：待办是别的会话同步挂起的，随时可能多一条或少一条；旧提示也不再保留
		state.approvals.notice = null;
		await refreshApprovals();
		return;
	}
	if (moduleId === "models") {
		// 模型页要画供应商/模型/当前模型，单独走一次带状态判断的拉取（403 与 404 要分开）
		state.health = await fetchJsonOrNull("/api/health");
		await refreshModelAdmin();
		return;
	}
	if (moduleId === "mcp") {
		// MCP 页每次进来都重拉：别的标签页可能刚注册/删了服务，状态也可能变了
		await refreshMcp();
		return;
	}
	if (moduleId === "plugins") {
		await refreshPlugins();
		return;
	}
	if (moduleId === "im") {
		// IM 页每次进来都重拉：机器人可能被别处改过，outbox 也可能刚多了几条
		await refreshIm();
		return;
	}
	if (moduleId === "monitor") {
		// 监控页每次进来都重拉：别的会话可能刚产生新的调用链
		await refreshMonitor();
		return;
	}
	if (moduleId !== "settings") return;
	const getJson = (url) => api(url).then((response) => (response.ok ? response.json() : null)).catch(() => null);
	state.health = await getJson("/api/health");
	const models = await getJson("/api/models");
	if (models) state.models = models;
	await refreshEmbeddingStatus();
	await refreshApiKeys();
}

/** 语义检索状态（GET /api/kb/embedding）：设置页与模型页的「向量模型」区块共用一份。 */
async function refreshEmbeddingStatus() {
	try {
		const response = await api("/api/kb/embedding");
		state.embedding = response.ok ? await response.json() : null;
	} catch {
		state.embedding = null;
	}
	if (state.embedding) state.kb.embedding = state.embedding;
}

/** 对话模块 = 三列布局（右侧技能栏已撤）；其它模块整宽显示模块页（靠 .shell.module-view 切列数）。 */
function renderModuleView() {
	const isChat = state.module === "chat";
	els.shell.classList.toggle("module-view", !isChat);
	// 容器也带上模块名：像审计表这种"这一页更宽"的样式才有地方挂（内层 section 之外还有这层）
	els.modulePage.dataset.module = isChat ? "" : state.module;
	if (isChat) {
		// 回到对话：数据一直没动过，按现有状态重画一遍就恢复原样（会话列表 / 技能高亮 / 当前会话）
		renderSidebar();
		renderSkillList();
		renderSkillCurrent();
		els.modulePage.innerHTML = "";
		return;
	}
	els.modulePage.innerHTML = "";
	els.modulePage.appendChild(modulePageNode(state.module));
}

function modulePageNode(moduleId) {
	const spec = MODULE_SPECS[moduleId] ?? { apis: [] };
	// 标题用模块清单里的名字：图标提示与页面标题永远同一个词
	const title = MODULES.find((module) => module.id === moduleId)?.label ?? "模块";
	const page = make("section", "module-page");
	page.dataset.module = moduleId;

	const head = make("div", "module-page__head");
	head.appendChild(make("h2", "module-page__title", title));
	if (moduleId === "skills") {
		const add = make("button", "btn-ghost mini", "＋ 新建技能");
		add.setAttribute("type", "button");
		add.addEventListener("click", () => void openFlowEditor(null, { title: "新建技能", focusSkill: true }));
		// 前端只给提示与置灰：真正的拦截在后端（权限清单里没有 workflow:write 就没这个能力）
		if (!canWriteWorkflow()) {
			add.disabled = true;
			add.title = "当前角色没有新建技能的权限（需要 workflow:write）";
		}
		head.appendChild(add);
	}
	if (moduleId === "members") {
		const add = make("button", "btn-ghost mini", "＋ 新建成员");
		add.setAttribute("type", "button");
		add.addEventListener("click", () => openNewMemberDialog());
		// 前端只给提示与置灰：真正的拦截在后端（403 文案会显示在页面/弹窗里）
		if (!canManageMembers()) {
			add.disabled = true;
			add.title = "当前角色不能管理成员";
		}
		head.appendChild(add);
	}
	if (moduleId === "plugins") {
		const actions = make("div", "module-page__actions");
		const file = make("input", "plugin-import-input");
		file.type = "file";
		file.accept = "application/json,.json";
		file.hidden = true;
		file.setAttribute("aria-label", "选择插件 JSON 清单");
		file.addEventListener("change", () => void importPluginFile(file));
		const add = guardPluginWrite(make("button", "btn-ghost mini plugin-import", "＋ 导入插件"));
		add.setAttribute("type", "button");
		add.addEventListener("click", () => {
			if (!add.disabled) file.click();
		});
		actions.appendChild(file);
		actions.appendChild(add);
		head.appendChild(actions);
	}
	if (moduleId === "mcp" && state.mcp.status !== "forbidden") {
		// 403 是"角色不够"，整页已经在说权限，不摆一个点了也白点的按钮
		const add = make("button", "btn-ghost mini mcp-add", "＋ 注册 MCP 服务");
		add.setAttribute("type", "button");
		guardMcpWrite(add);
		add.addEventListener("click", () => openMcpServerDialog(null));
		head.appendChild(add);
	}
	if (moduleId === "im") {
		// 两个按钮放进同一组：直接塞进 space-between 的页头会被摊开，看着像散落的
		const actions = make("div", "module-page__actions");
		if (state.im.status !== "forbidden") {
			// 403 已经在整页提示权限，不摆一个点了也白点的添加按钮
			const add = make("button", "btn-ghost mini im-add", "＋ 添加机器人");
			add.setAttribute("type", "button");
			guardImWrite(add);
			add.addEventListener("click", () => openImBotDialog(null));
			actions.appendChild(add);
		}
		const refresh = make("button", "btn-ghost mini im-refresh", "刷新");
		refresh.setAttribute("type", "button");
		refresh.addEventListener("click", async () => {
			refresh.disabled = true;
			refresh.textContent = "刷新中…";
			await refreshIm();
			if (state.module === "im") renderModuleView();
		});
		actions.appendChild(refresh);
		head.appendChild(actions);
	}
	if (moduleId === "models" && state.modelAdmin.status === "ready") {
		// 供应商 / 模型各一个入口；没 workflow.write 时统一置灰（后端仍会拦）
		const actions = make("div", "module-page__actions");
		const addProvider = guardModelWrite(make("button", "btn-ghost mini", "＋ 新建供应商"));
		addProvider.setAttribute("type", "button");
		addProvider.addEventListener("click", () => openProviderDialog(null));
		const addModel = guardModelWrite(make("button", "btn-ghost mini", "＋ 新建模型"));
		addModel.setAttribute("type", "button");
		addModel.addEventListener("click", () => openModelDialog(null));
		actions.appendChild(addProvider);
		actions.appendChild(addModel);
		head.appendChild(actions);
	}
	if (moduleId === "approvals") {
		const actions = make("div", "module-page__actions");
		const refresh = make("button", "btn-ghost mini approval-refresh", "刷新");
		refresh.setAttribute("type", "button");
		refresh.addEventListener("click", () => void refreshApprovalsPage());
		actions.appendChild(refresh);

		const auto = make("label", "approval-auto");
		const input = make("input", "approval-auto__input");
		input.type = "checkbox";
		input.checked = state.approvals.auto;
		input.setAttribute("aria-label", "自动刷新待办审批");
		input.addEventListener("change", () => setApprovalsAuto(Boolean(input.checked)));
		auto.appendChild(input);
		auto.appendChild(make("span", "approval-auto__text", "自动刷新（10 秒）"));
		actions.appendChild(auto);
		head.appendChild(actions);
	}
	page.appendChild(head);

	const body = make("div", "module-page__body");
	page.appendChild(body);

	if (moduleId === "skills") renderSkillsModule(body);
	else if (moduleId === "knowledge") renderKnowledgeModule(body, spec);
	else if (moduleId === "members") renderMembersModule(body, spec);
	else if (moduleId === "audit") renderAuditModule(body, spec);
	else if (moduleId === "models") renderModelsModule(body, spec);
	else if (moduleId === "mcp") renderMcpModule(body, spec);
	else if (moduleId === "plugins") renderPluginsModule(body, spec);
	else if (moduleId === "im") renderImModule(body, spec);
	else if (moduleId === "approvals") renderApprovalsModule(body, spec);
	else if (moduleId === "monitor") renderMonitorModule(body, spec);
	else if (moduleId === "settings") renderSettingsModule(body, spec);
	else renderNotConnectedModule(body, spec);
	return page;
}

/** 未接入模块的统一形态：说明 + 「未接入」徽标 + 需要的接口清单。 */
function renderNotConnectedModule(body, spec) {
	if (spec.current) {
		const now = make("div", "module-note");
		now.appendChild(make("span", "module-note__label", "现在"));
		now.appendChild(make("p", "module-note__text", spec.current));
		body.appendChild(now);
	}
	body.appendChild(moduleSummaryNode(spec.summary));
	body.appendChild(moduleApiNode(spec.apis));
	if (spec.next) body.appendChild(make("p", "module-page__hint", spec.next));
}

/** 「说明 + 未接入徽标」这一行，所有空态模块共用。 */
function moduleSummaryNode(summary) {
	const wrap = make("div", "module-empty");
	wrap.appendChild(make("p", "module-empty__text", summary));
	wrap.appendChild(make("span", "module-badge", "未接入"));
	return wrap;
}

/** 需要的接口清单：一行一个 `<code>方法 路径</code>` + 一句用途。 */
function moduleApiNode(apis, options = {}) {
	const wrap = make("div", "module-api");
	const title = make("div", "module-section-title", "需要的接口");
	// 有真数据的模块（模型/设置）只把"还没接的那部分"标出来，不整页挂空态
	if (options.pending) title.appendChild(make("span", "module-badge", "未接入"));
	wrap.appendChild(title);
	if (!apis || apis.length === 0) {
		wrap.appendChild(make("p", "module-page__hint", "暂时没有要补的接口。"));
		return wrap;
	}
	for (const [method, path, note] of apis) {
		const item = make("div", "module-api__item");
		item.appendChild(make("code", "module-api__code", `${method} ${path}`));
		if (note) item.appendChild(make("span", "module-api__note", note));
		wrap.appendChild(item);
	}
	return wrap;
}

/**
 * 存储后端文案：/api/health 的 storage 可能是字符串，也可能是 { kind, detail }。
 * SQLite 只展示库文件名——绝对路径对用户没意义，太长还会把这一行撑爆；
 * Postgres 的 detail 是 host:port/db（不含密码），整串留着才有信息量。
 */
function storageText(storage) {
	if (!storage) return "SQLite";
	if (typeof storage === "string") return storage;
	const kind = String(storage.kind ?? storage.label ?? "sqlite");
	const lower = kind.toLowerCase();
	const name = lower === "sqlite" ? "SQLite" : lower === "postgres" ? "PostgreSQL" : kind;
	const detail = String(storage.detail ?? "");
	const short = lower === "sqlite" && /[\\/]/.test(detail) ? detail.split(/[\\/]/).pop() : detail;
	return short ? `${name}（${short}）` : name;
}

function moduleKvRow(label, value) {
	const row = make("div", "module-kv__row");
	row.appendChild(make("span", "module-kv__label", label));
	row.appendChild(make("span", "module-kv__value", value));
	return row;
}

/** 「技能」模块页：装进/退出技能的唯一入口（复用同一个 skillRowNode）。 */
function renderSkillsModule(body) {
	body.appendChild(
		make(
			"p",
			"module-page__lead",
			"技能就是一套带说明和步骤的能力：模型会在对话里按你的话自己挑，也可以在这里点一条装进当前会话。",
		),
	);
	// 右侧常驻技能栏撤掉后，「退出技能」挪到这里：正是本页把技能装进会话的，反悔入口也放这
	const active = state.activeSkill;
	if (active) {
		const bar = make("div", "skill-module-current");
		bar.appendChild(make("span", "skill-module-current__label", "当前技能"));
		bar.appendChild(make("span", "skill-module-current__name", active.name ?? active.id));
		const exit = make("button", "btn-ghost mini skill-module-exit", "退出技能");
		exit.setAttribute("type", "button");
		exit.addEventListener("click", () => void setSkill(null));
		bar.appendChild(exit);
		body.appendChild(bar);
	}
	const toolbar = make("div", "skill-module-toolbar");
	const search = make("input", "skill-module-search");
	search.type = "search";
	search.placeholder = "搜索技能名称或说明";
	search.setAttribute("aria-label", "搜索技能名称或说明");
	search.value = state.skillQuery;
	search.addEventListener("input", () => {
		state.skillQuery = search.value.trim();
		refreshSkillsModuleList(body);
	});
	toolbar.appendChild(search);
	const filters = make("div", "skill-module-filters");
	for (const [id, label] of [["all", "全部"], ["builtin", "内置"], ["custom", "自定义"], ["active", "使用中"]]) {
		const button = make("button", "skill-module-filter", label);
		button.setAttribute("type", "button");
		button.setAttribute("aria-pressed", String(state.skillFilter === id));
		button.classList.toggle("active", state.skillFilter === id);
		button.addEventListener("click", () => {
			state.skillFilter = id;
			renderModuleView();
		});
		filters.appendChild(button);
	}
	toolbar.appendChild(filters);
	body.appendChild(toolbar);
	body.appendChild(make("div", "skill-module-count"));
	const list = make("div", "module-skill-list");
	list.dataset.skillList = "true";
	body.appendChild(list);
	refreshSkillsModuleList(body);
}

function refreshSkillsModuleList(body) {
	if (!body) return;
	const list = body.querySelector(".module-skill-list");
	const count = body.querySelector(".skill-module-count");
	if (!list || !count) return;
	const all = visibleSkills();
	const activeId = state.currentView?.activeSkillId ?? state.activeSkill?.id ?? null;
	const query = state.skillQuery.toLocaleLowerCase();
	const skills = all.filter((skill) => {
		if (state.skillFilter === "builtin" && !skill.builtin) return false;
		if (state.skillFilter === "custom" && skill.builtin) return false;
		if (state.skillFilter === "active" && skill.id !== activeId) return false;
		return !query || `${skill.name} ${skill.description ?? ""}`.toLocaleLowerCase().includes(query);
	});
	count.textContent = `显示 ${skills.length} / ${all.length} 项技能`;
	list.innerHTML = "";
	if (skills.length === 0) {
		const empty = make("div", "skill-module-empty");
		empty.appendChild(make("span", "placeholder", all.length ? "没有符合条件的技能" : "暂无可用技能"));
		if (all.length && (state.skillQuery || state.skillFilter !== "all")) {
			const clear = make("button", "btn-ghost mini", "清除筛选");
			clear.setAttribute("type", "button");
			clear.addEventListener("click", () => {
				state.skillQuery = "";
				state.skillFilter = "all";
				renderModuleView();
			});
			empty.appendChild(clear);
		}
		list.appendChild(empty);
		return;
	}
	for (const skill of skills) list.appendChild(skillRowNode(skill, activeId));
}

/** 「模型」模块页：模拟模式时仍展示旧版只读信息，避免老后端/接口 404 时白屏。 */
function renderModelsFallback(body, spec) {
	const health = state.health?.model ?? null;
	const currentId = state.models?.current ?? null;
	const kv = make("div", "module-kv");
	kv.appendChild(
		moduleKvRow(
			"当前模型",
			health ? `${health.label}${health.id ? ` · ${health.id}` : ""}` : "未知（/api/health 没返回模型信息）",
		),
	);
	kv.appendChild(moduleKvRow("模式", state.models?.mode === "live" ? "live（已配置 API key）" : "simulated（未配置 key，走模拟模型）"));
	body.appendChild(kv);

	const options = state.models?.options ?? [];
	if (options.length === 0) {
		body.appendChild(make("p", "module-page__hint", "服务端没报可用模型列表（模拟模型下这是正常的）。"));
	} else {
		body.appendChild(make("div", "module-section-title", `可用模型（${options.length}）`));
		const list = make("div", "module-model-list");
		for (const option of options) {
			const row = make("div", "module-model-row");
			row.dataset.modelId = option.id;
			row.appendChild(make("span", "module-model-row__name", option.label ?? option.id));
			row.appendChild(make("span", "module-model-row__id", option.id));
			if (option.id === currentId) row.appendChild(make("span", "module-tag on", "当前默认"));
			list.appendChild(row);
		}
		body.appendChild(list);
	}
	body.appendChild(moduleApiNode(spec.apis, { pending: true }));
}

/* ---------------- 模型管理（P6）：供应商 / 模型 / 当前模型 ---------------- */

const PROVIDER_KIND_LABELS = {
	openai: "OpenAI",
	deepseek: "DeepSeek",
	ollama: "Ollama",
	anthropic: "Anthropic",
	custom: "自定义",
};
const MODEL_KIND_LABELS = { chat: "对话", embedding: "向量" };
const MODEL_WRITE_TITLE = "当前角色不能修改模型配置";
const API_KEY_WRITE_TITLE = "当前角色不能管理 API Key";

function providerKindLabel(kind) {
	return PROVIDER_KIND_LABELS[kind] ?? (kind ? String(kind) : "—");
}

function modelKindLabel(kind) {
	return MODEL_KIND_LABELS[kind] ?? (kind ? String(kind) : "—");
}

function modelAdminProviders() {
	return Array.isArray(state.modelAdmin.providers) ? state.modelAdmin.providers : [];
}

function modelAdminModels() {
	return Array.isArray(state.modelAdmin.models) ? state.modelAdmin.models : [];
}

function adminProviderEnabled(providerId) {
	const provider = modelAdminProviders().find((item) => item.id === providerId);
	return Boolean(provider && provider.enabled !== false);
}

/** 当前模型行：后端 /api/models 的 current 是 modelId，也可能直接回模型行 id。 */
function isCurrentModel(row) {
	const current = state.modelAdmin.current;
	if (!current || !row) return false;
	return row.modelId === current || row.id === current;
}

/** 当前向量模型行：与「当前模型」同一套写法（行 id 对得上就是它）。 */
function isCurrentEmbedding(row) {
	const key = state.modelAdmin.embeddingKey ?? null;
	return Boolean(key && row && row.id === key);
}

function guardModelWrite(button) {
	if (canWriteWorkflow()) return button;
	button.disabled = true;
	button.title = MODEL_WRITE_TITLE;
	return button;
}

/** 写接口统一出口：{ ok, status, data }；网络错 status=0，错误文案由调用方决定怎么显示。 */
async function requestJson(url, method, body) {
	const options = { method };
	if (body !== undefined) {
		options.headers = { "Content-Type": "application/json" };
		options.body = JSON.stringify(body);
	}
	let response = null;
	try {
		response = await api(url, options);
	} catch {
		return { ok: false, status: 0, data: null };
	}
	const data = await response.json().catch(() => null);
	return { ok: response.ok, status: response.status, data };
}

function requestError(result, fallback) {
	if (!result || result.status === 0) return "连不上服务，稍后再试。";
	// 后端的 { error } 一律原样显示，别自己编一句更含糊的
	return result.data?.error ?? `${fallback}（HTTP ${result.status}）`;
}

/** 拉模型管理数据：ready = 真接口有 providers/models；403 = 角色不够；其余 = 未接入。 */
async function refreshModelAdmin() {
	let response = null;
	try {
		response = await api("/api/models");
	} catch {
		response = null;
	}
	if (!response) {
		state.modelAdmin.status = "unavailable";
		return;
	}
	if (response.status === 403) {
		state.modelAdmin.status = "forbidden";
		return;
	}
	if (!response.ok) {
		state.modelAdmin.status = "unavailable";
		return;
	}
	const data = await response.json().catch(() => null);
	if (!data) {
		state.modelAdmin.status = "unavailable";
		return;
	}
	state.models = data;
	// 老后端只回 { mode, current, options }：没有这两个数组就仍按「未接入」处理
	if (!Array.isArray(data.providers) || !Array.isArray(data.models)) {
		state.modelAdmin.status = "unavailable";
		return;
	}
	state.modelAdmin = {
		status: "ready",
		providers: data.providers,
		models: data.models,
		current: data.current ?? null,
		mode: data.mode ?? null,
		options: Array.isArray(data.options) ? data.options : [],
		embeddingKey: null,
		embeddingOptions: [],
	};
	// 向量模型（知识库语义检索用）：只在模型管理本身 ready 时才问——降级路径不该多打一个请求
	const embeddingResponse = await api("/api/models/embedding").catch(() => null);
	if (embeddingResponse?.ok) {
		const embeddingView = await embeddingResponse.json().catch(() => null);
		if (embeddingView) {
			state.modelAdmin.embeddingKey = embeddingView.modelKey ?? null;
			state.modelAdmin.embeddingOptions = Array.isArray(embeddingView.options) ? embeddingView.options : [];
		}
	}
}

/** 顶部当前模型：模拟模式就说清楚为什么没有真模型，别只印一个 id。 */
function currentModelLabel() {
	const admin = state.modelAdmin;
	if (admin.mode === "simulated") return "模拟模型（没配置供应商密钥）";
	const key = admin.current;
	if (!key) return "未选择（还没有可用的对话模型）";
	const option = (admin.options ?? []).find((item) => item.id === key);
	if (option?.label) return option.label;
	const row = modelAdminModels().find((item) => item.id === key || item.modelId === key);
	if (row) return row.providerName ? `${row.providerName} · ${row.name}` : row.name;
	return String(key);
}

function modelStatusNode() {
	const line = make("div", "model-status");
	const live = state.modelAdmin.mode === "live";
	line.dataset.mode = live ? "live" : "simulated";
	const main = make("div", "model-status__main");
	main.appendChild(make("span", "model-status__label", "当前模型"));
	main.appendChild(make("span", "model-status__current", currentModelLabel()));
	main.appendChild(make("span", live ? "model-mode-badge live" : "model-mode-badge simulated", live ? "真实模型" : "模拟模型"));
	line.appendChild(main);
	const switchBtn = make("button", "btn-ghost mini model-switch", "切换当前模型");
	switchBtn.setAttribute("type", "button");
	switchBtn.title = "选择会保存；只影响新建会话";
	switchBtn.addEventListener("click", () => openSwitchModelDialog());
	line.appendChild(guardModelWrite(switchBtn));
	// 当前模型选择会持久化；运行中的会话仍使用创建时确定的模型。
	line.appendChild(
		make("p", "model-status__note", "当前模型选择会保存；运行中的会话不会切换。"),
	);
	return line;
}

/** 供应商 Key 解不开（没配 SECRET_KEY / 换过密钥）：给解释 + 就地重填入口，而不是只在表格里一行红字。 */
function modelKeyWarnNode(provider) {
	const wrap = make("div", "model-key-warn");
	wrap.appendChild(make("span", "model-key-warn__badge", "需要处理"));
	const body = make("div", "model-key-warn__body");
	body.appendChild(
		make(
			"p",
			"model-key-warn__text",
			`供应商「${provider.name ?? provider.id}」的 API Key 无法解密，请重新填写。`,
		),
	);
	body.appendChild(
		make(
			"p",
			"model-key-warn__hint",
			"配置固定的 SECRET_KEY，避免重启后密钥失效。",
		),
	);
	const fix = make("button", "btn-ghost mini model-key-warn__fix", "重新填写 Key");
	fix.setAttribute("type", "button");
	if (!canWriteWorkflow()) {
		fix.disabled = true;
		fix.title = MODEL_WRITE_TITLE;
	} else {
		fix.addEventListener("click", () => openProviderDialog(provider));
	}
	body.appendChild(fix);
	wrap.appendChild(body);
	return wrap;
}

function applyPingResult(node, result) {
	const ok = Boolean(result?.ok);
	node.textContent = ok
		? `✓ ${Number(result?.latencyMs) || 0}ms`
		: `✗ ${truncateText(result?.error ?? "检测失败", 80)}`;
	node.classList.toggle("ok", ok);
	node.classList.toggle("err", !ok);
	node.title = ok ? `连通，耗时 ${Number(result?.latencyMs) || 0} 毫秒` : (result?.error ?? "连通性检测失败");
}

async function pingModelRow(model, button, resultNode) {
	if (!canWriteWorkflow()) return;
	const label = button.textContent;
	button.disabled = true;
	button.textContent = "检测中…";
	resultNode.textContent = "";
	resultNode.classList.remove("ok", "err");
	const result = await requestJson(`/api/models/${encodeURIComponent(model.id)}/ping`, "POST");
	if (!result.ok) {
		applyPingResult(resultNode, {
			ok: false,
			error: result.data?.error ?? (result.status === 0 ? "连不上服务" : `探测失败（HTTP ${result.status}）`),
		});
	} else {
		applyPingResult(resultNode, result.data ?? { ok: false, error: "探测接口没有返回结果" });
	}
	button.textContent = label;
	button.disabled = false;
	guardModelWrite(button);
}

/** 供应商没有自己的探测接口：拿它名下第一条模型去探（优先启用的）。 */
async function pingProvider(provider, button, resultNode) {
	const models = modelAdminModels().filter((item) => item.providerId === provider.id);
	const model = models.find((item) => item.enabled !== false) ?? models[0];
	if (!model) {
		applyPingResult(resultNode, { ok: false, error: "这个供应商还没有模型，先新建模型再检测" });
		return;
	}
	await pingModelRow(model, button, resultNode);
}

function providerStatusBadge(provider) {
	const enabled = provider.enabled !== false;
	return make("span", enabled ? "model-badge on" : "model-badge off", enabled ? "启用" : "停用");
}

function providerTableNode(providers) {
	const wrap = make("div", "module-table-wrap");
	const table = make("table", "module-table provider-table");
	const thead = make("thead", "module-table-head");
	const headRow = make("tr", "module-table-row");
	for (const label of ["名称", "类型", "端点", "Key", "状态", "操作"]) headRow.appendChild(make("th", "module-th", label));
	thead.appendChild(headRow);
	table.appendChild(thead);

	const tbody = make("tbody", "module-table-body");
	for (const provider of providers) {
		const row = make("tr", "module-table-row provider-row");
		row.dataset.providerId = String(provider.id ?? "");
		row.appendChild(make("td", "module-td provider-name", provider.name ?? "—"));
		row.appendChild(make("td", "module-td provider-kind", providerKindLabel(provider.kind)));

		const endpoint = String(provider.baseUrl ?? "");
		const endpointCell = make("td", "module-td provider-endpoint", endpoint ? truncateText(endpoint, 42) : "—");
		if (endpoint) endpointCell.title = endpoint;
		row.appendChild(endpointCell);

		const keyText = provider.apiKeyMasked ?? (provider.hasApiKey ? "已配置（掩码不可用）" : "未配置");
		row.appendChild(make("td", "module-td provider-key", keyText));

		const statusCell = make("td", "module-td provider-status");
		statusCell.appendChild(providerStatusBadge(provider));
		row.appendChild(statusCell);

		const actions = make("td", "module-td provider-actions");
		const edit = guardModelWrite(make("button", "link-btn provider-edit", "编辑"));
		edit.setAttribute("type", "button");
		edit.addEventListener("click", () => openProviderDialog(provider));
		const remove = guardModelWrite(make("button", "link-btn provider-delete", "删除"));
		remove.setAttribute("type", "button");
		remove.addEventListener("click", () => void deleteProvider(provider));
		const ping = guardModelWrite(make("button", "link-btn provider-ping", "连通性检测"));
		ping.setAttribute("type", "button");
		const resultNode = make("span", "ping-result");
		ping.addEventListener("click", () => void pingProvider(provider, ping, resultNode));
		actions.appendChild(edit);
		actions.appendChild(remove);
		actions.appendChild(ping);
		actions.appendChild(resultNode);
		row.appendChild(actions);
		tbody.appendChild(row);
	}
	table.appendChild(tbody);
	wrap.appendChild(table);
	return wrap;
}

function modelTableNode(models) {
	const wrap = make("div", "module-table-wrap");
	const table = make("table", "module-table model-admin-table");
	const thead = make("thead", "module-table-head");
	const headRow = make("tr", "module-table-row");
	for (const label of ["名称", "供应商", "modelId", "类型", "上下文窗口", "启用", "操作"]) {
		headRow.appendChild(make("th", "module-th", label));
	}
	thead.appendChild(headRow);
	table.appendChild(thead);

	const tbody = make("tbody", "module-table-body");
	for (const model of models) {
		const row = make("tr", "module-table-row model-admin-row");
		row.dataset.modelRowId = String(model.id ?? "");

		const nameCell = make("td", "module-td model-admin-name");
		nameCell.appendChild(make("span", "model-admin-name-text", model.name ?? model.modelId ?? "—"));
		if (isCurrentModel(model)) nameCell.appendChild(make("span", "model-current-tag", "当前"));
		// 向量模型和「当前模型」用同一套表达：名字旁的标签 + 行内动作，别另开一个弹窗
		if (isCurrentEmbedding(model)) nameCell.appendChild(make("span", "model-current-tag", "向量模型"));
		row.appendChild(nameCell);

		row.appendChild(make("td", "module-td model-admin-provider", model.providerName || "—"));
		row.appendChild(make("td", "module-td model-admin-modelid", model.modelId ?? "—"));
		row.appendChild(make("td", "module-td model-admin-kind", modelKindLabel(model.kind)));
		row.appendChild(
			make(
				"td",
				"module-td model-admin-context",
				typeof model.contextWindow === "number" ? String(model.contextWindow) : "—",
			),
		);

		const enabledCell = make("td", "module-td model-admin-enabled");
		enabledCell.appendChild(make("span", model.enabled !== false ? "model-badge on" : "model-badge off", model.enabled !== false ? "启用" : "停用"));
		row.appendChild(enabledCell);

		const actions = make("td", "module-td model-actions");
		if (model.kind === "embedding") {
			const setEmbedding = make("button", "link-btn model-embedding-pick", "设为向量模型");
			setEmbedding.setAttribute("type", "button");
			if (!canWriteWorkflow()) {
				setEmbedding.disabled = true;
				setEmbedding.title = MODEL_WRITE_TITLE;
			} else if (isCurrentEmbedding(model)) {
				setEmbedding.disabled = true;
				setEmbedding.title = "它已经是当前向量模型了";
			} else if (model.enabled === false || !adminProviderEnabled(model.providerId)) {
				setEmbedding.disabled = true;
				setEmbedding.title = "只有启用的向量模型（且供应商也启用）能设为向量模型";
			} else {
				setEmbedding.addEventListener("click", () => void setEmbeddingModelRow(model));
			}
			actions.appendChild(setEmbedding);
		}
		if (model.kind === "chat") {
			const setCurrent = make("button", "link-btn model-current", "设为当前");
			setCurrent.setAttribute("type", "button");
			// 没权限时统一用「当前角色不能修改模型配置」，别再混进"模型本身不可设当前"的说明
			if (!canWriteWorkflow()) {
				setCurrent.disabled = true;
				setCurrent.title = MODEL_WRITE_TITLE;
			} else if (model.enabled === false || !adminProviderEnabled(model.providerId)) {
				setCurrent.disabled = true;
				setCurrent.title = "只有启用的对话模型能设为当前";
			} else {
				setCurrent.addEventListener("click", () => void setCurrentModel(model));
			}
			actions.appendChild(setCurrent);
		}
		const edit = guardModelWrite(make("button", "link-btn model-edit", "编辑"));
		edit.setAttribute("type", "button");
		edit.addEventListener("click", () => openModelDialog(model));
		const remove = guardModelWrite(make("button", "link-btn model-delete", "删除"));
		remove.setAttribute("type", "button");
		remove.addEventListener("click", () => void deleteModel(model));
		const ping = guardModelWrite(make("button", "link-btn model-ping", "连通性检测"));
		ping.setAttribute("type", "button");
		const resultNode = make("span", "ping-result");
		ping.addEventListener("click", () => void pingModelRow(model, ping, resultNode));
		actions.appendChild(edit);
		actions.appendChild(remove);
		actions.appendChild(ping);
		actions.appendChild(resultNode);
		row.appendChild(actions);
		tbody.appendChild(row);
	}
	table.appendChild(tbody);
	wrap.appendChild(table);
	return wrap;
}

async function setCurrentModel(model) {
	if (!canWriteWorkflow()) return;
	const result = await requestJson("/api/models/current", "POST", { modelId: model.id });
	if (!result.ok) {
		addNotice(requestError(result, "切换当前模型失败"), true);
		return;
	}
	await refreshModelAdmin();
	if (state.module === "models") renderModuleView();
	addNotice(`已把「${model.name ?? model.modelId}」设为当前模型，运行中的会话不会换，只影响新会话。`);
}

async function setEmbeddingModelRow(model) {
	if (!canWriteWorkflow()) return;
	const result = await requestJson("/api/models/embedding", "POST", { modelId: model.id });
	if (!result.ok) {
		addNotice(requestError(result, "设置向量模型失败"), true);
		return;
	}
	await refreshModelAdmin();
	await refreshEmbeddingStatus();
	if (state.module === "models") renderModuleView();
	addNotice(
		`已把「${model.name ?? model.modelId}」设为向量模型；知识库页的旧文档要点「补齐向量」才会带新模型的向量。`,
	);
}

async function deleteProvider(provider) {
	if (!canWriteWorkflow()) return;
	const modelCount = modelAdminModels().filter((item) => item.providerId === provider.id).length;
	if (
		!confirm(
			`确定删除供应商「${provider.name ?? provider.id}」？\n\n会连带删掉它下面的 ${modelCount} 个模型，不可恢复。`,
		)
	) {
		return;
	}
	const result = await requestJson(`/api/models/providers/${encodeURIComponent(provider.id)}`, "DELETE");
	if (!result.ok) {
		addNotice(requestError(result, "删除供应商失败"), true);
		return;
	}
	await refreshModelAdmin();
	if (state.module === "models") renderModuleView();
	const removedModels = Number(result.data?.modelsRemoved ?? modelCount) || 0;
	addNotice(`已删除供应商「${provider.name ?? provider.id}」${removedModels > 0 ? `，连带 ${removedModels} 个模型` : ""}。`);
}

async function deleteModel(model) {
	if (!canWriteWorkflow()) return;
	if (!confirm(`确定删除模型「${model.name ?? model.modelId ?? model.id}」？\n\n引用它的会话不受影响，但新会话不能再选它。`)) {
		return;
	}
	const result = await requestJson(`/api/models/${encodeURIComponent(model.id)}`, "DELETE");
	if (!result.ok) {
		addNotice(requestError(result, "删除模型失败"), true);
		return;
	}
	await refreshModelAdmin();
	if (state.module === "models") renderModuleView();
	addNotice(`已删除模型「${model.name ?? model.modelId ?? model.id}」。`);
}

function selectField(label, value, choices) {
	const wrap = make("label", "kb-field");
	wrap.appendChild(make("span", "kb-field-label", label));
	const select = make("select", "kb-field-input");
	for (const [id, text] of choices) {
		const option = make("option", "", text);
		option.value = id;
		select.appendChild(option);
	}
	select.value = value;
	wrap.appendChild(select);
	return { node: wrap, select };
}

function checkboxField(label, checked) {
	const wrap = make("label", "kb-field kb-field-check");
	wrap.appendChild(make("span", "kb-field-label", label));
	const input = make("input", "kb-check");
	input.type = "checkbox";
	input.checked = Boolean(checked);
	wrap.appendChild(input);
	return { node: wrap, input };
}

/** 新建 / 编辑供应商：apiKey 是 password 框，编辑时留空 = 保留原值。 */
function openProviderDialog(provider) {
	if (!canWriteWorkflow()) return;
	const editing = Boolean(provider);
	const name = kbField("供应商名称", provider?.name ?? "", 80, "例如：DeepSeek 官方");
	name.input.classList.add("provider-form-name");
	const kind = selectField("类型", provider?.kind ?? "openai", Object.entries(PROVIDER_KIND_LABELS));
	kind.select.classList.add("provider-form-kind");
	const baseUrl = kbField("端点（base URL）", provider?.baseUrl ?? "", 500, "https://api.deepseek.com/v1");
	baseUrl.input.classList.add("provider-form-base");
	const apiKey = kbField(
		editing ? "API Key（留空不修改）" : "API Key（可选）",
		"",
		1000,
		editing ? "要换 Key 就填新的，界面只回显掩码" : "不填表示这个供应商不需要 Key",
		{ type: "password" },
	);
	apiKey.input.classList.add("provider-form-key");
	apiKey.input.autocomplete = "new-password";
	const enabled = checkboxField("启用这个供应商", provider ? provider.enabled !== false : true);

	const body = make("div", "kb-form");
	for (const field of [name, kind, baseUrl, apiKey, enabled]) body.appendChild(field.node);
	body.appendChild(
		make(
			"p",
			"kb-bind-hint",
			editing
				? "留空 API Key 表示保持原值；填写就是替换。界面永远不会显示明文。"
				: "API Key 保存后只回显掩码，明文不会出现在列表里。",
		),
	);
	openKbDialog({
		title: editing ? "编辑供应商" : "新建供应商",
		body,
		save: async () => {
			const nameValue = String(name.input.value ?? "").trim();
			if (!nameValue) {
				setKbDialogError("给供应商起个名字。");
				return false;
			}
			const payload = {
				name: nameValue,
				kind: String(kind.select.value ?? "openai"),
				baseUrl: String(baseUrl.input.value ?? "").trim(),
				enabled: Boolean(enabled.input.checked),
			};
			const keyValue = String(apiKey.input.value ?? "").trim();
			if (keyValue) payload.apiKey = keyValue;
			const result = editing
				? await requestJson(`/api/models/providers/${encodeURIComponent(provider.id)}`, "PATCH", payload)
				: await requestJson("/api/models/providers", "POST", payload);
			if (!result.ok) {
				setKbDialogError(requestError(result, editing ? "保存供应商失败" : "新建供应商失败"));
				return false;
			}
			await refreshModelAdmin();
			if (state.module === "models") renderModuleView();
			addNotice(editing ? `已保存供应商「${nameValue}」。` : `已新建供应商「${nameValue}」。`);
			return true;
		},
	});
}

/** 新建 / 编辑模型：providerId 下拉取当前供应商列表，contextWindow 可空。 */
function openModelDialog(model) {
	if (!canWriteWorkflow()) return;
	const editing = Boolean(model);
	const providers = modelAdminProviders();
	if (providers.length === 0) {
		addNotice("先新建一个供应商，再来加模型。", true);
		return;
	}
	const provider = selectField(
		"供应商",
		model?.providerId ?? providers[0].id,
		providers.map((item) => [item.id, `${item.name ?? item.id}（${providerKindLabel(item.kind)}）`]),
	);
	provider.select.classList.add("model-form-provider");
	const name = kbField("模型名称", model?.name ?? "", 80, "例如：DeepSeek Chat");
	name.input.classList.add("model-form-name");
	const modelId = kbField("modelId", model?.modelId ?? "", 200, "供应商那边的模型 id，例如 deepseek-chat");
	modelId.input.classList.add("model-form-modelid");
	const kind = selectField("类型", model?.kind ?? "chat", Object.entries(MODEL_KIND_LABELS));
	kind.select.classList.add("model-form-kind");
	const contextWindow = kbField(
		"上下文窗口（可选）",
		typeof model?.contextWindow === "number" ? String(model.contextWindow) : "",
		12,
		"例如：128000",
	);
	contextWindow.input.classList.add("model-form-context");
	contextWindow.input.type = "number";
	const enabled = checkboxField("启用这个模型", model ? model.enabled !== false : true);

	const body = make("div", "kb-form");
	for (const field of [provider, name, modelId, kind, contextWindow, enabled]) body.appendChild(field.node);
	// 类型/供应商一改就更新提示：深色坑是"在 DeepSeek 供应商下建向量模型"——它没有 /embeddings 接口
	const hint = make("p", "kb-bind-hint");
	const updateHint = () => {
		const providerRow = providers.find((item) => item.id === String(provider.select.value ?? ""));
		const isEmbedding = String(kind.select.value ?? "chat") === "embedding";
		if (!isEmbedding) {
			hint.textContent = "只有「对话」模型能设为当前模型；向量模型用于知识库检索。";
			hint.classList.remove("err");
			return;
		}
		const needsBaseUrl = !providerRow?.baseUrl && providerRow?.kind !== "ollama" && providerRow?.kind !== "openai";
		if (needsBaseUrl) {
			hint.textContent = `${providerKindLabel(providerRow?.kind)} 没有向量接口：要给供应商填 base_url（例如 https://api.openai.com/v1），或换成本地 Ollama / OpenAI 兼容网关。`;
			hint.classList.add("err");
			return;
		}
		hint.textContent = "向量模型（例如 text-embedding-3-small、bge-m3）给知识库做语义检索；建好后到上方「向量模型」区块选它。";
		hint.classList.remove("err");
	};
	updateHint();
	provider.select.addEventListener("change", updateHint);
	kind.select.addEventListener("change", updateHint);
	body.appendChild(hint);
	openKbDialog({
		title: editing ? "编辑模型" : "新建模型",
		body,
		save: async () => {
			const modelIdValue = String(modelId.input.value ?? "").trim();
			if (!modelIdValue) {
				setKbDialogError("填一下 modelId（供应商那边的模型名）。");
				return false;
			}
			const payload = {
				providerId: String(provider.select.value ?? ""),
				name: String(name.input.value ?? "").trim() || modelIdValue,
				modelId: modelIdValue,
				kind: String(kind.select.value ?? "chat"),
				enabled: Boolean(enabled.input.checked),
			};
			const contextValue = String(contextWindow.input.value ?? "").trim();
			if (contextValue) {
				const parsed = Number(contextValue);
				if (!Number.isInteger(parsed) || parsed <= 0) {
					setKbDialogError("上下文窗口要填正整数。");
					return false;
				}
				payload.contextWindow = parsed;
			}
			const result = editing
				? await requestJson(`/api/models/${encodeURIComponent(model.id)}`, "PATCH", payload)
				: await requestJson("/api/models", "POST", payload);
			if (!result.ok) {
				setKbDialogError(requestError(result, editing ? "保存模型失败" : "新建模型失败"));
				return false;
			}
			await refreshModelAdmin();
			if (state.module === "models") renderModuleView();
			addNotice(editing ? `已保存模型「${payload.name}」。` : `已新建模型「${payload.name}」。`);
			return true;
		},
	});
}

/** 顶部「切换当前模型」：只列启用的对话模型，提交 modelId（模型行 id）。 */
function openSwitchModelDialog() {
	if (!canWriteWorkflow()) return;
	const chatModels = modelAdminModels().filter(
		(item) => item.kind === "chat" && item.enabled !== false && adminProviderEnabled(item.providerId),
	);
	if (chatModels.length === 0) {
		addNotice("还没有启用的对话模型，先在下面新建一个。", true);
		return;
	}
	const current = chatModels.find(isCurrentModel) ?? chatModels[0];
	const field = selectField(
		"当前模型",
		current.id,
		chatModels.map((item) => [item.id, item.providerName ? `${item.providerName} · ${item.name}` : item.name]),
	);
	const body = make("div", "kb-form");
	body.appendChild(field.node);
	body.appendChild(make("p", "kb-bind-hint", "切换只影响新会话；运行中的会话保持原来的模型。"));
	openKbDialog({
		title: "切换当前模型",
		body,
		saveLabel: "切换",
		save: async () => {
			const result = await requestJson("/api/models/current", "POST", { modelId: String(field.select.value ?? "") });
			if (!result.ok) {
				setKbDialogError(requestError(result, "切换当前模型失败"));
				return false;
			}
			await refreshModelAdmin();
			if (state.module === "models") renderModuleView();
			addNotice("已切换当前模型，只影响新会话。");
			return true;
		},
	});
}

function renderModelAdmin(body) {
	body.appendChild(modelStatusNode());
	const providers = modelAdminProviders();
	const brokenKey = providers.find((provider) => provider.apiKeyBroken);
	if (brokenKey) body.appendChild(modelKeyWarnNode(brokenKey));
	body.appendChild(make("div", "module-section-title", `供应商（${providers.length}）`));
	if (providers.length === 0) {
		body.appendChild(make("div", "model-admin-empty", "还没有供应商，先添加服务来源。"));
	} else {
		body.appendChild(providerTableNode(providers));
	}
	const models = modelAdminModels();
	body.appendChild(make("div", "module-section-title", `模型（${models.length}）`));
	if (models.length === 0) {
		body.appendChild(make("div", "model-admin-empty", "还没有模型，使用右上角「新建模型」添加。"));
	} else {
		body.appendChild(modelTableNode(models));
	}
	body.appendChild(modelEmbeddingSectionNode());
	body.appendChild(
		make(
			"p",
			"module-page__hint model-admin-footer",
			"API Key 仅加密保存，列表只显示掩码；连通性检测会向供应商发送一次短请求。",
		),
	);
}

/**
 * 「向量模型」区块：知识库的语义检索用哪条模型，就在这儿选。
 * 以前这个开关只在 .env 里，界面上「类型=向量」是个摆设；现在选完即时生效，不用重启。
 */
function modelEmbeddingSectionNode() {
	const admin = state.modelAdmin;
	const wrap = make("div", "model-embedding");
	const fromModels = Array.isArray(admin.embeddingOptions) ? admin.embeddingOptions : [];
	const current = admin.embeddingKey ? fromModels.find((model) => model.id === admin.embeddingKey) : null;
	const title = make("div", "module-section-title", "向量模型（知识库语义检索）");
	wrap.appendChild(title);

	const line = make("div", "model-embedding__line");
	if (current) {
		line.appendChild(make("span", "model-embedding__badge ok", "已启用"));
		line.appendChild(
			make("span", "model-embedding__name", `${current.providerName || "供应商"} · ${current.name}`),
		);
		line.appendChild(make("span", "model-embedding__id", current.modelId ?? ""));
	} else if (state.embedding?.available) {
		// 模型页没选，但环境变量里配了 EMBEDDING_*：如实说清来源，别让人以为没开
		line.appendChild(make("span", "model-embedding__badge ok", "已启用"));
		line.appendChild(make("span", "model-embedding__name", state.embedding.model ?? "环境变量里的向量模型"));
		line.appendChild(make("span", "model-embedding__id", "来自 .env（EMBEDDING_*）"));
	} else if (state.embedding?.problem) {
		line.appendChild(make("span", "model-embedding__badge off", "配置有误"));
		line.appendChild(make("span", "model-embedding__name", "知识库暂时退回关键词检索"));
	} else {
		line.appendChild(make("span", "model-embedding__badge off", "未启用"));
		line.appendChild(make("span", "model-embedding__name", "知识库现在按字面词匹配（关键词检索）"));
	}
	wrap.appendChild(line);

	if (state.embedding?.problem) {
		wrap.appendChild(make("p", "model-embedding__warn", state.embedding.problem));
	}
	// 一条「向量」模型都没有时，直接把入口做成"新建模型"；有候选则去下面的模型表点「设为向量模型」
	const noOptions = fromModels.length === 0;
	if (noOptions) {
		const create = make("button", "btn-ghost mini model-embedding__pick", "新建向量模型");
		create.setAttribute("type", "button");
		create.addEventListener("click", () => openModelDialog());
		line.appendChild(guardModelWrite(create));
	}
	wrap.appendChild(
		make(
			"p",
			"model-embedding__hint",
			noOptions
				? "先添加支持 embeddings 的供应商，再新建「向量」类型模型；DeepSeek / Anthropic 没有向量接口。"
				: "在模型列表对应行点「设为向量模型」即可切换。",
		),
	);
	return wrap;
}

function renderModelsModule(body, spec) {
	if (state.modelAdmin.status === "forbidden") {
		body.appendChild(moduleDeniedNode("当前角色不能查看模型配置", "模型列表需要 workflow.read 权限。"));
		return;
	}
	if (state.modelAdmin.status === "ready") {
		renderModelAdmin(body);
		return;
	}
	// 老后端 / 404 / 连不上：保留原来的只读展示与「未接入」接口清单
	renderModelsFallback(body, spec);
}

/* ---------------- 成员 / 审计 / 设置（P4）：只读信息卡 + 真分页 ---------------- */

/** 权限不足的整页提示：不混进「未接入」（那是"后端没这功能"，这是"你没这个权限"）。 */
function moduleDeniedNode(message, hint) {
	const wrap = make("div", "module-denied");
	wrap.appendChild(make("span", "module-denied__badge", "权限不足"));
	const body = make("div", "module-denied__body");
	body.appendChild(make("p", "module-denied__text", message));
	if (hint) body.appendChild(make("p", "module-denied__hint", hint));
	wrap.appendChild(body);
	return wrap;
}

/** 前端只做提示：真拦截在后端。没有权限清单（后端没上登录）时不限制。 */
function canManageMembers() {
	if (!Array.isArray(state.permissions) || state.permissions.length === 0) return true;
	// 后端现役是点号（member.manage），任务书契约写的是冒号（member:manage）：两种都认
	return state.permissions.includes("member.manage") || state.permissions.includes("member:manage");
}

/** 设置页的鉴权模式：/api/health 的 auth 为准，老后端没这字段时回落到 /api/auth/me 的 mode。 */
function authModeText(health) {
	const mode = health?.auth ?? state.me?.mode ?? state.me?.authMode ?? null;
	if (mode === "required") return "需要登录（AUTH_MODE=required：按角色限制工具与审批）";
	if (mode === "off") return "免登录（AUTH_MODE=off：本机演示，全部按所有者放行）";
	return "未知（接口没返回鉴权模式）";
}

/** 当前模型：health 给的是 { label, mode }，缺字段时别把 undefined 印到界面上。 */
function modelSummary(model) {
	if (!model) return "未知（接口没返回模型信息）";
	const label = model.label ?? model.id ?? "未知模型";
	return `${label}（${model.mode ?? "未知模式"}）`;
}

/** 可用模型数：来自 /api/models；模拟模型下后端不给可选项，这很正常。 */
function modelCountText(models) {
	if (!models) return "未知（接口没返回）";
	const count = Array.isArray(models.options) ? models.options.length : 0;
	return count === 0 ? "0 个（模拟模型下没有可选项）" : `${count} 个`;
}

/** 语义检索：只有真配了 embedding key 才算启用，没配就老实说走关键词。 */
function embeddingText(embedding) {
	if (!embedding) return "未知（接口没返回）";
	if (embedding.available) return `已启用 · ${embedding.model ?? "embedding 模型"}`;
	return "未启用（用关键词检索）";
}

/**
 * 运行时长：超过一小时写「x 小时 y 分」，不到一小时只写分钟（写「0 小时 2 分」没人看得舒服）。
 */
function formatUptime(ms) {
	if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "—";
	const total = Math.floor(ms / 1000);
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	if (hours > 0) return `${hours} 小时 ${minutes} 分`;
	if (minutes > 0) return `${minutes} 分`;
	return `${total} 秒`;
}

/** 审计时间用本地时间到秒：同一秒里的多条记录靠 id 区分。 */
function formatDateTime(value) {
	const at = typeof value === "number" ? value : Date.parse(String(value ?? ""));
	if (!Number.isFinite(at)) return "—";
	const date = new Date(at);
	const pad = (part) => String(part).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * 最近登录：undefined = 接口没给这个字段（不能当成"从未登录"骗人），null / 0 = 确实没登录过。
 */
function formatRelativeTime(value) {
	if (value === undefined) return "—";
	if (value === null || value === "" || value === 0) return "从未登录";
	const at = typeof value === "number" ? value : Date.parse(String(value));
	if (!Number.isFinite(at)) return String(value);
	const diff = Math.max(0, Date.now() - at);
	if (diff < 60_000) return "刚刚";
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
	if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
	const date = new Date(at);
	const pad = (part) => String(part).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function truncateText(text, max) {
	const value = String(text ?? "");
	return value.length > max ? `${value.slice(0, max)}…` : value;
}

/* ---- API Key（P4）：设置页里的开放 API 凭证管理 ---- */

async function refreshApiKeys() {
	let response = null;
	try {
		response = await api("/api/api-keys");
	} catch {
		response = null;
	}
	if (!response) {
		state.apiKeys.status = "unavailable";
		state.apiKeys.items = [];
		return;
	}
	// 读写都要求 workflow.write：403 是"角色不够"，不是"没接入"
	if (response.status === 403) {
		state.apiKeys.status = "forbidden";
		state.apiKeys.items = [];
		return;
	}
	if (!response.ok) {
		state.apiKeys.status = "unavailable";
		state.apiKeys.items = [];
		return;
	}
	const data = await response.json().catch(() => null);
	if (!data || !Array.isArray(data.items)) {
		state.apiKeys.status = "unavailable";
		state.apiKeys.items = [];
		return;
	}
	state.apiKeys.status = "ready";
	state.apiKeys.items = data.items;
}

/** 最近使用：没这个字段写「—」，从没用过写「从未使用」（别借用成员的「从未登录」）。 */
function formatKeyUsed(value) {
	if (value === undefined) return "—";
	if (value === null || value === "" || value === 0) return "从未使用";
	return formatRelativeTime(value);
}

function apiKeyStateText(item) {
	if (item?.revoked) return "已吊销";
	return item?.disabled ? "已停用" : "启用";
}

function apiKeyStateBadge(item) {
	const revoked = Boolean(item?.revoked);
	const disabled = Boolean(item?.disabled);
	if (revoked) return make("span", "apikey-state-badge revoked", "已吊销");
	return make("span", disabled ? "apikey-state-badge off" : "apikey-state-badge on", disabled ? "已停用" : "启用");
}

function apiKeyTableNode(items) {
	const wrap = make("div", "module-table-wrap");
	const table = make("table", "module-table apikey-table");
	const thead = make("thead", "module-table-head");
	const headRow = make("tr", "module-table-row");
	for (const label of ["名称", "Key 前缀", "角色", "限流", "最近使用", "状态", "操作"]) {
		headRow.appendChild(make("th", "module-th", label));
	}
	thead.appendChild(headRow);
	table.appendChild(thead);

	const tbody = make("tbody", "module-table-body");
	for (const item of items) {
		const row = make("tr", "module-table-row apikey-row");
		row.dataset.apiKeyId = String(item.id ?? "");
		row.appendChild(make("td", "module-td apikey-name", item.name ?? "—"));

		const prefix = String(item.prefix ?? "");
		row.appendChild(make("td", "module-td apikey-prefix", prefix ? `${prefix}…` : "—"));
		row.appendChild(make("td", "module-td apikey-role", roleLabel(item.role) || "—"));
		row.appendChild(
			make("td", "module-td apikey-rate", Number.isFinite(item.rateLimitPerMin) ? `${item.rateLimitPerMin} 次/分` : "—"),
		);
		row.appendChild(make("td", "module-td apikey-used", formatKeyUsed(item.lastUsedAt)));

		const stateCell = make("td", "module-td apikey-state");
		stateCell.appendChild(apiKeyStateBadge(item));
		row.appendChild(stateCell);

		const actions = make("td", "module-td apikey-actions");
		const revoked = Boolean(item.revoked);
		const toggle = make("button", "link-btn apikey-toggle", item.disabled ? "启用" : "停用");
		toggle.setAttribute("type", "button");
		if (revoked) {
			toggle.disabled = true;
			toggle.title = "已吊销的 Key 不能再启用";
		} else if (!canWriteWorkflow()) {
			toggle.disabled = true;
			toggle.title = API_KEY_WRITE_TITLE;
		} else {
			toggle.addEventListener("click", () => void toggleApiKey(item));
		}
		const revoke = make("button", "link-btn apikey-revoke", "吊销");
		revoke.setAttribute("type", "button");
		if (revoked) {
			revoke.disabled = true;
			revoke.title = "已吊销";
		} else if (!canWriteWorkflow()) {
			revoke.disabled = true;
			revoke.title = API_KEY_WRITE_TITLE;
		} else {
			revoke.addEventListener("click", () => void revokeApiKey(item));
		}
		actions.appendChild(toggle);
		actions.appendChild(revoke);
		row.appendChild(actions);
		tbody.appendChild(row);
	}
	table.appendChild(tbody);
	wrap.appendChild(table);
	return wrap;
}

async function toggleApiKey(item) {
	if (!canWriteWorkflow()) return;
	const result = await requestJson(`/api/api-keys/${encodeURIComponent(item.id)}`, "PATCH", {
		disabled: !item.disabled,
	});
	if (!result.ok) {
		addNotice(requestError(result, "修改 API Key 状态失败"), true);
		return;
	}
	await refreshApiKeys();
	if (state.module === "settings") renderModuleView();
	addNotice(`已${item.disabled ? "启用" : "停用"} API Key「${item.name ?? item.id}」。`);
}

async function revokeApiKey(item) {
	if (!canWriteWorkflow()) return;
	if (
		!confirm(
			`确定吊销 API Key「${item.name ?? item.id}」？\n\n吊销后使用该 Key 的调用会立刻 401，且不可恢复。`,
		)
	) {
		return;
	}
	const result = await requestJson(`/api/api-keys/${encodeURIComponent(item.id)}`, "DELETE");
	if (!result.ok) {
		addNotice(requestError(result, "吊销 API Key 失败"), true);
		return;
	}
	await refreshApiKeys();
	if (state.module === "settings") renderModuleView();
	addNotice(`已吊销 API Key「${item.name ?? item.id}」，用它发起的调用会立刻 401。`);
}

/** 明文只在创建成功的那一次出现在这个弹窗里；关闭即清空 DOM，不再保留。 */
function openApiKeyRevealDialog(key, item) {
	const body = make("div", "apikey-reveal");
	body.appendChild(make("p", "apikey-reveal-warn", "只显示这一次，请现在保存。"));
	const row = make("div", "apikey-reveal-row");
	const input = make("input", "apikey-reveal-input");
	input.type = "text";
	input.readOnly = true;
	input.value = key;
	const copy = make("button", "btn-ghost mini apikey-reveal-copy", "复制");
	copy.setAttribute("type", "button");
	copy.addEventListener("click", () => void copyText(key, copy));
	row.appendChild(input);
	row.appendChild(copy);
	body.appendChild(row);
	body.appendChild(
		make(
			"p",
			"apikey-reveal-hint",
			`名称「${item?.name ?? "未命名"}」 · 角色「${roleLabel(item?.role) || "—"}」。关闭后服务端与页面都只剩前缀，丢了只能吊销重发。`,
		),
	);
	openKbDialog({
		title: "API Key 已创建",
		body,
		saveLabel: "我已保存",
		save: async () => true,
	});
}

function openNewApiKeyDialog() {
	if (!canWriteWorkflow()) return;
	const name = kbField("名称", "", 80, "例如：报表机器人");
	name.input.classList.add("apikey-form-name");
	const role = selectField("角色", "operator", Object.entries(ROLE_LABELS));
	role.select.classList.add("apikey-form-role");
	const rate = kbField("每分钟限流", "60", 4, "1 ~ 6000");
	rate.input.classList.add("apikey-form-rate");
	rate.input.type = "number";

	const body = make("div", "kb-form");
	for (const field of [name, role, rate]) body.appendChild(field.node);
	body.appendChild(
		make("p", "kb-bind-hint", "Key 的明文只在创建成功后显示一次；列表里永远只有前缀与掩码信息。"),
	);
	openKbDialog({
		title: "新建 API Key",
		body,
		saveLabel: "创建",
		save: async () => {
			const rateValue = Number(String(rate.input.value ?? "").trim());
			if (!Number.isInteger(rateValue) || rateValue < 1 || rateValue > 6000) {
				setKbDialogError("限流要填 1 ~ 6000 的整数（次/分）。");
				return false;
			}
			const payload = {
				role: String(role.select.value ?? "operator"),
				rateLimitPerMin: rateValue,
			};
			const nameValue = String(name.input.value ?? "").trim();
			if (nameValue) payload.name = nameValue;
			const result = await requestJson("/api/api-keys", "POST", payload);
			if (!result.ok) {
				setKbDialogError(requestError(result, "新建 API Key 失败"));
				return false;
			}
			const createdKey = typeof result.data?.key === "string" ? result.data.key : "";
			await refreshApiKeys();
			if (state.module === "settings") renderModuleView();
			if (!createdKey) {
				setKbDialogError("Key 已创建，但接口没有返回明文；请吊销后重新创建。");
				return false;
			}
			// 换成"只显示一次"的卡片：返回 false 让当前提交流程别关弹窗
			openApiKeyRevealDialog(createdKey, result.data?.item ?? null);
			return false;
		},
	});
}

function apiKeySectionNode() {
	const section = make("section", "apikey-section");
	const head = make("div", "module-section-head");
	head.appendChild(make("h3", "module-section-heading", "API Key"));
	const add = make("button", "btn-ghost mini apikey-add", "＋ 新建 API Key");
	add.setAttribute("type", "button");
	if (!canWriteWorkflow()) {
		add.disabled = true;
		add.title = API_KEY_WRITE_TITLE;
	} else {
		add.addEventListener("click", () => openNewApiKeyDialog());
	}
	head.appendChild(add);
	section.appendChild(head);
	section.appendChild(
		make(
			"p",
			"module-page__lead",
			"开放 API 的调用凭证：按 Key 限流、按角色授权；明文只在创建时出现一次。",
		),
	);
	if (!canWriteWorkflow()) {
		section.appendChild(make("p", "apikey-perm-hint", `当前角色不能管理 API Key（需要 workflow.write）。`));
	}
	if (state.apiKeys.status === "forbidden") {
		section.appendChild(moduleDeniedNode("当前角色不能管理 API Key", "API Key 只对所有者与开发者开放。"));
		return section;
	}
	if (state.apiKeys.status !== "ready") {
		section.appendChild(make("div", "apikey-empty", "API Key 接口未接入（GET /api/api-keys），这一块暂时只读。"));
		return section;
	}
	if (state.apiKeys.items.length === 0) {
		section.appendChild(make("div", "placeholder", "还没有 API Key，点右上角「＋ 新建 API Key」创建一把。"));
		return section;
	}
	section.appendChild(apiKeyTableNode(state.apiKeys.items));
	section.appendChild(make("p", "module-page__hint", `共 ${state.apiKeys.items.length} 把 API Key；吊销是软删除，记录仍留在审计里。`));
	return section;
}

/** 「设置」模块页：只读地摊开当前实例的关键状态（不提供任何写入开关）。 */
function renderSettingsModule(body, spec) {
	const health = state.health;
	const kv = make("div", "module-kv");
	kv.appendChild(moduleKvRow("存储后端", storageText(health?.storage)));
	kv.appendChild(moduleKvRow("鉴权模式", authModeText(health)));
	kv.appendChild(moduleKvRow("当前模型", modelSummary(health?.model)));
	kv.appendChild(moduleKvRow("可用模型", modelCountText(state.models)));
	kv.appendChild(
		moduleKvRow("会话数", String(typeof health?.sessions === "number" ? health.sessions : state.sessions.length)),
	);
	kv.appendChild(moduleKvRow("运行时长", formatUptime(health?.uptimeMs)));
	kv.appendChild(moduleKvRow("语义检索", embeddingText(state.embedding)));
	kv.appendChild(moduleKvRow("对话权限", "完全访问（可在对话里切换成只读）"));
	kv.appendChild(moduleKvRow("技能数", String(visibleSkills().length)));
	body.appendChild(kv);
	body.appendChild(
		make(
			"p",
			"module-page__hint",
			state.embedding?.available
				? `语义检索用 ${state.embedding.model ?? "embedding 模型"} 做向量召回；换模型后旧文档要重新上传。`
				: "要开启语义检索：配置 EMBEDDING_BASE_URL / EMBEDDING_MODEL / EMBEDDING_API_KEY 后重启服务，再重新上传文档（旧文档不会自动重嵌入）。",
		),
	);
	body.appendChild(apiKeySectionNode());
	body.appendChild(moduleApiNode(spec.apis, { pending: true }));
}

/* ---- MCP（P7）：服务注册 / 发现 / 工具开关 / 调试调用 ---- */

const MCP_WRITE_TITLE = "当前角色不能修改 MCP 配置";
const MCP_TRANSPORT_LABELS = { stdio: "stdio", http: "HTTP", sse: "SSE" };

function mcpTransportText(transport) {
	return MCP_TRANSPORT_LABELS[transport] ?? (transport ? String(transport) : "—");
}

/** 前端只做提示：真拦截在后端（MCP 的 POST/PATCH/DELETE 都要求 workflow.write）。 */
function guardMcpWrite(button) {
	if (canWriteWorkflow()) return button;
	button.disabled = true;
	button.title = MCP_WRITE_TITLE;
	return button;
}

/** 三种状态：ok 绿 / error 红（卡片里另带 lastError）/ unknown 灰。 */
function mcpStatusBadge(server) {
	const status = server?.lastStatus ?? "unknown";
	if (status === "ok") return make("span", "mcp-status-badge on", "正常");
	if (status === "error") return make("span", "mcp-status-badge error", "异常");
	return make("span", "mcp-status-badge unknown", "未知");
}

/** MCP 管理接口：ready = 有真接口；403 = 角色不够；404 / 连不上 = 回落「未接入」。 */
async function refreshMcp() {
	let response = null;
	try {
		response = await api("/api/mcp/servers");
	} catch {
		response = null;
	}
	if (!response) {
		state.mcp.status = "unavailable";
		state.mcp.servers = [];
		return;
	}
	if (response.status === 403) {
		state.mcp.status = "forbidden";
		state.mcp.servers = [];
		return;
	}
	if (!response.ok) {
		state.mcp.status = "unavailable";
		state.mcp.servers = [];
		return;
	}
	const data = await response.json().catch(() => null);
	if (!data || !Array.isArray(data.items)) {
		state.mcp.status = "unavailable";
		state.mcp.servers = [];
		return;
	}
	state.mcp.status = "ready";
	state.mcp.servers = data.items.map((server) => {
		const tools = Array.isArray(server.tools) ? server.tools : [];
		return {
			...server,
			tools,
			// 老后端 / 精简出参没有 toolCount 时按 tools 长度算，界面上不出现 "undefined 个工具"
			toolCount: typeof server.toolCount === "number" ? server.toolCount : tools.length,
		};
	});
	// 服务被删掉后，展开态别留在 Set 里越积越多
	const alive = new Set(state.mcp.servers.map((server) => server.id));
	for (const id of [...state.mcp.expanded]) {
		if (!alive.has(id)) state.mcp.expanded.delete(id);
	}
}

function renderMcpModule(body, spec) {
	if (state.mcp.status === "forbidden") {
		body.appendChild(moduleDeniedNode("当前角色不能查看 MCP 配置", "MCP 配置需要 workflow.read 权限。"));
		return;
	}
	if (state.mcp.status !== "ready") {
		// 404 / 连不上：保留原来的说明 + 「未接入」徽标 + 接口清单，不摆假服务卡
		renderNotConnectedModule(body, spec);
		return;
	}
	body.appendChild(
		make(
			"p",
			"module-page__lead",
			"把外部 MCP 服务的工具接进来：支持 stdio（本机子进程）、HTTP（Streamable HTTP）与 SSE（旧版 HTTP+SSE）三种传输，注册后立刻握手并发现工具。",
		),
	);
	if (!canWriteWorkflow()) {
		body.appendChild(make("p", "mcp-perm-hint", "当前角色不能修改 MCP 配置（需要 workflow.write），这一页只能看。"));
	}
	const servers = state.mcp.servers;
	if (servers.length === 0) {
		body.appendChild(make("div", "placeholder", "还没有注册 MCP 服务，点右上角「＋ 注册 MCP 服务」把外部工具接进来。"));
	} else {
		body.appendChild(make("div", "module-section-title", `MCP 服务（${servers.length}）`));
		const list = make("div", "mcp-server-list");
		for (const server of servers) list.appendChild(mcpServerCard(server));
		body.appendChild(list);
	}
	body.appendChild(
		make(
			"p",
			"module-page__hint",
			"MCP 工具默认按高风险处理：会话里调用会先弹审批卡片。删除服务会连带删掉它的工具，已加载这些工具的会话再调用会失败。",
		),
	);
}

/** 插件列表按 API 真值渲染；未知后端只显示接口说明，不构造示例插件。 */
async function refreshPlugins() {
	let response = null;
	try { response = await api("/api/plugins"); } catch { response = null; }
	if (!response) { state.plugins.status = "unavailable"; state.plugins.items = []; return; }
	if (response.status === 403) { state.plugins.status = "forbidden"; state.plugins.items = []; return; }
	if (!response.ok) { state.plugins.status = "unavailable"; state.plugins.items = []; return; }
	const data = await response.json().catch(() => null);
	const items = Array.isArray(data) ? data : data?.items;
	if (!Array.isArray(items)) { state.plugins.status = "unavailable"; state.plugins.items = []; return; }
	state.plugins.status = "ready"; state.plugins.items = items;
}

function guardPluginWrite(button) {
	if (canWriteWorkflow()) return button;
	button.disabled = true;
	button.title = "当前角色不能修改插件（需要 workflow.write）";
	return button;
}

async function importPluginFile(input) {
	const file = input.files?.[0];
	if (!file) return;
	state.plugins.notice = null;
	try {
		const manifest = JSON.parse(await file.text());
		if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("插件清单必须是 JSON 对象");
		const result = await requestJson("/api/plugins/import", "POST", { manifest });
		if (!result.ok) throw new Error(requestError(result, "导入插件失败"));
		state.plugins.notice = "插件已导入。";
		await refreshPlugins();
	} catch (error) { state.plugins.notice = error instanceof Error ? error.message : String(error); }
	input.value = "";
	if (state.module === "plugins") renderModuleView();
}

async function setPluginEnabled(plugin, enabled) {
	const result = await requestJson("/api/plugins/" + encodeURIComponent(plugin.id), "PATCH", { enabled });
	if (!result.ok) state.plugins.notice = requestError(result, enabled ? "启用插件失败" : "停用插件失败");
	else { state.plugins.notice = enabled ? "插件已启用。" : "插件已停用。"; await refreshPlugins(); }
	if (state.module === "plugins") renderModuleView();
}

async function uninstallPlugin(plugin) {
	const name = String(plugin.name ?? plugin.id ?? "此插件");
	if (!window.confirm("确定卸载插件「" + name + "」？")) return;
	const result = await requestJson("/api/plugins/" + encodeURIComponent(plugin.id), "DELETE");
	if (!result.ok) state.plugins.notice = requestError(result, "卸载插件失败");
	else { state.plugins.notice = "插件已卸载。"; await refreshPlugins(); }
	if (state.module === "plugins") renderModuleView();
}

function renderPluginsModule(body, spec) {
	if (state.plugins.status === "forbidden") { body.appendChild(moduleDeniedNode("当前角色不能查看插件", "插件配置需要 workflow.read 权限。")); return; }
	if (state.plugins.status !== "ready") { renderNotConnectedModule(body, spec); return; }
	body.appendChild(make("p", "module-page__lead", "插件可包含技能与外部工具。请先核对清单来源和权限声明；导入时不会执行插件代码。"));
	if (!canWriteWorkflow()) body.appendChild(make("p", "plugin-perm-hint", "当前角色不能修改插件（需要 workflow.write），这一页只能查看。"));
	if (state.plugins.notice) body.appendChild(make("p", "plugin-notice", state.plugins.notice));
	const items = state.plugins.items;
	if (!items.length) { body.appendChild(make("div", "plugin-empty", "还没有插件。选择 JSON 清单导入一个插件。")); return; }
	body.appendChild(make("div", "module-section-title", "插件（" + items.length + "）"));
	const list = make("div", "plugin-list");
	for (const plugin of items) {
		const row = make("article", "plugin-row"); row.dataset.pluginId = String(plugin.id ?? "");
		const main = make("div", "plugin-row__main");
		main.appendChild(make("strong", "plugin-row__name", plugin.name ?? plugin.id ?? "未命名插件"));
		if (plugin.version) main.appendChild(make("span", "plugin-row__version", String(plugin.version)));
		if (plugin.description) main.appendChild(make("p", "plugin-row__description", String(plugin.description)));
		const contents = [];
		if (Array.isArray(plugin.skills)) contents.push(plugin.skills.length + " 个技能");
		if (Array.isArray(plugin.tools)) contents.push(plugin.tools.length + " 个工具");
		if (contents.length) main.appendChild(make("span", "plugin-row__contents", contents.join(" · ")));
		row.appendChild(main);
		const actions = make("div", "plugin-row__actions"); const enabled = plugin.enabled !== false;
		const toggle = guardPluginWrite(make("button", "link-btn plugin-toggle", enabled ? "停用" : "启用"));
		toggle.setAttribute("type", "button"); toggle.setAttribute("aria-label", (enabled ? "停用" : "启用") + "插件 " + (plugin.name ?? plugin.id));
		toggle.addEventListener("click", () => void setPluginEnabled(plugin, !enabled)); actions.appendChild(toggle);
		const remove = guardPluginWrite(make("button", "link-btn plugin-uninstall", "卸载"));
		remove.setAttribute("type", "button"); remove.addEventListener("click", () => void uninstallPlugin(plugin)); actions.appendChild(remove);
		row.appendChild(actions); list.appendChild(row);
	}
	body.appendChild(list);
}
function mcpServerCard(server) {
	const card = make("section", "mcp-server-card");
	card.dataset.serverId = String(server.id ?? "");

	const head = make("div", "mcp-server-head");
	const main = make("div", "mcp-server-main");
	const titleRow = make("div", "mcp-server-title-row");
	titleRow.appendChild(make("span", "mcp-server-name", server.name ?? server.id ?? "未命名服务"));
	titleRow.appendChild(make("span", "mcp-transport-badge", mcpTransportText(server.transport)));
	titleRow.appendChild(mcpStatusBadge(server));
	titleRow.appendChild(
		make("span", server.enabled === false ? "mcp-enabled-badge off" : "mcp-enabled-badge on", server.enabled === false ? "停用" : "启用"),
	);
	titleRow.appendChild(make("span", "mcp-tool-count", `${server.toolCount ?? 0} 个工具`));
	main.appendChild(titleRow);
	// 连接失败的中文原因原样展示（后端拼好的「连接 MCP 服务「x」失败：…」）
	if (server.lastStatus === "error" && server.lastError) {
		main.appendChild(make("p", "mcp-server-error", server.lastError));
	}
	head.appendChild(main);

	const actions = make("div", "mcp-server-actions");
	const expanded = state.mcp.expanded.has(server.id);
	const expand = make("button", "link-btn mcp-expand", expanded ? "收起工具" : "展开工具");
	expand.setAttribute("type", "button");
	expand.setAttribute("aria-expanded", expanded ? "true" : "false");
	expand.addEventListener("click", () => {
		if (state.mcp.expanded.has(server.id)) state.mcp.expanded.delete(server.id);
		else state.mcp.expanded.add(server.id);
		if (state.module === "mcp") renderModuleView();
	});
	actions.appendChild(expand);

	const refresh = guardMcpWrite(make("button", "link-btn mcp-refresh", "刷新"));
	refresh.setAttribute("type", "button");
	refresh.addEventListener("click", () => void refreshMcpServer(server));
	actions.appendChild(refresh);

	const edit = guardMcpWrite(make("button", "link-btn mcp-edit", "编辑"));
	edit.setAttribute("type", "button");
	edit.addEventListener("click", () => openMcpServerDialog(server));
	actions.appendChild(edit);

	const enabled = server.enabled !== false;
	const toggle = guardMcpWrite(make("button", "link-btn mcp-toggle", enabled ? "停用" : "启用"));
	toggle.setAttribute("type", "button");
	toggle.addEventListener("click", () => void toggleMcpServer(server));
	actions.appendChild(toggle);

	const debug = make("button", "link-btn mcp-debug", "调试调用");
	debug.setAttribute("type", "button");
	if (!canWriteWorkflow()) {
		debug.disabled = true;
		debug.title = MCP_WRITE_TITLE;
	} else if (!enabled) {
		debug.disabled = true;
		debug.title = "服务已停用，启用后才能调用";
	} else {
		debug.addEventListener("click", () => openMcpDebugDialog(server));
	}
	actions.appendChild(debug);

	const remove = guardMcpWrite(make("button", "link-btn mcp-delete", "删除"));
	remove.setAttribute("type", "button");
	remove.addEventListener("click", () => void deleteMcpServer(server));
	actions.appendChild(remove);

	head.appendChild(actions);
	card.appendChild(head);
	if (state.mcp.expanded.has(server.id)) card.appendChild(mcpToolsNode(server));
	return card;
}

/** 展开后的工具表：工具名 / 描述（截断）/ 启用开关。 */
function mcpToolsNode(server) {
	const wrap = make("div", "mcp-tools");
	const tools = Array.isArray(server.tools) ? server.tools : [];
	if (tools.length === 0) {
		wrap.appendChild(make("div", "mcp-tools-empty", "还没有发现到工具：点「刷新」重新握手，或检查服务是否正常。"));
		return wrap;
	}
	const tableWrap = make("div", "module-table-wrap");
	const table = make("table", "module-table mcp-tool-table");
	const thead = make("thead", "module-table-head");
	const headRow = make("tr", "module-table-row");
	for (const label of ["工具名", "描述", "启用"]) headRow.appendChild(make("th", "module-th", label));
	thead.appendChild(headRow);
	table.appendChild(thead);

	const tbody = make("tbody", "module-table-body");
	for (const tool of tools) {
		const row = make("tr", "module-table-row mcp-tool-row");
		row.dataset.toolId = String(tool.id ?? "");
		row.appendChild(make("td", "module-td mcp-tool-name", tool.name ?? "—"));
		const description = String(tool.description ?? "").trim() || "—";
		const descCell = make("td", "module-td mcp-tool-desc", truncateText(description, 60));
		descCell.title = description;
		row.appendChild(descCell);

		const enabledCell = make("td", "module-td mcp-tool-enabled");
		const checkbox = make("input", "mcp-tool-toggle");
		checkbox.type = "checkbox";
		checkbox.checked = tool.enabled !== false;
		if (!canWriteWorkflow()) {
			checkbox.disabled = true;
			checkbox.title = MCP_WRITE_TITLE;
		} else {
			checkbox.addEventListener("change", () => void setMcpToolEnabled(tool, checkbox));
		}
		enabledCell.appendChild(checkbox);
		row.appendChild(enabledCell);
		tbody.appendChild(row);
	}
	table.appendChild(tbody);
	tableWrap.appendChild(table);
	wrap.appendChild(tableWrap);
	return wrap;
}

async function refreshMcpServer(server) {
	if (!canWriteWorkflow()) return;
	const result = await requestJson(`/api/mcp/servers/${encodeURIComponent(server.id)}/refresh`, "POST");
	if (!result.ok) {
		addNotice(requestError(result, "刷新 MCP 服务失败"), true);
		return;
	}
	await refreshMcp();
	if (state.module === "mcp") renderModuleView();
	// 刷新接口本身 200，但重新握手仍可能失败：这时把新的 lastError 直接说清楚
	if (result.data?.lastStatus === "error") addNotice(result.data.lastError ?? `MCP 服务「${server.name}」仍然连不上。`, true);
	else addNotice(`已刷新 MCP 服务「${server.name}」，发现 ${result.data?.toolCount ?? 0} 个工具。`);
}

async function toggleMcpServer(server) {
	if (!canWriteWorkflow()) return;
	const enabled = server.enabled === false;
	const result = await requestJson(`/api/mcp/servers/${encodeURIComponent(server.id)}`, "PATCH", { enabled });
	if (!result.ok) {
		addNotice(requestError(result, "修改 MCP 服务状态失败"), true);
		return;
	}
	await refreshMcp();
	if (state.module === "mcp") renderModuleView();
	addNotice(`已${enabled ? "启用" : "停用"} MCP 服务「${server.name}」。`);
}

async function deleteMcpServer(server) {
	if (!canWriteWorkflow()) return;
	const toolCount = server.toolCount ?? server.tools?.length ?? 0;
	if (
		!confirm(
			`确定删除 MCP 服务「${server.name ?? server.id}」？\n\n会连带删掉它的 ${toolCount} 个工具；已加载这些工具的会话再调用会失败，且不可恢复。`,
		)
	) {
		return;
	}
	const result = await requestJson(`/api/mcp/servers/${encodeURIComponent(server.id)}`, "DELETE");
	if (!result.ok) {
		addNotice(requestError(result, "删除 MCP 服务失败"), true);
		return;
	}
	state.mcp.expanded.delete(server.id);
	await refreshMcp();
	if (state.module === "mcp") renderModuleView();
	addNotice(`已删除 MCP 服务「${server.name ?? server.id}」及其 ${toolCount} 个工具。`);
}

/** 工具启停：只改这一行，避免整页重画把展开态和滚动位置弄丢。 */
async function setMcpToolEnabled(tool, checkbox) {
	const enabled = Boolean(checkbox.checked);
	const result = await requestJson(`/api/mcp/tools/${encodeURIComponent(tool.id)}`, "PATCH", { enabled });
	if (!result.ok) {
		// 失败要回滚勾选状态，否则界面会显示一个后端并不认可的值
		checkbox.checked = !enabled;
		addNotice(requestError(result, "切换 MCP 工具状态失败"), true);
		return;
	}
	tool.enabled = enabled;
	addNotice(`已${enabled ? "启用" : "停用"} MCP 工具「${tool.name}」。`);
}

/* ---- MCP 弹窗：注册 / 编辑 / 调试调用 ---- */

function mcpTextArea(label, value, placeholder, rows) {
	const wrap = make("label", "kb-field");
	wrap.appendChild(make("span", "kb-field-label", label));
	const input = make("textarea", "kb-field-input mcp-textarea");
	input.rows = rows ?? 3;
	input.value = value ?? "";
	input.placeholder = placeholder ?? "";
	wrap.appendChild(input);
	return { node: wrap, input };
}

/** 「Key: Value」逐行 → 对象；任何一行不合法返回 null，由调用方给中文提示。 */
function parseMcpHeaders(text) {
	const headers = {};
	for (const raw of String(text ?? "").split("\n")) {
		const line = raw.trim();
		if (!line) continue;
		const at = line.indexOf(":");
		if (at <= 0) return null;
		const key = line.slice(0, at).trim();
		const value = line.slice(at + 1).trim();
		if (!key) return null;
		headers[key] = value;
	}
	return headers;
}

/** 逗号或换行都算分隔符；空项丢掉，避免把 "" 当参数传给子进程。 */
function parseMcpArgs(text) {
	return String(text ?? "")
		.split(/[,\n]/)
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
}

function mcpHeadersText(headers) {
	if (!headers || typeof headers !== "object") return "";
	return Object.entries(headers)
		.map(([key, value]) => `${key}: ${value}`)
		.join("\n");
}

function openMcpServerDialog(server) {
	if (!canWriteWorkflow()) return;
	const editing = Boolean(server);
	const name = kbField("名称", server?.name ?? "", 80, "例如：文件助手");
	name.input.classList.add("mcp-form-name");
	const transport = selectField("传输", server?.transport ?? "stdio", [
		["stdio", "stdio（本机子进程）"],
		["http", "HTTP（Streamable HTTP）"],
		["sse", "SSE（旧版 HTTP+SSE）"],
	]);
	transport.select.classList.add("mcp-form-transport");

	const command = kbField("命令", server?.command ?? "", 1000, "例如：C:\\Program Files\\nodejs\\node.exe");
	command.input.classList.add("mcp-form-command");
	const args = mcpTextArea("参数（逗号或换行分隔，会转成数组）", (server?.args ?? []).join("\n"), "例如：\nD:\\path\\server.mjs\n--verbose", 3);
	args.input.classList.add("mcp-form-args");
	const url = kbField("URL", server?.url ?? "", 1000, "https://example.com/mcp");
	url.input.classList.add("mcp-form-url");
	const headers = mcpTextArea("请求头（每行 Key: Value）", mcpHeadersText(server?.headers), "例如：\nAuthorization: Bearer xxx", 3);
	headers.input.classList.add("mcp-form-headers");
	const enabled = checkboxField("启用这个服务（注册后立刻连接并发现工具）", server ? server.enabled !== false : true);
	enabled.input.classList.add("mcp-form-enabled");

	// 两种传输的字段分两组显示：stdio 用命令/参数，http 与 sse 用 URL/请求头
	const stdioGroup = make("div", "mcp-form-group mcp-form-stdio");
	stdioGroup.appendChild(command.node);
	stdioGroup.appendChild(args.node);
	const httpGroup = make("div", "mcp-form-group mcp-form-http");
	httpGroup.appendChild(url.node);
	httpGroup.appendChild(headers.node);
	const syncTransport = () => {
		const value = String(transport.select.value ?? "stdio");
		stdioGroup.hidden = value !== "stdio";
		httpGroup.hidden = value === "stdio";
	};
	transport.select.addEventListener("change", syncTransport);
	syncTransport();

	const body = make("div", "kb-form");
	body.appendChild(name.node);
	body.appendChild(transport.node);
	body.appendChild(stdioGroup);
	body.appendChild(httpGroup);
	body.appendChild(enabled.node);
	body.appendChild(
		make(
			"p",
			"kb-bind-hint",
			"stdio 会启动本机子进程；http / sse 连远程地址。连接失败的记录仍会保存，lastError 原样显示在服务卡片上。",
		),
	);
	openKbDialog({
		title: editing ? "编辑 MCP 服务" : "注册 MCP 服务",
		body,
		saveLabel: editing ? "保存" : "注册",
		save: async () => {
			const nameValue = String(name.input.value ?? "").trim();
			if (!nameValue) {
				setKbDialogError("给 MCP 服务起个名字。");
				return false;
			}
			const transportValue = String(transport.select.value ?? "stdio");
			const payload = {
				name: nameValue,
				transport: transportValue,
				enabled: Boolean(enabled.input.checked),
			};
			if (transportValue === "stdio") {
				const commandValue = String(command.input.value ?? "").trim();
				if (!commandValue) {
					setKbDialogError("stdio 传输要填启动命令（command）。");
					return false;
				}
				payload.command = commandValue;
				payload.args = parseMcpArgs(args.input.value);
			} else {
				const urlValue = String(url.input.value ?? "").trim();
				if (!urlValue) {
					setKbDialogError("http / sse 传输要填服务地址（URL）。");
					return false;
				}
				const headerMap = parseMcpHeaders(headers.input.value);
				if (headerMap === null) {
					setKbDialogError("请求头每行要是「Key: Value」的形式，例如 Authorization: Bearer xxx。");
					return false;
				}
				payload.url = urlValue;
				payload.headers = headerMap;
			}
			const result = editing
				? await requestJson(`/api/mcp/servers/${encodeURIComponent(server.id)}`, "PATCH", payload)
				: await requestJson("/api/mcp/servers", "POST", payload);
			if (!result.ok) {
				setKbDialogError(requestError(result, editing ? "保存 MCP 服务失败" : "注册 MCP 服务失败"));
				return false;
			}
			await refreshMcp();
			if (state.module === "mcp") renderModuleView();
			if (result.data?.lastStatus === "error" && result.data.lastError) {
				addNotice(`MCP 服务「${nameValue}」已保存，但连接失败：${result.data.lastError}`, true);
			} else {
				addNotice(editing ? `已保存 MCP 服务「${nameValue}」。` : `已注册 MCP 服务「${nameValue}」。`);
			}
			return true;
		},
	});
}

/** 调试调用：选工具 + JSON 参数；成功/失败结果都留在弹窗里看。 */
function openMcpDebugDialog(server) {
	if (!canWriteWorkflow()) return;
	const tools = Array.isArray(server?.tools) ? server.tools : [];
	if (tools.length === 0) {
		addNotice("这个服务还没有发现到工具，先点「刷新」再调试。", true);
		return;
	}
	const tool = selectField(
		"工具",
		tools[0].name,
		tools.map((item) => [item.name, item.enabled === false ? `${item.name}（已停用）` : item.name]),
	);
	tool.select.classList.add("mcp-call-tool");
	const args = mcpTextArea("参数（JSON 对象）", "{}", '例如：{"a": 1, "b": 2}', 4);
	args.input.classList.add("mcp-call-args");
	const output = make("div", "mcp-call-output");
	output.hidden = true;

	const body = make("div", "kb-form");
	body.appendChild(tool.node);
	body.appendChild(args.node);
	body.appendChild(make("p", "kb-bind-hint", "直接调一次工具，结果会显示在下面；返回 isError 时用红字标出。"));
	body.appendChild(output);
	openKbDialog({
		title: "调试调用 MCP 工具",
		body,
		saveLabel: "调用",
		save: async () => {
			const raw = String(args.input.value ?? "").trim();
			let parsed = {};
			if (raw) {
				try {
					parsed = JSON.parse(raw);
				} catch {
					setKbDialogError('参数不是合法的 JSON，例如 {"a": 1}。');
					return false;
				}
				if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
					setKbDialogError("参数必须是 JSON 对象（{...}），不能是数组或字符串。");
					return false;
				}
			}
			const result = await requestJson(`/api/mcp/servers/${encodeURIComponent(server.id)}/call`, "POST", {
				tool: String(tool.select.value ?? ""),
				arguments: parsed,
			});
			if (!result.ok) {
				setKbDialogError(requestError(result, "调用 MCP 工具失败"));
				return false;
			}
			const data = result.data ?? {};
			setKbDialogError("");
			output.hidden = false;
			output.innerHTML = "";
			output.appendChild(
				make(
					"p",
					"mcp-call-meta",
					`${data.serverName ?? server.name ?? "MCP"} · ${data.toolName ?? data.tool ?? ""} · ${data.isError ? "调用返回错误" : "调用成功"}`,
				),
			);
			const text = make("pre", "mcp-call-text", typeof data.text === "string" && data.text.length > 0 ? data.text : "（没有输出）");
			if (data.isError) text.classList.add("err");
			output.appendChild(text);
			// 返回 false：留着弹窗让用户看结果，关掉由用户自己点 × / 取消
			return false;
		},
	});
}

/* ---- IM 机器人（P8）：机器人凭证 / 启停 / 测试消息 / 回调说明 / fake outbox ---- */

const IM_WRITE_TITLE = "当前角色不能修改 IM 配置";
const IM_CALLBACK_PATH = "/api/im/dingtalk/callback";
// outbox 只用于本机调试：最近 10 条足够看清最近几次 ping / 回复
const IM_OUTBOX_LIMIT = 10;
// 出站内容截断到 60 字：完整内容挂在 title 上，别把表格撑破
const IM_OUTBOX_CONTENT_MAX = 60;

/** 前端只做提示：真拦截在后端（IM 的 POST/PATCH/DELETE/ping 都要求 workflow.write）。 */
function guardImWrite(button) {
	if (canWriteWorkflow()) return button;
	button.disabled = true;
	button.title = IM_WRITE_TITLE;
	return button;
}

/** 最近回调：null = 从没收到过（别借用成员的「从未登录」）；字段缺失给「—」。 */
function formatImCallbackAt(value) {
	if (value === undefined) return "—";
	if (value === null || value === "" || value === 0) return "从未回调";
	return formatRelativeTime(value);
}

/** IM 管理接口：ready = 有真接口；403 = 角色不够；404 / 连不上 = 回落「未接入」。 */
async function refreshIm() {
	let response = null;
	try {
		response = await api("/api/im/bots");
	} catch {
		response = null;
	}
	if (!response) {
		state.im.status = "unavailable";
		state.im.bots = [];
		state.im.outbox = null;
		return;
	}
	if (response.status === 403) {
		state.im.status = "forbidden";
		state.im.bots = [];
		state.im.outbox = null;
		return;
	}
	if (!response.ok) {
		state.im.status = "unavailable";
		state.im.bots = [];
		state.im.outbox = null;
		return;
	}
	const data = await response.json().catch(() => null);
	if (!data || !Array.isArray(data.items)) {
		state.im.status = "unavailable";
		state.im.bots = [];
		state.im.outbox = null;
		return;
	}
	state.im.status = "ready";
	state.im.bots = data.items;
	state.im.outbox = await fetchImOutbox();
}

/**
 * fake 传输下的出站队列：只在本机调试时有意义。
 * 404（真实传输）/ 403（没有 audit.read）/ 网络错都返回 null —— 页面整块隐藏，不显示「未接入」。
 */
async function fetchImOutbox() {
	try {
		const response = await api("/api/im/outbox");
		if (!response.ok) return null;
		const data = await response.json().catch(() => null);
		return Array.isArray(data?.items) ? data.items : null;
	} catch {
		return null;
	}
}

function renderImModule(body, spec) {
	if (state.im.status === "forbidden") {
		body.appendChild(moduleDeniedNode("当前角色不能查看 IM 配置", "IM 机器人配置需要 workflow.read 权限。"));
		return;
	}
	if (state.im.status !== "ready") {
		// 404 / 连不上：保留说明 + 「未接入」徽标 + 接口清单，不摆假机器人
		renderNotConnectedModule(body, spec);
		return;
	}
	body.appendChild(
		make(
			"p",
			"module-page__lead",
			"把钉钉或企业微信自建应用接进来：员工发来的消息会自动交给 AI 回复，多轮对话各自独立。添加机器人后，按卡片里的专属回调地址完成平台配置。",
		),
	);
	if (!canWriteWorkflow()) {
		body.appendChild(make("p", "im-perm-hint", "当前角色不能修改 IM 配置（需要 workflow.write），这一页只能看。"));
	}
	const bots = state.im.bots;
	if (bots.length === 0) {
		body.appendChild(imEmptyNode());
	} else {
		body.appendChild(make("div", "module-section-title", `机器人（${bots.length}）`));
		const list = make("div", "im-bot-list");
		for (const bot of bots) list.appendChild(imBotCard(bot));
		body.appendChild(list);
	}
	// 平台侧怎么配是一次性说明：默认收起，别让文档压住机器人列表
	body.appendChild(imGuideSection());
	// outbox 是 fake 传输的额外能力：接口 404 / 403 / 连不上时 null，整块不出现
	if (Array.isArray(state.im.outbox)) body.appendChild(imOutboxNode(state.im.outbox));
	body.appendChild(
		make(
			"p",
			"module-page__hint",
			"凭证只以密文落库，列表只回掩码；删除机器人会连带删掉它的外部会话映射，平台侧再回调会 404。",
		),
	);
}

function imBotCard(bot) {
	const card = make("section", "im-bot-card");
	card.dataset.botId = String(bot.id ?? "");

	const head = make("div", "im-bot-head");
	const main = make("div", "im-bot-main");

	const titleRow = make("div", "im-bot-title-row");
	titleRow.appendChild(make("span", "im-bot-name", bot.name ?? bot.id ?? "未命名机器人"));
	titleRow.appendChild(
		make("span", bot.enabled === false ? "im-state-badge off" : "im-state-badge on", bot.enabled === false ? "停用" : "启用"),
	);
	titleRow.appendChild(
		make("span", bot.hasAesKey ? "im-aes-badge on" : "im-aes-badge off", bot.hasAesKey ? "AES 已配置" : "未配置 AES"),
	);
	titleRow.appendChild(make("span", "module-tag", bot.platform === "wecom" ? "企业微信" : "钉钉"));
	main.appendChild(titleRow);

	const keys = make("div", "im-bot-keys");
	keys.appendChild(imBotMetaNode(bot.platform === "wecom" ? "CorpID" : "appKey", bot.appKey ?? "—", "im-bot-appkey"));
	keys.appendChild(imBotMetaNode(bot.platform === "wecom" ? "AgentId" : "robotCode", bot.robotCode ?? "—", "im-bot-robotcode"));
	// 接口只回掩码：没有掩码就别编一个，老实写「—」
	keys.appendChild(imBotMetaNode("appSecret", bot.appSecretMasked ?? "—", "im-bot-secret"));
	main.appendChild(keys);

	const stats = make("div", "im-bot-stats");
	stats.appendChild(
		make("span", "im-bot-callback", `最近回调：${formatImCallbackAt(bot.lastCallbackAt)}`),
	);
	stats.appendChild(make("span", "im-bot-sessions", `会话 ${Number(bot.sessionCount) || 0} 个`));
	main.appendChild(stats);
	head.appendChild(main);

	const actions = make("div", "im-bot-actions");
	const edit = guardImWrite(make("button", "link-btn im-edit", "编辑"));
	edit.setAttribute("type", "button");
	edit.addEventListener("click", () => openImBotDialog(bot));
	actions.appendChild(edit);

	const toggle = guardImWrite(make("button", "link-btn im-toggle", bot.enabled === false ? "启用" : "停用"));
	toggle.setAttribute("type", "button");
	toggle.addEventListener("click", () => void toggleImBot(bot));
	actions.appendChild(toggle);

	const ping = guardImWrite(make("button", "link-btn im-ping", "发测试消息"));
	ping.setAttribute("type", "button");
	ping.addEventListener("click", () => openImPingDialog(bot));
	if (canWriteWorkflow() && bot.enabled === false) {
		ping.disabled = true;
		ping.title = "请先启用机器人";
	}
	actions.appendChild(ping);

	const remove = guardImWrite(make("button", "link-btn im-delete", "删除"));
	remove.setAttribute("type", "button");
	remove.addEventListener("click", () => void deleteImBot(bot));
	actions.appendChild(remove);

	head.appendChild(actions);
	card.appendChild(head);
	const callbackPath = bot.platform === "wecom" ? "/api/im/wecom/callback" : IM_CALLBACK_PATH;
	const callbackUrl = `${window.location?.origin ?? ""}${callbackPath}?botId=${encodeURIComponent(bot.id)}`;
	const callback = make("div", "im-bot-callback-url");
	callback.appendChild(make("code", "im-callback-code", callbackUrl));
	const copy = make("button", "link-btn im-copy-callback", "复制回调地址");
	copy.setAttribute("type", "button");
	copy.addEventListener("click", () => void copyText(callbackUrl, copy));
	callback.appendChild(copy);
	card.appendChild(callback);

	// 测试消息的结果贴在卡片里：失败原因可能很长，不塞进按钮
	const pingResult = make("div", "im-ping-result");
	pingResult.hidden = true;
	card.appendChild(pingResult);
	return card;
}

function imBotMetaNode(label, value, className) {
	const row = make("div", "im-bot-meta");
	row.appendChild(make("span", "im-bot-meta__label", label));
	row.appendChild(make("span", `im-bot-meta__value ${className}`, value));
	return row;
}

/** 一个机器人都没有时的引导：说清支持哪两个平台，并就地给添加入口。 */
function imEmptyNode() {
	const card = make("div", "im-empty");
	card.appendChild(make("p", "im-empty__title", "还没有接入机器人"));
	card.appendChild(
		make(
			"p",
			"im-empty__text",
			"钉钉自建应用和企业微信自建应用都支持：添加后填上平台给的凭证，把卡片里的回调地址贴到平台后台，员工消息就会自动转成对话。",
		),
	);
	if (canWriteWorkflow()) {
		const add = make("button", "btn-ghost mini im-empty__add", "＋ 添加机器人");
		add.setAttribute("type", "button");
		add.addEventListener("click", () => openImBotDialog(null));
		card.appendChild(add);
	}
	return card;
}

/** 平台配置说明：内容长、平时用不到，收进一次点击展开的折叠区。 */
function imGuideSection() {
	const section = make("section", "im-guide");
	const toggle = make("button", "im-guide__toggle", "配置说明：钉钉 / 企业微信怎么接");
	toggle.setAttribute("type", "button");
	toggle.setAttribute("aria-expanded", "false");
	const panel = make("div", "im-guide__panel");
	panel.hidden = true;
	panel.appendChild(imCallbackCard());
	panel.appendChild(imWecomGuideCard());
	toggle.addEventListener("click", () => {
		const open = panel.hidden;
		panel.hidden = !open;
		toggle.setAttribute("aria-expanded", String(open));
	});
	section.appendChild(toggle);
	section.appendChild(panel);
	return section;
}

/** 企业微信自建应用的配置步骤（和钉钉那套放在同一个折叠区里）。 */
function imWecomGuideCard() {
	const card = make("section", "im-callback im-wecom-guide");
	card.appendChild(make("h3", "module-section-heading", "企业微信自建应用怎么配"));
	card.appendChild(
		make(
			"p",
			"im-callback-text",
			"在企业微信管理后台创建自建应用，填企业 ID、AgentId 与应用 Secret。在「接收消息」里填卡片的公网 HTTPS 回调地址，并配相同的 Token 与 EncodingAESKey，保存时平台会自动校验这个地址。",
		),
	);
	card.appendChild(
		make(
			"p",
			"im-callback-text",
			"把服务器出口 IP 配进应用可信 IP，并确认接收员工在应用可见范围内。当前支持员工向自建应用发文本，多轮对话按员工独立保存；图片、语音与群机器人 Webhook 不在这种接入方式里。",
		),
	);
	return card;
}

/** 回调说明卡：钉钉侧要填什么、签名怎么校验、消息怎么变成内部会话。 */
function imCallbackCard() {
	const card = make("section", "im-callback");
	const head = make("div", "module-section-head");
	head.appendChild(make("h3", "module-section-heading", "钉钉回调怎么配"));
	card.appendChild(head);

	const rows = make("div", "im-callback-rows");
	const urlValue = make("div", "im-callback-value");
	urlValue.appendChild(make("code", "im-callback-code", `POST ${IM_CALLBACK_PATH}`));
	urlValue.appendChild(
		make("span", "im-callback-text", "钉钉后台「事件订阅」里填这个地址，换成本机/服务器的地址与端口"),
	);
	rows.appendChild(imCallbackRow("回调地址", urlValue));
	rows.appendChild(
		imCallbackRow(
			"加签校验",
			make(
				"p",
				"im-callback-text",
				'timestamp + sign：sign = Base64(HMAC-SHA256(appSecret, timestamp + "\\n" + appSecret))；timestamp 与服务端相差超过 1 小时按过期拒绝（401），防重放。',
			),
		),
	);
	rows.appendChild(
		imCallbackRow(
			"回调时效",
			make(
				"p",
				"im-callback-text",
				"钉钉要求尽快回 200：先校验、再回执，模型回复异步跑；5 分钟内的重复投递按 msgId 幂等，不会重复起会话。",
			),
		),
	);
	rows.appendChild(
		imCallbackRow(
			"AES 加密（可选）",
			make(
				"p",
				"im-callback-text",
				"填了 aesKey 就走 encrypt + msg_signature：token / timestamp / nonce / encrypt 排序后 SHA1 校验，再用 AES-256-CBC 解密；没填就只验加签。",
			),
		),
	);
	rows.appendChild(
		imCallbackRow(
			"消息转会话",
			make(
				"p",
				"im-callback-text",
				"机器人在群里被 @ 时，文本消息会转成内部会话；每个 conversationId 对应一个会话，多轮消息串行处理，回复回推到原会话。",
			),
		),
	);
	rows.appendChild(
		imCallbackRow(
			"鉴权",
			make(
				"p",
				"im-callback-text",
				"回调是免登录的公开路径；本页的其它 /api/im 接口按 workflow.read / workflow.write 校验角色权限。",
			),
		),
	);
	card.appendChild(rows);
	return card;
}

function imCallbackRow(label, valueNode) {
	const row = make("div", "im-callback-row");
	row.appendChild(make("span", "im-callback-label", label));
	row.appendChild(valueNode);
	return row;
}

function imOutboxNode(items) {
	const section = make("section", "im-outbox");
	const head = make("div", "module-section-head");
	const count = Math.min(items.length, IM_OUTBOX_LIMIT);
	head.appendChild(make("h3", "module-section-heading", `模拟出站队列（最近 ${count} 条）`));
	head.appendChild(make("span", "im-outbox-hint", "模拟传输：不联网，只写到本机队列"));
	section.appendChild(head);

	if (items.length === 0) {
		section.appendChild(
			make("div", "im-outbox-empty", "还没有出站消息：点机器人的「发测试消息」，或让钉钉回调触发一次回复。"),
		);
		return section;
	}

	// 最新的排最上面：排查「刚才那条发出去没有」时不用翻到底
	const recent = items.slice(-IM_OUTBOX_LIMIT).reverse();
	const wrap = make("div", "module-table-wrap");
	const table = make("table", "module-table im-outbox-table");
	const thead = make("thead", "module-table-head");
	const headRow = make("tr", "module-table-row");
	for (const label of ["时间", "机器人", "会话", "内容"]) headRow.appendChild(make("th", "module-th", label));
	thead.appendChild(headRow);
	table.appendChild(thead);

	const tbody = make("tbody", "module-table-body");
	for (const item of recent) {
		const row = make("tr", "module-table-row im-outbox-row");
		row.dataset.outboxId = String(item.id ?? "");
		row.appendChild(make("td", "module-td im-outbox-time", formatDateTime(item.at)));
		row.appendChild(make("td", "module-td im-outbox-bot", item.botName ?? item.botId ?? "—"));
		const target = item.target?.conversationId ?? item.target?.staffId ?? "—";
		row.appendChild(make("td", "module-td im-outbox-target", target));
		const content = String(item.content ?? "");
		const cell = make("td", "module-td im-outbox-content", truncateText(content, IM_OUTBOX_CONTENT_MAX));
		cell.title = content;
		row.appendChild(cell);
		tbody.appendChild(row);
	}
	table.appendChild(tbody);
	wrap.appendChild(table);
	section.appendChild(wrap);
	return section;
}

/** 添加 / 编辑：凭证框都是 password；编辑时留空表示沿用原值（appSecret / callbackToken / aesKey 都不进 body）。 */
function openImBotDialog(bot) {
	if (!canWriteWorkflow()) return;
	const editing = Boolean(bot);
	const platform = selectField("接入平台", bot?.platform ?? "dingtalk", [["dingtalk", "钉钉"], ["wecom", "企业微信 · 自建应用"]]);
	platform.select.classList.add("im-form-platform");
	platform.select.disabled = editing;
	const name = kbField("名称", bot?.name ?? "", 80, "例如：客服机器人");
	name.input.classList.add("im-form-name");
	const appKey = kbField("appKey", bot?.appKey ?? "", 200, "钉钉开放平台的 AppKey");
	appKey.input.classList.add("im-form-appkey");
	const appSecret = kbField(
		editing ? "appSecret（留空不修改）" : "appSecret",
		"",
		500,
		editing ? "要换就填新的；列表只回掩码" : "钉钉开放平台的 AppSecret",
		{ type: "password" },
	);
	appSecret.input.classList.add("im-form-secret");
	appSecret.input.autocomplete = "new-password";
	const robotCode = kbField("robotCode", bot?.robotCode ?? "", 200, "机器人编码，例如 dingxxxxxx");
	robotCode.input.classList.add("im-form-robotcode");
	const callbackToken = kbField(
		editing ? "callbackToken（留空不修改）" : "callbackToken",
		"",
		500,
		"钉钉回调的加签 token",
		{ type: "password" },
	);
	callbackToken.input.classList.add("im-form-token");
	const aesKey = kbField(
		editing ? "aesKey（可选，留空不修改）" : "aesKey（可选）",
		"",
		500,
		"钉钉后台的 43 位 EncodingAESKey；不填表示只加签",
		{ type: "password" },
	);
	aesKey.input.classList.add("im-form-aeskey");
	const enabled = checkboxField("启用这个机器人", bot ? bot.enabled !== false : true);
	enabled.input.classList.add("im-form-enabled");

	const body = make("div", "kb-form");
	for (const field of [platform, name, appKey, appSecret, robotCode, callbackToken, aesKey, enabled]) {
		body.appendChild(field.node);
	}
	body.appendChild(
		make(
			"p",
			"kb-bind-hint",
			"凭证（appSecret / callbackToken / aesKey）只以密文落库，接口只回掩码；编辑时留空表示沿用原值。",
		),
	);

	const updatePlatformLabels = () => {
		const wecom = platform.select.value === "wecom";
		for (const [field, text] of [[appKey, wecom ? "企业 ID（CorpID）" : "appKey"], [robotCode, wecom ? "应用 AgentId" : "robotCode"], [appSecret, wecom ? "应用 Secret" : "appSecret"], [callbackToken, wecom ? "回调 Token" : "callbackToken"], [aesKey, wecom ? "EncodingAESKey（必填）" : "aesKey（可选）"]]) {
			field.node.querySelector(".kb-field-label").textContent = text + (editing && [appSecret, callbackToken, aesKey].includes(field) ? "（留空不修改）" : "");
		}
		appSecret.input.placeholder = editing ? "要换就填新的；列表只回掩码" : wecom ? "企业微信应用详情中的 Secret" : "钉钉开放平台的 AppSecret";
		callbackToken.input.placeholder = wecom ? "企业微信接收消息设置中的 Token" : "钉钉回调的加签 token";
		appKey.input.placeholder = wecom ? "企业微信管理后台的企业 ID" : "钉钉开放平台的 AppKey";
		robotCode.input.placeholder = wecom ? "应用详情中的数字 AgentId" : "机器人编码，例如 dingxxxxxx";
		aesKey.input.placeholder = wecom ? "接收消息设置中的 43 位 EncodingAESKey" : "钉钉后台的 43 位 EncodingAESKey；可不填";
	};
	platform.select.addEventListener("change", updatePlatformLabels);
	updatePlatformLabels();
	openKbDialog({
		title: editing ? "编辑机器人" : "添加机器人",
		body,
		saveLabel: editing ? "保存" : "添加",
		save: async () => {
			const payload = {
				name: String(name.input.value ?? "").trim(),
				appKey: String(appKey.input.value ?? "").trim(),
				robotCode: String(robotCode.input.value ?? "").trim(),
				enabled: Boolean(enabled.input.checked),
			};
			if (!editing) payload.platform = platform.select.value;
			const secretValue = String(appSecret.input.value ?? "").trim();
			if (secretValue) payload.appSecret = secretValue;
			const tokenValue = String(callbackToken.input.value ?? "").trim();
			if (tokenValue) payload.callbackToken = tokenValue;
			const aesValue = String(aesKey.input.value ?? "").trim();
			if (aesValue) payload.aesKey = aesValue;
			const result = editing
				? await requestJson(`/api/im/bots/${encodeURIComponent(bot.id)}`, "PATCH", payload)
				: await requestJson("/api/im/bots", "POST", payload);
			if (!result.ok) {
				// 后端 { error } 原样显示在弹窗里
				setKbDialogError(requestError(result, editing ? "保存机器人失败" : "添加机器人失败"));
				return false;
			}
			await refreshIm();
			if (state.module === "im") renderModuleView();
			addNotice(
				editing ? `已保存机器人「${payload.name || bot.name}」。` : `已添加机器人「${payload.name}」。`,
			);
			return true;
		},
	});
}

/** 发测试消息：fake 模式会进 outbox；真实传输失败也回 200 + ok:false，失败原因照原样显示。 */
function openImPingDialog(bot) {
	if (!canWriteWorkflow() || bot.enabled === false) return;
	const wecom = bot.platform === "wecom";
	const targetType = selectField("接收方式", wecom ? "staffId" : "conversationId", wecom ? [["staffId", "企业微信员工 UserID"]] : [
		["conversationId", "群聊（群会话 ID）"],
		["staffId", "单聊（员工 ID）"],
	]);
	targetType.select.classList.add("im-ping-type");
	const target = kbField("接收目标", "", 200, "填写群会话 ID 或员工 ID");
	target.input.classList.add("im-ping-target");
	const body = make("div", "kb-form");
	body.appendChild(targetType.node);
	body.appendChild(target.node);
	body.appendChild(make("p", "kb-bind-hint", "将发送一条固定测试消息。真实钉钉必须填写接收目标；模拟传输可留空，消息只进入本机出站队列。"));
	let sending = false;
	openKbDialog({
		title: `发送测试消息 · ${bot.name}`,
		body,
		saveLabel: "发送测试消息",
		save: async () => {
			const value = String(target.input.value ?? "").trim();
			if (!value && bot.transport !== "fake" && !(bot.transport === undefined && Array.isArray(state.im.outbox))) {
				setKbDialogError("请填写群会话 ID 或员工 ID。");
				return false;
			}
			if (sending) return false;
			sending = true;
			try {
				return await pingImBot(bot, value ? { [targetType.select.value]: value } : {});
			} finally {
				sending = false;
			}
		},
	});
}

async function pingImBot(bot, target) {
	if (!canWriteWorkflow() || bot.enabled === false) return false;
	const result = await requestJson(`/api/im/bots/${encodeURIComponent(bot.id)}/ping`, "POST", target);
	const data = result.data;
	const ok = result.ok && data?.ok !== false;
	let message;
	if (ok) {
		message =
			data?.transport === "fake"
				? "✓ 测试消息已发送（fake 传输，已写入 outbox）"
				: `✓ 测试消息已发送（尝试 ${data?.attempts ?? 1} 次）`;
	} else if (result.ok) {
		message = `✗ ${data?.error ?? "发送失败"}`;
	} else {
		message = `✗ ${requestError(result, "发送测试消息失败")}`;
	}
	// 刷新 outbox：ping 成功时这里会多一条，失败时列表不该变
	state.im.outbox = await fetchImOutbox();
	if (state.module === "im") renderModuleView();
	showImPingResult(bot.id, ok, message);
	if (!ok) setKbDialogError(message);
	return ok;
}

/** 重画后把结果贴回对应的卡片（整页重画会丢掉临时节点）。 */
function showImPingResult(botId, ok, message) {
	const card = Array.from(els.modulePage.querySelectorAll(".im-bot-card")).find(
		(node) => node.dataset.botId === String(botId),
	);
	const node = card?.querySelector(".im-ping-result");
	if (!node) return;
	node.hidden = false;
	node.textContent = message;
	node.classList.toggle("ok", ok);
	node.classList.toggle("err", !ok);
}

async function toggleImBot(bot) {
	if (!canWriteWorkflow()) return;
	const enabled = bot.enabled === false;
	const result = await requestJson(`/api/im/bots/${encodeURIComponent(bot.id)}`, "PATCH", { enabled });
	if (!result.ok) {
		addNotice(requestError(result, "修改机器人状态失败"), true);
		return;
	}
	await refreshIm();
	if (state.module === "im") renderModuleView();
	addNotice(`已${enabled ? "启用" : "停用"}机器人「${bot.name ?? bot.id}」。`);
}

async function deleteImBot(bot) {
	if (!canWriteWorkflow()) return;
	const sessions = Number(bot.sessionCount) || 0;
	if (
		!confirm(
			`确定删除机器人「${bot.name ?? bot.id}」？\n\n会连带删掉它的 ${sessions} 个外部会话映射；钉钉侧再回调会 404，且不可恢复。`,
		)
	) {
		return;
	}
	const result = await requestJson(`/api/im/bots/${encodeURIComponent(bot.id)}`, "DELETE");
	if (!result.ok) {
		addNotice(requestError(result, "删除机器人失败"), true);
		return;
	}
	await refreshIm();
	if (state.module === "im") renderModuleView();
	addNotice(`已删除机器人「${bot.name ?? bot.id}」及其 ${result.data?.sessionsRemoved ?? sessions} 个会话映射。`);
}

/* ---- 审批中心：跨会话待办 / 批准 / 拒绝 / 去会话 ---- */

// 并发请求只让最新那次落地：手动刷新与轮询撞在一起时，慢的那次不能盖掉新结果
let approvalsRequestSeq = 0;

/** 当前角色能不能处理审批（后端 POST /api/approvals/:sessionId 要 session.run）。 */
function canRunSessions() {
	if (!Array.isArray(state.permissions) || state.permissions.length === 0) return true;
	// 后端现役是点号（session.run），任务书契约写的是冒号（session:run）：两种都认
	return state.permissions.includes("session.run") || state.permissions.includes("session:run");
}

/** 系统标签页隐藏时暂停轮询：用户看不见的页面没必要一直打接口。 */
function approvalsHidden() {
	return typeof document !== "undefined" && document.hidden === true;
}

/** 审批队列 GET：ready = 有真接口；403 = 角色不够；404 / 连不上 = 回落「未接入」。 */
async function refreshApprovals() {
	const seq = (approvalsRequestSeq += 1);
	let response = null;
	try {
		response = await api("/api/approvals");
	} catch {
		response = null;
	}
	if (seq !== approvalsRequestSeq) return;
	if (!response) {
		state.approvals.status = "unavailable";
		state.approvals.items = [];
		state.approvals.total = 0;
		return;
	}
	if (response.status === 403) {
		state.approvals.status = "forbidden";
		state.approvals.items = [];
		state.approvals.total = 0;
		return;
	}
	if (!response.ok) {
		state.approvals.status = "unavailable";
		state.approvals.items = [];
		state.approvals.total = 0;
		return;
	}
	const data = await response.json().catch(() => null);
	if (seq !== approvalsRequestSeq) return;
	const items = Array.isArray(data?.items) ? data.items : null;
	if (!items) {
		state.approvals.status = "unavailable";
		state.approvals.items = [];
		state.approvals.total = 0;
		return;
	}
	state.approvals.status = "ready";
	state.approvals.items = items;
	state.approvals.total = Number.isFinite(data?.total) ? data.total : items.length;
}

/** 轮询拉一次并重画：待办是别的会话挂起的，列表与等待时长都要跟着变。 */
async function pollApprovals() {
	if (state.module !== "approvals" || !state.approvals.auto) return;
	await refreshApprovals();
	if (state.module === "approvals") renderModuleView();
}

/** 手动「刷新」：清掉上一次操作的提示，再整页重画。 */
async function refreshApprovalsPage() {
	state.approvals.notice = null;
	await refreshApprovals();
	if (state.module === "approvals") renderModuleView();
}

function stopApprovalsPolling() {
	if (state.approvals.timer) clearInterval(state.approvals.timer);
	state.approvals.timer = null;
	state.approvals.tick = 0;
}

function startApprovalsPolling() {
	if (!state.approvals.auto || state.approvals.timer) return;
	if (state.module !== "approvals") return;
	state.approvals.tick = 0;
	state.approvals.timer = setInterval(approvalsTick, APPROVALS_TICK_MS);
}

/** 每秒走一格：更新等待时长；每 10 格拉一次待办。标签页隐藏时整轮跳过。 */
function approvalsTick() {
	if (state.module !== "approvals") {
		stopApprovalsPolling();
		return;
	}
	if (approvalsHidden()) return;
	state.approvals.tick += 1;
	refreshApprovalWaitNodes();
	if (state.approvals.auto && state.approvals.tick >= APPROVALS_POLL_MS / APPROVALS_TICK_MS) {
		state.approvals.tick = 0;
		void pollApprovals();
	}
}

/** 自动刷新开关：关掉就清定时器，打开立刻重新开始计时。 */
function setApprovalsAuto(enabled) {
	state.approvals.auto = Boolean(enabled);
	if (state.approvals.auto) startApprovalsPolling();
	else stopApprovalsPolling();
	if (state.module === "approvals") renderModuleView();
}

/** 会话标题为空时退到 sessionId 前 8 位，别在列表里摆一个空白单元格。 */
function approvalSessionText(item) {
	const title = String(item?.sessionTitle ?? "").trim();
	if (title) return title;
	const id = String(item?.sessionId ?? "");
	return id ? id.slice(0, TRACE_ID_SHORT) : "—";
}

/** 审批挂在哪个技能上：后端字段叫 workflowName，界面对用户只说「技能」。 */
function approvalSkillText(item) {
	return String(item?.workflowName ?? item?.workflowId ?? "").trim() || "—";
}

function approvalRiskLabel(risk) {
	if (risk === "high") return "高风险";
	if (risk === "medium") return "中风险";
	if (risk === "low") return "低风险";
	return risk ? String(risk) : "未知";
}

function approvalRiskClass(risk) {
	return risk === "high" || risk === "medium" || risk === "low" ? risk : "unknown";
}

/** 参数摘要：JSON 压成 key=value · key=value；嵌套值仍写 JSON，整串由调用方截断。 */
function approvalArgsFull(args) {
	if (!args || typeof args !== "object" || Array.isArray(args)) return auditDetailFull(args);
	const parts = [];
	for (const [key, value] of Object.entries(args)) {
		if (value === null || value === undefined) continue;
		parts.push(`${key}=${typeof value === "object" ? JSON.stringify(value) : String(value)}`);
	}
	const text = parts.join(" · ").replace(/\s+/g, " ").trim();
	return text || "—";
}

/** 等待时长：从 askedAt 数到现在，写成「已等待 N 秒」。 */
function approvalWaitText(askedAt, now = Date.now()) {
	const at = typeof askedAt === "number" ? askedAt : Date.parse(String(askedAt ?? ""));
	if (!Number.isFinite(at)) return "—";
	const seconds = Math.max(0, Math.floor((now - at) / 1000));
	return `已等待 ${seconds} 秒`;
}

/** 超过 60 秒标红：卡太久的审批优先处理。 */
function approvalWaitOver(askedAt, now = Date.now()) {
	const at = typeof askedAt === "number" ? askedAt : Date.parse(String(askedAt ?? ""));
	if (!Number.isFinite(at)) return false;
	return now - at > APPROVAL_WAIT_WARN_MS;
}

/** 只更新等待时长，不重画整页：每秒闪一下的表格会让人没法点按钮。 */
function refreshApprovalWaitNodes() {
	if (state.module !== "approvals") return;
	for (const node of Array.from(els.modulePage.querySelectorAll(".approval-wait"))) {
		const askedAt = Number(node.dataset.askedAt);
		node.textContent = approvalWaitText(askedAt);
		node.classList.toggle("over", approvalWaitOver(askedAt));
		node.title = `请求时间：${formatDateTime(askedAt)}`;
	}
}

function setApprovalsNotice(text, isError) {
	state.approvals.notice = text ? { text, error: Boolean(isError) } : null;
}

function approvalNoticeNode() {
	const notice = state.approvals.notice;
	if (!notice) return null;
	return make("div", notice.error ? "module-notice err" : "module-notice", notice.text);
}

function removeApprovalItem(sessionId, requestId) {
	state.approvals.items = state.approvals.items.filter(
		(item) => !(String(item.sessionId) === sessionId && String(item.requestId) === requestId),
	);
	state.approvals.total = Math.max(0, state.approvals.total - 1);
}

/** 权限不够时把按钮置灰并说清原因；真拦截仍在后端（403 文案会原样显示）。 */
function guardApprovalDecision(button) {
	if (canRunSessions()) return button;
	button.disabled = true;
	button.title = APPROVAL_DENY_TITLE;
	return button;
}

/** 批准 / 拒绝：成功后从列表移除；409 说明已被别处处理，刷新队列。 */
async function decideApproval(item, approved) {
	if (!canRunSessions() || state.approvals.loading) return;
	const sessionId = String(item?.sessionId ?? "");
	const requestId = String(item?.requestId ?? "");
	if (!sessionId || !requestId) return;
	state.approvals.loading = true;
	let result;
	try {
		result = await requestJson(`/api/approvals/${encodeURIComponent(sessionId)}`, "POST", { requestId, approved });
	} finally {
		state.approvals.loading = false;
	}
	const action = approved ? "批准" : "拒绝";
	if (result.ok) {
		removeApprovalItem(sessionId, requestId);
		setApprovalsNotice(`已${action}「${item.toolName ?? "这次调用"}」的请求。`, false);
		if (state.module === "approvals") renderModuleView();
		return;
	}
	if (result.status === 409) {
		// 别处已经批过 / 拒过：不报错，提示一句并刷新，列表会自己少掉这条
		setApprovalsNotice("这条审批已经处理过了", true);
		await refreshApprovals();
		if (state.module === "approvals") renderModuleView();
		return;
	}
	if (result.status === 403) {
		setApprovalsNotice(result.data?.error ?? APPROVAL_DENY_TITLE, true);
		if (state.module === "approvals") renderModuleView();
		return;
	}
	setApprovalsNotice(requestError(result, `${action}审批失败`), true);
	if (state.module === "approvals") renderModuleView();
}

/** 「去会话」：切回对话模块并打开这条审批所在的会话。 */
async function openApprovalSession(item) {
	const sessionId = String(item?.sessionId ?? "");
	if (!sessionId) return;
	if (state.module !== "chat") await switchModule("chat");
	try {
		await openSession(sessionId);
	} catch {
		addNotice("打开会话失败：这个会话可能已经被删除了。", true);
	}
}

function approvalTableNode(items) {
	const wrap = make("div", "module-table-wrap");
	const table = make("table", "module-table approval-table");
	const thead = make("thead", "module-table-head");
	const headRow = make("tr", "module-table-row");
	for (const label of ["会话", "技能", "工具", "风险", "参数", "等待", "操作"]) {
		headRow.appendChild(make("th", "module-th", label));
	}
	thead.appendChild(headRow);
	table.appendChild(thead);

	const tbody = make("tbody", "module-table-body");
	for (const item of items) {
		const row = make("tr", "module-table-row approval-row");
		row.dataset.sessionId = String(item?.sessionId ?? "");
		row.dataset.requestId = String(item?.requestId ?? "");

		const sessionCell = make("td", "module-td approval-session");
		sessionCell.appendChild(make("span", "approval-session-title", approvalSessionText(item)));
		if (item?.archived) sessionCell.appendChild(make("span", "approval-archived", "已归档"));
		sessionCell.title = String(item?.sessionId ?? "");
		row.appendChild(sessionCell);

		row.appendChild(make("td", "module-td approval-skill", approvalSkillText(item)));

		const toolCell = make("td", "module-td approval-tool", String(item?.toolName ?? "—"));
		toolCell.title = String(item?.toolName ?? "");
		row.appendChild(toolCell);

		const riskCell = make("td", "module-td approval-risk-cell");
		const riskBadge = make(
			"span",
			`approval-risk ${approvalRiskClass(item?.risk)}`,
			approvalRiskLabel(item?.risk),
		);
		riskBadge.title = `风险等级：${item?.risk ?? "未知"}`;
		riskCell.appendChild(riskBadge);
		row.appendChild(riskCell);

		const full = approvalArgsFull(item?.args);
		const argsCell = make("td", "module-td approval-args", truncateText(full, APPROVAL_ARGS_MAX));
		if (full.length > APPROVAL_ARGS_MAX) argsCell.title = full;
		row.appendChild(argsCell);

		const askedAt = Number(item?.askedAt);
		const waitCell = make("td", "module-td approval-wait", approvalWaitText(askedAt));
		waitCell.dataset.askedAt = String(askedAt);
		waitCell.classList.toggle("over", approvalWaitOver(askedAt));
		waitCell.title = `请求时间：${formatDateTime(askedAt)}`;
		row.appendChild(waitCell);

		const actions = make("td", "module-td approval-actions");
		const approve = guardApprovalDecision(make("button", "link-btn approval-approve", "批准"));
		approve.setAttribute("type", "button");
		approve.addEventListener("click", () => void decideApproval(item, true));
		const reject = guardApprovalDecision(make("button", "link-btn approval-reject", "拒绝"));
		reject.setAttribute("type", "button");
		reject.addEventListener("click", () => void decideApproval(item, false));
		const open = make("button", "link-btn approval-open", "去会话");
		open.setAttribute("type", "button");
		open.title = String(item?.sessionId ?? "");
		open.addEventListener("click", () => void openApprovalSession(item));
		actions.appendChild(approve);
		actions.appendChild(reject);
		actions.appendChild(open);
		row.appendChild(actions);
		tbody.appendChild(row);
	}
	table.appendChild(tbody);
	wrap.appendChild(table);
	return wrap;
}

function approvalsEmptyNode() {
	const empty = make("div", "approval-empty");
	empty.appendChild(make("p", "approval-empty__title", "当前没有待处理的审批"));
	empty.appendChild(
		make(
			"p",
			"approval-empty__text",
			"高风险工具调用需要人工放行：模型调用这类工具时会在这里排队，批准后它继续执行。不放心就先看参数，再决定批不批。",
		),
	);
	return empty;
}

function renderApprovalsModule(body, spec) {
	if (state.approvals.status === "forbidden") {
		body.appendChild(moduleDeniedNode("当前角色不能查看审批队列", "查看待办需要 session.read 权限。"));
		return;
	}
	if (state.approvals.status === "unknown") {
		body.appendChild(make("div", "placeholder", "正在加载待办审批…"));
		return;
	}
	if (state.approvals.status !== "ready") {
		// 404 / 连不上：保留说明 + 「未接入」徽标 + 接口清单，不摆假待办
		renderNotConnectedModule(body, spec);
		return;
	}
	body.appendChild(
		make(
			"p",
			"module-page__lead",
			"高风险工具调用会同步挂起，等人工在这里放行；自动刷新每 10 秒拉一次，切走模块就停，系统标签页隐藏时暂停。",
		),
	);
	if (!canRunSessions()) {
		body.appendChild(make("p", "approval-perm-hint", "当前角色不能处理审批（需要 session.run），这一页只能看。"));
	}
	const notice = approvalNoticeNode();
	if (notice) body.appendChild(notice);

	const items = state.approvals.items;
	if (items.length === 0) {
		body.appendChild(approvalsEmptyNode());
	} else {
		const head = make("div", "module-section-head");
		head.appendChild(make("h3", "module-section-heading", `待处理（${items.length}）`));
		head.appendChild(make("span", "module-section-hint", "先问先显示"));
		body.appendChild(head);
		body.appendChild(approvalTableNode(items));
	}
	body.appendChild(
		make(
			"p",
			"module-page__hint",
			"审批是同步挂起的：拒绝只会让这一次工具调用失败，会话本身继续跑，你可以接着追问或换个方式办。",
		),
	);
}

/* ---- 成员 ---- */

async function refreshMembers() {
	let response = null;
	try {
		response = await api("/api/auth/users");
	} catch {
		response = null;
	}
	if (!response) {
		state.members.status = "unavailable";
		state.members.items = [];
		return;
	}
	// 403 = 角色不够（不是"没接入"）：整页说清楚，别让用户以为后端没这功能
	if (response.status === 403) {
		state.members.status = "forbidden";
		state.members.items = [];
		return;
	}
	if (!response.ok) {
		state.members.status = "unavailable";
		state.members.items = [];
		return;
	}
	const data = await response.json().catch(() => null);
	// 后端现役是 { items }，任务书契约写的是 { users }：两种形状都认
	const items = Array.isArray(data?.items) ? data.items : Array.isArray(data?.users) ? data.users : null;
	if (!items) {
		state.members.status = "unavailable";
		state.members.items = [];
		return;
	}
	state.members.status = "ready";
	state.members.items = items;
}

function memberName(user) {
	const name = String(user?.name ?? "").trim();
	return name || "—";
}

/** 角色一律显示中文：后端给了 roleLabel 就用它，没有就查本地映射（两边同一套四角色）。 */
function memberRoleText(user) {
	const label = user?.roleLabel ?? roleLabel(user?.role);
	return label || "—";
}

function membersTableNode(items) {
	const wrap = make("div", "module-table-wrap");
	const table = make("table", "module-table");
	const thead = make("thead", "module-table-head");
	const headRow = make("tr", "module-table-row");
	for (const label of ["姓名", "邮箱", "角色", "状态", "最近登录", "操作"]) {
		headRow.appendChild(make("th", "module-th", label));
	}
	thead.appendChild(headRow);
	table.appendChild(thead);

	const tbody = make("tbody", "module-table-body");
	for (const item of items) {
		const row = make("tr", "module-table-row member-row");
		row.dataset.userId = String(item.id ?? "");
		if (memberIsSelf(item)) row.classList.add("member-self");
		row.appendChild(make("td", "module-td member-name", memberName(item)));
		row.appendChild(make("td", "module-td member-email", item.email ?? "—"));
		row.appendChild(make("td", "module-td member-role", memberRoleText(item)));

		const statusCell = make("td", "module-td member-status");
		const disabled = item.disabled === true;
		statusCell.appendChild(make("span", disabled ? "member-badge off" : "member-badge on", disabled ? "已停用" : "正常"));
		row.appendChild(statusCell);

		const loginCell = make("td", "module-td member-login", formatRelativeTime(item.lastLoginAt));
		if (item.lastLoginAt === undefined) loginCell.title = "接口没返回最近登录时间";
		row.appendChild(loginCell);
		row.appendChild(memberActionsCell(item));
		tbody.appendChild(row);
	}
	table.appendChild(tbody);
	wrap.appendChild(table);
	return wrap;
}

/** 当前登录用户自己那一行：后端不允许改自己的角色 / 状态，前端先置灰说明。 */
function memberIsSelf(user) {
	const meId = state.me?.user?.id;
	return Boolean(meId) && String(user?.id ?? "") === String(meId);
}

/** 不能操作这一行的原因（空串 = 可以操作）：没权限优先于"不能改自己"。 */
function memberActionTitle(user) {
	if (!canManageMembers()) return "当前角色不能管理成员";
	if (memberIsSelf(user)) return "不能修改自己的角色或状态";
	return "";
}

function guardMemberAction(button, user) {
	const reason = memberActionTitle(user);
	if (reason) {
		button.disabled = true;
		button.title = reason;
	}
	return button;
}

function memberActionsCell(user) {
	const actions = make("td", "module-td member-actions");

	const roleBtn = guardMemberAction(make("button", "link-btn member-role-btn", "改角色"), user);
	roleBtn.setAttribute("type", "button");
	roleBtn.addEventListener("click", () => openMemberRoleDialog(user));
	actions.appendChild(roleBtn);

	const disabled = user?.disabled === true;
	const toggle = guardMemberAction(make("button", "link-btn member-toggle", disabled ? "启用" : "停用"), user);
	toggle.setAttribute("type", "button");
	toggle.addEventListener("click", () => void toggleMember(user));
	actions.appendChild(toggle);

	const remove = guardMemberAction(make("button", "link-btn member-delete", "删除"), user);
	remove.setAttribute("type", "button");
	remove.addEventListener("click", () => void deleteMember(user));
	actions.appendChild(remove);
	return actions;
}

function setMemberNotice(text, isError) {
	state.members.notice = text ? { text, error: Boolean(isError) } : null;
}

function memberNoticeNode() {
	const notice = state.members.notice;
	if (!notice) return null;
	return make("div", notice.error ? "module-notice err" : "module-notice", notice.text);
}

/** 改角色：下拉四个中文角色，PATCH { role }；失败文案（400/404）显示在弹窗里。 */
function openMemberRoleDialog(user) {
	if (memberActionTitle(user)) return;
	const role = memberRoleField(user?.role ?? "developer");
	role.select.classList.add("member-form-role");
	const body = make("div", "kb-form");
	body.appendChild(role.node);
	body.appendChild(make("p", "kb-bind-hint", "改完立即生效：本人下一次请求就按新角色校验，旧令牌不用重登。"));
	openKbDialog({
		title: `修改角色 · ${memberName(user)}`,
		body,
		saveLabel: "保存",
		save: async () => {
			const value = String(role.select.value ?? "");
			const result = await requestJson(`/api/auth/users/${encodeURIComponent(user.id)}`, "PATCH", { role: value });
			if (!result.ok) {
				// 后端的中文文案（角色不合法 / 成员不存在 / 不能改自己）原样显示
				setKbDialogError(requestError(result, "修改角色失败"));
				return false;
			}
			await refreshMembers();
			setMemberNotice(`已把 ${memberName(user)} 的角色改为「${roleLabel(value)}」。`, false);
			if (state.module === "members") renderModuleView();
			return true;
		},
	});
}

/** 停用 / 启用：PATCH { disabled: !current }，按钮文案跟着当前状态走。 */
async function toggleMember(user) {
	if (memberActionTitle(user)) return;
	const target = user?.disabled !== true;
	const result = await requestJson(`/api/auth/users/${encodeURIComponent(user.id)}`, "PATCH", {
		disabled: target,
	});
	if (!result.ok) {
		setMemberNotice(requestError(result, target ? "停用成员失败" : "启用成员失败"), true);
		if (state.module === "members") renderModuleView();
		return;
	}
	await refreshMembers();
	setMemberNotice(
		target ? `已停用 ${memberName(user)}，其旧令牌会立即失效。` : `已启用 ${memberName(user)}。`,
		false,
	);
	if (state.module === "members") renderModuleView();
}

/** 删除：二次确认写清不可恢复；成功后刷新列表。 */
async function deleteMember(user) {
	if (memberActionTitle(user)) return;
	if (
		!confirm(
			`确定删除成员「${memberName(user)} / ${user?.email ?? "—"}」？\n\n会删掉这个账号，删除后不可恢复；该账号的旧令牌会立即失效。`,
		)
	) {
		return;
	}
	const result = await requestJson(`/api/auth/users/${encodeURIComponent(user.id)}`, "DELETE");
	if (!result.ok) {
		setMemberNotice(requestError(result, "删除成员失败"), true);
		if (state.module === "members") renderModuleView();
		return;
	}
	await refreshMembers();
	setMemberNotice(`已删除成员 ${memberName(user)}。`, false);
	if (state.module === "members") renderModuleView();
}

function renderMembersModule(body, spec) {
	if (state.members.status === "forbidden") {
		body.appendChild(moduleDeniedNode("当前角色不能管理成员", "成员名单与新建成员只对所有者开放。"));
		return;
	}
	if (state.members.status !== "ready") {
		// 接口 404 / 连不上：回落到原来的空态（说明 + 未接入 + 接口清单），不摆假表格
		renderNotConnectedModule(body, spec);
		return;
	}
	body.appendChild(
		make("p", "module-page__lead", "成员按角色分权限：所有者管成员，开发者写技能，运营跑会话，审计员只看记录。"),
	);
	const notice = memberNoticeNode();
	if (notice) body.appendChild(notice);
	if (state.members.items.length === 0) {
		const empty = canManageMembers() ? "还没有成员，点右上角「＋ 新建成员」加一个。" : "还没有成员。";
		body.appendChild(make("div", "placeholder", empty));
		return;
	}
	body.appendChild(membersTableNode(state.members.items));
	body.appendChild(make("p", "module-page__hint", `共 ${state.members.items.length} 位成员。`));
}

/** 新建成员：邮箱 / 密码 / 姓名（可选）/ 角色，提交 POST /api/auth/users。 */
function openNewMemberDialog() {
	// 按钮置灰时点不到，这里再兜一层：别让"没权限也能弹出表单"留下错觉
	if (!canManageMembers() || state.members.status === "forbidden") return;
	const email = kbField("邮箱", "", 120, "name@company.com");
	const password = kbField("密码", "", 64, "至少 6 位", { type: "password" });
	const name = kbField("姓名（可选）", "", 40, "例如：李工");
	const role = memberRoleField("developer");
	const body = make("div", "kb-form");
	for (const field of [email, password, name, role]) body.appendChild(field.node);
	body.appendChild(make("p", "kb-bind-hint", "创建后把邮箱和初始密码给到本人，让他自己登录。"));
	openKbDialog({
		title: "新建成员",
		body,
		saveLabel: "创建",
		save: async () => {
			const payload = {
				email: String(email.input.value ?? "").trim(),
				password: String(password.input.value ?? ""),
				role: String(role.select.value ?? "developer"),
			};
			if (!payload.email) {
				setKbDialogError("填一下邮箱。");
				return false;
			}
			if (!payload.password) {
				setKbDialogError("填一下密码。");
				return false;
			}
			// 姓名可选：空着就不发这个字段（后端按"没填"处理），别发一个空串
			const nameValue = String(name.input.value ?? "").trim();
			if (nameValue) payload.name = nameValue;

			let response = null;
			try {
				response = await api("/api/auth/users", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(payload),
				});
			} catch {
				response = null;
			}
			if (!response) {
				setKbDialogError("连不上服务，稍后再试。");
				return false;
			}
			const data = await response.json().catch(() => null);
			if (!response.ok) {
				// 后端的中文文案（邮箱已存在 / 密码太短 / 角色不合法）原样显示在弹窗里
				setKbDialogError(data?.error ?? `创建失败（HTTP ${response.status}）`);
				return false;
			}
			await refreshMembers();
			if (state.module === "members") renderModuleView();
			addNotice(`已添加成员 ${data?.user?.email ?? payload.email}。`);
			return true;
		},
	});
}

/** 角色下拉：四个角色都用中文，默认给权限最小的「开发者」。 */
function memberRoleField(value) {
	const wrap = make("label", "kb-field");
	wrap.appendChild(make("span", "kb-field-label", "角色"));
	const select = make("select", "kb-field-input");
	for (const [role, label] of Object.entries(ROLE_LABELS)) {
		const option = make("option", "", label);
		option.value = role;
		select.appendChild(option);
	}
	select.value = value;
	wrap.appendChild(select);
	return { node: wrap, select };
}

/* ---- 审计 ---- */

// 并发请求只让最新那次落地：慢请求晚回来不能覆盖后一次筛选的结果
let auditRequestSeq = 0;

async function refreshAudit(options = {}) {
	const reset = options.reset !== false;
	const seq = (auditRequestSeq += 1);
	const offset = reset ? 0 : state.audit.items.length;
	state.audit.loading = true;
	// 手拼 query：前端跑在浏览器里，但单测的 vm 沙盒没有 URLSearchParams，别依赖它
	const params = [`limit=${AUDIT_PAGE_SIZE}`, `offset=${offset}`];
	const action = state.audit.action.trim();
	const actor = state.audit.actor.trim();
	if (action) params.push(`action=${encodeURIComponent(action)}`);
	if (actor) params.push(`actor=${encodeURIComponent(actor)}`);
	let response = null;
	try {
		response = await api(`/api/audit?${params.join("&")}`);
	} catch {
		response = null;
	}
	if (seq !== auditRequestSeq) return;
	state.audit.loading = false;
	if (response?.status === 403) {
		state.audit.status = "forbidden";
		state.audit.items = [];
		state.audit.total = 0;
		return;
	}
	if (!response || !response.ok) {
		state.audit.status = "unavailable";
		if (reset) {
			state.audit.items = [];
			state.audit.total = 0;
		}
		return;
	}
	const data = await response.json().catch(() => null);
	const items = Array.isArray(data?.items) ? data.items : null;
	if (!items) {
		state.audit.status = "unavailable";
		if (reset) {
			state.audit.items = [];
			state.audit.total = 0;
		}
		return;
	}
	state.audit.status = "ready";
	state.audit.items = reset ? items : [...state.audit.items, ...items];
	state.audit.total = Number.isFinite(data?.total) ? data.total : state.audit.items.length;
}

/** 筛选框防抖：停手 300ms 再查，避免每敲一个字打一次接口。 */
let auditSearchTimer = null;
function scheduleAuditRefresh() {
	if (auditSearchTimer) clearTimeout(auditSearchTimer);
	auditSearchTimer = setTimeout(() => {
		auditSearchTimer = null;
		void runAuditSearch();
	}, AUDIT_DEBOUNCE_MS);
}

async function runAuditSearch() {
	await refreshAudit({ reset: true });
	if (state.module !== "audit") return;
	// 403 / 接口掉了要整页换形态，别留着筛选框；正常就只换结果区（否则输入框会被重建、焦点丢掉）
	if (state.audit.status !== "ready") renderModuleView();
	else refreshAuditResults();
}

async function loadMoreAudit() {
	if (state.audit.loading || state.audit.items.length >= state.audit.total) return;
	await refreshAudit({ reset: false });
	if (state.module !== "audit") return;
	if (state.audit.status !== "ready") renderModuleView();
	else refreshAuditResults();
}

/** 只重画结果区：输入框保持原样，用户连续打字不会被抢焦点。 */
function refreshAuditResults() {
	const box = els.modulePage.querySelector(".audit-results");
	if (!box) return;
	box.innerHTML = "";
	fillAuditResults(box);
}

function auditActorText(item) {
	const id = item?.actorId ? String(item.actorId) : "";
	if (item?.actorType === "system" || !id) return id ? `系统 · ${id}` : "系统";
	if (item.actorType === "user") {
		const known = state.members.items.find((user) => user.id === id);
		const role = known?.role ?? (state.me?.user?.id === id ? state.me.user.role : null);
		return `${role ? roleLabel(role) : "成员"} · ${id}`;
	}
	return `${item.actorType} · ${id}`;
}

function auditTargetText(item) {
	const type = item?.targetType ? String(item.targetType) : "";
	const id = item?.targetId ? String(item.targetId) : "";
	if (type && id) return `${type} · ${id}`;
	return type || id || "—";
}

/**
 * 详情摘要：审计详情基本都是扁平对象，写成 `key=value · key=value`——
 * 有空格才有断行机会，不会像 JSON 那样把单词劈成两半；嵌套对象仍退回 JSON。
 */
function auditDetailFull(detail) {
	if (detail === null || detail === undefined || detail === "") return "—";
	if (typeof detail === "object" && !Array.isArray(detail)) {
		const parts = [];
		for (const [key, value] of Object.entries(detail)) {
			if (value === null || value === undefined) continue;
			parts.push(`${key}=${typeof value === "object" ? JSON.stringify(value) : String(value)}`);
		}
		if (parts.length > 0) {
			const text = parts.join(" · ").replace(/\s+/g, " ").trim();
			return text || "—";
		}
	}
	let text;
	try {
		text = typeof detail === "string" ? detail : JSON.stringify(detail);
	} catch {
		text = String(detail);
	}
	return String(text ?? "").replace(/\s+/g, " ").trim() || "—";
}

function auditTableNode(items) {
	const wrap = make("div", "module-table-wrap");
	const table = make("table", "module-table audit-table");
	const thead = make("thead", "module-table-head");
	const headRow = make("tr", "module-table-row");
	for (const label of ["时间", "操作者", "动作", "目标", "详情", "traceId"]) headRow.appendChild(make("th", "module-th", label));
	thead.appendChild(headRow);
	table.appendChild(thead);

	const tbody = make("tbody", "module-table-body");
	for (const item of items) {
		const row = make("tr", "module-table-row audit-row");
		row.dataset.auditId = String(item?.id ?? "");
		row.appendChild(make("td", "module-td audit-time", formatDateTime(item?.createdAt)));
		row.appendChild(make("td", "module-td audit-actor", auditActorText(item)));
		row.appendChild(make("td", "module-td audit-action", item?.action ?? "—"));
		row.appendChild(make("td", "module-td audit-target", auditTargetText(item)));

		const full = auditDetailFull(item?.detail);
		const detailCell = make("td", "module-td audit-detail", truncateText(full, AUDIT_DETAIL_MAX));
		if (full.length > AUDIT_DETAIL_MAX) detailCell.title = full;
		row.appendChild(detailCell);

		const traceCell = make("td", "module-td audit-trace");
		const traceId = item?.traceId ? String(item.traceId) : "";
		if (traceId) {
			const copy = make("button", "link-btn audit-trace-btn", traceId);
			copy.setAttribute("type", "button");
			copy.title = "点击复制 traceId";
			copy.addEventListener("click", () => void copyText(traceId, copy, "已复制"));
			traceCell.appendChild(copy);
		} else {
			traceCell.textContent = "—";
		}
		row.appendChild(traceCell);
		tbody.appendChild(row);
	}
	table.appendChild(tbody);
	wrap.appendChild(table);
	return wrap;
}

function auditFilterNode() {
	const box = make("div", "audit-filter");
	const action = kbField("动作关键字", state.audit.action, 60, "要写全名，例如 user.create / http.post");
	const actor = kbField("操作者", state.audit.actor, 60, "用户 id，例如 u-1");
	action.node.classList.add("audit-field");
	actor.node.classList.add("audit-field");
	// 后端 /api/audit 的 action / actor 都是精确匹配：说明白，免得用户以为"输两个字就能搜"
	action.input.title = "后端按动作全名精确匹配";
	actor.input.title = "后端按操作者 id 精确匹配";
	const bind = (input, key) => {
		input.addEventListener("input", () => {
			state.audit[key] = String(input.value ?? "");
			scheduleAuditRefresh();
		});
	};
	bind(action.input, "action");
	bind(actor.input, "actor");
	box.appendChild(action.node);
	box.appendChild(actor.node);
	box.appendChild(make("span", "audit-filter__hint", `每页 ${AUDIT_PAGE_SIZE} 条 · 筛选按全名精确匹配`));
	return box;
}

function fillAuditResults(container) {
	if (state.audit.items.length === 0) {
		if (state.audit.loading) {
			container.appendChild(make("div", "placeholder", "正在加载…"));
			return;
		}
		// 有筛选条件时说"没匹配上"，别让用户以为整个审计是空的
		const filtered = Boolean(state.audit.action.trim() || state.audit.actor.trim());
		container.appendChild(
			make("div", "placeholder", filtered ? "没有匹配的审计记录，换个筛选条件试试" : "还没有审计记录"),
		);
		return;
	}
	container.appendChild(auditTableNode(state.audit.items));
	const foot = make("div", "audit-foot");
	foot.appendChild(make("span", "audit-foot__hint", `已显示 ${state.audit.items.length} / ${state.audit.total} 条`));
	const more = make("button", "btn-ghost mini audit-more", "加载更多");
	more.setAttribute("type", "button");
	if (state.audit.items.length >= state.audit.total) {
		more.disabled = true;
		more.title = "已经到底了";
	}
	more.addEventListener("click", () => void loadMoreAudit());
	foot.appendChild(more);
	container.appendChild(foot);
}

function renderAuditModule(body, spec) {
	if (state.audit.status === "forbidden") {
		body.appendChild(moduleDeniedNode("当前角色不能查看审计记录", "所有者与审计员可以查看审计记录。"));
		return;
	}
	if (state.audit.status !== "ready") {
		renderNotConnectedModule(body, spec);
		return;
	}
	body.appendChild(auditFilterNode());
	const results = make("div", "audit-results");
	body.appendChild(results);
	fillAuditResults(results);
}

/* ---------------- 监控（P9）：范围聚合 / 分组用量 / 调用链与事件时间轴 ---------------- */

const MONITOR_RANGE_LABELS = { "1h": "最近 1 小时", "24h": "最近 24 小时", "7d": "最近 7 天" };
// 并发请求只让最新那次落地：连点范围或刷新时，慢请求晚回来不能盖掉当前窗口
let monitorSummarySeq = 0;
let monitorTraceSeq = 0;

/** 后端数字字段可能缺省：缺了按 0 渲染，别把 undefined 印到界面上。 */
function monitorNumber(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** summary 归一到前端好画的形状：数组缺失当空表，数字缺失当 0。 */
function normalizeMonitorSummary(raw) {
	const data = raw && typeof raw === "object" ? raw : {};
	const sessions = data.sessions && typeof data.sessions === "object" ? data.sessions : {};
	const toolCalls = data.toolCalls && typeof data.toolCalls === "object" ? data.toolCalls : {};
	const listOf = (value, shape) =>
		Array.isArray(value) ? value.map((item) => shape(item && typeof item === "object" ? item : {})) : [];
	return {
		sessions: { total: monitorNumber(sessions.total), active24h: monitorNumber(sessions.active24h) },
		messages24h: monitorNumber(data.messages24h),
		toolCalls: {
			total: monitorNumber(toolCalls.total),
			ok: monitorNumber(toolCalls.ok),
			failed: monitorNumber(toolCalls.failed),
			avgMs: monitorNumber(toolCalls.avgMs),
		},
		skills: listOf(data.skills, (item) => ({ id: String(item.id ?? ""), calls: monitorNumber(item.calls) })),
		mcp: listOf(data.mcp, (item) => ({
			server: String(item.server ?? ""),
			calls: monitorNumber(item.calls),
			failed: monitorNumber(item.failed),
		})),
		model: listOf(data.model, (item) => ({
			model: String(item.model ?? ""),
			calls: monitorNumber(item.calls),
			avgMs: monitorNumber(item.avgMs),
		})),
		errors: monitorNumber(data.errors),
		p95Ms: monitorNumber(data.p95Ms),
	};
}

/** 耗时统一中文单位：不到 1 秒写毫秒，1 分钟内写秒（保留一位小数），更长写分秒。 */
function formatDurationMs(value) {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "—";
	if (value < 1000) return `${Math.round(value)} 毫秒`;
	const seconds = value / 1000;
	if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} 秒`;
	const minutes = Math.floor(seconds / 60);
	const rest = Math.round(seconds % 60);
	return `${minutes} 分 ${rest} 秒`;
}

/** 成功率：没有调用时写「—」，整百分比不带小数点，其余保留一位。 */
function formatPercent(ok, total) {
	if (!Number.isFinite(ok) || !Number.isFinite(total) || total <= 0) return "—";
	const percent = (ok / total) * 100;
	return `${Number.isInteger(percent) ? String(percent) : percent.toFixed(1)}%`;
}

/** traceId / 会话 id 在列表里只露前 8 位，完整值挂 title。 */
function shortId(value) {
	const text = String(value ?? "");
	return text ? text.slice(0, TRACE_ID_SHORT) : "—";
}

/** 调用链 payload 摘要：复用审计的 key=value 压平逻辑，完整内容由调用方挂 title。 */
function tracePayloadFull(payload) {
	return auditDetailFull(payload);
}

/**
 * summary 拉取。404 / 连不上 → 「未接入」；403 = 角色不够，整页说权限（不混进「未接入」）。
 * range 用当前选中的窗口，切范围时只有一个请求会真正落地。
 */
async function refreshMonitorSummary() {
	const seq = (monitorSummarySeq += 1);
	const range = state.monitor.range;
	let response = null;
	try {
		response = await api(`/api/monitor/summary?range=${encodeURIComponent(range)}`);
	} catch {
		response = null;
	}
	if (seq !== monitorSummarySeq || range !== state.monitor.range) return;
	if (!response) {
		state.monitor.status = "unavailable";
		state.monitor.summary = null;
		return;
	}
	if (response.status === 403) {
		state.monitor.status = "forbidden";
		state.monitor.summary = null;
		return;
	}
	if (!response.ok) {
		state.monitor.status = "unavailable";
		state.monitor.summary = null;
		return;
	}
	const data = await response.json().catch(() => null);
	// sessions / toolCalls 是 KPI 的骨架：缺了就当接口没接好，别画一排 0 骗人
	if (!data || typeof data !== "object" || !data.sessions || !data.toolCalls) {
		state.monitor.status = "unavailable";
		state.monitor.summary = null;
		return;
	}
	state.monitor.status = "ready";
	state.monitor.summary = normalizeMonitorSummary(data);
}

/** 调用链列表：reset = 从第一页重拉，否则按当前条数当 offset 追加。 */
async function refreshMonitorTraces(options = {}) {
	const reset = options.reset !== false;
	const seq = (monitorTraceSeq += 1);
	const offset = reset ? 0 : state.monitor.traces.length;
	state.monitor.loading = true;
	let response = null;
	try {
		response = await api(`/api/monitor/traces?limit=${MONITOR_TRACE_PAGE_SIZE}&offset=${offset}`);
	} catch {
		response = null;
	}
	if (seq !== monitorTraceSeq) return;
	state.monitor.loading = false;
	if (response?.status === 403) {
		state.monitor.tracesStatus = "forbidden";
		state.monitor.traces = [];
		state.monitor.total = 0;
		return;
	}
	if (!response || !response.ok) {
		state.monitor.tracesStatus = "unavailable";
		if (reset) {
			state.monitor.traces = [];
			state.monitor.total = 0;
		}
		return;
	}
	const data = await response.json().catch(() => null);
	const items = Array.isArray(data?.items) ? data.items : null;
	if (!items) {
		state.monitor.tracesStatus = "unavailable";
		if (reset) {
			state.monitor.traces = [];
			state.monitor.total = 0;
		}
		return;
	}
	state.monitor.tracesStatus = "ready";
	state.monitor.traces = reset ? items : [...state.monitor.traces, ...items];
	state.monitor.total = Number.isFinite(data?.total) ? data.total : state.monitor.traces.length;
}

/** 进监控页 / 点刷新：先 summary 再 traces；summary 都没接上就不白打调用链接口。 */
async function refreshMonitor() {
	await refreshMonitorSummary();
	if (state.monitor.status !== "ready") {
		state.monitor.tracesStatus = "unavailable";
		state.monitor.traces = [];
		state.monitor.total = 0;
		state.monitor.detail = null;
		return;
	}
	state.monitor.detail = null;
	await refreshMonitorTraces({ reset: true });
}

/** 范围切换：先跟手换选中态，再只重拉 summary（调用链列表不按 range 过滤）。 */
async function setMonitorRange(range) {
	const value = String(range ?? "");
	if (!MONITOR_RANGES.includes(value) || state.monitor.range === value) return;
	state.monitor.range = value;
	if (state.module === "monitor") renderModuleView();
	await refreshMonitorSummary();
	if (state.module === "monitor") renderModuleView();
}

/** 页头刷新按钮：聚合与调用链一起重拉。 */
async function reloadMonitor() {
	await refreshMonitor();
	if (state.module === "monitor") renderModuleView();
}

async function loadMoreMonitorTraces() {
	if (state.monitor.loading || state.monitor.traces.length >= state.monitor.total) return;
	await refreshMonitorTraces({ reset: false });
	if (state.module === "monitor") renderModuleView();
}

/**
 * 点开一条调用链：请求详情后直接在调用链列表下方展开时间轴。
 * 详情接口的 { error }（404「调用链不存在」/ 403 文案）原样显示，不吞成通用失败。
 */
async function openTraceDetail(traceId) {
	const id = String(traceId ?? "");
	if (!id) return;
	state.monitor.detail = { traceId: id, status: "loading", trace: null, events: [], error: "" };
	if (state.module === "monitor") renderModuleView();

	let response = null;
	try {
		response = await api(`/api/monitor/traces/${encodeURIComponent(id)}`);
	} catch {
		response = null;
	}
	// 期间用户点了别的行或切走了：旧请求的结果不能再盖回来
	if (state.monitor.detail?.traceId !== id) return;
	if (!response) {
		state.monitor.detail = { traceId: id, status: "error", trace: null, events: [], error: "连不上服务，稍后再试" };
	} else {
		const data = await response.json().catch(() => null);
		if (response.status === 403) {
			state.monitor.detail = {
				traceId: id,
				status: "forbidden",
				trace: null,
				events: [],
				error: data?.error ?? "当前角色不能查看这条调用链",
			};
		} else if (!response.ok) {
			state.monitor.detail = {
				traceId: id,
				status: "error",
				trace: null,
				events: [],
				error: data?.error ?? `调用链加载失败（HTTP ${response.status}）`,
			};
		} else if (!data || !data.trace) {
			state.monitor.detail = { traceId: id, status: "error", trace: null, events: [], error: "接口没有返回调用链详情" };
		} else {
			// 后端已按 seq 升序；前端再排一次，时间轴顺序不依赖出参的隐含约定
			const events = Array.isArray(data.events) ? [...data.events] : [];
			events.sort((left, right) => monitorNumber(left?.seq) - monitorNumber(right?.seq));
			state.monitor.detail = { traceId: id, status: "ready", trace: data.trace, events, error: "" };
		}
	}
	if (state.module === "monitor") renderModuleView();
}

function monitorToolbarNode() {
	const bar = make("div", "monitor-toolbar");
	const ranges = make("div", "monitor-ranges");
	for (const range of MONITOR_RANGES) {
		const button = make("button", "monitor-range", range);
		button.type = "button";
		button.dataset.range = range;
		const active = state.monitor.range === range;
		button.classList.toggle("active", active);
		button.setAttribute("aria-pressed", active ? "true" : "false");
		button.title = `统计${MONITOR_RANGE_LABELS[range] ?? range}`;
		button.addEventListener("click", () => void setMonitorRange(range));
		ranges.appendChild(button);
	}
	bar.appendChild(ranges);
	bar.appendChild(
		make("span", "monitor-toolbar__hint", `统计窗口：${MONITOR_RANGE_LABELS[state.monitor.range] ?? state.monitor.range}`),
	);
	const refresh = make("button", "btn-ghost mini monitor-refresh", "刷新");
	refresh.type = "button";
	refresh.title = "重新拉取聚合与调用链";
	refresh.addEventListener("click", () => void reloadMonitor());
	bar.appendChild(refresh);
	return bar;
}

function monitorKpiCard(id, label, value, note) {
	const card = make("div", "monitor-kpi-card");
	card.dataset.kpi = id;
	card.appendChild(make("span", "monitor-kpi-label", label));
	card.appendChild(make("span", "monitor-kpi-value", value));
	card.appendChild(make("span", "monitor-kpi-note", note));
	return card;
}

function monitorKpiNode(summary) {
	const wrap = make("div", "monitor-kpi");
	const toolCalls = summary.toolCalls;
	const rangeText = MONITOR_RANGE_LABELS[state.monitor.range] ?? state.monitor.range;
	const hasCalls = toolCalls.total > 0;
	wrap.appendChild(
		monitorKpiCard("sessions", "会话", `${summary.sessions.total} 个`, `24h 活跃 ${summary.sessions.active24h} 个`),
	);
	wrap.appendChild(monitorKpiCard("messages", "消息数", `${summary.messages24h} 条`, `${rangeText}内的消息`));
	wrap.appendChild(
		monitorKpiCard(
			"tools",
			"工具调用",
			`${toolCalls.total} 次`,
			`成功 ${toolCalls.ok} · 失败 ${toolCalls.failed}`,
		),
	);
	wrap.appendChild(
		monitorKpiCard(
			"success",
			"工具成功率",
			formatPercent(toolCalls.ok, toolCalls.total),
			hasCalls ? "成功 / 总调用" : "范围内没有工具调用",
		),
	);
	wrap.appendChild(
		monitorKpiCard("avg", "平均耗时", hasCalls ? formatDurationMs(toolCalls.avgMs) : "—", "工具调用平均耗时"),
	);
	wrap.appendChild(
		monitorKpiCard("p95", "P95 耗时", hasCalls ? formatDurationMs(summary.p95Ms) : "—", "95% 的调用快于它"),
	);
	wrap.appendChild(monitorKpiCard("errors", "错误数", `${summary.errors} 次`, "本范围内的失败记录"));
	return wrap;
}

/** 分组表统一外壳：标题 + 条数 + 数据表（空表写「还没有数据」）。 */
function monitorGroupNode(id, title, items, headers, rowBuilder) {
	const group = make("section", `monitor-group monitor-group--${id}`);
	group.dataset.group = id;
	const head = make("div", "module-section-head");
	head.appendChild(make("h3", "module-section-heading", title));
	head.appendChild(make("span", "monitor-group-count", `${items.length} 项`));
	group.appendChild(head);
	if (items.length === 0) {
		group.appendChild(make("div", "placeholder monitor-group-empty", "还没有数据"));
		return group;
	}
	const wrap = make("div", "module-table-wrap");
	const table = make("table", `module-table monitor-group-table monitor-${id}-table`);
	const thead = make("thead", "module-table-head");
	const headRow = make("tr", "module-table-row");
	for (const label of headers) headRow.appendChild(make("th", "module-th", label));
	thead.appendChild(headRow);
	table.appendChild(thead);
	const tbody = make("tbody", "module-table-body");
	for (const item of items) tbody.appendChild(rowBuilder(item));
	table.appendChild(tbody);
	wrap.appendChild(table);
	group.appendChild(wrap);
	return group;
}

/** 按调用次数倒序；夹具/接口顺序不作数。 */
function monitorSortByCalls(items) {
	return [...items].sort((left, right) => monitorNumber(right?.calls) - monitorNumber(left?.calls));
}

function monitorGroupsNode(summary) {
	const wrap = make("div", "monitor-groups");
	wrap.appendChild(
		monitorGroupNode(
			"skills",
			"技能调用",
			monitorSortByCalls(summary.skills),
			["技能", "调用次数"],
			(item) => {
				const row = make("tr", "module-table-row monitor-skill-row");
				row.dataset.skillId = item.id;
				row.appendChild(make("td", "module-td monitor-skill-id", item.id || "—"));
				row.appendChild(make("td", "module-td monitor-skill-calls", `${monitorNumber(item.calls)} 次`));
				return row;
			},
		),
	);
	wrap.appendChild(
		monitorGroupNode(
			"mcp",
			"MCP 服务",
			monitorSortByCalls(summary.mcp),
			["服务", "调用次数", "失败次数"],
			(item) => {
				const row = make("tr", "module-table-row monitor-mcp-row");
				row.dataset.server = item.server;
				row.appendChild(make("td", "module-td monitor-mcp-server", item.server || "—"));
				row.appendChild(make("td", "module-td monitor-mcp-calls", `${monitorNumber(item.calls)} 次`));
				row.appendChild(make("td", "module-td monitor-mcp-failed", `${monitorNumber(item.failed)} 次`));
				return row;
			},
		),
	);
	wrap.appendChild(
		monitorGroupNode(
			"model",
			"模型调用",
			monitorSortByCalls(summary.model),
			["模型", "调用次数", "平均耗时"],
			(item) => {
				const row = make("tr", "module-table-row monitor-model-row");
				row.dataset.model = item.model;
				row.appendChild(make("td", "module-td monitor-model-name", item.model || "—"));
				row.appendChild(make("td", "module-td monitor-model-calls", `${monitorNumber(item.calls)} 次`));
				row.appendChild(make("td", "module-td monitor-model-avg", formatDurationMs(item.avgMs)));
				return row;
			},
		),
	);
	return wrap;
}

function monitorTraceStatusBadge(status) {
	if (status === "ok") return make("span", "trace-status-badge ok", "成功");
	if (status === "error") return make("span", "trace-status-badge error", "失败");
	if (status === "running") return make("span", "trace-status-badge running", "进行中");
	return make("span", "trace-status-badge unknown", "未知");
}

function monitorTraceTableNode() {
	const wrap = make("div", "module-table-wrap");
	const table = make("table", "module-table monitor-trace-table");
	const thead = make("thead", "module-table-head");
	const headRow = make("tr", "module-table-row");
	for (const label of ["时间", "调用链", "会话", "状态", "耗时", "模型", "工具数"]) {
		headRow.appendChild(make("th", "module-th", label));
	}
	thead.appendChild(headRow);
	table.appendChild(thead);

	const tbody = make("tbody", "module-table-body");
	for (const trace of state.monitor.traces) {
		const traceId = String(trace?.traceId ?? "");
		const sessionId = String(trace?.sessionId ?? "");
		const row = make("tr", "module-table-row trace-row");
		row.dataset.traceId = traceId;
		row.tabIndex = 0;
		const selected = state.monitor.detail?.traceId === traceId;
		if (selected) row.classList.add("active");
		row.setAttribute("aria-expanded", selected ? "true" : "false");
		row.appendChild(make("td", "module-td trace-time", formatDateTime(trace?.startedAt)));

		const idCell = make("td", "module-td trace-id-cell");
		if (traceId) {
			const copy = make("button", "link-btn trace-copy", shortId(traceId));
			copy.type = "button";
			copy.title = `${traceId}（点击复制完整调用链 id）`;
			copy.addEventListener("click", (event) => {
				// 复制不能顺带把详情打开：行上也有 click 监听
				event.stopPropagation();
				void copyText(traceId, copy, "已复制");
			});
			idCell.appendChild(copy);
		} else {
			idCell.textContent = "—";
		}
		row.appendChild(idCell);

		const sessionCell = make("td", "module-td trace-session", sessionId ? shortId(sessionId) : "—");
		if (sessionId) sessionCell.title = sessionId;
		row.appendChild(sessionCell);

		const statusCell = make("td", "module-td trace-status-cell");
		statusCell.appendChild(monitorTraceStatusBadge(trace?.status));
		row.appendChild(statusCell);

		const ms = typeof trace?.ms === "number" && Number.isFinite(trace.ms) ? trace.ms : null;
		row.appendChild(make("td", "module-td trace-ms", ms === null ? "进行中" : formatDurationMs(ms)));
		row.appendChild(make("td", "module-td trace-model", trace?.model ?? "—"));
		row.appendChild(make("td", "module-td trace-tools", `${monitorNumber(trace?.toolCount)} 个`));

		row.addEventListener("click", () => void openTraceDetail(traceId));
		row.addEventListener("keydown", (event) => {
			if (event.key !== "Enter" && event.key !== " ") return;
			event.preventDefault?.();
			void openTraceDetail(traceId);
		});
		tbody.appendChild(row);
	}
	table.appendChild(tbody);
	wrap.appendChild(table);
	return wrap;
}

function monitorTraceFootNode() {
	const foot = make("div", "monitor-traces-foot");
	foot.appendChild(
		make("span", "monitor-traces-foot__hint", `已显示 ${state.monitor.traces.length} / ${state.monitor.total} 条`),
	);
	const more = make("button", "btn-ghost mini monitor-more", "加载更多");
	more.type = "button";
	if (state.monitor.loading) {
		more.disabled = true;
		more.textContent = "加载中…";
	} else if (state.monitor.traces.length >= state.monitor.total) {
		more.disabled = true;
		more.title = "已经到底了";
	}
	more.addEventListener("click", () => void loadMoreMonitorTraces());
	foot.appendChild(more);
	return foot;
}

function traceEventNode(event) {
	const item = make("li", "trace-event");
	const seq = monitorNumber(event?.seq);
	const kind = String(event?.kind ?? "unknown");
	item.dataset.seq = String(seq);
	item.appendChild(make("span", "trace-event-seq", `#${seq}`));
	// kind 只来自后端的固定枚举；class 里再滤一次，别让脏数据带出奇怪选择器
	item.appendChild(make("span", `trace-kind kind-${kind.replace(/[^a-z0-9_-]/gi, "")}`, kind));
	item.appendChild(make("span", "trace-event-name", String(event?.name ?? "—")));
	if (event?.ok === true) item.appendChild(make("span", "trace-event-ok ok", "成功"));
	else if (event?.ok === false) item.appendChild(make("span", "trace-event-ok error", "失败"));
	else item.appendChild(make("span", "trace-event-ok unknown", "—"));
	item.appendChild(
		make("span", "trace-event-ms", event?.ms === null || event?.ms === undefined ? "—" : formatDurationMs(event.ms)),
	);
	const full = tracePayloadFull(event?.payload);
	const payload = make("span", "trace-event-payload", truncateText(full, TRACE_PAYLOAD_MAX));
	payload.title = full;
	item.appendChild(payload);
	return item;
}

/** 调用链详情：页内下方展开（选中行高亮），时间轴按 seq 升序。 */
function traceDetailNode() {
	const detail = state.monitor.detail;
	const wrap = make("section", "trace-detail");
	wrap.dataset.traceId = detail.traceId;
	const head = make("div", "trace-detail-head");
	head.appendChild(make("h3", "trace-detail-title", "调用链详情"));
	head.appendChild(make("code", "trace-detail-id", detail.traceId));
	const close = make("button", "link-btn trace-detail-close", "关闭");
	close.type = "button";
	close.title = "收起调用链详情";
	close.addEventListener("click", () => {
		state.monitor.detail = null;
		if (state.module === "monitor") renderModuleView();
	});
	head.appendChild(close);
	wrap.appendChild(head);

	if (detail.status === "loading") {
		wrap.appendChild(make("div", "placeholder trace-detail-loading", "正在加载调用链…"));
		return wrap;
	}
	if (detail.status !== "ready") {
		wrap.appendChild(make("p", "trace-detail-error", detail.error || "调用链加载失败"));
		return wrap;
	}

	const trace = detail.trace ?? {};
	const meta = make("p", "trace-detail-meta");
	const ms = typeof trace.ms === "number" && Number.isFinite(trace.ms) ? trace.ms : null;
	meta.appendChild(make("span", "trace-detail-meta__item", `开始 ${formatDateTime(trace.startedAt)}`));
	meta.appendChild(make("span", "trace-detail-meta__item", `耗时 ${ms === null ? "进行中" : formatDurationMs(ms)}`));
	meta.appendChild(make("span", "trace-detail-meta__item", `模型 ${trace.model ?? "—"}`));
	meta.appendChild(make("span", "trace-detail-meta__item", `工具 ${monitorNumber(trace.toolCount)} 个`));
	wrap.appendChild(meta);
	if (trace.error) wrap.appendChild(make("p", "trace-detail-error", String(trace.error)));

	if (detail.events.length === 0) {
		wrap.appendChild(make("div", "placeholder trace-timeline-empty", "这条调用链没有记录到事件。"));
		return wrap;
	}
	const list = make("ol", "trace-timeline");
	for (const event of detail.events) list.appendChild(traceEventNode(event));
	wrap.appendChild(list);
	return wrap;
}

function monitorTracesNode() {
	const section = make("section", "monitor-traces");
	const head = make("div", "module-section-head");
	head.appendChild(make("h3", "module-section-heading", "调用链"));
	if (state.monitor.tracesStatus === "ready") {
		head.appendChild(make("span", "monitor-traces-count", `共 ${state.monitor.total} 条`));
	}
	section.appendChild(head);

	if (state.monitor.tracesStatus === "forbidden") {
		section.appendChild(
			moduleDeniedNode("当前角色不能查看审计记录", "调用链需要审计查看权限，请联系所有者开通后再看。"),
		);
		return section;
	}
	if (state.monitor.tracesStatus === "unavailable") {
		section.appendChild(make("div", "placeholder monitor-traces-empty", "调用链接口未接入，稍后再试。"));
		return section;
	}
	if (state.monitor.traces.length === 0) {
		section.appendChild(
			make(
				"div",
				"placeholder monitor-traces-empty",
				state.monitor.loading ? "正在加载…" : "还没有调用链，发一条消息后这里就会出现。",
			),
		);
		return section;
	}
	section.appendChild(monitorTraceTableNode());
	section.appendChild(monitorTraceFootNode());
	if (state.monitor.detail) section.appendChild(traceDetailNode());
	return section;
}

function renderMonitorModule(body, spec) {
	if (state.monitor.status === "forbidden") {
		body.appendChild(moduleDeniedNode("当前角色不能查看监控数据", "监控聚合需要会话查看权限（session.read）。"));
		return;
	}
	if (state.monitor.status !== "ready" || !state.monitor.summary) {
		// 404 / 连不上：保留原来的说明 + 「未接入」徽标 + 接口清单，不摆假 KPI
		renderNotConnectedModule(body, spec);
		return;
	}
	body.appendChild(monitorToolbarNode());
	body.appendChild(
		make(
			"p",
			"module-page__lead",
			"每一轮对话是一条调用链：先看 KPI 定位范围，再点开下面任意一行，看模型、工具、技能、MCP 与审批各自花了多久。",
		),
	);
	body.appendChild(monitorKpiNode(state.monitor.summary));
	body.appendChild(monitorGroupsNode(state.monitor.summary));
	body.appendChild(monitorTracesNode());
}

/* ---------------- 知识库（P5）：库列表 / 文档 / 检索试跑 ---------------- */

// 「设为对话默认」是写操作：没有 workflow.write 时置灰，真正拦截在后端（PUT 回 403）
const KB_DEFAULT_WRITE_TITLE = "当前角色不能修改知识库（需要 workflow.write）";

/**
 * 拉库列表。后端还没上线时这里会 404 —— 那时整页回落到「未接入」空态，
 * 不弹错误、也不摆假表格（用户会把假数据当成能用的功能）。
 */
async function refreshKb() {
	const libraries = await fetchJsonOrNull("/api/kb");
	if (!Array.isArray(libraries)) {
		state.kb.status = "unavailable";
		state.kb.libraries = [];
		state.kb.documents = [];
		return;
	}
	state.kb.status = "ready";
	state.kb.libraries = libraries;
	state.kb.embedding = await fetchJsonOrNull("/api/kb/embedding");
	if (!libraries.some((lib) => lib.id === state.kb.selectedId)) state.kb.selectedId = libraries[0]?.id ?? null;
	if (state.kb.selectedId) {
		const docs = await fetchJsonOrNull(`/api/kb/${encodeURIComponent(state.kb.selectedId)}/documents`);
		state.kb.documents = Array.isArray(docs) ? docs : [];
	} else {
		state.kb.documents = [];
	}
}

/** 只重拉库列表：上传/删文档后文档数变了，但别动选中的库与文档列表。 */
async function refreshKbCounts() {
	const libraries = await fetchJsonOrNull("/api/kb");
	if (Array.isArray(libraries)) state.kb.libraries = libraries;
}

async function selectKbLibrary(id) {
	if (!id) return;
	state.kb.selectedId = id;
	state.kb.search = null;
	const docs = await fetchJsonOrNull(`/api/kb/${encodeURIComponent(id)}/documents`);
	state.kb.documents = Array.isArray(docs) ? docs : [];
	if (state.module === "knowledge") renderModuleView();
}

function formatBytes(bytes) {
	const size = Number(bytes) || 0;
	if (size < 1024) return `${size} B`;
	if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
	return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function renderKnowledgeModule(body, spec) {
	if (state.kb.status !== "ready") {
		// 兜底就是之前那套空态：说明 + 「未接入」徽标 + 接口清单
		renderNotConnectedModule(body, spec);
		return;
	}
	body.appendChild(kbEmbeddingNode());
	const notice = kbNoticeNode();
	if (notice) body.appendChild(notice);
	// 一个库都没有时，两栏布局里全是占位符，看着像坏了；直接给一张能动手的空态卡
	if (state.kb.libraries.length === 0) {
		body.appendChild(kbEmptyState());
		return;
	}
	const layout = make("div", "kb-layout");
	layout.appendChild(kbListColumn());
	layout.appendChild(kbMainColumn());
	body.appendChild(layout);
}

/** 空态：说清知识库是干什么的，并把「新建」放成主按钮（列表头那个「＋」太小，新人看不见）。 */
function kbEmptyState() {
	const box = make("div", "kb-empty");
	box.appendChild(make("h3", "kb-empty__title", "还没有知识库"));
	box.appendChild(
		make(
			"p",
			"kb-empty__text",
			"知识库是给 Agent 用的资料夹：把产品手册、客服话术、政策条款放进去，它在对话里需要时会先检索这些段落，再据此回答。",
		),
	);
	const add = make("button", "btn-primary", "新建知识库");
	add.setAttribute("type", "button");
	add.addEventListener("click", () => openNewKbDialog());
	box.appendChild(add);
	box.appendChild(
		make("p", "kb-empty__hint", "建好后可以到「技能」页把它绑给某个技能，让模型加载技能时优先查这里。"),
	);
	return box;
}

/** 顶部状态：语义检索有没有配好，直接决定检索走向量还是关键词。
 *  第二行单独说「对话检索」——那是"对话不加载技能时查哪几个库"，跟向量检索不是一回事，别混成一句。 */
function kbEmbeddingNode() {
	const embedding = state.kb.embedding;
	const enabled = Boolean(embedding?.available);
	const line = make("div", "kb-status");
	line.classList.toggle("on", enabled);
	line.appendChild(make("span", "kb-status__badge", enabled ? "语义检索" : "关键词检索"));
	line.appendChild(
		make(
			"span",
			"kb-status__text",
			enabled
				? `语义检索：${embedding.model ?? "已启用"}——按意思找段落，措辞不一样也能召回`
				: "语义检索未启用：按字面词匹配（到「模型」页选一条「向量」模型就能开启语义检索）",
		),
	);

	const defaultCount = defaultKbLibraries().length;
	const defaults = make("span", "kb-status__text kb-status__defaults");
	defaults.classList.toggle("on", defaultCount > 0);
	// 数据来自 /api/kb 每行的 isDefault；开关就在下面每个库一行的「设为对话默认」上
	const summary =
		defaultCount > 0
			? `对话检索：已启用 ${defaultCount} 个库——不加载技能时，对话会直接在这几个库里检索`
			: "对话检索：未启用——不加载技能时对话不会查知识库（在下面勾选「设为对话默认」即可开启）";
	defaults.textContent = summary;
	defaults.title = defaultCount > 0
		? `${defaultKbLibraries().map((lib) => lib.name ?? lib.id).join("、")}`
		: "勾选任一知识库的「设为对话默认」，对话就能直接用它的内容回答";
	line.appendChild(defaults);
	return line;
}

/** 「对话默认检索」的库：GET /api/kb 每行的 isDefault 是唯一真相，前端不另存一份。 */
function defaultKbLibraries() {
	return state.kb.libraries.filter((lib) => lib.isDefault === true);
}

/** 知识库页的操作提示（对话框外那句）：成功绿、失败红，只画在页面里。 */
function setKbNotice(text, isError) {
	state.kb.notice = text ? { text, error: Boolean(isError) } : null;
}

function kbNoticeNode() {
	const notice = state.kb.notice;
	if (!notice) return null;
	return make("div", notice.error ? "module-notice err kb-defaults-notice" : "module-notice kb-defaults-notice", notice.text);
}

/** PUT /api/kb/defaults 是覆盖式：每次都把"当前所有勾选的库"整体提交，而不是只提被点的那一个。 */
async function saveKbDefaults(kbIds) {
	if (state.kb.savingDefaults) return;
	state.kb.savingDefaults = true;
	const result = await requestJson("/api/kb/defaults", "PUT", { kbIds });
	state.kb.savingDefaults = false;
	if (!result.ok) {
		// 后端 { error } 中文原样给用户；重画一遍让开关退回服务端的真实状态（别留下"看起来已开"的错觉）
		setKbNotice(requestError(result, "保存对话默认检索失败"), true);
		if (state.module === "knowledge") renderModuleView();
		return;
	}
	const saved = Array.isArray(result.data?.kbIds) ? result.data.kbIds : kbIds;
	const count = saved.length;
	setKbNotice(
		count > 0
			? `已设为对话默认检索：${count} 个知识库（不加载技能时对话会直接查它们）。`
			: "已关闭对话默认检索：不加载技能时对话不会再查知识库。",
		false,
	);
	await refreshKb();
	if (state.module === "knowledge") renderModuleView();
}

function kbListColumn() {
	const col = make("div", "kb-list");
	const head = make("div", "kb-list-head");
	head.appendChild(make("span", "kb-list-title", "知识库"));
	const add = make("button", "icon-btn kb-list-add", "＋");
	add.setAttribute("type", "button");
	add.title = "新建知识库";
	add.addEventListener("click", () => openNewKbDialog());
	head.appendChild(add);
	col.appendChild(head);

	if (state.kb.libraries.length === 0) {
		col.appendChild(make("div", "placeholder", "还没有知识库，点右上角 ＋ 建一个，再上传文档。"));
		return col;
	}
	for (const lib of state.kb.libraries) {
		const row = make("div", "kb-item");
		row.dataset.kbId = lib.id;
		row.setAttribute("role", "button");
		row.tabIndex = 0;
		if (lib.id === state.kb.selectedId) row.classList.add("active");
		const nameNode = make("span", "kb-item-name", lib.name ?? lib.id);
		nameNode.title = lib.name ?? lib.id;
		row.appendChild(nameNode);
		row.appendChild(make("span", "kb-item-meta", `${lib.docCount ?? 0} 文档 · ${lib.chunkCount ?? 0} 块`));
		row.appendChild(kbDefaultToggle(lib));
		row.addEventListener("click", () => void selectKbLibrary(lib.id));
		row.addEventListener("keydown", (event) => {
			if (event.key !== "Enter" && event.key !== " ") return;
			event.preventDefault();
			void selectKbLibrary(lib.id);
		});
		col.appendChild(row);
	}
	return col;
}

/** 每个库一行的「设为对话默认」开关：数据只信 GET /api/kb 的 isDefault，勾选状态不在前端缓存。 */
function kbDefaultToggle(lib) {
	const label = make("label", "kb-default");
	label.title = `对话不加载技能时也查这个库：勾上后，会话里问到的相关内容会直接从「${lib.name ?? lib.id}」里找。`;
	const box = make("input", "kb-default__box");
	box.type = "checkbox";
	box.value = lib.id;
	box.checked = lib.isDefault === true;
	box.setAttribute("aria-label", `把「${lib.name ?? lib.id}」设为对话默认检索`);
	// 只读的角色也能看状态：置灰 + title 说明原因，真正的拦截在后端（PUT 回 403）
	if (!canWriteWorkflow()) {
		box.disabled = true;
		box.title = KB_DEFAULT_WRITE_TITLE;
		label.title = KB_DEFAULT_WRITE_TITLE;
	}
	box.addEventListener("change", () => {
		if (!canWriteWorkflow()) return;
		// 覆盖式接口：以"勾选后的完整集合"为准，而不是被测库的布尔值
		const kbIds = [];
		for (const item of state.kb.libraries) {
			if (item.id === lib.id) {
				if (box.checked) kbIds.push(item.id);
			} else if (item.isDefault === true) {
				kbIds.push(item.id);
			}
		}
		void saveKbDefaults(kbIds);
	});
	// 行本身是"选中这个库"的按钮：点开关（含文字）不该顺带切换右边详情，也不该触发行的键盘处理
	label.addEventListener("click", (event) => event.stopPropagation());
	label.addEventListener("keydown", (event) => event.stopPropagation());
	label.appendChild(box);
	label.appendChild(make("span", "kb-default__text", "设为对话默认"));
	return label;
}

function currentKbLibrary() {
	return state.kb.libraries.find((lib) => lib.id === state.kb.selectedId) ?? null;
}

function kbMainColumn() {
	const main = make("div", "kb-main");
	const lib = currentKbLibrary();
	if (!lib) {
		main.appendChild(make("div", "placeholder", "左边还没有选中的知识库。"));
		return main;
	}

	const head = make("div", "kb-main-head");
	const titleBox = make("div", "kb-main-title");
	titleBox.appendChild(make("h3", "kb-main-name", lib.name ?? lib.id));
	const chunks = Number(lib.chunkCount ?? 0);
	const metaText =
		state.kb.embedding?.available && chunks > 0
			? `${lib.docCount ?? 0} 文档 · ${chunks} 块 · 已向量化 ${lib.embeddedChunkCount ?? 0}/${chunks}`
			: `${lib.docCount ?? 0} 文档 · ${chunks} 块`;
	titleBox.appendChild(make("div", "kb-main-meta", metaText));
	head.appendChild(titleBox);
	// 操作区单独包一层：窄屏整行换行时两个按钮一起下去，别把标题挤成一字一行
	const actions = make("div", "kb-main-actions");
	const reindex = make("button", "btn-ghost mini", "重新向量化");
	reindex.setAttribute("type", "button");
	reindex.title = "用当前向量化配置把整库分块重算一遍（补 key 后让旧文档也能语义检索）";
	reindex.disabled = !state.kb.embedding?.available || chunks === 0;
	reindex.addEventListener("click", () => void reindexKbLibrary(lib));
	actions.appendChild(reindex);
	const del = make("button", "btn-ghost mini danger", "删除知识库");
	del.setAttribute("type", "button");
	del.title = "连这个库的文档和分块一起删掉，不可恢复";
	del.addEventListener("click", () => void deleteKbLibrary(lib));
	actions.appendChild(del);
	head.appendChild(actions);
	main.appendChild(head);
	if (lib.description) main.appendChild(make("p", "kb-desc", lib.description));

	// 语义检索开着、但库里还有块没向量：这批块只能被关键词命中，得显眼地说清楚并给一键补齐
	const missingVectors = state.kb.embedding?.available ? Math.max(0, chunks - Number(lib.embeddedChunkCount ?? 0)) : 0;
	if (missingVectors > 0) {
		const banner = make("div", "kb-reembed");
		const body = make("div", "kb-reembed__body");
		body.appendChild(make("span", "kb-reembed__badge", "待补齐"));
		body.appendChild(
			make(
				"p",
				"kb-reembed__text",
				`有 ${missingVectors} 个块还没有向量（共 ${chunks} 块），语义检索暂时命中不到它们；补齐后按意思也能召回。`,
			),
		);
		banner.appendChild(body);
		const fix = make("button", "btn-primary mini kb-reembed__fix", `补齐向量（${missingVectors} 块）`);
		fix.setAttribute("type", "button");
		fix.addEventListener("click", () => void reindexKbLibrary(lib));
		banner.appendChild(fix);
		main.appendChild(banner);
	}

	const uploadRow = make("div", "kb-upload");
	const uploading = Boolean(state.kb.uploading);
	const upload = make("button", "btn-primary mini", uploading ? "上传中…" : "上传文档");
	upload.setAttribute("type", "button");
	upload.disabled = uploading;
	upload.title = "支持 .txt / .md / .csv / .pdf / .docx";
	upload.addEventListener("click", () => els.kbFile.click());
	uploadRow.appendChild(upload);
	uploadRow.appendChild(make("span", "kb-upload-hint", "支持 .txt / .md / .csv / .pdf / .docx，上传后自动解析分块。"));
	main.appendChild(uploadRow);

	main.appendChild(kbDocsTable());
	main.appendChild(kbSearchNode());
	return main;
}

function kbDocsTable() {
	const wrap = make("div", "kb-table-wrap");
	const table = make("table", "kb-table");
	const thead = make("thead", "kb-table-head");
	const headRow = make("tr", "kb-table-row");
	for (const label of ["文件名", "大小", "状态", "块数", ""]) headRow.appendChild(make("th", "kb-th", label));
	thead.appendChild(headRow);
	table.appendChild(thead);

	const tbody = make("tbody", "kb-table-body");
	if (state.kb.documents.length === 0) {
		const row = make("tr", "kb-table-row");
		const cell = make("td", "kb-td kb-td-empty", "还没有文档，点上面的「上传文档」加一个。");
		cell.colSpan = 5;
		row.appendChild(cell);
		tbody.appendChild(row);
	}
	for (const doc of state.kb.documents) {
		const row = make("tr", "kb-table-row kb-doc-row");
		row.dataset.docId = doc.id;
		const nameCell = make("td", "kb-td kb-td-name", doc.filename ?? doc.id);
		nameCell.title = doc.filename ?? doc.id;
		row.appendChild(nameCell);
		row.appendChild(make("td", "kb-td kb-td-size", formatBytes(doc.bytes)));

		const statusCell = make("td", "kb-td kb-td-status");
		const ready = doc.status === "ready";
		statusCell.appendChild(make("span", ready ? "kb-badge on" : "kb-badge err", ready ? "已就绪" : "解析失败"));
		if (doc.error) statusCell.appendChild(make("span", "kb-doc-error", doc.error));
		row.appendChild(statusCell);

		row.appendChild(make("td", "kb-td kb-td-chunks", String(doc.chunkCount ?? 0)));

		const actionCell = make("td", "kb-td kb-td-actions");
		const del = make("button", "link-btn", "删除");
		del.setAttribute("type", "button");
		del.addEventListener("click", () => void deleteKbDocument(doc));
		actionCell.appendChild(del);
		row.appendChild(actionCell);
		tbody.appendChild(row);
	}
	table.appendChild(tbody);
	wrap.appendChild(table);
	return wrap;
}

function renderKbSearchResults(badge, container, data) {
	badge.textContent = "";
	badge.classList.remove("on");
	container.innerHTML = "";
	if (!data) {
		container.appendChild(make("div", "placeholder", "输入一句话点「检索」，看看能召回哪些段落。"));
		return;
	}
	const vector = data.mode === "vector";
	badge.textContent = vector ? "语义检索" : "关键词检索";
	badge.classList.toggle("on", vector);
	const list = Array.isArray(data.results) ? data.results : [];
	if (list.length === 0) {
		container.appendChild(make("div", "placeholder", "没检索到相关段落，换个说法再试。"));
		return;
	}
	for (const result of list) {
		const item = make("div", "kb-result");
		const head = make("div", "kb-result-head");
		head.appendChild(make("span", "kb-result-heading", result.heading ?? "（无标题）"));
		head.appendChild(
			make("span", "kb-result-score", typeof result.score === "number" ? result.score.toFixed(2) : ""),
		);
		item.appendChild(head);
		item.appendChild(make("p", "kb-result-snippet", result.snippet ?? ""));
		container.appendChild(item);
	}
}

function kbSearchNode() {
	const box = make("div", "kb-search");
	box.appendChild(make("div", "kb-section-title", "检索试跑（只在当前知识库里找）"));
	const row = make("div", "kb-search-row");
	const input = make("input", "kb-search-input");
	input.type = "search";
	input.placeholder = "输入一句话，看看能不能召回到相关段落";
	const button = make("button", "btn-primary mini kb-search-run", "检索");
	button.setAttribute("type", "button");
	const badge = make("span", "kb-search-badge", "");
	const results = make("div", "kb-results");

	const run = async () => {
		const query = String(input.value ?? "").trim();
		if (!query || !state.kb.selectedId) return;
		button.disabled = true;
		const data = await fetchJsonOrNull(`/api/kb/${encodeURIComponent(state.kb.selectedId)}/search`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ query, topK: 5 }),
		});
		button.disabled = false;
		state.kb.search = data ?? { mode: "keyword", results: [] };
		if (!data) addNotice("检索没成功：后端没接住这次请求。", true);
		renderKbSearchResults(badge, results, state.kb.search);
	};
	state.kb.searchRun = run;
	button.addEventListener("click", () => void run());
	input.addEventListener("keydown", (event) => {
		if (event.key !== "Enter") return;
		event.preventDefault();
		void run();
	});

	row.appendChild(input);
	row.appendChild(button);
	row.appendChild(badge);
	box.appendChild(row);
	renderKbSearchResults(badge, results, state.kb.search);
	box.appendChild(results);
	return box;
}

/* ---- 知识库小弹窗（新建库 / 技能绑定库共用） ---- */

function kbField(label, value, maxLength, placeholder, options = {}) {
	const wrap = make("label", "kb-field");
	wrap.appendChild(make("span", "kb-field-label", label));
	const input = make("input", "kb-field-input");
	// 密码框也走同一个字段：类型可选，默认文本（新建成员要 type=password）
	input.type = options.type ?? "text";
	input.value = value ?? "";
	input.maxLength = maxLength;
	input.placeholder = placeholder ?? "";
	wrap.appendChild(input);
	return { node: wrap, input };
}

function openKbDialog({ title, body, save, saveLabel }) {
	state.kbDialog = { save };
	els.kbModalTitle.textContent = title;
	els.kbModalBody.innerHTML = "";
	els.kbModalBody.appendChild(body);
	els.kbError.textContent = "";
	els.kbError.hidden = true;
	els.kbSave.textContent = saveLabel ?? "保存";
	els.kbSave.disabled = false;
	els.kbModal.hidden = false;
}

function closeKbDialog() {
	els.kbModal.hidden = true;
	els.kbModalBody.innerHTML = "";
	els.kbError.hidden = true;
	state.kbDialog = null;
}

function setKbDialogError(message) {
	els.kbError.textContent = message ?? "";
	els.kbError.hidden = !message;
}

async function submitKbDialog() {
	if (!state.kbDialog) return;
	els.kbSave.disabled = true;
	let ok = false;
	try {
		ok = await state.kbDialog.save();
	} catch {
		setKbDialogError("保存失败，稍后再试。");
	}
	els.kbSave.disabled = false;
	if (ok) closeKbDialog();
}

function openNewKbDialog() {
	const name = kbField("名称", "", 40, "例如：产品文档 / 客服话术");
	const desc = kbField("说明（可选）", "", 200, "这个库放什么资料");
	const body = make("div", "kb-form");
	body.appendChild(name.node);
	body.appendChild(desc.node);
	openKbDialog({
		title: "新建知识库",
		body,
		save: async () => {
			const value = String(name.input.value ?? "").trim();
			if (!value) {
				setKbDialogError("给知识库起个名字。");
				return false;
			}
			const created = await fetchJsonOrNull("/api/kb", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: value, description: String(desc.input.value ?? "").trim() }),
			});
			if (!created) {
				setKbDialogError("新建失败：后端没接住这次请求。");
				return false;
			}
			state.kb.selectedId = created.id ?? state.kb.selectedId;
			await refreshKb();
			if (state.module === "knowledge") renderModuleView();
			return true;
		},
	});
}

async function deleteKbLibrary(lib) {
	const docs = Number(lib.docCount ?? 0);
	const chunks = Number(lib.chunkCount ?? 0);
	if (!confirm(`确定删除知识库「${lib.name ?? lib.id}」？\n\n会连带删掉 ${docs} 篇文档、${chunks} 个分块，不可恢复。`)) return;
	const data = await fetchJsonOrNull(`/api/kb/${encodeURIComponent(lib.id)}`, { method: "DELETE" });
	if (!data) {
		addNotice("删除知识库失败：后端没接住这次请求。", true);
		return;
	}
	if (state.kb.selectedId === lib.id) state.kb.selectedId = null;
	await refreshKb();
	if (state.module === "knowledge") renderModuleView();
	addNotice(
		`已删除知识库「${lib.name ?? lib.id}」：${data.documentsRemoved ?? docs} 篇文档、${data.chunksRemoved ?? chunks} 个分块。`,
	);
}

async function reindexKbLibrary(lib) {
	const data = await fetchJsonOrNull(`/api/kb/${encodeURIComponent(lib.id)}/reindex`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({}),
	});
	if (!data || typeof data.chunks !== "number") {
		addNotice("重新向量化失败：后端没接住这次请求。", true);
		return;
	}
	state.kb.search = null;
	await refreshKb();
	if (state.module === "knowledge") renderModuleView();
	addNotice(`已重新向量化「${lib.name ?? lib.id}」：${data.chunks} 个分块。`);
}

async function deleteKbDocument(doc) {
	if (!confirm(`确定删除文档「${doc.filename ?? doc.id}」？它的 ${doc.chunkCount ?? 0} 个分块一起删。`)) return;
	const data = await fetchJsonOrNull(`/api/kb/documents/${encodeURIComponent(doc.id)}`, { method: "DELETE" });
	if (!data) {
		addNotice("删除文档失败：后端没接住这次请求。", true);
		return;
	}
	await selectKbLibrary(state.kb.selectedId);
	await refreshKbCounts();
	if (state.module === "knowledge") renderModuleView();
}

/** 文件 → dataURL → base64：后端要 JSON base64，不做 multipart。 */
function readFileAsDataUrl(file) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result ?? ""));
		reader.onerror = () => reject(reader.error ?? new Error("读取文件失败"));
		reader.readAsDataURL(file);
	});
}

function dataUrlToBase64(dataUrl) {
	const comma = String(dataUrl).indexOf(",");
	return comma >= 0 ? String(dataUrl).slice(comma + 1) : "";
}

async function uploadKbDocument(filename, contentBase64) {
	if (!state.kb.selectedId) return null;
	let response;
	try {
		response = await api(`/api/kb/${encodeURIComponent(state.kb.selectedId)}/documents`, {
			method: "POST",
			// 后端只认 JSON base64；这里绝不能变成 multipart/form-data
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ filename, contentBase64 }),
		});
	} catch {
		addNotice("上传失败：连不上服务，稍后再试。", true);
		return null;
	}
	const data = await response.json().catch(() => null);
	if (!response.ok) {
		// 400 是文件名/内容问题，直接把后端中文文案给用户；
		// 5xx 多半是解析失败（扫描件、加密 PDF、损坏文件），给一句人话而不是英文报错
		const reason = response.status >= 500 ? "这个文件没解析出文字（扫描件、加密或文件损坏），换个文件再试。" : data?.error;
		addNotice(`上传「${filename}」失败：${reason ?? `HTTP ${response.status}`}`, true);
		return null;
	}
	if (!data) {
		addNotice("上传失败：后端没返回结果。", true);
		return null;
	}
	await selectKbLibrary(state.kb.selectedId);
	await refreshKbCounts();
	if (state.module === "knowledge") renderModuleView();
	return data;
}

async function handleKbFilePicked() {
	const file = els.kbFile.files?.[0] ?? null;
	els.kbFile.value = "";
	if (!file || !state.kb.selectedId) return;
	// 解析是同步完成的（大文件要等几秒），按钮先变成「上传中…」并禁用，避免连点重复上传
	state.kb.uploading = true;
	if (state.module === "knowledge") renderModuleView();
	try {
		const dataUrl = await readFileAsDataUrl(file);
		const created = await uploadKbDocument(file.name, dataUrlToBase64(dataUrl));
		if (created) {
			if (created.warning) addNotice(`已上传「${file.name}」：${created.warning}`, true);
			else addNotice(`已上传「${file.name}」：${created.chunkCount ?? 0} 个分块。`);
		}
	} catch {
		addNotice("读文件失败，换一个格式再试。", true);
	} finally {
		state.kb.uploading = false;
		if (state.module === "knowledge") renderModuleView();
	}
}

/** 技能 ↔ 知识库绑定：勾选要用的库，PUT 回后端。 */
async function openSkillKbDialog(skill) {
	const libraries = await fetchJsonOrNull("/api/kb");
	if (!Array.isArray(libraries)) {
		addNotice("知识库还没接后端，暂时不能绑定。", true);
		return;
	}
	const bound = await fetchJsonOrNull(`/api/skills/${encodeURIComponent(skill.id)}/kb`);
	const boundIds = new Set(Array.isArray(bound?.kbIds) ? bound.kbIds : []);
	const body = make("div", "kb-bind");
	body.appendChild(make("p", "kb-bind-hint", `模型加载「${skill.name}」时，可以先在这些知识库里检索。`));
	const boxes = [];
	if (libraries.length === 0) {
		body.appendChild(make("div", "placeholder", "还没有知识库，先去「知识库」页建一个。"));
	}
	for (const lib of libraries) {
		const row = make("label", "kb-bind-row");
		const box = make("input", "kb-bind-box");
		box.type = "checkbox";
		box.value = lib.id;
		box.checked = boundIds.has(lib.id);
		row.appendChild(box);
		row.appendChild(make("span", "kb-bind-name", lib.name ?? lib.id));
		row.appendChild(make("span", "kb-bind-meta", `${lib.docCount ?? 0} 文档`));
		body.appendChild(row);
		boxes.push(box);
	}
	openKbDialog({
		title: `绑定知识库 · ${skill.name}`,
		body,
		save: async () => {
			const kbIds = boxes.filter((box) => box.checked).map((box) => box.value);
			const data = await fetchJsonOrNull(`/api/skills/${encodeURIComponent(skill.id)}/kb`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ kbIds }),
			});
			if (!data) {
				setKbDialogError("保存失败：后端没接住这次请求。");
				return false;
			}
			addNotice(`技能「${skill.name}」已绑定 ${kbIds.length} 个知识库。`);
			return true;
		},
	});
}

/* ---------------- 技能管理（新建 / 编辑 / 删除技能） ---------------- */

const FLOW_NAME_MAX = 40;
const FLOW_STEP_TITLE_MAX = 40;
const FLOW_STEP_HINT_MAX = 200;

async function refreshWorkflows() {
	state.workflows = await (await api("/api/workflows")).json();
	renderSidebar();
}

function setFlowError(message) {
	els.flowError.textContent = message ?? "";
	els.flowError.hidden = !message;
}

function markFlowDirty() {
	state.flowDirty = true;
	// 用户一改动就把上一次的校验/保存错误收起来，避免旧提示赖着不走
	setFlowError("");
}

function emptyFlowDraft() {
	return {
		id: null,
		builtin: false,
		name: "",
		systemPrompt: "",
		skillDescription: "",
		skillInstructions: "",
		// 新建技能默认不给步骤：技能 = 说明 + 正文，工具由模型自己按需要挑；
		// 需要固定流程的人再展开「高级」加步骤
		steps: [],
	};
}

function draftFromDetail(detail) {
	return {
		id: detail.id,
		builtin: Boolean(detail.builtin),
		name: detail.name ?? "",
		systemPrompt: detail.systemPrompt ?? "",
		// 技能文案是可选的：老流程没有 skill 字段，就当两段都空
		skillDescription: detail.skill?.description ?? "",
		skillInstructions: detail.skill?.instructions ?? "",
		steps: (detail.steps ?? []).map((step) => ({
			title: step.title ?? "",
			hint: step.hint ?? "",
			via: Array.isArray(step.via) ? [...step.via] : [],
		})),
	};
}

// 工具目录只在第一次打开编辑器时拉一次；失败就下次再试
async function ensureToolCatalog() {
	if (state.tools.length > 0) return true;
	const response = await api("/api/tools");
	if (!response.ok) return false;
	state.tools = await response.json();
	return true;
}

function groupToolsByCategory(tools) {
	const groups = new Map();
	for (const tool of tools) {
		const category = tool.category || "未分类";
		if (!groups.has(category)) groups.set(category, []);
		groups.get(category).push(tool);
	}
	return [...groups.entries()];
}

function applyFlowChrome() {
	const readonly = state.flowReadonly;
	els.flowName.disabled = readonly;
	els.flowPrompt.disabled = readonly;
	// 技能文案跟着只读：内置技能只能看，不能改
	els.flowSkillDesc.disabled = readonly;
	els.flowSkillInst.disabled = readonly;
	els.flowSave.hidden = readonly;
	els.flowAddStep.hidden = readonly;
	// 只读（内置技能）时高级区也给用户看一眼：里面是它的固定步骤
	const advanced = document.getElementById("flow-advanced");
	if (advanced) {
		advanced.hidden = false;
		if (readonly) advanced.open = true;
	}
	els.flowCancel.textContent = readonly ? "关闭" : "取消";
}

// workflow 为空 = 新建技能；内置技能默认以只读方式打开（不给保存 / 增删入口）
// options.readonly 可强制只读，options.title 换标题，options.focusSkill 把焦点送到技能文案
async function openFlowEditor(workflow, options = {}) {
	state.flowReadonly = options.readonly ?? Boolean(workflow && workflow.builtin);
	state.flowDraft = emptyFlowDraft();
	state.flowDirty = false;
	els.flowModalTitle.textContent =
		options.title ?? (workflow ? (state.flowReadonly ? "查看技能" : "编辑技能") : "新建技能");
	setFlowError("");
	applyFlowChrome();
	els.flowModal.hidden = false;
	renderFlowEditor();
	if (!workflow) {
		if (options.focusSkill) els.flowSkillDesc.focus();
		else els.flowName.focus();
	}

	const catalogOk = await ensureToolCatalog().catch(() => false);

	if (workflow) {
		try {
			const response = await api(`/api/workflows/${encodeURIComponent(workflow.id)}`);
			if (!response.ok) {
				setFlowError(`读取技能失败（HTTP ${response.status}）。`);
			} else {
				state.flowDraft = draftFromDetail(await response.json());
				state.flowDirty = false;
			}
		} catch {
			setFlowError("读取技能失败：无法连接服务，请稍后重试。");
		}
	}
	if (!catalogOk) setFlowError("工具目录加载失败，暂时选不了可用工具，请稍后重试。");
	renderFlowEditor();
}

function closeFlowEditor(force) {
	if (!force && !state.flowReadonly && state.flowDirty) {
		if (!confirm("放弃未保存的技能修改？")) return;
	}
	els.flowModal.hidden = true;
	els.flowStepsBox.innerHTML = "";
	state.flowDraft = null;
	state.flowReadonly = false;
	state.flowDirty = false;
	setFlowError("");
}

function renderFlowEditor() {
	const draft = state.flowDraft;
	if (!draft) return;
	// 只读模式下拿不到模板数据时，这里也会把已加载的字段回填
	els.flowName.value = draft.name;
	els.flowPrompt.value = draft.systemPrompt;
	els.flowSkillDesc.value = draft.skillDescription ?? "";
	els.flowSkillInst.value = draft.skillInstructions ?? "";
	// 高级区（步骤 + 系统提示）只在真有内容时展开：新技能默认就是"只写说明"的形态
	const advanced = document.getElementById("flow-advanced");
	if (advanced) advanced.open = draft.steps.length > 0;
	renderFlowStepList();
}

function renderFlowStepList() {
	const draft = state.flowDraft;
	if (!draft) return;
	els.flowStepsBox.innerHTML = "";
	if (draft.steps.length === 0) {
		els.flowStepsBox.appendChild(
			make("div", "placeholder", "没有固定步骤：模型会自己决定调哪些工具。需要按顺序强制走完时，点「＋ 添加步骤」。"),
		);
		return;
	}
	draft.steps.forEach((step, index) => {
		els.flowStepsBox.appendChild(flowStepCard(step, index));
	});
}

function flowStepCard(step, index) {
	const card = make("div", "flow-step");

	const head = make("div", "flow-step-head");
	head.appendChild(make("span", "flow-step-index", `步骤 ${index + 1}`));
	if (!state.flowReadonly) {
		const up = make("button", "mini-btn");
		up.type = "button";
		up.title = "上移";
		up.innerHTML =
			'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V6"/><path d="m6 12 6-6 6 6"/></svg>';
		up.disabled = index === 0;
		up.addEventListener("click", () => moveFlowStep(index, -1));

		const down = make("button", "mini-btn");
		down.type = "button";
		down.title = "下移";
		down.innerHTML =
			'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v13"/><path d="m6 12 6 6 6-6"/></svg>';
		down.disabled = index === state.flowDraft.steps.length - 1;
		down.addEventListener("click", () => moveFlowStep(index, 1));

		const remove = make("button", "mini-btn danger", "×");
		remove.type = "button";
		remove.title = "删除该步骤";
		remove.addEventListener("click", () => removeFlowStep(index));

		head.appendChild(up);
		head.appendChild(down);
		head.appendChild(remove);
	}
	card.appendChild(head);

	const titleField = make("label", "field");
	titleField.appendChild(make("span", "field-label", "步骤标题"));
	const titleInput = make("input", "field-input");
	titleInput.type = "text";
	titleInput.maxLength = FLOW_STEP_TITLE_MAX;
	titleInput.placeholder = "例如：查询工单";
	titleInput.autocomplete = "off";
	titleInput.spellcheck = false;
	titleInput.value = step.title;
	titleInput.disabled = state.flowReadonly;
	titleInput.addEventListener("input", () => {
		step.title = titleInput.value;
		markFlowDirty();
	});
	titleField.appendChild(titleInput);
	card.appendChild(titleField);

	const hintField = make("label", "field");
	hintField.appendChild(make("span", "field-label", "步骤提示"));
	const hintInput = make("input", "field-input");
	hintInput.type = "text";
	hintInput.maxLength = FLOW_STEP_HINT_MAX;
	hintInput.placeholder = "给模型的这一步提示（可留空）";
	hintInput.autocomplete = "off";
	hintInput.spellcheck = false;
	hintInput.value = step.hint;
	hintInput.disabled = state.flowReadonly;
	hintInput.addEventListener("input", () => {
		step.hint = hintInput.value;
		markFlowDirty();
	});
	hintField.appendChild(hintInput);
	card.appendChild(hintField);

	card.appendChild(flowStepTools(step));
	return card;
}

function flowStepTools(step) {
	const field = make("div", "field");
	const head = make("div", "field-row");
	head.appendChild(make("span", "field-label", "可用工具"));
	const counter = make("span", "field-note", `已选 ${step.via.length}`);
	head.appendChild(counter);
	field.appendChild(head);

	if (state.tools.length === 0) {
		field.appendChild(make("div", "placeholder", "工具目录未加载"));
		return field;
	}

	for (const [category, tools] of groupToolsByCategory(state.tools)) {
		const group = make("div", "tool-group");
		group.appendChild(make("div", "tool-group-label", category));
		const chips = make("div", "tool-chips");
		for (const tool of tools) {
			const chip = make("label", "tool-chip");
			const box = make("input");
			box.type = "checkbox";
			box.value = tool.name;
			box.checked = step.via.includes(tool.name);
			box.disabled = state.flowReadonly;
			chip.classList.toggle("checked", box.checked);
			// 工具说明挂在 chip 的 title 上，不占版面
			chip.title = tool.risk ? `${tool.description ?? ""}（风险：${tool.risk}）` : (tool.description ?? "");
			box.addEventListener("change", () => {
				if (box.checked) {
					if (!step.via.includes(tool.name)) step.via.push(tool.name);
				} else {
					step.via = step.via.filter((name) => name !== tool.name);
				}
				chip.classList.toggle("checked", box.checked);
				counter.textContent = `已选 ${step.via.length}`;
				markFlowDirty();
			});
			chip.appendChild(box);
			chip.appendChild(make("span", "tool-chip-name", tool.name));
			chips.appendChild(chip);
		}
		group.appendChild(chips);
		field.appendChild(group);
	}
	return field;
}

function addFlowStep() {
	if (!state.flowDraft || state.flowReadonly) return;
	state.flowDraft.steps.push({ title: "", hint: "", via: [] });
	markFlowDirty();
	renderFlowStepList();
	const cards = els.flowStepsBox.querySelectorAll(".flow-step");
	const last = cards[cards.length - 1];
	if (last) last.scrollIntoView({ block: "nearest" });
}

function removeFlowStep(index) {
	if (!state.flowDraft || state.flowReadonly) return;
	// 删到零步是允许的：那就是"没有固定步骤、交给模型自己编排"
	state.flowDraft.steps.splice(index, 1);
	markFlowDirty();
	renderFlowStepList();
}

function moveFlowStep(index, delta) {
	const steps = state.flowDraft?.steps;
	if (!steps || state.flowReadonly) return;
	const target = index + delta;
	if (target < 0 || target >= steps.length) return;
	const [step] = steps.splice(index, 1);
	steps.splice(target, 0, step);
	markFlowDirty();
	renderFlowStepList();
}

async function saveFlow() {
	const draft = state.flowDraft;
	if (!draft || state.flowReadonly) return;

	const name = draft.name.trim();
	if (name === "") {
		setFlowError("请填写技能名称。");
		els.flowName.focus();
		return;
	}
	const skillDescription = (draft.skillDescription ?? "").trim();
	const skillInstructions = (draft.skillInstructions ?? "").trim();
	// 「什么时候用它」是模型挑技能的唯一线索：前端当必填，免得不填就建出一条永远不会被加载的技能
	if (skillDescription === "") {
		setFlowError("请填写「什么时候用它」：模型靠这句话决定要不要加载这个技能。");
		document.getElementById("flow-advanced").open = false;
		els.flowSkillDesc.focus();
		return;
	}
	if (skillInstructions === "" && draft.systemPrompt.trim() === "") {
		document.getElementById("flow-advanced").open = true;
		setFlowError("请填写「指导书正文」（或展开高级填系统提示），模型加载后总得看到点什么。");
		els.flowSkillInst.focus();
		return;
	}
	const steps = draft.steps.map((step) => ({
		title: step.title.trim(),
		hint: step.hint.trim(),
		via: [...step.via],
	}));
	for (let index = 0; index < steps.length; index += 1) {
		if (steps[index].title === "") {
			setFlowError(`第 ${index + 1} 步缺少标题。`);
			return;
		}
		if (steps[index].via.length === 0) {
			setFlowError(`第 ${index + 1} 步至少要选一个可用工具。`);
			return;
		}
	}

	// 正文优先；没写正文就用系统提示；系统提示也空就用「什么时候用它」兜底（服务端系统提示必填）
	const systemPrompt = draft.systemPrompt.trim() || skillInstructions || skillDescription;
	// hint 留空就不传，交给服务端用默认提示
	const payload = {
		name,
		systemPrompt,
		steps: steps.map((step) => {
			const item = { title: step.title, via: step.via };
			if (step.hint !== "") item.hint = step.hint;
			return item;
		}),
	};

	// 技能文案：什么时候用它必填（上面已校验），正文可为空（服务端回落到系统提示）
	const skillText = {};
	if (skillDescription !== "") skillText.description = skillDescription;
	if (skillInstructions !== "") skillText.instructions = skillInstructions;
	payload.skill = Object.keys(skillText).length > 0 ? skillText : null;

	const isEdit = typeof draft.id === "string" && draft.id.length > 0;
	const url = isEdit ? `/api/workflows/${encodeURIComponent(draft.id)}` : "/api/workflows";
	els.flowSave.disabled = true;
	setFlowError("");
	try {
		const response = await api(url, {
			method: isEdit ? "PATCH" : "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});
		const data = await response.json().catch(() => ({}));
		if (!response.ok) {
			// 服务端的 400 文案直接展示在弹窗里，不用 alert
			setFlowError(data.error ?? `保存失败（HTTP ${response.status}）。`);
			return;
		}
		closeFlowEditor(true);
		await refreshSessions();
		await refreshWorkflows();
		// 技能列表（含已隐藏的旧右栏）是流程的投影：定义改了，名字/说明也要跟着变
		await refreshSkillCatalog();
	} catch {
		setFlowError("保存失败：无法连接服务，请稍后重试。");
	} finally {
		els.flowSave.disabled = false;
	}
}

async function deleteFlow(workflow) {
	if (!workflow || workflow.builtin) return;
	// 删技能 = 连它的会话一起删（服务端 sessionsRemoved），所以文案要把后果说清楚
	const used = state.sessions.filter((session) => session.id !== state.currentId && session.workflowId === workflow.id).length;
	const extra = used > 0 ? `这个技能下的 ${used} 个会话也会一起删除。` : "这个技能下的会话（如有）也会一起删除。";
	if (!confirm(`确定删除「${workflow.name}」？\n\n${extra}不可恢复；别的会话里正加载着它的，会自动退回默认模式。`)) {
		return;
	}
	try {
		const response = await api(`/api/workflows/${encodeURIComponent(workflow.id)}`, { method: "DELETE" });
		if (!response.ok) {
			const data = await response.json().catch(() => ({}));
			alert(data.error ?? `删除失败（HTTP ${response.status}）。`);
			return;
		}
		const wasActiveSkill = state.currentView?.activeSkillId === workflow.id;
		// 被删的会话要从左栏消失；被摘掉的技能引用也在这次的列表里
		await refreshSessions();
		await refreshWorkflows();
		await refreshSkillCatalog();
		// 当前会话正挂着这条技能：服务端已经退出并推了 SSE skill 事件，但断线时不能指望它，
		// 这里按"会话还在就重拉一次视图"把技能区/胶囊/抽屉刷成「未加载」
		if (wasActiveSkill && state.currentId && state.sessions.some((session) => session.id === state.currentId)) {
			await openSession(state.currentId);
		}
	} catch {
		alert("删除失败：无法连接服务，请稍后重试。");
	}
}

/* ---------------- 步骤 / 审计 ---------------- */

function renderStepbar(steps) {
	els.stepbar.innerHTML = "";
	if (!steps || steps.length === 0) return;
	for (const step of steps) els.stepbar.appendChild(make("span", `step-chip ${step.status}`, step.title));
}

function renderSteps(steps) {
	els.steps.innerHTML = "";
	if (!steps || steps.length === 0) {
		els.steps.appendChild(make("li", "placeholder", "尚未开始"));
		return;
	}
	for (const step of steps) els.steps.appendChild(make("li", step.status, step.title));
}

function renderAudit(entries) {
	els.audit.innerHTML = "";
	if (!entries || entries.length === 0) {
		els.audit.appendChild(make("div", "placeholder", "暂无调用"));
		return;
	}
	for (const entry of entries) appendAudit(entry);
}

function appendAudit(entry) {
	const stale = els.audit.querySelector(".placeholder");
	if (stale) stale.remove();
	const row = make("div", `row ${entry.ok ? "ok" : "err"}`);
	row.appendChild(make("span", "name", entry.toolName));
	row.appendChild(document.createTextNode(entry.ok ? "  ok" : "  err"));
	if (entry.truncated) row.appendChild(document.createTextNode("  截断"));
	els.audit.appendChild(row);
}

/* ---------------- 消息区 ---------------- */

/** 复制文本；按钮文字临时变成「已复制」，无权限/旧浏览器退回 execCommand。 */
async function copyText(text, button, done = "已复制") {
	// 记下按钮本来的文案：连点两下时 textContent 已经是「已复制」，直接捕获会把动作文案永久弄丢
	const label = button.dataset.label ?? button.textContent;
	button.dataset.label = label;
	const finish = () => {
		button.textContent = done;
		button.classList.add("copied");
		setTimeout(() => {
			button.textContent = label;
			button.classList.remove("copied");
		}, 1200);
	};
	try {
		await navigator.clipboard.writeText(text);
		finish();
	} catch {
		const area = make("textarea", "copy-fallback");
		area.value = text;
		document.body.appendChild(area);
		area.select();
		try {
			document.execCommand("copy");
			finish();
		} catch {
			addNotice("复制失败：浏览器不允许访问剪贴板。", true);
		}
		area.remove();
	}
}

/** 空会话的引导页：一句标题 + 三条可点的示例（点了只填输入框，不替用户发出去）。 */
const EMPTY_SUGGESTIONS = [
	{ label: "把已支付订单按区域汇总金额", hint: "数据分析" },
	{ label: "TK-1001 支付回调超时，指派李工并通知客户", hint: "工单流转" },
	{ label: "提交张明 3200 元的客户拜访差旅报销", hint: "费用审批" },
];

function emptyStateNode() {
	const wrap = make("div", "empty");
	wrap.appendChild(make("div", "empty-mark", "B"));
	wrap.appendChild(make("h2", null, "今天想处理什么？"));
	wrap.appendChild(make("p", "empty-sub", "用一句话说清要办的事，Agent 会自己挑技能和工具。"));

	const chips = make("div", "empty-chips");
	for (const item of EMPTY_SUGGESTIONS) {
		const chip = make("button", "empty-chip");
		chip.type = "button";
		chip.appendChild(make("span", "empty-chip-label", item.label));
		chip.appendChild(make("span", "empty-chip-hint", item.hint));
		chip.addEventListener("click", () => {
			els.input.value = item.label;
			els.input.dispatchEvent(new Event("input"));
			els.input.focus();
		});
		chips.appendChild(chip);
	}
	wrap.appendChild(chips);
	wrap.appendChild(make("p", "empty-tip", "Enter 发送 · Shift + Enter 换行 · Ctrl / ⌘ + K 搜索会话"));
	return wrap;
}

function mountEmptyState() {
	els.threadInner.innerHTML = "";
	const node = emptyStateNode();
	els.threadInner.appendChild(node);
	els.empty = node;
}

function ensureRun() {
	clearEmpty();
	if (!state.runEl) {
		state.runEl = make("div", "run");
		els.threadInner.appendChild(state.runEl);
	}
	return state.runEl;
}

function addUserMessage(text) {
	clearEmpty();
	const wrap = make("div", "msg-user");
	wrap.appendChild(make("div", "bubble", text));
	els.threadInner.appendChild(wrap);
	state.runEl = null;
	state.answerEl = null;
	state.thinkingEl = null;
	scrollToBottom(true);
}

/**
 * 思考过程：推理模型（reasoning）会先吐思考再吐正文。
 * 单独一块、默认折起——它不该挤占回答的视觉位置，但想看的人点一下就能看。
 */
function appendThinking(delta) {
	ensureRun();
	if (!state.thinkingEl) {
		const box = make("details", "thinking");
		const summary = make("summary", "thinking__toggle", "思考中…");
		state.thinkingEl = make("div", "thinking__body");
		box.appendChild(summary);
		box.appendChild(state.thinkingEl);
		state.runEl.appendChild(box);
	}
	state.thinkingEl.textContent += delta;
	scrollToBottom();
}

/** 正文一开始就把「思考中…」改成「思考过程」：模型已经想完在写回答了。 */
function settleThinking() {
	const box = state.thinkingEl?.parentNode;
	const toggle = box?.querySelector?.(".thinking__toggle");
	if (toggle && toggle.textContent === "思考中…") toggle.textContent = "思考过程";
}

function appendText(delta) {
	settleThinking();
	ensureRun();
	if (!state.answerEl) {
		state.answerEl = make("div", "answer");
		state.answerEl.style.whiteSpace = "pre-wrap";
		state.runEl.appendChild(state.answerEl);
	}
	// 流式阶段先按纯文本追加（每来一个字都重排 markdown 会闪），收尾再一次性渲染
	state.answerEl.classList.add("streaming");
	state.answerEl.textContent += delta;
	scrollToBottom();
}

function finalizeAnswer(text) {
	if (!state.answerEl) {
		if (!text) return;
		ensureRun();
		state.answerEl = make("div", "answer");
		state.runEl.appendChild(state.answerEl);
	}
	const finalText = text || state.answerEl.textContent;
	state.answerEl.classList.remove("streaming");
	state.answerEl.style.whiteSpace = "";
	state.answerEl.innerHTML = renderMarkdown(finalText);
	attachAnswerActions(state.answerEl, finalText);
	scrollToBottom();
}

/** 回答右下角的复制按钮：hover 才露出来，和 Codex 的消息动作一致。 */
function attachAnswerActions(answerEl, text) {
	if (!text) return;
	answerEl.querySelector(".answer-actions")?.remove();
	const actions = make("div", "answer-actions");
	const copy = make("button", "msg-action", "复制");
	copy.type = "button";
	copy.title = "复制回答";
	copy.addEventListener("click", () => void copyText(text, copy));
	actions.appendChild(copy);
	answerEl.appendChild(actions);
}

/** 展开/收起工具卡片：class 和 aria-expanded 一起改，样式与读屏才不会各说各话。 */
function setToolOpen(card, open) {
	card.classList.toggle("open", open);
	const head = card.querySelector(".tool-head");
	if (head) head.setAttribute("aria-expanded", open ? "true" : "false");
}

function addToolStart(event) {
	ensureRun();
	state.answerEl = null;

	const card = make("div", "tool");
	card.dataset.id = event.id;

	const head = make("div", "tool-head");
	// 标题行本身就是折叠开关：给它按钮语义，键盘（Enter / Space）也能用
	head.setAttribute("role", "button");
	head.setAttribute("tabindex", "0");
	head.setAttribute("aria-expanded", "true");
	head.title = "展开 / 收起详情";
	head.appendChild(make("span", "tool-caret", "›"));
	head.appendChild(make("span", "tool-name", event.name));
	const args = JSON.stringify(event.args ?? {});
	head.appendChild(make("span", "tool-args", args.length > 110 ? `${args.slice(0, 110)}…` : args));
	const status = make("span", "tool-status run", "运行中");
	status.dataset.role = "status";
	head.appendChild(status);

	const body = make("div", "tool-body");
	const output = make("pre", "tool-output");
	output.dataset.role = "output";
	body.appendChild(output);
	card.append(head, body);

	// 点标题行展开/收起详情——长输出默认收起，和 Codex 的工具卡片一样
	const toggle = () => setToolOpen(card, !card.classList.contains("open"));
	head.addEventListener("click", toggle);
	head.addEventListener("keydown", (keyEvent) => {
		if (keyEvent.key !== "Enter" && keyEvent.key !== " ") return;
		keyEvent.preventDefault(); // Space 默认会滚动页面
		toggle();
	});
	setToolOpen(card, true);
	state.runEl.appendChild(card);
	scrollToBottom();
}

function findToolCard(id) {
	if (!state.runEl) return null;
	return [...state.runEl.querySelectorAll(".tool")].find((node) => node.dataset.id === id) ?? null;
}

function finishTool(event) {
	const card = findToolCard(event.id);
	if (!card) return;
	const status = card.querySelector('[data-role="status"]');
	const output = card.querySelector('[data-role="output"]');
	const body = card.querySelector(".tool-body");
	if (!status || !output || !body) return;

	const cost = event.durationMs ? ` · ${event.durationMs}ms` : "";
	status.className = `tool-status ${event.ok ? "ok" : "err"}`;
	status.textContent = event.ok ? `完成${cost}` : "失败";

	const result = event.result ?? "";
	output.textContent = result;
	// 长输出先收起，用户点标题行（或 Enter / Space）再看；短输出保持展开
	setToolOpen(card, result.length <= 320);
	if (result !== "") {
		const foot = make("div", "tool-foot");
		const copy = make("button", "msg-action", "复制输出");
		copy.type = "button";
		copy.addEventListener("click", () => void copyText(result, copy));
		foot.appendChild(copy);
		body.appendChild(foot);
	}
	scrollToBottom();
}

function addApproval(event) {
	ensureRun();
	state.answerEl = null;

	const card = make("div", "approval");
	card.appendChild(make("h4", null, `需要人工审批 · ${event.toolName}`));
	card.appendChild(make("pre", null, JSON.stringify(event.args ?? {}, null, 2)));

	const actions = make("div", "actions");
	const approve = make("button", "btn-primary", "同意并继续");
	const reject = make("button", "btn-ghost danger", "拒绝");
	actions.append(approve, reject);
	card.appendChild(actions);
	state.runEl.appendChild(card);
	scrollToBottom();

	const decide = async (approved) => {
		approve.disabled = true;
		reject.disabled = true;
		await api(`/api/sessions/${state.currentId}/approve`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ requestId: event.requestId, approved }),
		});
		card.appendChild(make("div", "notice", approved ? "已同意，继续执行。" : "已拒绝，这次调用中断。"));
	};

	approve.addEventListener("click", () => void decide(true));
	reject.addEventListener("click", () => void decide(false));
}

function addNotice(text, isError) {
	ensureRun();
	state.runEl.appendChild(make("div", isError ? "notice err" : "notice", text));
	// 报错必须让人看见（可能会拦下一次复制/归档），普通提示不打断正在翻历史的用户
	scrollToBottom(Boolean(isError));
}

/* ---------------- 会话 ---------------- */

async function refreshSessions() {
	state.sessions = await (await api("/api/sessions")).json();
	// 归档状态可能被服务端改过（已归档会话收到新消息会自动取消归档），把当前视图同步一份
	const mine = state.sessions.find((session) => session.id === state.currentId);
	if (mine && state.currentView?.id === mine.id) state.currentView.archived = Boolean(mine.archived);
	renderHeaderTitle();
	renderSidebar();
}

async function createSession(workflowId, modelId) {
	const payload = { workflowId };
	if (modelId) payload.modelId = modelId;

	const response = await api("/api/sessions", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
	});
	if (!response.ok) {
		alert("创建会话失败");
		return;
	}
	const view = await response.json();
	state.currentId = view.id;
	setupSession(view);
	mountEmptyState();
	connect(view.id);
	await refreshSessions();
}

async function openSession(id) {
	const view = await (await api(`/api/sessions/${id}`)).json();
	state.currentId = id;
	setupSession(view);

	els.threadInner.innerHTML = "";
	state.runEl = null;
	state.answerEl = null;
	state.thinkingEl = null;
	for (const turn of view.transcript) {
		if (turn.role === "user") {
			addUserMessage(turn.text);
		} else {
			ensureRun();
			const block = make("div", "answer");
			block.innerHTML = renderMarkdown(turn.text);
			state.runEl.appendChild(block);
			attachAnswerActions(block, turn.text);
		}
	}
	if (view.transcript.length === 0) {
		mountEmptyState();
	}
	connect(id);
	// 历史会话可能很长，打开时直接定位到最新一条
	requestAnimationFrame(() => scrollToBottom(true));
	await refreshSessions();
}

function setupSession(view) {
	state.currentView = view;
	// 头部展示当前会话标题（自定义优先，否则用首条用户消息派生）
	renderHeaderTitle();
	const label = view.modeLabel ?? (view.mode === "live" ? "真实模型" : "模拟模型");
	els.modeChip.textContent = label;
	els.modelName.textContent = view.modelId ?? "模拟模型";
	els.permissionLabel.textContent = view.permissionMode === "readonly" ? "只读" : "完全访问";
	els.permissionChip.classList.toggle("readonly", view.permissionMode === "readonly");
	state.activeSkill = activeSkillOf(view);
	renderSkillChip();
	renderStepbar(view.steps);
	renderSteps(view.steps);
	renderAudit(view.audit);
}

function connect(id) {
	if (state.es) state.es.close();
	const source = new EventSource(`/api/sessions/${id}/events`);
	state.es = source;
	source.onmessage = (message) => {
		let event;
		try {
			event = JSON.parse(message.data);
		} catch {
			return;
		}
		handle(event);
	};
}

function handle(event) {
	switch (event.type) {
		case "ready":
			setupSession(event.session);
			break;
		case "text":
			appendText(event.delta);
			break;
		case "thinking":
			appendThinking(event.delta);
			break;
		case "tool_start":
			addToolStart(event);
			break;
		case "tool_end":
			finishTool(event);
			break;
		case "audit":
			appendAudit(event.entry);
			break;
		case "approval":
			addApproval(event);
			break;
		case "workflow":
			renderStepbar(event.steps);
			renderSteps(event.steps);
			break;
		case "skill":
			applySkillEvent(event);
			break;
		case "done":
			finalizeAnswer(event.text);
			state.runEl = null;
			state.answerEl = null;
			state.thinkingEl = null;
			void refreshSessions();
			break;
		case "error":
			addNotice(event.message, true);
			break;
		case "busy":
			state.busy = event.running;
			els.send.disabled = event.running;
			break;
		default:
			break;
	}
}

/* ---------------- 抽屉 ---------------- */

function toggleDrawer(force) {
	const open = force ?? !els.drawer.classList.contains("open");
	els.drawer.classList.toggle("open", open);
}

/* ---------------- 附件 ---------------- */

function renderAttachments() {
	els.attachments.innerHTML = "";
	if (state.attachments.length === 0) {
		els.attachments.hidden = true;
		return;
	}
	els.attachments.hidden = false;
	state.attachments.forEach((attachment, index) => {
		const chip = make("span", "attach-chip");
		chip.appendChild(make("span", null, `${attachment.name}（${attachment.content.length} 字）`));
		const remove = make("button", null, "×");
		remove.title = "移除";
		remove.addEventListener("click", () => {
			state.attachments.splice(index, 1);
			renderAttachments();
		});
		chip.appendChild(remove);
		els.attachments.appendChild(chip);
	});
}

els.attachBtn.addEventListener("click", () => els.fileInput.click());

els.fileInput.addEventListener("change", async () => {
	const file = els.fileInput.files?.[0];
	if (!file) return;
	// 文本类小文件本地直读（省一次往返）；PDF/Word 必须送服务端解析
	const isPlain = /\.(txt|md|json|csv|log|ya?ml)$/i.test(file.name);
	if (isPlain && file.size <= 400_000) {
		const content = await file.text();
		state.attachments.push({ name: file.name, content: content.slice(0, 60_000) });
		renderAttachments();
		els.fileInput.value = "";
		return;
	}
	await addAttachmentFromBytes(file);
	els.fileInput.value = "";
});

/**
 * PDF / Word 等二进制附件：交给服务端的解析器（与知识库同一套 unpdf / mammoth），
 * 浏览器里没有 PDF 解析能力，也不该为此引一个几百 KB 的库。
 */
async function addAttachmentFromBytes(file) {
	try {
		setAttachBusy(true);
		const buffer = await file.arrayBuffer();
		const response = await api("/api/kb/extract", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ filename: file.name, contentBase64: bytesToBase64(buffer) }),
		});
		const data = await response.json().catch(() => ({}));
		if (!response.ok) {
			addNotice(data.error ?? `解析「${file.name}」失败（HTTP ${response.status}）`, true);
			return;
		}
		state.attachments.push({ name: file.name, content: data.text });
		renderAttachments();
		// 截断要如实说：用户以为全文都进去了，回答却漏了后半段，比报错还糟
		if (data.totalChars > data.text.length) {
			addNotice(
				`「${file.name}」共 ${data.totalChars} 字，附件最多送 ${data.text.length} 字（已截断）`,
				false,
			);
		}
	} catch {
		addNotice(`解析「${file.name}」失败：无法连接服务，请稍后重试。`, true);
	} finally {
		setAttachBusy(false);
	}
}

/** ArrayBuffer → base64（浏览器 FileReader 也行，但这里是纯同步、无回调）。 */
function bytesToBase64(buffer) {
	const bytes = new Uint8Array(buffer);
	let binary = "";
	// 分片拼接：一次性 apply 十万级参数会爆栈
	const step = 0x8000;
	for (let i = 0; i < bytes.length; i += step) {
		binary += String.fromCharCode(...bytes.subarray(i, i + step));
	}
	return btoa(binary);
}

function setAttachBusy(busy) {
	els.attachBtn.disabled = busy;
	els.attachBtn.title = busy ? "正在解析附件…" : "附加文件（文本 / PDF / Word）";
}

function buildOutgoingText(value) {
	if (state.attachments.length === 0) return value;
	const blocks = state.attachments.map(
		(attachment) => `<附件 name="${attachment.name}">\n${attachment.content}\n</附件>`,
	);
	return `${value}\n\n${blocks.join("\n\n")}`.trim();
}

/* ---------------- 语音输入 ---------------- */

const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;

if (!SpeechRecognitionCtor) {
	els.micBtn.classList.add("hidden");
} else {
	let recognition = null;
	els.micBtn.addEventListener("click", () => {
		if (recognition) {
			recognition.stop();
			return;
		}
		recognition = new SpeechRecognitionCtor();
		recognition.lang = "zh-CN";
		recognition.interimResults = true;
		recognition.continuous = false;
		const base = els.input.value;
		recognition.onresult = (event) => {
			let transcript = "";
			for (let index = event.resultIndex; index < event.results.length; index++) {
				transcript += event.results[index][0].transcript;
			}
			els.input.value = `${base}${base ? " " : ""}${transcript}`;
			els.input.dispatchEvent(new Event("input"));
		};
		recognition.onerror = () => {
			addNotice("语音识别不可用（需要浏览器麦克风权限）", true);
		};
		recognition.onend = () => {
			recognition = null;
			els.micBtn.classList.remove("recording");
		};
		els.micBtn.classList.add("recording");
		recognition.start();
	});
}

/* ---------------- 交互绑定 ---------------- */

/* ---------------- 斜杠命令面板 ---------------- */

/**
 * 输入框里敲 `/` 弹出的命令面板。
 *
 * 两个约定：
 * 1. **命令表是数据，不是 if-else**：加一条命令只改 SLASH_COMMANDS，别去改 keydown 分支；
 * 2. **命令直接调既有函数**（setSkill / setSessionArchived / toggleDrawer / newChat），
 *    不要在这里另写一遍请求——一份逻辑两个入口最容易漂移。
 */
const SLASH_COMMANDS = [
	{
		id: "compact",
		label: "压缩",
		hint: "把这段对话的上下文压缩成摘要，腾出空间继续聊",
		aliases: ["yasuo", "compact"],
		run: () => void compactContext(),
	},
	{
		id: "plan",
		label: "计划模式",
		hint: "先只做分析、出方案，不动数据（只读模式：中高风险工具会被拦截）",
		aliases: ["jihua", "plan"],
		run: () => void switchToPlanMode(),
	},
	{
		id: "skill",
		label: "加载技能",
		hint: "把一条技能装进当前会话（等于在「技能」页点那一条）",
		aliases: ["jineng", "skill"],
		run: () => openSkillPickerFromSlash(),
	},
	{
		id: "skills",
		label: "退出技能",
		hint: "回到会话原本的流程，不再用技能",
		aliases: ["tuichu", "exit"],
		run: () => void setSkill(null),
	},
	{
		id: "goal",
		label: "设定目标",
		hint: "告诉模型这一轮到底要达成什么，它会在回答前先对齐目标",
		aliases: ["mubiao", "goal"],
		run: () => void startGoalPrompt(),
	},
	{
		id: "drawer",
		label: "运行详情",
		hint: "打开右侧抽屉：当前进度 + 审计流水",
		aliases: ["xiangqing", "detail"],
		run: () => toggleDrawer(true),
	},
	{
		id: "archive",
		label: "归档当前对话",
		hint: "收进左栏「已归档」，需要时能取消归档",
		aliases: ["guidang", "archive"],
		run: () => void archiveCurrentFromSlash(),
	},
	{
		id: "new",
		label: "新建对话",
		hint: "开一个新的「自动编排」会话",
		aliases: ["xinjian", "new"],
		run: () => void newChat(),
	},
];

/** 面板里实际展示的项：有技能目录时把每条技能也列出来（敲 / 就能直接换技能）。 */
function slashItems() {
	const items = SLASH_COMMANDS.slice();
	for (const skill of state.skillCatalog) {
		// 自动编排是默认模式，加载它等于什么都没换（和服务端面板过滤一致）
		if (skill.id === "auto-flow") continue;
		items.push({
			id: `skill:${skill.id}`,
			label: skill.name,
			hint: "技能 · 直接装进当前会话",
			aliases: [skill.id],
			run: () => void setSkill(skill.id),
		});
	}
	return items;
}

function slashMatches(query) {
	const q = query.trim().toLowerCase();
	if (!q) return slashItems();
	return slashItems().filter((item) =>
		[item.label, ...(item.aliases ?? [])].some((word) => String(word).toLowerCase().includes(q)),
	);
}

function closeSlash() {
	if (!state.slash.open) return;
	state.slash.open = false;
	state.slash.index = 0;
	state.slash.query = "";
	els.slash.hidden = true;
	els.slash.innerHTML = "";
}

function renderSlash() {
	const items = slashMatches(state.slash.query);
	els.slash.innerHTML = "";
	if (items.length === 0) {
		els.slash.appendChild(make("div", "slash-empty", "没有匹配的命令，按 Esc 关闭"));
		els.slash.hidden = false;
		return;
	}
	// 高亮可能因为过滤变短而越界，先夹回合法范围
	state.slash.index = Math.max(0, Math.min(state.slash.index, items.length - 1));
	items.forEach((item, index) => {
		const row = make("button", "slash-item", null);
		row.type = "button";
		row.dataset.slashId = item.id;
		row.classList.toggle("active", index === state.slash.index);
		row.appendChild(make("span", "slash-item__slash", "/"));
		row.appendChild(make("span", "slash-item__label", item.label));
		row.appendChild(make("span", "slash-item__hint", item.hint ?? ""));
		// mousedown 里就执行：blur 会先于 click 把面板关掉
		row.addEventListener("mousedown", (event) => {
			event.preventDefault();
			runSlashItem(item);
		});
		els.slash.appendChild(row);
	});
	els.slash.hidden = false;
}

/**
 * 技能目录平时只在「技能」页才拉；命令面板不该逼用户先去那页一趟，
 * 所以第一次打开时补一次（拿不到就只显示内置命令，不影响用）。
 * 每次只发一个请求：并发敲键时用 inFlight 挡住重复拉取。
 */
let slashSkillsInFlight = false;
function ensureSlashSkills() {
	if (state.skillCatalog.length > 0 || slashSkillsInFlight) return;
	slashSkillsInFlight = true;
	void refreshSkillCatalog()
		.then(() => {
			slashSkillsInFlight = false;
			if (state.slash.open) renderSlash();
		})
		.catch(() => {
			slashSkillsInFlight = false;
		});
}

function openSlash() {
	state.slash.open = true;
	state.slash.index = 0;
	state.slash.query = "";
	renderSlash();
	ensureSlashSkills();
}

/** 输入框内容以 "/" 开头时，把后面的部分当作过滤词；不在开头就关掉面板。 */
function syncSlashFromInput() {
	const value = els.input.value;
	if (!value.startsWith("/")) {
		closeSlash();
		return;
	}
	// 已经敲了空格 = 在写正文，不是在挑命令
	const rest = value.slice(1);
	if (rest.includes(" ")) {
		closeSlash();
		return;
	}
	state.slash.open = true;
	state.slash.query = rest;
	renderSlash();
	ensureSlashSkills();
}

function runSlashItem(item) {
	// 先清空输入框：命令是"动作"，不是要发出去的消息
	els.input.value = "";
	els.input.style.height = "auto";
	closeSlash();
	els.input.focus();
	item.run();
}

function runHighlightedSlash() {
	const items = slashMatches(state.slash.query);
	const item = items[state.slash.index];
	if (!item) return false;
	runSlashItem(item);
	return true;
}

async function archiveCurrentFromSlash() {
	if (!state.currentId) {
		addNotice("先打开一个对话，再归档。", true);
		return;
	}
	await setSessionArchived(state.currentId, true);
}

/**
 * 「计划模式」：平台没有单独的 plan 档位，落到已有的只读权限上——
 * 只读 = 只放行低风险工具，恰好就是"只分析不动数据"。
 * 已经在只读时再执行一次就切回完全访问（命令是开关，不是单向）。
 */
async function switchToPlanMode() {
	if (!state.currentId) {
		addNotice("先打开一个对话，再切换计划模式。", true);
		return;
	}
	const current = state.currentView?.permissionMode ?? "full";
	await setPermission(current === "readonly" ? "full" : "readonly");
}

/** 「设定目标」：不编造一个 goal 系统，先把目标框进输入框让用户补充。 */
async function startGoalPrompt() {
	els.input.value = "本轮目标：";
	els.input.style.height = "auto";
	els.input.style.height = `${Math.min(els.input.scrollHeight, 180)}px`;
	els.input.focus();
	// 光标放末尾，用户接着写
	els.input.setSelectionRange(els.input.value.length, els.input.value.length);
}

/** 「加载技能」：技能多的时候一层菜单放不下，直接弹既有菜单让用户挑。 */
function openSkillPickerFromSlash() {
	const skills = state.skillCatalog.filter((skill) => skill.id !== "auto-flow");
	if (skills.length === 0) {
		addNotice("还没有可用技能，先去「技能」页新建一条。", true);
		return;
	}
	openMenu(els.input, skills.map((skill) => ({
		label: skill.name,
		hint: skill.builtin ? "内置技能" : "自定义技能",
		checked: state.currentView?.activeSkillId === skill.id,
		onClick: () => void setSkill(skill.id),
	})));
}

/** 「压缩」：平台还没有真的摘要压缩，别假装做到了——说清现状并给出可行做法。 */
async function compactContext() {
	addNotice(
		"当前平台还没有「压缩上下文」功能：会话历史会按窗口自动截断（保留系统提示 + 最近若干条）。想立刻腾出空间，最稳的做法是开一个新对话，把必要的背景贴进去。",
		false,
	);
}

els.input.addEventListener("input", () => {
	els.input.style.height = "auto";
	els.input.style.height = `${Math.min(els.input.scrollHeight, 180)}px`;
	syncSlashFromInput();
});

els.input.addEventListener("keydown", (event) => {
	// 命令面板打开时吞掉上下键 / 回车 / Tab：回车是"选中命令"，不是"发送消息"
	if (state.slash.open) {
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			const count = slashMatches(state.slash.query).length;
			if (count > 0) {
				const step = event.key === "ArrowDown" ? 1 : -1;
				state.slash.index = (state.slash.index + step + count) % count;
				renderSlash();
			}
			return;
		}
		if (event.key === "Enter" || event.key === "Tab") {
			event.preventDefault();
			runHighlightedSlash();
			return;
		}
		if (event.key === "Escape") {
			event.preventDefault();
			closeSlash();
			return;
		}
	}
	if (event.key === "Enter" && !event.shiftKey) {
		event.preventDefault();
		els.composer.requestSubmit();
	}
});

els.composer.addEventListener("submit", async (event) => {
	event.preventDefault();
	const raw = els.input.value.trim();
	if ((!raw && state.attachments.length === 0) || !state.currentId || state.busy) return;

	const text = buildOutgoingText(raw || "（见附件）");
	els.input.value = "";
	els.input.style.height = "auto";
	state.attachments = [];
	renderAttachments();
	addUserMessage(text);

	await api(`/api/sessions/${state.currentId}/messages`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ text }),
	});
	// 已归档会话收到新消息会被服务端自动取消归档，刷一次列表让它回到主列表
	void refreshSessions();
});

// 新建聊天直接开会话：不给「选技能」这一步，模型按你的话自己挑
document.getElementById("btn-new").addEventListener("click", () => void newChat());

/* ---------------- 技能编辑器事件 ---------------- */

// 「+ 新建技能」（旧右栏头部与技能页共用）：同一个编辑器，标题不同、焦点直接送到技能文案上
els.newSkillBtn.addEventListener("click", () =>
	void openFlowEditor(null, { title: "新建技能", focusSkill: true }),
);
els.flowModalClose.addEventListener("click", () => closeFlowEditor(false));
els.flowCancel.addEventListener("click", () => closeFlowEditor(false));
els.flowSave.addEventListener("click", () => void saveFlow());
els.flowAddStep.addEventListener("click", () => addFlowStep());

els.flowName.addEventListener("input", () => {
	if (!state.flowDraft) return;
	state.flowDraft.name = els.flowName.value;
	markFlowDirty();
});
els.flowPrompt.addEventListener("input", () => {
	if (!state.flowDraft) return;
	state.flowDraft.systemPrompt = els.flowPrompt.value;
	markFlowDirty();
});
els.flowSkillDesc.addEventListener("input", () => {
	if (!state.flowDraft) return;
	state.flowDraft.skillDescription = els.flowSkillDesc.value;
	markFlowDirty();
});
els.flowSkillInst.addEventListener("input", () => {
	if (!state.flowDraft) return;
	state.flowDraft.skillInstructions = els.flowSkillInst.value;
	markFlowDirty();
});
// 点遮罩关闭：只有点在遮罩本身（而不是弹窗内容）才生效
els.flowModal.addEventListener("click", (event) => {
	if (event.target === els.flowModal) closeFlowEditor(false);
});

/* ---------------- 会话归档事件 ---------------- */

els.archivedToggle.addEventListener("click", toggleArchivedFold);
els.unarchiveBtn.addEventListener("click", () => {
	const session = currentSession();
	if (session) void setSessionArchived(session.id, false);
});

// 中栏头部标题：点击就地重命名当前会话
els.title.title = "点击重命名当前会话";
els.title.addEventListener("click", () => {
	const session = currentSession();
	if (session) startInlineTitleEdit(session, els.title);
});

document.getElementById("btn-search").addEventListener("click", () => {
	const showing = !els.searchRow.hidden;
	els.searchRow.hidden = showing;
	if (!showing) {
		els.searchInput.value = state.searchQuery;
		els.searchInput.focus();
	} else {
		state.searchQuery = "";
		els.searchInput.value = "";
		renderSidebar();
	}
});
els.searchInput.addEventListener("input", () => {
	state.searchQuery = els.searchInput.value.trim();
	renderSidebar();
});

for (const id of ["btn-audit", "btn-audit-top"]) {
	document.getElementById(id).addEventListener("click", () => toggleDrawer(true));
}
els.drawerClose.addEventListener("click", () => toggleDrawer(false));

/* ---------------- 旧右栏技能面板的事件（DOM 隐藏，接线保留） ---------------- */

// 「退出技能」：和模型自己 use_skill(null) 走同一条路
els.skillCurrentExit.addEventListener("click", () => void setSkill(null));

els.permissionChip.addEventListener("click", (event) => {
	const current = state.currentView?.permissionMode ?? "full";
	openMenu(event.currentTarget, [
		{ title: "权限模式" },
		{
			label: "完全访问",
			hint: "可调用全部工具",
			checked: current === "full",
			onClick: () => void setPermission("full"),
		},
		{
			label: "只读",
			hint: "仅低风险工具",
			checked: current === "readonly",
			onClick: () => void setPermission("readonly"),
		},
	]);
});

async function setPermission(mode) {
	if (!state.currentId) return;
	await api(`/api/sessions/${state.currentId}/permissions`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ mode }),
	});
	els.permissionLabel.textContent = mode === "readonly" ? "只读" : "完全访问";
	els.permissionChip.classList.toggle("readonly", mode === "readonly");
	if (state.currentView) state.currentView.permissionMode = mode;
	addNotice(mode === "readonly" ? "已切换为只读模式：中高风险工具会被拦截。" : "已切换为完全访问模式。", false);
}

els.modelSelect.addEventListener("click", async (event) => {
	// 必须在第一个 await 之前取：事件派发结束后浏览器会把 currentTarget 置空，
	// 等到 await 回来再读就是 null，菜单会定位失败（曾经表现为弹到左上角）
	const anchor = event.currentTarget;
	const data = await (await api("/api/models")).json();

	if (data.mode === "simulated") {
		openMenu(anchor, [
			{ title: "当前模型" },
			{ label: "模拟模型", hint: "未配置 API key", checked: true, onClick: () => {} },
			{ separator: true },
			{ label: "在 .env 配置 key 后可切换", onClick: () => {} },
		]);
		return;
	}

	const items = [{ title: `可用模型（${data.options.length}）` }];
	for (const option of data.options) {
		items.push({
			label: option.label,
			hint: option.id,
			checked: option.id === state.currentView?.modelId,
			onClick: () => {
				if (option.id === state.currentView?.modelId) return;
				void createSession(state.currentView?.workflowId ?? state.workflows[0].id, option.id);
			},
		});
	}
	items.push({ separator: true });
	items.push({ label: "切换模型会新建会话", onClick: () => {} });
	openMenu(anchor, items);
});

document.addEventListener("click", (event) => {
	// 技能菜单不是 fixed 定位（贴着 chip），点外部就收起
	if (els.menu.hidden) return;
	// 点击触发菜单的按钮本身不算"点外部"，交给 openMenu 的 toggle 逻辑处理
	if (state.menuAnchor && state.menuAnchor.contains(event.target)) return;
	if (!els.menu.contains(event.target)) closeMenu();
});

document.addEventListener("keydown", (event) => {
	if (event.key === "Escape") {
		closeMenu();
		toggleDrawer(false);
		// 弹窗开着时 Esc 优先关弹窗（有未保存改动会先确认）
		if (!els.kbModal.hidden) closeKbDialog();
		if (!els.flowModal.hidden) closeFlowEditor(false);
	}
	// Ctrl / ⌘ + K：聚焦搜索（Codex 里也是这个键）；技能编辑器开着时不抢它的输入焦点
	if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k" && els.flowModal.hidden) {
		event.preventDefault();
		// 搜索行在会话栏里：先切回对话，否则在别的模块页里按了没反应
		if (state.module !== "chat") void switchModule("chat");
		els.searchRow.hidden = false;
		els.searchInput.focus();
		els.searchInput.select();
	}
});

/* ---------------- 阅读体验：复制、回到底部 ---------------- */

// 代码块与工具卡片的复制按钮都走事件委托，避免每次渲染都重新绑定
els.threadInner.addEventListener("click", (event) => {
	const button = event.target.closest?.('[data-role="copy-code"]');
	if (!button) return;
	const code = button.closest(".code-block")?.querySelector("pre code")?.textContent ?? "";
	void copyText(code, button);
});

els.messages.addEventListener("scroll", () => {
	// 离开底部一定距离才露出"回到底部"，否则会一直悬在那里碍事
	const gap = els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight;
	els.toBottom.hidden = gap < BOTTOM_GAP;
});

els.toBottom.addEventListener("click", () => {
	els.messages.scrollTo({ top: els.messages.scrollHeight, behavior: "smooth" });
});

/* ---------------- 登录页 / 身份 / 知识库弹窗的接线 ---------------- */

// 登录表单只走 submit：真浏览器里回车与点按钮都会触发表单提交，绑两处会发两次请求
els.loginForm.addEventListener("submit", (event) => void submitLogin(event));

els.railAvatar.addEventListener("click", () => openIdentityMenu());
els.railAvatar.addEventListener("keydown", (event) => {
	if (event.key !== "Enter" && event.key !== " ") return;
	event.preventDefault();
	openIdentityMenu();
});

els.kbCancel.addEventListener("click", () => closeKbDialog());
els.kbModalClose.addEventListener("click", () => closeKbDialog());
els.kbSave.addEventListener("click", () => void submitKbDialog());
els.kbForm.addEventListener("submit", (event) => {
	event.preventDefault();
	void submitKbDialog();
});
els.kbFile.addEventListener("change", () => void handleKbFilePicked());

/** 头像菜单：当前身份 + 退出登录；免登录模式（AUTH_MODE=off）不给退出。 */
function openIdentityMenu() {
	const items = [];
	const user = state.me?.user ?? null;
	const label = roleLabel(user?.role);
	if (user) items.push({ title: `${user.name}${label ? ` · ${label}` : ""}` });
	if (canLogout()) items.push({ label: "退出登录", hint: "清掉本机 token", onClick: () => logout() });
	else items.push({ label: "免登录模式", hint: "后端 AUTH_MODE=off，这个实例不需要登录", onClick: () => {} });
	openMenu(els.railAvatar, items);
}

/* ---------------- 启动 ---------------- */

async function init() {
	// 图标栏是模块入口，先把壳画出来，再去拉会话/技能数据
	renderModuleNav();
	state.workflows = await (await api("/api/workflows")).json();
	// 技能目录只影响右栏，失败也不该挡住建会话
	await refreshSkillCatalog();
	await refreshSessions();

	if (state.sessions.length > 0) {
		// 最近改过的那个会话最可能是用户想继续的
		const latest = [...state.sessions].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
		await openSession(latest.id);
	} else {
		// 空库也能直接开始聊：默认模式不依赖任何自定义技能
		await createSession("auto-flow");
	}
}

void bootstrap();
