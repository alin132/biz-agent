/** 企业微信端到端：只允许 fake 传输实例，不连接企业微信。 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { encryptWecomMessage, wecomMsgSignature } from "../server/im/wecom.js";
const base = process.env.SMOKE_IM_BASE ?? "http://127.0.0.1:4446";
let checks = 0;
function check(value: unknown, text: string): void { assert.ok(value, text); checks++; console.log("通过：" + text); }
async function api(path: string, method = "GET", body?: unknown) {
	const response = await fetch(base + path, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
	return { status: response.status, body: await response.json() as Record<string, any> };
}
const key = randomBytes(32).toString("base64").slice(0, 43);
const token = "qa-token";
const corp = "ww-smoke";
let id = "";
try {
	const health = await api("/api/health");
	check(health.status === 200, "隔离服务可连接");
	const created = await api("/api/im/bots", "POST", { platform: "wecom", name: "Smoke企业微信", appKey: corp, appSecret: "qa-secret", robotCode: "1000002", callbackToken: token, aesKey: key });
	check(created.status === 201 && created.body.platform === "wecom", "创建企业微信配置");
	id = created.body.id;
	const list = await api("/api/im/bots");
	const bot = list.body.items.find((item: { id: string }) => item.id === id);
	check(bot?.transport === "fake", "企业微信传输明确为 fake");
	check(!JSON.stringify(bot).includes(key) && !JSON.stringify(bot).includes("qa-secret"), "凭证只返回掩码");
	function callback(encrypted: string, echo = false): string {
		const timestamp = String(Math.floor(Date.now() / 1000));
		return "/api/im/wecom/callback?" + new URLSearchParams({ botId: id, timestamp, nonce: "qa-nonce", msg_signature: wecomMsgSignature(token, timestamp, "qa-nonce", encrypted), ...(echo ? { echostr: encrypted } : {}) });
	}
	const echo = await fetch(base + callback(encryptWecomMessage("验证通过", key, corp), true));
	check(echo.status === 200 && await echo.text() === "验证通过", "完整服务 GET URL 校验");
	const encrypted = encryptWecomMessage(`<xml><ToUserName>${corp}</ToUserName><FromUserName>staff-smoke</FromUserName><CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime><MsgType>text</MsgType><Content><![CDATA[你好]]></Content><MsgId>msg-${Date.now()}</MsgId><AgentID>1000002</AgentID></xml>`, key, corp);
	const path = callback(encrypted);
	async function deliver() { return fetch(base + path, { method: "POST", headers: { "Content-Type": "application/xml" }, body: `<xml><Encrypt><![CDATA[${encrypted}]]></Encrypt></xml>` }); }
	check((await deliver()).status === 200, "完整服务接收加密消息");
	let reply: { botId: string; target: { staffId: string }; content: string } | undefined;
	for (let i = 0; i < 80; i++) {
		const box = await api("/api/im/outbox");
		reply = box.body.items.find((item: { botId: string }) => item.botId === id);
		if (reply) break;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	check(reply?.target.staffId === "staff-smoke" && reply.content.length > 0, "AI 回复发给原员工");
	check((await deliver()).status === 200, "重复消息正常确认");
	const box = await api("/api/im/outbox");
	check(box.body.items.filter((item: { botId: string }) => item.botId === id).length === 1, "重复消息不重复回复");
	const details = await api(`/api/im/bots/${id}`);
	check(details.body.sessionCount === 1 && details.body.lastCallbackAt > 0, "会话映射与最近回调已记录");
	const group = await api(`/api/im/bots/${id}/ping`, "POST", { conversationId: "群" });
	check(group.status === 400, "企业微信不接受钉钉群目标");
	const ping = await api(`/api/im/bots/${id}/ping`, "POST", { staffId: "staff-test" });
	check(ping.status === 200 && ping.body.ok === true, "企业微信员工测试发送");
	await api(`/api/im/bots/${id}`, "PATCH", { enabled: false });
	check((await deliver()).status === 403, "停用后拒绝回调");
	check((await api(`/api/im/bots/${id}/ping`, "POST", { staffId: "staff-test" })).status === 403, "停用后拒绝测试消息");
	console.log(`企业微信端到端全部通过：${checks} 项`);
} finally { if (id) await api(`/api/im/bots/${id}`, "DELETE"); }
