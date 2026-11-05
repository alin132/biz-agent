/** 企业微信自建应用协议自检：本机 HTTP + 注入会话，不联网、不写数据库。 */
import assert from "node:assert/strict";
import { createCipheriv, createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { ImBotRecord, ImSessionRecord } from "../server/db/types.js";
import type { SessionHub, WireEvent } from "../server/session.js";
import type { GatewaySession } from "../server/im/dingtalk.js";
import { ImError } from "../server/im/errors.js";
import type { ImStore } from "../server/im/store.js";
import type { OutboundService } from "../server/im/outbound.js";
import { WeComGateway, decryptWecomMessage, encryptWecomMessage, parseWecomXml, wecomMsgSignature } from "../server/im/wecom.js";

const key = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64").slice(0, -1);
const corpId = "ww-selftest";
const token = "自检token";
const now = 1_800_000_000_000;
let checks = 0;
function check(name: string, action: () => void): void { action(); checks++; console.log("通过：" + name); }

// 独立构造明文包，避免只验证同一对加解密函数互相抵消的错误。
function fixture(message: string, paddingValue?: number): string {
	const text = Buffer.from(message);
	const size = Buffer.alloc(4); size.writeUInt32BE(text.length);
	const raw = Buffer.concat([Buffer.alloc(16, 7), size, text, Buffer.from(corpId)]);
	const padding = 32 - raw.length % 32;
	const cipher = createCipheriv("aes-256-cbc", Buffer.from(key + "=", "base64"), Buffer.from(key + "=", "base64").subarray(0, 16));
	cipher.setAutoPadding(false);
	return Buffer.concat([cipher.update(Buffer.concat([raw, Buffer.alloc(padding, paddingValue ?? padding)])), cipher.final()]).toString("base64");
}
check("中文 AES 协议包解密", () => assert.equal(decryptWecomMessage(fixture("你好😀"), key, corpId), "你好😀"));
check("加解密往返覆盖各填充长度", () => { for (let i = 0; i < 64; i++) assert.equal(decryptWecomMessage(encryptWecomMessage("中" + "a".repeat(i), key, corpId), key, corpId), "中" + "a".repeat(i)); });
check("SHA1 排序签名", () => assert.equal(wecomMsgSignature("b", "d", "a", "c"), createHash("sha1").update("abcd").digest("hex")));
check("拒绝错误企业 ID", () => assert.throws(() => decryptWecomMessage(fixture("文本"), key, "其他企业")));
check("拒绝错误密钥和非 Base64", () => { assert.throws(() => decryptWecomMessage("abc!", key, corpId)); assert.throws(() => decryptWecomMessage(fixture("文本"), "短密钥", corpId)); });
check("拒绝非法填充", () => assert.throws(() => decryptWecomMessage(fixture("文本", 0), key, corpId)));
check("XML CDATA 与实体解码", () => assert.equal(parseWecomXml("<xml><Content><![CDATA[中<&]]>&amp;&#x1f600;</Content></xml>").Content, "中<&&😀"));
for (const xml of ['<!DOCTYPE xml [<!ENTITY x SYSTEM "file:///secret">]><xml/>', '<xml><A>1</B></xml>', '<xml><Encrypt>a</Encrypt><Encrypt>b</Encrypt></xml>', '<xml><A>&unknown;</A></xml>', '<xml a="1"/>', '<xml><A>&#0;</A></xml>', '<xml>' + '<A>'.repeat(9) + '</A>'.repeat(9) + '</xml>']) {
	check("拒绝不安全或畸形 XML", () => assert.throws(() => parseWecomXml(xml)));
}
check("XML 大小限制", () => assert.throws(() => parseWecomXml("x".repeat(1024 * 1024 + 1))));

const bot = { id: "wecom-test", name: "自检", platform: "wecom", appKey: corpId, robotCode: "1000002", workflowId: "auto-flow", enabled: true } as unknown as ImBotRecord;
const mappings = new Map<string, ImSessionRecord>();
const sessions = new Map<string, GatewaySession>();
const inputs: string[] = [];
const sent: { platform?: string; staffId?: string; text: string }[] = [];
let created = 0;
let active = 0;
let maxActive = 0;
let mode: "normal" | "timeout" | "error" = "normal";
let callbacks = 0;
const store = {
	findForCallback(id: string, platform: string) {
		assert.equal(platform, "wecom");
		if (id !== bot.id) throw new ImError(404, "机器人不存在");
		if (!bot.enabled) throw new ImError(403, "机器人已停用");
		return bot;
	},
	credentialsOf: () => ({ callbackToken: token, aesKey: key, appSecret: "测试凭证" }),
	markCallback: () => { callbacks++; },
	findSession: (_botId: string, conversationId: string) => mappings.get(conversationId),
	upsertSession: (_botId: string, conversationId: string, input: object) => { const row = { conversationId, ...input } as ImSessionRecord; mappings.set(conversationId, row); return row; },
	outboundOf: () => ({ id: bot.id, name: bot.name, platform: "wecom", appKey: corpId, robotCode: "1000002", appSecret: "测试凭证" }),
} as unknown as ImStore;
const hub = {
	get: (id: string) => sessions.get(id),
	create: () => {
		created++;
		const listeners = new Set<(event: WireEvent) => void>();
		const session: GatewaySession = {
			id: "session-" + created,
			setTitle: (title) => title,
			subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
			async send(text) {
				inputs.push(text);
				active++; maxActive = Math.max(maxActive, active);
				try {
					if (mode === "timeout") return;
					if (mode === "error") throw new Error("自检错误");
					await new Promise<void>((resolve) => setImmediate(resolve));
					for (const listener of listeners) listener({ type: "done", text: "回复：" + text } as WireEvent);
				} finally { active--; }
			},
		};
		sessions.set(session.id, session);
		return session;
	},
} as unknown as Pick<SessionHub, "create" | "get">;
const outbound = { async send(outBot: { platform?: string }, target: { staffId?: string }, text: string) { sent.push({ platform: outBot.platform, staffId: target.staffId, text }); return { ok: true, attempts: 1 }; } } as unknown as OutboundService;
let gateway = new WeComGateway({ store, hub, outbound, now: () => now, timeoutMs: 15 });
const server = createServer((req, res) => { void gateway.handleCallback(req, res, new URL(req.url!, "http://localhost")); });
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
function url(encrypted: string, get = false): URL {
	const result = new URL(base);
	const timestamp = String(now / 1000);
	result.search = new URLSearchParams({ botId: bot.id, timestamp, nonce: "nonce-中文", msg_signature: wecomMsgSignature(token, timestamp, "nonce-中文", encrypted), ...(get ? { echostr: encrypted } : {}) }).toString();
	return result;
}
function message(id: string, text = "你好", type = "text", sender = "zhangsan"): string {
	return '<xml><ToUserName>' + corpId + '</ToUserName><FromUserName>' + sender + '</FromUserName><CreateTime>1800000000</CreateTime><MsgType>' + type + '</MsgType><Content><![CDATA[' + text + ']]></Content><MsgId>' + id + '</MsgId><AgentID>1000002</AgentID></xml>';
}
async function post(xml: string): Promise<Response> {
	const encrypted = fixture(xml);
	return fetch(url(encrypted), { method: "POST", body: '<xml><Encrypt><![CDATA[' + encrypted + ']]></Encrypt><AgentID>1000002</AgentID></xml>' });
}
try {
	const echo = await fetch(url(fixture("随机验证字符串+中文"), true));
	check("GET 返回解密后的原始 echostr", () => { assert.equal(echo.status, 200); });
	const echoText = await echo.text();
	check("GET 正文精确匹配", () => assert.equal(echoText, "随机验证字符串+中文"));
	for (const [label, mutate, expected] of [
		["缺少 botId", (u: URL) => u.searchParams.delete("botId"), 400],
		["重复 botId", (u: URL) => u.searchParams.append("botId", bot.id), 400],
		["错误签名", (u: URL) => u.searchParams.set("msg_signature", "0".repeat(40)), 401],
		["过期时间戳", (u: URL) => u.searchParams.set("timestamp", "1"), 401],
		["机器人不存在", (u: URL) => u.searchParams.set("botId", "missing"), 404],
	] as const) {
		const requestUrl = url(fixture("echo"), true); mutate(requestUrl);
		const response = await fetch(requestUrl); check(label, () => assert.equal(response.status, expected));
	}
	bot.enabled = false;
	const disabled = await fetch(url(fixture("echo"), true));
	check("停用机器人", () => assert.equal(disabled.status, 403)); bot.enabled = true;
	const wrongCorp = encryptWecomMessage("echo", key, "wrong-corp");
	assert.equal((await fetch(url(wrongCorp, true))).status, 400); checks++;
	const first = await post(message("msg-1"));
	check("POST 快速确认", () => assert.equal(first.status, 200)); assert.equal(await first.text(), "success");
	await Promise.all([post(message("msg-1")), post(message("msg-2", "第二轮")), post(message("msg-3", "第三轮"))]);
	await gateway.drain();
	check("消息幂等与同会话串行", () => { assert.deepEqual(inputs, ["你好", "第二轮", "第三轮"]); assert.equal(maxActive, 1); assert.equal(created, 1); });
	check("应用消息发给原始员工", () => { assert.equal(sent.length, 3); assert.deepEqual(sent[0], { platform: "wecom", staffId: "zhangsan", text: "回复：你好" }); });
	gateway = new WeComGateway({ store, hub, outbound, now: () => now, timeoutMs: 15 });
	await post(message("msg-3")); await gateway.drain();
	check("重启后 lastMsgId 去重", () => assert.equal(sent.length, 3));
	await post(message("event-1", "", "event")); await gateway.drain();
	check("非文本事件确认后忽略", () => assert.equal(sent.length, 3));
	assert.equal((await post(message("bad-agent").replace("1000002", "999"))).status, 400); checks++;
	mode = "timeout"; await post(message("msg-timeout")); await gateway.drain();
	check("超时回复", () => assert.equal(sent.at(-1)!.text, "处理超时"));
	mode = "error"; await post(message("msg-error")); await gateway.drain();
	check("会话错误回复", () => assert.match(sent.at(-1)!.text, /处理失败：自检错误/));
	check("仅合法回调更新时间", () => assert.ok(callbacks >= 6));
	console.log("企业微信自检全部通过，共 " + checks + " 项");
} finally {
	await gateway.drain();
	await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
