/**
 * P6 多模型管理 + P4 API Key 的自检（`npm run models:selftest`）——零网络、临时 SQLite、不起服务。
 *
 * 覆盖：
 *   AES-256-GCM 加解密往返 / 密文形状 / 错密钥 / 篡改密文
 *   掩码格式（sk-****abcd）
 *   API Key 的 sha256 哈希比对、令牌桶窗口与按 key 隔离
 *   供应商/模型的 DAO 与门面（唯一名、级联删除、掩码出参）
 *   当前模型切换与运行时解析（含 LLM_DISABLE=1）
 *   ping 的 chat/embedding/anthropic 端点与失败文案（注入假 fetch，不联网）
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SqliteStorage } from "../server/db/sqlite.js";
import type { ModelRecord } from "../server/db/types.js";
import { generateApiKey, hashApiKey } from "../server/apiKeys/store.js";
import { ApiKeyService, TokenBucketLimiter } from "../server/apiKeys/service.js";
import {
	decryptSecret,
	encryptSecret,
	maskSecret,
	resetEncryptionSecretCache,
	sha256Hex,
} from "../server/models/crypto.js";
import { ModelService, pingModel } from "../server/models/service.js";
import type { FetchLike } from "../server/models/service.js";
import { ModelError, ModelStore } from "../server/models/store.js";

// 固定密钥：让本脚本的加密结果可断言；也避免误用本机 .env 里的 SECRET_KEY
process.env.SECRET_KEY = "models-selftest-secret";
delete process.env.AUTH_SECRET;
delete process.env.LLM_DISABLE;
resetEncryptionSecretCache();

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const TMP_DIR = resolve(ROOT, "data/_tmp");
const DB_PATH = resolve(TMP_DIR, "models-selftest.db");

let passed = 0;

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
	try {
		await fn();
		passed += 1;
		console.log(`  ✓ ${name}`);
	} catch (error) {
		console.error(`  ✗ ${name}`);
		console.error(error instanceof Error ? `    ${error.message}` : `    ${String(error)}`);
		throw error;
	}
}

function removeDbFiles(base: string): void {
	for (const suffix of ["", "-wal", "-shm"]) {
		const file = `${base}${suffix}`;
		if (existsSync(file)) {
			rmSync(file, { force: true });
		}
	}
}

const SECRET = "models-selftest-secret";

function expectModelError(fn: () => unknown, status: number, contains?: string): void {
	assert.throws(fn, (error: unknown) => {
		assert.ok(error instanceof ModelError, `应当是 ModelError，实际是 ${String(error)}`);
		assert.equal(error.status, status);
		if (contains) {
			assert.ok(error.message.includes(contains), `文案应包含「${contains}」，实际「${error.message}」`);
		}
		return true;
	});
}

async function main(): Promise<void> {
	console.log("P6 多模型 + P4 开放 API 自检（不起服务）");

	mkdirSync(TMP_DIR, { recursive: true });
	removeDbFiles(DB_PATH);

	/* ---------------- 1. 加密 ---------------- */

	await check("AES-256-GCM 加解密往返", () => {
		const plaintext = "sk-live-1234567890abcd";
		const blob = encryptSecret(plaintext, SECRET);
		assert.equal(decryptSecret(blob, SECRET), plaintext);
		assert.notEqual(blob, plaintext);
		assert.equal(decryptSecret(blob, SECRET), decryptSecret(blob, SECRET), "同一密文反复解密结果一致");
	});

	await check("密文形状是 { v:1, iv, tag, data } 且不含明文、每次随机", () => {
		const blob = encryptSecret("sk-shape-check", SECRET);
		const parsed = JSON.parse(blob) as Record<string, unknown>;
		assert.equal(parsed.v, 1);
		for (const key of ["iv", "tag", "data"]) {
			assert.equal(typeof parsed[key], "string");
			assert.ok((parsed[key] as string).length > 0);
		}
		const second = JSON.parse(encryptSecret("sk-shape-check", SECRET)) as Record<string, unknown>;
		assert.notEqual(parsed.iv, second.iv, "每次加密 iv 不同（避免重放）");
		assert.notEqual(parsed.data, second.data, "每次加密密文不同");
		assert.ok(!blob.includes("sk-shape-check"), "密文里不能出现明文");
	});

	await check("错密钥解不开", () => {
		const blob = encryptSecret("sk-wrong-key", "secret-a");
		assert.throws(() => decryptSecret(blob, "secret-b"), /bad decrypt|unable to authenticate|Unsupported state/i);
	});

	await check("篡改密文解不开", () => {
		const parsed = JSON.parse(encryptSecret("sk-tamper", SECRET)) as {
			v: number;
			iv: string;
			tag: string;
			data: string;
		};
		const tampered = Buffer.from(parsed.data, "base64");
		tampered[0] = (tampered[0]! + 1) % 256;
		const blob = JSON.stringify({ ...parsed, data: tampered.toString("base64") });
		assert.throws(() => decryptSecret(blob, SECRET));
	});

	await check("掩码格式：sk-****abcd / 短 key / 空值", () => {
		assert.equal(maskSecret("sk-1234567890abcd"), "sk-****abcd");
		assert.equal(maskSecret("plainkeymaterial"), "pl****rial");
		assert.equal(maskSecret("ab"), "ab****");
		assert.equal(maskSecret(""), null);
		assert.equal(maskSecret(null), null);
		assert.ok(!maskSecret("sk-1234567890abcd")!.includes("1234567890"));
	});

	/* ---------------- 2. API Key 哈希与限流 ---------------- */

	await check("sha256 key 哈希比对", () => {
		const generated = generateApiKey();
		assert.ok(generated.key.startsWith("bk_"), "明文以 bk_ 开头");
		assert.equal(generated.key.length, "bk_".length + 43, "32 字节随机 → base64url 43 字符");
		assert.equal(generated.prefix, generated.key.slice(0, 8));
		const expected = createHash("sha256").update(generated.key, "utf8").digest("hex");
		assert.equal(hashApiKey(generated.key), expected);
		assert.equal(sha256Hex(generated.key), expected);
		assert.notEqual(hashApiKey(generated.key), hashApiKey(`${generated.key}x`));
		assert.ok(!generated.keyHash.includes(generated.key), "哈希里不应出现明文");
	});

	await check("令牌桶：容量内突发通过、超限给出 Retry-After", () => {
		let now = 1_000_000;
		const limiter = new TokenBucketLimiter(() => now);
		const decisions = [1, 2, 3].map(() => limiter.take("key-1", 3));
		assert.deepEqual(decisions.map((d) => d.allowed), [true, true, true]);
		const blocked = limiter.take("key-1", 3);
		assert.equal(blocked.allowed, false);
		assert.equal(blocked.remaining, 0);
		// 容量 3 → 每 20 秒回一个令牌
		assert.equal(blocked.retryAfterMs, 20_000);
		now += 20_000;
		assert.equal(limiter.take("key-1", 3).allowed, true, "过了 20 秒恢复一个令牌");
		now += 60_000;
		const refilled = [1, 2, 3].map(() => limiter.take("key-1", 3));
		assert.deepEqual(refilled.map((d) => d.allowed), [true, true, true], "空窗一整分钟后回满");
	});

	await check("令牌桶：不同 key 互不影响", () => {
		let now = 5_000;
		const limiter = new TokenBucketLimiter(() => now);
		assert.equal(limiter.take("a", 1).allowed, true);
		assert.equal(limiter.take("a", 1).allowed, false);
		assert.equal(limiter.take("b", 1).allowed, true, "另一个 key 有自己的桶");
		now += 60_000;
		assert.equal(limiter.take("a", 1).allowed, true);
	});

	/* ---------------- 3. 存储与门面 ---------------- */

	const storage = new SqliteStorage(DB_PATH);
	const store = new ModelStore(storage);

	const provider = store.createProvider({
		name: "自检供应商",
		kind: "openai",
		baseUrl: "https://example.invalid/v1/",
		apiKey: "sk-1234567890abcd",
		enabled: true,
	});

	await check("供应商创建：base_url 规整、key 加密、出参只有掩码", () => {
		assert.equal(provider.baseUrl, "https://example.invalid/v1", "去掉尾部斜杠");
		assert.equal(provider.hasApiKey, true);
		assert.equal(provider.apiKeyMasked, "sk-****abcd");
		assert.ok(!JSON.stringify(provider).includes("sk-1234567890abcd"), "出参里不能有明文");
		const row = storage.getModelProvider(provider.id);
		assert.ok(row?.apiKeyEncrypted);
		assert.ok(!row!.apiKeyEncrypted!.includes("sk-1234567890abcd"));
		assert.equal(decryptSecret(row!.apiKeyEncrypted!, SECRET), "sk-1234567890abcd");
	});

	await check("供应商唯一名冲突 → 409；非法 kind/base_url → 400", () => {
		expectModelError(() => store.createProvider({ name: "自检供应商", kind: "openai" }), 409, "已存在");
		expectModelError(() => store.createProvider({ name: "坏类型", kind: "gemini" }), 400, "供应商类型");
		expectModelError(() => store.createProvider({ name: "坏地址", kind: "openai", baseUrl: "ftp://x" }), 400, "http");
	});

	const chatModel = store.createModel({
		providerId: provider.id,
		name: "自检对话模型",
		modelId: "selftest-chat",
		kind: "chat",
		contextWindow: 8192,
	});
	const embeddingModel = store.createModel({
		providerId: provider.id,
		name: "自检向量模型",
		modelId: "selftest-embedding",
		kind: "embedding",
	});

	await check("模型创建 / 更新 / 列表", () => {
		assert.equal(chatModel.providerName, "自检供应商");
		assert.equal(chatModel.kind, "chat");
		assert.equal(chatModel.contextWindow, 8192);
		const updated = store.updateModel(chatModel.id, { name: "改名后的模型", enabled: false });
		assert.equal(updated.name, "改名后的模型");
		assert.equal(updated.enabled, false);
		assert.equal(store.models().length, 2);
		assert.equal(store.provider(provider.id)?.modelCount, 2);
		store.updateModel(chatModel.id, { enabled: true });
		expectModelError(() => store.createModel({ providerId: "prov-nope", modelId: "x" }), 404, "供应商不存在");
		expectModelError(() => store.createModel({ providerId: provider.id, modelId: "x", kind: "image" }), 400, "chat");
	});

	await check("删供应商连带删它的模型", () => {
		const temp = store.createProvider({ name: "待删供应商", kind: "custom" });
		store.createModel({ providerId: temp.id, modelId: "temp-model" });
		const result = store.removeProvider(temp.id);
		assert.equal(result.removed, true);
		assert.equal(result.modelsRemoved, 1);
		assert.equal(store.provider(temp.id), undefined);
		assert.equal(store.modelRows().some((row) => row.providerId === temp.id), false);
		expectModelError(() => store.removeProvider(temp.id), 404, "供应商不存在");
	});

	await check("当前模型：只认 enabled 的 chat 模型", () => {
		const service = new ModelService(storage);
		const current = service.setCurrent(chatModel.id);
		assert.equal(current.current, "selftest-chat");
		assert.equal(current.model?.id, chatModel.id);
		assert.equal(service.currentModelKey(), chatModel.id);
		expectModelError(() => service.setCurrent(embeddingModel.id), 400, "对话");
		expectModelError(() => service.setCurrent("nope"), 404, "模型不存在");
		expectModelError(() => service.setCurrent(""), 400, "不能为空");
	});

	await check("运行时解析：库里的当前模型 → LlmRuntime；LLM_DISABLE=1 → 交回 .env（undefined）", () => {
		const service = new ModelService(storage);
		service.setCurrent(chatModel.id);
		const runtime = service.resolveRuntime();
		assert.ok(runtime, "应解析出真实运行时");
		assert.equal(runtime!.modelId, "selftest-chat");
		assert.equal(runtime!.provider, "openai");
		assert.ok(runtime!.label.includes("自检供应商"));
		assert.equal(service.resolveRuntime("不存在的模型"), undefined, "库里没有 → 交回 .env");
		process.env.LLM_DISABLE = "1";
		try {
			assert.equal(service.resolveRuntime(), undefined, "LLM_DISABLE=1 时强制模拟");
			assert.equal(service.currentRuntime(), null);
			assert.equal(service.healthModel().mode, "simulated");
		} finally {
			delete process.env.LLM_DISABLE;
		}
	});

	await check("options：库里的 chat 模型会进下拉，embedding 不进", () => {
		const service = new ModelService(storage);
		const options = service.options();
		assert.ok(options.some((option) => option.id === "selftest-chat"));
		assert.equal(options.some((option) => option.id === "selftest-embedding"), false);
		for (const option of options) {
			assert.equal(typeof option.id, "string");
			assert.equal(typeof option.label, "string");
		}
	});

	/* ---------------- 4. API Key 服务 ---------------- */

	await check("API Key 创建：明文只出现一次、库里只有 sha256、可鉴权", () => {
		const service = new ApiKeyService(storage);
		const created = service.create({ name: "自检 Key", role: "operator", rateLimitPerMin: 5 });
		assert.ok(created.key.startsWith("bk_"));
		assert.equal(created.item.prefix, created.key.slice(0, 8));
		assert.equal(created.item.role, "operator");
		assert.equal(created.item.rateLimitPerMin, 5);
		assert.ok(!JSON.stringify(service.list()).includes(created.key), "列表不能回明文");
		assert.ok(!JSON.stringify(service.list()).includes(hashApiKey(created.key)), "列表不能回 hash");

		const record = service.authenticate(created.key);
		assert.ok(record, "有效 key 应鉴权通过");
		assert.equal(record!.id, created.item.id);
		assert.equal(service.authenticate(`${created.key}x`), null, "错 key → null");
		assert.equal(service.authenticate(null), null);
		assert.equal(service.authenticate("not-a-bk-key"), null);
		const touched = service.list().find((item) => item.id === created.item.id);
		assert.ok(touched?.lastUsedAt && touched.lastUsedAt > 0, "鉴权成功要更新 last_used_at");
	});

	await check("API Key 停用 / 吊销后鉴权失败，参数校验生效", () => {
		const service = new ApiKeyService(storage);
		const created = service.create({ name: "停用测试", role: "developer" });
		service.update(created.item.id, { disabled: true });
		assert.equal(service.authenticate(created.key), null, "停用后 401");

		const second = service.create({ name: "吊销测试" });
		const revoked = service.revoke(second.item.id);
		assert.equal(revoked.revoked, true);
		assert.equal(service.authenticate(second.key), null, "吊销后 401");
		assert.throws(() => service.update(second.item.id, { name: "x" }), /已吊销/);

		assert.throws(() => service.create({ name: "坏角色", role: "root" }), /角色/);
		assert.throws(() => service.create({ rateLimitPerMin: 0 }), /rateLimitPerMin/);
		assert.throws(() => service.create({ rateLimitPerMin: 999999 }), /rateLimitPerMin/);
	});

	await check("服务层限流按 key 的 rateLimitPerMin 生效", () => {
		let now = 0;
		const service = new ApiKeyService(storage, { now: () => now });
		const created = service.create({ name: "限流测试", rateLimitPerMin: 2 });
		const record = service.authenticate(created.key)!;
		assert.equal(service.checkRateLimit(record).allowed, true);
		assert.equal(service.checkRateLimit(record).allowed, true);
		const blocked = service.checkRateLimit(record);
		assert.equal(blocked.allowed, false);
		assert.ok(blocked.retryAfterMs > 0);
		now += blocked.retryAfterMs;
		assert.equal(service.checkRateLimit(record).allowed, true);
	});

	/* ---------------- 5. 探测（注入假 fetch，不联网） ---------------- */

	const providerRow = storage.getModelProvider(provider.id)!;
	const chatRow = storage.getModel(chatModel.id) as ModelRecord;
	const embeddingRow = storage.getModel(embeddingModel.id) as ModelRecord;

	await check("ping chat：打 /chat/completions、带 Bearer、返回 ok", async () => {
		const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
		const fake: FetchLike = async (url, init) => {
			calls.push({ url, init });
			return { ok: true, status: 200, text: async () => "{}" };
		};
		const result = await pingModel({ provider: providerRow, model: chatRow }, fake);
		assert.equal(result.ok, true);
		assert.ok(result.latencyMs >= 0);
		assert.equal(calls[0]!.url, "https://example.invalid/v1/chat/completions");
		assert.equal(calls[0]!.init.headers.authorization, "Bearer sk-1234567890abcd");
		assert.ok(JSON.parse(calls[0]!.init.body).messages);
	});

	await check("ping embedding：打 /embeddings、body 是 input", async () => {
		const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
		const fake: FetchLike = async (url, init) => {
			calls.push({ url, init });
			return { ok: true, status: 200, text: async () => "{}" };
		};
		const result = await pingModel({ provider: providerRow, model: embeddingRow }, fake);
		assert.equal(result.ok, true);
		assert.equal(calls[0]!.url, "https://example.invalid/v1/embeddings");
		assert.equal(JSON.parse(calls[0]!.init.body).input, "ping");
	});

	await check("ping anthropic：打 /v1/messages、用 x-api-key", async () => {
		const anthropic = store.createProvider({
			name: "自检 Anthropic",
			kind: "anthropic",
			baseUrl: "https://api.anthropic.com",
			apiKey: "sk-ant-test",
		});
		const model = store.createModel({ providerId: anthropic.id, modelId: "claude-test" });
		const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
		const fake: FetchLike = async (url, init) => {
			calls.push({ url, init });
			return { ok: true, status: 200, text: async () => "{}" };
		};
		const result = await pingModel({ provider: storage.getModelProvider(anthropic.id)!, model: storage.getModel(model.id)! }, fake);
		assert.equal(result.ok, true);
		assert.equal(calls[0]!.url, "https://api.anthropic.com/v1/messages");
		assert.equal(calls[0]!.init.headers["x-api-key"], "sk-ant-test");
		assert.equal(calls[0]!.init.headers.authorization, undefined);
	});

	await check("ping 不可达 / HTTP 失败 → ok:false + 中文错误", async () => {
		const unreachable: FetchLike = async () => {
			throw new Error("connect ECONNREFUSED 127.0.0.1:1");
		};
		const failed = await pingModel({ provider: providerRow, model: chatRow }, unreachable);
		assert.equal(failed.ok, false);
		assert.ok(failed.error?.includes("连接模型端点失败"), failed.error);

		const httpError: FetchLike = async () => ({
			ok: false,
			status: 401,
			text: async () => '{"error":"invalid api key"}',
		});
		const denied = await pingModel({ provider: providerRow, model: chatRow }, httpError);
		assert.equal(denied.ok, false);
		assert.ok(denied.error?.includes("HTTP 401"), denied.error);

		const custom = store.createProvider({ name: "自定义无地址", kind: "custom" });
		const customModel = store.createModel({ providerId: custom.id, modelId: "local-llm" });
		const noBase = await pingModel(
			{ provider: storage.getModelProvider(custom.id)!, model: storage.getModel(customModel.id)! },
			httpError,
		);
		assert.equal(noBase.ok, false);
		assert.ok(noBase.error?.includes("base_url"), noBase.error);
	});

	storage.close();
	removeDbFiles(DB_PATH);
	console.log(`\n全部通过：${passed} 项检查`);
}

await main();
