<script setup>
import { computed, ref, watch } from "vue";
import { NAlert, NButton, NDrawer, NDrawerContent, NEmpty, NInput, NSpin, NTag, NTree, useMessage } from "naive-ui";
import { sessionApi } from "../api.js";

const props = defineProps({ show: Boolean, sessionId: String, canNavigate: Boolean, canFork: Boolean });
const emit = defineEmits(["update:show", "navigate", "fork"]);
const message = useMessage();
const loading = ref(false);
const tree = ref({ leafId: null, nodes: [] });
const selectedId = ref(null);
const labelDraft = ref("");
const savingLabel = ref(false);
const navigating = ref(false);
const forking = ref(false);
const selected = computed(() => findNode(tree.value.nodes, selectedId.value));
const expandedKeys = computed(() => activeAncestorIds(tree.value.nodes));

function findNode(nodes, id) {
	for (const node of nodes) {
		if (node.id === id) return node;
		const nested = findNode(node.children ?? [], id);
		if (nested) return nested;
	}
	return null;
}

function activeLeafId(nodes) {
	let leaf = null;
	for (const node of nodes) {
		if (!node.active) continue;
		leaf = activeLeafId(node.children ?? []) ?? node.id;
	}
	return leaf;
}

function activeAncestorIds(nodes, ancestors = [], result = []) {
	for (const node of nodes) {
		const path = [...ancestors, node.id];
		if (node.active) result.push(...path);
		activeAncestorIds(node.children ?? [], path, result);
	}
	return [...new Set(result)];
}

function treeData(nodes) {
	return nodes.map((node) => ({
		key: node.id,
		label: `${node.active ? "● 当前分支 · " : ""}${node.label}${node.preview ? ` · ${node.preview}` : ""}`,
		children: treeData(node.children ?? []),
	}));
}

const items = computed(() => treeData(tree.value.nodes));

async function load() {
	if (!props.sessionId) return;
	loading.value = true;
	try {
		tree.value = await sessionApi.piTree(props.sessionId);
		selectedId.value = activeLeafId(tree.value.nodes);
		labelDraft.value = findNode(tree.value.nodes, selectedId.value)?.bookmark ?? "";
	} catch (cause) {
		message.error(cause?.message ?? "读取 Pi 会话树失败");
	} finally {
		loading.value = false;
	}
}

function onSelect(keys) {
	selectedId.value = keys[0] ?? null;
	labelDraft.value = selected.value?.bookmark ?? "";
}

async function saveLabel() {
	if (!props.sessionId || !selected.value || savingLabel.value) return;
	savingLabel.value = true;
	try {
		tree.value = await sessionApi.setPiTreeLabel(props.sessionId, selected.value.id, labelDraft.value.trim() || null);
		labelDraft.value = findNode(tree.value.nodes, selectedId.value)?.bookmark ?? "";
		message.success(labelDraft.value ? "标签已保存" : "标签已清除");
	} catch (cause) {
		message.error(cause?.message ?? "保存标签失败");
	} finally {
		savingLabel.value = false;
	}
}

async function continueFromSelected() {
	if (!props.sessionId || !selected.value || !props.canNavigate || navigating.value) return;
	navigating.value = true;
	try {
		const result = await sessionApi.navigatePiTree(props.sessionId, selected.value.id);
		tree.value = result.tree;
		selectedId.value = activeLeafId(result.tree.nodes);
		emit("navigate", result);
		emit("update:show", false);
		message.success("已切换到所选 Pi 分支");
	} catch (cause) {
		message.error(cause?.message ?? "切换 Pi 分支失败");
	} finally {
		navigating.value = false;
	}
}

async function forkFromSelected() {
	if (!props.sessionId || !selected.value || selected.value.type !== "message" || selected.value.label !== "用户" || !props.canFork || forking.value) return;
	forking.value = true;
	try {
		const result = await sessionApi.fork(props.sessionId, selected.value.id);
		emit("fork", result);
		emit("update:show", false);
		message.success("已从此消息创建独立对话");
	} catch (cause) {
		message.error(cause?.message ?? "创建 Pi 分支失败");
	} finally {
		forking.value = false;
	}
}

watch(() => [props.show, props.sessionId], ([show]) => {
	if (show) void load();
});
</script>

<template>
	<n-drawer :show="show" placement="right" :width="560" @update:show="emit('update:show', $event)">
		<n-drawer-content title="Pi 会话树" closable>
			<div class="pi-tree-meta">
				<span>{{ tree.nodes.length }} 个根节点</span>
				<n-tag size="small" type="info">当前分支已标记</n-tag>
			</div>
			<n-spin :show="loading">
				<n-empty v-if="!items.length" description="当前会话还没有 Pi 历史节点" />
				<n-tree
					v-else
					:data="items"
					:default-expanded-keys="expandedKeys"
					:selected-keys="selectedId ? [selectedId] : []"
					:block-line="true"
					:selectable="true"
					@update:selected-keys="onSelect"
				/>
			</n-spin>
			<section v-if="selected" class="pi-tree-entry">
				<header>
					<strong>{{ selected.label }}</strong>
					<n-tag size="tiny" :type="selected.active ? 'success' : 'default'">{{ selected.active ? "当前分支" : selected.type }}</n-tag>
					<n-tag v-if="selected.bookmark" size="tiny" type="warning">{{ selected.bookmark }}</n-tag>
				</header>
				<time>{{ new Date(selected.timestamp).toLocaleString() }}</time>
				<p>{{ selected.preview || "此节点没有可显示的文本预览" }}</p>
				<div class="pi-tree-label-editor">
					<n-input v-model:value="labelDraft" size="small" maxlength="80" show-count placeholder="添加 Pi 会话标签" @keydown.enter.prevent="saveLabel" />
					<n-button size="small" :loading="savingLabel" @click="saveLabel">保存标签</n-button>
				</div>
				<n-alert v-if="!canNavigate" class="pi-tree-limit" type="info" :bordered="false">对话正在执行或等待审批，暂时不能切换分支</n-alert>
				<n-button v-if="canNavigate" class="pi-tree-continue" type="primary" :loading="navigating" @click="continueFromSelected">从此处继续</n-button>
				<n-button v-if="canFork && selected.type === 'message' && selected.label === '用户'" class="pi-tree-continue" :loading="forking" @click="forkFromSelected">从此消息分叉</n-button>
			</section>
			<template #footer><n-button @click="emit('update:show', false)">关闭</n-button></template>
		</n-drawer-content>
	</n-drawer>
</template>

<style scoped>
.pi-tree-meta { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; color: var(--text-2); font-size: 12px; }
.pi-tree-entry { margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--line); }
.pi-tree-entry header { display: flex; align-items: center; gap: 8px; }
.pi-tree-entry time { display: block; margin-top: 8px; color: var(--text-2); font-size: 12px; }
.pi-tree-entry p { margin: 8px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.55; }
.pi-tree-label-editor { display: flex; align-items: center; gap: 8px; margin-top: 12px; }
.pi-tree-limit, .pi-tree-continue { margin-top: 12px; }
</style>
