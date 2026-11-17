<script setup>
/**
 * Agent 列表页：卡片网格 + 状态筛选 + 六维配置编辑抽屉。
 *
 * 三个必须写在界面上的事实（都来自后端语义，藏起来就是骗人）：
 *  1. 新建的 Agent 一律是「草稿」，草稿/试运行/已发布能对话，已停用不能；
 *  2. 已发布的 Agent 不能直接改配置，必须先「召回草稿」；
 *  3. 状态机只能走 draft → testing → published → stopped（+ revert 回草稿），没有捷径。
 */
import { computed, onMounted, reactive, ref } from "vue";
import { useRouter } from "vue-router";
import {
	NButton,
	NEmpty,
	NForm,
	NFormItem,
	NInput,
	NInputNumber,
	NModal,
	NSelect,
	NSwitch,
	NTabPane,
	NTabs,
	NTag,
	useMessage,
	useDialog,
} from "naive-ui";
import PageShell from "../components/PageShell.vue";
import { agentsApi, kbApi, mcpApi, modelsApi, skillsApi } from "../api.js";

import { can } from "../access.js";
import { openAgentHistory, startAgentChat } from "../navigation.js";
const dialog = useDialog();
const keyword = ref("");
const message = useMessage();
const router = useRouter();
const loading = ref(true);
const error = ref("");
const agents = ref([]);
const statusFilter = ref("all");
const busy = ref("");

/** 编辑抽屉 */
const showEditor = ref(false);
const saving = ref(false);
const editingId = ref(null);
const editingAdvanced = ref({});
const checkTarget = ref(null);
const checkReport = ref(null);
const checkLoading = ref(false);
const checkError = ref("");
const copySource = ref(null);
const copyName = ref("");
const copying = ref(false);
const form = reactive(blankForm());
const skillOptions = ref([]);
const kbOptions = ref([]);
const modelOptions = ref([]);
const mcpServers = ref([]);

/** 可对话状态：与后端 CHATTABLE 一致（已停用不能聊，这是硬规则不是界面偏好） */
const CHATTABLE = ["draft", "testing", "published"];
function chattable(status) {
	return CHATTABLE.includes(status);
}

/**
 * 开一个新对话，并把它绑定到这个 Agent。
 *
 * Agent 会话仍是普通会话，只是带有 agentId；打开标准对话页时用它筛选对应 Agent 的历史。
 */
async function startChat(item) {
	busy.value = item.id + "chat";
	try {
		await startAgentChat(router, item.id);
	} catch (err) {
		message.error(err?.message ?? "开对话失败");
	} finally {
		busy.value = "";
	}
}

/**
 * 在标准对话页中查看这个 Agent 的历史会话。
 *
 * 卡片上的「对话」按钮走的是 startChat（先建会话再进去），这条只服务"先看看历史"；
	 * 新对话按钮仍由 startChat 处理；这里仅进入对应 Agent 的会话列表。
 */
function openAgentChat(item) {
	try {
		openAgentHistory(router, item.id);
	} catch (cause) {
		message.error(cause.message);
	}
}

const STATUS_META = {
	draft: { label: "草稿", type: "default" },
	testing: { label: "试运行", type: "info" },
	published: { label: "已发布", type: "success" },
	stopped: { label: "已停用", type: "warning" },
};

/** 每个状态允许的动作：与后端 TRANSITIONS 表一一对应，两边不能各写一套 */
const ACTIONS_BY_STATUS = {
	draft: [{ key: "test", label: "试运行" }, { key: "publish", label: "发布" }],
	testing: [{ key: "publish", label: "发布" }, { key: "revert", label: "召回草稿" }],
	published: [{ key: "stop", label: "停用" }, { key: "revert", label: "召回草稿" }],
	stopped: [{ key: "revert", label: "恢复为草稿" }],
};

const filtered = computed(() =>
	agents.value.filter((item) => (statusFilter.value === "all" || item.status === statusFilter.value) && `${item.name} ${item.description}`.toLowerCase().includes(keyword.value.toLowerCase())),
);

const counts = computed(() => {
	const result = { all: agents.value.length, draft: 0, testing: 0, published: 0, stopped: 0 };
	for (const item of agents.value) result[item.status] = (result[item.status] ?? 0) + 1;
	return result;
});

const statusOptions = computed(() => [
	{ label: `全部 ${counts.value.all}`, value: "all" },
	{ label: `草稿 ${counts.value.draft}`, value: "draft" },
	{ label: `试运行 ${counts.value.testing}`, value: "testing" },
	{ label: `已发布 ${counts.value.published}`, value: "published" },
	{ label: `已停用 ${counts.value.stopped}`, value: "stopped" },
]);

function blankForm() {
	return {
		name: "",
		description: "",
		category: "",
		agentsMd: "",
		chatModelId: null,
		temperature: 0.7,
		topP: 1,
		maxTokens: 4096,
		stream: true,
		reserveTokens: 16384,
		keepRecentTokens: 20000,
		maxIters: 10,
		showThinking: true,
		skillIds: [],
		kbIds: [],
	};
}

function statusMeta(status) {
	return STATUS_META[status] ?? { label: status, type: "default" };
}

function actionsOf(status) {
	return ACTIONS_BY_STATUS[status] ?? [];
}

async function load() {
	loading.value = true;
	error.value = "";
	try {
		agents.value = await agentsApi.list();
	} catch (cause) {
		error.value = `读取 Agent 列表失败：${cause.message}`;
	} finally {
		loading.value = false;
	}
}

/** 下拉选项：技能 / 知识库 / 模型，失败就空着（不阻断编辑主表单） */
async function loadOptions() {
	const [skills, kbs, models, mcp] = await Promise.all([
		skillsApi.list().catch(() => []),
		kbApi.list().catch(() => []),
		modelsApi.list().catch(() => null),
		mcpApi.list().catch(() => []),
	]);
	// auto-flow 是默认聊天模式，不是可绑定的技能（与技能页同一规则）
	skillOptions.value = skills.filter((item) => item.id !== "auto-flow").map((item) => ({ label: item.name, value: item.id }));
	kbOptions.value = kbs.map((item) => ({ label: item.name, value: item.id }));
	const chatModels = (models?.models ?? []).filter((item) => item.kind !== "embedding");
	modelOptions.value = chatModels.map((item) => ({ label: item.name || item.modelId, value: item.id }));
	mcpServers.value = mcp;
}

function openCreate() {
	editingId.value = null;
	editingAdvanced.value = {};
	Object.assign(form, blankForm());
	showEditor.value = true;
}

function openCopy(item) {
	copySource.value = { id: item.id, name: item.name };
	copyName.value = `${item.name.slice(0, 55)} - 副本`;
}

async function copyAgent() {
	if (copying.value || !copySource.value) return;
	const name = copyName.value.trim();
	if (!name || name.length > 60) {
		message.warning("请填写 1–60 个字的副本名称");
		return;
	}
	copying.value = true;
	try {
		const source = await agentsApi.get(copySource.value.id);
		await agentsApi.create({
			name,
			description: source.description,
			category: source.category,
			icon: source.icon,
			agentsMd: source.agentsMd,
			modelConfig: source.modelConfig,
			memoryConfig: source.memoryConfig,
			advancedConfig: source.advancedConfig,
			skillIds: source.skillIds,
			kbIds: source.kbIds,
		});
		copySource.value = null;
		keyword.value = name;
		statusFilter.value = "all";
		await load();
		message.success("已复制为草稿，可独立配置和发布");
	} catch (cause) {
		message.error(cause?.message || "复制 Agent 失败");
	} finally {
		copying.value = false;
	}
}

function openEdit(item) {
	editingId.value = item.id;
	editingAdvanced.value = { ...(item.advancedConfig ?? {}) };
	Object.assign(form, blankForm(), {
		name: item.name,
		description: item.description,
		category: item.category,
		agentsMd: item.agentsMd,
		chatModelId: item.modelConfig?.chatModelId ?? null,
		temperature: item.modelConfig?.temperature ?? 0.7,
		topP: item.modelConfig?.topP ?? 1,
		maxTokens: item.modelConfig?.maxTokens ?? 4096,
		stream: item.modelConfig?.stream ?? true,
		reserveTokens: item.memoryConfig?.reserveTokens ?? 16384,
		keepRecentTokens: item.memoryConfig?.keepRecentTokens ?? 20000,
		maxIters: item.advancedConfig?.maxIters ?? 10,
		showThinking: item.advancedConfig?.showThinking ?? true,
		skillIds: [...(item.skillIds ?? [])],
		kbIds: [...(item.kbIds ?? [])],
	});
	showEditor.value = true;
}

/** 六维配置打包成接口形状：表单字段 → 三个 JSON 配置 + 两个绑定数组 */
function toPayload() {
	return {
		name: form.name,
		description: form.description,
		category: form.category,
		agentsMd: form.agentsMd,
		modelConfig: {
			chatModelId: form.chatModelId,
			temperature: form.temperature,
			topP: form.topP,
			maxTokens: form.maxTokens,
			stream: form.stream,
		},
		memoryConfig: { reserveTokens: form.reserveTokens, keepRecentTokens: form.keepRecentTokens },
		advancedConfig: { ...editingAdvanced.value, maxIters: form.maxIters, showThinking: form.showThinking },
		skillIds: form.skillIds,
		kbIds: form.kbIds,
	};
}

async function save() {
	if (form.name.trim().length === 0) {
		message.warning("请填写 Agent 名称");
		return;
	}
	saving.value = true;
	try {
		if (editingId.value) {
			await agentsApi.update(editingId.value, toPayload());
			message.success("已保存");
		} else {
			await agentsApi.create(toPayload());
			message.success("已创建，状态为草稿");
		}
		showEditor.value = false;
		await load();
	} catch (cause) {
		// 409 published_locked：后端明确拒绝编辑已发布体，提示要具体
		if (cause.message.includes("已发布")) message.warning(cause.message);
		else message.error(cause.message);
	} finally {
		saving.value = false;
	}
}

async function runAction(item, action) {
	if (action === "publish") return openCheck(item);
	busy.value = item.id + action;
	try {
		await agentsApi.act(item.id, action);
		await load();
		message.success(`已执行「${ACTIONS_BY_STATUS[item.status]?.find((a) => a.key === action)?.label ?? action}」`);
	} catch (cause) {
		message.error(cause.message);
	} finally {
		busy.value = "";
	}
}

async function openCheck(item) {
	if (checkLoading.value) return;
	checkTarget.value = item;
	checkReport.value = null;
	await refreshCheck();
}

async function refreshCheck() {
	if (!checkTarget.value || checkLoading.value) return;
	checkLoading.value = true;
	checkError.value = "";
	try {
		checkReport.value = await agentsApi.preflight(checkTarget.value.id);
	} catch (cause) {
		checkReport.value = null;
		checkError.value = cause.message;
	} finally {
		checkLoading.value = false;
	}
}

async function publishChecked() {
	if (!checkTarget.value || !checkReport.value?.ready || checkLoading.value) return;
	checkLoading.value = true;
	checkError.value = "";
	try {
		await agentsApi.act(checkTarget.value.id, "publish");
		checkTarget.value = null;
		await load();
		message.success("已发布");
	} catch (cause) {
		checkReport.value = null;
		checkError.value = cause.message;
	} finally {
		checkLoading.value = false;
	}
}

function confirmRemove(item) {
 dialog.warning({ title: "删除 Agent", content: `确定删除「${item.name}」？历史会话仍保留，Agent 配置无法恢复。`, positiveText: "删除", negativeText: "取消", onPositiveClick: () => remove(item) });
}
async function remove(item) {
	busy.value = item.id + "remove";
	try {
		await agentsApi.remove(item.id);
		await load();
		message.success("已删除");
	} catch (cause) {
		message.error(cause.message);
	} finally {
		busy.value = "";
	}
}

onMounted(async () => {
	await Promise.all([load(), loadOptions()]);
});
</script>

<template>
	<page-shell
		title="Agent"
		subtitle="把模型、技能、知识库与人格指令打包成一个可发布、可停用的智能体"
		:action="can('workflow.write') ? '新建 Agent' : ''"
		:loading="loading"
		:error="error"
		@action="openCreate"
	>
		<div class="status-bar toolbar">
 <n-input v-model:value="keyword" placeholder="搜索 Agent 名称或用途" class="search" clearable />
			<n-select v-model:value="statusFilter" :options="statusOptions" class="status-select" />
			<span class="flow-hint">{{ filtered.length }} 个智能体 · 已发布配置需召回后修改</span>
		</div>

		<n-empty v-if="filtered.length === 0 && !loading" description="还没有 Agent，点右上角新建一个" class="empty-block" />

		<div v-else class="agent-grid">
			<!-- data-agent-id：e2e 要断言"跳转路由里带的是这个 Agent 的真实 id"，光比名字会放过取错 id 的 bug -->
			<article v-for="item in filtered" :key="item.id" class="agent-card" :data-agent-id="item.id">
				<div class="agent-head">
					<div class="agent-avatar">{{ (item.name ?? "A").slice(0, 1) }}</div>
					<div class="agent-title-wrap">
						<div class="agent-name">{{ item.name }}</div>
						<div class="agent-category">{{ item.category || "未分类" }}</div>
					</div>
					<n-tag :bordered="false" size="small" :type="statusMeta(item.status).type">
						{{ statusMeta(item.status).label }}
					</n-tag>
				</div>

				<p class="agent-desc">{{ item.description || "暂无简介" }}</p>

				<div class="agent-stats">
					<span>{{ (item.skillIds ?? []).length }} 个技能</span>
					<span class="dot">·</span>
					<span>{{ (item.kbIds ?? []).length }} 个知识库</span>
				</div>

				<div class="agent-actions">
					<n-button
						v-if="chattable(item.status)"
						size="small"
						type="primary"
						:loading="busy === item.id + 'chat'"
						@click="startChat(item)"
					>
						对话
					</n-button>
					<n-button size="small" quaternary @click="openAgentChat(item)">历史会话</n-button>
					<n-button size="small" quaternary @click="openCheck(item)">发布检查</n-button>
					<details v-if="can('workflow.write')" class="more-actions"><summary>管理</summary><div class="more-menu">
					<n-button size="small" quaternary @click="openCopy(item)">复制为草稿</n-button>
					<n-button
						v-for="act in actionsOf(item.status)"
						:key="act.key"
						size="small"
						:type="act.key === 'publish' ? 'primary' : 'default'"
						:loading="busy === item.id + act.key"
						@click="runAction(item, act.key)"
					>
						{{ act.label }}
					</n-button>
					<n-button size="small" quaternary :disabled="item.status === 'published'" @click="openEdit(item)">
						配置
					</n-button>
					<n-button size="small" quaternary type="error" :loading="busy === item.id + 'remove'" @click="confirmRemove(item)">
						删除
					</n-button>
					</div></details>
				</div>
			</article>
		</div>

		<n-modal :show="Boolean(copySource)" preset="card" title="复制为草稿" :closable="!copying" :mask-closable="!copying" :close-on-esc="!copying" style="width: 460px; max-width: 95vw" @update:show="value => { if (!value && !copying) copySource = null; }">
			<p class="hint">从「{{ copySource?.name }}」复制配置及能力绑定。历史会话和长期记忆保留在原 Agent。</p>
			<n-form label-placement="top" @submit.prevent="copyAgent">
				<n-form-item label="副本名称" required>
					<n-input v-model:value="copyName" :disabled="copying" :maxlength="60" show-count placeholder="填写副本名称" />
				</n-form-item>
			</n-form>
			<template #footer>
				<div class="action-row">
					<n-button :disabled="copying" @click="copySource = null">取消</n-button>
					<n-button type="primary" :loading="copying" :disabled="copying || !copyName.trim()" @click="copyAgent">创建副本</n-button>
				</div>
			</template>
		</n-modal>

		<n-modal v-model:show="showEditor" preset="card" :title="editingId ? '配置 Agent' : '新建 Agent'" style="width: 860px; max-width: 95vw">
			<p class="hint">先填写名称、职责、模型与能力绑定即可开始试用；记忆和高级设置可按需调整。</p>
			<n-form label-placement="top">
				<n-tabs type="line" animated>
					<n-tab-pane name="basic" tab="基础信息">
						<n-form-item label="名称" required>
							<n-input v-model:value="form.name" placeholder="例如：售后客服助手" />
						</n-form-item>
						<n-form-item label="简介">
							<n-input v-model:value="form.description" type="textarea" :rows="2" placeholder="一句话说明它能做什么" />
						</n-form-item>
						<n-form-item label="分类">
							<n-input v-model:value="form.category" placeholder="例如：客服 / 销售 / 人事" />
						</n-form-item>
					</n-tab-pane>

					<n-tab-pane name="persona" tab="人格与指令">
						<n-form-item label="AGENTS.md 风格指令（Markdown）">
							<n-input v-model:value="form.agentsMd" type="textarea" :rows="10" placeholder="# 你的角色\n你是……\n\n## 原则\n1. ……" />
						</n-form-item>
					</n-tab-pane>

					<n-tab-pane name="model" tab="模型策略">
						<n-form-item label="对话模型">
							<n-select v-model:value="form.chatModelId" :options="modelOptions" clearable placeholder="留空则用当前模型" />
						</n-form-item>
						<n-form-item label="温度（0–2，越高越发散）">
							<n-input-number v-model:value="form.temperature" :min="0" :max="2" :step="0.1" style="width: 100%" />
						</n-form-item>
						<n-form-item label="Top P（0–1）">
							<n-input-number v-model:value="form.topP" :min="0" :max="1" :step="0.05" style="width: 100%" />
						</n-form-item>
						<n-form-item label="最大输出 token">
							<n-input-number v-model:value="form.maxTokens" :min="1" :max="128000" :step="256" style="width: 100%" />
						</n-form-item>
						<n-form-item label="流式输出">
							<n-switch v-model:value="form.stream" />
						</n-form-item>
					</n-tab-pane>

					<n-tab-pane name="memory" tab="记忆">
						<n-form-item label="自动压缩预留 token 数">
							<n-input-number v-model:value="form.reserveTokens" :min="0" :max="1000000" :step="1024" style="width: 100%" />
						</n-form-item>
						<n-form-item label="压缩后保留 token 数">
							<n-input-number v-model:value="form.keepRecentTokens" :min="0" :max="1000000" :step="1024" style="width: 100%" />
						</n-form-item>
					</n-tab-pane>

					<n-tab-pane name="binding" tab="能力绑定">
						<section class="mcp-capability">
							<div class="mcp-capability-head">
								<div>
									<strong>MCP 工具</strong>
									<p>已启用的 MCP 工具会自动提供给这个 Agent 的对话；高风险调用需要人工审批。</p>
								</div>
								<n-button size="small" @click="router.push({ name: 'mcp' })">管理 MCP</n-button>
							</div>
							<div v-if="mcpServers.length" class="mcp-server-list">
								<div v-for="server in mcpServers" :key="server.id" class="mcp-server-row">
									<div class="mcp-server-copy">
										<strong>{{ server.name }}</strong>
										<span>{{ (server.tools ?? []).filter((tool) => tool.enabled).length }} 个可用工具</span>
									</div>
									<n-tag size="small" :bordered="false" :type="server.enabled && server.lastStatus === 'ok' ? 'success' : 'default'">
										{{ !server.enabled ? '已停用' : server.lastStatus === 'ok' ? '已连接' : server.lastStatus === 'error' ? '连接异常' : '待检查' }}
									</n-tag>
								</div>
							</div>
							<div v-else class="mcp-empty">尚未配置 MCP 服务</div>
						</section>
						<n-form-item label="技能">
							<n-select v-model:value="form.skillIds" :options="skillOptions" multiple filterable placeholder="选择要挂载的技能" />
						</n-form-item>
						<n-form-item label="知识库">
							<n-select v-model:value="form.kbIds" :options="kbOptions" multiple filterable placeholder="选择要检索的知识库" />
						</n-form-item>
					</n-tab-pane>

					<n-tab-pane name="advanced" tab="高级">
						<n-form-item label="最大推理轮数">
							<n-input-number v-model:value="form.maxIters" :min="1" :max="50" style="width: 100%" />
						</n-form-item>
						<n-form-item label="向用户展示思考过程">
							<n-switch v-model:value="form.showThinking" />
						</n-form-item>
					</n-tab-pane>
				</n-tabs>
			</n-form>
			<template #footer>
				<div class="editor-foot">
					<span v-if="editingId" class="editor-hint">已发布的 Agent 无法保存，请先召回草稿</span>
					<div class="editor-buttons">
						<n-button @click="showEditor = false">取消</n-button>
						<n-button type="primary" :loading="saving" @click="save">保存</n-button>
					</div>
				</div>
			</template>
		</n-modal>
		<n-modal :show="Boolean(checkTarget)" preset="card" title="Agent 发布检查" class="agent-preflight" :closable="!checkLoading" :mask-closable="!checkLoading" :close-on-esc="!checkLoading" style="width: 620px; max-width: 95vw" @update:show="value => { if (!value && !checkLoading) checkTarget = null; }">
			<p class="check-agent-name">{{ checkTarget?.name }}</p>
			<p v-if="checkLoading" role="status">正在检查配置…</p>
			<p v-if="checkError" role="alert" class="check-error">{{ checkError }}</p>
			<template v-if="checkReport">
				<n-tag :type="checkReport.ready ? 'success' : 'error'" :bordered="false">{{ checkReport.ready ? '配置检查通过' : '存在阻断项，暂不可发布' }}</n-tag>
				<ul class="check-issues">
					<li v-for="(issue, index) in checkReport.issues" :key="index" :class="{ 'check-error': issue.level === 'error' }">
						<n-tag size="small" :bordered="false" :type="issue.level === 'error' ? 'error' : 'warning'">{{ issue.level === 'error' ? '需修复' : '提醒' }}</n-tag>
						<span>{{ issue.message }}</span>
					</li>
				</ul>
				<p v-if="!checkReport.issues.length">未发现配置问题。</p>
			</template>
			<template #footer>
				<div class="check-actions">
					<n-button :disabled="checkLoading" @click="refreshCheck">重新检查</n-button>
					<n-button v-if="checkTarget && chattable(checkTarget.status)" :disabled="checkLoading" :loading="busy === checkTarget.id + 'chat'" @click="startChat(checkTarget)">一键试聊</n-button>
					<n-button v-if="checkTarget && ['draft', 'testing'].includes(checkTarget.status) && can('workflow.write')" type="primary" :disabled="!checkReport?.ready || checkLoading" :loading="checkLoading" @click="publishChecked">确认发布</n-button>
				</div>
			</template>
		</n-modal>
	</page-shell>
</template>

<style scoped>
.check-agent-name { margin-top: 0; font-weight: 600; }
.check-issues { list-style: none; padding: 0; margin: 16px 0; display: grid; gap: 12px; }
.check-issues li { display: flex; align-items: flex-start; gap: 10px; line-height: 1.7; }
.check-issues .n-tag { flex-shrink: 0; margin-top: 2px; }
.check-error { color: var(--error, #c0393a); }
.check-actions { display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
.status-bar {
	display: flex;
	align-items: center;
	gap: 12px;
	margin-bottom: 16px;
	flex-wrap: wrap;
}

.status-select {
	width: 160px;
}

.flow-hint {
	font-size: 12px;
	color: var(--muted);
}

.agent-grid {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
	gap: 16px;
}

.agent-card {
	background: var(--surface);
	border: 1px solid var(--line);
	border-radius: var(--radius-lg);
	padding: 16px 18px 12px;
	box-shadow: var(--shadow-sm);
	display: flex;
	flex-direction: column;
	gap: 10px;
	transition: box-shadow 0.15s ease;
}

.agent-card:hover {
	box-shadow: var(--shadow);
}

.agent-head {
	display: flex;
	align-items: flex-start;
	gap: 10px;
}

.agent-avatar {
	width: 36px;
	height: 36px;
	border-radius: 11px;
	background: var(--brand-gradient);
	color: #fff;
	display: grid;
	place-items: center;
	font-weight: 600;
	flex: 0 0 auto;
}

.agent-title-wrap {
	flex: 1;
	min-width: 0;
}

.agent-name {
	font-size: 14px;
	font-weight: 600;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}

.agent-category {
	font-size: 11.5px;
	color: var(--muted);
	margin-top: 2px;
}

.agent-desc {
	margin: 0;
	font-size: 12.5px;
	line-height: 1.6;
	color: var(--text-2);
	display: -webkit-box;
	-webkit-line-clamp: 2;
	line-clamp: 2;
	-webkit-box-orient: vertical;
	overflow: hidden;
	min-height: 40px;
}

.agent-stats {
	font-size: 12px;
	color: var(--muted);
	display: flex;
	gap: 6px;
}

.dot {
	color: var(--line-strong);
}

.agent-actions {
	display: flex;
	gap: 6px;
	flex-wrap: wrap;
	padding-top: 10px;
	border-top: 1px solid var(--line);
}

.empty-block {
	padding: 48px 0;
}

.editor-foot {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
}

.editor-hint {
	font-size: 12px;
	color: var(--muted);
}

.editor-buttons {
	display: flex;
	gap: 8px;
	margin-left: auto;
}

.mcp-capability {
	margin: 0 0 20px;
	padding: 14px 16px;
	background: var(--surface-alt);
	border: 1px solid var(--line);
	border-radius: 8px;
}

.mcp-capability-head, .mcp-server-row, .mcp-server-copy {
	display: flex;
	align-items: center;
}

.mcp-capability-head, .mcp-server-row {
	justify-content: space-between;
	gap: 12px;
}

.mcp-capability-head strong, .mcp-server-copy strong { font-size: 13px; font-weight: 600; }
.mcp-capability-head p { margin: 4px 0 0; color: var(--muted); font-size: 12px; line-height: 1.55; }
.mcp-server-list { display: grid; margin-top: 12px; border-top: 1px solid var(--line); }
.mcp-server-row { padding: 10px 0 0; }
.mcp-server-copy { gap: 10px; min-width: 0; }
.mcp-server-copy span, .mcp-empty { color: var(--muted); font-size: 12px; }
.mcp-empty { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--line); }
</style>
