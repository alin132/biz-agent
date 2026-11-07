/**
 * 接口封装：所有 HTTP 都从这里走。
 *
 * 为什么集中：旧前端把 fetch 散在各处，改鉴权/错误文案要翻半天。这里统一处理三件事——
 *  1. JSON 头与 body 序列化；
 *  2. 错误统一抛 `ApiError`（带 status 与后端的中文 error 文案），页面只管 catch 后展示；
 *  3. 401 统一走登录失效处理（交给上层注册的回调，避免这里 import 路由造成循环依赖）。
 */

export class ApiError extends Error {
	constructor(message, status) {
		super(message);
		this.name = "ApiError";
		this.status = status;
	}
}

/** 登录失效时的回调：由 main.js 注册（跳登录页 / 显示登录弹窗），API 层不感知路由 */
let onUnauthorized = () => {};
export function setUnauthorizedHandler(handler) {
	onUnauthorized = handler;
}

let token = sessionStorage.getItem("biz-agent-token") ?? "";
export function setAuthToken(value) {
	token = value || "";
	if (token) sessionStorage.setItem("biz-agent-token", token);
	else sessionStorage.removeItem("biz-agent-token");
}

function authHeaders() {
	return token ? { Authorization: `Bearer ${token}` } : {};
}

export const authApi = {
	me: () => http.get("/api/auth/me"),
	login: (email, password) => http.post("/api/auth/login", { email, password }),
	logout: () => http.post("/api/auth/logout", {}),
};
/** fetch 流支持 Bearer；提供与页面现有 EventSource 接线相同的回调及 close。 */
export function sessionEvents(id) {
	const controller = new AbortController();
	const source = { onmessage: null, onerror: null, close: () => controller.abort() };
	async function connect() {
		while (!controller.signal.aborted) {
			try {
				const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/events`, {
					headers: authHeaders(), signal: controller.signal,
				});
				if (response.status === 401) { setAuthToken(""); onUnauthorized(); return; }
				if (!response.ok || !response.body) {
					source.onerror?.(new ApiError(`订阅失败（HTTP ${response.status}）`, response.status));
					return;
				}
				const reader = response.body.getReader();
				const decoder = new TextDecoder();
				let buffer = "";
				try {
					while (!controller.signal.aborted) {
						const { value, done } = await reader.read();
						if (done) break;
						buffer += decoder.decode(value, { stream: true });
						let match;
						while ((match = /\r?\n\r?\n/.exec(buffer))) {
							const frame = buffer.slice(0, match.index);
							buffer = buffer.slice(match.index + match[0].length);
							const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:"))
								.map((line) => line.slice(5).replace(/^ /, "")).join("\n");
							if (data) source.onmessage?.({ data });
						}
					}
				} finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
				if (!controller.signal.aborted) source.onerror?.(new Error("连接已断开，正在重连"));
			} catch (error) {
				if (controller.signal.aborted) return;
				source.onerror?.(error);
			}
			if (!controller.signal.aborted) await new Promise((resolve) => {
				const finish = () => { clearTimeout(timer); controller.signal.removeEventListener("abort", finish); resolve(); };
				const timer = setTimeout(finish, 1500);
				controller.signal.addEventListener("abort", finish, { once: true });
			});
		}
	}
	void connect();
	return source;
}

async function request(method, path, body, options = {}) {
	const headers = { ...authHeaders(), ...(options.headers ?? {}) };
	let payload;
	if (body !== undefined) {
		headers["Content-Type"] = "application/json";
		payload = JSON.stringify(body);
	}
	let response;
	try {
		response = await fetch(path, { method, headers, body: payload });
	} catch {
		// 网络层失败（服务没起 / 断网）：给一句人话，不把 fetch 的英文原文丢到界面上
		throw new ApiError("无法连接服务，请确认后端已启动。", 0);
	}
	if (response.status === 401) {
		setAuthToken("");
		onUnauthorized();
	}
	// 204 / 空响应体：别硬 parse，否则 "Unexpected end of JSON input"
	const text = await response.text();
	let data = null;
	if (text.length > 0) {
		try {
			data = JSON.parse(text);
		} catch {
			throw new ApiError("服务返回的不是合法 JSON。", response.status);
		}
	}
	if (!response.ok) {
		const message = data && typeof data.error === "string" ? data.error : `请求失败（HTTP ${response.status}）`;
		throw new ApiError(message, response.status);
	}
	return data;
}

export const http = {
	get: (path) => request("GET", path),
	post: (path, body) => request("POST", path, body),
	patch: (path, body) => request("PATCH", path, body),
	put: (path, body) => request("PUT", path, body),
	delete: (path, body) => request("DELETE", path, body),
};
/** 列表接口有裸数组和 { items } 两种形状，统一在这里抹平，页面不用各写一遍 */
function items(data) {
	if (Array.isArray(data)) return data;
	return data?.items ?? [];
}

/* ---------------- 具体接口：按模块分，页面不拼路径 ---------------- */

export const healthApi = {
	get: () => http.get("/api/health"),
};

export const kbApi = {
	list: async () => items(await http.get("/api/kb")),
	create: (input) => http.post("/api/kb", input),
	remove: (id) => http.delete(`/api/kb/${id}`),
	documents: async (id) => items(await http.get(`/api/kb/${id}/documents`)),
	uploadDocument: (id, input) => http.post(`/api/kb/${id}/documents`, input),
	removeDocument: (docId) => http.delete(`/api/kb/documents/${docId}`),
	search: (id, input) => http.post(`/api/kb/${id}/search`, input),
	reindex: (id) => http.post(`/api/kb/${id}/reindex`),
	embedding: () => http.get("/api/kb/embedding"),
	defaults: () => http.get("/api/kb/defaults"),
	setDefaults: (kbIds) => http.put("/api/kb/defaults", { kbIds }),
};

export const modelsApi = {
	list: () => http.get("/api/models"),
	current: () => http.get("/api/models/current"),
	setCurrent: (modelId) => http.post("/api/models/current", { modelId }),
	embedding: () => http.get("/api/models/embedding"),
	/** 新建模型 { providerId, modelId, name?, kind?, enabled?, contextWindow? } */
	create: (input) => http.post("/api/models", input),
	/** 改模型本身（如最大上下文 contextWindow；传 null 表示清空配置） */
	patch: (id, input) => http.patch(`/api/models/${id}`, input),
	/** 删除模型 → { removed } */
	remove: (id) => http.delete(`/api/models/${id}`),
	/** 测试连通：永远 200，成败看 body 的 ok 字段（8 秒超时） */
	ping: (id) => http.post(`/api/models/${id}/ping`),
	/** 向量模型：知识库语义检索用哪一条 */
	setEmbedding: (modelId) => http.post("/api/models/embedding", { modelId }),
};

export const providersApi = {
	list: async () => items(await http.get("/api/models/providers")),
	/** 新建供应商 { name, kind, baseUrl?, apiKey?, enabled? }；apiKey 明文只在这一刻出现一次 */
	create: (input) => http.post("/api/models/providers", input),
	/** 改供应商：apiKey 留空 = 不改，填了 = 替换 */
	patch: (id, input) => http.patch(`/api/models/providers/${id}`, input),
	remove: (id) => http.delete(`/api/models/providers/${id}`),
};

export const skillsApi = {
	update: (id, input) => http.patch(`/api/workflows/${id}`, input),
	/** 技能目录（GET /api/skills，含自动编排 auto-flow，面板自行过滤） */
	list: async () => items(await http.get("/api/skills")),
	/** 技能详情（底层是自定义流程的详情：步骤/工具/技能文案） */
	detail: (id) => http.get(`/api/workflows/${id}`),
	/** 新建技能（底层 = 自定义流程；字段校验在后端，错误文案是中文直接可显示） */
	create: (input) => http.post("/api/workflows", input),
	/** 删除技能（内置流程后端会 403；返回 { removed, sessionsRemoved, skillsCleared }） */
	remove: (id) => http.delete(`/api/workflows/${id}`),
};

export const mcpApi = {
	patch: (id, input) => http.patch(`/api/mcp/servers/${id}`, input),
	call: (id, tool, args) => http.post(`/api/mcp/servers/${id}/call`, { tool, arguments: args }),
	list: async () => items(await http.get("/api/mcp/servers")),
	create: (input) => http.post("/api/mcp/servers", input),
	refresh: (id) => http.post(`/api/mcp/servers/${id}/refresh`),
	remove: (id) => http.delete(`/api/mcp/servers/${id}`),
};

export const imApi = {
	patch: (id, input) => http.patch(`/api/im/bots/${id}`, input),
	bots: async () => items(await http.get("/api/im/bots")),
	create: (input) => http.post("/api/im/bots", input),
	ping: (id, target = {}) => http.post(`/api/im/bots/${id}/ping`, target),
	remove: (id) => http.delete(`/api/im/bots/${id}`),
	outbox: async () => items(await http.get("/api/im/outbox")),
};

/**
 * 会话级的三个动作：换模型、计划模式、压缩上下文。
 *
 * 为什么单独抽一组：换模型/计划模式都是**会话级**的，与「模型」页的全局当前模型
 * 是两件事——全局那个只决定「之后新建的会话用哪条模型」，改它不会动已有会话。
 */
export const sessionApi = {
	setModel: (id, modelId) => http.post(`/api/sessions/${id}/model`, { modelId }),
	setPlan: (id, enabled) => http.post(`/api/sessions/${id}/plan`, { enabled }),
	compact: (id) => http.post(`/api/sessions/${id}/compact`),
	stop: (id) => http.post(`/api/sessions/${id}/stop`, {}),
};

export const approvalsApi = {
	list: async () => items(await http.get("/api/approvals")),
	decide: (sessionId, requestId, approved) => http.post(`/api/approvals/${sessionId}`, { requestId, approved }),
};

export const auditApi = {
	list: (query = "") => http.get(`/api/audit${query ? `?${query}` : ""}`),
};

export const monitorApi = {
	summary: (range = "24h") => http.get(`/api/monitor/summary?range=${range}`),
	traces: (query = "") => http.get(`/api/monitor/traces${query ? `?${query}` : ""}`),
	trace: (id) => http.get(`/api/monitor/traces/${id}`),
};

export const membersApi = {
	create: (input) => http.post("/api/auth/users", input),
	patch: (id, input) => http.patch(`/api/auth/users/${id}`, input),
	remove: (id) => http.delete(`/api/auth/users/${id}`),
	list: async () => items(await http.get("/api/auth/users")),
};

export const pluginsApi = {
	list: async () => items(await http.get("/api/plugins")),
	import: (manifest) => http.post("/api/plugins/import", { manifest }),
	patch: (id, enabled) => http.patch(`/api/plugins/${id}`, { enabled }),
	remove: (id) => http.delete(`/api/plugins/${id}`),
};
export const apiKeysApi = {
	revoke: (id) => http.delete(`/api/api-keys/${id}`),
	list: async () => items(await http.get("/api/api-keys")),
	create: (input) => http.post("/api/api-keys", input),
	patch: (id, input) => http.patch(`/api/api-keys/${id}`, input),
	remove: (id) => http.delete(`/api/api-keys/${id}`),
};

export const agentsApi = {
	list: async () => items(await http.get("/api/agents")),
	get: (id) => http.get(`/api/agents/${id}`),
	create: (input) => http.post("/api/agents", input),
	update: (id, patch) => http.patch(`/api/agents/${id}`, patch),
	remove: (id) => http.delete(`/api/agents/${id}`),
	/** 状态机动作：test / publish / stop / revert */
	act: (id, action) => http.post(`/api/agents/${id}/actions`, { action }),
	/**
	 * 用这个 Agent 开一个对话。
	 *
	 * 对话本身还是普通会话（workflowId 用默认聊天模式 auto-flow），
	 * agentId 让后端把六维配置落到这次会话上：模型策略、人格指令、技能/知识库绑定。
	 * 已停用的 Agent 后端会回 409，这里让错误照常抛出去给界面显示。
	 */
	startChat: (id) => http.post("/api/sessions", { workflowId: "auto-flow", agentId: id }),
	/**
	 * 某个 Agent 自己的会话列表。
	 *
	 * 作用：Agent 的对话从通用对话页里拆出来，归到各自的专属页。
	 * 用查询参数而不是新开端点——会话列表本来就是这个接口，过滤只是视图需要，
	 * 后端不必为一种"前端分组方式"再加一条路由。
	 */
	sessions: async (id) => items(await http.get(`/api/sessions?agentId=${encodeURIComponent(id)}`)),
};

