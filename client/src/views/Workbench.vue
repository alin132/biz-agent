<script setup>
import { onMounted, ref, computed } from "vue";
import { useRouter } from "vue-router";
import { NAlert, NButton, NCard, NStatistic, NTag, NEmpty } from "naive-ui";
import PageShell from "../components/PageShell.vue";
import Panel from "../components/Panel.vue";
import { healthApi, agentsApi, kbApi, modelsApi, http, approvalsApi } from "../api.js";
import { can } from "../access.js";
const router = useRouter();
const loading = ref(true), error = ref(""), health = ref(null), agents = ref([]), sessions = ref([]), kbs = ref([]), models = ref(null), pending = ref(null);
const current = computed(() => {
 const row = models.value?.models?.find(item => item.modelId === models.value.current || item.id === models.value.current);
 return row?.name || row?.modelId || (health.value?.model?.mode === "simulated" ? "模拟模型" : health.value?.model?.label || "未选择");
});
function openSession(item) { router.push({ name: item.agentId ? "agent-chat" : "chat", ...(item.agentId ? { params: { id: item.agentId } } : {}), query: { session: item.id } }); }
async function load() {
 loading.value=true; error.value="";
 const tasks=[healthApi.get(),agentsApi.list(),http.get("/api/sessions"),kbApi.list(),modelsApi.list(),can("session.read")?approvalsApi.list():Promise.resolve(null)];
 const results=await Promise.allSettled(tasks); const refs=[health,agents,sessions,kbs,models,pending];
 const labels=["运行状态","Agent","会话","知识库","模型","审批"];
 results.forEach((r,i)=>{ if(r.status==="fulfilled") refs[i].value=r.value; else error.value += `${labels[i]}：${r.reason.message}；`; }); loading.value=false;
}
onMounted(load);
</script>
<template>
 <PageShell title="工作台" subtitle="从最近的工作继续，或选择一个智能体开始新任务" :loading="loading" :error="error">
  <template #actions><n-button @click="load">刷新</n-button><n-button type="primary" @click="router.push({name:'agents'})">选择 Agent</n-button></template>
  <div class="stat-grid">
   <n-card class="stat-card"><n-statistic label="可用 Agent" :value="agents.filter(a=>a.status!=='stopped').length" /><p class="hint">共 {{ agents.length }} 个智能体</p></n-card>
   <n-card class="stat-card"><n-statistic label="待处理审批" :value="pending?.length ?? '—'" /><n-button text type="primary" @click="router.push({name:'approvals'})">前往审批中心 →</n-button></n-card>
   <n-card class="stat-card"><n-statistic label="知识库" :value="kbs.length" /><p class="hint">共 {{ kbs.reduce((n,k)=>n+(k.docCount??0),0) }} 份文档</p></n-card>
   <n-card class="stat-card"><n-statistic label="当前模型" :value="current" /><p class="hint">{{ health?.model?.mode==='simulated' ? '当前使用模拟模型，未调用真实供应商' : '用于新建的通用会话' }}</p></n-card>
  </div>
  <div class="section-grid">
   <Panel title="最近对话"><n-empty v-if="!sessions.length" description="还没有对话" class="empty-state" /><div v-for="item in sessions.slice(0,6)" :key="item.id" class="recent-row"><button @click="openSession(item)">{{ item.title || item.transcript?.find(m=>m.role==='user')?.text?.slice(0,40) || item.agentName || '未命名对话' }}</button><span class="secondary">{{ item.agentName || '通用对话' }}</span></div><n-button text type="primary" @click="router.push({name:'chat'})">查看通用对话 →</n-button></Panel>
   <Panel title="可用智能体"><n-empty v-if="!agents.length" description="先创建一个业务智能体" class="empty-state" /><div v-for="item in agents.filter(a=>a.status!=='stopped').slice(0,4)" :key="item.id" class="recent-row"><button @click="router.push({name:'agent-chat',params:{id:item.id}})">{{ item.name }}</button><span class="secondary">{{ item.description || '暂无简介' }}</span></div><n-button text type="primary" @click="router.push({name:'agents'})">管理 Agent →</n-button></Panel>
  </div>
  <details class="environment"><summary>工作空间运行信息</summary><p class="hint">存储：{{ health?.storage?.kind || '—' }} · 会话：{{ health?.sessions ?? '—' }} · {{ health?.auth==='required'?'已开启登录验证':'免登录演示模式' }}</p><n-button text @click="router.push({name:'settings'})">打开设置</n-button></details>
 </PageShell>
</template>
<style scoped>
.stat-grid { display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px; }
.stat-card :deep(.n-statistic-value__content) { font-size:24px;overflow-wrap:anywhere; }
.recent-row { padding:14px 0;border-bottom:1px solid var(--line);display:grid;gap:5px; }
.recent-row button { text-align:left;border:0;background:none;color:var(--text);cursor:pointer;font-weight:500; }
.environment { margin-top:24px;padding:16px;border:1px solid var(--line);border-radius:12px; }
.environment summary {cursor:pointer;color:var(--text-2);}
@media(max-width:1100px){.stat-grid{grid-template-columns:repeat(2,minmax(0,1fr));}}
@media(max-width:540px){.stat-grid{grid-template-columns:minmax(0,1fr);}}
</style>
