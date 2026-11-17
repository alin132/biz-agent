<script setup>
import { NButton, NSelect, NTag, useMessage } from "naive-ui";
import { ref } from "vue";
import { agentGroupsApi } from "../api.js";
import { can } from "../access.js";
const props = defineProps({ group: Object, turn: Object });
const emit = defineEmits(["updated", "source"]);
const saving = ref("");
const message = useMessage();
const statuses = [{ label: "待处理", value: "pending" }, { label: "进行中", value: "in_progress" }, { label: "已完成", value: "done" }, { label: "已取消", value: "cancelled" }];
const owner = id => props.group.members.find(member => member.agentId === id)?.agentName ?? "待明确负责人";
async function setStatus(item, status) {
	if (saving.value) return;
	if (props.turn.status !== "completed" || props.group.groupRunning) return;
	const groupId = props.group.id, turnId = props.turn.id;
	saving.value = item.id;
	try { emit("updated", await agentGroupsApi.updateAction(groupId, { turnId, actionId: item.id, status })); }
	catch (cause) { message.error(cause.message); }
	finally { saving.value = ""; }
}
</script>

<template>
	<details class="group-results" open data-testid="group-results">
		<summary><span class="result-summary-title">第 {{ turn.sequence }} 次事项 · 决策与行动项</span><span v-if="turn.discussion.result.structured" class="result-summary-count">{{ turn.discussion.result.decisions.length }} 项决策 · {{ turn.discussion.result.actionItems.length }} 项行动</span><n-tag v-else size="tiny" type="warning">仅文本汇总</n-tag></summary>
		<p v-if="!turn.discussion.result.structured" class="result-hint">本轮未产生可核实的结构化清单，请参考主持原文，不将文本自动当作已确认任务。</p>
		<section v-if="turn.discussion.result.decisions.length" class="result-section result-decisions"><h3>决策<span class="section-count">{{ turn.discussion.result.decisions.length }}</span></h3><div v-for="item in turn.discussion.result.decisions" :key="item.id" class="result-item"><p>{{ item.content }}</p><div class="result-sources"><n-button v-for="(id,index) in item.sourceMessageIds" :key="id" text size="tiny" @click="emit('source',id)">依据 {{ index + 1 }}</n-button></div></div></section>
		<section v-if="turn.discussion.result.actionItems.length" class="result-section result-actions"><h3>行动项<span class="section-count">{{ turn.discussion.result.actionItems.length }}</span></h3><div v-for="item in turn.discussion.result.actionItems" :key="item.id" class="result-item" :data-action-id="item.id"><p>{{ item.title }}</p><div class="action-meta"><span class="action-owner">{{ owner(item.ownerAgentId) }}<span class="action-deadline">{{ item.deadline || '待明确截止日期' }}</span></span><n-select size="small" :value="item.status" :options="statuses" :disabled="!can('session.write') || turn.status !== 'completed' || group.groupRunning || Boolean(saving)" :loading="saving===item.id" aria-label="行动项状态" @update:value="setStatus(item,$event)" /></div><div class="result-sources"><n-button v-for="(id,index) in item.sourceMessageIds" :key="id" text size="tiny" @click="emit('source',id)">依据 {{ index + 1 }}</n-button></div></div></section>
		<section v-if="turn.discussion.result.unresolved.length" class="result-section result-unresolved"><h3>未决事项<span class="section-count">{{ turn.discussion.result.unresolved.length }}</span></h3><div v-for="item in turn.discussion.result.unresolved" :key="item.id" class="result-item"><p>{{ item.content }}</p><div class="result-sources"><n-button v-for="(id,index) in item.sourceMessageIds" :key="id" text size="tiny" @click="emit('source',id)">依据 {{ index + 1 }}</n-button></div></div></section>
	</details>
</template>

<style scoped>
.group-results{box-sizing:border-box;padding:16px 18px;border:1px solid var(--line);border-radius:12px;background:var(--surface);width:100%;min-width:0;font-size:13px;overflow-wrap:anywhere}
.group-results summary{display:flex;align-items:center;gap:10px;flex-wrap:wrap;cursor:pointer;font-weight:600;line-height:1.7;list-style:none}
.group-results summary::-webkit-details-marker{display:none}.group-results summary::before{content:"";width:6px;height:6px;border-right:1.5px solid var(--text-2);border-bottom:1.5px solid var(--text-2);transform:rotate(-45deg);flex-shrink:0;margin-right:3px;transition:transform .15s}.group-results[open] summary::before{transform:rotate(45deg)}.group-results summary:focus-visible{outline:2px solid var(--brand-primary);outline-offset:5px;border-radius:3px}
.result-summary-title{min-width:0}.result-summary-count{margin-left:auto;font-size:11px;font-weight:400;color:var(--text-2);font-variant-numeric:tabular-nums}
.result-section{margin-top:18px}.group-results h3{display:flex;align-items:center;gap:7px;font-size:12px;font-weight:600;margin:0;padding-bottom:8px;border-bottom:1px solid var(--line);color:var(--text-2)}.section-count{display:inline-grid;place-items:center;min-width:18px;height:18px;padding:0 4px;border-radius:5px;background:var(--surface-alt);font-size:10px;font-weight:500;font-variant-numeric:tabular-nums}
.result-decisions h3{color:var(--brand-primary)}.result-unresolved h3{color:#a46c16}.result-item{padding:12px 0;border-bottom:1px solid var(--line)}.result-item:last-child{padding-bottom:0;border-bottom:0}.result-item p{margin:0 0 7px;white-space:pre-wrap;line-height:1.75;color:var(--text)}.result-actions .result-item p{font-weight:500}.result-sources{display:flex;flex-wrap:wrap;gap:4px 12px}.result-sources :deep(.n-button){font-size:11px}
.action-meta{display:flex;align-items:center;gap:10px;justify-content:space-between;margin-bottom:7px;font-size:12px;color:var(--text-2);min-width:0}.action-owner{min-width:0;line-height:1.6}.action-deadline{display:block;color:var(--muted,var(--text-2));font-size:11px}.action-meta .n-select{width:116px;flex-shrink:0}.result-hint{margin:12px 0 0;color:var(--text-2);font-size:12px;line-height:1.7}
@media(max-width:500px){.group-results{padding:13px 12px;border-radius:9px}.group-results summary{gap:6px}.result-summary-count{margin-left:19px;width:100%}.result-section{margin-top:15px}.action-meta{align-items:flex-start;flex-wrap:wrap}.action-meta .n-select{width:108px}}
</style>
