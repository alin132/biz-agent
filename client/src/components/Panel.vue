<script setup>
/**
 * 面板容器：白底、圆角、细边、轻阴影。
 *
 * 之所以不直接用 n-card：n-card 的 padding 与标题结构对我们这种"表格式面板"偏厚，
 * 八张面板摆一起会很松。这里统一 16/20 的内边距，标题行自带右侧操作位。
 */
defineProps({
	title: { type: String, default: "" },
	/** 标题右侧的补充信息（数量、状态等） */
	meta: { type: String, default: "" },
	padded: { type: Boolean, default: true },
});
</script>

<template>
	<section class="panel">
		<header v-if="title" class="panel-head">
			<div class="panel-title">
				{{ title }}
				<span v-if="meta" class="panel-meta">{{ meta }}</span>
			</div>
			<div class="panel-actions">
				<slot name="actions" />
			</div>
		</header>
		<div class="panel-body" :class="{ 'panel-body--flush': !padded }">
			<slot />
		</div>
	</section>
</template>

<style scoped>
.panel {
	background: var(--surface);
	border: 1px solid var(--line);
	border-radius: var(--radius-lg);
	box-shadow: var(--shadow-sm);
	overflow: hidden;
}

.panel-head {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
	padding: 14px 20px;
	border-bottom: 1px solid var(--line);
}

.panel-title {
	font-size: 14px;
	font-weight: 600;
}

.panel-meta {
	margin-left: 8px;
	font-size: 12px;
	font-weight: 400;
	color: var(--muted);
}

.panel-actions {
	display: flex;
	align-items: center;
	gap: 8px;
}

.panel-body {
	padding: 20px;
}

.panel-body--flush {
	padding: 0;
}
</style>
