<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { NAlert, NButton, NDrawer, NDrawerContent, NEmpty, NInput, NInputNumber, NModal, NSelect, NTag, useDialog, useMessage } from "naive-ui";
import PageShell from "../components/PageShell.vue";
import MessageBody from "../components/MessageBody.vue";
import GroupResults from "../components/GroupResults.vue";
import { agentGroupsApi, agentsApi } from "../api.js";
import { groupMentionOptions, groupMentionTargets } from "../groupMentions.js";
import { can } from "../access.js";
import { dateText } from "../display.js";

const dialog = useDialog();
const message = useMessage();
const route = useRoute();
const router = useRouter();
const isChat = computed(() => route.name === "agent-group-chat");
const groups = ref([]);
const agents = ref([]);
const selectedId = computed(() => isChat.value ? String(route.params.id ?? "") : "");
const selected = computed(() => groups.value.find((group) => group.id === selectedId.value) ?? null);
const conversationId = computed(() => typeof route.query.conversation === "string" ? route.query.conversation : selectedId.value);
const creatingConversation = ref(false);
const conversationOptions = computed(() => (selected.value?.conversations ?? []).map((item) => ({ label: item.title, value: item.id })));
const loading = ref(false);
const running = computed(() => selected.value?.running ?? false);
const groupRunning = computed(() => selected.value?.groupRunning ?? running.value);
const error = ref("");
const editorOpen = ref(false);
const editingId = ref("");
const groupName = ref("");
const selectedAgents = ref([]);
const collaborationMode = ref("sequential");
const hostAgentId = ref(null);
const maxRounds = ref(3);
const maxCalls = ref(24);
const maxDurationSeconds = ref(600);
const maxTokens = ref(null);
const resuming = ref(false);
const latestTurn = computed(() => selected.value?.turns.at(-1));
const hostOptions = computed(() => agentOptions.value.filter((option) => selectedAgents.value.includes(option.value)));
const latestDiscussion = computed(() => selected.value?.turns.at(-1)?.discussion);
const outcomeLabels = { pending: "讨论中", consensus: "参与部门已达成共识", round_limit: "已达轮数上限，仍有分歧", call_limit: "已达调用上限，未确认共识", failed: "执行失败，未确认共识", cancelled: "已停止", interrupted: "讨论中断", time_limit: "已达时限，未确认共识", token_limit: "已达 Token 预算，后续请求已停止" };
const phaseLabels = { planning: "主持分派", discussing: "部门讨论", summarizing: "统一汇总", finished: "已结束" };
function messageStage(item) {
	if (!item.metadata) return "";
	const labels = { plan: "主持分派", reply: "部门意见", summary: "最终汇总", notice: "调度提示" };
	return `${item.metadata.round ? `第 ${item.metadata.round} 轮 · ` : ""}${labels[item.metadata.kind] ?? ""}`;
}
const stanceLabels = { agree: "同意方案", disagree: "存在分歧", needs_info: "待补充信息" };
const membersOpen = ref(false);
const keyword = ref("");
const draft = ref("");
const composer = ref(null);
const messageList = ref(null);
const atBottom = ref(true);
const mentionRange = ref(null);
const mentionIndex = ref(0);
const mentionOptions = computed(() => groupMentionOptions(selected.value?.members ?? []));
const mentionCandidates = computed(() => mentionOptions.value.filter((member) => member.agentName.toLowerCase().includes(mentionRange.value?.query.toLowerCase() ?? "")));
const targets = computed(() => groupMentionTargets(draft.value, selected.value?.members ?? []));
const sendingId = ref("");
const saving = ref(false);
const filteredGroups = computed(() => groups.value.filter((group) => `${group.name} ${group.members.map((member) => member.agentName).join(" ")}`.toLowerCase().includes(keyword.value.toLowerCase())));
const agentOptions = computed(() => agents.value.filter((agent) => agent.status === "published" || selectedAgents.value.includes(agent.id)).map((agent) => ({ label: `${agent.name}${agent.status === "published" ? "" : " · 未发布"}`, value: agent.id })));
const memberDetails = computed(() => (selected.value?.members ?? []).map((member) => ({ ...member, agent: agents.value.find((agent) => agent.id === member.agentId) })));
let pollTimer;
let disposed = false;
let loadVersion = 0;

function replaceGroup(updated) {
	const index = groups.value.findIndex((group) => group.id === updated.id);
	if (index < 0) groups.value.unshift(updated);
	else groups.value[index] = updated;
}
async function load() {
	const version = ++loadVersion;
	loading.value = true;
	error.value = "";
	try {
		const [items, agentItems] = await Promise.all([agentGroupsApi.list(), agentsApi.list()]);
		if (version !== loadVersion || disposed) return;
		groups.value = items;
		agents.value = agentItems;
		if (isChat.value && selected.value) {
			const updated = await agentGroupsApi.get(selectedId.value, conversationId.value);
			if (version !== loadVersion || disposed) return;
			replaceGroup(updated);
		}
		if (isChat.value && !selected.value) error.value = "找不到这个部门群聊，请返回群聊列表";
	} catch (cause) { if (version === loadVersion) error.value = cause.message; }
	finally { if (version === loadVersion) loading.value = false; }
}
async function refreshGroup(id, conversation = conversationId.value) {
	try {
		const updated = await agentGroupsApi.get(id, conversation);
		if (!disposed && selectedId.value === id && conversationId.value === conversation) { replaceGroup(updated); error.value = ""; }
	} catch (cause) { if (!disposed && selectedId.value === id) error.value = cause.message; }
}
function schedulePoll(id) {
	clearTimeout(pollTimer);
	if (disposed || selectedId.value !== id || !groupRunning.value) return;
	pollTimer = setTimeout(async () => {
		await refreshGroup(id);
		schedulePoll(id);
	}, 700);
}
watch([selectedId, conversationId, groupRunning], ([id]) => schedulePoll(id));
watch([selectedId, conversationId], async () => {
	draft.value = "";
	mentionRange.value = null;
	membersOpen.value = false;
	atBottom.value = true;
	if (isChat.value) await refreshGroup(selectedId.value);
	await nextTick();
	scrollToBottom();
});
watch(() => [selected.value?.messages.length, selected.value?.activeAgentId], async () => {
	if (!atBottom.value) return;
	await nextTick();
	scrollToBottom();
});
function scrollToBottom() {
	if (messageList.value) messageList.value.scrollTop = messageList.value.scrollHeight;
	atBottom.value = true;
}
function onScroll() {
	const el = messageList.value;
	if (el) atBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 70;
}
function openGroup(id) { return router.push({ name: "agent-group-chat", params: { id } }); }
async function newConversation() {
	if (!selected.value || groupRunning.value || creatingConversation.value) return;
	creatingConversation.value = true;
	try {
		const updated = await agentGroupsApi.createConversation(selectedId.value);
		replaceGroup(updated);
		await router.push({ name: "agent-group-chat", params: { id: selectedId.value }, query: { conversation: updated.activeConversationId } });
	} catch (cause) { message.error(cause.message); }
	finally { creatingConversation.value = false; }
}
function switchConversation(id) {
	return router.push({ name: "agent-group-chat", params: { id: selectedId.value }, query: id === selectedId.value ? {} : { conversation: id } });
}
function backToGroups() { return router.push({ name: "agent-groups" }); }
function openEditor(group = null) {
	editingId.value = group?.id ?? "";
	groupName.value = group?.name ?? "";
	selectedAgents.value = group?.members.map((member) => member.agentId) ?? [];
	collaborationMode.value = group?.collaboration ? "moderated" : "sequential";
	hostAgentId.value = group?.collaboration?.hostAgentId ?? null;
	maxRounds.value = group?.collaboration?.maxRounds ?? 3;
	maxCalls.value = group?.collaboration?.maxCalls ?? 24;
	maxDurationSeconds.value = Math.round((group?.collaboration?.maxDurationMs ?? 600000) / 1000);
	maxTokens.value = group?.collaboration?.maxTokens ?? null;
	editorOpen.value = true;
}
async function saveGroup() {
	if (saving.value) return;
	saving.value = true;
	try {
		const input = { name: groupName.value, agentIds: selectedAgents.value, collaboration: collaborationMode.value === "moderated" ? { mode: "moderated", hostAgentId: hostAgentId.value, maxRounds: maxRounds.value, maxCalls: maxCalls.value, maxDurationMs: maxDurationSeconds.value * 1000, ...(maxTokens.value === null ? {} : { maxTokens: maxTokens.value }) } : null };
		let updated = editingId.value ? await agentGroupsApi.update(editingId.value, input) : await agentGroupsApi.create(input);
		if (isChat.value && updated.id === selectedId.value) updated = await agentGroupsApi.get(updated.id, conversationId.value);
		replaceGroup(updated);
		editorOpen.value = false;
		message.success(editingId.value ? "群聊配置已保存" : "部门群聊已创建");
	} catch (cause) { message.error(cause.message); }
	finally { saving.value = false; }
}
function syncMention() {
	const el = composer.value;
	if (!el || el.selectionStart !== el.selectionEnd) { mentionRange.value = null; return; }
	const end = el.selectionStart;
	const match = draft.value.slice(0, end).match(/(?:^|[\s，。！？、,:;：；!?])@([^@\n]*)$/);
	mentionRange.value = match ? { start: end - match[1].length - 1, end, query: match[1] } : null;
	if (mentionRange.value && mentionOptions.value.some(({ token }) => {
		const tail = draft.value.slice(mentionRange.value.start, end);
		return tail.startsWith(token) && /[\s，。！？、,:;：；!?]/.test(tail[token.length] ?? "");
	})) mentionRange.value = null;
	mentionIndex.value = 0;
}
async function insertMention(member) {
	const range = mentionRange.value;
	if (!range) return;
	const inserted = `${member.token} `;
	draft.value = draft.value.slice(0, range.start) + inserted + draft.value.slice(range.end);
	mentionRange.value = null;
	await nextTick();
	composer.value?.focus();
	composer.value?.setSelectionRange(range.start + inserted.length, range.start + inserted.length);
}
function onComposerKey(event) {
	if (event.isComposing || event.keyCode === 229) return;
	if (mentionRange.value) {
		if (event.key === "Escape") { event.preventDefault(); mentionRange.value = null; return; }
		if (mentionCandidates.value.length && ["ArrowDown", "ArrowUp", "Enter", "Tab"].includes(event.key) && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
			event.preventDefault();
			if (event.key === "ArrowDown" || event.key === "ArrowUp") mentionIndex.value = (mentionIndex.value + (event.key === "ArrowDown" ? 1 : -1) + mentionCandidates.value.length) % mentionCandidates.value.length;
			else void insertMention(mentionCandidates.value[mentionIndex.value]);
			return;
		}
	}
	if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); }
}
async function send() {
	if (!selected.value || !draft.value.trim() || groupRunning.value || sendingId.value) return;
	const id = selected.value.id;
	const conversation = conversationId.value;
	const text = draft.value.trim();
	const ids = [...targets.value];
	if (/(?:^|\s)@[^\s，。！？、,:;：；!?]/.test(text) && !ids.length) { message.warning("没有匹配到群成员，请从 @ 菜单选择需要点名的成员"); return; }
	draft.value = "";
	mentionRange.value = null;
	sendingId.value = id;
	replaceGroup({ ...selected.value, running: true, groupRunning: true });
	atBottom.value = true;
	try { const updated = await agentGroupsApi.send(id, text, ids, conversation); if (!disposed && selectedId.value === id && conversationId.value === conversation) replaceGroup(updated); }
	catch (cause) {
		if (selectedId.value === id && conversationId.value === conversation && !draft.value) draft.value = text;
		message.error(cause.message);
		await refreshGroup(id, conversation);
	} finally { sendingId.value = ""; }
}
async function cancel() {
	if (!selected.value || !groupRunning.value) return;
	try { const result = await agentGroupsApi.cancel(selected.value.id, conversationId.value); replaceGroup(result.group); message.info("已请求停止本轮"); }
	catch (cause) { message.error(cause.message); }
}
async function resumeTurn() {
	if (!selected.value || !latestTurn.value?.canResume || resuming.value) return;
	const groupId = selected.value.id, conversation = conversationId.value, turnId = latestTurn.value.id;
	resuming.value = true;
	replaceGroup({ ...selected.value, running: true, groupRunning: true });
	try { const updated = await agentGroupsApi.resume(groupId, turnId); if (!disposed && selectedId.value === groupId && conversationId.value === conversation) replaceGroup(updated); }
	catch (cause) { message.error(cause.message); await refreshGroup(groupId, conversation); }
	finally { resuming.value = false; }
}
function showSource(id) {
	const element = [...(messageList.value?.querySelectorAll('[data-message-id]') ?? [])].find(item => item.dataset.messageId === id);
	if (!element) { message.warning("原始发言不在当前对话中"); return; }
	atBottom.value = false;
	element.scrollIntoView({ behavior: "smooth", block: "center" });
	element.focus({ preventScroll: true });
}
function removeGroup(group) {
	dialog.warning({ title: "删除部门群聊", content: `删除「${group.name}」及其全部消息和成员专属会话？`, positiveText: "删除", negativeText: "取消", onPositiveClick: async () => {
		try {
			await agentGroupsApi.remove(group.id);
			groups.value = groups.value.filter((item) => item.id !== group.id);
			if (selectedId.value === group.id) await backToGroups();
		} catch (cause) { message.error(cause.message); return false; }
	} });
}
onMounted(load);
onUnmounted(() => { disposed = true; clearTimeout(pollTimer); });
</script>

<template>
	<div class="group-page" :class="{ 'group-page-chat': isChat }">
		<PageShell v-if="!isChat" title="部门群聊" subtitle="配置协作群组，管理部门成员，按需发起多 Agent 对话" :loading="loading" :error="error" wide>
			<template #actions><n-button @click="load">刷新</n-button><n-button v-if="can('session.write')" type="primary" @click="openEditor()">新建群聊</n-button></template>
			<div class="group-toolbar"><n-input v-model:value="keyword" clearable placeholder="搜索群聊或成员" /><span>{{ filteredGroups.length }} 个群聊</span></div>
			<div v-if="filteredGroups.length" class="group-grid">
				<article v-for="group in filteredGroups" :key="group.id" class="group-card" :data-group-id="group.id">
					<header><div class="group-avatar">群</div><div><h2>{{ group.name }}</h2><small>{{ group.members.length }} 位成员 · {{ group.turns.length }} 轮对话</small></div><n-tag v-if="group.running" size="small" type="info">运行中</n-tag></header>
					<div class="group-card-members"><n-tag v-for="member in group.members" :key="member.id" size="small">{{ member.agentName }}</n-tag></div>
					<p>{{ group.collaboration ? `主持协作 · 最多 ${group.collaboration.maxRounds} 轮 / ${group.collaboration.maxCalls} 次调用` : "按顺序发言" }}<br>更新于 {{ dateText(group.updatedAt) }}</p>
					<footer><n-button type="primary" @click="openGroup(group.id)">进入群聊</n-button><n-button v-if="can('session.write')" :disabled="group.running" @click="openEditor(group)">配置</n-button><n-button v-if="can('session.write')" quaternary type="error" :disabled="group.running" @click="removeGroup(group)">删除</n-button></footer>
				</article>
			</div>
			<n-empty v-else :description="keyword ? '没有匹配的群聊' : '还没有部门群聊，先创建一个协作群组'" />
		</PageShell>
		<section v-else class="group-chat" :aria-busy="loading">
			<header class="group-head">
				<n-button quaternary size="small" @click="backToGroups">返回群聊</n-button>
				<div class="group-heading"><h1>{{ selected?.name || '部门群聊' }}</h1><span>{{ selected?.members.length ?? 0 }} 位成员 · {{ running ? '正在协作' : '部门协作对话' }}</span></div>
				<div class="group-head-actions"><n-button v-if="can('session.write')" size="small" :loading="creatingConversation" :disabled="!selected || selected.groupRunning" @click="newConversation">新对话</n-button><n-button size="small" :disabled="!selected" @click="membersOpen = true">查看成员</n-button><n-button v-if="can('session.write')" size="small" :disabled="!selected || selected.groupRunning" @click="openEditor(selected)">群聊配置</n-button></div>
			</header>
			<n-alert v-if="error" type="error" :bordered="false">{{ error }}<n-button text @click="load">重试</n-button></n-alert>
			<div v-if="selected" class="group-conversation-bar"><span class="conversation-label">当前对话</span><n-select size="small" aria-label="群聊历史对话" :value="selected.activeConversationId" :options="conversationOptions" @update:value="switchConversation" /><span v-if="selected.groupRunning && !running" class="other-conversation-running">其他对话正在协作</span></div>
			<div v-if="selected" class="group-members" aria-label="群成员"><span v-for="member in selected.members" :key="member.id" :class="{ 'member-active': member.agentId === selected.activeAgentId }"><i class="member-status-dot" aria-hidden="true" />{{ member.agentName }}<small v-if="selected.collaboration?.hostAgentId === member.agentId">主持</small>{{ member.agentId === selected.activeAgentId ? ' · 正在处理' : '' }}</span></div>
			<div v-if="latestDiscussion" class="discussion-progress" data-testid="group-discussion-state">
				<div class="discussion-status-row"><span class="discussion-phase">{{ phaseLabels[latestDiscussion.phase] }}</span><n-tag size="small" :type="latestDiscussion.outcome === 'consensus' ? 'success' : latestDiscussion.outcome === 'failed' ? 'error' : 'default'">{{ outcomeLabels[latestDiscussion.outcome] }}</n-tag></div>
				<div class="discussion-metrics"><span>第 {{ latestDiscussion.round }} 轮</span><span>{{ latestDiscussion.calls }} 次调用</span><span v-if="latestTurn?.budget">用时 {{ Math.round(latestTurn.budget.elapsedMs / 1000) }} 秒 / {{ Math.round(latestTurn.budget.maxDurationMs / 1000) }} 秒</span><span data-testid="group-token-usage">Token {{ latestDiscussion.usage?.tokens == null ? '用量未知' : latestDiscussion.usage.tokens.toLocaleString() }}<template v-if="latestTurn?.budget?.maxTokens != null"> / {{ latestTurn.budget.maxTokens.toLocaleString() }}</template> · 实际费用未知<span v-if="latestDiscussion.usage?.piReportedCostUsd != null"> · Pi 目录估算 ${{ latestDiscussion.usage.piReportedCostUsd.toFixed(4) }}</span></span></div>
				<div v-if="latestTurn?.canResume" class="discussion-recovery"><n-button v-if="can('session.run')" size="tiny" :loading="resuming" :disabled="groupRunning" @click="resumeTurn">只读恢复讨论</n-button><span class="group-hint">保留已完成发言，不重放业务写入</span></div>
			</div>
			<div ref="messageList" class="group-messages" data-testid="group-messages" @scroll="onScroll">
				<div class="group-message-stack">
					<div v-for="item in selected?.messages ?? []" :key="item.id" class="group-message" :data-message-id="item.id" tabindex="-1" :class="[item.role, { failed: item.isError, 'host-message': item.metadata?.kind === 'plan', 'summary-message': item.metadata?.kind === 'summary' }]">
						<div class="group-message-meta"><strong>{{ item.role === 'user' ? '你' : item.agentName }}</strong><span v-if="item.metadata" class="message-stage">{{ messageStage(item) }}</span><n-tag v-if="item.metadata?.stance" size="tiny" :type="item.metadata.stance === 'agree' ? 'success' : 'warning'">{{ stanceLabels[item.metadata.stance] }}</n-tag><time>{{ dateText(item.createdAt) }}</time><n-tag v-if="item.isError" size="tiny" type="error">执行失败</n-tag></div>
						<MessageBody :text="item.content" :markdown="item.role !== 'user'" />
					</div>
					<GroupResults v-for="turn in selected?.turns.filter(item=>item.discussion?.result) ?? []" :key="turn.id" :turn="turn" :group="selected" @updated="updated=>{if(updated.id===selectedId && updated.activeConversationId===conversationId)replaceGroup(updated)}" @source="showSource" />
					<div v-if="running" class="group-running" role="status"><span class="group-spinner" />{{ selected.activeAgentName ? `${selected.activeAgentName} 正在处理本轮消息` : '部门 Agent 正在准备本轮消息…' }}</div>
					<n-empty v-if="selected && !selected.messages.length && !running" description="发送消息邀请全部成员，或输入 @ 点名成员" />
				</div>
			</div>
			<div v-if="selected && !atBottom" class="group-scroll-action"><n-button size="small" @click="scrollToBottom">回到最新消息</n-button></div>
			<form v-if="selected && can('session.run')" class="group-composer" @submit.prevent="send">
				<div v-if="mentionRange" id="group-mentions" class="mention-menu" role="listbox" aria-label="点名群成员">
					<div class="mention-title">选择本轮发言成员</div>
					<button v-for="(member, index) in mentionCandidates" :id="`mention-${index}`" :key="member.agentId" type="button" role="option" :aria-selected="index === mentionIndex" :class="{ active: index === mentionIndex }" @mousedown.prevent @click="insertMention(member)"><span class="member-avatar">{{ member.agentName.slice(0, 1) }}</span><span>{{ member.agentName }}<small>{{ member.token }}</small></span></button>
					<div v-if="!mentionCandidates.length" class="mention-title">未找到匹配的群成员</div>
				</div>
				<textarea ref="composer" v-model="draft" rows="3" maxlength="12000" placeholder="输入协作事项，@ 点名成员" :disabled="selected.groupRunning" aria-label="群聊消息" :aria-expanded="Boolean(mentionRange)" :aria-controls="mentionRange ? 'group-mentions' : undefined" :aria-activedescendant="mentionRange && mentionCandidates.length ? `mention-${mentionIndex}` : undefined" @input="syncMention" @click="syncMention" @keyup.left="syncMention" @keyup.right="syncMention" @keydown="onComposerKey" />
				<div class="group-composer-actions"><span class="group-hint">{{ selected.collaboration ? (targets.length ? `首轮点名 ${targets.length} 位成员，主持可追加分派` : '主持自动分派 · 部门点名优先回应') : (targets.length ? `本轮仅邀请 ${targets.length} 位点名成员` : '未点名时邀请全部成员') }}<span class="keyboard-hint"> · Enter 发送 · Shift + Enter 换行</span></span><n-button v-if="running" type="warning" @click="cancel">停止本轮</n-button><n-button v-else type="primary" attr-type="submit" :loading="sendingId === selectedId" :disabled="!draft.trim() || Boolean(sendingId) || selected.groupRunning">发送</n-button></div>
			</form>
		</section>
		<n-modal v-model:show="editorOpen" preset="card" :title="editingId ? '群聊配置' : '新建部门群聊'" style="width: min(600px, calc(100vw - 32px))">
			<div class="create-form"><label>群聊名称<n-input v-model:value="groupName" maxlength="60" placeholder="例如：新客户交付协同" /></label><label>群聊成员<n-select v-model:value="selectedAgents" multiple filterable :options="agentOptions" :max-tag-count="4" placeholder="选择 2–8 个已发布 Agent" /></label><label>协作模式<n-select v-model:value="collaborationMode" :options="[{ label: '按顺序发言', value: 'sequential' }, { label: '主持协作 · 多轮讨论与统一汇总', value: 'moderated' }]" /></label>
				<div v-if="collaborationMode === 'moderated'" class="moderation-config"><label>主持 Agent<n-select v-model:value="hostAgentId" :options="hostOptions" placeholder="选择一位群成员担任主持" /></label><div class="moderation-limits"><label>最多讨论轮数<n-input-number v-model:value="maxRounds" :min="1" :max="6" /></label><label>最多 Agent 调用<n-input-number v-model:value="maxCalls" :min="4" :max="64" /></label><label>时限（秒）<n-input-number v-model:value="maxDurationSeconds" :min="1" :max="3600" /></label><label>Token 预算（可选）<n-input-number v-model:value="maxTokens" :min="1" :max="100000000" :precision="0" clearable placeholder="不限制" /></label></div><small>主持负责分派和汇总，其余成员参与讨论。部门互相 @ 会优先回应，已发言部门也可继续回应，受总调用、时限与 Token 预算约束；仅在参与部门明确同意同一方案时确认共识。调用上限包含主持与部门发言，预留一次最终汇总。Token 预算在后续对话请求前检查，Pi 原生压缩在完成后统计，压缩内部请求和单次在途请求可能超出；配置预算但无法获得用量时会停止。启用预算会阻止未计量的技能委托。费用为未知或 Pi 目录估算，不代表实际账单。</small></div>
				<div class="config-members"><div v-for="(id, index) in selectedAgents" :key="id"><span>{{ index + 1 }}. {{ agents.find((agent) => agent.id === id)?.name ?? groups.find((group) => group.id === editingId)?.members.find((member) => member.agentId === id)?.agentName ?? id }}</span><n-button text type="error" @click="selectedAgents = selectedAgents.filter((value) => value !== id)">移除</n-button></div></div><small>{{ collaborationMode === 'moderated' ? '主持根据事项分派部门，点名成员会纳入讨论。' : '按成员顺序依次发言；@ 点名时只邀请指定成员。' }}保留成员的专属记忆不变，移除成员会清理其专属会话，群内历史发言保留。</small></div>
			<template #footer><n-button :disabled="saving" @click="editorOpen = false">取消</n-button><n-button type="primary" :loading="saving" :disabled="selectedAgents.length < 2 || selectedAgents.length > 8 || !groupName.trim() || (collaborationMode === 'moderated' && (!selectedAgents.includes(hostAgentId) || !maxRounds || !maxCalls))" @click="saveGroup">{{ editingId ? '保存配置' : '创建群聊' }}</n-button></template>
		</n-modal>
		<n-drawer v-model:show="membersOpen" :width="360" placement="right"><n-drawer-content title="群聊成员" closable><div class="member-detail-list"><article v-for="member in memberDetails" :key="member.id" class="member-detail"><div class="member-avatar">{{ member.agentName.slice(0, 1) }}</div><div><strong>{{ member.agentName }}</strong><n-tag v-if="selected.collaboration?.hostAgentId === member.agentId" size="small" type="info">主持</n-tag><n-tag size="small" :type="member.agent?.status === 'published' ? 'success' : 'warning'">{{ member.agent?.status === 'published' ? '已发布' : '不可参与新轮次' }}</n-tag><p>{{ member.agent?.description || '暂无成员介绍' }}</p><small>{{ member.sessionId ? '已有独立对话记忆' : '尚未开始独立对话' }}</small></div></article></div><template #footer><n-button v-if="can('session.write')" :disabled="running" @click="membersOpen = false; openEditor(selected)">管理成员</n-button></template></n-drawer-content></n-drawer>
	</div>
</template>

<style scoped>
.group-conversation-bar{display:flex;align-items:center;gap:10px;padding:8px 24px;border-bottom:1px solid var(--line);flex-shrink:0;font-size:12px;color:var(--text-2);flex-wrap:wrap}
.group-conversation-bar .n-select{width:min(380px,calc(100% - 62px));min-width:0}
.other-conversation-running{color:var(--brand-primary);font-size:11px}
.discussion-progress{display:block;align-items:center;justify-content:space-between;gap:8px;padding:10px 24px;background:var(--surface-alt);border-bottom:1px solid var(--line);font-size:12px;flex-shrink:0;flex-wrap:wrap;min-width:0}
.message-stage{color:var(--brand-primary);font-size:11px}
.group-message.host-message{border-left:3px solid var(--brand-primary)}
.group-message.summary-message{border-left:3px solid #10b981;background:#f6fcfa}
.moderation-config{display:grid;gap:14px;padding:14px;border:1px solid var(--line);border-radius:8px;background:var(--surface-alt)}
.moderation-limits{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px}
.moderation-limits .n-input-number{width:100%}
.group-toolbar{display:flex;align-items:center;gap:16px;margin-bottom:20px}
.group-toolbar .n-input{max-width:360px}
.group-toolbar>span{font-size:13px;color:var(--text-2);white-space:nowrap}
.group-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,320px),1fr));gap:18px}
.group-card{padding:20px;border:1px solid var(--line);border-radius:12px;background:var(--surface);min-width:0}
.group-card header{display:flex;align-items:center;gap:12px}
.group-card header>div:nth-child(2){flex:1;min-width:0}
.group-card h2{font-size:17px;margin:0 0 4px;overflow-wrap:anywhere}
.group-card small{font-size:12px;color:var(--text-2)}
.group-card p{font-size:12px;color:var(--text-2)}
.group-card-members{display:flex;flex-wrap:wrap;gap:6px;margin-top:18px}
.group-card-members :deep(.n-tag__content){max-width:220px;overflow:hidden;text-overflow:ellipsis}
.group-card footer{display:flex;gap:8px;border-top:1px solid var(--line);padding-top:14px}
.group-avatar{width:34px;height:34px;border-radius:9px;display:grid;place-items:center;background:var(--surface-alt);color:var(--brand-primary);font-size:14px;flex-shrink:0}
.member-avatar{width:34px;height:34px;border-radius:9px;display:grid;place-items:center;background:var(--surface-alt);color:var(--brand-primary);font-size:14px;flex-shrink:0}
.group-page-chat{height:100%;min-height:0;overflow:hidden;min-width:0}
.group-chat{height:100%;display:flex;flex-direction:column;min-height:0;background:var(--surface);position:relative;min-width:0}
.group-head{flex-shrink:0;padding:14px 22px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:12px}
.group-heading{flex:1;min-width:0}
.group-heading h1{font-size:18px;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:1.5;letter-spacing:-.2px}
.group-heading>span{font-size:11px;color:var(--text-2)}
.group-head-actions{display:flex;gap:6px;flex-shrink:0}
.group-members{display:flex;gap:7px;padding:8px 24px;overflow-x:auto;flex-shrink:0;border-bottom:0;font-size:12px;color:var(--text-2);white-space:nowrap}
.member-active{color:var(--brand-primary);font-weight:600}
.group-messages{padding:24px;overflow:auto;flex:1;min-height:0;overscroll-behavior:contain;overflow-wrap:anywhere;min-width:0;scrollbar-gutter:stable}
.group-message-stack{max-width:960px;margin:0 auto;display:flex;flex-direction:column;gap:20px;min-height:100%;min-width:0}
.group-message{max-width:92%;min-width:0;padding:14px 16px;border:1px solid var(--line);border-radius:10px;align-self:flex-start;background:var(--surface);box-sizing:border-box}
.group-message.user{align-self:flex-end;background:var(--surface-alt)}
.group-message.failed{border-color:#dca4a4;background:#fff8f8}
.group-message-meta{display:flex;align-items:center;flex-wrap:wrap;gap:6px 9px;font-size:12px;color:var(--text-2);margin-bottom:8px}
.group-message-meta strong{color:var(--text)}
.group-message-meta time{margin-left:auto;font-size:11px}
.group-message :deep(pre){max-width:100%;overflow:auto}
.group-running{display:flex;align-items:center;gap:9px;color:var(--text-2);font-size:13px;padding:8px}
.group-spinner{width:14px;height:14px;border:2px solid #cbd2d7;border-top-color:var(--brand-primary);border-radius:50%;animation:spin .8s linear infinite}
.group-composer{flex-shrink:0;padding:14px 24px 18px;border-top:1px solid var(--line);position:relative;width:100%;background:var(--surface);box-sizing:border-box}
.group-composer textarea{display:block;width:100%;max-width:960px;margin:auto;resize:none;height:90px;border:1px solid var(--line);border-radius:10px;padding:12px 14px;font:inherit;font-size:14px;line-height:1.6;background:var(--surface);color:var(--text);outline:none;box-sizing:border-box;transition:border-color .15s,box-shadow .15s}
.group-composer textarea:focus{border-color:var(--brand-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--brand-primary) 9%,transparent)}
.group-composer textarea:disabled{background:var(--surface-alt)}
.group-composer-actions{display:flex;justify-content:space-between;align-items:center;gap:12px;max-width:960px;margin:10px auto 0}
.group-hint{font-size:12px;color:var(--text-2);line-height:1.7}
.create-form small{font-size:12px;color:var(--text-2);line-height:1.7}
.group-scroll-action{position:absolute;bottom:190px;align-self:center;background:var(--surface);border-radius:6px;z-index:2}
.create-form{display:grid;gap:18px}
.create-form label{display:grid;gap:8px;font-size:13px;font-weight:600}
.config-members{display:grid;gap:8px}
.config-members>div{display:flex;justify-content:space-between;gap:12px;font-size:13px}
.config-members>div>span{overflow-wrap:anywhere;min-width:0}
.mention-menu{position:absolute;bottom:calc(100% - 6px);left:max(24px,calc((100% - 960px)/2));width:min(340px,calc(100% - 48px));max-height:min(300px,35dvh);overflow:auto;border:1px solid var(--line);border-radius:10px;background:var(--surface);box-shadow:var(--shadow);padding:6px;z-index:4}
.mention-title{font-size:12px;color:var(--text-2);padding:8px}
.mention-menu button{display:flex;align-items:center;gap:10px;width:100%;text-align:left;border:0;border-radius:6px;background:transparent;color:var(--text);padding:8px;cursor:pointer}
.mention-menu button.active{background:var(--surface-alt)}
.mention-menu button:hover{background:var(--surface-alt)}
.mention-menu button>span:last-child{min-width:0;overflow-wrap:anywhere}
.mention-menu small{display:block;color:var(--text-2);font-size:11px}
.member-detail-list{display:grid;gap:20px}
.member-detail{display:flex;gap:12px}
.member-detail>div:last-child{min-width:0;overflow-wrap:anywhere}
.member-detail strong{display:block;margin-bottom:6px}
.member-detail p{font-size:13px;color:var(--text-2)}
.member-detail small{color:var(--muted);font-size:12px}
.conversation-label{flex-shrink:0;font-size:11px}
.group-members>span{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line);border-radius:6px;padding:3px 8px;background:var(--surface);line-height:1.5;font-size:11px}
.group-members>span.member-active{border-color:var(--brand-primary);background:var(--surface-alt)}
.group-members small{color:var(--text-2);font-size:10px;font-weight:400}
.member-status-dot{display:block;width:5px;height:5px;border-radius:50%;background:var(--muted,var(--text-2));opacity:.5;flex-shrink:0}
.member-active .member-status-dot{background:var(--brand-primary);opacity:1}
.discussion-status-row{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
.discussion-phase{font-size:12px;font-weight:600;color:var(--text)}
.discussion-status-row :deep(.n-tag){max-width:100%;height:auto;min-height:22px}
.discussion-status-row :deep(.n-tag__content){white-space:normal;line-height:1.6}
.discussion-metrics{display:flex;flex-wrap:wrap;gap:4px 14px;margin-top:5px;color:var(--text-2);font-size:11px;line-height:1.7;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.discussion-recovery{display:flex;align-items:center;flex-wrap:wrap;gap:5px 10px;margin-top:8px;padding-top:8px;border-top:1px solid var(--line)}
.discussion-recovery .group-hint{font-size:11px}
.group-composer-actions>.group-hint{min-width:0;font-size:11px}
.group-composer-actions>.n-button{flex-shrink:0}
@keyframes spin{to{transform:rotate(360deg)}}
@media(max-width:760px){
	.group-conversation-bar{gap:6px 10px;padding:7px 12px}
	.group-conversation-bar .n-select{width:auto;flex:1}
	.other-conversation-running{width:100%;padding-left:58px}
	.discussion-progress{padding:8px 12px}
	.group-toolbar{align-items:flex-start}
	.group-card{padding:16px}
	.group-head{padding:10px 12px;gap:6px 10px;flex-wrap:wrap}
	.group-heading h1{font-size:16px}
	.group-head-actions{width:100%;justify-content:flex-end}
	.group-members{padding:7px 12px}
	.group-messages{padding:14px 12px}
	.group-message-stack{gap:16px}
	.group-message{max-width:100%;padding:12px}
	.group-composer{padding:10px 12px max(12px,env(safe-area-inset-bottom))}
	.group-composer textarea{height:78px;font-size:13px}
	.group-composer-actions{gap:8px;margin-top:8px}
	.group-scroll-action{bottom:164px}
	.mention-menu{left:12px;width:min(340px,calc(100% - 24px))}
	.keyboard-hint{display:none}
	.discussion-metrics{gap:2px 10px}
	.group-composer-actions>.group-hint{line-height:1.6}
}
</style>
