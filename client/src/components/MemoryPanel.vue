<script setup>
import { computed, onMounted, ref } from "vue";
import { NAlert, NButton, NEmpty, NForm, NFormItem, NInput, NModal, NSelect, NTag, useDialog, useMessage } from "naive-ui";
import { agentsApi, http } from "../api.js";
import { can } from "../access.js";
import { dateText } from "../display.js";
import Panel from "./Panel.vue";

const entries = ref([]), agents = ref([]), sessions = ref([]), loading = ref(false), error = ref("");
const editorOpen = ref(false), editing = ref(null), saving = ref(false), filter = ref("all");
const form = ref({ scope: "personal", agentId: null, sessionId: null, content: "", source: "用户确认" });
const message = useMessage(), dialog = useDialog();
const filters = [{ label: "全部范围", value: "all" }, { label: "个人", value: "personal" }, { label: "Agent", value: "agent" }, { label: "会话", value: "session" }];
const scopes = filters.slice(1);
const scopeOf = entry => entry.sessionId ? "session" : entry.agentId ? "agent" : "personal";
const visible = computed(() => entries.value.filter(entry => filter.value === "all" || scopeOf(entry) === filter.value));
const agentOptions = computed(() => agents.value.map(agent => ({ label: agent.name, value: agent.id })));
const sessionOptions = computed(() => sessions.value.map(session => ({ label: session.title || session.transcript?.find(entry => entry.role === "user")?.text?.slice(0, 40) || `对话 ${session.id}`, value: session.id })));
function scopeLabel(entry) {
	if (entry.sessionId) return `会话 · ${sessionOptions.value.find(item => item.value === entry.sessionId)?.label ?? entry.sessionId}`;
	if (entry.agentId) return `Agent · ${agents.value.find(agent => agent.id === entry.agentId)?.name ?? entry.agentId}`;
	return "个人 · 适用于我的对话";
}
async function load() {
	loading.value = true; error.value = "";
	try {
		const [memories, agentItems, sessionItems] = await Promise.all([http.get("/api/memories"), agentsApi.list(), http.get("/api/sessions")]);
		entries.value = memories.items; agents.value = agentItems; sessions.value = sessionItems.items ?? sessionItems;
	} catch (cause) { error.value = cause.message; }
	finally { loading.value = false; }
}
function openEditor(entry = null) {
	editing.value = entry;
	form.value = { scope: entry ? scopeOf(entry) : "personal", agentId: entry?.agentId ?? null, sessionId: entry?.sessionId ?? null, content: entry?.content ?? "", source: entry?.source ?? "用户确认" };
	editorOpen.value = true;
}
async function save() {
	if (saving.value) return;
	if (!form.value.content.trim() || !form.value.source.trim()) { message.warning("请填写记忆内容和来源"); return; }
	if (!editing.value && form.value.scope === "agent" && !form.value.agentId) { message.warning("请选择适用的 Agent"); return; }
	const selectedSession = sessions.value.find(session => session.id === form.value.sessionId);
	if (!editing.value && form.value.scope === "session" && !selectedSession) { message.warning("请选择适用的会话"); return; }
	saving.value = true;
	try {
		const body = { content: form.value.content.trim(), source: form.value.source.trim() };
		if (editing.value) await http.patch(`/api/memories/${encodeURIComponent(editing.value.id)}`, body);
		else await http.post("/api/memories", { ...body,
			agentId: form.value.scope === "agent" ? form.value.agentId : form.value.scope === "session" ? selectedSession.agentId : null,
			sessionId: form.value.scope === "session" ? selectedSession.id : null });
		editorOpen.value = false;
		await load(); message.success("记忆已保存，下一轮对话生效");
	} catch (cause) { message.error(cause.message); }
	finally { saving.value = false; }
}
function remove(entry) {
	dialog.warning({ title: "删除长期记忆", content: "删除后，后续对话不再注入这条记忆。已经生成的历史消息不会被删除。", positiveText: "删除", negativeText: "取消",
		onPositiveClick: async () => { try { await http.delete(`/api/memories/${encodeURIComponent(entry.id)}`); await load(); } catch (cause) { message.error(cause.message); return false; } } });
}
onMounted(load);
</script>

<template>
	<Panel title="长期记忆" :meta="`${entries.length} 条`" data-testid="memory-panel">
		<template #actions><n-button size="small" :loading="loading" @click="load">刷新记忆</n-button><n-button v-if="can('session.write')" size="small" type="primary" @click="openEditor()">添加记忆</n-button></template>
		<p class="memory-hint">只保存自己确认的偏好、约定和事实。记忆按个人、Agent 或会话隔离，与上下文压缩分开管理；来源说明由你提供。</p>
		<n-alert v-if="error" type="error" :bordered="false">{{ error }}</n-alert>
		<n-select v-model:value="filter" aria-label="记忆范围筛选" :options="filters" class="memory-filter" />
		<n-empty v-if="!visible.length && !loading" description="没有这个范围的长期记忆" />
		<ul v-else class="memory-list">
			<li v-for="entry in visible" :key="entry.id" :data-memory-id="entry.id">
				<div class="memory-meta"><n-tag size="small" :bordered="false">{{ scopeLabel(entry) }}</n-tag><time>{{ dateText(entry.updatedAt) }}</time></div>
				<p class="memory-content">{{ entry.content }}</p><small>来源：{{ entry.source }}</small>
				<div v-if="can('session.write')" class="memory-actions"><n-button size="tiny" @click="openEditor(entry)">编辑记忆</n-button><n-button size="tiny" quaternary type="error" @click="remove(entry)">删除记忆</n-button></div>
			</li>
		</ul>
		<n-modal v-model:show="editorOpen" preset="card" :title="editing ? '编辑长期记忆' : '添加长期记忆'" style="width:min(560px,calc(100vw - 32px))">
			<n-form label-placement="top">
				<n-form-item label="适用范围"><n-select v-model:value="form.scope" :options="scopes" :disabled="!!editing" /></n-form-item>
				<n-form-item v-if="form.scope === 'agent'" label="适用 Agent"><n-select v-model:value="form.agentId" :options="agentOptions" filterable :disabled="!!editing" /></n-form-item>
				<n-form-item v-if="form.scope === 'session'" label="适用会话"><n-select v-model:value="form.sessionId" :options="sessionOptions" filterable :disabled="!!editing" /></n-form-item>
				<n-form-item label="记忆内容"><n-input v-model:value="form.content" type="textarea" :maxlength="2000" show-count :autosize="{minRows:3,maxRows:8}" placeholder="例如：本项目的预算金额统一使用人民币元" /></n-form-item>
				<n-form-item label="来源说明"><n-input v-model:value="form.source" :maxlength="500" placeholder="例如：用户确认、项目会议纪要" /></n-form-item>
			</n-form>
			<template #footer><n-button type="primary" :loading="saving" @click="save">保存记忆</n-button></template>
		</n-modal>
	</Panel>
</template>

<style scoped>
.memory-hint{font-size:12px;line-height:1.7;color:var(--text-2);margin:0 0 14px}.memory-filter{max-width:240px;margin-bottom:16px}.memory-list{list-style:none;padding:0;margin:0;display:grid;gap:12px}.memory-list li{padding:14px;border:1px solid var(--line);border-radius:8px;overflow-wrap:anywhere}.memory-meta{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}.memory-meta time,.memory-list small{font-size:12px;color:var(--text-2)}.memory-content{white-space:pre-wrap;font-size:13px;line-height:1.7}.memory-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:8px}
</style>
