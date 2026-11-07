<script setup>
/**
 * 模型表单弹窗：新建与编辑共用一套字段。
 *
 * 为什么单独拆一个组件：Models.vue 是共享文件，供应商那一半由别人同时在改；
 * 把表单收进来，Models.vue 里只剩「入口按钮 + 传 props」，两边就不容易互相覆盖。
 *
 * 几条与后端约定对齐的事实（别按直觉改）：
 *  - `modelId` 是发给供应商的真实模型名（如 deepseek-chat），不是库里的内部 id；
 *  - `contextWindow` 后端只接受正整数或 null，**越界是钳制不是报错**，所以保存后一律
 *    以后端返回的记录为准回显，不能拿表单里填的值当真；
 *  - 编辑时 `modelId` 可改（PATCH 支持），改完等于换了个模型，页面要刷新列表；
 *  - 空 `name` 后端会回落成 `modelId`，所以显示名留空是合法的（占位文案要写清楚）。
 */
import { computed, ref, watch } from "vue";
import { NButton, NInput, NInputNumber, NModal, NSelect, NSwitch, useMessage } from "naive-ui";
import { modelsApi } from "../api.js";

const props = defineProps({
	/** 弹窗开关（v-model:show 语义，父组件写回） */
	show: { type: Boolean, default: false },
	/** 传 null = 新建；传模型记录 = 编辑它 */
	model: { type: Object, default: null },
	/** 供应商下拉可选项：父组件已经把 { id, name } 备好，这里不再拉一次接口 */
	providers: { type: Array, default: () => [] },
});

const emit = defineEmits(["update:show", "saved"]);

const message = useMessage();
const saving = ref(false);

const providerId = ref("");
const modelId = ref("");
const name = ref("");
const kind = ref("chat");
const enabled = ref(true);
/** 最大上下文用字符串存：number 类型在 naive 的 input-number 里没法表达「留空」 */
const contextWindow = ref(null);

const isEdit = computed(() => props.model !== null && props.model !== undefined);
const title = computed(() => (isEdit.value ? "编辑模型" : "新建模型"));

const kindOptions = [
	{ label: "对话（chat）", value: "chat" },
	{ label: "向量（embedding）", value: "embedding" },
];

const providerOptions = computed(() =>
	props.providers.map((item) => ({
		label: item.enabled === false ? `${item.name}（已停用）` : item.name,
		value: item.id,
	})),
);

/**
 * 打开时灌初值。
 * 用 watch 而不是在父组件里手动 reset：编辑与新建都走同一个弹窗实例，
 * 不重置就会把上一条模型的值带进来（保存后才发现改错了对象）。
 */
watch(
	() => [props.show, props.model],
	([open]) => {
		if (!open) return;
		const row = props.model;
		if (row) {
			providerId.value = row.providerId ?? "";
			modelId.value = row.modelId ?? "";
			name.value = row.name ?? "";
			kind.value = row.kind ?? "chat";
			enabled.value = row.enabled !== false;
			contextWindow.value = typeof row.contextWindow === "number" ? row.contextWindow : null;
		} else {
			// 新建的默认供应商：第一条可用的（通常是 default），省掉一次必选点击
			const first = props.providers.find((item) => item.enabled !== false);
			providerId.value = first?.id ?? "";
			modelId.value = "";
			name.value = "";
			kind.value = "chat";
			enabled.value = true;
			contextWindow.value = null;
		}
	},
	{ immediate: true },
);

function close() {
	emit("update:show", false);
}

async function save() {
	if (providerId.value.length === 0) {
		message.warning("先选一个供应商。");
		return;
	}
	if (modelId.value.trim().length === 0) {
		message.warning("「模型 ID」必填，填供应商那边的真实模型名（例如 deepseek-chat）。");
		return;
	}
	saving.value = true;
	try {
		const payload = {
			providerId: providerId.value,
			modelId: modelId.value.trim(),
			name: name.value.trim(),
			kind: kind.value,
			enabled: enabled.value,
			contextWindow: contextWindow.value,
		};
		const saved = isEdit.value
			? await modelsApi.patch(props.model.id, payload)
			: await modelsApi.create(payload);
		// 一切以后端返回的记录为准：小数会被截断、显示名留空会回落成 modelId，
		// 处这两个值的是后端，界面上照抄表单里的值就会跟列表对不上。
		const storedContext = saved?.contextWindow;
		const adjusted =
			typeof storedContext === "number" &&
			contextWindow.value !== null &&
			storedContext !== contextWindow.value;
		const label = `${isEdit.value ? "已保存" : "已新建"}「${saved?.name || saved?.modelId}」`;
		message.success(
			adjusted
				? `${label}；最大上下文按后端规则取整为 ${storedContext}`
				: label,
		);
		emit("saved", saved);
		close();
	} catch (cause) {
		message.error(cause.message);
	} finally {
		saving.value = false;
	}
}
</script>

<template>
	<n-modal
		:show="show"
		preset="card"
		:title="title"
		:style="{ maxWidth: '520px' }"
		data-testid="model-form"
		@update:show="(value) => emit('update:show', value)"
	>
		<div class="form-grid">
			<label class="field">
				<span class="field-label">供应商</span>
				<n-select
					v-model:value="providerId"
					:options="providerOptions"
					data-testid="model-form-provider"
					placeholder="选一个供应商"
				/>
			</label>

			<label class="field">
				<span class="field-label">模型 ID<span class="required">*</span></span>
				<n-input
					v-model:value="modelId"
					data-testid="model-form-model-id"
					placeholder="供应商那边的真实模型名，例如 deepseek-chat"
				/>
			</label>

			<label class="field">
				<span class="field-label">显示名</span>
				<n-input
					v-model:value="name"
					data-testid="model-form-name"
					placeholder="留空则用模型 ID 当显示名"
				/>
			</label>

			<label class="field">
				<span class="field-label">类型</span>
				<n-select v-model:value="kind" :options="kindOptions" data-testid="model-form-kind" />
			</label>

			<label class="field">
				<span class="field-label">最大上下文（token）</span>
				<n-input-number
					v-model:value="contextWindow"
					data-testid="model-form-context"
					placeholder="例如 131072；留空表示未配置"
					:min="1"
					:show-button="false"
					style="width: 100%"
				/>
			</label>

			<label class="field field--inline">
				<span class="field-label">启用</span>
				<n-switch v-model:value="enabled" data-testid="model-form-enabled" />
			</label>
		</div>

		<p class="form-hint">
			模型 ID 与显示名是两件事：ID 要跟供应商文档一致，显示名只影响这个页面上的称呼。
			停用后这条模型不再出现在对话的可选列表里，但配置留着，随时可以再启用。
		</p>

		<template #footer>
			<div class="form-foot">
				<n-button data-testid="model-form-cancel" @click="close">取消</n-button>
				<n-button type="primary" data-testid="model-form-save" :loading="saving" @click="save">
					{{ isEdit ? "保存" : "新建" }}
				</n-button>
			</div>
		</template>
	</n-modal>
</template>

<style scoped>
.form-grid {
	display: flex;
	flex-direction: column;
	gap: 14px;
}

.field {
	display: flex;
	flex-direction: column;
	gap: 6px;
}

.field--inline {
	flex-direction: row;
	align-items: center;
	justify-content: space-between;
}

.field-label {
	font-size: 13px;
	font-weight: 500;
}

.required {
	color: var(--danger, #d03050);
	margin-left: 2px;
}

.form-hint {
	margin: 14px 0 0;
	font-size: 12px;
	line-height: 1.7;
	color: var(--muted);
}

.form-foot {
	display: flex;
	justify-content: flex-end;
	gap: 8px;
}
</style>
