/**
 * 路由：hash 模式。
 *
 * 为什么用 hash 而不是 history：产物由后端 serveStatic 直接读文件发，
 * history 模式要求服务端对每个未知路径都回 index.html（否则刷新 404）。
 * 后端是零框架手写路由，为一个前端刷新加一条通配重写不值得，hash 一劳永逸。
 */
import { createRouter, createWebHashHistory } from "vue-router";
import Workbench from "./views/Workbench.vue";

const routes = [
	{ path: "/", redirect: { name: "workbench" } },
	{ path: "/workbench", name: "workbench", component: Workbench },
	{ path: "/chat", name: "chat", component: () => import("./views/Chat.vue") },
	{ path: "/agents", name: "agents", component: () => import("./views/Agents.vue") },
	// Agent 专属对话：每个 Agent 一个对话入口，历史按 agentId 归位，不跟通用对话页混在一起。
	// 放在 /agents 之后即可：vue-router 按 path 静态段匹配，/:id/chat 与 /agent-chat 不会互相吃掉。
	{ path: "/agent-chat/:id", name: "agent-chat", component: () => import("./views/AgentChat.vue") },
	{ path: "/knowledge", name: "knowledge", component: () => import("./views/Knowledge.vue") },
	{ path: "/skills", name: "skills", component: () => import("./views/Skills.vue") },
	{ path: "/models", name: "models", component: () => import("./views/Models.vue") },
	{ path: "/mcp", name: "mcp", component: () => import("./views/Mcp.vue") },
	{ path: "/im", name: "im", component: () => import("./views/Im.vue") },
	{ path: "/approvals", name: "approvals", component: () => import("./views/Approvals.vue") },
	{ path: "/audit", name: "audit", component: () => import("./views/Audit.vue") },
	{ path: "/monitor", name: "monitor", component: () => import("./views/Monitor.vue") },
	{ path: "/members", name: "members", component: () => import("./views/Members.vue") },
	{ path: "/settings", name: "settings", component: () => import("./views/Settings.vue") },
	{ path: "/plugins", name: "plugins", component: () => import("./views/Plugins.vue") },
	{ path: "/:pathMatch(.*)*", redirect: { name: "workbench" } },
];

export const router = createRouter({
	history: createWebHashHistory(),
	routes,
});
