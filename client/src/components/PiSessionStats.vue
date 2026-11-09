<script setup>
import { NDescriptions, NDescriptionsItem, NDrawer, NDrawerContent } from "naive-ui";
import { formatTokens } from "../contextUsage.ts";

defineProps({
	show: { type: Boolean, default: false },
	stats: { type: Object, default: null },
});
const emit = defineEmits(["update:show"]);
</script>

<template>
	<n-drawer :show="show" placement="right" :width="420" @update:show="emit('update:show', $event)">
		<n-drawer-content title="Pi 会话统计" closable>
			<n-descriptions v-if="stats" :column="1" bordered size="small">
				<n-descriptions-item label="用户消息">{{ stats.userMessages }}</n-descriptions-item>
				<n-descriptions-item label="助手回复">{{ stats.assistantMessages }}</n-descriptions-item>
				<n-descriptions-item label="工具调用">{{ stats.toolCalls }}</n-descriptions-item>
				<n-descriptions-item label="工具结果">{{ stats.toolResults }}</n-descriptions-item>
				<n-descriptions-item label="输入 Token">{{ formatTokens(stats.tokens?.input ?? 0) }}</n-descriptions-item>
				<n-descriptions-item label="输出 Token">{{ formatTokens(stats.tokens?.output ?? 0) }}</n-descriptions-item>
				<n-descriptions-item label="缓存读取">{{ formatTokens(stats.tokens?.cacheRead ?? 0) }}</n-descriptions-item>
				<n-descriptions-item label="缓存写入">{{ formatTokens(stats.tokens?.cacheWrite ?? 0) }}</n-descriptions-item>
				<n-descriptions-item label="累计 Token">{{ formatTokens(stats.tokens?.total ?? 0) }}</n-descriptions-item>
				<n-descriptions-item label="费用">${{ Number(stats.cost ?? 0).toFixed(6) }}</n-descriptions-item>
			</n-descriptions>
		</n-drawer-content>
	</n-drawer>
</template>
