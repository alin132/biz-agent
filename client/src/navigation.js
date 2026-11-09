import { http } from "./api.js";
export async function openSession(router, id) {
	const item = await http.get(`/api/sessions/${encodeURIComponent(id)}`);
	return router.push({ name: "chat", query: { ...(item.agentId ? { agentId: item.agentId } : {}), session: id } });
}
