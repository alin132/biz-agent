<script setup>
import { onMounted, ref, computed } from "vue";
import { useRouter } from "vue-router";
import { NAlert, NButton, NCard, NStatistic, NTag, NEmpty } from "naive-ui";
import PageShell from "../components/PageShell.vue";
import Panel from "../components/Panel.vue";
import { healthApi, agentsApi, kbApi, modelsApi, http, approvalsApi } from "../api.js";
import { can } from "../access.js";

const router = useRouter();
const loading = ref(true);
const error = ref("");
const health = ref(null);
const agents = ref([]);
const sessions = ref([]);
const kbs = ref([]);
const models = ref(null);
const pending = ref(null);

const activeAgents = computed(() => agents.value.filter((agent) => agent.status !== "stopped"));
const recentSessions = computed(() => sessions.value
	.filter((item) => !item.archived)
	.slice()
	.sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0))
	.slice(0, 6));
const currentModel = computed(() => {
	const row = models.value?.models?.find((item) => item.modelId === models.value.current || item.id === models.value.current);
	return row?.name || row?.modelId || health.value?.model?.label || "未选择模型";
});
const modelIsLive = computed(() => health.value?.model?.mode === "live");
const documentCount = computed(() => kbs.value.reduce((total, kb) => total + (kb.docCount ?? 0), 0));

function openSession(item) {
	router.push({ name: "chat", query: { ...(item.agentId ? { agentId: item.agentId } : {}), session: item.id } });
}

function titleOf(item) {
	return item.title || item.transcript?.find((message) => message.role === "user")?.text?.slice(0, 54) || item.agentName || "未命名对话";
}

function previewOf(item) {
	const latest = item.transcript?.slice().reverse().find((message) => message.role === "assistant" || message.role === "user");
	return latest?.text?.replace(/\s+/g, " ").slice(0, 100) || "暂无消息内容";
}

function updatedLabel(item) {
	const timestamp = item.updatedAt ?? item.createdAt;
	if (!timestamp) return "时间未知";
	return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(timestamp);
}

function statusLabel(status) {
	return ({ published: "已发布", testing: "测试中", draft: "草稿", stopped: "已停用" })[status] || "草稿";
}

async function load() {
	loading.value = true;
	error.value = "";
	const tasks = [healthApi.get(), agentsApi.list(), http.get("/api/sessions"), kbApi.list(), modelsApi.list(), can("session.read") ? approvalsApi.list() : Promise.resolve(null)];
	const refs = [health, agents, sessions, kbs, models, pending];
	const labels = ["运行状态", "Agent", "会话", "知识库", "模型", "审批"];
	const results = await Promise.allSettled(tasks);
	results.forEach((result, index) => {
		if (result.status === "fulfilled") refs[index].value = result.value;
		else error.value += `${labels[index]}：${result.reason?.message || "加载失败"}；`;
	});
	loading.value = false;
}

onMounted(load);
</script>

<template>
	<PageShell title="工作台" subtitle="查看运行状态，继续最近工作，快速进入智能体任务">
		<template #actions>
			<n-button @click="load">刷新</n-button>
			<n-button @click="router.push({ name: 'agents' })">选择 Agent</n-button>
			<n-button type="primary" @click="router.push({ name: 'chat' })">新建对话</n-button>
		</template>

		<section class="workspace-status" aria-label="工作空间状态">
			<div class="workspace-status-main">
				<span class="status-indicator" :class="modelIsLive ? 'is-live' : 'is-simulated'" aria-hidden="true"></span>
				<div class="workspace-status-copy">
					<strong>{{ modelIsLive ? '模型服务已连接' : '当前使用模拟模型' }}</strong>
					<span>{{ currentModel }}</span>
				</div>
				<n-tag size="small" :type="modelIsLive ? 'success' : 'warning'" :bordered="false">
					{{ modelIsLive ? '真实模型' : '模拟模式' }}
				</n-tag>
			</div>
			<div class="workspace-status-meta">
				<div><span>存储</span><strong>{{ health?.storage?.kind || '读取中' }}</strong></div>
				<div><span>访问</span><strong>{{ health?.auth === 'required' ? '登录验证' : '演示模式' }}</strong></div>
				<n-button text type="primary" @click="router.push({ name: 'models' })">模型设置</n-button>
			</div>
		</section>

		<div class="workbench-stats">
			<n-card class="workbench-stat">
				<n-statistic label="可用 Agent" :value="activeAgents.length" />
				<div class="stat-foot"><span>共 {{ agents.length }} 个配置</span><button @click="router.push({ name: 'agents' })">查看 Agent</button></div>
			</n-card>
			<n-card class="workbench-stat">
				<n-statistic label="未归档会话" :value="sessions.filter((item) => !item.archived).length" />
				<div class="stat-foot"><span>已归档 {{ sessions.filter((item) => item.archived).length }} 个</span><button @click="router.push({ name: 'chat' })">打开对话</button></div>
			</n-card>
			<n-card class="workbench-stat">
				<n-statistic label="待处理审批" :value="pending?.length ?? '—'" />
				<div class="stat-foot"><span>需要人工处理</span><button @click="router.push({ name: 'approvals' })">前往审批</button></div>
			</n-card>
			<n-card class="workbench-stat">
				<n-statistic label="知识库文档" :value="documentCount" />
				<div class="stat-foot"><span>{{ kbs.length }} 个知识库</span><button @click="router.push({ name: 'knowledge' })">查看知识库</button></div>
			</n-card>
		</div>

		<div class="workbench-columns">
			<Panel title="最近对话" :meta="`${recentSessions.length} 条`" class="workbench-panel">
				<template #actions><n-button text type="primary" @click="router.push({ name: 'chat' })">全部对话</n-button></template>
				<n-empty v-if="!recentSessions.length" description="还没有对话" class="empty-state" />
				<div v-else class="session-list">
					<button v-for="item in recentSessions" :key="item.id" class="session-row" @click="openSession(item)">
						<span class="session-row-main">
							<strong>{{ titleOf(item) }}</strong>
							<span>{{ previewOf(item) }}</span>
						</span>
						<span class="session-row-side">
							<small>{{ item.agentName || '通用对话' }}</small>
							<time>{{ updatedLabel(item) }}</time>
						</span>
					</button>
				</div>
			</Panel>

			<Panel title="可用 Agent" :meta="`${activeAgents.length} 个`" class="workbench-panel">
				<template #actions><n-button text type="primary" @click="router.push({ name: 'agents' })">管理 Agent</n-button></template>
				<n-empty v-if="!activeAgents.length" description="先创建一个业务智能体" class="empty-state" />
				<div v-else class="agent-list">
					<div v-for="item in activeAgents.slice(0, 5)" :key="item.id" class="agent-row">
						<div class="agent-mark" aria-hidden="true">{{ (item.name || 'A').slice(0, 1) }}</div>
						<div class="agent-row-copy">
							<strong>{{ item.name }}</strong>
							<span>{{ item.description || '暂无简介' }}</span>
						</div>
						<div class="agent-row-actions">
							<n-tag size="small" :type="item.status === 'published' ? 'success' : 'default'" :bordered="false">{{ statusLabel(item.status) }}</n-tag>
							<n-button size="small" @click="router.push({ name: 'agent-chat', params: { id: item.id } })">开始对话</n-button>
						</div>
					</div>
				</div>
			</Panel>
		</div>

		<details class="environment">
			<summary>工作空间运行信息</summary>
			<p class="hint">共 {{ health?.sessions ?? '—' }} 条会话 · {{ health?.auth === 'required' ? '已开启登录验证' : '免登录演示模式' }}</p>
			<n-button text @click="router.push({ name: 'settings' })">打开设置</n-button>
		</details>
	</PageShell>
</template>

<style scoped>
.workspace-status {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 20px;
	padding: 16px 20px;
	margin-bottom: 18px;
	background: var(--surface);
	border: 1px solid var(--line);
	border-radius: 8px;
}
.workspace-status-main, .workspace-status-meta, .workspace-status-copy { display: flex; align-items: center; }
.workspace-status-main { gap: 12px; min-width: 0; }
.status-indicator { width: 10px; height: 10px; flex: 0 0 auto; border-radius: 50%; background: var(--warning); box-shadow: 0 0 0 4px var(--warning-soft); }
.status-indicator.is-live { background: var(--success); box-shadow: 0 0 0 4px var(--success-soft); }
.workspace-status-copy { flex-direction: column; align-items: flex-start; gap: 3px; min-width: 0; }
.workspace-status-copy strong { font-size: 14px; font-weight: 600; }
.workspace-status-copy span { max-width: min(46vw, 520px); color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.workspace-status-meta { gap: 24px; }
.workspace-status-meta > div { display: grid; gap: 3px; padding-left: 20px; border-left: 1px solid var(--line); }
.workspace-status-meta > div span { color: var(--muted); font-size: 11px; }
.workspace-status-meta > div strong { font-size: 12px; font-weight: 500; }
.workbench-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.workbench-stat { min-width: 0; }
.workbench-stat :deep(.n-card__content) { padding: 16px 18px; }
.workbench-stat :deep(.n-statistic-value__content) { font-size: 25px; overflow-wrap: anywhere; }
.stat-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 10px; padding-top: 9px; border-top: 1px solid var(--line); color: var(--muted); font-size: 12px; }
.stat-foot button { padding: 0; color: var(--brand-primary); background: transparent; border: 0; cursor: pointer; white-space: nowrap; }
.workbench-columns { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(320px, .85fr); gap: 16px; margin-top: 18px; align-items: start; }
.session-list, .agent-list { display: grid; }
.session-row { display: flex; align-items: center; justify-content: space-between; gap: 18px; width: 100%; min-width: 0; padding: 14px 0; text-align: left; background: transparent; border: 0; border-bottom: 1px solid var(--line); cursor: pointer; }
.session-row:last-child, .agent-row:last-child { border-bottom: 0; }
.session-row:hover .session-row-main strong, .agent-row:hover .agent-row-copy strong { color: var(--brand-primary); }
.session-row-main, .session-row-side, .agent-row-copy { display: grid; min-width: 0; gap: 5px; }
.session-row-main strong, .agent-row-copy strong { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.session-row-main span, .agent-row-copy span { color: var(--muted); font-size: 12px; line-height: 1.5; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.session-row-side { flex: 0 0 auto; justify-items: end; color: var(--muted); }
.session-row-side small, .session-row-side time { font-size: 11px; white-space: nowrap; }
.agent-row { display: flex; align-items: center; gap: 11px; min-width: 0; padding: 13px 0; border-bottom: 1px solid var(--line); }
.agent-mark { display: grid; place-items: center; width: 34px; height: 34px; flex: 0 0 auto; color: var(--brand-primary); background: var(--brand-soft); border: 1px solid var(--brand-soft-border); border-radius: 8px; font-weight: 600; }
.agent-row-copy { flex: 1; }
.agent-row-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; flex: 0 0 auto; }
.environment { margin-top: 18px; padding: 12px 16px; border-top: 1px solid var(--line); color: var(--text-2); }
.environment summary { cursor: pointer; font-size: 12px; }
.environment .hint { margin: 10px 0; font-size: 12px; }
@media (max-width: 1120px) {
	.workbench-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
	.workbench-columns { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 700px) {
	.workspace-status { align-items: flex-start; flex-direction: column; }
	.workspace-status-meta { width: 100%; justify-content: space-between; gap: 8px; }
	.workspace-status-meta > div { padding-left: 10px; }
	.workspace-status-meta > div:first-child { padding-left: 0; border-left: 0; }
	.workspace-status-copy span { max-width: calc(100vw - 100px); }
	.workbench-stats { gap: 8px; }
	.workbench-stat :deep(.n-card__content) { padding: 13px; }
	.workbench-stat :deep(.n-statistic-value__content) { font-size: 22px; }
	.stat-foot { align-items: flex-start; flex-direction: column; }
	.session-row { align-items: flex-start; gap: 8px; }
	.session-row-side { padding-top: 2px; }
	.agent-row { flex-wrap: wrap; }
	.agent-row-copy { min-width: calc(100% - 50px); }
	.agent-row-actions { width: 100%; justify-content: flex-start; padding-left: 45px; }
}
</style>
