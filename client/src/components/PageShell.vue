<script setup>
/**
 * 模块页骨架：标题 + 说明 + 右侧主操作 + 错误/加载态。
 *
 * 为什么抽出来：八个模块页如果各写一遍页头，字号/间距/错误条必然慢慢长歪。
 * 这里只负责"容器与状态"，内容用默认插槽塞。
 */
import { NAlert, NButton, NSpin } from "naive-ui";

defineProps({
	title: { type: String, required: true },
	subtitle: { type: String, default: "" },
	/** 主操作按钮文案；不传就不显示按钮 */
	action: { type: String, default: "" },
	/** 主操作是否在请求中 */
	actionLoading: { type: Boolean, default: false },
	loading: { type: Boolean, default: false },
	wide: { type: Boolean, default: false },
	/** 加载失败的中文原因；有值就显示错误条 */
	error: { type: String, default: "" },
});

const emit = defineEmits(["action"]);
</script>

<template>
	<div class="page" :class="{ 'page--wide': wide }">
		<header class="page-head">
			<div>
				<h1 class="page-title">{{ title }}</h1>
				<p v-if="subtitle" class="page-sub">{{ subtitle }}</p>
			</div>
			<div class="page-head-actions">
				<slot name="actions" />
				<n-button v-if="action" type="primary" :loading="actionLoading" @click="emit('action')">
					{{ action }}
				</n-button>
			</div>
		</header>

		<n-alert v-if="error" type="error" :bordered="false" class="page-alert">{{ error }}</n-alert>

		<n-spin :show="loading">
			<slot />
		</n-spin>
	</div>
</template>

<style scoped>
.page-head-actions {
	display: flex;
	align-items: center;
	gap: 8px;
}
</style>
