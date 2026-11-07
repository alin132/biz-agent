<script setup>
/**
 * 主壳：左侧分组导航 + 右侧内容区。
 *
 * 布局对齐 AgentOne 的三段式侧边栏：
 *   顶部 = 品牌区（logo + 产品名 + 版本）
 *   中部 = 分组导航（构建 / 接入 / 管理）
 *   底部 = 当前用户
 *
 * 为什么用 n-menu 而不是自己画：菜单的高亮、键盘导航、折叠、子项展开都是 Naive UI 处理过的，
 * 自己写一遍只会得到一堆边界情况。分组用 n-menu 的 group 类型表达，跟 AgentOne 的视觉一致。
 */
import { computed, h, inject, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { NConfigProvider, NDialogProvider, NMenu, NMessageProvider, NTag } from "naive-ui";
import AuthGate from "./components/AuthGate.vue";
import { can } from "./access.js";

const route = useRoute();
const router = useRouter();
const mobileOpen = ref(false);
watch(() => route.fullPath, () => { mobileOpen.value = false; });
// main.js 里 provide 进来的主题（唯一真相在 theme.js，别在组件里再写一份颜色）
const themeOverrides = inject("themeOverrides");

/**
 * 导航配置：顺序按「进来先干什么」排，不按代码模块排。
 * 图标用内联 SVG（不用图标字体：多一个网络请求 + 字体加载期间会闪方块）。
 */
const NAV = [
	{
		key: "workbench",
		label: "工作台",
		icon: icon("M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"),
	},
	{
		key: "chat",
		label: "对话",
		icon: icon("M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H9l-5 4z"),
	},
	{
		type: "group",
		label: "构建",
		key: "g-build",
		children: [
			{
				key: "agents",
				label: "Agent",
				icon: icon("M12 3.2 4.5 7v6.2c0 3.6 3.2 6.2 7.5 7.6 4.3-1.4 7.5-4 7.5-7.6V7zM9.2 11.5h.01M14.8 11.5h.01M9.5 15c1.5 1 3.5 1 5 0"),
			},
			{
				key: "knowledge",
				label: "知识库",
				icon: icon("M4 5.5A1.5 1.5 0 0 1 5.5 4H19v16H5.5A1.5 1.5 0 0 1 4 18.5zM8 4v16"),
			},
			{
				key: "skills",
				label: "技能",
				icon: icon("M12 3.2 14 9l5.8 2-5.8 2-2 5.8-2-5.8L4.2 11 10 9z"),
			},
			{
				key: "mcp",
				label: "MCP 集成",
				icon: icon("M9 3v4M15 3v4M7 7h10v4a5 5 0 0 1-10 0zM12 16v5"),
			},
		],
	},
	{
		type: "group",
		label: "接入",
		key: "g-connect",
		children: [
			{
				key: "models",
				label: "模型管理",
				icon: icon("M7 7h10v10H7zM10 3v2M14 3v2M10 19v2M14 19v2M3 10h2M3 14h2M19 10h2M19 14h2"),
			},
			{
				key: "im",
				label: "IM 机器人",
				icon: icon("M4 7h16v12H4zM12 3v4M9.5 13h.01M14.5 13h.01"),
			},
		],
	},
	{
		type: "group",
		label: "管理",
		key: "g-manage",
		children: [
			{
				key: "approvals",
				label: "审批",
				icon: icon("M12 3.5 19 6v6c0 4-3 6.6-7 8-4-1.4-7-4-7-8V6zM9 12l2 2 4-4"),
			},
			{
				key: "audit",
				label: "审计",
				icon: icon("M3.5 4.5h5v15h-5zM10.5 4.5h5v10h-5zM17.5 4.5h3v6h-3z"),
			},
			{
				key: "monitor",
				label: "监控",
				icon: icon("M3 12h4l2.5-6 3.5 12 2.5-6H21"),
			},
		],
	},
];
NAV.find((item) => item.key === "g-build").children.push({ key: "plugins", label: "插件", icon: icon("M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z") });
NAV.find((item) => item.key === "g-manage").children.push(
	{ key: "members", label: "成员", permission: "member.manage", icon: icon("M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M20 21v-2a4 4 0 0 0-3-4") },
	{ key: "settings", label: "设置", icon: icon("M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2") },
);

/**
 * 生成图标渲染函数：统一 18px、1.6 描边，和 AgentOne 的线性图标一致。
 *
 * 注意：这里用 h("path", ...) 造子节点，**不能用 innerHTML**。
 * h() 的 props 里 `innerHTML` 是 Naive UI 扩展出来的写法，原生 Vue 的 patch 阶段会对它
 * 做 props 归一化并抛错，整棵渲染树就断在第一个图标上——菜单文字因此全都不显示。
 */
function icon(path) {
	return () =>
		h(
			"svg",
			{
				viewBox: "0 0 24 24",
				fill: "none",
				stroke: "currentColor",
				"stroke-width": "1.6",
				"stroke-linecap": "round",
				"stroke-linejoin": "round",
			},
			[h("path", { d: path })],
		);
}

/**
 * 单个导航项：label 必须是"渲染函数"或字符串，直接把 vnode 塞进 label 字段不生效（菜单会画成空白）。
 * 这里另外两处讲究：
 *   - label 用 renderLabel，让 RouterLink 拿到真实 <a>，能 Ctrl+点击新窗口打开、能右键复制链接；
 *   - icon 用 renderIcon，图标尺寸由菜单自己的 .n-icon 容器控制。
 */
function renderLabel(item) {
	return () => h(RouterLink, { to: { name: item.key } }, { default: () => item.label });
}

/**
 * 菜单项：label / title 两个都给。
 *
 * 为什么必须都给：naive-ui 在 `utils.mjs` 里把每一层转成组件时用的是**字段白名单**
 * （menuItemPropKeys / submenuPropKeys ...），子项只认 `label`，
 * 而真正渲染的 MenuOption 读的是 `title`（`title: rawNode.title || rawNode[labelField]`）。
 * 只给 label 的话，子项会渲染成一个没有文字的图标——正是这里踩过的坑。
 */
function toMenuItem(item) {
	return {
		key: item.key,
		label: item.label,
		title: item.label,
		icon: item.icon,
	};
}

const menuOptions = computed(() =>
	NAV.map((item) =>
		item.type === "group"
			? {
					type: "group",
					label: item.label,
					key: item.key,
					// 分组标题是纯文本，Naive 对 group 的 label 支持字符串，不需要渲染函数
					children: item.children.filter((entry) => !entry.permission || can(entry.permission)).map(toMenuItem),
				}
			: toMenuItem(item),
	),
);

const activeKey = computed(() => {
	// Agent 的专属对话页在侧边栏里归属「Agent」（它就是从这个列表点进去的），
	// 而不是「对话」——否则用户点开某个 Agent 后，菜单会跳到通用对话页那一项上，自相矛盾。
	if (route.name === "agent-chat") return "agents";
	return route.name;
});
function handleMenu(key) {
	if (key && key !== route.name) router.push({ name: key });
}
</script>

<template>
	<!-- themeOverrides 必须包在最外层：包在某个页面里，别的页面就会掉回 Naive 默认蓝 -->
	<n-config-provider :theme-overrides="themeOverrides">
		<!-- message / dialog 这两个 provider 必须包在路由外面：任何页面都能 useMessage() 弹提示，
		     少一层就会抛 "No outer <n-message-provider /> founded"，整页白屏 -->
		<n-message-provider>
			<n-dialog-provider>
		<AuthGate v-slot="{ user, roleLabel, logout, authRequired }">
		<div class="app-shell" :class="{ 'nav-open': mobileOpen }">
		<button class="nav-toggle" type="button" :aria-expanded="mobileOpen" aria-controls="app-navigation" @click="mobileOpen = !mobileOpen">☰ <span>导航</span></button>
		<button v-if="mobileOpen" class="nav-backdrop" type="button" aria-label="关闭导航" @click="mobileOpen = false" />
		<aside id="app-navigation" class="app-sider">
			<div class="brand">
				<div class="brand-mark">B</div>
				<div class="brand-text">
					<div class="brand-name">biz-agent</div>
					<div class="brand-tag">企业业务智能体</div>
				</div>
			</div>

			<n-menu
				class="app-menu"
				:options="menuOptions"
				:value="activeKey"
				:indent="18"
				@update:value="handleMenu"
			/>

			<div class="sider-footer">
				<n-tag size="small" :bordered="false" type="success">运行中</n-tag>
				<span class="sider-role">{{ user?.name || roleLabel }} · {{ roleLabel }}</span>
				<button v-if="authRequired" type="button" @click="logout">退出登录</button>
			</div>
		</aside>

		<main class="app-main">
			<router-view />
		</main>
		</div>
		</AuthGate>
			</n-dialog-provider>
		</n-message-provider>
	</n-config-provider>
</template>

<style>
/* 全局基础样式：只在这里定义一次，组件里不要再 reset */
* {
	box-sizing: border-box;
}

html,
body,
#app {
	height: 100%;
	margin: 0;
}

body {
	font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB",
		"Microsoft YaHei", sans-serif;
	background: var(--bg);
	color: var(--text);
	-webkit-font-smoothing: antialiased;
}

.app-shell {
	display: grid;
	grid-template-columns: 236px minmax(0, 1fr);
	height: 100vh;
}

.app-sider {
	display: flex;
	flex-direction: column;
	background: var(--surface);
	border-right: 1px solid var(--line);
	padding: 16px 12px 12px;
	min-height: 0;
}

.brand {
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 4px 8px 18px;
}

.brand-mark {
	width: 34px;
	height: 34px;
	border-radius: 10px;
	background: var(--brand-gradient);
	color: #fff;
	display: grid;
	place-items: center;
	font-weight: 700;
	font-size: 16px;
	box-shadow: var(--shadow);
}

.brand-name {
	font-size: 14.5px;
	font-weight: 600;
	letter-spacing: 0.01em;
}

.brand-tag {
	font-size: 11px;
	color: var(--muted);
	margin-top: 1px;
}

/* 菜单区域自己滚：分组多了也不会把底部信息挤出去 */
.app-menu {
	flex: 1;
	min-height: 0;
	overflow-y: auto;
}

.sider-footer {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 12px 8px 4px;
	border-top: 1px solid var(--line);
	margin-top: 8px;
}

.sider-role {
	font-size: 12px;
	color: var(--muted);
}

.app-main {
	min-width: 0;
	overflow-y: auto;
	background: var(--bg);
}
</style>
