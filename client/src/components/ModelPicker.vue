<script setup>
/**
 * Codex 风格的模型选择器：输入框下方一个内联按钮（显示当前模型名），
 * 点开向上弹出的轻量菜单——每项右侧选中勾、底部「管理模型」入口。
 * 键盘：↑↓ 移动高亮、Enter 选中、Esc 关闭。
 *
 * 为什么不用 n-select：那是个大下拉框，跟输入框右下角的空间气质不搭；
 * Codex 的交互是「按钮本身就在说当前用谁」，点开是紧凑菜单，选完立即收起。
 * 会话级切换语义不在这里——组件只上报 choose 事件，由页面决定调哪个接口。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useRouter } from "vue-router";

const props = defineProps({
	/** 全部可选模型：[{ id, label }]；空数组 = 没得选（没配 key / 没建模型） */
	options: { type: Array, default: () => [] },
	/** 当前生效的模型行 id */
	value: { type: String, default: null },
	/** 按钮上的标签（模拟模型时如实写「模拟模型」） */
	currentLabel: { type: String, required: true },
	/** 切换请求进行中：按钮转圈防重复点 */
	switching: { type: Boolean, default: false },
	/** 没得选时置灰并说明原因 */
	disabled: { type: Boolean, default: false },
});
const emit = defineEmits(["choose"]);
const router = useRouter();

const open = ref(false);
const active = ref(0);
const root = ref(null);
const menu = ref(null);

const activeId = computed(() => props.options[active.value]?.id ?? null);

function toggle() {
	if (props.disabled || props.switching) return;
	open.value = !open.value;
	if (open.value) {
		// 打开时高亮停在当时选中的那一项上，符合「接着上次的选」的直觉
		const idx = props.options.findIndex((option) => option.id === props.value);
		active.value = idx >= 0 ? idx : 0;
		scrollActiveIntoView();
	}
}

function openMenu() {
	if (props.disabled || props.switching) return;
	if (!open.value) toggle();
}

function close() {
	open.value = false;
}

function pick(option) {
	if (!option || option.id === props.value) {
		close();
		return;
	}
	emit("choose", option.id);
	close();
}

function go(route) {
	router.push(route);
	close();
}

/** 键盘导航：↑↓ 循环移动、Enter 选中、Esc 收起；外点关闭由 document 监听兜住 */
function onKeydown(event) {
	if (!open.value) {
		if ((event.key === "ArrowUp" || event.key === "ArrowDown") && !props.disabled) {
			event.preventDefault();
			toggle();
		}
		return;
	}
	if (event.key === "Escape") {
		event.preventDefault();
		close();
	} else if (event.key === "ArrowDown") {
		event.preventDefault();
		active.value = (active.value + 1) % Math.max(props.options.length, 1);
		scrollActiveIntoView();
	} else if (event.key === "ArrowUp") {
		event.preventDefault();
		active.value = (active.value - 1 + props.options.length) % Math.max(props.options.length, 1);
		scrollActiveIntoView();
	} else if (event.key === "Enter") {
		event.preventDefault();
		pick(props.options[active.value]);
	}
}

function scrollActiveIntoView() {
	void nextTick(() => {
		const el = menu.value?.querySelector("[data-active=true]");
		el?.scrollIntoView({ block: "nearest" });
	});
}

function onDocumentPointer(event) {
	if (open.value && root.value && !root.value.contains(event.target)) close();
}

document.addEventListener("pointerdown", onDocumentPointer);
onBeforeUnmount(() => document.removeEventListener("pointerdown", onDocumentPointer));

// 会话或模型被外部改掉（切会话/换模型成功回包）时收起菜单，别停在旧高亮上
watch(() => props.value, close);

defineExpose({ open: openMenu });
</script>

<template>
	<div ref="root" class="model-picker" data-testid="session-model-picker" @keydown="onKeydown">
		<button
			type="button"
			class="model-trigger"
			:disabled="disabled || switching"
			:aria-expanded="open"
			aria-haspopup="listbox"
			:title="currentLabel"
			@click="toggle"
		>
			<span class="model-trigger-dot" aria-hidden="true"></span>
			<span class="model-trigger-name" data-testid="model-current-name">{{ currentLabel }}</span>
			<span class="model-trigger-caret" aria-hidden="true">▲</span>
		</button>
		<Transition name="model-pop">
			<div v-if="open" ref="menu" class="model-menu" role="listbox" data-testid="model-menu">
				<p v-if="options.length === 0" class="model-menu-empty">没有可选模型（先去「模型」页配置）</p>
				<button
					v-for="(option, index) in options"
					:key="option.id"
					type="button"
					class="model-item"
					role="option"
					:aria-selected="option.id === value"
					:data-active="index === active"
					:class="{ active: index === active }"
					@mouseenter="active = index"
					@click="pick(option)"
				>
					<span class="model-item-label">{{ option.label }}</span>
					<span v-if="option.id === value" class="model-item-check" aria-hidden="true">✓</span>
				</button>
				<div class="model-menu-foot">
					<button type="button" class="model-manage" @click="go({ name: 'models' })">
						管理模型 →
					</button>
				</div>
			</div>
		</Transition>
	</div>
</template>

<style scoped>
.model-picker {
	position: relative;
	display: inline-flex;
}
.model-trigger {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	border: 1px solid var(--bs-border, #d9deea);
	background: transparent;
	border-radius: 8px;
	padding: 4px 10px;
	font-size: 12px;
	color: var(--bs-text, #333);
	cursor: pointer;
	transition: border-color .15s, background .15s;
}
.model-trigger:hover:not(:disabled) { border-color: #6c7cff; background: rgba(108,124,255,.06); }
.model-trigger:disabled { opacity: .55; cursor: not-allowed; }
.model-trigger-dot { width: 6px; height: 6px; border-radius: 50%; background: #35c28f; }
.model-trigger-name { max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.model-trigger-caret { font-size: 9px; opacity: .6; }
.model-menu {
	position: absolute;
	bottom: calc(100% + 6px);
	left: 0;
	min-width: 220px;
	max-height: 260px;
	overflow: auto;
	background: #fff;
	border: 1px solid #e2e6f0;
	border-radius: 10px;
	box-shadow: 0 10px 28px rgba(23,31,60,.14);
	padding: 6px;
	z-index: 30;
}
.model-menu-empty { margin: 4px 8px; font-size: 12px; color: #8a90a5; }
.model-item {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
	width: 100%;
	border: 0;
	background: transparent;
	border-radius: 7px;
	padding: 7px 10px;
	font-size: 13px;
	color: #333;
	cursor: pointer;
	text-align: left;
}
.model-item.active { background: rgba(108,124,255,.10); }
.model-item-check { color: #4f5cff; font-weight: 700; }
.model-menu-foot { border-top: 1px solid #eef0f6; margin-top: 4px; padding-top: 4px; }
.model-manage {
	width: 100%;
	border: 0;
	background: transparent;
	padding: 6px 10px;
	font-size: 12px;
	color: #6c7cff;
	cursor: pointer;
	border-radius: 7px;
	text-align: left;
}
.model-manage:hover { background: rgba(108,124,255,.08); }
/* 弹出动画：从下往上浮起（Codex 同款方向），尊重系统减弱动效偏好 */
.model-pop-enter-active, .model-pop-leave-active { transition: opacity .14s ease, transform .14s ease; }
.model-pop-enter-from, .model-pop-leave-to { opacity: 0; transform: translateY(6px); }
@media (prefers-reduced-motion: reduce) {
	.model-pop-enter-active, .model-pop-leave-active { transition: none; }
}
</style>
