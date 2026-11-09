<script setup>
/**
 * 知识库页 —— 按 AgentOne 的两栏布局：左边库列表，右边库详情。
 *
 * 布局要点（对齐 AgentOne）：
 *   - 左栏是窄卡片列表，选中项用靛蓝浅底 + 左侧高亮；
 *   - 右栏顶部是库名 + 两个大数字（文档 / 分块），下面是「配置概要」一行；
 *   - 再往下是拖拽上传区（虚线框），最后是文档列表。
 *
 * 数据全部来自真接口：/api/kb、/api/kb/:id/documents、/api/kb/embedding。
 * 没有库时显示一张"能直接动手"的空态卡，而不是一句"暂无数据"。
 */
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
	NAlert,
	NButton,
	NEmpty,
	NInput,
	NModal,
	NSpin,
	NTag,
	useMessage,
 useDialog,
} from "naive-ui";
import { can } from "../access.js";
import { kbApi } from "../api.js";

const message = useMessage();
const dialog = useDialog();
const route = useRoute();
const router = useRouter();
let selectionSeq=0, searchSeq=0;
const activeTab=ref("documents"), query=ref(""), searchResult=ref(null), searching=ref(false), settingsBusy=ref(false);
const sourceChunkId = ref("");
async function search(){if(!query.value.trim())return;const id=activeId.value,seq=++searchSeq;searching.value=true;try{const result=await kbApi.search(id,{query:query.value.trim()});if(id===activeId.value&&seq===searchSeq)searchResult.value=result;}catch(e){if(seq===searchSeq)message.error(e.message);}finally{if(seq===searchSeq)searching.value=false;}}
function openSearchSource(result) { void router.push({ name: "knowledge", query: { kbId: result.kbId, docId: result.docId, chunkId: String(result.chunkId) } }); }
async function setDefault(){const id=activeId.value,wasDefault=activeBase.value.isDefault;settingsBusy.value=true;try{const current=await kbApi.defaults();const ids=new Set(current.kbIds??[]);if(wasDefault)ids.delete(id);else ids.add(id);await kbApi.setDefaults([...ids]);await loadBases();message.success("默认检索范围已更新");}catch(e){message.error(e.message);}finally{settingsBusy.value=false;}}
async function reindex(){const id=activeId.value;settingsBusy.value=true;try{await kbApi.reindex(id);if(activeId.value===id)await selectBase(id);await loadBases();message.success("向量已重新计算");}catch(e){message.error(e.message);}finally{settingsBusy.value=false;}}
function removeDoc(doc){dialog.warning({title:"删除文档",content:`确定删除「${doc.filename}」及其分块？`,positiveText:"删除",negativeText:"取消",onPositiveClick:async()=>{try{await kbApi.removeDocument(doc.id);await selectBase(activeId.value);await loadBases();}catch(e){message.error(e.message);return false;}}});}
function removeBase(){const base=activeBase.value;dialog.warning({title:"删除知识库",content:`确定删除「${base.name}」及其中所有文档？此操作不可撤销。`,positiveText:"删除",negativeText:"取消",onPositiveClick:async()=>{try{await kbApi.remove(base.id);activeId.value=null;documents.value=[];await loadBases();activeTab.value="documents";}catch(e){message.error(e.message);return false;}}});}


const loading = ref(true);
const embedding = ref(null);
const bases = ref([]);
const activeId = ref(null);
const documents = ref([]);
const docsLoading = ref(false);
const uploading = ref(false);
const loadError = ref("");

/** 新建库弹窗 */
const showCreate = ref(false);
const draftName = ref("");
const draftDesc = ref("");
const creating = ref(false);

const activeBase = computed(() => bases.value.find((item) => item.id === activeId.value) ?? null);

function docTotal() {
	return documents.value.length;
}

function chunkTotal() {
	return documents.value.reduce((sum, item) => sum + (item.chunkCount ?? 0), 0);
}

/** 分块策略展示：库上存的是字符数，界面上要换算成人能读懂的一句话 */
function chunkPolicy() {
	if (!activeBase.value) return "—";
	const size = activeBase.value.chunkSize ?? 800;
	const overlap = activeBase.value.chunkOverlap ?? 120;
	return `按长度切分 · 每块 ${size} 字（重叠 ${overlap}）`;
}

function embeddingLabel() {
	if (!embedding.value) return "未配置";
	return embedding.value.available ? embedding.value.model : "未配置（走关键词检索）";
}

function fileSize(bytes) {
	if (!bytes) return "0 B";
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function loadBases() {
	loading.value = true;
	loadError.value = "";
	try {
		const [list, emb] = await Promise.all([kbApi.list(), kbApi.embedding().catch(() => null)]);
		// 兼容两种返回形状：裸数组，或 { items: [...] }
		bases.value = Array.isArray(list) ? list : (list.items ?? []);
		embedding.value = emb;
		if (bases.value.length > 0 && !activeId.value) {
			await selectBase(bases.value[0].id);
		}
	} catch (error) {
		loadError.value = error.message;
	} finally {
		loading.value = false;
	}
}

async function openSourceFromRoute() {
	const kbId = typeof route.query.kbId === "string" ? route.query.kbId : "";
	const docId = typeof route.query.docId === "string" ? route.query.docId : "";
	const chunkId = typeof route.query.chunkId === "string" ? route.query.chunkId : "";
	if (!kbId || !docId) return;
	sourceChunkId.value = chunkId;
	if (!bases.value.some((base) => base.id === kbId)) {
		message.warning("引用的知识库不存在或当前不可访问");
		return;
	}
	activeTab.value = "documents";
	await selectBase(kbId);
	await nextTick();
	const row = document.querySelector(`[data-kb-doc-id="${CSS.escape(docId)}"]`);
	if (!row) {
		message.warning("引用的文档已不存在或不属于该知识库");
		return;
	}
	row.scrollIntoView({ behavior: "smooth", block: "center" });
}

async function selectBase(id) {
 const seq=++selectionSeq;searchSeq++;searching.value=false;documents.value=[];
	activeId.value = id;
 searchResult.value=null;
	docsLoading.value = true;
	try {
		const list = await kbApi.documents(id);
		if(seq===selectionSeq) documents.value = Array.isArray(list) ? list : (list.items ?? []);
	} catch (error) {
		if(seq===selectionSeq){documents.value = [];
		message.error(`读取文档列表失败：${error.message}`);}
	} finally {
		if(seq===selectionSeq) docsLoading.value = false;
	}
}

async function createBase() {
	const name = draftName.value.trim();
	if (name.length === 0) {
		message.warning("库名不能为空");
		return;
	}
	creating.value = true;
	try {
		const created = await kbApi.create({
			name,
			description: draftDesc.value.trim() || null,
		});
		showCreate.value = false;
		draftName.value = "";
		draftDesc.value = "";
		await loadBases();
		if (created?.id) await selectBase(created.id);
		message.success(`已创建知识库「${name}」`);
	} catch (error) {
		message.error(error.message);
	} finally {
		creating.value = false;
	}
}

/**
 * 上传：浏览器把文件读成 base64 再 POST。
 * 二进制安全——文本用 content、二进制用 contentBase64，这里统一用 base64 省一个分支。
 */
async function uploadFiles(files) {
	if (!activeId.value || files.length === 0) return;
	const targetId = activeId.value;
 uploading.value = true;
	let ok = 0;
	const failures = [];
	for (const file of files) {
		try {
			const buffer = await file.arrayBuffer();
			await kbApi.uploadDocument(targetId, {
				filename: file.name,
				contentBase64: bytesToBase64(buffer),
			});
			ok += 1;
		} catch (error) {
			failures.push(`${file.name}：${error.message}`);
		}
	}
	uploading.value = false;
	if(activeId.value===targetId) await selectBase(targetId);
	await loadBases();
	if (ok > 0) message.success(`已上传 ${ok} 份文档`);
	for (const failure of failures) message.error(failure, { duration: 6000 });
}

/** ArrayBuffer → base64：分片避免 apply 爆栈 */
function bytesToBase64(buffer) {
	const bytes = new Uint8Array(buffer);
	let binary = "";
	const step = 0x8000;
	for (let i = 0; i < bytes.length; i += step) {
		binary += String.fromCharCode(...bytes.subarray(i, i + step));
	}
	return btoa(binary);
}

function onDrop(event) {
	const files = Array.from(event.dataTransfer?.files ?? []);
	void uploadFiles(files);
}

const fileInput = ref(null);
function pickFiles() {
	fileInput.value?.click();
}
function onFilePicked(event) {
	const files = Array.from(event.target.files ?? []);
	event.target.value = "";
	void uploadFiles(files);
}

onMounted(async () => { await loadBases(); await openSourceFromRoute(); });
watch(() => [route.query.kbId, route.query.docId, route.query.chunkId], () => { void openSourceFromRoute(); });
</script>

<template>
	<div class="page kb-page">
		<header class="page-head">
			<div>
				<h1 class="page-title">知识库</h1>
				<p class="page-sub">上传文档，构建 AI 知识体系，让 Agent 拥有专业知识</p>
			</div>
			<n-button v-if="can('workflow.write')" type="primary" @click="showCreate = true">创建知识库</n-button>
		</header>

		<n-alert v-if="loadError" type="error" :bordered="false" class="page-alert">
			读取知识库失败：{{ loadError }}
		</n-alert>

		<n-spin :show="loading">
			<div v-if="bases.length === 0 && !loading" class="kb-empty-wrap">
				<n-empty description="还没有知识库">
					<template #extra>
						<n-button v-if="can('workflow.write')" type="primary" @click="showCreate = true">创建第一个知识库</n-button>
					</template>
				</n-empty>
			</div>

			<div v-else class="kb-layout">
				<!-- 左栏：库列表 -->
				<aside class="kb-list">
					<div class="kb-list-head">
						<span>知识库列表</span>
						<span class="kb-count">{{ bases.length }}</span>
					</div>
					<button
						v-for="base in bases"
						:key="base.id"
						type="button"
						class="kb-item"
						:class="{ 'kb-item--active': base.id === activeId }"
						@click="selectBase(base.id)"
					>
						<div class="kb-item-name">{{ base.name }}</div>
						<div class="kb-item-meta">{{ base.docCount ?? 0 }} 文档 · {{ base.chunkCount ?? 0 }} 分块</div>
					</button>
				</aside>

				<!-- 右栏：详情 -->
				<section v-if="activeBase" class="kb-detail">
					<div class="kb-detail-head">
						<div>
							<h2 class="kb-detail-title">{{ activeBase.name }}</h2>
							<p class="kb-detail-desc">{{ activeBase.description || "暂无描述" }}</p>
						</div>
						<div class="kb-stats">
							<div class="kb-stat">
								<div class="kb-stat-num">{{ docTotal() }}</div>
								<div class="kb-stat-label">文档</div>
							</div>
							<div class="kb-stat">
								<div class="kb-stat-num">{{ chunkTotal() }}</div>
								<div class="kb-stat-label">分块</div>
							</div>
						</div>
					</div>

					<div class="kb-config-bar">
						<span><b>Embedding 模型</b> {{ embeddingLabel() }}</span>
						<span><b>分块策略</b> {{ chunkPolicy() }}</span>
						<span>
							<b>检索状态</b>
							<n-tag :bordered="false" size="small" :type="activeBase.embedding ? 'success' : 'warning'">
								{{ activeBase.embedding ? "语义检索已启用" : "仅关键词检索" }}
							</n-tag>
						</span>
					</div>

					<div class="action-row" style="margin-top:20px;margin-bottom:16px"><n-button :type="activeTab==='documents'?'primary':'default'" @click="activeTab='documents'">文档</n-button><n-button :type="activeTab==='search'?'primary':'default'" @click="activeTab='search'">检索测试</n-button><n-button :type="activeTab==='settings'?'primary':'default'" @click="activeTab='settings'">设置</n-button></div>
<template v-if="activeTab==='search'"><p class="hint">用实际业务问题检查资料能否命中。</p><div class="action-row"><n-input v-model:value="query" placeholder="输入检索问题" @keyup.enter="search"/><n-button type="primary" :loading="searching" @click="search">检索</n-button></div><template v-if="searchResult"><p class="hint">{{searchResult.mode==='vector'?'语义检索':searchResult.mode==='hybrid'?'语义与关键词混合检索':'关键词检索'}} · {{searchResult.fallbackReason||'按相关性排序'}}</p><n-empty v-if="!searchResult.results.length" description="没有命中结果"/><article v-for="r in searchResult.results" :key="r.chunkId" class="search-result"><b>{{documents.find(d=>d.id===r.docId)?.filename||r.heading||'文档分块'}}</b><p>{{r.snippet}}</p><button class="source-ref" type="button" @click="openSearchSource(r)">来源编号 [kb:{{r.kbId}} doc:{{r.docId}} chunk:{{r.chunkId}}] · 查看文档</button><span class="hint">相关性 {{r.score}}</span></article></template></template>
<template v-if="activeTab==='settings'"><dl class="detail-grid"><dt>默认检索</dt><dd>{{activeBase.isDefault?'已加入通用对话默认检索':'未加入默认检索'}}</dd><dt>向量模型</dt><dd>{{embeddingLabel()}}</dd><dt>分块策略</dt><dd>{{chunkPolicy()}}</dd></dl><div v-if="can('workflow.write')" class="action-row"><n-button :loading="settingsBusy" @click="setDefault">{{activeBase.isDefault?'取消默认检索':'设为默认检索'}}</n-button><n-button :disabled="!embedding?.available" :loading="settingsBusy" @click="reindex">重新向量化</n-button><n-button type="error" quaternary @click="removeBase">删除知识库</n-button></div><p v-if="!embedding?.available" class="hint">请先在模型管理中配置可用的向量模型，当前可使用关键词检索。</p></template>
<template v-if="activeTab==='documents'">
<!-- 文档上传与解析 -->
					<div
 v-if="can('workflow.write')"
						class="kb-drop"
						:class="{ 'kb-drop--busy': uploading }"
						role="button"
						tabindex="0"
						@click="pickFiles"
						@keydown.enter.prevent="pickFiles"
						@keydown.space.prevent="pickFiles"
						@dragover.prevent
						@drop.prevent="onDrop"
					>
						<input
							ref="fileInput"
							type="file"
							multiple
							accept=".txt,.md,.markdown,.csv,.pdf,.docx"
							hidden
							@change="onFilePicked"
						/>
						<div class="kb-drop-title">{{ uploading ? "正在上传解析…" : "拖拽文件到此处，或点击选择文件" }}</div>
						<div class="kb-drop-hint">支持 TXT、Markdown、PDF、Word、CSV</div>
					</div>

					<div class="kb-doc-head">
						<span>文档列表</span>
						<span class="kb-count">{{ documents.length }}</span>
					</div>
					<p v-if="sourceChunkId" class="source-location">来源分块 #{{ sourceChunkId }}</p>

					<n-spin :show="docsLoading">
						<div v-if="documents.length === 0" class="kb-doc-empty">还没有文档，上传一份就能开始检索</div>
						<ul v-else class="kb-doc-list">
							<li v-for="doc in documents" :key="doc.id" class="kb-doc" :data-kb-doc-id="doc.id" :class="{ 'kb-doc--source': doc.id === route.query.docId }">
								<div class="kb-doc-main">
									<div class="kb-doc-name">{{ doc.filename }}</div>
									<div class="kb-doc-meta">
										{{ fileSize(doc.bytes) }} · {{ doc.chunkCount ?? 0 }} 分块 · {{ doc.createdAt ? new Date(doc.createdAt).toLocaleDateString('zh-CN') : '' }}
									</div>
								</div>
								<n-tag :bordered="false" size="small" :type="doc.status === 'ready' ? 'success' : 'warning'">
									{{ doc.status === "ready" ? "已就绪" : doc.status }}
								</n-tag>
 <n-button v-if="can('workflow.write')" size="small" quaternary type="error" @click="removeDoc(doc)">删除文档</n-button>
							</li>
						</ul>
					</n-spin>
 </template>
				</section>
			</div>
		</n-spin>

		<n-modal v-model:show="showCreate" preset="card" title="创建知识库" style="max-width: 480px">
			<div class="kb-form">
				<n-input v-model:value="draftName" placeholder="库名，例如：产品文档" />
				<n-input v-model:value="draftDesc" type="textarea" placeholder="描述（可选）" :rows="3" />
			</div>
			<template #footer>
				<div class="kb-form-foot">
					<n-button @click="showCreate = false">取消</n-button>
					<n-button type="primary" :loading="creating" @click="createBase">创建</n-button>
				</div>
			</template>
		</n-modal>
	</div>
</template>

<style scoped>
.kb-layout {
	display: grid;
	grid-template-columns: 300px minmax(0, 1fr);
	gap: 16px;
	align-items: start;
}

@media (max-width: 900px) {
	.kb-layout {
		grid-template-columns: 1fr;
	}
}

/* 左栏：卡片式列表 */
.kb-list {
	background: var(--surface);
	border: 1px solid var(--line);
	border-radius: var(--radius-lg);
	padding: 12px;
	box-shadow: var(--shadow-sm);
}

.kb-list-head,
.kb-doc-head {
	display: flex;
	align-items: center;
	justify-content: space-between;
	font-size: 13px;
	color: var(--text-2);
	padding: 2px 6px 10px;
}

.kb-count {
	background: var(--surface-alt);
	border-radius: 999px;
	padding: 1px 8px;
	font-size: 12px;
	color: var(--muted);
}

.kb-item {
	display: block;
	width: 100%;
	text-align: left;
	border: none;
	background: transparent;
	border-radius: var(--radius);
	padding: 10px 12px;
	cursor: pointer;
	transition: background 0.15s ease;
}

.kb-item:hover {
	background: var(--surface-alt);
}

/* 选中：浅靛蓝底 + 左侧高亮条，和 AgentOne 的列表选中态一致 */
.kb-item--active {
	background: var(--brand-soft);
	box-shadow: inset 3px 0 0 var(--brand-primary);
}

.kb-item-name {
	font-size: 13.5px;
	color: var(--text);
	font-weight: 500;
}

.kb-item-meta {
	font-size: 12px;
	color: var(--muted);
	margin-top: 3px;
}

/* 右栏：详情卡片 */
.kb-detail {
	background: var(--surface);
	border: 1px solid var(--line);
	border-radius: var(--radius-lg);
	padding: 20px 24px 24px;
	box-shadow: var(--shadow-sm);
}

.kb-detail-head {
	display: flex;
	align-items: flex-start;
	justify-content: space-between;
	gap: 16px;
}

.kb-detail-title {
	margin: 0;
	font-size: 19px;
	font-weight: 600;
}

.kb-detail-desc {
	margin: 6px 0 0;
	font-size: 13px;
	color: var(--muted);
}

.kb-stats {
	display: flex;
	gap: 24px;
}

.kb-stat {
	text-align: right;
}

.kb-stat-num {
	font-size: 22px;
	font-weight: 600;
	color: var(--brand-primary);
	line-height: 1.2;
}

.kb-stat-label {
	font-size: 12px;
	color: var(--muted);
}

/* 配置概要条：浅底一行，把关键参数压成可扫的一条 */
.kb-config-bar {
	display: flex;
	flex-wrap: wrap;
	gap: 20px;
	margin-top: 16px;
	padding: 10px 14px;
	background: var(--surface-alt);
	border-radius: var(--radius);
	font-size: 12.5px;
	color: var(--text-2);
}

.kb-config-bar b {
	font-weight: 500;
	color: var(--muted);
	margin-right: 6px;
}

/* 拖拽上传区 */
.search-result {padding:16px 0;border-bottom:1px solid var(--line);}
.kb-drop {
	margin-top: 16px;
	border: 1.5px dashed var(--line-strong);
	border-radius: var(--radius);
	padding: 28px 16px;
	text-align: center;
	cursor: pointer;
	transition:
		border-color 0.15s ease,
		background 0.15s ease;
}

.kb-drop:hover,
.kb-drop:focus-visible {
	border-color: var(--brand-primary);
	background: var(--brand-soft);
	outline: none;
}

.kb-drop--busy {
	pointer-events: none;
	opacity: 0.7;
}

.kb-drop-title {
	font-size: 13.5px;
	color: var(--text);
}

.kb-drop-hint {
	font-size: 12px;
	color: var(--muted);
	margin-top: 4px;
}

.kb-doc-head {
	padding-top: 20px;
}

.kb-doc-list {
	list-style: none;
	margin: 0;
	padding: 0;
}

.kb-doc {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
	padding: 10px 12px;
	border-radius: var(--radius);
}

.kb-doc + .kb-doc {
	border-top: 1px solid var(--line);
}

.kb-doc-name {
	font-size: 13px;
	word-break: break-all;
}
.kb-doc--source { background: var(--primary-soft, #e8edff); outline: 2px solid var(--primary); outline-offset: 2px; }
.source-ref { display: block; margin: 6px 0; padding: 0; border: 0; background: none; color: var(--primary); font: inherit; font-size: 12px; text-align: left; cursor: pointer; }
.source-location { margin: 0 6px 8px; color: var(--primary); font-size: 12px; }

.kb-doc-meta {
	font-size: 12px;
	color: var(--muted);
	margin-top: 2px;
}

.kb-doc-empty,
.kb-empty-wrap {
	padding: 36px 0;
	text-align: center;
	font-size: 13px;
	color: var(--muted);
}

.kb-empty-wrap {
	background: var(--surface);
	border: 1px solid var(--line);
	border-radius: var(--radius-lg);
}

.kb-form {
	display: flex;
	flex-direction: column;
	gap: 12px;
}

.kb-form-foot {
	display: flex;
	justify-content: flex-end;
	gap: 8px;
}
</style>
