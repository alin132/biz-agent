import { http } from "./api.js";
export async function openSession(router, id) {
	const item = await http.get(`/api/sessions/${encodeURIComponent(id)}`);
	return router.push({ name: item.agentId ? "agent-chat" : "chat", ...(item.agentId ? { params: { id: item.agentId } } : {}), query: { session: id } });
}
