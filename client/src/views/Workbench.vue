<script setup>
import { onMounted, ref, computed } from "vue";
import { useRouter } from "vue-router";
import { NButton, NCard, NStatistic, NTag, NEmpty, NSkeleton } from "naive-ui";
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
const loadStates = ref({});

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
const modelStatus = computed(() => {
	if (loading.value) return { label: "正在读取运行状态", tag: "读取中", type: "default", className: "is-unknown" };
	if (!ready("health") || !["live", "simulated"].includes(health.value?.model?.mode)) return { label: "运行状态暂不可用", tag: "状态未知", type: "default", className: "is-unknown" };
	return modelIsLive.value
		? { label: "已配置真实模型", tag: "真实模型", type: "success", className: "is-live" }
		: { label: "当前使用模拟模型", tag: "模拟模式", type: "warning", className: "is-simulated" };
});
const documentCount = computed(() => kbs.value.reduce((total, kb) => total + (kb.docCount ?? 0), 0));
const unarchivedCount = computed(() => sessions.value.filter((item) => !item.archived).length);
const publishedCount = computed(() => activeAgents.value.filter((item) => item.status === "published").length);

function ready(key) {
	return !loading.value && loadStates.value[key] === "fulfilled";
}

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
	loadStates.value = {};
	const tasks = [healthApi.get(), agentsApi.list(), http.get("/api/sessions"), kbApi.list(), modelsApi.list(), can("session.read") ? approvalsApi.list() : Promise.resolve(null)];
	const refs = [health, agents, sessions, kbs, models, pending];
	const labels = ["运行状态", "Agent", "会话", "知识库", "模型", "审批"];
	const keys = ["health", "agents", "sessions", "kbs", "models", "pending"];
	const results = await Promise.allSettled(tasks);
	results.forEach((result, index) => {
		loadStates.value[keys[index]] = result.status;
		if (result.status === "fulfilled") refs[index].value = result.value;
		else error.value += `${labels[index]}：${result.reason?.message || "加载失败"}；`;
	});
	loading.value = false;
}

onMounted(load);
</script>

<template>
	<PageShell title="工作台" subtitle="查看运行状态，继续最近工作，快速进入智能体任务" :loading="loading" :error="error">
		<template #actions>
			<n-button :loading="loading" :disabled="loading" @click="load">刷新</n-button>
			<n-button @click="router.push({ name: 'agents' })">选择 Agent</n-button>
			<n-button type="primary" @click="router.push({ name: 'chat' })">新建对话</n-button>
		</template>

		<section class="workspace-status" aria-label="工作空间状态">
			<div class="workspace-status-main">
				<span class="status-indicator" :class="modelStatus.className" aria-hidden="true"></span>
				<div class="workspace-status-copy">
					<strong>{{ modelStatus.label }}</strong>
					<span :title="ready('health') ? currentModel : ''">{{ loading ? '正在获取模型与工作空间信息' : ready('health') ? currentModel : '请刷新重试，或检查服务状态' }}</span>
				</div>
				<n-tag size="small" :type="modelStatus.type" :bordered="false">
					{{ modelStatus.tag }}
				</n-tag>
			</div>
			<div class="workspace-status-meta">
				<div><span>数据存储</span><strong>{{ ready('health') ? health?.storage?.kind || '未知' : loading ? '读取中' : '不可用' }}</strong></div>
				<div><span>访问方式</span><strong>{{ ready('health') ? health?.auth === 'required' ? '登录验证' : health?.auth === 'off' ? '演示模式' : '未知' : loading ? '读取中' : '不可用' }}</strong></div>
				<n-button text type="primary" @click="router.push({ name: 'models' })">模型设置</n-button>
			</div>
		</section>

		<div class="workbench-stats">
			<n-card class="workbench-stat">
				<n-statistic label="可用 Agent" :value="ready('agents') ? activeAgents.length : '—'" />
				<p class="stat-description">{{ ready('agents') ? `已发布 ${publishedCount} 个 · 可试用 ${activeAgents.length - publishedCount} 个` : loading ? '正在读取智能体配置' : '智能体数据加载失败' }}</p>
				<div class="stat-foot"><span>{{ ready('agents') ? `共 ${agents.length} 个配置` : '配置与运行入口' }}</span><button @click="router.push({ name: 'agents' })">查看 Agent <span aria-hidden="true">→</span></button></div>
			</n-card>
			<n-card class="workbench-stat">
				<n-statistic label="未归档会话" :value="ready('sessions') ? unarchivedCount : '—'" />
				<p class="stat-description">继续任务，保留工作上下文</p>
				<div class="stat-foot"><span>{{ ready('sessions') ? `已归档 ${sessions.length - unarchivedCount} 个` : loading ? '正在读取会话' : '会话加载失败' }}</span><button @click="router.push({ name: 'chat' })">打开对话 <span aria-hidden="true">→</span></button></div>
			</n-card>
			<n-card class="workbench-stat">
				<n-statistic label="待处理审批" :value="ready('pending') ? pending?.length ?? '—' : '—'" />
				<p class="stat-description">高风险操作由人工确认</p>
				<div class="stat-foot"><span>{{ loading ? '正在读取审批' : !can('session.read') ? '暂无查看权限' : !ready('pending') ? '审批加载失败' : pending?.length ? '有事项等待处理' : '暂无待处理事项' }}</span><button @click="router.push({ name: 'approvals' })">前往审批 <span aria-hidden="true">→</span></button></div>
			</n-card>
			<n-card class="workbench-stat">
				<n-statistic label="知识库文档" :value="ready('kbs') ? documentCount : '—'" />
				<p class="stat-description">为回答提供业务资料</p>
				<div class="stat-foot"><span>{{ ready('kbs') ? `${kbs.length} 个知识库` : loading ? '正在读取知识库' : '知识库加载失败' }}</span><button @click="router.push({ name: 'knowledge' })">查看知识库 <span aria-hidden="true">→</span></button></div>
			</n-card>
		</div>

		<div class="workbench-columns">
			<Panel title="最近对话" :meta="ready('sessions') ? `最近 ${recentSessions.length} 条` : ''" class="workbench-panel">
				<template #actions><n-button text type="primary" @click="router.push({ name: 'chat' })">全部对话</n-button></template>
				<div v-if="loading" class="list-loading" aria-label="正在加载最近对话"><n-skeleton v-for="index in 3" :key="index" text :repeat="2" /></div>
				<n-empty v-else-if="!ready('sessions')" description="暂时无法读取最近对话" class="empty-state"><template #extra><n-button size="small" @click="load">重新加载</n-button></template></n-empty>
				<n-empty v-else-if="!recentSessions.length" description="开始一段对话，最近的工作会显示在这里" class="empty-state"><template #extra><n-button size="small" type="primary" @click="router.push({ name: 'chat' })">新建对话</n-button></template></n-empty>
				<div v-else class="session-list">
					<button v-for="item in recentSessions" :key="item.id" class="session-row" @click="openSession(item)">
						<span class="session-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M20 11.5a8 8 0 0 1-8 8H5l-3 2v-10a9 9 0 0 1 18 0Z"/><path d="M7 10h8M7 14h5"/></svg></span>
						<span class="session-row-main">
							<strong :title="titleOf(item)">{{ titleOf(item) }}</strong>
							<span>{{ previewOf(item) }}</span>
						</span>
						<span class="session-row-side">
							<small>{{ item.agentName || '通用对话' }}</small>
							<time>{{ updatedLabel(item) }}</time>
						</span>
					</button>
				</div>
			</Panel>

			<Panel title="可用 Agent" :meta="ready('agents') ? `${activeAgents.length} 个` : ''" class="workbench-panel">
				<template #actions><n-button text type="primary" @click="router.push({ name: 'agents' })">管理 Agent</n-button></template>
				<div v-if="loading" class="list-loading" aria-label="正在加载智能体"><n-skeleton v-for="index in 3" :key="index" text :repeat="2" /></div>
				<n-empty v-else-if="!ready('agents')" description="暂时无法读取智能体" class="empty-state"><template #extra><n-button size="small" @click="load">重新加载</n-button></template></n-empty>
				<n-empty v-else-if="!activeAgents.length" :description="agents.length ? '当前智能体均已停用，可前往管理页调整' : '创建业务智能体，配置专属能力与知识'" class="empty-state"><template #extra><n-button size="small" @click="router.push({ name: 'agents' })">管理 Agent</n-button></template></n-empty>
				<div v-else class="agent-list">
					<div v-for="item in activeAgents.slice(0, 5)" :key="item.id" class="agent-row">
						<div class="agent-mark" aria-hidden="true">{{ (item.name || 'A').slice(0, 1) }}</div>
						<div class="agent-row-copy">
							<strong :title="item.name">{{ item.name }}</strong>
							<span>{{ item.description || '暂无简介' }}</span>
						</div>
						<div class="agent-row-actions">
							<n-tag size="small" :type="item.status === 'published' ? 'success' : item.status === 'testing' ? 'info' : 'default'" :bordered="false">{{ statusLabel(item.status) }}</n-tag>
							<n-button size="small" @click="router.push({ name: 'agent-chat', params: { id: item.id } })">{{ item.status === 'published' ? '开始对话' : '试用' }}</n-button>
						</div>
					</div>
				</div>
			</Panel>
		</div>

		<details class="environment">
			<summary>工作空间运行信息</summary>
			<p class="hint">{{ loading ? '正在读取运行信息' : ready('health') ? `共 ${health?.sessions ?? '—'} 条会话 · ${health?.auth === 'required' ? '已开启登录验证' : health?.auth === 'off' ? '免登录演示模式' : '访问方式未知'}` : '运行信息加载失败，请刷新重试' }}</p>
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
	border-radius: var(--radius-lg);
	box-shadow: var(--shadow-sm);
}
.workspace-status-main, .workspace-status-meta, .workspace-status-copy { display: flex; align-items: center; }
.workspace-status-main { gap: 12px; min-width: 0; }
.status-indicator { width: 10px; height: 10px; flex: 0 0 auto; border-radius: 50%; background: var(--warning); box-shadow: 0 0 0 4px var(--warning-soft); }
.status-indicator.is-live { background: var(--success); box-shadow: 0 0 0 4px var(--success-soft); }
.status-indicator.is-unknown { background: var(--muted); box-shadow: 0 0 0 4px var(--surface-alt); }
.workspace-status-copy { flex-direction: column; align-items: flex-start; gap: 3px; min-width: 0; }
.workspace-status-copy strong { font-size: 14px; font-weight: 600; }
.workspace-status-copy span { max-width: min(46vw, 520px); color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.workspace-status-meta { gap: 24px; flex: 0 0 auto; }
.workspace-status-meta > div { display: grid; gap: 3px; padding-left: 20px; border-left: 1px solid var(--line); }
.workspace-status-meta > div span { color: var(--muted); font-size: 11px; }
.workspace-status-meta > div strong { font-size: 12px; font-weight: 500; }
.workbench-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.workbench-stat { min-width: 0; }
.workbench-stat :deep(.n-card__content) { padding: 16px 18px; }
.workbench-stat :deep(.n-statistic .n-statistic__label) { color: var(--text-2); font-size: 12px; }
.workbench-stat :deep(.n-statistic-value__content) { font-size: 28px; font-weight: 600; letter-spacing: -.03em; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.stat-description { margin: 4px 0 0; color: var(--muted); font-size: 11px; line-height: 1.6; }
.stat-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 10px; padding-top: 9px; border-top: 1px solid var(--line); color: var(--muted); font-size: 12px; }
.stat-foot button { padding: 0; color: var(--brand-primary); background: transparent; border: 0; cursor: pointer; white-space: nowrap; }
.workbench-columns { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(340px, 1fr); gap: 16px; margin-top: 18px; align-items: start; }
.workbench-panel { min-width: 0; }
.workbench-panel :deep(.panel-body) { padding: 8px 16px; }
.workbench-panel :deep(.empty-state) { min-height: 226px; justify-content: center; padding: 36px 12px; }
.list-loading { display: grid; gap: 22px; padding: 22px 4px; }
.session-list, .agent-list { display: grid; }
.session-row { display: flex; align-items: center; gap: 12px; width: 100%; min-width: 0; padding: 16px 4px; color: var(--text); text-align: left; background: transparent; border: 0; border-bottom: 1px solid var(--line); cursor: pointer; transition: background .15s; }
.session-row:hover { background: var(--surface-alt); }
.session-row:focus-visible { outline-offset: -2px; border-radius: 6px; }
.session-mark { display: grid; place-items: center; width: 32px; height: 32px; flex: 0 0 auto; color: var(--muted); background: var(--surface-alt); border: 1px solid var(--line); border-radius: 8px; }
.session-mark svg { width: 17px; height: 17px; }
.session-row:last-child, .agent-row:last-child { border-bottom: 0; }
.session-row:hover .session-row-main strong, .agent-row:hover .agent-row-copy strong { color: var(--brand-primary); }
.session-row-main, .session-row-side, .agent-row-copy { display: grid; min-width: 0; gap: 5px; }
.session-row-main { flex: 1; }
.session-row-main strong, .agent-row-copy strong { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.session-row-main span, .agent-row-copy span { color: var(--muted); font-size: 12px; line-height: 1.5; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.session-row-side { flex: 0 0 auto; max-width: 30%; justify-items: end; color: var(--muted); }
.session-row-side small, .session-row-side time { max-width: 100%; overflow: hidden; text-overflow: ellipsis; font-size: 11px; white-space: nowrap; }
.agent-row { display: flex; align-items: center; gap: 11px; min-width: 0; padding: 15px 4px; border-bottom: 1px solid var(--line); }
.agent-mark { display: grid; place-items: center; width: 34px; height: 34px; flex: 0 0 auto; color: var(--brand-primary); background: var(--brand-soft); border: 1px solid var(--brand-soft-border); border-radius: 8px; font-weight: 600; }
.agent-row-copy { flex: 1; }
.agent-row-copy span { white-space: normal; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.agent-row-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; flex: 0 0 auto; }
.environment { margin-top: 18px; padding: 12px 16px; border-top: 1px solid var(--line); color: var(--text-2); }
.environment summary { cursor: pointer; font-size: 12px; }
.environment .hint { margin: 10px 0; font-size: 12px; }
@media (max-width: 1120px) {
	.workbench-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
	.workbench-columns { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 700px) {
	.workspace-status { align-items: flex-start; flex-direction: column; gap: 18px; padding: 16px; }
	.workspace-status-main { width: 100%; flex-wrap: wrap; gap: 10px; }
	.workspace-status-copy { flex: 1; }
	.workspace-status-meta { width: 100%; justify-content: space-between; gap: 8px; }
	.workspace-status-meta > div { padding-left: 10px; }
	.workspace-status-meta > div:first-child { padding-left: 0; border-left: 0; }
	.workspace-status-copy span { max-width: 100%; overflow-wrap: anywhere; white-space: normal; }
	.workbench-stats { gap: 8px; }
	.workbench-stat :deep(.n-card__content) { padding: 13px; }
	.workbench-stat :deep(.n-statistic-value__content) { font-size: 22px; }
	.stat-foot { align-items: flex-start; flex-direction: column; }
	.session-row { display: grid; grid-template-columns: 28px minmax(0, 1fr); align-items: start; gap: 7px 10px; }
	.session-mark { width: 28px; height: 28px; grid-row: span 2; }
	.session-row-main span { white-space: normal; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
	.session-row-side { grid-column: 2; max-width: 100%; display: flex; justify-content: space-between; gap: 12px; }
	.agent-row { display: grid; grid-template-columns: 34px minmax(0, 1fr); align-items: start; gap: 10px 11px; }
	.agent-row-actions { grid-column: 2; justify-content: space-between; }
	.workbench-panel :deep(.panel-head) { padding: 14px 16px; gap: 8px; }
}
@media (max-width: 380px) {
	.workbench-stats { grid-template-columns: minmax(0, 1fr); }
	.stat-foot { flex-direction: row; }
	.workspace-status-main > :deep(.n-tag) { margin-left: 20px; }
}
</style>
