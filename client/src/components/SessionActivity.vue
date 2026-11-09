<script setup>
import { NButton, NTag, useMessage } from "naive-ui";
import { useRouter } from "vue-router";
import { approvalsApi } from "../api.js";
import { can } from "../access.js";
import { knowledgeSourcesOf } from "../knowledgeSources.js";
import { ref } from "vue";

const props = defineProps({ sessionId: String, turn: { type: Object, required: true }, pending: { type: Array, default: () => [] }, elapsedMs: { type: Number, default: 0 }, running: Boolean });
const emit = defineEmits(["resolved"]);
const busy = ref(false), message = useMessage(), router = useRouter();
function durationText(ms) { const seconds = Math.max(0, Math.floor(ms / 1000)); return seconds < 60 ? `${(ms / 1000).toFixed(1)} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`; }
function openSource(source) { void router.push({ name: "knowledge", query: { kbId: source.kbId, docId: source.docId, chunkId: source.chunkId } }); }
async function decide(item, approved) {
	busy.value = true;
	try { await approvalsApi.decide(props.sessionId, item.requestId, approved); emit("resolved", item.requestId); message.success(approved ? "已批准" : "已拒绝"); }
	catch (error) { if (error.status === 409) { message.warning("这条审批已被处理"); emit("resolved", item.requestId); } else message.error(error.message); }
	finally { busy.value = false; }
}
</script>

<template>
	<div v-if="turn.startedAt || turn.durationMs > 0" class="turn-timing" data-testid="task-timing">
		<details :open="running">
			<summary><span>{{ running ? "本轮用时" : "用时" }} {{ durationText(elapsedMs) }}</span><span class="timing-chevron">⌄</span></summary>
			<div v-if="turn.tools?.length" class="turn-tools">
				<details v-for="tool in turn.tools" :key="tool.id" class="tool-call">
					<summary><span>{{ tool.name }}</span><n-tag size="small" :type="tool.running ? 'info' : tool.ok === false ? 'error' : 'success'">{{ tool.running ? "执行中" : tool.ok === false ? "失败" : "完成" }}</n-tag><small v-if="tool.durationMs != null">{{ durationText(tool.durationMs) }}</small></summary>
					<div class="tool-call-name">参数</div><pre class="json-view">{{ JSON.stringify(tool.args ?? {}, null, 2) }}</pre>
					<div class="tool-call-name">结果</div><pre class="json-view">{{ tool.result || (tool.running ? "等待结果…" : "无结果") }}</pre>
					<div v-if="tool.name === 'kb_search' && knowledgeSourcesOf(tool.result).length" class="source-links">
						<button v-for="source in knowledgeSourcesOf(tool.result)" :key="source.marker" type="button" @click="openSource(source)">查看来源 {{ source.chunkId }}</button>
					</div>
				</details>
			</div>
		</details>
	</div>
	<section v-for="item in pending" :key="item.requestId" class="approval-card"><b>需要人工确认：{{ item.toolName }}</b><pre class="json-view">{{ JSON.stringify(item.args, null, 2) }}</pre><div v-if="can('session.run')" class="action-row"><n-button :loading="busy" @click="decide(item, false)">拒绝本次操作</n-button><n-button type="primary" :loading="busy" @click="decide(item, true)">批准并继续</n-button></div><p v-else class="hint">当前账号无权处理审批。</p></section>
</template>

<style scoped>
.turn-timing { width: min(100%, 800px); color: var(--muted); font-size: 13px; }
.turn-timing>details>summary { display: flex; align-items: center; gap: 8px; cursor: pointer; list-style: none; padding-bottom: 8px; border-bottom: 1px solid var(--line); }
.turn-timing>details>summary::-webkit-details-marker { display: none; }
.timing-chevron { font-size: 16px; }
.turn-tools { margin: 8px 0 4px 8px; padding-left: 12px; border-left: 1px solid var(--line); }
.tool-call { padding: 8px 0; border-bottom: 1px solid var(--line); }
.tool-call>summary { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.tool-call>summary small { margin-left: auto; font-variant-numeric: tabular-nums; }
.tool-call-name { margin: 7px 0 3px; font-size: 12px; }
.json-view { max-width: 100%; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
.source-links { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.source-links button { border: 0; padding: 3px 0; background: none; color: var(--primary); font: inherit; font-size: 12px; text-decoration: underline; cursor: pointer; }
.approval-card { padding: 16px; border: 1px solid #f6d38a; background: var(--warning-soft); border-radius: 8px; margin: 10px 0; }
</style>
