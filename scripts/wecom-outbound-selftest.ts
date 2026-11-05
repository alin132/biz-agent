/** 企业微信出站自检：npx tsx scripts/wecom-outbound-selftest.ts；所有请求均注入，不联网。 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../server/db/index.js";
import { ImError } from "../server/im/errors.js";
import { OutboundService, resolveWeComTransport } from "../server/im/outbound.js";
import type { HttpJsonPost, OutboundBot, OutboundTarget } from "../server/im/outbound.js";

const bot: OutboundBot = {
	id: "wecom-outbound-test", name: "企业微信自检", platform: "wecom",
	appKey: "corp&test", appSecret: "secret+test&value", robotCode: "1000002",
};
let passed = 0;
async function check(name: string, run: () => void | Promise<void>): Promise<void> {
	await run();
	passed += 1;
	console.log(`  ✓ ${name}`);
}

async function main(): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "biz-wecom-outbound-"));
	const store = openStore({ dbPath: join(dir, "outbound.db") });
	const savedWecom = process.env.WECOM_TRANSPORT;
	const savedDing = process.env.DINGTALK_TRANSPORT;
	const savedNode = process.env.NODE_ENV;
	delete process.env.WECOM_TRANSPORT;
	try {
		await check("传输使用企业微信配置、IM 回落和测试环境默认", async () => {
			process.env.DINGTALK_TRANSPORT = "fake";
			assert.equal(resolveWeComTransport(), "fake");
			const outbound = new OutboundService({ storage: store, request: async () => { throw new Error("禁止联网"); } });
			assert.equal((await outbound.send(bot, { staffId: "user.one@example" }, " 测试 ")).transport, "fake");
			assert.equal(outbound.outbox()[0]?.platform, "wecom");
			assert.equal(outbound.outbox()[0]?.content, "测试");
			process.env.WECOM_TRANSPORT = "real";
			assert.equal(resolveWeComTransport(), "real");
			assert.equal(new OutboundService({ storage: store, transport: "fake" }).wecomTransport, "real");
			delete process.env.WECOM_TRANSPORT;
			delete process.env.DINGTALK_TRANSPORT;
			process.env.NODE_ENV = "test";
			assert.equal(resolveWeComTransport(), "fake");
		});
		await check("群、同时指定目标、广播和多收件人均在请求前拒绝（fake 同样校验）", async () => {
			for (const transport of ["fake", "real"] as const) {
				let calls = 0;
				const outbound = new OutboundService({ storage: store, transport, request: async () => { calls += 1; throw new Error("不应请求"); } });
				const targets: OutboundTarget[] = [{}, { conversationId: "group" }, { conversationId: "group", staffId: "user" },
					{ conversationId: "", staffId: "user" }, ...["@all", "@ALL", "a|b", "a,b", "a;b", "a b", "a\nb", "a&b"].map(staffId => ({ staffId }))];
				for (const target of targets) {
					await assert.rejects(outbound.send(bot, target, "测试"), (error: unknown) => error instanceof ImError && error.status === 400);
				}
				for (const robotCode of ["bad", "0", "-1", "1.2", "9007199254740992"]) {
					await assert.rejects(outbound.send({ ...bot, robotCode }, { staffId: "user" }, "测试"), ImError);
				}
				assert.equal(calls, 0);
				assert.equal(outbound.outbox().length, 0);
			}
		});
		await check("GET 换 token、文本发送协议和缓存", async () => {
			let tokenCalls = 0;
			let sends = 0;
			const request: HttpJsonPost = async (url, body, headers, method) => {
				const parsed = new URL(url);
				assert.equal(parsed.origin, "https://qyapi.weixin.qq.com");
				assert.deepEqual(headers, {});
				if (parsed.pathname.endsWith("gettoken")) {
					tokenCalls += 1;
					assert.equal(method, "GET");
					assert.equal(body, undefined);
					assert.equal(parsed.searchParams.get("corpid"), bot.appKey);
					assert.equal(parsed.searchParams.get("corpsecret"), bot.appSecret);
					return { status: 200, body: { errcode: 0, access_token: "token+&1", expires_in: 7200 } };
				}
				assert.equal(parsed.pathname, "/cgi-bin/message/send");
				assert.equal(parsed.searchParams.get("access_token"), "token+&1");
				assert.equal(method ?? "POST", "POST");
				assert.deepEqual(body, { touser: "user-1", msgtype: "text", agentid: 1000002, text: { content: "你好" } });
				sends += 1;
				return { status: 200, body: { errcode: 0, invaliduser: "", msgid: "message-1" } };
			};
			const outbound = new OutboundService({ storage: store, transport: "real", request, sleep: async () => {} });
			for (let i = 0; i < 2; i += 1) {
				assert.deepEqual(await outbound.send(bot, { staffId: "user-1" }, " 你好 "), { ok: true, transport: "real", attempts: 1, messageId: "message-1" });
			}
			assert.equal(tokenCalls, 1);
			assert.equal(sends, 2);
		});
		await check("expires_in 提前刷新、密钥轮换、企业和应用及平台隔离", async () => {
			let now = 0;
			let tokens = 0;
			const request: HttpJsonPost = async (url) => {
				if (url.includes("gettoken")) { tokens += 1; return { status: 200, body: { errcode: 0, access_token: "t", expires_in: 100 } }; }
				if (url.includes("accessToken")) { tokens += 1; return { status: 200, body: { accessToken: "ding" } }; }
				return { status: 200, body: { errcode: 0 } };
			};
			const outbound = new OutboundService({ storage: store, transport: "real", request, now: () => now, sleep: async () => {} });
			const send = (item = bot) => outbound.send(item, { staffId: "user" }, "测试");
			await send(); now = 89_999; await send(); assert.equal(tokens, 1);
			now = 90_000; await send(); assert.equal(tokens, 2);
			await send({ ...bot, appSecret: "rotated" }); assert.equal(tokens, 3);
			await send({ ...bot, robotCode: "1000003" }); assert.equal(tokens, 4);
			await send({ ...bot, appKey: "other-corp" }); assert.equal(tokens, 5);
			await send({ ...bot, platform: "dingtalk" }); assert.equal(tokens, 6);
		});
		for (const errcode of [40014, 42001]) {
			await check(`${errcode} 失效 token 清缓存重试`, async () => {
				let tokens = 0;
				let sends = 0;
				const used: string[] = [];
				const delays: number[] = [];
				const request: HttpJsonPost = async (url) => {
					if (url.includes("gettoken")) { tokens += 1; return { status: 200, body: { errcode: 0, access_token: "token-" + tokens, expires_in: 7200 } }; }
					used.push(new URL(url).searchParams.get("access_token")!);
					sends += 1;
					return { status: 200, body: sends === 1 ? { errcode, errmsg: "过期" } : { errcode: 0 } };
				};
				const outbound = new OutboundService({ storage: store, transport: "real", request, sleep: async ms => { delays.push(ms); } });
				const result = await outbound.send(bot, { staffId: "user" }, "测试");
				assert.equal(result.ok, true);
				assert.equal(result.attempts, 2);
				assert.deepEqual(used, ["token-1", "token-2"]);
				assert.deepEqual(delays, [300]);
				assert.equal(tokens, 2);
			});
		}
		for (const failure of [{ errcode: 81013, errmsg: "无权限" }, { errcode: 0, invaliduser: "user" }, {}]) {
			await check("HTTP 200 的永久错误或无效成员不能报告成功：" + JSON.stringify(failure), async () => {
				let sends = 0;
				const before = store.listAudit({ action: "im.send.failed", limit: 100, offset: 0 }).length;
				const request: HttpJsonPost = async url => {
					if (url.includes("gettoken")) { return { status: 200, body: { errcode: 0, access_token: "t", expires_in: 7200 } }; }
					sends += 1; return { status: 200, body: failure };
				};
				const outbound = new OutboundService({ storage: store, transport: "real", request, sleep: async () => {} });
				const result = await outbound.send(bot, { staffId: "user" }, "测试");
				assert.equal(result.ok, false);
				assert.equal(result.attempts, 3);
				assert.equal(sends, 3);
				assert.match(result.error ?? "", /企业微信发送失败/);
				assert.equal(store.listAudit({ action: "im.send.failed", limit: 100, offset: 0 }).length, before + 1);
			});
		}
		await check("换 token 的业务错误和无效有效期阻止发送", async () => {
			for (const body of [{ errcode: 40013, errmsg: "无效 CorpID" }, { errcode: 0, access_token: "t", expires_in: 0 }]) {
				let sends = 0;
				const outbound = new OutboundService({ storage: store, transport: "real", sleep: async () => {}, request: async url => {
					if (!url.includes("gettoken")) { sends += 1; }
					return { status: 200, body };
				} });
				assert.equal((await outbound.send(bot, { staffId: "user" }, "测试")).ok, false);
				assert.equal(sends, 0);
			}
		});
	} finally {
		for (const [key, value] of [["WECOM_TRANSPORT", savedWecom], ["DINGTALK_TRANSPORT", savedDing], ["NODE_ENV", savedNode]]) {
			if (value === undefined) { delete process.env[key!]; } else { process.env[key!] = value; }
		}
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
	console.log("全部通过：" + passed + " 项检查");
}
void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
