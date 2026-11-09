<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { NAlert, NButton, NCheckbox, NEmpty, NInput, NModal, NSelect, NTag, useDialog, useMessage } from "naive-ui";
import PageShell from "../components/PageShell.vue";
import Panel from "../components/Panel.vue";
import { agentGroupsApi, agentsApi } from "../api.js";
import { can } from "../access.js";
import { dateText } from "../display.js";

const dialog = useDialog();
const message = useMessage();
const groups = ref([]);
const agents = ref([]);
const selectedId = ref("");
const selected = computed(() => groups.value.find((group) => group.id === selectedId.value) ?? null);
const loading = ref(false);
const running = ref(false);
const error = ref("");
const createOpen = ref(false);
const groupName = ref("");
const selectedAgents = ref([]);
const draft = ref("");
const sending = ref(false);
const creating = ref(false);
const published = computed(() => agents.value.filter((agent) => agent.status === "published"));
const agentOptions = computed(() => published.value.map((agent) => ({ label: `${agent.name} · ${agent.description || "部门 Agent"}`, value: agent.id })));
let groupPollTimer;
let groupPollInFlight = false;

function scheduleGroupPoll(groupId) {
	clearTimeout(groupPollTimer);
	if (!groupId || !running.value || selectedId.value !== groupId) return;
	groupPollTimer = setTimeout(async () => {
		if (groupPollInFlight) return scheduleGroupPoll(groupId);
		groupPollInFlight = true;
		try { await refreshGroup(groupId); }
		finally {
			groupPollInFlight = false;
			scheduleGroupPoll(groupId);
		}
	}, 700);
}

watch([selectedId, running], ([groupId, isRunning]) => {
	clearTimeout(groupPollTimer);
	if (isRunning) scheduleGroupPoll(groupId);
}, { immediate: true });

async function load() {
	loading.value = true;
	error.value = "";
	try {
		[groups.value, agents.value] = await Promise.all([agentGroupsApi.list(), agentsApi.list()]);
		if (!selectedId.value && groups.value.length) selectedId.value = groups.value[0].id;
		if (selectedId.value && !groups.value.some((group) => group.id === selectedId.value)) selectedId.value = groups.value[0]?.id ?? "";
		running.value = groups.value.find((group) => group.id === selectedId.value)?.running ?? false;
	} catch (cause) { error.value = cause.message; }
	finally { loading.value = false; }
}

async function refreshGroup(groupId) {
	try {
		const updated = await agentGroupsApi.get(groupId);
		groups.value = groups.value.map((group) => group.id === updated.id ? updated : group);
		if (selectedId.value === groupId) running.value = updated.running;
	} catch (cause) { error.value = cause.message; }
}

function selectGroup(groupId) {
	selectedId.value = groupId;
	running.value = false;
	void refreshGroup(groupId);
}

async function createGroup() {
	creating.value = true;
	try {
		const group = await agentGroupsApi.create({ name: groupName.value, agentIds: selectedAgents.value });
		groups.value.unshift(group);
		selectedId.value = group.id;
		groupName.value = "";
		selectedAgents.value = [];
		createOpen.value = false;
		message.success("部门群聊已创建");
	} catch (cause) { message.error(cause.message); }
	finally { creating.value = false; }
}

async function send() {
	if (!selected.value || !draft.value.trim() || running.value) return;
	const groupId = selected.value.id;
	const text = draft.value.trim();
	draft.value = "";
	running.value = true;
	sending.value = true;
	try {
		const updated = await agentGroupsApi.send(groupId, text);
		groups.value = groups.value.map((group) => group.id === updated.id ? updated : group);
		if (selectedId.value === groupId) running.value = updated.running;
	} catch (cause) {
		draft.value = text;
		message.error(cause.message);
		await refreshGroup(groupId);
	} finally { sending.value = false; }
}

async function cancel() {
	if (!selected.value || !running.value) return;
	try {
		const result = await agentGroupsApi.cancel(selected.value.id);
		groups.value = groups.value.map((group) => group.id === result.group.id ? result.group : group);
		running.value = result.group.running;
		message.info(result.cancelled ? "已请求停止当前部门并结束本轮" : "当前轮次已结束或正在收尾");
	} catch (cause) { message.error(cause.message); }
}

function removeGroup() {
	if (!selected.value) return;
	const id = selected.value.id;
	dialog.warning({ title: "删除部门群聊", content: "群聊记录和各部门 Agent 的专属会话都会删除，确定继续？", positiveText: "删除", negativeText: "取消", onPositiveClick: async () => {
		try { await agentGroupsApi.remove(id); selectedId.value = ""; await load(); }
		catch (cause) { message.error(cause.message); return false; }
	} });
}

onMounted(load);
onUnmounted(() => clearTimeout(groupPollTimer));
</script>

<template>
	<PageShell title="部门群聊" subtitle="把已发布的部门 Agent 放在同一条协作对话中" :loading="loading" :error="error" wide>
		<template #actions>
			<n-button @click="load">刷新</n-button>
			<n-button v-if="can('session.write')" type="primary" @click="createOpen = true">新建群聊</n-button>
		</template>
		<div class="group-layout">
			<aside class="group-list">
				<div class="group-list-head">群聊 <span>{{ groups.length }}</span></div>
				<button v-for="group in groups" :key="group.id" class="group-list-item" :class="{ active: selectedId === group.id }" @click="selectGroup(group.id)">
					<strong>{{ group.name }}</strong><small>{{ group.members.length }} 个部门 · {{ group.turns.length }} 轮</small>
				</button>
				<n-empty v-if="!groups.length" description="还没有部门群聊" size="small" />
			</aside>
			<section v-if="selected" class="group-main">
				<header class="group-head"><div><h2>{{ selected.name }}</h2><div class="group-members"><n-tag v-for="member in selected.members" :key="member.id" size="small" :type="member.agentId === selected.activeAgentId ? 'info' : 'default'">{{ member.agentName }}<template v-if="member.agentId === selected.activeAgentId"> · 正在处理</template></n-tag></div></div><div class="group-head-actions"><n-button v-if="running && can('session.run')" type="warning" @click="cancel">停止本轮</n-button><n-button v-if="can('session.write')" quaternary type="error" :disabled="running" @click="removeGroup">删除</n-button></div></header>
				<div class="group-messages" data-testid="group-messages">
					<div v-for="item in selected.messages" :key="item.id" class="group-message" :class="[item.role, { failed: item.isError }]">
						<div class="group-message-meta"><strong>{{ item.role === 'user' ? '你' : item.agentName }}</strong><span>{{ dateText(item.createdAt) }}</span><n-tag v-if="item.isError" size="tiny" type="error">执行失败</n-tag></div>
						<p>{{ item.content }}</p>
					</div>
					<div v-if="running" class="group-running" role="status"><span class="group-spinner" />{{ selected.activeAgentName ? `${selected.activeAgentName} 正在处理本轮消息` : '部门 Agent 正在准备本轮消息…' }}</div>
					<n-empty v-if="!selected.messages.length && !running" description="发送一条消息，开始部门协同" />
				</div>
				<form v-if="can('session.run')" class="group-composer" @submit.prevent="send">
					<n-input v-model:value="draft" type="textarea" :autosize="{ minRows: 3, maxRows: 8 }" placeholder="输入需要各部门协同处理的事项" :disabled="running" @keydown.ctrl.enter.prevent="send" @keydown.meta.enter.prevent="send" />
					<div><span class="group-hint">每个部门使用独立会话，后续轮次保留各自上下文</span><n-button type="primary" attr-type="submit" :loading="sending" :disabled="!draft.trim() || running">发送给部门</n-button></div>
				</form>
			</section>
			<section v-else class="group-placeholder"><n-empty description="选择一个部门群聊，或新建群聊开始协作" /></section>
		</div>
		<n-modal v-model:show="createOpen" preset="card" title="新建部门群聊" style="width: min(560px, calc(100vw - 32px))">
			<div class="create-form"><label>群聊名称<n-input v-model:value="groupName" maxlength="60" placeholder="例如：新客户交付协同" /></label><label>部门 Agent<n-select v-model:value="selectedAgents" multiple :options="agentOptions" placeholder="选择 2–8 个已发布 Agent" /></label><small>每个 Agent 以自己的部门身份发言，并保留专属会话记忆。</small></div>
			<template #footer><n-button type="primary" :loading="creating" :disabled="selectedAgents.length < 2 || !groupName.trim()" @click="createGroup">创建群聊</n-button></template>
		</n-modal>
	</PageShell>
</template>

<style scoped>
.group-layout{display:grid;grid-template-columns:260px minmax(0,1fr);min-height:620px;border:1px solid var(--line);border-radius:6px;overflow:hidden;background:var(--surface)}
.group-list{border-right:1px solid var(--line);padding:12px;display:flex;flex-direction:column;gap:6px;background:var(--surface-subtle)}
.group-list-head{font-size:13px;font-weight:650;padding:6px 8px 12px;display:flex;justify-content:space-between;color:var(--text-secondary)}
.group-list-item{border:0;background:transparent;text-align:left;border-radius:5px;padding:10px;cursor:pointer;color:var(--text);display:grid;gap:5px}.group-list-item.active{background:#eceff1}.group-list-item small{color:var(--text-secondary)}
.group-main{display:grid;grid-template-rows:auto minmax(0,1fr) auto;min-width:0}.group-head{padding:16px 20px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;gap:16px}.group-head h2{font-size:18px;margin:0 0 10px}.group-members{display:flex;gap:6px;flex-wrap:wrap}.group-head-actions{display:flex;align-items:center;gap:8px}
.group-messages{padding:18px 20px;overflow:auto;display:flex;flex-direction:column;gap:14px;min-height:0}.group-message{max-width:min(820px,92%);padding:12px 14px;border:1px solid var(--line);border-radius:6px;align-self:flex-start;background:var(--surface)}.group-message.user{align-self:flex-end;background:#f0f3f5}.group-message.failed{border-color:#dca4a4;background:#fff8f8}.group-message-meta{display:flex;align-items:center;gap:10px;font-size:12px;color:var(--text-secondary)}.group-message-meta strong{color:var(--text)}.group-message-meta span{margin-left:auto}.group-message p{white-space:pre-wrap;margin:8px 0 0;line-height:1.65;overflow-wrap:anywhere}
.group-running{display:flex;align-items:center;gap:9px;color:var(--text-secondary);font-size:13px;padding:8px}.group-spinner{width:14px;height:14px;border:2px solid #cbd2d7;border-top-color:#4e8b77;border-radius:50%;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}
.group-composer{padding:14px 20px;border-top:1px solid var(--line);display:grid;gap:10px}.group-composer>div{display:flex;justify-content:space-between;align-items:center;gap:12px}.group-hint,.create-form small{font-size:12px;color:var(--text-secondary)}.group-placeholder{display:grid;place-items:center}.create-form{display:grid;gap:18px}.create-form label{display:grid;gap:8px;font-size:13px;font-weight:600}
@media(max-width:760px){.group-layout{grid-template-columns:1fr;min-height:calc(100vh - 190px)}.group-list{border-right:0;border-bottom:1px solid var(--line);max-height:180px;overflow:auto}.group-main{min-height:520px}.group-composer>div{align-items:flex-start;flex-direction:column}.group-message{max-width:100%}}
</style>
