export const dateText = (value) => value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—";
export function resultOf(item) {
	const status = Number(item.detail?.status);
	if (item.ok === false || status >= 400) return { label: "失败", type: "error" };
	if (item.ok === true || (status >= 200 && status < 400)) return { label: "成功", type: "success" };
	return { label: "已记录", type: "default" };
}
const actions = { "session.create": "创建会话", "session.message": "发送消息", "session.delete": "删除会话", "workflow.create": "创建技能", "workflow.update": "修改技能", "workflow.delete": "删除技能", "auth.login": "登录", "auth.logout": "退出登录", "user.create": "添加成员", "user.update": "修改成员", "user.delete": "删除成员" };
export const actionText = (value) => actions[value] || ({ "http.post": "提交操作", "http.patch": "修改配置", "http.delete": "删除操作", "http.put": "更新配置" }[value]) || value || "工具调用";
export const actorText = (value) => ({ user: "成员", system: "系统", api_key: "开放 API", anonymous: "匿名" }[value] || value || "—");
