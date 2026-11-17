import { agentsApi, http } from "./api.js";

export async function startAgentChat(router, agentId) {
	const chatWindow = window.open("about:blank", "_blank");
	if (!chatWindow) throw new Error("浏览器阻止了新窗口，请允许此站点打开新标签页后重试。");
	chatWindow.opener = null;
	try {
		const session = await agentsApi.startChat(agentId);
		if (chatWindow.closed) throw new Error("对话页面已关闭，新建的会话已保留，可从历史会话继续。");
		const target = router.resolve({ name: "chat", query: { agentId, session: session.id, standalone: "1" } });
		chatWindow.location.replace(new URL(target.href, window.location.href).href);
	} catch (error) {
		chatWindow.close();
		throw error;
	}
}

export function openAgentHistory(router, agentId) {
	const target = router.resolve({ name: "chat", query: { agentId, standalone: "1" } });
	const chatWindow = window.open(new URL(target.href, window.location.href).href, "_blank");
	if (!chatWindow) throw new Error("浏览器阻止了新窗口，请允许此站点打开新标签页后重试。");
	chatWindow.opener = null;
}

export async function openSession(router, id) {
	const item = await http.get(`/api/sessions/${encodeURIComponent(id)}`);
	return router.push({ name: "chat", query: { ...(item.agentId ? { agentId: item.agentId } : {}), session: id } });
}
