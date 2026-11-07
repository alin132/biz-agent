<script setup>
import { computed } from "vue";
import { useMessage } from "naive-ui";
import "../../../web/markdown.js";
const props = defineProps({ text: { type: String, default: "" }, markdown: { type: Boolean, default: true } });
const message = useMessage();
const html = computed(() => window.renderMarkdown(props.text));
async function copy(text) {
	try { await navigator.clipboard.writeText(text); message.success("已复制"); }
	catch { message.error("复制失败，请手动选择文本复制"); }
}
function click(event) {
	const button = event.target.closest('[data-role="copy-code"]');
	if (button) void copy(button.closest(".code-block")?.querySelector("code")?.textContent ?? "");
}
</script>
<template>
	<div class="message-content">
		<div v-if="markdown" class="markdown-body" v-html="html" @click="click" />
		<div v-else class="plain-message">{{ text }}</div>
		<button v-if="text" class="message-copy" type="button" aria-label="复制消息" @click="copy(text)">复制</button>
	</div>
</template>
