/**
 * P8 IM Bot 网关自检（**不需要起服务、不联网**）：`npm run im:selftest`
 *
 * 覆盖：
 *   1. 钉钉加签：正确 / 错误 / 过期 / 秒级时间戳 / URL 编码把 `+` 解成空格
 *   2. AES 解密：用同一套钉钉算法构造真实 encrypt 值做往返，错 key 抛错
 *   3. msg_signature：正确 / 错误 / 过期
 *   4. 回调文本解析：去 @机器人 前缀、折叠空白、表情保留、非文本忽略
 *   5. 幂等 LRU：200 条容量与淘汰
 *   6. 凭证：AES-256-GCM 落库（不是明文）、出参只有掩码、必填校验、aesKey 形状校验
 *   7. im_sessions 映射：查找 / 创建 / 同会话只一行 / last_msg_id 更新 / 计数
 *   8. 出站：fake outbox、真实传输的重试计数与退避、token 缓存、最终失败写审计
 *   9. 传输选择与权限映射、回调公开路径
 *
 * 临时库放在系统临时目录，跑完删掉；不碰仓库里的 data/。
 */

import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { permissionFor } from "../server/auth/roles.js";
import { isPublicApiPath } from "../server/auth/service.js";
import { openStore } from "../server/db/index.js";
import type { Storage } from "../server/db/types.js";
import {
	cleanDingText,
	decryptDingTalkEncrypt,
	dingTalkMsgSignature,
	dingTalkSign,
	MsgIdLru,
	parseDingTalkMessage,
	verifyEncryptedRequest,
	verifySignedRequest,
} from "../server/im/dingtalk.js";
import { ImError } from "../server/im/errors.js";
import { OutboundService, resolveDingTalkTransport } from "../server/im/outbound.js";
import type { HttpJsonPost, OutboundBot } from "../server/im/outbound.js";
import { ImStore } from "../server/im/store.js";
import { decryptSecret, encryptSecret, maskSecret } from "../server/models/crypto.js";

let passed = 0;

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
	await fn();
	passed += 1;
	console.log(`  ✓ ${name}`);
}

function tempStore(): { store: Storage; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "biz-agent-im-"));
	const store = openStore({ dbPath: join(dir, "im.db") });
	return {
		store,
		cleanup: () => {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

/** 钉钉后台那种 43 位 EncodingAESKey（base64 解出 32 字节）。 */
function randomAesKey(): string {
	return randomBytes(32).toString("base64").slice(0, 43);
}

/**
 * 按钉钉规则造一个真实 encrypt 值（与解密实现互相独立，避免"自己测自己"）：
 * random(16) + len(4 BE) + msg + corpId，再按 32 字节块做 PKCS#7 填充后 AES-256-CBC。
 */
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

const APP_SECRET = "sk-im-selftest-secret-1234";
const CALLBACK_TOKEN = "im-callback-token-5678";
const AES_KEY = randomAesKey();
const SIGN_NOW = Date.UTC(2026, 0, 2, 3, 4, 5);

async function testSign(): Promise<void> {
	console.log("\n[1] 钉钉加签");

	await check("正确 timestamp + sign 通过", () => {
		const timestamp = String(SIGN_NOW);
		const sign = dingTalkSign(timestamp, APP_SECRET);
		const result = verifySignedRequest({ timestamp, sign }, APP_SECRET, SIGN_NOW);
		assert.equal(result.ok, true, JSON.stringify(result));
	});

	await check("错误 sign 被拒绝（401 签名校验失败）", () => {
		const timestamp = String(SIGN_NOW);
		const result = verifySignedRequest({ timestamp, sign: "AAAA" }, APP_SECRET, SIGN_NOW);
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.status, 401);
			assert.match(result.error, /签名校验失败/);
		}
	});

	await check("时间戳与当前差超过 1 小时 → 401 签名已过期", () => {
		const timestamp = String(SIGN_NOW - 2 * 60 * 60 * 1000);
		const sign = dingTalkSign(timestamp, APP_SECRET);
		const result = verifySignedRequest({ timestamp, sign }, APP_SECRET, SIGN_NOW);
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.status, 401);
			assert.match(result.error, /签名已过期/);
		}
	});

	await check("兼容秒级时间戳", () => {
		const seconds = String(Math.floor(SIGN_NOW / 1000));
		const sign = dingTalkSign(seconds, APP_SECRET);
		const result = verifySignedRequest({ timestamp: seconds, sign }, APP_SECRET, SIGN_NOW);
		assert.equal(result.ok, true, JSON.stringify(result));
	});

	await check("sign 里的 `+` 被 URL 解码成空格后仍能通过", () => {
		let timestamp = "";
		let sign = "";
		for (let offset = 0; offset < 5000; offset += 1) {
			const candidate = String(SIGN_NOW + offset);
			const value = dingTalkSign(candidate, APP_SECRET);
			if (value.includes("+")) {
				timestamp = candidate;
				sign = value;
				break;
			}
		}
		assert.ok(timestamp.length > 0, "没找到带 + 的签名，测试数据不足");
		const result = verifySignedRequest({ timestamp, sign: sign.replace(/\+/g, " ") }, APP_SECRET, SIGN_NOW);
		assert.equal(result.ok, true, JSON.stringify(result));
	});
}

async function testAes(): Promise<void> {
	console.log("\n[2] AES 解密与 msg_signature");

	await check("AES 解密往返：构造真实 encrypt 值能解回 JSON", () => {
		const body = {
			msgtype: "text",
			text: { content: "查一下华南的销售数据" },
			conversationId: "cid-aes-1",
			msgId: "msg-aes-1",
		};
		const encrypt = buildEncrypt(AES_KEY, JSON.stringify(body), "ding-corp-1");
		const decoded = decryptDingTalkEncrypt(encrypt, AES_KEY);
		assert.deepEqual(JSON.parse(decoded), body);
	});

	await check("AES 解密用错 aesKey 会抛错（不会返回半截明文）", () => {
		const encrypt = buildEncrypt(AES_KEY, JSON.stringify({ ok: true }), "corp");
		assert.throws(() => decryptDingTalkEncrypt(encrypt, randomAesKey()));
	});

	await check("msg_signature 正确时返回解密后的回调体", () => {
		const timestamp = String(SIGN_NOW);
		const nonce = "nonce-1";
		const body = { msgtype: "text", text: { content: "你好" }, conversationId: "cid-aes-2", msgId: "m-2" };
		const encrypt = buildEncrypt(AES_KEY, JSON.stringify(body), "corp");
		const msgSignature = dingTalkMsgSignature(CALLBACK_TOKEN, timestamp, nonce, encrypt);
		const result = verifyEncryptedRequest(
			{ timestamp, nonce, encrypt, msg_signature: msgSignature },
			CALLBACK_TOKEN,
			AES_KEY,
			SIGN_NOW,
		);
		assert.equal(result.ok, true, JSON.stringify(result));
		if (result.ok) {
			assert.equal(result.body.conversationId, "cid-aes-2");
			assert.equal(result.timestamp, timestamp);
		}
	});

	await check("msg_signature 错误 → 401", () => {
		const timestamp = String(SIGN_NOW);
		const encrypt = buildEncrypt(AES_KEY, JSON.stringify({ conversationId: "c" }), "corp");
		const result = verifyEncryptedRequest(
			{ timestamp, nonce: "n", encrypt, msg_signature: "bad-signature" },
			CALLBACK_TOKEN,
			AES_KEY,
			SIGN_NOW,
		);
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.status, 401);
			assert.match(result.error, /msg_signature/);
		}
	});

	await check("加密回调同样检查时间戳过期", () => {
		const timestamp = String(SIGN_NOW - 2 * 60 * 60 * 1000);
		const encrypt = buildEncrypt(AES_KEY, JSON.stringify({ conversationId: "c" }), "corp");
		const msgSignature = dingTalkMsgSignature(CALLBACK_TOKEN, timestamp, "n", encrypt);
		const result = verifyEncryptedRequest(
			{ timestamp, nonce: "n", encrypt, msg_signature: msgSignature },
			CALLBACK_TOKEN,
			AES_KEY,
			SIGN_NOW,
		);
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.status, 401);
			assert.match(result.error, /签名已过期/);
		}
	});
}

async function testText(): Promise<void> {
	console.log("\n[3] 回调文本解析");

	await check("去掉 @机器人 前缀、折叠空白、保留表情", () => {
		assert.equal(cleanDingText("  @机器人   你好 😀 \n  世界 \u3000 "), "你好 😀 世界");
		assert.equal(cleanDingText("@机器人 @小李 请处理"), "请处理");
		assert.equal(cleanDingText("正文里的 @张三 不能删"), "正文里的 @张三 不能删");
	});

	await check("解析文本回调的字段", () => {
		const parsed = parseDingTalkMessage({
			msgtype: "text",
			text: { content: "@机器人 统计一下" },
			senderStaffId: "staff-1",
			senderNick: "张三",
			conversationId: "cid-text-1",
			conversationType: "2",
			msgId: "msg-text-1",
		});
		assert.ok(parsed);
		assert.equal(parsed?.text, "统计一下");
		assert.equal(parsed?.senderStaffId, "staff-1");
		assert.equal(parsed?.conversationId, "cid-text-1");
		assert.equal(parsed?.msgId, "msg-text-1");
	});

	await check("非文本 / 没有会话 id 的回调返回 null（网关回 200 ignored）", () => {
		assert.equal(parseDingTalkMessage({ msgtype: "markdown", text: { content: "x" }, conversationId: "c" }), null);
		assert.equal(parseDingTalkMessage({ msgtype: "text", text: { content: "x" } }), null);
		assert.equal(parseDingTalkMessage({ msgtype: "text", text: { content: "   " }, conversationId: "c" }), null);
	});
}

async function testIdempotency(): Promise<void> {
	console.log("\n[4] 幂等 LRU");

	await check("默认容量 200，超出后淘汰最老的 msgId", () => {
		const lru = new MsgIdLru();
		for (let index = 0; index < 200; index += 1) {
			lru.add(`msg-${index}`);
		}
		assert.equal(lru.size, 200);
		assert.equal(lru.has("msg-0"), true);
		lru.add("msg-200");
		assert.equal(lru.size, 200);
		assert.equal(lru.has("msg-0"), false);
		assert.equal(lru.has("msg-200"), true);
	});

	await check("重复 add 不增加计数", () => {
		const lru = new MsgIdLru(3);
		lru.add("a");
		lru.add("a");
		lru.add("b");
		assert.equal(lru.size, 2);
	});
}

async function testCredentials(store: Storage): Promise<void> {
	console.log("\n[5] 凭证加密与掩码");

	await check("凭证 AES-256-GCM 加密落库，出参只有掩码", () => {
		const imStore = new ImStore(store);
		const view = imStore.create({
			name: "自检机器人",
			appKey: "ding-im-app-key",
			appSecret: APP_SECRET,
			robotCode: "ding-im-robot",
			callbackToken: CALLBACK_TOKEN,
			aesKey: AES_KEY,
		});
		const row = store.getImBot(view.id)!;
		assert.match(row.appSecretEnc, /^\{"v":1,/);
		assert.equal(row.appSecretEnc.includes(APP_SECRET), false);
		assert.equal(decryptSecret(row.appSecretEnc), APP_SECRET);
		assert.equal(decryptSecret(row.callbackTokenEnc), CALLBACK_TOKEN);
		assert.equal(decryptSecret(row.aesKeyEnc!), AES_KEY);
		assert.equal(view.appSecretMasked, maskSecret(APP_SECRET));
		assert.equal(view.hasAesKey, true);
		assert.equal(JSON.stringify(view).includes(APP_SECRET), false);
		assert.equal(JSON.stringify(view).includes(CALLBACK_TOKEN), false);
		assert.equal(view.sessionCount, 0);
		assert.equal(view.lastCallbackAt, null);

		// 直接复用 P6 的加解密工具做一次显式往返（防止以后换实现时静默失配）
		assert.equal(decryptSecret(encryptSecret("plain-value")), "plain-value");
	});

	await check("缺少必填凭证 → 400；aesKey 形状不对 → 400", () => {
		const imStore = new ImStore(store);
		assert.throws(
			() =>
				imStore.create({
					name: "缺 appSecret",
					appKey: "k",
					robotCode: "r",
					callbackToken: "t",
				}),
			(error: unknown) => error instanceof ImError && error.status === 400,
		);
		assert.throws(
			() =>
				imStore.create({
					name: "坏 aesKey",
					appKey: "k",
					appSecret: "s",
					robotCode: "r",
					callbackToken: "t",
					aesKey: "not-base64!!",
				}),
			(error: unknown) => error instanceof ImError && error.status === 400,
		);
	});
}

async function testSessions(store: Storage): Promise<void> {
	console.log("\n[6] im_sessions 映射");

	await check("同一 conversationId 只建一行，last_msg_id 随消息更新", () => {
		const imStore = new ImStore(store);
		const view = imStore.create({
			name: "映射机器人",
			appKey: "ding-map-key",
			appSecret: "ding-map-secret",
			robotCode: "ding-map-robot",
			callbackToken: "ding-map-token",
		});
		const first = imStore.upsertSession(view.id, "conv-1", {
			sessionId: "session-1",
			externalUserId: "staff-1",
			lastMsgId: "msg-1",
			now: 1000,
		});
		assert.equal(first.conversationId, "conv-1");
		assert.equal(first.sessionId, "session-1");
		assert.equal(imStore.countSessions(view.id), 1);

		const found = imStore.findSession(view.id, "conv-1");
		assert.equal(found?.lastMsgId, "msg-1");
		assert.equal(found?.externalUserId, "staff-1");

		const second = imStore.upsertSession(view.id, "conv-1", {
			sessionId: "session-1",
			externalUserId: "staff-1",
			lastMsgId: "msg-2",
			now: 2000,
		});
		assert.equal(second.id, first.id);
		assert.equal(second.lastMsgId, "msg-2");
		assert.equal(imStore.countSessions(view.id), 1);

		imStore.upsertSession(view.id, "conv-2", {
			sessionId: "session-2",
			externalUserId: "staff-2",
			lastMsgId: "msg-3",
			now: 3000,
		});
		assert.equal(imStore.countSessions(view.id), 2);
		assert.equal(imStore.view(view.id).sessionCount, 2);
	});

	await check("findForCallback：唯一启用时兜底、多个启用时必须带 botId", () => {
		const imStore = new ImStore(store);
		const first = store.listImBots().find((row) => row.name === "映射机器人")!;
		// 先把别的机器人停用，保证"唯一启用"这个前提成立
		for (const row of store.listImBots()) {
			if (row.id !== first.id && row.enabled) {
				imStore.update(row.id, { enabled: false });
			}
		}
		assert.equal(imStore.findForCallback().id, first.id);
		const second = imStore.create({
			name: "第二个机器人",
			appKey: "ding-map-key-2",
			appSecret: "ding-map-secret-2",
			robotCode: "ding-map-robot-2",
			callbackToken: "ding-map-token-2",
		});
		assert.throws(
			() => imStore.findForCallback(),
			(error: unknown) => error instanceof ImError && error.status === 400,
		);
		assert.equal(imStore.findForCallback(second.id).id, second.id);
		imStore.update(second.id, { enabled: false });
		assert.equal(imStore.findForCallback().id, first.id);
		assert.throws(
			() => imStore.findForCallback(second.id),
			(error: unknown) => error instanceof ImError && error.status === 403,
		);
	});
}

async function testOutbound(store: Storage): Promise<void> {
	console.log("\n[7] 出站与 outbox");

	const botRow = store.listImBots().find((row) => row.name === "自检机器人")!;
	const bot: OutboundBot = {
		id: botRow.id,
		name: botRow.name,
		appKey: botRow.appKey,
		appSecret: decryptSecret(botRow.appSecretEnc),
		robotCode: botRow.robotCode,
	};

	await check("fake 传输写内存 outbox（不发网络）", async () => {
		const outbound = new OutboundService({ storage: store, transport: "fake", now: () => 123 });
		assert.equal(outbound.fake, true);
		await outbound.send(bot, { conversationId: "conv-out-1" }, "第一条回复");
		await outbound.send(bot, { staffId: "staff-1" }, "第二条回复");
		const items = outbound.outbox();
		assert.equal(items.length, 2);
		assert.equal(items[0]?.content, "第一条回复");
		assert.equal(items[0]?.target.conversationId, "conv-out-1");
		assert.equal(items[1]?.target.staffId, "staff-1");
		assert.equal(items[0]?.botId, bot.id);
		assert.equal(items[0]?.attempts, 1);
		outbound.clearOutbox();
		assert.equal(outbound.outbox().length, 0);
	});

	await check("真实传输失败重试 2 次（300ms / 900ms），第三次成功", async () => {
		let sendAttempts = 0;
		let tokenCalls = 0;
		const request: HttpJsonPost = async (url) => {
			if (url.includes("accessToken")) {
				tokenCalls += 1;
				return { status: 200, body: { accessToken: "token-1", expireIn: 7200 } };
			}
			sendAttempts += 1;
			if (sendAttempts < 3) {
				return { status: 500, body: { message: "internal error" } };
			}
			return { status: 200, body: { processQueryKey: "mq-1" } };
		};
		const delays: number[] = [];
		const outbound = new OutboundService({
			storage: store,
			transport: "real",
			request,
			now: () => 1_000_000,
			sleep: async (ms) => {
				delays.push(ms);
			},
		});
		const result = await outbound.send(bot, { conversationId: "conv-real-1" }, "真实发送");
		assert.equal(result.ok, true, JSON.stringify(result));
		assert.equal(result.attempts, 3);
		assert.equal(result.transport, "real");
		assert.deepEqual(delays, [300, 900]);
		assert.equal(tokenCalls, 1, "access token 应缓存，三次尝试只换一次");
	});

	await check("token 缓存命中：两次成功发送只换一次 token", async () => {
		let tokenCalls = 0;
		const request: HttpJsonPost = async (url) => {
			if (url.includes("accessToken")) {
				tokenCalls += 1;
				return { status: 200, body: { accessToken: "token-2", expireIn: 7200 } };
			}
			return { status: 200, body: { processQueryKey: "mq-2" } };
		};
		const outbound = new OutboundService({
			storage: store,
			transport: "real",
			request,
			now: () => 2_000_000,
			sleep: async () => {},
		});
		await outbound.send(bot, { conversationId: "c1" }, "一");
		await outbound.send(bot, { conversationId: "c2" }, "二");
		assert.equal(tokenCalls, 1);
	});

	await check("最终失败写 audit_logs（im.send.failed），尝试 3 次", async () => {
		let attempts = 0;
		const request: HttpJsonPost = async (url) => {
			if (url.includes("accessToken")) {
				return { status: 200, body: { accessToken: "token-3", expireIn: 7200 } };
			}
			attempts += 1;
			return { status: 503, body: { message: "unavailable" } };
		};
		const outbound = new OutboundService({
			storage: store,
			transport: "real",
			request,
			now: () => 3_000_000,
			sleep: async () => {},
		});
		const result = await outbound.send(bot, { conversationId: "conv-fail" }, "发不出去");
		assert.equal(result.ok, false);
		assert.equal(result.attempts, 3);
		assert.equal(attempts, 3);
		assert.match(result.error ?? "", /503/);
		const audits = store.listAudit({ limit: 10, offset: 0, action: "im.send.failed" });
		assert.ok(audits.length >= 1, "最终失败应写一条审计");
		assert.equal(audits[0]?.targetId, bot.id);
	});
}

async function testMisc(): Promise<void> {
	console.log("\n[8] 传输选择、权限与公开路径");

	await check("DINGTALK_TRANSPORT / NODE_ENV 决定 fake / real", () => {
		const savedTransport = process.env.DINGTALK_TRANSPORT;
		const savedNodeEnv = process.env.NODE_ENV;
		try {
			delete process.env.DINGTALK_TRANSPORT;
			process.env.NODE_ENV = "test";
			assert.equal(resolveDingTalkTransport(), "fake");
			process.env.NODE_ENV = "production";
			assert.equal(resolveDingTalkTransport(), "real");
			assert.equal(resolveDingTalkTransport("fake"), "fake");
			assert.equal(resolveDingTalkTransport("REAL"), "real");
			process.env.DINGTALK_TRANSPORT = "fake";
			assert.equal(resolveDingTalkTransport(), "fake");
		} finally {
			if (savedTransport === undefined) {
				delete process.env.DINGTALK_TRANSPORT;
			} else {
				process.env.DINGTALK_TRANSPORT = savedTransport;
			}
			if (savedNodeEnv === undefined) {
				delete process.env.NODE_ENV;
			} else {
				process.env.NODE_ENV = savedNodeEnv;
			}
		}
	});

	await check("权限映射：读 workflow.read、写 workflow.write、outbox audit.read", () => {
		assert.equal(permissionFor("GET", "/api/im/bots"), "workflow.read");
		assert.equal(permissionFor("POST", "/api/im/bots"), "workflow.write");
		assert.equal(permissionFor("PATCH", "/api/im/bots/imb-1"), "workflow.write");
		assert.equal(permissionFor("DELETE", "/api/im/bots/imb-1"), "workflow.write");
		assert.equal(permissionFor("POST", "/api/im/bots/imb-1/ping"), "workflow.write");
		assert.equal(permissionFor("GET", "/api/im/outbox"), "audit.read");
	});

	await check("只有钉钉回调是公开路径，机器人管理接口仍要登录", () => {
		assert.equal(isPublicApiPath("/api/im/dingtalk/callback"), true);
		assert.equal(isPublicApiPath("/api/im/wecom/callback"), true);
		assert.equal(isPublicApiPath("/api/im/bots"), false);
		assert.equal(isPublicApiPath("/api/im/outbox"), false);
		assert.equal(isPublicApiPath("/api/health"), true);
		assert.equal(isPublicApiPath("/api/sessions"), false);
	});
}

async function main(): Promise<void> {
	// 固定加密密钥：自检不依赖 .env，也不让随机密钥的 warn 干扰输出
	process.env.SECRET_KEY = "im-selftest-secret-key";
	const { store, cleanup } = tempStore();
	try {
		await testSign();
		await testAes();
		await testText();
		await testIdempotency();
		await testCredentials(store);
		await check("企业微信配置必填 AES、校验 AgentId 并隔离平台回调", () => {
			const im = new ImStore(store);
			const body = { platform: "wecom", name: "企业微信测试", appKey: "ww-corp", appSecret: "secret", robotCode: "1000002", callbackToken: "token", aesKey: randomAesKey() };
			assert.throws(() => im.create({ ...body, aesKey: "" }), /EncodingAESKey/);
			assert.throws(() => im.create({ ...body, robotCode: "abc" }), /AgentId/);
			const bot = im.create(body);
			assert.equal(bot.platform, "wecom");
			assert.equal(im.findForCallback(bot.id, "wecom").appKey, "ww-corp");
			assert.throws(() => im.findForCallback(bot.id), /平台/);
			assert.throws(() => im.update(bot.id, { aesKey: "" }), /EncodingAESKey/);
			assert.throws(() => im.update(bot.id, { platform: "dingtalk" }), /更换平台/);
			assert.equal(im.outboundOf(im.requireRow(bot.id)).platform, "wecom");
		});
		await testSessions(store);
		await testOutbound(store);
		await testMisc();
	} finally {
		cleanup();
	}
	console.log(`\n全部通过：${passed} 项检查`);
}

void main().catch((error: unknown) => {
	console.error(`\n✗ 自检失败：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	process.exit(1);
});
