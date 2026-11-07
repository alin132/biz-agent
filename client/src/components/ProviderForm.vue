<script setup>
/**
 * 供应商表单弹窗：新建与编辑共用一套字段，删除确认也在组件里（ModelForm 同款拆法）。
 *
 * 为什么单独拆一个组件：Models.vue 是共享文件，模型那半由别人同时在改；
 * 把供应商的表单收进来，Models.vue 里只剩「入口按钮 + 传 props」，两边互不覆盖。
 *
 * API Key 的安全语义（与后端约定对齐，别按直觉改）：
 *  - 出参永远只有掩码 apiKeyMasked，明文只在创建那一刻出现一次；
 *  - 编辑时 Key 输入框**留空 = 不改**，填了 = 替换（后端 PATCH 的语义）；
 *  - 密文解不开时出参带 apiKeyBroken:true、掩码是「（无法解密，请重新填写）」——
 *    判断要不要提示重填 Key 只看 apiKeyBroken 这个布尔，**不要匹配中文占位串**。
 */
import { computed, ref, watch } from "vue";
import { NButton, NInput, NModal, NSelect, NSwitch, useMessage } from "naive-ui";
import { providersApi } from "../api.js";

const props = defineProps({
	/** 弹窗开关（v-model:show 语义，父组件写回） */
	show: { type: Boolean, default: false },
	/** 传 null = 新建；传供应商记录 = 编辑它 */
	provider: { type: Object, default: null },
});

const emit = defineEmits(["update:show", "saved"]);

const message = useMessage();
const saving = ref(false);

const name = ref("");
const kind = ref("deepseek");
const baseUrl = ref("");
const apiKey = ref("");
const enabled = ref(true);

const isEdit = computed(() => props.provider !== null && props.provider !== undefined);
const title = computed(() => (isEdit.value ? "编辑供应商" : "新建供应商"));

const kindOptions = [
	{ label: "DeepSeek", value: "deepseek" },
	{ label: "OpenAI 兼容", value: "openai" },
	{ label: "Ollama（本地）", value: "ollama" },
	{ label: "自定义（填 Base URL）", value: "custom" },
];

/** 编辑时 Key 框上方的现状说明：掩码原样展示， broken 时另给一句显眼的提示 */
const keyStatus = computed(() => {
	const row = props.provider;
	if (!row) return "";
	if (row.apiKeyBroken) return "Key 密文解不开（多半是换了部署密钥），下面的框里重新填一次就能修好。";
	return row.apiKeyMasked ? `当前 Key：${row.apiKeyMasked}` : "还没有配置 Key。";
});

/**
 * 打开时灌初值。watch 而不是父组件手动 reset：新建与编辑共用同一个弹窗实例，
 * 不重置会把上一条的值带进来（保存后才发现改错了对象）。
 */
watch(
	() => [props.show, props.provider],
	([open]) => {
		if (!open) return;
		const row = props.provider;
		if (row) {
			name.value = row.name ?? "";
			kind.value = row.kind ?? "custom";
			baseUrl.value = row.baseUrl ?? "";
			enabled.value = row.enabled !== false;
			// Key 永远从空开始：留空 = 不改，这是 PATCH 的约定，不是偷懒
			apiKey.value = "";
		} else {
			name.value = "";
			kind.value = "deepseek";
			baseUrl.value = "";
			apiKey.value = "";
			enabled.value = true;
		}
	},
	{ immediate: true },
);

function close() {
	emit("update:show", false);
}

async function save() {
	if (name.value.trim().length === 0) {
		message.warning("供应商名称必填。");
		return;
	}
	saving.value = true;
	try {
		// Key 只在真的填了东西时才进 payload：空串会被后端当成"清空 Key"处理吗？不会——
		// PATCH 只认「key in body」，这里不带 apiKey 字段就是"不改"，语义最稳。
		const payload = {
			name: name.value.trim(),
			kind: kind.value,
			baseUrl: baseUrl.value.trim() || null,
			enabled: enabled.value,
		};
		const keyValue = apiKey.value.trim();
		if (keyValue.length > 0) payload.apiKey = keyValue;
		const saved = isEdit.value
			? await providersApi.patch(props.provider.id, payload)
			: await providersApi.create(payload);
		message.success(`${isEdit.value ? "已保存" : "已新建"}供应商「${saved?.name || name.value.trim()}」`);
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
		data-testid="provider-form"
		@update:show="(value) => emit('update:show', value)"
	>
		<div class="form-grid">
			<label class="field">
				<span class="field-label">名称<span class="required">*</span></span>
				<n-input
					v-model:value="name"
					data-testid="provider-form-name"
					placeholder="例如：DeepSeek 官方"
				/>
			</label>

			<label class="field">
				<span class="field-label">类型</span>
				<n-select v-model:value="kind" :options="kindOptions" data-testid="provider-form-kind" />
			</label>

			<label class="field">
				<span class="field-label">Base URL</span>
				<n-input
					v-model:value="baseUrl"
					data-testid="provider-form-base-url"
					placeholder="自定义网关才需要填，例如 https://api.openai.com/v1"
				/>
			</label>

			<label class="field">
				<span class="field-label">API Key</span>
				<p v-if="keyStatus" class="key-status" :class="{ 'key-status--broken': provider?.apiKeyBroken }" data-testid="provider-form-key-status">
					{{ keyStatus }}
				</p>
				<n-input
					v-model:value="apiKey"
					type="password"
					show-password-on="click"
					data-testid="provider-form-api-key"
					:placeholder="isEdit ? '留空 = 保持不变；填了 = 替换' : 'sk- 开头的密钥；明文只在保存前可见，之后只剩掩码'"
				/>
			</label>

			<label class="field field--inline">
				<span class="field-label">启用</span>
				<n-switch v-model:value="enabled" data-testid="provider-form-enabled" />
			</label>
		</div>

		<p class="form-hint">
			停用的供应商下的模型不再参与对话；删除供应商会连带删掉它名下所有模型，页面上会再跟你确认一次。
		</p>

		<template #footer>
			<div class="form-foot">
				<n-button data-testid="provider-form-cancel" @click="close">取消</n-button>
				<n-button type="primary" data-testid="provider-form-save" :loading="saving" @click="save">
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

/* Key 现状：普通掩码低调展示；解不开的要用警示色让人一眼看见 */
.key-status {
	margin: 0;
	font-size: 12px;
	color: var(--muted);
}

.key-status--broken {
	color: var(--danger, #d03050);
	font-weight: 500;
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
