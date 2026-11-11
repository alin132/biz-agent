<script setup>
/**
	 * E2E-MARKER-7K91
	 */
	/**
 * Agent 专属对话页：/agents/:id/chat
 *
 * 为什么单独一页：Agent 的对话不是"普通会话里恰好绑了个 Agent"——它用的是这个 Agent 的
 * 模型策略、人格指令、技能与知识库绑定。混在通用对话页里，多个 Agent 的历史会挤在同一条
 * 列表上，用户分不清"我在跟谁说话"。这里按 agentId 归位：本页只列这个 Agent 的历史。
 *
 * 三条如实呈现的约定（沿用对话页的既有约定）：
 *  1. Agent 已停用 / 已被删：如实说明并停用输入，不假装还能聊；
 *  2. 打不开的历史会话单独提示，其余照常可读——不能因为一条会话坏了就整页空白；
 *  3. 模拟模型（LLM_DISABLE=1）标出来，否则用户会以为是自己选的模型在答。
 *
 * 消息、SSE、审批、审计仍走会话的既有链路，这里不另造一套聊天协议。
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

const agentId = computed(() => String(route.params.id ?? ""));
const agent = ref(null);
const incomplete = ref(false);
const agentError = ref("");

const activity = useSessionActivity();
const showSessions=ref(false),sessionQuery=ref("");
const pinRevision = ref(0);
async function removed() { closeStream();current.value=null;messages.value=[];streamText.value="";streamThinking.value="";sending.value=false;activity.hydrate({});await router.replace({name:"agent-chat",params:{id:agentId.value},query:{}});await refreshList(); }
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
const busy = ref(false);
const error = ref("");
const streamText = ref("");
const streamThinking = ref("");
const showThinking = ref(false);

let events = null;
let openSessionSequence = 0;
const sessionDrafts = new Map();
const scrollBox = ref(null);

const STATUS_META = {
	draft: { label: "草稿", type: "default" },
	testing: { label: "试运行", type: "info" },
	published: { label: "已发布", type: "success" },
	stopped: { label: "已停用", type: "warning" },
};

const statusLabel = computed(() => STATUS_META[agent.value?.status]?.label ?? agent.value?.status ?? "");
/** 与后端一致：已停用的 Agent 拒绝对话（409 stopped_not_chattable），界面提前把这条路堵上 */
const canStart = computed(() => Boolean(agent.value) && agent.value.status !== "stopped");

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

/** 把会话快照灌进消息列表。transcript 是唯一真相。 */
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
				// 新一轮压缩开始后，旧的「内容不足」提示不再描述当前状态。
				error.value = "";
				compacting.value = true;
				startCompactingTimer();
				break;
			case "workflow":
				if(current.value) current.value={...current.value,steps:payload.steps,current:payload.current,done:payload.done};
				break;
			case "ready":
				current.value = payload.session;
				hydrate(payload.session);
				selectedModel.value = payload.session?.modelKey ?? null;
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
				compacting.value = false;
				stopCompactingTimer();
				if (!streamText.value && payload.text) streamText.value = payload.text;
				if (streamText.value.trim()) {
					messages.value.push({ role: "assistant", text: streamText.value, at: Date.now() });
				}
				streamText.value = "";
				streamThinking.value = "";
				sending.value = false;
				scrollToEnd();
				break;
			case "plan":
				// 计划模式开关变了（本页或别的入口切的）：跟着会话状态走
				if (current.value) current.value.planMode = Boolean(payload.planMode);
				break;
			case "thinking_level":
				if (current.value) current.value.thinkingLevel = payload.thinkingLevel;
				break;
			case "compacted":
				compacting.value = false;
				stopCompactingTimer();
				applyCompressedTranscript(payload.transcript);
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

/**
 * 把当前会话写回路由。
 *
 * Agent 页点「对话 / 试运行」已经建好会话，URL 里带着 session；那种情况下不能再写一次
 * （router.replace 到同一个地址会触发下面的 watch，白跑一轮）。只有"在这里新开的会话"
 * 才需要补进地址栏，刷新后仍然停在同一条会话上。
 */
function syncRoute(sessionId) {
	if (route.query.session === sessionId) return;
	router.replace({ name: "agent-chat", params: { id: agentId.value }, query: { session: sessionId } });
}

async function openSession(id) {
 const sequence = ++openSessionSequence;
 const requestedAgentId = agentId.value;
 showSessions.value=false;
	error.value = "";
	attachments.value = [];
	let view;
	try {
		view = await http.get(`/api/sessions/${id}`);
	} catch (cause) {
		if (sequence !== openSessionSequence || requestedAgentId !== agentId.value) return;
		throw cause;
	}
	if (sequence !== openSessionSequence || requestedAgentId !== agentId.value) return;
	// 路由串了 Agent 的被拒会话：如实说明，不硬把它显示成本 Agent 的历史
	if ((view.agentId ?? null) !== requestedAgentId) {
		error.value = "这条会话不属于当前 Agent，已回到本 Agent 的对话列表。";
		current.value = null;
		messages.value = [];
		closeStream();
		return;
	}
	if (current.value?.id !== id) {
		if (current.value) sessionDrafts.set(current.value.id, draft.value);
		draft.value = sessionDrafts.get(id) ?? "";
		compacting.value = false;
		stopCompactingTimer();
		contextSession.value = null;
	}
	current.value = view;
	const index = sessions.value.findIndex((item) => item.id === id);
	if (index < 0) sessions.value.push(view);
	else sessions.value[index] = view;
	if (!titleOf(view).toLowerCase().includes(sessionQuery.value.toLowerCase())) sessionQuery.value = "";
	hydrate(view);
	selectedModel.value = view?.modelKey ?? null;
	// 上下文用量是这条会话的累计值：换会话必须清零，否则数字会串到别的对话上
	resetUsage();
	subscribe(id);
	syncRoute(id);
}

/** 只列本 Agent 的会话："Agent 的对话归 Agent 自己"这一条在这里落地 */
async function refreshList() {
	const list = await agentsApi.sessions(agentId.value);
	sessions.value = list.filter((item) => (item.agentId ?? null) === agentId.value);
}

async function loadAgent() {
	try {
		agent.value = await agentsApi.get(agentId.value);
		agentError.value = "";
	} catch (cause) {
		agent.value = null;
		agentError.value = `读取 Agent 失败：${cause.message}`;
	}
}

/** 新开一条属于本 Agent 的会话（试运行/对话点进来走的也是这条链路） */
async function createSession() {
	error.value = "";
	busy.value = true;
	try {
		const view = await agentsApi.startChat(agentId.value);
		await refreshList();
		await openSession(view.id);
	} catch (cause) {
		error.value = cause?.message ?? "开对话失败";
	} finally {
		busy.value = false;
	}
}

/**
 * 初值：优先认地址栏里那条会话，它不在本 Agent 名下就别用（否则刷新/被拒的链接会串页）；
 * 没有或不能用时，落到最近的一条历史会话；一条都没有就只显示引导，不擅自新建——
 * 路过一次页面就多一条空会话，历史列表会被垃圾塞满。
 */
async function bootstrap() {
	loading.value = true;
	error.value = "";
	try {
		await loadAgent();
		if (!agent.value) return;
		await refreshList();
		const wanted = typeof route.query.session === "string" ? route.query.session : "";
		const usable = wanted && sessions.value.some((item) => item.id === wanted) ? wanted : "";
		if (usable) {
			await openSession(usable);
			return;
		}
		if (sessions.value.length > 0) {
			await openSession(sessions.value[sessions.value.length - 1].id);
		}
	} catch (cause) {
		error.value = cause?.message ?? "加载失败";
	} finally {
		loading.value = false;
	}
}

async function send() {
	const text = draft.value.trim();
	if ((!text && attachments.value.length === 0) || !current.value || toolbarBusy.value) return;
	const alreadyRunning = sending.value;
	const outgoing = buildOutgoingText(text, attachments.value);
	draft.value = "";
	error.value = "";
	attachments.value = [];
	const turn = { role: "user", text: outgoing, at: Date.now(), tools: [], durationMs: 0 };
	messages.value.push(turn);
	activity.beginTurn(turn);
	// 用户这条立刻计入：只在轮末结算的话，敲完一条会先看到数字纹丝不动
	sending.value = true;
	scrollToEnd();
	try {
		await http.post(`/api/sessions/${current.value.id}/messages`, { text: outgoing });
	} catch (cause) {
		error.value = cause?.message ?? "发送失败";
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

async function stopGeneration() {
	if (!current.value || !sending.value) return;
	try {
		await sessionApi.stop(current.value.id);
	} catch (cause) {
		error.value = cause?.message ?? "停止生成失败";
	}
}

function onKeydown(event) {
	// 面板开着时键盘归它：上下选命令、回车执行、Esc 收起
	if (handleSlashKeydown(event)) return;
	if (event.key === "Enter" && !event.shiftKey) {
		event.preventDefault();
		send();
	}
}

const canChat = computed(() => Boolean(current.value) && canStart.value && !toolbarBusy.value);
const modeBadge = computed(() => current.value?.modeLabel ?? null);

/* ── 以下与对话页（Chat.vue）同款：模型选择 / 斜杠命令 / 计划模式 / 压缩 ──────────
 * 为什么不抽 composable：两页对「当前会话」的来源不同（这里是 agent 名下的会话），
 * 先对齐功能让用户不觉得割裂；等两边稳定后（task-7 验收过）再抽 useChatSession。
 * 复制是有意为之并留了注释，别在功能对齐前强行合并。 */
const message = useMessage();

const planModeOn = computed(() => Boolean(current.value?.planMode));
const compacting = ref(false);
const compactingElapsed = ref(0);
let compactingTimer = null;
const compactingText = computed(() => compactingElapsed.value < 8 ? "正在压缩上下文：总结旧对话…" : "对话较长，仍在压缩中，可能需要几分钟…");
function startCompactingTimer() {
	stopCompactingTimer();
	compactingElapsed.value = 0;
	compactingTimer = setInterval(() => { compactingElapsed.value += 1; }, 1000);
}
function stopCompactingTimer() {
	if (compactingTimer) { clearInterval(compactingTimer); compactingTimer = null; }
}

// 模型选择（会话级；Agent 会话换模型走同一个接口）
const modelOptions = ref([]);
const modelRows = ref([]);
const globalSimulated = ref(false);
const switchingModel = ref(false);
const selectedModel = ref(null);

async function loadModels() {
	try {
		const data = await modelsApi.list();
		modelOptions.value = Array.isArray(data?.options) ? data.options : [];
		modelRows.value = Array.isArray(data?.models) ? data.models : [];
		globalSimulated.value = data?.mode === "simulated";
	} catch {
		modelOptions.value = [];
	}
}

/** 会话的 modelKey（行 id）翻译成 options 命名空间的 modelId；翻译不出就原样返回 */
const modelKeyToOptionId = (key) => {
	if (!key) return key;
	const row = modelRows.value.find((candidate) => candidate.id === key);
	return row?.modelId ?? key;
};
const modelValue = computed(() => {
	if (!current.value) return selectedModel.value;
	return current.value.modelKey ?? selectedModel.value ?? null;
});
const modelValueAsOptionId = computed(() => modelKeyToOptionId(modelValue.value));
const isSimulated = computed(() => globalSimulated.value || current.value?.mode === "simulated");
const modelHint = computed(() =>
	isSimulated.value ? "模拟模型（未接入真实模型）" : `当前：${current.value?.modeLabel ?? "真实模型"}`,
);
const currentModelTitle = computed(() => {
	const key = modelValue.value;
	if (!key) return modelHint.value;
	const optionId = modelKeyToOptionId(key);
	const hit = modelOptions.value.find((option) => option.id === optionId);
	return hit?.label ?? optionId;
});

/* ---------------- 上下文用量（头部常驻的「已用 / 总量」） ---------------- */

/* 与对话页同款：两边逻辑有意复制，等两页功能稳定后再抽公共 composable
   （见本文件顶部关于"复制"的说明）。契约完全一致——
   纯内存累计、换会话清零、不落库，估算口径见 estimateTokens。 */

/**
 * 已用 token：**当前会话**的累计值。
 *
 * 服务端不广播每轮的用量（SSE 的 WireEvent 里没有 usage 字段），所以按同一份
 * 发出去的内容估算：用户消息 + 助手回复（含思考块），口径与
 * server/observability/trace.ts 的 estimateTokens 一致
 * （中日韩字 1 字 ≈ 1 token，其余非空白 4 字符 ≈ 1 token）。
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

/** 头部胶囊的文案「29k/256k」；没配窗口时只显示已用，不编总量 */
const usageText = computed(() => {
	const used = formatTokens(usedTokens.value);
	const total = contextWindow.value;
	return total > 0 ? used + "/" + formatTokens(total) : used;
});

/** hover 给精确数字：k 是取整过的 */
const usageTitle = computed(() => {
	const used = String(Math.max(0, Math.round(usedTokens.value)));
	const total = contextWindow.value;
	const source = contextEstimated.value ? "估算" : "模型返回";
	return total > 0
		? "上下文用量（" + source + "）：" + usageText.value + "；精确数值 " + used + " / " + total + " tokens"
		: "上下文用量（" + source + "）：" + usageText.value + "；精确数值 " + used + " tokens（未配置上下文窗口）";
});
const usagePercent = computed(() => contextWindow.value > 0 ? Math.round((usedTokens.value / contextWindow.value) * 100) : null);

/** 用掉超过 80% 换警示色：这个量再聊几轮就要压缩了 */
const usageWarn = computed(() => contextWindow.value > 0 && usedTokens.value / contextWindow.value > 0.8);
const ctxRingDash = computed(() => contextRingDash(usedTokens.value, contextWindow.value));

async function onModelChange(modelId) {
	if (!modelId) return;
	// 用户确实点了这一行：上下文窗口照它算（模拟模式下后端不会把它记进会话，见 contextWindow）
	pickedModelKey.value = modelRowKeyOf(modelId);
	if (!current.value) {
		selectedModel.value = modelId;
		return;
	}
	if (modelId === current.value.modelKey) return;
	switchingModel.value = true;
	error.value = "";
	try {
		const result = await sessionApi.setModel(current.value.id, modelId);
		current.value = result?.session ?? current.value;
		selectedModel.value = current.value.modelKey ?? null;
		// 后端可能拒绝（例如模拟模式选不了模型）：上面已按用户点选的行记了 pickedModelKey，
		// 那是界面自己的账，不受接口成败影响。
		if (Array.isArray(result?.modelRows) && result.modelRows.length > 0) {
			modelRows.value = result.modelRows;
		}
		message.success(`已切换这条对话的模型：${current.value.modeLabel || "模拟模型"}`);
	} catch (err) {
		error.value = err?.message ?? "换模型失败";
	} finally {
		switchingModel.value = false;
	}
}

// 斜杠命令（命令表与面板与对话页共用一份）
const slashOpen = ref(false);
/** 命令表与对话页共用：执行函数接到本页的动作上。
 * 必须包 computed——createSlashCommands 返回的是普通数组，
 * 不包 .value 就取不到，slashFiltered 里 slashCommands.value 会是 undefined（实测踩过：面板永远弹不出）。 */
const slashCommands = computed(() =>
	createSlashCommands({
		compact: () => compactContext(),
		plan: () => togglePlanMode(),
		mcp: () => router.push({ name: "mcp" }),
		skills: current.value?.skills ?? [],
		skill: (skillId) => selectSkill(skillId),
		piSkills: piSkills.value,
		piSkill: (name) => {
			draft.value = `/skill:${name} `;
			nextTick(() => document.querySelector(".chat-input textarea")?.focus());
		},
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
const slashQuery = ref("");
/** 面板要显示的项：按输入框里的过滤词筛（与对话页同一套规则） */
const slashFiltered = computed(() => {
	const query = slashQuery.value.trim().toLowerCase();
	if (!query) return slashCommands.value;
	return slashCommands.value.filter((item) =>
		[item.label, ...(item.aliases ?? [])].some((word) => String(word).toLowerCase().includes(query)),
	);
});
const slashActiveIndex = ref(0);

function onDraftInput() {
	const query = slashQueryOf(draft.value);
	if (query === null) {
		slashOpen.value = false;
		slashQuery.value = "";
		return;
	}
	slashOpen.value = true;
	slashQuery.value = query;
	slashActiveIndex.value = 0;
}

function onSlashPick(command) {
	slashOpen.value = false;
	if (command?.kind === "pi-skill") {
		command.run();
		return;
	}
	draft.value = "";
	command?.run?.();
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

async function showPiStats(targetSession = current.value) {
	if (!targetSession) return;
	try {
		piStats.value = await sessionApi.piStats(targetSession.id);
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

function handleSlashKeydown(event) {
	if (!slashOpen.value) return false;
	if (event.key === "ArrowDown" || event.key === "ArrowUp") {
		event.preventDefault();
		const total = slashFiltered.value.length;
		if (total > 0) {
			slashActiveIndex.value = event.key === "ArrowDown"
				? (slashActiveIndex.value + 1) % total
				: (slashActiveIndex.value - 1 + total) % total;
		}
		return true;
	}
	if (event.key === "Enter") {
		event.preventDefault();
		const picked = slashFiltered.value[slashActiveIndex.value];
		if (picked) onSlashPick(picked);
		return true;
	}
	if (event.key === "Escape") {
		event.preventDefault();
		slashOpen.value = false;
		return true;
	}
	return false;
}

/** /plan：切换计划模式（是开关，不是单向） */
async function togglePlanMode() {
	if (!current.value) {
		error.value = "先打开一个对话，再切换计划模式。";
		return;
	}
	try {
		const view = await sessionApi.setPlan(current.value.id, !planModeOn.value);
		current.value = view ?? current.value;
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

/** /compact：压缩上下文，并把摘要记录放入对话时间线。 */
async function compactContext(targetSession = current.value) {
	if (!targetSession) {
		error.value = "先打开一个对话，再压缩。";
		return;
	}
	if ((sending.value && current.value?.id === targetSession.id) || compacting.value) {
		error.value = compacting.value ? "正在压缩，稍候" : "上一条还没回完，等回复落地再压缩";
		return;
	}
	compacting.value = true;
	startCompactingTimer();
	error.value = "";
	const sessionId = targetSession.id;
	try {
		await sessionApi.compact(sessionId);
		const view = await http.get(`/api/sessions/${sessionId}`);
		if (current.value?.id === sessionId) {
			current.value = view;
			applyCompressedTranscript(view.transcript);
		}
	} catch (err) {
		const detail = String(err?.message ?? "");
		error.value = /Nothing to compact/i.test(detail)
			? "当前对话还比较短，没有足够的旧内容可压缩。继续对话后再试。"
			: detail || "压缩失败";
	} finally {
		compacting.value = false;
		stopCompactingTimer();
	}
}

onMounted(() => {
	bootstrap();
	pluginsApi.list().then((plugins) => { piSkills.value = piSkillsFromPlugins(plugins); }).catch((cause) => { error.value = cause?.message ?? "读取 Pi 技能失败"; });
	// Agent 专属页同样需要模型选择器：模型列表不拉，控件会一直置灰（实测踩过）
	loadModels();
});
onBeforeUnmount(() => {
	openSessionSequence += 1;
	closeStream();
	stopCompactingTimer();
});

/**
 * 换 Agent：/agent-chat/A → /agent-chat/B 命中的是同一条路由记录，Vue 会复用同一个组件实例，
 * onMounted 不会重跑。不在这里重来一遍，页面会停在上一个 Agent 的名字和历史会话上
 * （地址栏已经变了、内容还是旧的）——这正是"聊天窗口串台"最难看的样子。
 * 因此 agentId 变化必须重新 bootstrap，并清空上一位 Agent 遗留的状态。
 */
watch(agentId, async (next, previous) => {
	if (!next || next === previous) return;
	openSessionSequence += 1;
	current.value = null;
	messages.value = [];
	sessions.value = [];
	streamText.value = "";
	streamThinking.value = "";
	closeStream();
	await bootstrap();
});

// 地址栏里的会话变了（浏览器前进/后退、外链带 session）才重新打开；
// 本页自己 replace 时 openSession 已经拉过一次，且会写进 current，这里天然不重复。
watch(() => route.query.session, async (id) => {
	if (typeof id !== "string" || !id || id === current.value?.id) return;
	try {
		await openSession(id);
	} catch (cause) {
		// 打不开的历史会话只提示，不把整页打成错误态——其余会话还得能读
		incomplete.value = true;
		error.value = `打不开这条会话：${cause.message}`;
	}
});
</script>

<template>
	<PageShell wide :title="agent ? agent.name : 'Agent 对话'" :subtitle="agent?.description || '这个 Agent 的专属对话；它的历史不会混进通用对话页'">
		<template #actions>
<n-button class="chat-list-toggle" @click="showSessions=!showSessions">会话列表</n-button>
			<n-button v-if="current" size="small" @click="piTreeOpen=true">Pi 会话树</n-button>
			<n-button size="small" @click="router.push({ name: 'agents' })">返回 Agent 列表</n-button>
			<n-button type="primary" size="small" :loading="busy" :disabled="!canStart" @click="createSession">
				新对话
			</n-button>
		</template>

		<div class="agent-banner">
			<span class="agent-banner-label">当前 Agent</span>
			<span class="agent-banner-name">{{ agent?.name ?? agentId }}</span>
			<n-tag v-if="statusLabel" size="small" :bordered="false" :type="STATUS_META[agent?.status]?.type ?? 'default'">
				{{ statusLabel }}
			</n-tag>
			<span v-if="!canStart" class="agent-banner-hint">已停用，不能开新对话；恢复为草稿后即可继续</span>
		</div>

		<n-alert v-if="agentError" type="error" :bordered="false" class="chat-alert">{{ agentError }}</n-alert>
		<n-alert v-else-if="error" type="error" :bordered="false" class="chat-alert">{{ error }}</n-alert>

		<!-- Agent 不存在（已被删除）：别显示一个空壳对话页，给一条回列表的路 -->
		<n-empty v-if="!loading && !agent && !agentError" description="这个 Agent 不存在或已被删除">
			<template #extra>
				<n-button size="small" @click="router.push({ name: 'agents' })">返回 Agent 列表</n-button>
			</template>
		</n-empty>

		<n-spin v-else :show="loading">
			<div class="chat-layout" :class="{'show-sessions':showSessions}">
				<aside class="chat-list">
					<div class="chat-list-head">
						<div class="chat-list-title">这个 Agent 的对话</div>
						<n-button type="primary" size="small" block :loading="busy" :disabled="!canStart" @click="createSession">
							新对话
						</n-button>
					</div>
					<n-input v-model:value="sessionQuery" placeholder="搜索会话" clearable style="margin:10px 0"/>
<ul class="chat-sessions">
						<li
							v-for="item in visibleSessions"
							:key="item.id"
							class="chat-session"
							:data-session-id="item.id"
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
					<n-empty v-if="!loading && sessions.length === 0" description="这个 Agent 还没有对话" size="small" />
				</aside>

				<section class="chat-main">
					<PiSessionTree v-model:show="piTreeOpen" :session-id="current?.id" :can-fork="Boolean(current && !sending && !current.pendingApprovals?.length)" :can-navigate="Boolean(current && !sending && !current.pendingApprovals?.length)" @navigate="onPiTreeNavigate" @fork="onPiTreeFork" />
					<PiSessionStats v-model:show="piStatsOpen" :stats="piStats" />
					<SessionContextMenu ref="sessionContextMenuRef" :session="contextSession" :x="contextX" :y="contextY" :busy="toolbarBusy || (sending && contextSession?.id === current?.id)" :pinned="contextSession ? pinnedIds.includes(contextSession.id) : false" @close="contextSession=null" @pin="toggleSessionPin(contextSession)" @busy="toolbarBusy=$event" @updated="onContextSessionUpdated" @removed="onContextSessionRemoved" @created="onContextSessionCreated" @compact="compactContext" @stats="showPiStats" />
					<header v-if="current" class="chat-head">
						<div class="chat-head-title">{{ titleOf(current) }}</div>
						<div class="chat-head-tags">
							<n-tag size="small" type="info" :bordered="false">{{ agent?.name ?? agentId }}</n-tag>
							<n-tag v-if="modeBadge" size="small" :bordered="false">{{ modeBadge }}</n-tag>
							<Transition name="badge">
								<span v-if="planModeOn" class="plan-badge" data-testid="plan-mode-badge">计划模式</span>
							</Transition>
							<n-button v-if="planModeOn" size="tiny" quaternary @click="togglePlanMode">关闭计划模式</n-button>
						</div>
					</header>

					<div ref="scrollBox" class="chat-scroll">
						<n-empty v-if="!current" description="点「新对话」开始跟这个 Agent 说话" />
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
								<span>{{ compactingText }}</span>
								<div class="chat-compacting-bar" aria-hidden="true"><span class="chat-compacting-bar-fill"></span></div>
							</div>
						</Transition>
					</div>

					<footer class="chat-input">
						<!-- 斜杠命令面板绝对定位在输入框上方，这一层是它的定位上下文 -->
						<div class="chat-slash-anchor">
							<SlashCommandPanel
								v-if="slashOpen"
								:query="slashQuery"
								:items="slashFiltered"
								:index="slashActiveIndex"
								@run="onSlashPick"
								@update:index="slashActiveIndex = $event"
							/>
						</div>
						<input
							ref="fileInput"
							type="file"
							multiple
							accept=".txt,.md,.json,.csv,.log,.yaml,.yml,.pdf,.doc,.docx"
							class="chat-file-input"
							@change="addFiles($event.target.files)"
						/>
						<div v-if="attachments.length" class="chat-attachments" aria-label="待发送附件">
							<div v-for="(file, index) in attachments" :key="`${file.name}-${index}`" class="chat-attachment">
								<span>{{ file.name }}</span>
								<n-button size="tiny" quaternary :aria-label="`移除附件 ${file.name}`" @click="attachments.splice(index, 1)">移除</n-button>
							</div>
						</div>
						<n-input
							v-model:value="draft"
							type="textarea"
							:autosize="{ minRows: 2, maxRows: 6 }"
							placeholder="说点什么，Enter 发送，Shift+Enter 换行；敲 / 看命令"
							:disabled="!canChat||!can('session.run')"
							@keydown="onKeydown"
							@input="onDraftInput"
						/>
						<div class="chat-compose-actions">
						<n-button quaternary :loading="attachmentBusy" :disabled="attachmentBusy || toolbarBusy || !current" @click="fileInput?.click()">附加文件</n-button>
						<span v-if="queuedFollowUps.length" class="queue-status">已排队 {{ queuedFollowUps.length }} 条</span>
							<!--
								上下文用量圆环：输入框左下角，同对话页（SVG 占比 + 中心 k 数 + 警示色）。
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
								<!-- Codex 风格模型选择器：与对话页同款，会话级切换 -->
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
				<n-button v-if="sending" type="warning" class="chat-send-button" aria-label="停止" title="停止" :disabled="!can('session.run')" @click="stopGeneration">停止</n-button>
							</div>
						</div>
					</footer>
				</section>
			</div>
		</n-spin>
	</PageShell>
</template>

<style scoped>
/* ── 与对话页同款的样式：计划模式标记 / 压缩提示 / 动画 / 模型行 ── */
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
.chat-compacted {
	margin: 0 0 12px;
	padding: 10px 14px;
	background: #f6f7fb;
	border: 1px solid #e4e8f2;
	border-radius: 10px;
	font-size: 13px;
}
.chat-compacting {
	display: grid;
	grid-template-columns: 14px minmax(0, 1fr);
	align-items: center;
	gap: 8px;
	padding: 10px 12px;
	color: #4b5268;
	background: #f6f7fb;
	border: 1px solid #e4e8f2;
	border-radius: 8px;
	font-size: 13px;
}
.chat-compacting-spin {
	width: 13px;
	height: 13px;
	border: 2px solid #d9deeb;
	border-top-color: #5267d8;
	border-radius: 50%;
	animation: compacting-rotate .9s linear infinite;
}
.chat-compacting-bar {
	grid-column: 1 / -1;
	position: relative;
	height: 2px;
	overflow: hidden;
	background: #e4e8f2;
}
.chat-compacting-bar-fill {
	position: absolute;
	left: -35%;
	width: 35%;
	height: 100%;
	background: #5267d8;
	animation: compacting-flow 1.6s ease-in-out infinite;
}
@keyframes compacting-rotate { to { transform: rotate(360deg); } }
@keyframes compacting-flow { to { left: 100%; } }
@media (prefers-reduced-motion: reduce) { .chat-compacting-spin, .chat-compacting-bar-fill { animation: none; } }
.chat-compacted-head {
	display: flex;
	align-items: center;
	justify-content: space-between;
	font-weight: 600;
	color: #4b5268;
}
.chat-compacted-close {
	border: 0;
	background: transparent;
	color: #8a90a5;
	cursor: pointer;
	font-size: 12px;
}

/* 上下文用量圆环：同对话页 */
.ctx-ring { position: relative; width: 18px; height: 18px; flex: none; cursor: default; }
.ctx-ring-tooltip {
	position: absolute; left: 50%; bottom: calc(100% + 8px); z-index: 40; display: grid; gap: 4px;
	width: max-content; max-width: min(280px, calc(100vw - 32px)); padding: 8px 10px; border-radius: 8px;
	background: #191b1e; color: #f5f5f5; box-shadow: 0 8px 24px rgba(0,0,0,.22); font-size: 12px;
	line-height: 1.35; text-align: center; white-space: normal; opacity: 0; visibility: hidden;
	transform: translate(-50%,4px); transition: opacity .14s ease,transform .14s ease,visibility .14s ease; pointer-events: none;
}
.ctx-ring-tooltip::after { position: absolute; top: 100%; left: 50%; border: 5px solid transparent; border-top-color: #191b1e; content: ""; transform: translateX(-50%); }
.ctx-ring-tooltip b { font-weight: 600; }
.ctx-ring:hover .ctx-ring-tooltip,.ctx-ring:focus-visible .ctx-ring-tooltip { opacity: 1; visibility: visible; transform: translate(-50%,0); }
.chat-file-input { display: none; }
.chat-attachments { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 8px; }
.chat-attachment { display: inline-flex; align-items: center; gap: 6px; min-width: 0; padding: 3px 7px; border: 1px solid #d9dee8; border-radius: 6px; font-size: 12px; }
.ctx-ring-svg { width: 100%; height: 100%; transform: rotate(-90deg); }
.ctx-ring-track { fill: none; stroke: rgba(108,124,255,.15); stroke-width: 5; }
.ctx-ring-fill { fill: none; stroke: #6c7cff; stroke-width: 5; stroke-linecap: round; transition: stroke-dasharray .6s ease, stroke .3s ease; }
.ctx-ring.warn .ctx-ring-fill { stroke: #e08a3c; }
.ctx-ring-text {
	position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%);
	white-space: nowrap; visibility: hidden; pointer-events: none;
}
@media (prefers-reduced-motion: reduce) { .ctx-ring-fill { transition: none; } }
.chat-model-label { font-size: 12px; color: #8a90a5; }
/* 动画：出现/收起都有过渡，帮用户看清"列表变了"；尊重减弱动效偏好 */
.notice-enter-active, .notice-leave-active { transition: opacity .25s ease, transform .25s ease; }
.notice-enter-from, .notice-leave-to { opacity: 0; transform: translateY(-8px); }
.badge-enter-active, .badge-leave-active { transition: opacity .2s ease, transform .2s ease; }
.badge-enter-from, .badge-leave-to { opacity: 0; transform: translateX(-10px); }
@media (prefers-reduced-motion: reduce) {
	.notice-enter-active, .notice-leave-active,
	.badge-enter-active, .badge-leave-active { transition: none; }
}
/* 斜杠命令面板的定位上下文：面板 absolute（left:0;right:0）撑满这层的宽度，
   ① 没有 relative 会飞到整个页面顶部去；② 没有 width:100% 会塌缩成 10px 竖线
   （flex 容器里空 div 宽度按内容算，而面板不占流式宽度）——两个都实测踩过。 */
.chat-slash-anchor {
	position: relative;
	width: 100%;
}
.agent-banner {
	display: flex;
	align-items: center;
	gap: 8px;
	flex-wrap: wrap;
	padding: 10px 14px;
	margin-bottom: 12px;
	background: var(--brand-soft);
	border-radius: var(--radius-lg);
	font-size: 13px;
}
.agent-banner-label {
	color: var(--muted);
	font-size: 12px;
}
.agent-banner-name {
	font-weight: 600;
}
.agent-banner-hint {
	color: var(--muted);
	font-size: 12px;
}
.chat-alert {
	margin-bottom: 12px;
}
.chat-layout {
	display: grid;
	grid-template-columns: 260px minmax(0, 1fr);
	gap: 16px;
	min-height: 0;
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
/* 上下文用量：背景信息，不是操作入口——灰字 + 虚线边，别跟 Agent 名/计划模式抢视线 */
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
	flex-direction: column; /* 纵向：textarea 一整行，模型选择+发送一行——横排会把 textarea 挤窄（实测踩过） */
	gap: 8px;
}
.chat-input .n-input {
	width: 100%;
}
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
.chat-compose-actions .chat-model-label {
	white-space: nowrap;
	max-width: 220px;
	overflow: hidden;
	text-overflow: ellipsis;
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
