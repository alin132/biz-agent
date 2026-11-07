<script setup>
/**
 * 技能页：卡片网格 + 分类筛选。
 *
 * 对齐 AgentOne 的「技能广场」做法——不是一张大表，而是能扫的卡片：
 * 名字、一句话说明、步骤数/工具数、内置还是自建。
 *
 * 数据来自 GET /api/skills。auto-flow（自动编排）是聊天默认模式，steps 为空、
 * 工具是整个目录，列出来只会让人困惑，所以这里按老规矩过滤掉。
 */
import { computed, onMounted, ref } from "vue";
import { NButton, NDrawer, NDrawerContent, NEmpty, NForm, NFormItem, NInput, NSpin, NTag, useDialog, useMessage } from "naive-ui";
import PageShell from "../components/PageShell.vue";
import Panel from "../components/Panel.vue";
import { can } from "../access.js";
import { skillsApi } from "../api.js";

const loading = ref(true);
const error = ref("");
const skills = ref([]);
const keyword = ref("");
const category = ref("all");

/** 自动编排：默认聊天模式，不是一条可以"用"的技能 */
const HIDDEN = new Set(["auto-flow"]);

const visible = computed(() => skills.value.filter((item) => !HIDDEN.has(item.id)));

const categories = computed(() => {
	const counts = new Map();
	for (const item of visible.value) {
		const key = item.builtin ? "builtin" : "custom";
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return [
		{ key: "all", label: `全部 ${visible.value.length}` },
		{ key: "builtin", label: `内置 ${counts.get("builtin") ?? 0}` },
		{ key: "custom", label: `自建 ${counts.get("custom") ?? 0}` },
	];
});

const filtered = computed(() => {
	const text = keyword.value.trim().toLowerCase();
	return visible.value.filter((item) => {
		if (category.value === "builtin" && !item.builtin) return false;
		if (category.value === "custom" && item.builtin) return false;
		if (text.length === 0) return true;
		const haystack = `${item.name ?? ""} ${item.description ?? item.skill?.description ?? ""}`.toLowerCase();
		return haystack.includes(text);
	});
});

/** 技能说明在哪：新接口给 skill.description，老接口可能只有顶层 description */
function descriptionOf(item) {
	return item.description || item.skill?.description || item.systemPrompt || "暂无说明";
}

/**
 * 步骤数：GET /api/skills 给的是**数字**（列表视图的汇总），
 * 而流程详情（/api/workflows/:id）给的是数组。两种形状都要吃得下。
 */
function stepCount(item) {
	if (typeof item.steps === "number") return item.steps;
	if (Array.isArray(item.steps)) return item.steps.length;
	return 0;
}

/** 工具数：列表视图直接给工具名数组；详情视图要从每步的 via 里并集出来 */
function toolCount(item) {
	if (Array.isArray(item.tools)) return item.tools.length;
	const names = new Set();
	for (const step of Array.isArray(item.steps) ? item.steps : []) {
		for (const name of step.via ?? []) names.add(name);
	}
	return names.size;
}

async function load() {
	loading.value = true;
	error.value = "";
	try {
		skills.value = await skillsApi.list();
	} catch (cause) {
		error.value = `读取技能目录失败：${cause.message}`;
	} finally {
		loading.value = false;
	}
}

/* ── 详情抽屉 / 新建 / 删除 ──────────────────────────────────────────────
 * 底层就是自定义流程的 REST：详情 GET、新建 POST、删除 DELETE（/api/workflows*）。
 * 内置技能（builtin）后端本来就会拒改删，界面上直接不给按钮，少一次注定失败的操作。 */
const message = useMessage();
const dialog = useDialog();

const detailOpen = ref(false);
const detailLoading = ref(false);
const detail = ref(null);

async function openDetail(item) {
	detailOpen.value = true;
	detailLoading.value = true;
	detail.value = null;
	try {
		detail.value = await skillsApi.detail(item.id);
	} catch (cause) {
		// 详情拉不到就把列表里的汇总信息摆出来，别让抽屉变成空白
		detail.value = { ...item, _fallback: true };
		message.warning(`详情接口读取失败，展示的是目录里的汇总信息：${cause.message}`);
	} finally {
		detailLoading.value = false;
	}
}

/** 详情抽屉里的步骤列表：详情接口给数组，目录汇总给数字（或没有） */
const detailSteps = computed(() => {
	const steps = detail.value?.steps;
	return Array.isArray(steps) ? steps : [];
});

const detailTools = computed(() => {
	if (Array.isArray(detail.value?.tools)) return detail.value.tools;
	const names = new Set();
	for (const step of detailSteps.value) {
		for (const name of step.via ?? []) names.add(name);
	}
	return [...names];
});

// 新建
const createOpen = ref(false);
const editingId = ref(null);
const editingSteps = ref([]);
const creating = ref(false);
const createForm = ref({ name: "", description: "", instructions: "" });

async function openEdit(item) {
 try { const value = await skillsApi.detail(item.id); editingId.value=item.id; editingSteps.value=value.steps??[]; createForm.value={name:value.name,description:value.skill?.description??"",instructions:value.skill?.instructions??value.systemPrompt??""};createOpen.value=true;}catch(e){message.error(e.message);}
}
function openCreate() {
 editingId.value=null;editingSteps.value=[];
	createForm.value = { name: "", description: "", instructions: "" };
	createOpen.value = true;
}

async function submitCreate() {
	const name = createForm.value.name.trim();
	if (!name) {
		message.warning("先给技能起个名字");
		return;
	}
	creating.value = true;
	try {
		// steps 留空 = 纯技能（工具交给模型自己挑）——这是后端明确支持的合法形态；
		// 但 systemPrompt 是必填字符串（workflowSpec 校验），没写指导书时给一个兜底值。
		const instructions = createForm.value.instructions.trim();
		const input = {
			name,
			systemPrompt: instructions || "你是这一技能的执行者：严格按技能指导书里的步骤做事。",
			skill: {
				description: createForm.value.description.trim(),
				instructions: createForm.value.instructions,
			},
			steps: editingSteps.value,
		};
		if(editingId.value) await skillsApi.update(editingId.value,{name:input.name,skill:input.skill}); else await skillsApi.create(input);
		message.success(`技能「${name}」已保存`);
		createOpen.value = false;
		await load();
	} catch (cause) {
		// 后端的校验文案是中文写给人看的，原样显示
		message.error(cause?.message ?? "创建失败");
	} finally {
		creating.value = false;
	}
}

// 删除
const removing = ref("");

function confirmRemove(item) {
	dialog.warning({
		title: "删除技能",
		content: `确定删除「${item.name}」？会连带删除使用它的会话，并让正在加载它的对话退出该技能。此操作不可撤销。`,
		positiveText: "删除",
		negativeText: "取消",
		onPositiveClick: async () => {
			removing.value = item.id;
			try {
				const result = await skillsApi.remove(item.id);
				const extra = result?.sessionsRemoved > 0 ? `，连带删除了 ${result.sessionsRemoved} 条会话` : "";
				message.success(`技能「${item.name}」已删除${extra}`);
				await load();
			} catch (cause) {
				message.error(cause?.message ?? "删除失败");
			} finally {
				removing.value = "";
			}
		},
	});
}

onMounted(load);
</script>

<template>
	<page-shell
		title="技能"
		subtitle="把工具与步骤组织成可复用的能力，对话时模型按需取用"
		:loading="loading"
		:error="error"
	>
		<div class="filter-bar">
			<div class="filter-chips">
				<button
					v-for="item in categories"
					:key="item.key"
					type="button"
					class="chip"
					:class="{ 'chip--active': category === item.key }"
					@click="category = item.key"
				>
					{{ item.label }}
				</button>
			</div>
			<n-input v-model:value="keyword" placeholder="搜索技能名称或说明" clearable class="filter-search" />
			<n-button v-if="can('workflow.write')" type="primary" @click="openCreate" data-testid="skill-create">＋ 新建技能</n-button>
		</div>

		<n-empty v-if="filtered.length === 0 && !loading" description="没有匹配的技能" class="empty-block" />

		<div v-else class="skill-grid">
			<article v-for="item in filtered" :key="item.id" class="skill-card">
				<div class="skill-card-head">
					<div class="skill-avatar">{{ (item.name ?? "技").slice(0, 1) }}</div>
					<div class="skill-title-wrap">
						<div class="skill-name">{{ item.name }}</div>
					</div>
					<n-tag :bordered="false" size="small" :type="item.builtin ? 'info' : 'success'">
						{{ item.builtin ? "内置" : "自建" }}
					</n-tag>
				</div>

				<p class="skill-desc">{{ descriptionOf(item) }}</p>

				<div class="skill-foot">
					<span v-if="stepCount(item) > 0">{{ stepCount(item) }} 个步骤</span>
					<span v-else>由模型自选工具</span>
					<span v-if="toolCount(item) > 0" class="skill-foot-sep">·</span>
					<span v-if="toolCount(item) > 0">{{ toolCount(item) }} 个工具</span>
				</div>
				<div class="skill-actions">
 <n-button v-if="!item.builtin && !item.readonly && can('workflow.write')" size="small" @click="openEdit(item)">编辑技能</n-button>
					<n-button size="tiny" quaternary type="primary" @click="openDetail(item)">查看详情</n-button>
					<n-button
						v-if="!item.builtin && !item.readonly && can('workflow.write')"
						size="tiny"
						quaternary
						type="error"
						:loading="removing === item.id"
						@click="confirmRemove(item)"
					>删除</n-button>
				</div>
			</article>
		</div>
		<!-- 详情抽屉：步骤/工具/技能文案一目了然 -->
		<n-drawer v-model:show="detailOpen" :width="520" data-testid="skill-detail">
			<n-drawer-content :title="detail?.name ?? '技能详情'" closable>
				<n-spin :show="detailLoading">
					<template v-if="detail">
						<p class="detail-desc">{{ detail.description || detail.skill?.description || "暂无说明" }}</p>
						<p class="detail-meta">
							<n-tag :bordered="false" size="small" :type="detail.builtin ? 'info' : 'success'">{{ detail.builtin ? "内置" : "自建" }}</n-tag>
							<span class="detail-meta-id">{{ detail.id }}</span>
						</p>
						<h4 class="detail-h4">步骤（{{ detailSteps.length }}）</h4>
						<n-empty v-if="detailSteps.length === 0" description="没有固定步骤——由模型按你的话自己挑工具" size="small" />
						<ol v-else class="detail-steps">
							<li v-for="step in detailSteps" :key="step.id" class="detail-step">
								<span class="detail-step-title">{{ step.title }}</span>
								<span class="detail-step-via">{{ (step.via ?? []).join("、") }}</span>
							</li>
						</ol>
						<h4 class="detail-h4">工具（{{ detailTools.length }}）</h4>
						<div class="detail-tools">
							<n-tag v-for="name in detailTools" :key="name" size="small" :bordered="false">{{ name }}</n-tag>
						</div>
						<template v-if="detail.skill?.instructions">
							<h4 class="detail-h4">指导书</h4>
							<pre class="detail-instructions">{{ detail.skill.instructions }}</pre>
						</template>
					</template>
				</n-spin>
			</n-drawer-content>
		</n-drawer>
		<!-- 新建抽屉：名称 + 什么时候用 + 指导书正文（步骤留空 = 纯技能，工具交给模型挑） -->
		<n-drawer v-model:show="createOpen" :width="480" data-testid="skill-create-drawer">
			<n-drawer-content :title="editingId ? '编辑技能' : '新建技能'" closable>
				<n-form label-placement="top">
					<n-form-item label="名称（必填）">
						<n-input v-model:value="createForm.name" placeholder="例如：报销助手" data-testid="skill-name-input" />
					</n-form-item>
					<n-form-item label="什么时候用它（给模型的挑选依据）">
						<n-input v-model:value="createForm.description" type="textarea" :autosize="{ minRows: 2, maxRows: 4 }" placeholder="例如：用户提到报销、发票、差旅费用时使用" />
					</n-form-item>
					<n-form-item label="指导书正文（怎么一步步做）">
						<n-input v-model:value="createForm.instructions" type="textarea" :autosize="{ minRows: 4, maxRows: 10 }" placeholder="写清楚操作顺序、注意事项、每一步用什么工具…" />
					</n-form-item>
				</n-form>
				<template #footer>
					<n-button @click="createOpen = false">取消</n-button>
					<n-button type="primary" :loading="creating" @click="submitCreate" data-testid="skill-submit">保存技能</n-button>
				</template>
			</n-drawer-content>
		</n-drawer>
	</page-shell>
</template>

<style scoped>
.filter-bar {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 16px;
	margin-bottom: 16px;
	flex-wrap: wrap;
}

.filter-chips {
	display: flex;
	gap: 8px;
}

/* 分类 chip：浅底 + 选中变主色，和 AgentOne 的工种导航一致 */
.chip {
	border: 1px solid var(--line);
	background: var(--surface);
	color: var(--text-2);
	border-radius: 999px;
	padding: 5px 14px;
	font-size: 13px;
	cursor: pointer;
	transition: all 0.15s ease;
}

.chip:hover {
	border-color: var(--brand-soft-border);
	color: var(--brand-primary);
}

.chip--active {
	background: var(--brand-soft);
	border-color: var(--brand-soft-border);
	color: var(--brand-primary);
	font-weight: 500;
}

.filter-search {
	width: 240px;
}

.skill-grid {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
	gap: 16px;
}

.skill-card {
	background: var(--surface);
	border: 1px solid var(--line);
	border-radius: var(--radius-lg);
	padding: 16px 18px 14px;
	box-shadow: var(--shadow-sm);
	transition:
		box-shadow 0.15s ease,
		transform 0.15s ease;
}

.skill-card:hover {
	box-shadow: var(--shadow);
	transform: translateY(-1px);
}

.skill-card-head {
	display: flex;
	align-items: flex-start;
	gap: 10px;
}

/* 首字母头像：和 AgentOne 的技能卡片同一手法，省掉一套图标 */
.skill-avatar {
	width: 34px;
	height: 34px;
	border-radius: 10px;
	background: var(--brand-gradient);
	color: #fff;
	display: grid;
	place-items: center;
	font-weight: 600;
	flex: 0 0 auto;
}

.skill-title-wrap {
	flex: 1;
	min-width: 0;
}

.skill-name {
	font-size: 14px;
	font-weight: 600;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}

.skill-id {
	font-size: 11px;
	color: var(--muted);
	margin-top: 2px;
}

.skill-desc {
	margin: 12px 0 0;
	font-size: 12.5px;
	line-height: 1.6;
	color: var(--text-2);
	display: -webkit-box;
	-webkit-line-clamp: 3;
	line-clamp: 3;
	-webkit-box-orient: vertical;
	overflow: hidden;
	min-height: 60px;
}

.skill-foot {
	display: flex;
	align-items: center;
	gap: 4px;
	margin-top: 12px;
	padding-top: 10px;
	border-top: 1px solid var(--line);
	font-size: 12px;
	color: var(--muted);
}

.skill-foot-sep {
	color: var(--line-strong);
}

.empty-block {
	padding: 48px 0;
}
/* 卡片操作行与详情抽屉排版 */
.skill-actions {
	display: flex;
	gap: 4px;
	margin-top: 10px;
	padding-top: 8px;
	border-top: 1px dashed var(--line);
}
.detail-desc { margin: 0 0 8px; color: var(--text-2); line-height: 1.6; }
.detail-meta { display: flex; align-items: center; gap: 8px; margin: 0 0 14px; }
.detail-meta-id { font-size: 12px; color: var(--muted); }
.detail-h4 { margin: 16px 0 8px; font-size: 13px; color: var(--text-2); }
.detail-steps { margin: 0; padding-left: 20px; display: grid; gap: 8px; }
.detail-step { display: flex; flex-direction: column; }
.detail-step-title { font-weight: 600; }
.detail-step-via { font-size: 12px; color: var(--muted); }
.detail-tools { display: flex; flex-wrap: wrap; gap: 6px; }
.detail-instructions {
	margin: 0;
	padding: 10px 12px;
	background: var(--surface-2, #f6f7fb);
	border-radius: 8px;
	white-space: pre-wrap;
	font-size: 12px;
	line-height: 1.7;
}
</style>
