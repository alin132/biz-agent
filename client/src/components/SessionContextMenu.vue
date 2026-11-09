<script setup>
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { NButton, NInput, NModal, useDialog, useMessage } from "naive-ui";
import { http } from "../api.js";
import { downloadPiSession } from "../piSessionDownload.js";
import { can } from "../access.js";

const props = defineProps({ session: Object, x: Number, y: Number, busy: Boolean, pinned: Boolean });
const emit = defineEmits(["close", "updated", "removed", "created", "busy", "pin"]);
const dialog = useDialog();
const message = useMessage();
const menu = ref(null);
const renameOpen = ref(false);
const title = ref("");
const working = ref(false);
const targetSession = ref(null);
const canWrite = computed(() => can("session.write"));
const canRead = computed(() => can("session.read"));
const menuStyle = computed(() => ({
	left: `${Math.max(8, Math.min(props.x ?? 8, window.innerWidth - 204))}px`,
	top: `${Math.max(8, Math.min(props.y ?? 8, window.innerHeight - 220))}px`,
}));

async function update(body, method = "PATCH") {
	if (!targetSession.value) return;
	const sessionId = targetSession.value.id;
	working.value = true;
	emit("busy", true);
	try {
		await http[method.toLowerCase()](`/api/sessions/${sessionId}`, body);
		const result = await http.get(`/api/sessions/${sessionId}`);
		emit("updated", result);
		renameOpen.value = false;
		emit("close");
	} catch (cause) {
		message.error(cause?.message ?? "会话操作失败");
	} finally {
		working.value = false;
		emit("busy", false);
	}
}

async function exportPiSession() {
	if (!targetSession.value || !canRead.value) return;
	const sessionId = targetSession.value.id;
	emit("close");
	try {
		await downloadPiSession(sessionId);
	} catch (cause) {
		message.error(cause?.message ?? "导出 Pi 会话失败");
	}
}

async function cloneSession() {
	if (!targetSession.value || !canWrite.value || working.value) return;
	working.value = true;
	emit("busy", true);
	emit("close");
	try {
		const result = await http.post(`/api/sessions/${targetSession.value.id}/clone`, {});
		emit("created", result.session);
	} catch (cause) {
		message.error(cause?.message ?? "复制对话失败");
	} finally {
		working.value = false;
		emit("busy", false);
	}
}

function remove() {
	if (!targetSession.value) return;
	const sessionId = targetSession.value.id;
	emit("close");
	dialog.warning({
		title: "删除对话",
		content: "这将永久删除当前对话及其历史记录，确定继续？",
		positiveText: "删除",
		negativeText: "取消",
		onPositiveClick: async () => {
			try {
				await http.delete(`/api/sessions/${sessionId}`);
				emit("removed", sessionId);
			} catch (cause) {
				message.error(cause?.message ?? "删除失败");
				return false;
			}
		},
	});
}

function onWindowPointer(event) {
	if (props.session && !menu.value?.contains(event.target)) emit("close");
}
function onWindowKeydown(event) {
	if (event.key === "Escape" && props.session) emit("close");
}
function openRenameFor(session) {
	if (!session || !canWrite.value) return;
	targetSession.value = session;
	title.value = session.title ?? "";
	renameOpen.value = true;
}
defineExpose({ openRenameFor });
watch(() => props.session, (session) => {
	if (session) {
		targetSession.value = session;
		title.value = session.title ?? "";
	}
});
if (typeof window !== "undefined") {
	window.addEventListener("pointerdown", onWindowPointer);
	window.addEventListener("keydown", onWindowKeydown);
}
onBeforeUnmount(() => {
	window.removeEventListener("pointerdown", onWindowPointer);
	window.removeEventListener("keydown", onWindowKeydown);
});
</script>

<template>
	<Teleport to="body">
		<div
			v-if="session && (canRead || canWrite)"
			ref="menu"
			class="session-context-menu"
			:style="menuStyle"
			role="menu"
			aria-label="会话操作"
			data-testid="session-context-menu"
			@click.stop
		>
			<button v-if="canRead" type="button" role="menuitem" :disabled="working" @click="exportPiSession">导出 Pi 会话 (.jsonl)</button>
			<button v-if="canWrite" type="button" role="menuitem" :disabled="busy || working" @click="cloneSession">复制对话</button>
			<button v-if="canWrite" type="button" role="menuitem" @click="emit('pin'); emit('close')">{{ pinned ? "取消置顶" : "置顶对话" }}</button>
			<button v-if="canWrite" type="button" role="menuitem" :disabled="busy || working" @click="renameOpen = true; emit('close')">重命名</button>
			<button v-if="canWrite" type="button" role="menuitem" :disabled="busy || working" @click="update({ archived: !session.archived })">{{ session.archived ? "取消归档" : "归档" }}</button>
			<button v-if="canWrite" type="button" role="menuitem" class="danger" :disabled="busy || working" @click="remove">删除对话</button>
		</div>
		<n-modal v-model:show="renameOpen" preset="card" title="重命名对话" style="width: min(460px, calc(100vw - 32px))">
			<n-input v-model:value="title" placeholder="输入标题，留空恢复自动标题" :maxlength="80" />
			<template #footer>
				<n-button type="primary" :loading="working" @click="update({ title })">保存标题</n-button>
			</template>
		</n-modal>
	</Teleport>
</template>

<style scoped>
.session-context-menu {
	position: fixed;
	z-index: 2000;
	width: 196px;
	display: grid;
	gap: 2px;
	padding: 4px;
	background: var(--surface, #fff);
	border: 1px solid var(--line, #dfe3e8);
	border-radius: 8px;
	box-shadow: 0 8px 24px rgb(21 31 45 / 18%);
}
.session-context-menu button {
	width: 100%;
	border: 0;
	border-radius: 5px;
	padding: 8px 10px;
	background: transparent;
	color: var(--text, #20252c);
	text-align: left;
	cursor: pointer;
	font-size: 13px;
}
.session-context-menu button:hover:not(:disabled) { background: var(--surface-alt, #f2f4f7); }
.session-context-menu button:disabled { opacity: .5; cursor: default; }
.session-context-menu button.danger { color: var(--danger, #c2413b); }
</style>
