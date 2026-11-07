<script setup>
/**
 * 模型管理页：供应商 + 模型两张面板，当前模型可切换，最大上下文可配置。
 *
 * 关键事实（来自后端设计，页面上要说清楚，不能让人误会）：
 *  - API Key 只回掩码，明文只在创建时出现一次；
 *  - 当前模型只存内存，重启回落第一条可用项 —— 这是设计如此，不是 bug；
 *  - 最大上下文（contextWindow，单位 token）存库、重启仍在，空 = 未配置（后端存 null）。
 *
 * 增删改都在这里：新建/编辑走 ModelForm 组件（弹窗表单），删除与测试连通是行内按钮。
 * 表单拆成独立组件是为了跟同时改这张页面的另一半（供应商面板）少撞车。
 *
 * 一条要如实呈现的语义：**测试连通永远返回 200**，失败也 200（body 里 `ok:false` + 中文 `error`），
 * 所以判定成败只能读 body.ok，不能看状态码——看状态码会把「连不上」显示成「正常」。
 */
import { computed, onMounted, ref } from "vue";
import { NButton, NEmpty, NInput, NModal, NPopconfirm, NSelect, NTag, useMessage } from "naive-ui";
import PageShell from "../components/PageShell.vue";
import Panel from "../components/Panel.vue";
import ModelForm from "../components/ModelForm.vue";
import ProviderForm from "../components/ProviderForm.vue";
import { can } from "../access.js";
import { modelsApi, providersApi } from "../api.js";

const message = useMessage();
const loading = ref(true);
const error = ref("");
const data = ref(null);
const switching = ref("");
const selectedProvider = ref(null);
const keyword = ref("");
const embeddingKey = ref(null);
const currentKey = ref(null);

const providers = computed(() => data.value?.providers ?? []);
const models = computed(() => (data.value?.models ?? []).filter(m=>(!selectedProvider.value||m.providerId===selectedProvider.value)&&`${m.name} ${m.modelId}`.toLowerCase().includes(keyword.value.toLowerCase())));
/**
 * 当前模型：GET /api/models 的 `current` 是 **modelId 字符串**（如 deepseek-flash），
 * 不是模型记录的内部 id（model-e1b524a5）。对模型行判断时拿 modelId 比，别拿内部 id。
 */
const currentModelId = computed(() => data.value?.current ?? "");
const isCurrent = (item) => item.kind === "embedding" ? item.id === embeddingKey.value : item.id === currentKey.value;

/** 供应商名：模型行里只存 providerId，要回表查名字给人看 */
function providerName(id) {
	return providers.value.find((item) => item.id === id)?.name ?? id ?? "—";
}

function kindLabel(kind) {
	if (kind === "chat") return "对话";
	if (kind === "embedding") return "向量";
	return kind ?? "—";
}

/**
 * token 数按人读的方式显示：131072 → 128k、256000 → 256k、200000 → 200k。
 *
 * 约数是**低精度取整**（128k，不是 131.1k）：这些数字是给人扫一眼用的，
 * 131072 这种精确到个位的 k 值既不比原数好读，还跟行业口径（128k/256k）对不上——
 * 到底存了多少看同一行里的原始数字，这里只负责"大致多大"。
 */
function formatTokens(value) {
	if (value >= 1000000) return `${trimZero(Math.round(value / 100000) / 10)}M`;
	if (value >= 1000) return `${trimZero(Math.round(value / 100) / 10)}k`;
	return String(value);
}

/** 去掉 toFixed(1) 留下的尾零：128.0 → 128、131.1 → 131.1 */
function trimZero(value) {
	return value.toFixed(1).replace(/\.0$/, "");
}

/** 列表里那一列：没配就写「未配置」；只显示 k（用户指定，行业口径），不摆原始数字。 */
function contextWindowText(model) {
	if (typeof model.contextWindow !== "number") return "未配置";
	return formatTokens(model.contextWindow);
}

/* ---------------- 最大上下文：编辑抽屉 ---------------- */

const editing = ref(null);
/** 弹窗开关单独一个 ref：模板里必须绑一个可写变量，不能写 `editing !== null` 这种表达式 */
const contextOpen = ref(false);
const draftContext = ref("");
const savingContext = ref(false);

function openContextDialog(model) {
	editing.value = model;
	draftContext.value = typeof model.contextWindow === "number" ? String(model.contextWindow) : "";
	contextOpen.value = true;
}

/**
 * 保存最大上下文。
 * 空串 = 清空配置（PATCH 传 null，后端落 null）；只写数字不写单位——
 * 「128k」这种带单位的值后端会直接 400，与其在界面上放宽再报错，不如当场说清楚。
 */
async function saveContext() {
	const model = editing.value;
	if (!model) return;
	const raw = draftContext.value.trim().replace(/[,\s]/g, "");
	let contextWindow = null;
	if (raw.length > 0) {
		const parsed = Number(raw);
		if (!Number.isInteger(parsed) || parsed <= 0) {
			message.warning("最大上下文要填正整数（token 数，例如 131072），留空表示未配置。");
			return;
		}
		contextWindow = parsed;
	}
	savingContext.value = true;
	try {
		await modelsApi.patch(model.id, { contextWindow });
		contextOpen.value = false;
		await load();
		message.success(
			contextWindow === null
				? `已清空「${model.name || model.modelId}」的最大上下文`
				: `已保存「${model.name || model.modelId}」的最大上下文：${formatTokens(contextWindow)}`,
		);
	} catch (cause) {
		message.error(cause.message);
	} finally {
		savingContext.value = false;
	}
}

/* ---------------- 供应商：新建 / 编辑 / 删除 ---------------- */

/** 供应商表单弹窗；provider 为 null 表示新建 */
const providerFormOpen = ref(false);
const providerFormTarget = ref(null);
const removingProvider = ref("");

function openProviderCreate() {
	providerFormTarget.value = null;
	providerFormOpen.value = true;
}

function openProviderEdit(provider) {
	providerFormTarget.value = provider;
	providerFormOpen.value = true;
}

async function onProviderSaved() {
	await load();
}

/**
 * 删除供应商。
 * 引用保护交给后端：名下还有模型时后端怎么定（拒绝或连带），界面只如实转述它的原话，
 * 不在前端先猜一遍——猜错了会挡住合法操作，或者放行了不该放的。
 */
async function removeProvider(provider) {
	removingProvider.value = provider.id;
	try {
		await providersApi.remove(provider.id);
		await load();
		message.success(`已删除供应商「${provider.name || provider.id}」`);
	} catch (cause) {
		message.error(cause.message);
	} finally {
		removingProvider.value = "";
	}
}

/* ---------------- 新建 / 编辑 / 删除 / 测试连通 ---------------- */

/** 表单弹窗开关；model 为 null 表示新建 */
const formOpen = ref(false);
const formTarget = ref(null);
const removing = ref("");
/** ping 结果按模型 id 存：异步回来时不能只认「最后点的那条」，否则点 A 再点 B 会把结果写错行 */
const pings = ref({});

function openCreate() {
	formTarget.value = null;
	formOpen.value = true;
}

function openEdit(model) {
	formTarget.value = model;
	formOpen.value = true;
}

/** 表单存完统一重拉列表：钳制后的上下文、回落过的显示名都以后端为准 */
async function onFormSaved() {
	await load();
}

async function removeModel(model) {
	removing.value = model.id;
	try {
		await modelsApi.remove(model.id);
		await load();
		message.success(`已删除「${model.name || model.modelId}」`);
	} catch (cause) {
		message.error(cause.message);
	} finally {
		removing.value = "";
	}
}

/**
 * 测试连通。
 * 8 秒超时，成败都在 body：`{ ok, latencyMs, error? }`。
 * 失败文案直接透传后端的中文 error（那里已经说清了是 401、超时还是域名解析不了），
 * 这里不再自己翻译一遍——自己编一句「连接失败」会把真正的原因盖掉。
 */
async function pingModel(model) {
	pings.value = { ...pings.value, [model.id]: { state: "running" } };
	try {
		const result = await modelsApi.ping(model.id);
		pings.value = {
			...pings.value,
			[model.id]: {
				state: result?.ok ? "ok" : "fail",
				latencyMs: result?.latencyMs,
				error: result?.error ?? "",
			},
		};
	} catch (cause) {
		// 真出网络错（服务没起来之类）才走这里；正常业务失败是 200 + ok:false
		pings.value = { ...pings.value, [model.id]: { state: "fail", error: cause.message } };
	}
}

/** 行内那条测试结果文案：失败时必须带上后端给的原因，不能只说「失败」 */
function pingText(model) {
	const result = pings.value[model.id];
	if (!result) return "";
	if (result.state === "running") return "测试中…";
	if (result.state === "ok") return `连通正常${result.latencyMs ? ` · ${result.latencyMs}ms` : ""}`;
	return `连不上${result.error ? `：${result.error}` : ""}`;
}

async function load() {
	loading.value = true;
	error.value = "";
	try {
		const [config, current, embedding] = await Promise.all([modelsApi.list(), modelsApi.current(), modelsApi.embedding()]);
		data.value = config;
		currentKey.value = current.model?.id ?? null;
		embeddingKey.value = embedding.modelKey;
	} catch (cause) {
		error.value = `读取模型配置失败：${cause.message}`;
	} finally {
		loading.value = false;
	}
}

async function setCurrent(item) {
 const modelId = item.modelId;
	switching.value = item.id;
	try {
		if(item.kind === "embedding") await modelsApi.setEmbedding(item.id);
		else await modelsApi.setCurrent(item.id);
		await load();
		message.success(item.kind === "embedding" ? "已设为默认向量模型" : "已设为默认对话模型，仅影响新建会话");
	} catch (cause) {
		message.error(cause.message);
	} finally {
		switching.value = "";
	}
}

onMounted(load);
</script>

<template>
	<page-shell
		title="模型管理"
		subtitle="分别管理默认对话模型和向量模型；已打开的会话保持自己的模型"
		:loading="loading"
		:error="error"
	>
		<div class="toolbar"><n-input v-model:value="keyword" class="search" placeholder="搜索模型名称或 ID" clearable /><n-select v-model:value="selectedProvider" :options="providers.map(p=>({label:p.name,value:p.id}))" clearable placeholder="全部供应商" style="width:220px" /></div>
		<div class="stack">
			<panel title="供应商" :meta="`${providers.length} 个`">
				<template #actions>
					<n-button size="small" type="primary" data-testid="provider-create" :disabled="!can('workflow.write')" @click="openProviderCreate">＋ 新建供应商</n-button>
				</template>
				<n-empty v-if="providers.length === 0" description="还没有供应商，点右上角「＋ 新建供应商」加一个" />
				<ul v-else class="row-list">
					<li v-for="item in providers" :key="item.id" class="row">
						<div class="row-main">
							<div class="row-name">{{ item.name }}</div>
							<div class="row-meta">
								{{ item.baseUrl || "默认地址" }} · Key：<span data-testid="provider-key-masked">{{ item.apiKeyMasked || "未配置" }}</span>
							</div>
							<!-- Key 密文解不开：给显眼的「重新填写 Key」入口，判定只看 apiKeyBroken，不匹配占位文案 -->
							<div v-if="item.apiKeyBroken" class="row-meta key-broken" data-testid="provider-key-broken">
								Key 密文解不开
								<n-button size="tiny" type="warning" data-testid="provider-rekey" @click="openProviderEdit(item)">重新填写 Key</n-button>
							</div>
						</div>
						<div class="row-actions">
							<n-tag :bordered="false" size="small" :type="item.enabled === false ? 'default' : 'success'">
								{{ item.enabled === false ? "已停用" : "启用" }}
							</n-tag>
							<n-button size="small" data-testid="provider-edit" :disabled="!can('workflow.write')" @click="openProviderEdit(item)">编辑</n-button>
							<n-popconfirm
								:show-icon="false"
								positive-text="删除"
								negative-text="取消"
								@positive-click="() => removeProvider(item)"
							>
								<template #trigger>
									<n-button size="small" quaternary type="error" data-testid="provider-delete" :disabled="!can('workflow.write')" :loading="removingProvider === item.id">
										删除
									</n-button>
								</template>
								{{ `确定删除供应商「${item.name || item.id}」？它名下的 ${item.modelCount ?? 0} 个模型会一并删掉。` }}
							</n-popconfirm>
						</div>
					</li>
				</ul>
			</panel>

			<panel title="模型" :meta="`${models.length} 个`">
				<template #actions>
					<n-button size="small" type="primary" data-testid="model-create" :disabled="!can('workflow.write')" @click="openCreate">＋ 新建模型</n-button>
				</template>
				<n-empty v-if="models.length === 0" description="还没有模型，点右上角「＋ 新建模型」加一条" />
				<ul v-else class="row-list">
					<li v-for="item in models" :key="item.id" class="row" :class="{ 'row--current': isCurrent(item) }">
						<div class="row-main">
							<div class="row-name">
								{{ item.name || item.modelId }}
								<n-tag v-if="isCurrent(item)" :bordered="false" size="small" type="primary" class="current-tag">
									当前
								</n-tag>
							</div>
							<div class="row-meta">{{ providerName(item.providerId) }} · {{ item.modelId }} · {{ kindLabel(item.kind) }}</div>
							<div class="row-meta">
								最大上下文：<span data-testid="model-context-value">{{ contextWindowText(item) }}</span>
							</div>
							<!-- 测试结果如实贴在行内：ok/延迟/失败原因都来自后端，失败时不能只写「失败」 -->
							<div
								v-if="pingText(item)"
								class="row-meta row-ping"
								:class="{ 'row-ping--fail': pings[item.id]?.state === 'fail' }"
								data-testid="model-ping-result"
							>
								{{ pingText(item) }}
							</div>
						</div>
						<div class="row-actions">
							<n-button size="small" :disabled="isCurrent(item) || !can('workflow.write')" :loading="switching === item.id" @click="setCurrent(item)">
								{{ isCurrent(item) ? '使用中' : item.kind === 'embedding' ? '设为默认向量' : '设为默认对话' }}
							</n-button>
							<n-button
								size="small"
								data-testid="model-context-edit" :disabled="!can('workflow.write')"
								:title="`配置「${item.name || item.modelId}」的最大上下文`"
								@click="openContextDialog(item)"
							>
								最大上下文
							</n-button>
							<n-button
								size="small"
								data-testid="model-ping" :disabled="!can('workflow.write')"
								:title="`向「${item.name || item.modelId}」发一次极短请求，验证 Key 与地址可用`"
								:loading="pings[item.id]?.state === 'running'"
								@click="pingModel(item)"
							>
								测试连通
							</n-button>
							<n-button size="small" data-testid="model-edit" :disabled="!can('workflow.write')" @click="openEdit(item)">编辑</n-button>
							<n-popconfirm
								:show-icon="false"
								positive-text="删除"
								negative-text="取消"
								@positive-click="removeModel(item)"
							>
								<template #trigger>
									<n-button size="small" quaternary type="error" data-testid="model-delete" :disabled="!can('workflow.write')" :loading="removing === item.id">
										删除
									</n-button>
								</template>
								{{ `确定删除「${item.name || item.modelId}」？绑定了它的会话会回落到默认模型。` }}
							</n-popconfirm>
						</div>
					</li>
				</ul>
			</panel>
		</div>

		<!-- 编辑抽屉：Naive UI 的 dialog 要额外挂 provider，页面不该为一个输入框付出这个代价，用 modal 即可 -->
		<n-modal v-model:show="contextOpen" preset="card" title="最大上下文" :style="{ maxWidth: '460px' }">
			<div class="ctx-form">
				<div class="ctx-target">{{ editing ? editing.name || editing.modelId : "" }}</div>
				<n-input
					v-model:value="draftContext"
					data-testid="model-context-input"
					placeholder="例如 131072；留空表示未配置"
				>
					<template #suffix>token</template>
				</n-input>
				<p class="ctx-hint">
					这个模型一次能装下的 token 数（含输入与输出），填正整数；先查供应商文档里的准确数字，别照抄别家。
					留空即清空配置，对话页的上下文用量在没有配置时不显示占比。
				</p>
			</div>
			<template #footer>
				<div class="ctx-foot">
					<n-button @click="contextOpen = false">取消</n-button>
					<n-button type="primary" data-testid="model-context-save" :loading="savingContext" @click="saveContext">保存</n-button>
				</div>
			</template>
		</n-modal>

		<!-- 新建/编辑共用同一个组件：formTarget 为 null 就是新建 -->
		<model-form
			v-model:show="formOpen"
			:model="formTarget"
			:providers="providers"
			@saved="onFormSaved"
		/>

		<!-- 供应商表单：同款拆法，provider 为 null 就是新建 -->
		<provider-form
			v-model:show="providerFormOpen"
			:provider="providerFormTarget"
			@saved="onProviderSaved"
		/>
	</page-shell>
</template>

<style scoped>
.stack {
	display: flex;
	flex-direction: column;
	gap: 16px;
}

.row-list {
	list-style: none;
	margin: 0;
	padding: 0;
}

.row {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 16px;
	padding: 10px 12px;
	border-radius: var(--radius);
}

.row + .row {
	border-top: 1px solid var(--line);
}

/* 当前模型：浅靛蓝底，一眼看出在用哪个 */
.row--current {
	background: var(--brand-soft);
}

.row-name {
	display: flex;
	align-items: center;
	gap: 8px;
	font-size: 13.5px;
	font-weight: 500;
}

.row-meta {
	font-size: 12px;
	color: var(--muted);
	margin-top: 3px;
	word-break: break-all;
}

.row-actions {
	display: flex;
	align-items: center;
	gap: 8px;
	flex: none;
}

.current-tag {
	margin-left: 2px;
}

/* 测试连通的结果贴在行内：成功低调、失败用警示色，原因文字可能很长要能换行 */
.row-ping {
	color: var(--success, #18a058);
}

.row-ping--fail {
	color: var(--danger, #d03050);
}

/* Key 解不开的提示行：警示色 + 让重填按钮跟文字对齐 */
.key-broken {
	display: flex;
	align-items: center;
	gap: 8px;
	color: var(--danger, #d03050);
}

.ctx-form {
	display: flex;
	flex-direction: column;
	gap: 12px;
}

.ctx-target {
	font-weight: 500;
}

.ctx-hint {
	margin: 0;
	font-size: 12px;
	line-height: 1.7;
	color: var(--muted);
}

.ctx-foot {
	display: flex;
	justify-content: flex-end;
	gap: 8px;
}
</style>
