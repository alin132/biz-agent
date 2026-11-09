<script setup>
/**
 * 斜杠命令面板：输入框里敲 `/` 弹出的命令列表。
 *
 * 为什么单独一个组件而不是塞进 Chat.vue：命令表是**数据**，加一条命令只该改一处；
 * 面板的键盘导航（上下键换高亮 / 回车执行 / Esc 收起）与"谁在用"无关，
 * 抽出来之后 Chat.vue 只需要接一个 v-model 与一个 @run，改动面最小。
 *
 * 与旧前端 web/app.js 的 SLASH_COMMANDS 同一套约定：
 *  - aliases 里带拼音（"yasuo" / "jihua"），中文用户敲拼音也能命中；
 *  - 命令只调既有函数，面板自己不写任何请求。
 */
import { computed } from "vue";

const props = defineProps({
	/** 输入框里 "/" 之后的过滤词 */
	query: { type: String, default: "" },
	/** 命令表：[{ id, label, hint, aliases }] */
	items: { type: Array, required: true },
	/** 当前高亮的序号（由父组件持有，键盘导航在父组件里处理） */
	index: { type: Number, default: 0 },
});

const emit = defineEmits(["run", "update:index"]);

/** 命中规则：命令名或任一别名包含过滤词（大小写不敏感） */
const matches = computed(() => {
	const q = props.query.trim().toLowerCase();
	if (!q) return props.items;
	return props.items.filter((item) =>
		[item.label, ...(item.aliases ?? [])].some((word) => String(word).toLowerCase().includes(q)),
	);
});
const groups = computed(() => [
	{ id: "skill", title: "技能", items: matches.value.filter((item) => item.kind === "skill") },
	{ id: "command", title: "命令", items: matches.value.filter((item) => item.kind !== "skill") },
].filter((group) => group.items.length));

/** 过滤后条数会变少，高亮可能越界；这里夹回合法范围并回报给父组件 */
const activeIndex = computed(() => {
	const count = matches.value.length;
	if (count === 0) return -1;
	return Math.max(0, Math.min(props.index, count - 1));
});

function pick(item) {
	if (item) emit("run", item);
}
</script>

<template>
	<div class="slash-panel" data-testid="slash-panel">
		<div v-if="matches.length === 0" class="slash-empty">没有匹配的命令，按 Esc 关闭</div>
		<section v-for="group in groups" :key="group.id" class="slash-group">
			<h3 class="slash-group-title">{{ group.title }}</h3>
			<button
				v-for="item in group.items"
				:key="item.id"
				type="button"
				class="slash-item"
				:class="{ active: matches.indexOf(item) === activeIndex, 'is-skill': item.kind === 'skill' }"
				data-testid="slash-item"
				:data-command-id="item.id"
				@mousedown.prevent="pick(item)"
			>
				<span class="slash-item-label">{{ item.label }}</span>
				<span class="slash-item-hint">{{ item.hint ?? "" }}</span>
				<span v-if="item.active" class="slash-item-status">当前</span>
			</button>
		</section>
	</div>
</template>

<style scoped>
.slash-panel {
	position: absolute;
	bottom: calc(100% + 6px);
	left: 0;
	right: 0;
	max-height: 280px;
	overflow-y: auto;
	background: var(--panel, #fff);
	border: 1px solid var(--border, #e0e0e6);
	border-radius: 10px;
	box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
	padding: 4px;
	z-index: 50; /* 压过 naive-ui 抽屉/消息条的层级，保证永远浮在最上 */
	display: flex;
	flex-direction: column;
	gap: 2px;
}
.slash-group + .slash-group { border-top: 1px solid var(--border, #e0e0e6); margin-top: 4px; padding-top: 4px; }
.slash-group-title { margin: 0; padding: 7px 10px 5px; color: var(--text-2, #77808a); font-size: 12px; font-weight: 500; }
.slash-empty {
	padding: 10px 12px;
	font-size: 12px;
	opacity: 0.6;
}
.slash-item {
	display: flex;
	align-items: center;
	gap: 10px;
	width: 100%;
	min-width: 0;
	min-height: 38px;
	text-align: left;
	background: none;
	border: none;
	border-radius: 6px;
	padding: 7px 10px;
	cursor: pointer;
	font-size: 13px;
	color: inherit;
}
.slash-item.active {
	background: var(--surface-alt, #f1f3f5);
}
.slash-item-label {
	flex: 0 1 auto;
	min-width: 0;
	font-weight: 500;
	white-space: nowrap;
}
.slash-item-hint {
	flex: 1 1 auto;
	min-width: 0;
	font-size: 12px;
	color: var(--text-2, #77808a);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.slash-item-status { flex: none; color: var(--text-2, #77808a); font-size: 11px; }
@media (max-width: 600px) {
	.slash-item { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 8px; }
	.slash-item-label { grid-column: 1; }
	.slash-item-hint { grid-column: 1 / -1; grid-row: 2; }
	.slash-item-status { grid-column: 2; grid-row: 1; }
}
</style>
