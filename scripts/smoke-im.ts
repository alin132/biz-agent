/**
 * P8 IM Bot 网关端到端冒烟（要一个 `DINGTALK_TRANSPORT=fake` 的实例在跑）：`npm run smoke:im`
 *
 * 起服务（隔离实例，别碰 4317；用临时库，跑完删）：
 *   PowerShell:
 *     $env:PORT="4380"; $env:DB_PATH="$PWD\data\g26-im.db"; $env:DINGTALK_TRANSPORT="fake"
 *     $env:LLM_DISABLE="1"; $env:AUTH_MODE="off"; npm run dev
 *   然后：
 *     $env:SMOKE_IM_BASE="http://127.0.0.1:4380"; npm run smoke:im
 *
 * 覆盖：建机器人（掩码、明文不回）→ 正确加签回调 → outbox 收到回复 → 同 msgId 幂等
 *       → 错签名 401 → 过期时间戳 401 → 同一 conversationId 两条消息只映射一个内部会话
 *       → outbox 2 条 → ping 进 outbox → PATCH 改属性/停用 → 停用后回调 403
 *       → 删除机器人（连带删映射）→ 回调 404。
 */

import { createCipheriv, createHash, createHmac, randomBytes } from "node:crypto";

const BASE = (process.env.SMOKE_IM_BASE ?? "http://127.0.0.1:4380").replace(/\/$/, "");

const APP_SECRET = "smoke-im-app-secret-1234";
const CALLBACK_TOKEN = "smoke-im-callback-token-5678";
const AES_KEY = process.env.SMOKE_IM_AES_KEY ?? "";

let assertions = 0;

function fail(message: string): never {
	console.error(`✗ ${message}`);
	process.exit(1);
}

function assert(condition: boolean, message: string): void {
	if (!condition) {
		fail(message);
	}
	assertions += 1;
	console.log(`  ✓ ${message}`);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Wire {
	status: number;
	body: Record<string, unknown>;
}

async function request(method: string, path: string, body?: unknown): Promise<Wire> {
	const headers: Record<string, string> = {};
	if (body !== undefined) {
		headers["content-type"] = "application/json";
	}
	const response = await fetch(`${BASE}${path}`, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await response.text();
	let parsed: Record<string, unknown> = {};
	if (text.length > 0) {
		try {
			parsed = JSON.parse(text) as Record<string, unknown>;
		} catch {
			parsed = { raw: text };
		}
	}
	return { status: response.status, body: parsed };
}

/** 与 server/im/dingtalk.ts 的算法一致：HMAC-SHA256(key=appSecret) over `${timestamp}\n${appSecret}`。 */
function dingTalkSign(timestamp: string, appSecret: string): string {
	return createHmac("sha256", appSecret).update(`${timestamp}\n${appSecret}`, "utf8").digest("base64");
}

/** 钉钉 AES 回调的 msg_signature：sort(token, timestamp, nonce, encrypt) 后 sha1。 */
function dingTalkMsgSignature(token: string, timestamp: string, nonce: string, encrypt: string): string {
	return createHash("sha1").update([token, timestamp, nonce, encrypt].sort().join(""), "utf8").digest("hex");
}

/** 按钉钉规则构造真实 encrypt 值（random(16)+len(4)+msg+corpId，PKCS#7 后 AES-256-CBC）。 */
function buildEncrypt(aesKey: string, message: string, corpId: string): string {
	const key = Buffer.from(aesKey.endsWith("=") ? aesKey : `${aesKey}=`, "base64");
	const iv = key.subarray(0, 16);
	const length = Buffer.alloc(4);
	length.writeUInt32BE(Buffer.byteLength(message, "utf8"));
	let plain = Buffer.concat([randomBytes(16), length, Buffer.from(message, "utf8"), Buffer.from(corpId, "utf8")]);
	const padding = 32 - (plain.length % 32);
	plain = Buffer.concat([plain, Buffer.alloc(padding, padding)]);
	const cipher = createCipheriv("aes-256-cbc", key, iv);
	cipher.setAutoPadding(false);
	return Buffer.concat([cipher.update(plain), cipher.final()]).toString("base64");
}

interface CallbackOptions {
	botId: string;
	msgId: string;
	conversationId: string;
	content: string;
	staffId?: string;
	nick?: string;
	/** 默认当前时间；过期用例传旧时间 */
	timestamp?: number;
	/** 覆盖签名（错签名用例） */
	sign?: string;
}

async function sendCallback(options: CallbackOptions): Promise<Wire> {
	const timestamp = String(options.timestamp ?? Date.now());
	const sign = options.sign ?? dingTalkSign(timestamp, APP_SECRET);
	const query = new URLSearchParams({ botId: options.botId, timestamp, sign });
	const payload = {
		msgtype: "text",
		text: { content: options.content },
		senderStaffId: options.staffId ?? "staff-1",
		senderNick: options.nick ?? "测试用户",
		conversationId: options.conversationId,
		conversationType: "2",
		msgId: options.msgId,
	};
	return request("POST", `/api/im/dingtalk/callback?${query.toString()}`, payload);
}

async function outboxCount(): Promise<number> {
	const response = await request("GET", "/api/im/outbox");
	if (response.status !== 200) {
		fail(
			`outbox 不可用（${response.status} ${JSON.stringify(response.body)}）：` +
				"实例必须用 DINGTALK_TRANSPORT=fake 起，见脚本头部注释",
		);
	}
	return Number(response.body.count ?? 0);
}

/** 轮询等到 outbox 到达期望条数（回调是"先回 200、后台处理"，所以要等）。 */
async function waitOutbox(expected: number, hint: string, timeoutMs = 20000): Promise<void> {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if ((await outboxCount()) >= expected) {
			return;
		}
		await sleep(100);
	}
	fail(`等待 outbox 达到 ${expected} 条超时（${hint}）`);
}

async function main(): Promise<void> {
	console.log(`P8 IM Bot 冒烟：${BASE}`);

	// ---------- 0. 前置 ----------
	const health = await request("GET", "/api/health");
	assert(health.status === 200 && health.body.ok === true, "健康探针可用");

	const initialOutbox = await outboxCount();
	const baseCount = initialOutbox;

	// ---------- 1. 建机器人 ----------
	console.log("\n[1] 建机器人（凭证只回掩码）");
	const created = await request("POST", "/api/im/bots", {
		name: "冒烟机器人",
		appKey: "smoke-im-app-key",
		appSecret: APP_SECRET,
		robotCode: "smoke-im-robot",
		callbackToken: CALLBACK_TOKEN,
		...(AES_KEY ? { aesKey: AES_KEY } : {}),
	});
	assert(created.status === 201, `POST /api/im/bots → 201（实际 ${created.status} ${JSON.stringify(created.body)}）`);
	const botId = String(created.body.id ?? "");
	assert(botId.length > 0, "返回机器人 id");
	const createdText = JSON.stringify(created.body);
	assert(!createdText.includes(APP_SECRET), "出参不含 appSecret 明文");
	assert(!createdText.includes(CALLBACK_TOKEN), "出参不含 callbackToken 明文");
	const masked = String(created.body.appSecretMasked ?? "");
	assert(masked.includes("****") && masked.endsWith("1234"), `appSecret 掩码形如 sk-****1234（实际 ${masked}）`);

	const list = await request("GET", "/api/im/bots");
	const items = Array.isArray(list.body.items) ? (list.body.items as Record<string, unknown>[]) : [];
	const listed = items.find((item) => item.id === botId);
	assert(list.status === 200 && listed !== undefined, "GET /api/im/bots 能查到刚建的机器人");
	assert(
		listed?.enabled === true && listed?.sessionCount === 0 && listed?.lastCallbackAt === null,
		"列表带 enabled / 会话数 0 / 最近回调时间为空",
	);

	// ---------- 2. 正确加签回调 → outbox ----------
	console.log("\n[2] 正确加签回调");
	const first = await sendCallback({
		botId,
		msgId: "msg-smoke-1",
		conversationId: "cid-smoke-1",
		content: "@机器人 帮我看看今天的工单",
	});
	assert(first.status === 200 && first.body.ok === true, `回调返回 200 { ok: true }（实际 ${first.status}）`);
	await waitOutbox(baseCount + 1, "第一轮回复");
	const outbox1 = await request("GET", "/api/im/outbox");
	const items1 = Array.isArray(outbox1.body.items) ? (outbox1.body.items as Record<string, unknown>[]) : [];
	const reply1 = items1[items1.length - 1];
	assert(String(reply1?.content ?? "").length > 0, "outbox 收到非空回复");
	assert(
		reply1?.botId === botId && (reply1?.target as Record<string, unknown> | undefined)?.conversationId === "cid-smoke-1",
		"回复带 botId 且发回同一个 conversationId",
	);

	// 内部会话：默认落到 auto-flow，标题「钉钉 · <发送人>」
	const sessions = await request("GET", "/api/sessions");
	const sessionItems = Array.isArray(sessions.body) ? (sessions.body as Record<string, unknown>[]) : [];
	const mappedSession = sessionItems.find((item) => item.title === "钉钉 · 测试用户");
	assert(
		mappedSession !== undefined && mappedSession.workflowId === "auto-flow",
		"回调映射到 auto-flow 内部会话，标题为「钉钉 · 测试用户」",
	);

	// 回调后最近回调时间应更新
	const afterCallback = await request("GET", "/api/im/bots");
	const afterItems = Array.isArray(afterCallback.body.items) ? (afterCallback.body.items as Record<string, unknown>[]) : [];
	const afterBot = afterItems.find((item) => item.id === botId);
	assert(typeof afterBot?.lastCallbackAt === "number" && Number(afterBot.lastCallbackAt) > 0, "最近回调时间已更新");

	// ---------- 3. 同一 msgId 幂等 ----------
	console.log("\n[3] 同一 msgId 幂等");
	const duplicate = await sendCallback({
		botId,
		msgId: "msg-smoke-1",
		conversationId: "cid-smoke-1",
		content: "@机器人 重复投递",
	});
	assert(duplicate.status === 200 && duplicate.body.duplicate === true, "重复 msgId 返回 200 { duplicate: true }");
	await sleep(500);
	assert((await outboxCount()) === baseCount + 1, "重复 msgId 不再产生出站消息");

	// ---------- 4. 错签名 / 过期时间戳 ----------
	console.log("\n[4] 签名校验失败路径");
	const badSignature = await sendCallback({
		botId,
		msgId: "msg-smoke-bad",
		conversationId: "cid-smoke-1",
		content: "@机器人 错签名",
		sign: "AAAA",
	});
	assert(badSignature.status === 401, `错误 sign → 401（实际 ${badSignature.status}）`);
	const expired = await sendCallback({
		botId,
		msgId: "msg-smoke-expired",
		conversationId: "cid-smoke-1",
		content: "@机器人 过期",
		timestamp: Date.now() - 2 * 60 * 60 * 1000,
	});
	assert(expired.status === 401, `过期 timestamp → 401（实际 ${expired.status}）`);
	assert(
		String(expired.body.error ?? "").includes("签名已过期"),
		`过期文案是「签名已过期」（实际 ${String(expired.body.error)}）`,
	);
	await sleep(300);
	assert((await outboxCount()) === baseCount + 1, "被拒绝的签名不会产生出站消息");

	// ---------- 5. 同一会话第二条消息 ----------
	console.log("\n[5] 同一 conversationId 的多轮");
	const second = await sendCallback({
		botId,
		msgId: "msg-smoke-2",
		conversationId: "cid-smoke-1",
		content: "@机器人   再来一条 😀",
		staffId: "staff-1",
	});
	assert(second.status === 200 && second.body.ok === true, "第二条消息回调 200");
	await waitOutbox(baseCount + 2, "第二轮回复");
	const outbox2 = await request("GET", "/api/im/outbox");
	const items2 = Array.isArray(outbox2.body.items) ? (outbox2.body.items as Record<string, unknown>[]) : [];
	assert(Number(outbox2.body.count) === baseCount + 2, "outbox 一共有 2 条（本轮新增）");

	const afterSecond = await request("GET", "/api/im/bots");
	const afterSecondItems = Array.isArray(afterSecond.body.items)
		? (afterSecond.body.items as Record<string, unknown>[])
		: [];
	const mapped = afterSecondItems.find((item) => item.id === botId);
	assert(mapped?.sessionCount === 1, `同一 conversationId 只映射一个内部会话（sessionCount=${String(mapped?.sessionCount)}）`);

	// ---------- 6. ping 进 outbox ----------
	console.log("\n[6] ping 测试消息");
	const ping = await request("POST", `/api/im/bots/${encodeURIComponent(botId)}/ping`, {});
	assert(ping.status === 200 && ping.body.ok === true, `ping → 200 ok（实际 ${ping.status} ${JSON.stringify(ping.body)}）`);
	assert(ping.body.transport === "fake", "ping 走 fake 传输");
	await waitOutbox(baseCount + 3, "ping 消息");

	// ---------- 7. AES 加密回调（可选模式） ----------
	console.log("\n[7] AES 加密回调");
	const aesKey = randomBytes(32).toString("base64").slice(0, 43);
	const aesBot = await request("POST", "/api/im/bots", {
		name: "AES 冒烟机器人",
		appKey: "smoke-im-aes-app-key",
		appSecret: "smoke-im-aes-app-secret",
		robotCode: "smoke-im-aes-robot",
		callbackToken: CALLBACK_TOKEN,
		aesKey,
	});
	assert(aesBot.status === 201 && aesBot.body.hasAesKey === true, "建带 aesKey 的机器人，hasAesKey=true");
	const aesBotId = String(aesBot.body.id ?? "");
	const aesTimestamp = String(Date.now());
	const aesNonce = "nonce-smoke-aes";
	const aesInner = {
		msgtype: "text",
		text: { content: "@机器人 请用 AES 回调回复" },
		senderStaffId: "staff-aes",
		senderNick: "AES 用户",
		conversationId: "cid-smoke-aes",
		conversationType: "2",
		msgId: "msg-smoke-aes-1",
	};
	const aesEncrypt = buildEncrypt(aesKey, JSON.stringify(aesInner), "ding-corp-smoke");
	const aesSignature = dingTalkMsgSignature(CALLBACK_TOKEN, aesTimestamp, aesNonce, aesEncrypt);
	const aesQuery = new URLSearchParams({
		botId: aesBotId,
		timestamp: aesTimestamp,
		nonce: aesNonce,
		encrypt: aesEncrypt,
		msg_signature: aesSignature,
	});
	const aesCallback = await request("POST", `/api/im/dingtalk/callback?${aesQuery.toString()}`, {});
	assert(aesCallback.status === 200 && aesCallback.body.ok === true, `AES 加密回调 → 200（实际 ${aesCallback.status}）`);
	await waitOutbox(baseCount + 4, "AES 回调的回复");
	const outboxAes = await request("GET", "/api/im/outbox");
	const itemsAes = Array.isArray(outboxAes.body.items) ? (outboxAes.body.items as Record<string, unknown>[]) : [];
	const replyAes = itemsAes[itemsAes.length - 1];
	assert(
		(replyAes?.target as Record<string, unknown> | undefined)?.conversationId === "cid-smoke-aes",
		"AES 解密出的 conversationId 正确用于出站",
	);
	const badMsgSignature = await request(
		"POST",
		`/api/im/dingtalk/callback?${new URLSearchParams({
			botId: aesBotId,
			timestamp: aesTimestamp,
			nonce: aesNonce,
			encrypt: aesEncrypt,
			msg_signature: "bad-signature",
		}).toString()}`,
		{},
	);
	assert(badMsgSignature.status === 401, `AES 回调 msg_signature 错 → 401（实际 ${badMsgSignature.status}）`);
	const aesRemoved = await request("DELETE", `/api/im/bots/${encodeURIComponent(aesBotId)}`);
	assert(aesRemoved.status === 200 && aesRemoved.body.removed === true, "删除 AES 机器人");

	// ---------- 8. PATCH 与停用 ----------
	console.log("\n[8] PATCH 与停用");
	const patched = await request("PATCH", `/api/im/bots/${encodeURIComponent(botId)}`, {
		name: "冒烟机器人（改名）",
	});
	assert(patched.status === 200 && patched.body.name === "冒烟机器人（改名）", "PATCH 改名成功");
	const disabled = await request("PATCH", `/api/im/bots/${encodeURIComponent(botId)}`, { enabled: false });
	assert(disabled.status === 200 && disabled.body.enabled === false, "PATCH 停用成功");
	const rejected = await sendCallback({
		botId,
		msgId: "msg-smoke-disabled",
		conversationId: "cid-smoke-1",
		content: "@机器人 停用了",
	});
	assert(rejected.status === 403, `停用后回调 → 403（实际 ${rejected.status}）`);
	const reEnabled = await request("PATCH", `/api/im/bots/${encodeURIComponent(botId)}`, { enabled: true });
	assert(reEnabled.status === 200 && reEnabled.body.enabled === true, "重新启用成功");

	// ---------- 9. 删除 ----------
	console.log("\n[9] 删除机器人");
	const removed = await request("DELETE", `/api/im/bots/${encodeURIComponent(botId)}`);
	assert(removed.status === 200 && removed.body.removed === true, "DELETE 返回 removed=true");
	assert(Number(removed.body.sessionsRemoved) === 1, `删除连带删掉 1 条会话映射（实际 ${String(removed.body.sessionsRemoved)}）`);
	const gone = await sendCallback({
		botId,
		msgId: "msg-smoke-gone",
		conversationId: "cid-smoke-1",
		content: "@机器人 已经删了",
	});
	assert(gone.status === 404, `删除后回调 → 404（实际 ${gone.status}）`);
	const finalList = await request("GET", "/api/im/bots");
	const finalItems = Array.isArray(finalList.body.items) ? (finalList.body.items as Record<string, unknown>[]) : [];
	assert(!finalItems.some((item) => item.id === botId), "列表里不再有被删的机器人");

	console.log(`\n全部通过：${assertions} 项检查`);
	if (items2.length < 2) {
		fail("outbox 断言异常：第二轮之后应有至少 2 条");
	}
}

void main().catch((error: unknown) => {
	console.error(`\n✗ 冒烟失败：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	process.exit(1);
});
