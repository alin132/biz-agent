<script setup>
/**
 * 通用对话页：跟"没有绑定 Agent"的会话聊天的地方。
 *
 * 为什么需要这一页：之前 Agent 页只能"发布"，发布完没有入口说话——配置再完整也是死的。
 * 这里复用会话的全部既有链路（SSE、审批、技能快照、审计），不另造一套聊天协议。
 *
 * Agent 从列表进入时也复用这套对话界面，通过 agentId 只显示对应 Agent 的会话。
 * 不带 agentId 时仍只列通用会话，避免不同 Agent 的历史混在一起。
 *
 * 三条如实呈现的约定：
 *  1. 已停用的 Agent 后端会回 409，这里把错误原样显示，不假装能聊；
 *  2. 思考过程折起来单独显示，绝不混进正文；
 *  3. 模拟模型（LLM_DISABLE=1）要标出来，否则用户会以为是自己配的模型在答。
 *
 * 输入框右下角的模型选择器是**会话级**的：换它只改这一条对话（POST /api/sessions/:id/model），
 * 绝不碰「模型」页的全局当前模型——全局那个管的是「之后新建的会话用哪条」，
 * 拿它当切换用会把这页上别的会话一起换掉。
 *
 * 输入框敲 `/` 弹出斜杠命令面板（命令表在 ../slashCommands.js，面板在 SlashCommandPanel.vue）。
 * 命令只调用既有函数（sessionApi.compact / sessionApi.setPlan），不在这里另写一遍请求，
 * 否则"一个动作两个入口"必然漂移。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import MessageBody from "../components/MessageBody.vue";
import SessionActivity from "../components/SessionActivity.vue";
import SessionContextMenu from "../components/SessionContextMenu.vue";
import PiSessionTree from "../components/PiSessionTree.vue";
import PiSessionStats from "../components/PiSessionStats.vue";
import { useSessionActivity } from "../sessionActivity.js";
import { readPinnedSessionIds, sortPinnedSessions, togglePinnedSession } from "../sessionPins.js";
import { can } from "../access.js";
import { NAlert, NButton, NEmpty, NInput, NSpin, NTag, useMessage } from "naive-ui";
import PageShell from "../components/PageShell.vue";
import ModelPicker from "../components/ModelPicker.vue";
import SlashCommandPanel from "../components/SlashCommandPanel.vue";
import { agentsApi, http, modelsApi, pluginsApi, sessionApi, sessionEvents } from "../api.js";
import { createSlashCommands, piSkillsFromPlugins, slashQueryOf } from "../slashCommands.js";
import { downloadPiSession, downloadPiSessionHtml } from "../piSessionDownload.js";
import { copyText, lastAssistantText } from "../clipboard.js";
import { contextRingDash, formatTokens } from "../contextUsage.js";

const route = useRoute();
const router = useRouter();
const message = useMessage();
const agentId = computed(() => typeof route.query.agentId === "string" ? route.query.agentId : "");
const agent = ref(null);

const activity = useSessionActivity();
const showSessions=ref(false),sessionQuery=ref("");
const pinRevision = ref(0);
async function removed() { closeStream();current.value=null;messages.value=[];streamText.value="";streamThinking.value="";sending.value=false;activity.hydrate({});await router.replace({path:"/chat",query:{...(agentId.value?{agentId:agentId.value}:{}),...(route.query.standalone==="1"?{standalone:"1"}:{})}});await refreshList(); }
const sessions = ref([]);
const pinnedIds = computed(() => { pinRevision.value; return readPinnedSessionIds(agentId.value); });
const visibleSessions=computed(()=>sortPinnedSessions(sessions.value.filter(s=>titleOf(s).toLowerCase().includes(sessionQuery.value.toLowerCase())),pinnedIds.value));
const current = ref(null);
const piSkills = ref([]);
const piTreeOpen = ref(false);
const piStatsOpen = ref(false);
const piStats = ref(null);
const modelPickerRef = ref(null);
const contextSession = ref(null);
const sessionContextMenuRef = ref(null);
const contextX = ref(0);
const contextY = ref(0);
const messages = ref([]);
const draft = ref("");
const attachments = ref([]);
const attachmentBusy = ref(false);
const fileInput = ref(null);
const sending = ref(false);
const queuedFollowUps = ref([]);
const toolbarBusy = ref(false);
const loading = ref(true);
const error = ref("");
const streamText = ref("");
const streamThinking = ref("");
const showThinking = ref(false);

/** 可选模型（GET /api/models 的 options）；空 = 没得选（没配 key / 没建模型） */
const modelOptions = ref([]);
/** 模型行清单（/api/models 的 models[]）：行 id ↔ modelId 的翻译表，见 modelKeyToOptionId */
const modelRows = ref([]);
/** 服务端整体是模拟模型（LLM_DISABLE=1）：这时选什么都答不出真实模型，如实标注 */
const globalSimulated = ref(false);
/** 当前这条对话生效的模型（没有会话时就是为下一条会话暂存的选择） */
const selectedModel = ref(null);
/** 换模型请求进行中：按钮转圈，防重复点 */
const switchingModel = ref(false);

let events = null;
const scrollBox = ref(null);

function titleOf(item) {
	if (item.title) return item.title;
	const first = (item.transcript ?? []).find((entry) => entry.role === "user");
	return first?.text?.slice(0, 40) || "新对话";
}

function toggleSessionPin(item) {
	if (!item) return;
	togglePinnedSession(item.id, agentId.value);
	pinRevision.value += 1;
}

function openSessionContextMenu(item, event) {
	if (!can("session.read") && !can("session.write")) return;
	const rect = event.currentTarget.getBoundingClientRect();
	contextSession.value = item;
	contextX.value = event.clientX || rect.left + 16;
	contextY.value = event.clientY || rect.top + rect.height / 2;
}

function onSessionContextKeydown(item, event) {
	if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
	event.preventDefault();
	openSessionContextMenu(item, event);
}

async function onContextSessionRemoved(id) {
	contextSession.value = null;
	if (current.value?.id === id) await removed();
	else await refreshList();
}

function onContextSessionUpdated(view) {
	if (current.value?.id === view.id) current.value = view;
	refreshList();
}

async function scrollToEnd() {
	await nextTick();
	const box = scrollBox.value;
	if (box) box.scrollTop = box.scrollHeight;
}

/** 把会话快照灌进消息列表（历史 + 当前）。transcript 是唯一真相。 */
function hydrate(view) {
	messages.value = (view.transcript ?? []).map((entry) => ({ ...entry, tools: entry.tools ?? [] }));
	activity.hydrate(view, messages.value);
	sending.value = Boolean(view.running);
	queuedFollowUps.value = view.queuedFollowUps ?? [];
	usedTokens.value = Math.max(0, Number(view.contextTokens ?? 0));
	contextEstimated.value = Boolean(view.contextTokensEstimated ?? true);
	scrollToEnd();
}

function onPiTreeNavigate(result) {
	current.value = result.session;
	draft.value = result.editorText ?? "";
	hydrate(result.session);
}

async function onPiTreeFork(result) {
	await refreshList();
	await openSession(result.session.id);
	draft.value = result.editorText ?? "";
}

async function onContextSessionCreated(view) {
	contextSession.value = null;
	await refreshList();
	await openSession(view.id);
}

async function cloneCurrentSession() {
	if (!current.value || sending.value) return;
	try {
		const result = await sessionApi.clone(current.value.id);
		await refreshList();
		await openSession(result.session.id);
		message.success("已复制为独立对话");
	} catch (cause) {
		message.error(cause?.message ?? "复制对话失败");
	}
}

function applyCompressedTranscript(entries) {
	const previous = messages.value;
	const active = activity.activeTurn.value;
	messages.value = (entries ?? []).map((entry) => {
		const old = [...previous].reverse().find((item) => item.role === entry.role &&
			(item.at === entry.at || (entry.role === "user" && item.text === entry.text)));
		return { ...(old ?? {}), ...entry, tools: entry.tools ?? old?.tools ?? [] };
	});
	if (active) {
		activity.activeTurn.value = [...messages.value].reverse().find((item) => item.role === "user" &&
			(item.at === active.at || item.text === active.text)) ?? null;
	}
	scrollToEnd();
}

function closeStream() {
	if (events) {
		events.close();
		events = null;
	}
}

/** 订阅这一条会话的 SSE：协议见 server/session.ts 的 WireEvent */
function subscribe(id) {
	closeStream();
	streamText.value = "";
	streamThinking.value = "";
	events = sessionEvents(id);
	events.onmessage = (event) => {
 if(current.value?.id!==id)return;
		let payload;
		try {
			payload = JSON.parse(event.data);
		} catch {
			return;
		}
		activity.event(payload);
		switch (payload.type) {
			case "context_usage":
				usedTokens.value = Math.max(0, Number(payload.tokens ?? 0));
				contextEstimated.value = Boolean(payload.estimated);
				if (current.value) current.value = { ...current.value, contextTokens: usedTokens.value, contextTokensEstimated: contextEstimated.value };
				break;
			case "compacting":
				compacting.value = true;
				startCompactingTimer();
				break;
			case "workflow":
				if(current.value) current.value={...current.value,steps:payload.steps,current:payload.current,done:payload.done};
				break;
			case "ready":
				current.value = payload.session;
				// SSE 的 ready 视图最权威（可能来自别的标签页/别的客户端建的会话），
				// 下拉跟着它走，否则控件显示的还是上一次选的模型
				selectedModel.value = payload.session?.modelKey ?? null;
				hydrate(payload.session);
				break;
			case "text":
				streamText.value += payload.delta;
				scrollToEnd();
				break;
			case "thinking":
				streamThinking.value += payload.delta;
				break;
			case "busy":
				sending.value = payload.running;
				break;
			case "queue":
				queuedFollowUps.value = payload.followUp ?? [];
				break;
			case "done":
				if (!streamText.value && payload.text) streamText.value = payload.text;
				if (streamText.value.trim()) {
					messages.value.push({ role: "assistant", text: streamText.value, at: Date.now() });
				}
				streamText.value = "";
				streamThinking.value = "";
				sending.value = false;
				scrollToEnd();
				break;
			case "compacted":
				compacting.value = false;
				stopCompactingTimer();
				applyCompressedTranscript(payload.transcript);
				break;
			case "plan":
				// 计划模式是会话级开关，别的标签页切了这里也要跟上
				if (current.value) current.value = { ...current.value, planMode: payload.planMode };
				break;
			case "thinking_level":
				if (current.value) current.value = { ...current.value, thinkingLevel: payload.thinkingLevel };
				break;
			case "error":
				compacting.value = false;
				stopCompactingTimer();
				error.value = payload.message;
				sending.value = false;
				break;
			default:
				break;
		}
	};

	events.onerror = () => {
		// EventSource 自己会重连；这里只把状态标出来，不弹打扰性的提示
	};
}

async function openSession(id, { updateRoute = true } = {}) {
 showSessions.value=false;
	error.value = "";
	const requestedAgentId = agentId.value;
	const requestedPath = route.fullPath;
	const view = await http.get(`/api/sessions/${id}`);
	if (route.name !== "chat" || route.fullPath !== requestedPath || requestedAgentId !== agentId.value) return;
	if ((view.agentId ?? "") !== requestedAgentId) {
		error.value = agentId.value ? "这条会话不属于当前 Agent。" : "这条会话属于 Agent，请从对应 Agent 的对话入口打开。";
		return;
	}
	current.value = view;
	attachments.value = [];
	selectedModel.value = view?.modelKey ?? null;
	// 换会话时清掉上一段的状态：面板、压缩提示都不该跨会话残留
	slashOpen.value = false;
	slashQuery.value = "";
	// 上下文用量是**这条会话**的累计值：换会话必须清零，否则数字会串到别的对话上
	resetUsage();
	hydrate(view);
	subscribe(id);
	if (updateRoute && route.name === "chat" && route.fullPath === requestedPath) {
		void router.replace({ path: "/chat", query: { ...(agentId.value ? { agentId: agentId.value } : {}), session: id, ...(route.query.standalone === "1" ? { standalone: "1" } : {}) } });
	}
}

/**
 * 按当前入口筛选会话：Agent 对话只列该 Agent 的记录，普通对话只列未绑定 Agent 的记录。
 *
 * 直接 map 成普通数组：列表是页面内部的展示数据，不回传给任何接口；
 * 反过来（Agent 会话留在这里）会让同一个会话出现在两个页面上，正是要修的问题。
 */
async function refreshList() {
	const all = await http.get("/api/sessions");
	sessions.value = all.filter((item) => (item.agentId ?? "") === agentId.value);
}

async function loadAgent() {
	agent.value = agentId.value ? await agentsApi.get(agentId.value) : null;
}

async function createSession() {
	error.value = "";
	try {
		// 空会话时选过模型就先记着，建会话时带上：POST /api/sessions 本来就认 modelId，
		// 不传的话它会取全局当前模型——那就把用户在下拉里的选择丢了。
		const body = { workflowId: "auto-flow" };
		if (agentId.value) body.agentId = agentId.value;
		if (selectedModel.value) body.modelId = selectedModel.value;
		const view = await http.post("/api/sessions", body);
		await refreshList();
		await openSession(view.id);
	} catch (err) {
		// 已停用 Agent 会在这里拿到 409：如实显示后端的原话
		error.value = err?.message ?? "新建对话失败";
	}
}

async function send() {
	const text = draft.value.trim();
	if ((!text && attachments.value.length === 0) || !current.value || toolbarBusy.value) return;
	const alreadyRunning = sending.value;
	const outgoing = buildOutgoingText(text, attachments.value);
	draft.value = "";
	attachments.value = [];
	error.value = "";
	const turn = { role: "user", text: outgoing, at: Date.now(), tools: [], durationMs: 0 };
	messages.value.push(turn);
	activity.beginTurn(turn);
	sending.value = true;
	scrollToEnd();
	try {
		await http.post(`/api/sessions/${current.value.id}/messages`, { text: outgoing });
	} catch (err) {
		error.value = err?.message ?? "发送失败";
		activity.event({ type: "error" });
		sending.value = alreadyRunning;
	}
}

function buildOutgoingText(text, files) {
	if (!files.length) return text;
	const blocks = files.map((file) => `<附件 name="${file.name}">\n${file.content}\n</附件>`);
	return [text, ...blocks].filter(Boolean).join("\n\n");
}

async function addFiles(fileList) {
	const files = [...(fileList ?? [])];
	if (!files.length) return;
	attachmentBusy.value = true;
	try {
		for (const file of files) {
			if (!/\.(txt|md|json|csv|log|ya?ml)$/i.test(file.name) || file.size > 400_000) {
				const bytes = new Uint8Array(await file.arrayBuffer());
				let binary = "";
				for (let offset = 0; offset < bytes.length; offset += 0x8000) {
					binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
				}
				const result = await http.post("/api/kb/extract", {
					filename: file.name,
					contentBase64: btoa(binary),
				});
				attachments.value.push({ name: file.name, content: result.text });
				if (result.totalChars > result.text.length) {
					message.warning(`「${file.name}」共 ${result.totalChars} 字，附件最多送 ${result.text.length} 字（已截断）`);
				}
			} else {
				attachments.value.push({ name: file.name, content: (await file.text()).slice(0, 60_000) });
			}
		}
	} catch (cause) {
		error.value = cause?.message ?? "附件解析失败";
	} finally {
		attachmentBusy.value = false;
		if (fileInput.value) fileInput.value.value = "";
	}
}

function onKeydown(event) {
	// 面板开着时它优先：回车是选命令，不是发消息
	if (handleSlashKeydown(event)) return;
	if (event.key === "Enter" && !event.shiftKey) {
		event.preventDefault();
		send();
	}
}
/* ---------------- 斜杠命令面板 ---------------- */

const slashOpen = ref(false);
const slashIndex = ref(0);
const slashQuery = ref("");
/** 压缩请求进行中：要给按钮/提示一个明确的忙态，避免重复触发 */
const compacting = ref(false);
/** 压缩等待的阶段性文案：压缩是真实模型调用，短则几秒长则几分钟，文案跟着耗时推进 */
const compactingElapsed = ref(0);
let compactingTimer = null;
const compactingText = computed(() =>
	compactingElapsed.value < 8 ? "正在压缩上下文：总结旧对话…" : "对话较长，仍在压缩中，可能需要几分钟…",
);
function startCompactingTimer() {
	stopCompactingTimer();
	compactingElapsed.value = 0;
	compactingTimer = setInterval(() => { compactingElapsed.value += 1; }, 1000);
}
function stopCompactingTimer() {
	if (compactingTimer) { clearInterval(compactingTimer); compactingTimer = null; }
}

/** 命令表：动作在运行时注入，缺哪条就少哪条（界面不必为了对齐塞空函数） */
const slashCommands = computed(() =>
	createSlashCommands({
		...((!agentId.value && can("session.write")) || (agentId.value && can("session.write") && agent.value?.status !== "stopped") ? { new: () => createSession() } : {}),
		compact: () => compactContext(),
		plan: () => togglePlanMode(),
		thinking: () => cycleThinkingLevel(),
		name: () => openRenameDialog(),
		reload: () => reloadPiResources(),
		copy: () => copyLatestAssistant(),
		session: () => showPiStats(),
		resume: () => { showSessions.value = true; },
		settings: () => router.push({ name: "settings" }),
		...(current.value && can("session.read") ? { export: () => exportPiSession() } : {}),
		...(current.value && can("session.read") ? { "export-html": () => exportPiSessionHtml() } : {}),
		tree: () => { piTreeOpen.value = true; },
		fork: () => { piTreeOpen.value = true; },
		...(current.value && can("session.write") ? { clone: () => cloneCurrentSession() } : {}),
		model: () => modelPickerRef.value?.open(),
		piSkills: piSkills.value,
		piSkill: (name) => {
			draft.value = `/skill:${name} `;
			nextTick(() => document.querySelector(".chat-input textarea")?.focus());
		},
		skills: current.value?.skills ?? [],
		skill: (skillId) => selectSkill(skillId),
	}),
);

async function exportPiSession() {
	if (!current.value || !can("session.read")) return;
	try {
		await downloadPiSession(current.value.id);
	} catch (cause) {
		message.error(cause?.message ?? "导出 Pi 会话失败");
	}
}

async function copyLatestAssistant() {
	try {
		await copyText(lastAssistantText(messages.value));
		message.success("已复制最近一条助手回复");
	} catch (cause) {
		message.error(cause?.message ?? "复制失败，请手动选择文本复制");
	}
}

async function reloadPiResources() {
	if (!current.value) return;
	try {
		const result = await sessionApi.reloadPiResources(current.value.id);
		current.value = result.session;
		hydrate(result.session);
		message.success(`Pi 资源已刷新：${result.piSkills.length} 个原生技能`);
	} catch (cause) {
		message.error(cause?.message ?? "刷新 Pi 资源失败");
	}
}

async function exportPiSessionHtml() {
	if (!current.value || !can("session.read")) return;
	try {
		await downloadPiSessionHtml(current.value.id);
	} catch (cause) {
		message.error(cause?.message ?? "导出 Pi HTML 会话失败");
	}
}

/** 面板要显示的项：按输入框里的过滤词筛 */
const slashItems = computed(() => {
	const query = slashQuery.value.trim().toLowerCase();
	if (!query) return slashCommands.value;
	return slashCommands.value.filter((item) =>
		[item.label, ...(item.aliases ?? [])].some((word) => String(word).toLowerCase().includes(query)),
	);
});

/** 输入框变化时同步面板：以 / 开头且在挑命令才弹，敲了空格就收起 */
function onDraftInput() {
	const query = slashQueryOf(draft.value);
	if (query === null) {
		slashOpen.value = false;
		slashQuery.value = "";
		return;
	}
	slashOpen.value = true;
	slashQuery.value = query;
	// 过滤后条数会变少，高亮可能越界，夹回合法范围
	const count = slashItems.value.length;
	slashIndex.value = count === 0 ? 0 : Math.min(slashIndex.value, count - 1);
}

/** 执行一条命令：先清空输入框（命令是动作，不是要发出去的消息）再跑 */
function runSlashItem(item) {
	if (!item) return;
	if (item.kind === "pi-skill") {
		slashOpen.value = false;
		slashQuery.value = "";
		item.run();
		return;
	}
	draft.value = "";
	slashOpen.value = false;
	slashQuery.value = "";
	item.run();
}

function openRenameDialog() {
	if (!current.value) {
		error.value = "先打开一个对话，再设置会话名称。";
		return;
	}
	if (!can("session.write")) {
		error.value = "没有重命名会话的权限。";
		return;
	}
	sessionContextMenuRef.value?.openRenameFor(current.value);
}

async function showPiStats() {
	if (!current.value) return;
	try {
		piStats.value = await sessionApi.piStats(current.value.id);
		piStatsOpen.value = true;
	} catch (cause) {
		message.error(cause?.message ?? "读取 Pi 会话统计失败");
	}
}

async function selectSkill(skillId) {
	if (!current.value || !can("session.run")) return;
	const sessionId = current.value.id;
	try {
		await http.post(`/api/sessions/${sessionId}/skills`, { skillId });
		const view = await http.get(`/api/sessions/${sessionId}`);
		if (current.value?.id !== sessionId) return;
		current.value = view;
		hydrate(view);
		await refreshList();
		message.success(skillId ? `已加载技能：${view.skills.find((skill) => skill.id === skillId)?.name ?? "技能"}` : "已退出当前技能");
	} catch (cause) {
		error.value = cause?.message ?? "切换技能失败";
	}
}

/**
 * /compact：压缩这条对话的上下文。
 *
 * 成功后以服务端返回为准刷新界面：压缩摘要作为时间线记录显示，
 * 被摘要覆盖的旧消息从当前 transcript 移除。
 */
async function compactContext() {
	if (!current.value) {
		error.value = "先打开一个对话，再压缩。";
		return;
	}
	if (sending.value || compacting.value) {
		// 静默吞等于「命令消失了但什么都没发生」（e2e 探针实锤过这个症状）：
		// 用户敲了 /compact、面板收了、输入框清了，却没有任何反馈。给一句人话。
		error.value = compacting.value ? "正在压缩，稍候" : "上一条还没回完，等回复落地再压缩";
		return;
	}
	compacting.value = true;
	startCompactingTimer();
	error.value = "";
	const sessionId = current.value.id;
	try {
		await sessionApi.compact(sessionId);
		const view = await http.get(`/api/sessions/${sessionId}`);
		if (current.value?.id === sessionId) {
			current.value = view;
			applyCompressedTranscript(view.transcript);
		}
	} catch (err) {
		// 太短 / 模拟模型都会在这里拿到后端的原话，如实显示
		error.value = err?.message ?? "压缩失败";
	} finally {
		compacting.value = false;
		stopCompactingTimer();
	}
}

/**
 * /plan：切换计划模式（是开关，不是单向）。
 *
 * 以后端返回的会话快照为准：请求失败时不改界面，否则用户会以为已经开了。
 */
async function togglePlanMode() {
	if (!current.value) {
		error.value = "先打开一个对话，再切换计划模式。";
		return;
	}
	const next = !(current.value.planMode ?? false);
	try {
		current.value = await sessionApi.setPlan(current.value.id, next);
	} catch (err) {
		error.value = err?.message ?? "切换计划模式失败";
	}
}

async function cycleThinkingLevel() {
	if (!current.value) {
		error.value = "先打开一个对话，再调整推理强度。";
		return;
	}
	const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
	const index = levels.indexOf(current.value.thinkingLevel ?? "medium");
	const thinkingLevel = levels[(index + 1) % levels.length];
	try {
		current.value = await sessionApi.setThinking(current.value.id, thinkingLevel);
		message.success(`Pi 推理强度：${thinkingLevel}`);
	} catch (err) {
		error.value = err?.message ?? "调整推理强度失败";
	}
}

/** 当前是否处于计划模式（页头标记与关闭按钮都用它） */
const planModeOn = computed(() => Boolean(current.value?.planMode));

/**
 * 面板展开时接管上下键 / 回车 / Esc。
 *
 * 返回 true = 事件已被处理，调用方不要再走"回车发送"。
 * 回车在这里是"选中命令"，不是"发消息"——这也是面板最容易出错的地方。
 */
function handleSlashKeydown(event) {
	if (!slashOpen.value) return false;
	const count = slashItems.value.length;
	if (event.key === "ArrowDown" || event.key === "ArrowUp") {
		event.preventDefault();
		if (count > 0) {
			const step = event.key === "ArrowDown" ? 1 : -1;
			slashIndex.value = (slashIndex.value + step + count) % count;
		}
		return true;
	}
	if (event.key === "Enter" || event.key === "Tab") {
		event.preventDefault();
		runSlashItem(slashItems.value[slashIndex.value]);
		return true;
	}
	if (event.key === "Escape") {
		event.preventDefault();
		slashOpen.value = false;
		return true;
	}
	return false;
}

const canChat = computed(() => Boolean(current.value) && !toolbarBusy.value);
const modeBadge = computed(() => current.value?.modeLabel ?? null);

/**
 * 拉一次可选模型。
 *
 * `options` 是后端 /api/models 已经拼好的「对话类、启用、供应商也启用」的模型，
 * `current` 是**全局当前模型**——只用来给「没选过模型的会话」一个初始值，
 * 它不随会话级切换而变，所以这里只在首次加载时用它兜底。
 */
async function loadModels() {
	try {
		const data = await modelsApi.list();
		// options[] 是「全部可选」的唯一真相（.env 模型 + 库里的模型行按 modelId 去重后的结果），
		// 它的 id 是供应商侧的模型名（modelId）。
		// 会话的 modelKey 是**模型行 id**（model-xxx），两个命名空间不一致——
		// 所以这里同时记下「行 id → modelId」的映射，显示时先把行 id 翻译成 modelId 再找 label，
		// 否则控件上会出现 model-e1b524a5 这种原始 id 而不是模型名。
		modelOptions.value = Array.isArray(data?.options) ? data.options : [];
		modelRows.value = Array.isArray(data?.models) ? data.models : [];
		globalSimulated.value = data?.mode === "simulated";
	} catch {
		// 模型列表拉不到不该拦住聊天：没有可选模型时控件只显示当前状态
		modelOptions.value = [];
	}
}
/** 服务端当前使用哪个模型：真实模式给供应商 · 模型名，模拟模式如实写「模拟模型」 */
const activeModelLabel = computed(() => current.value?.modeLabel || "模拟模型");

/** 控件里显示的值：有会话就看会话的模型行 id，没有会话就看这次暂存的选择 */
const modelValue = computed(() => {
	if (!current.value) return selectedModel.value;
	return current.value.modelKey ?? selectedModel.value ?? null;
});

/**
 * 当前会话跑的是不是模拟模型。
 *
 * 两种来源都算：整站没接真实模型，或这条会话的模型被停用后退回了模拟。
 * 只要有一个成立，界面就必须说「模拟模型」——不能让用户以为是自己选的模型在答。
 */
const isSimulated = computed(() => globalSimulated.value || current.value?.mode === "simulated");

/** 控件旁的说明文字：明说这条对话实际在用谁答话 */
const modelHint = computed(() =>
	isSimulated.value ? "模拟模型（未接入真实模型）" : `当前：${activeModelLabel.value}`,
);

/** 会话的 modelKey（行 id）翻译成 options 命名空间的 modelId；翻译不出就原样返回 */
const modelKeyToOptionId = (key) => {
	if (!key) return key;
	// 已经是选项 id（modelId）就直达，避免行 id 与 modelId 同形时误翻
	if (modelOptions.value.some((option) => option.id === key)) return key;
	const row = modelRows.value.find((candidate) => candidate.id === key);
	return row?.modelId ?? key;
};

/** 控件的选中值要落在 options 的命名空间上（modelId），会话的 modelKey（行 id）先翻译过去 */
const modelValueAsOptionId = computed(() => modelKeyToOptionId(modelValue.value));

/** 选中项被停用/删除时不会有 label，回落成 id，避免下拉里出现空白行 */
const currentModelTitle = computed(() => {
	const key = modelValue.value;
	if (!key) return modelHint.value;
	const optionId = modelKeyToOptionId(key);
	const hit = modelOptions.value.find((option) => option.id === optionId);
	return hit?.label ?? optionId;
});

/* ---------------- 上下文用量（头部常驻的「已用 / 总量」） ---------------- */

/**
 * 已用 token：**当前会话**的累计值，纯内存、不落库。
 *
 * 服务端不广播每轮的用量（SSE 的 WireEvent 里没有 usage 字段），所以这里按同一份
 * 发出去的内容估算：用户消息 + 助手回复（含思考块）。估算口径与 server/observability/trace.ts
 * 的 estimateTokens 一致（中日韩字 1 字 ≈ 1 token，其余非空白 4 字符 ≈ 1 token），
 * 中文场景下不会偏出一倍。
 *
 * 三条边界：
 *  1. **只算这条会话**：openSession 时清零，别把上一条对话的量带过来；
 *  2. **结束的轮 + 正在流式的这段都要算**：只在轮末结算的话，用户敲完一条会先看到
 *     数字纹丝不动，以为这东西坏了；
 *  3. 精确用量看监控页的调用链，这里是「背景信息」。
 */
const usedTokens = ref(0);
const contextEstimated = ref(true);

/** 用户在这条会话里点选的模型行 id：模拟模式下 modelKey 恒为 null，得自己记一份才能取到 contextWindow */
const pickedModelKey = ref(null);

/** 下拉给的是 options 命名空间（modelId），翻回模型行 id；翻不出就原样返回（可能是行 id 本身） */
function modelRowKeyOf(modelId) {
	if (!modelId) return null;
	const row = modelRows.value.find((candidate) => candidate.id === modelId || candidate.modelId === modelId);
	return row?.id ?? modelId;
}

/** 一位小数，够看又不啰嗦：256000 → 256k，128000 → 128k，1500 → 1.5k，900 → 900 */
/** 重置模型行选择；用量由随后加载的会话快照恢复 */
function resetUsage() {
	pickedModelKey.value = null;
}

/**
 * 这条会话用的模型行的 contextWindow；没配（null）就返 0 = 总量未知。
 *
 * 三个来源按优先级取，都是为了拿到「模型行 id」这一个东西：
 *  1. 会话自己的 modelKey —— 真实模型生效时后端才回，最权威；
 *  2. 用户在本页点选过的行 —— 模拟模式下后端会拒绝选模型（如实报错，是既有设计），
 *     但界面不该因为模式差异就少一块信息，点过就按点过的那行算总量；
 *  3. 当前选中值 —— 还没跟后端确认过时先按它显示。
 * 翻不到行（没建模型 / 行没有 contextWindow）就返 0，界面只显示已用，不编总量。
 */
const contextWindow = computed(() => {
	const candidates = [current.value?.modelKey, pickedModelKey.value, modelValue.value];
	for (const key of candidates) {
		if (!key || !Array.isArray(modelRows.value)) continue;
		// 行 id 与 modelId 两种命名空间都认（见 modelKeyToOptionId 的说明）
		const row = modelRows.value.find((candidate) => candidate.id === key || candidate.modelId === key);
		const size = Number(row?.contextWindow);
		if (Number.isFinite(size) && size > 0) return size;
	}
	return 0;
});

/**
 * 头部那个胶囊的文案：「29k/256k」。
 *
 * 没配上下文窗口时**只显示已用**，不编一个总量出来——编了就是在告诉用户
 * "还剩多少"，那是假信息。
 */
const usageText = computed(() => {
	const used = formatTokens(usedTokens.value);
	const total = contextWindow.value;
	return total > 0 ? used + "/" + formatTokens(total) : used;
});

/** hover 给精确数字：k 是取整过的，光标停上去要能看到真实值 */
const usageTitle = computed(() => {
	const used = String(Math.max(0, Math.round(usedTokens.value)));
	const total = contextWindow.value;
	const source = contextEstimated.value ? "估算" : "模型返回";
	return total > 0
		? "上下文用量（" + source + "）：" + usageText.value + "；精确数值 " + used + " / " + total + " tokens"
		: "上下文用量（" + source + "）：" + usageText.value + "；精确数值 " + used + " tokens（未配置上下文窗口）";
});
const usagePercent = computed(() => contextWindow.value > 0 ? Math.round((usedTokens.value / contextWindow.value) * 100) : null);

/** 用掉超过 80% 就该换警示色：这个量再聊几轮就要压缩了 */
const usageWarn = computed(() => contextWindow.value > 0 && usedTokens.value / contextWindow.value > 0.8);
const ctxRingDash = computed(() => contextRingDash(usedTokens.value, contextWindow.value));

/**
 * 选一个模型。
 *
 * 分流两种情形：
 *  1. 还没有会话：没有可变的对象，先记在 selectedModel 上，等下建会话时随 modelId 发给后端；
 *  2. 已有会话：走**会话级**接口 POST /api/sessions/:id/model，只改这一条对话。
 * 两种情形都不碰全局当前模型（那是「模型」页的事）。
 */
async function onModelChange(value) {
	const modelId = typeof value === "string" ? value : "";
	if (!modelId) return;
	// 用户确实点了这一行：上下文窗口照它算（模拟模式下后端不会把它记进会话，见 contextWindow）
	pickedModelKey.value = modelRowKeyOf(modelId);
	if (!current.value) {
		selectedModel.value = modelId;
		return;
	}
	// value 来自 ModelPicker，命名空间是 options[].id（modelId）；
	// current.value.modelKey 可能是模型行 id（model-xxx）——先翻译到同一命名空间再比，
	// 否则「换成同一条模型行」会被误判成没变而静默跳过（探针实锤过：一次请求都不发）。
	if (modelId === modelKeyToOptionId(current.value.modelKey)) return;

	switchingModel.value = true;
	error.value = "";
	try {
		const result = await sessionApi.setModel(current.value.id, modelId);
		// 后端可能把「库里不认识的 id」归一成 null，所以以它回来的视图为准
		current.value = result?.session ?? current.value;
		selectedModel.value = current.value.modelKey ?? null;
		// 后端可能拒绝（例如模拟模式选不了模型）：上面已按用户点选的行记了 pickedModelKey，
		// 那是界面自己的账，不受接口成败影响。
		// 注意：result.models 是**模型行**清单（行 id 命名空间），而 modelOptions 是 options
		// （modelId 命名空间）——直接覆盖会让 currentModelTitle 的翻译表错乱，按钮显示原始行 id。
		// 行清单只更新翻译表 modelRows。
		if (Array.isArray(result?.modelRows) && result.modelRows.length > 0) {
			modelRows.value = result.modelRows;
		}
		message.success(`已切换这条对话的模型：${current.value.modeLabel || "模拟模型"}`);
	} catch (err) {
		// 400（模型不可用）/ 409（正在执行中）都是后端的中文原话，直接显示，不吞
		error.value = err?.message ?? "换模型失败";
	} finally {
		switchingModel.value = false;
	}
}

onMounted(async () => {
	const initialPath = route.fullPath;
	try {
		await Promise.all([refreshList(), loadModels(), loadAgent(), pluginsApi.list().then((plugins) => { piSkills.value = piSkillsFromPlugins(plugins); })]);
		if (route.name !== "chat" || route.fullPath !== initialPath) return;
		const wanted = typeof route.query.session === "string" ? route.query.session : null;
		if (wanted) {
			await openSession(wanted);
		} else if (sessions.value.length > 0) {
			await openSession(sessions.value[0].id, { updateRoute: false });
		}
	} catch (err) {
		error.value = err?.message ?? "加载失败";
	} finally {
		loading.value = false;
	}
});

onBeforeUnmount(() => {
	closeStream();
	stopCompactingTimer();
});

watch(() => route.query.session, async (id) => {
	if (typeof id === "string" && id && id !== current.value?.id) {
		await openSession(id);
	}
});
</script>

<template>
	<PageShell :title="agent?.name ?? (agentId ? 'Agent 对话' : '对话')" :subtitle="agent ? agent.description : '直接提问，或加载技能完成业务任务'" wide>
		<template #actions>
			<n-button class="chat-list-toggle" @click="showSessions=!showSessions">会话列表</n-button>
			<n-button v-if="current" @click="piTreeOpen=true">Pi 会话树</n-button>
			<n-button v-if="!agentId" :disabled="!can('session.write')" @click="createSession">新对话</n-button>
		</template>
		<n-alert v-if="error" type="error" :bordered="false" class="chat-alert">
			{{ error }}
		</n-alert>

		<n-spin :show="loading">
			<div class="chat-layout" :class="{'show-sessions':showSessions}">
				<aside class="chat-list">
					<div class="chat-list-head">
						<div v-if="!agent" class="chat-list-title">通用会话</div>
						<n-button type="primary" size="small" block @click="createSession">新对话</n-button>
					</div>
					<n-input v-model:value="sessionQuery" placeholder="搜索会话" clearable style="margin:10px 0"/>
<ul class="chat-sessions">
						<li
							v-for="item in visibleSessions"
							:key="item.id"
							class="chat-session"
							:class="{ active: item.id === current?.id }"
							@click="openSession(item.id)"
							role="button" tabindex="0"
							@keydown.enter="openSession(item.id)"
							@keydown.space.prevent="openSession(item.id)"
							@keydown="onSessionContextKeydown(item, $event)"
							@contextmenu.prevent.stop="openSessionContextMenu(item, $event)"
						>
							<div class="chat-session-title">{{ titleOf(item) }}</div>
							<span v-if="pinnedIds.includes(item.id)" class="chat-session-pin">置顶</span>
							<div class="chat-session-meta">
								<n-tag v-if="item.archived" size="tiny" :bordered="false">已归档</n-tag>
							</div>
						</li>
					</ul>
					<n-empty v-if="sessions.length === 0" :description="agent ? '还没有这个 Agent 的会话' : '还没有通用会话'" size="small" />
				</aside>

				<section class="chat-main">
					<PiSessionTree v-model:show="piTreeOpen" :session-id="current?.id" :can-fork="Boolean(current && !sending && !current.pendingApprovals?.length)" :can-navigate="Boolean(current && !sending && !current.pendingApprovals?.length)" @navigate="onPiTreeNavigate" @fork="onPiTreeFork" />
					<PiSessionStats v-model:show="piStatsOpen" :stats="piStats" />
					<SessionContextMenu ref="sessionContextMenuRef" :session="contextSession" :x="contextX" :y="contextY" :busy="toolbarBusy || (sending && contextSession?.id === current?.id)" :pinned="contextSession ? pinnedIds.includes(contextSession.id) : false" @close="contextSession=null" @pin="toggleSessionPin(contextSession)" @busy="toolbarBusy=$event" @updated="onContextSessionUpdated" @removed="onContextSessionRemoved" @created="onContextSessionCreated" />
					<header v-if="current" class="chat-head">
						<div class="chat-head-title">{{ titleOf(current) }}</div>
						<div class="chat-head-tags">
							<n-tag v-if="agent" size="small" :bordered="false">{{ agent.name }}</n-tag>
							<!-- 计划模式是会话级开关：标记要显眼、并且提供就地关闭的入口 -->
							<Transition name="badge">
								<span v-if="planModeOn" class="plan-badge" data-testid="plan-mode-badge">计划模式</span>
							</Transition>
							<n-button v-if="planModeOn" size="tiny" quaternary @click="togglePlanMode">关闭计划模式</n-button>
							<n-tag v-if="modeBadge" size="small" :bordered="false">{{ modeBadge }}</n-tag>
						</div>
					</header>

					<div ref="scrollBox" class="chat-scroll">
						<n-empty v-if="!current" description="选一个对话，或点「新对话」" />
						<template v-for="(msg, index) in messages" :key="`${msg.role}-${msg.at}-${index}`">
							<article v-if="msg.role === 'compaction'" class="chat-compaction-record" data-testid="compaction-record">
								<header><span class="chat-compaction-badge">{{ msg.automatic ? "上下文已自动压缩" : "上下文已压缩" }}</span><span>前序对话摘要</span></header>
								<div class="chat-compaction-summary"><MessageBody :text="msg.text" :markdown="true"/></div>
							</article>
							<div v-else class="chat-msg" :class="[msg.role, { 'with-activity': msg.role==='user' && (msg.startedAt || msg.durationMs > 0 || msg.tools?.length || activity.pending.value.length && activity.activeTurn.value===msg) }]">
								<div v-if="msg.role === 'user'" class="chat-role">我</div>
								<div class="chat-bubble"><MessageBody :text="msg.text" :markdown="msg.role==='assistant'"/></div>
								<SessionActivity v-if="msg.role==='user' && (msg.startedAt || msg.durationMs > 0 || msg.tools?.length || activity.pending.value.length && activity.activeTurn.value===msg)" :session-id="current?.id" :turn="msg" :pending="activity.activeTurn.value===msg ? activity.pending.value : []" :elapsed-ms="activity.activeTurn.value===msg ? activity.elapsedMs.value : msg.durationMs" :running="sending && activity.activeTurn.value===msg" @resolved="activity.resolved"/>
							</div>
						</template>

						<div v-if="streamThinking" class="chat-thinking">
							<button class="chat-thinking-head" @click="showThinking = !showThinking">
								{{ showThinking ? "▾" : "▸" }} 思考过程
							</button>
							<pre v-if="showThinking" class="chat-thinking-body">{{ streamThinking }}</pre>
						</div>

						<div v-if="streamText" class="chat-msg assistant">
							<div class="chat-bubble"><MessageBody :text="streamText"/></div>
						</div>

						<Transition name="notice">
							<div v-if="compacting" class="chat-compacting" data-testid="compacting-indicator">
								<span class="chat-compacting-spin" aria-hidden="true"></span>
								<span class="chat-compacting-text">{{ compactingText }}</span>
								<div class="chat-compacting-bar" aria-hidden="true"><span class="chat-compacting-bar-fill"></span></div>
							</div>
						</Transition>
					</div>

					<footer class="chat-input">
						<!-- 面板绝对定位在输入框上方，所以这一层是它的定位上下文 -->
						<div class="chat-input-wrap">
							<SlashCommandPanel
								v-if="slashOpen"
								:query="slashQuery"
								:items="slashCommands"
								:index="slashIndex"
								@run="runSlashItem"
							/>
							<n-input
								v-model:value="draft"
								type="textarea"
								:autosize="{ minRows: 2, maxRows: 6 }"
								placeholder="说点什么，Enter 发送，Shift+Enter 换行；敲 / 看命令"
								:disabled="!current||!can('session.run')"
								@keydown="onKeydown"
								@input="onDraftInput"
							/>
						</div>
						<input ref="fileInput" type="file" multiple accept=".txt,.md,.json,.csv,.log,.yaml,.yml,.pdf,.doc,.docx" class="chat-file-input" @change="addFiles($event.target.files)" />
						<div v-if="attachments.length" class="chat-attachments" aria-label="待发送附件">
							<div v-for="(file, index) in attachments" :key="`${file.name}-${index}`" class="chat-attachment">
								<span>{{ file.name }}</span>
								<n-button size="tiny" quaternary :aria-label="`移除附件 ${file.name}`" @click="attachments.splice(index, 1)">移除</n-button>
							</div>
						</div>
						<!--
							右下角：模型选择器 + 发送。
							模型写在发送按钮左边（同一个右下角区域），选完立刻生效于**这一条对话**。
						-->
						<div class="chat-compose-actions">
							<n-button quaternary :loading="attachmentBusy" :disabled="attachmentBusy || toolbarBusy || !current" @click="fileInput?.click()">附加文件</n-button>
							<span v-if="queuedFollowUps.length" class="queue-status">已排队 {{ queuedFollowUps.length }} 条</span>
							<!--
								上下文用量圆环：放输入框左下角。中心留空，悬停时显示已用比例和精确 token 数。
							-->
							<div class="chat-compose-main-actions">
								<div
									class="ctx-ring"
									:class="{ warn: usageWarn }"
									data-testid="context-usage"
									:aria-label="usageTitle"
									:aria-describedby="`context-usage-tooltip-${current?.id ?? 'empty'}`"
									role="img"
									tabindex="0"
								>
									<div :id="`context-usage-tooltip-${current?.id ?? 'empty'}`" class="ctx-ring-tooltip" role="tooltip">
										<strong>背景信息窗口：</strong>
										<span v-if="usagePercent !== null">{{ usagePercent }}% 已用</span>
										<span v-else>总量未配置</span>
										<b v-if="contextWindow > 0">已用 {{ formatTokens(usedTokens) }} 标记，共 {{ formatTokens(contextWindow) }}</b>
										<b v-else>已用 {{ formatTokens(usedTokens) }} 标记</b>
									</div>
									<svg viewBox="0 0 36 36" class="ctx-ring-svg" aria-hidden="true">
										<circle class="ctx-ring-track" cx="18" cy="18" r="15.5" />
										<circle
											v-if="contextWindow > 0"
											class="ctx-ring-fill"
											cx="18" cy="18" r="15.5"
											:stroke-dasharray="ctxRingDash"
										/>
									</svg>
									<span class="ctx-ring-text" data-testid="context-usage-text">{{ usageText }}</span>
								</div>
								<div class="chat-model-picker">
								<!--
									Codex 风格：内联按钮 + 向上弹出的轻量菜单（组件内管弹出/键盘/勾选），
									这里只接 choose——继续走 onModelChange 的会话级语义，不碰全局当前模型。
								-->
								<ModelPicker
									ref="modelPickerRef"
									:options="modelOptions"
									:value="modelValueAsOptionId"
									:current-label="currentModelTitle"
									:switching="switchingModel"
									:disabled="modelOptions.length === 0"
									@choose="onModelChange"
								/>
								</div>
								<n-button class="chat-send-button" type="primary" aria-label="发送" title="发送" :loading="attachmentBusy" :disabled="!canChat || (!draft.trim() && !attachments.length) || attachmentBusy || !can('session.run')" @click="send">
									<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6" /></svg>
								</n-button>
							</div>
						</div>
					</footer>
				</section>
			</div>
		</n-spin>
	</PageShell>
</template>

<style scoped>
.chat-alert {
	margin-bottom: 12px;
}
/* 输入框上方的命令面板靠绝对定位浮起来，这一层是它的定位上下文 */
.chat-input-wrap {
	position: relative;
	flex: 1;
	min-width: 0;
}
/* 压缩提示：低调但看得见，说明"上下文被压过"这件事实 */
/* 压缩进行中状态条：旋转圈 + 流动光带。压缩是几十秒级的真实模型调用，
   这段等待必须有「它在干活」的可视证据，否则像卡死。 */
.chat-compacting {
	display: flex;
	align-items: center;
	gap: 10px;
	margin: 0 0 12px;
	padding: 10px 14px;
	background: linear-gradient(90deg, rgba(108,124,255,.06), rgba(108,124,255,.02));
	border: 1px solid rgba(108,124,255,.25);
	border-radius: 10px;
	font-size: 13px;
	color: #4b5268;
	position: relative;
	overflow: hidden;
}
.chat-compacting-spin {
	width: 14px;
	height: 14px;
	border: 2px solid rgba(108,124,255,.25);
	border-top-color: #6c7cff;
	border-radius: 50%;
	animation: compacting-rotate .9s linear infinite;
	flex: none;
}
@keyframes compacting-rotate { to { transform: rotate(360deg); } }
.chat-compacting-text { flex: none; }
/* 光带：底边一条来回流动的细线，暗示「还在跑」 */
.chat-compacting-bar {
	position: absolute;
	left: 0; right: 0; bottom: 0;
	height: 2px;
	background: rgba(108,124,255,.10);
	overflow: hidden;
}
.chat-compacting-bar-fill {
	position: absolute;
	top: 0; left: -30%;
	width: 30%; height: 100%;
	background: linear-gradient(90deg, transparent, #6c7cff, transparent);
	animation: compacting-flow 1.6s ease-in-out infinite;
}
@keyframes compacting-flow { to { left: 100%; } }
/* 压缩提示滑入/滑出：不是装饰——出现时消息列表刚被换过，动画帮用户看清"列表变了" */
.notice-enter-active, .notice-leave-active { transition: opacity .25s ease, transform .25s ease; }
.notice-enter-from, .notice-leave-to { opacity: 0; transform: translateY(-8px); }
.chat-compaction-record {
	margin: 0 0 14px;
	padding: 12px 14px;
	border: 1px solid #cbdde3;
	border-radius: 8px;
	background: #f5fafb;
	color: #344b50;
}
.chat-compaction-record > header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	flex-wrap: wrap;
	gap: 8px;
}
.chat-compaction-badge {
	display: inline-flex;
	align-items: center;
	padding: 3px 8px;
	border-radius: 5px;
	background: #e2f0f2;
	color: #245d65;
	font-size: 12px;
	font-weight: 600;
}
.chat-compaction-record > header > span:last-child { color: #65777b; font-size: 12px; }
.chat-compaction-summary { margin-top: 9px; padding-top: 9px; border-top: 1px solid #dce8ea; }
/* 计划模式标记滑入滑出 */
.badge-enter-active, .badge-leave-active { transition: opacity .2s ease, transform .2s ease; }
.badge-enter-from, .badge-leave-to { opacity: 0; transform: translateX(-10px); }
@media (prefers-reduced-motion: reduce) {
	.notice-enter-active, .notice-leave-active,
	.badge-enter-active, .badge-leave-active { transition: none; }
	.chat-compacting-spin, .chat-compacting-bar-fill { animation: none; }
}
.chat-compacted {
	border: 1px dashed var(--border);
	border-radius: 10px;
	padding: 8px 10px;
	font-size: 12px;
	background: var(--panel);
}
.plan-badge {
	display: inline-flex;
	align-items: center;
	padding: 2px 10px;
	border-radius: 999px;
	font-size: 12px;
	color: #b45309;
	background: #fef3c7;
	border: 1px solid #fcd34d;
}
.chat-compacted-head {
	font-weight: 600;
}
.chat-layout {
	display: grid;
	grid-template-columns: 260px minmax(0, 1fr);
	gap: 16px;
	min-height: 560px;
}
.chat-list {
	display: flex;
	flex-direction: column;
	gap: 10px;
	border-right: 1px solid var(--border);
	padding-right: 12px;
}
.chat-list-head {
	display: flex;
	flex-direction: column;
	gap: 8px;
}
.chat-list-title {
	font-size: 12px;
	color: var(--muted);
}
.chat-sessions {
	list-style: none;
	margin: 0;
	padding: 0;
	display: flex;
	flex-direction: column;
	gap: 2px;
	overflow-y: auto;
	max-height: 520px;
}
.chat-session {
	padding: 8px 10px;
	border-radius: 8px;
	cursor: pointer;
}
.chat-session:hover {
	background: var(--hover);
}
.chat-session.active {
	background: var(--active);
}
.chat-session-title {
	font-size: 13px;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.chat-session-pin { margin-left: 6px; color: var(--text-2); font-size: 11px; white-space: nowrap; }
.chat-session-meta {
	margin-top: 4px;
	display: flex;
	gap: 4px;
}
.chat-main {
	display: flex;
	flex-direction: column;
	min-width: 0;
}
.chat-head {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding-bottom: 10px;
	border-bottom: 1px solid var(--border);
}
.chat-head-title {
	font-weight: 600;
}
.chat-head-tags {
	display: flex;
	align-items: center;
	gap: 6px;
}
/* 上下文用量：背景信息，不是操作入口——灰字 + 虚线边，别跟计划模式那种状态标记抢视线 */
.chat-usage {
	display: inline-flex;
	align-items: center;
	padding: 1px 8px;
	border: 1px dashed var(--border);
	border-radius: 999px;
	font-size: 12px;
	font-variant-numeric: tabular-nums;
	color: var(--muted);
	cursor: default;
}
/* 用掉八成以上才换色：这个量再聊几轮就得压缩了 */
.chat-usage.warn {
	color: #b45309;
	border-color: #fcd34d;
	background: #fef3c7;
}
.chat-scroll {
	flex: 1;
	min-height: 0;
	overflow-y: auto;
	padding: 16px 4px;
	display: flex;
	flex-direction: column;
	gap: 14px;
}
.chat-msg {
	display: flex;
	flex-direction: column;
	gap: 4px;
	max-width: 88%;
}
.chat-msg.user {
	align-self: flex-end;
	align-items: flex-end;
}
.chat-msg.user.with-activity { width: 100%; max-width: 100%; align-self: stretch; align-items: stretch; }
.chat-msg.user.with-activity > .chat-role,
.chat-msg.user.with-activity > .chat-bubble { align-self: flex-end; }
.chat-msg.user.with-activity :deep(.turn-timing) { align-self: stretch; width: 100%; }
.chat-role {
	font-size: 11px;
	opacity: 0.6;
}
.chat-bubble {
	padding: 10px 12px;
	border-radius: 10px;
	background: var(--panel);
	white-space: pre-wrap;
	word-break: break-word;
	line-height: 1.6;
}
.chat-msg.user .chat-bubble {
	background: var(--brand-soft);
}
.chat-thinking {
	border-left: 2px solid var(--border);
	padding-left: 10px;
}
.chat-thinking-head {
	background: none;
	border: none;
	padding: 0;
	font-size: 12px;
	cursor: pointer;
	opacity: 0.7;
}
.chat-thinking-body {
	margin: 6px 0 0;
	font-size: 12px;
	white-space: pre-wrap;
	opacity: 0.7;
}
.chat-input {
	padding-top: 12px;
	border-top: 1px solid var(--border);
	display: flex;
	flex-direction: column;
	gap: 8px;
}
/* 附件靠左；用量、模型和发送作为一组贴在右侧。 */
.chat-compose-actions {
	display: flex;
	align-items: center;
	justify-content: flex-start;
	gap: 10px;
}
.chat-compose-main-actions { display: flex; align-items: center; gap: 16px; min-width: 0; margin-left: auto; }
.chat-compose-main-actions :deep(.chat-send-button) { width: 34px; height: 34px; padding: 0; border-radius: 50%; }
.queue-status { color: var(--text-muted); font-size: 12px; }
.chat-compose-main-actions :deep(.chat-send-button svg) { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.chat-model-picker {
	display: flex;
	align-items: center;
	gap: 8px;
	min-width: 0;
}
.chat-model-select {
	width: 210px;
}
/* 上下文用量圆环：贴模型选择器，SVG 描边显示占比，中心文字用 k */
.ctx-ring {
	position: relative;
	width: 18px;
	height: 18px;
	flex: none;
	cursor: default;
}
.ctx-ring-tooltip {
	position: absolute;
	left: 50%;
	bottom: calc(100% + 8px);
	z-index: 40;
	display: grid;
	gap: 4px;
	width: max-content;
	max-width: min(272px, calc(100vw - 32px));
	padding: 8px 10px;
	border-radius: 8px;
	background: #191b1e;
	color: #f5f5f5;
	box-shadow: 0 8px 24px rgba(0, 0, 0, .22);
	font-size: 12px;
	line-height: 1.35;
	text-align: center;
	white-space: normal;
	opacity: 0;
	visibility: hidden;
	transform: translate(-50%, 4px);
	transition: opacity .14s ease, transform .14s ease, visibility .14s ease;
	pointer-events: none;
}
.ctx-ring-tooltip::after {
	position: absolute;
	top: 100%;
	left: 50%;
	border: 5px solid transparent;
	border-top-color: #191b1e;
	content: "";
	transform: translateX(-50%);
}
.ctx-ring-tooltip b { font-weight: 600; }
.ctx-ring:hover .ctx-ring-tooltip,
.ctx-ring:focus-visible .ctx-ring-tooltip {
	opacity: 1;
	visibility: visible;
	transform: translate(-50%, 0);
}
.ctx-ring-svg { width: 100%; height: 100%; transform: rotate(-90deg); }
.chat-file-input { display: none; }
.chat-attachments { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 8px; }
.chat-attachment { display: inline-flex; align-items: center; gap: 6px; min-width: 0; padding: 3px 7px; border: 1px solid var(--line); border-radius: 6px; font-size: 12px; }
.ctx-ring-track { fill: none; stroke: rgba(108,124,255,.15); stroke-width: 5; }
.ctx-ring-fill {
	fill: none;
	stroke: #6c7cff;
	stroke-width: 5;
	stroke-linecap: round;
	transition: stroke-dasharray .6s ease, stroke .3s ease;
}
.ctx-ring.warn .ctx-ring-fill { stroke: #e08a3c; }
.ctx-ring-text {
	position: absolute;
	width: 1px;
	height: 1px;
	overflow: hidden;
	clip-path: inset(50%);
	white-space: nowrap;
	visibility: hidden;
	pointer-events: none;
}
@media (prefers-reduced-motion: reduce) { .ctx-ring-fill { transition: none; } }
/* 说明文字：模拟模型时会顶掉长模型名，所以允许省略号 */
.chat-model-label {
	font-size: 12px;
	color: var(--muted);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
@media (max-width: 760px) {
	.chat-layout {
		display: block;
		height: calc(100dvh - 215px);
		min-height: 420px;
	}
	.chat-list {
		display: none;
		max-height: 240px;
		overflow-y: auto;
		border: 1px solid var(--line);
		padding: 12px;
		margin-bottom: 12px;
		background: white;
	}
	.chat-layout.show-sessions .chat-list { display: flex; }
	.chat-main { height: 100%; }
	.chat-scroll { padding: 16px; }
	.chat-input { padding: 12px; }
}
</style>
