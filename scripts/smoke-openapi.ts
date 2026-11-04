/**
 * P6 多模型管理 + P4 开放 API 的端到端冒烟（`npm run smoke:openapi`）。
 *
 * 需要一个 **AUTH_MODE=required + LLM_DISABLE=1** 的隔离实例在跑（别碰 4317）：
 *
 *   PowerShell:
 *     $env:PORT="4340"; $env:AUTH_MODE="required"; $env:DB_PATH="$PWD\data\g24-openapi.db"
 *     $env:AUTH_BOOTSTRAP_PASSWORD="owner12345"; $env:SECRET_KEY="g24-smoke-secret"
 *     $env:LLM_DISABLE="1"; npm run dev
 *   然后：
 *     $env:SMOKE_OPENAPI_BASE="http://127.0.0.1:4340"; npm run smoke:openapi
 *
 * 脚本自己会在本机随机端口起一个假供应商（只回 200），用来验证 ping 成功/失败，
 * 不打任何真实模型、不花钱。覆盖：
 *   供应商建 + 掩码、chat/embedding 模型、ping 成功与不可达、切当前模型、
 *   API Key 明文只出现一次、非流式 /v1/chat、流式（≥1 delta + [DONE]）、
 *   坏 key / 停用 key 401、限流 429 + Retry-After、/v1/health 免鉴权、
 *   operator 403、审计有 api_key 记录、/api/models 向后兼容。
 *
 * 跑完把 `data/g24-openapi.db` 删掉即可。
 */

import { createServer } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import type { AddressInfo } from "node:net";

const BASE = (process.env.SMOKE_OPENAPI_BASE ?? "http://127.0.0.1:4340").replace(/\/$/, "");
const OWNER_EMAIL = process.env.SMOKE_OPENAPI_OWNER_EMAIL ?? "owner@local";
const OWNER_PASSWORD = process.env.SMOKE_OPENAPI_OWNER_PASSWORD ?? "owner12345";
const OPERATOR_EMAIL = process.env.SMOKE_OPENAPI_OPERATOR_EMAIL ?? "operator@local";
const OPERATOR_PASSWORD = process.env.SMOKE_OPENAPI_OPERATOR_PASSWORD ?? "operator12345";

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

interface Wire {
	status: number;
	body: Record<string, unknown>;
	text: string;
	headers: Headers;
}

async function request(
	method: string,
	path: string,
	options: { token?: string; apiKey?: string; body?: unknown } = {},
): Promise<Wire> {
	const headers: Record<string, string> = {};
	if (options.token) {
		headers.authorization = `Bearer ${options.token}`;
	}
	if (options.apiKey) {
		headers.authorization = `Bearer ${options.apiKey}`;
	}
	if (options.body !== undefined) {
		headers["content-type"] = "application/json";
	}
	const response = await fetch(`${BASE}${path}`, {
		method,
		headers,
		body: options.body === undefined ? undefined : JSON.stringify(options.body),
	});
	const text = await response.text();
	let body: Record<string, unknown> = {};
	if (text.length > 0) {
		try {
			body = JSON.parse(text) as Record<string, unknown>;
		} catch {
			body = { raw: text };
		}
	}
	return { status: response.status, body, text, headers: response.headers };
}

async function login(email: string, password: string, hint = ""): Promise<string> {
	const response = await request("POST", "/api/auth/login", { body: { email, password } });
	if (response.status !== 200 || typeof response.body.token !== "string") {
		fail(
			`登录失败（${email} / ${response.status} ${JSON.stringify(response.body)}）。` +
				`请按脚本头部注释用 AUTH_MODE=required + AUTH_BOOTSTRAP_PASSWORD 起实例。${hint}`,
		);
	}
	return response.body.token as string;
}

/** 建成员；已经存在（409）也当成功，方便反复跑。 */
async function ensureUser(token: string, email: string, password: string, role: string): Promise<void> {
	const response = await request("POST", "/api/auth/users", { token, body: { email, password, role } });
	if (response.status === 201 || response.status === 409) {
		return;
	}
	fail(`建成员失败（${email} / ${response.status} ${JSON.stringify(response.body)}）`);
}

/** 只回 200 的假供应商：ping 只关心状态码，不解析响应体。 */
function startFakeProvider(): Promise<{ server: Server; port: number }> {
	return new Promise((resolve) => {
		const server = createServer((req: IncomingMessage, res) => {
			req.resume();
			if (req.method === "POST" && (req.url === "/v1/chat/completions" || req.url === "/v1/embeddings")) {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ ok: true }));
				return;
			}
			res.writeHead(404, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: "not found" }));
		});
		server.listen(0, "127.0.0.1", () => {
			const address = server.address() as AddressInfo;
			resolve({ server, port: address.port });
		});
	});
}

/** 从 SSE 文本里拆出 data 行（`[DONE]` 单独处理）。 */
function parseSse(text: string): { chunks: Record<string, unknown>[]; done: boolean } {
	const chunks: Record<string, unknown>[] = [];
	let done = false;
	for (const line of text.split(/\r?\n/)) {
		if (!line.startsWith("data: ")) {
			continue;
		}
		const payload = line.slice("data: ".length);
		if (payload === "[DONE]") {
			done = true;
			continue;
		}
		try {
			chunks.push(JSON.parse(payload) as Record<string, unknown>);
		} catch {
			// 忽略非 JSON 行（注释/ping）
		}
	}
	return { chunks, done };
}

/** 从 chunk 数组里拼出所有 delta 正文。 */
function deltasOf(chunks: Record<string, unknown>[]): string {
	const parts: string[] = [];
	for (const chunk of chunks) {
		const choices = Array.isArray(chunk.choices) ? (chunk.choices as Record<string, unknown>[]) : [];
		for (const choice of choices) {
			const delta = choice.delta as Record<string, unknown> | undefined;
			if (delta && typeof delta.content === "string") {
				parts.push(delta.content);
			}
		}
	}
	return parts.join("");
}

async function main(): Promise<void> {
	console.log(`P6/P4 冒烟：${BASE}`);
	const suffix = Date.now().toString(36);

	// ---------- 0. 前置：确认打的是 required + 模拟模型实例 ----------
	const health = await request("GET", "/api/health");
	if (health.status !== 200 || health.body.auth !== "required") {
		fail(
			`健康探针不可用或实例不是 AUTH_MODE=required（auth=${String(health.body.auth)}）：` +
				"请按脚本头部注释起隔离实例，或用 SMOKE_OPENAPI_BASE 指向它",
		);
	}
	const healthModel = health.body.model as Record<string, unknown> | undefined;
	assert(healthModel?.mode === "simulated", "隔离实例走模拟模型（LLM_DISABLE=1），/api/health.model 形状不变");

	// ---------- 1. 登录 owner / 建 operator ----------
	const owner = await login(OWNER_EMAIL, OWNER_PASSWORD);
	await ensureUser(owner, OPERATOR_EMAIL, OPERATOR_PASSWORD, "operator");
	const operator = await login(OPERATOR_EMAIL, OPERATOR_PASSWORD);

	// ---------- 2. 供应商 + 模型 ----------
	console.log("\n[1] 供应商与模型");
	const fake = await startFakeProvider();
	const fakeBase = `http://127.0.0.1:${fake.port}/v1`;
	const credential = "sk-smoke-1234567890abcd";

	const createdProvider = await request("POST", "/api/models/providers", {
		token: owner,
		body: { name: `冒烟供应商-${suffix}`, kind: "openai", baseUrl: fakeBase, apiKey: credential },
	});
	assert(createdProvider.status === 201, "POST /api/models/providers → 201");
	assert(
		!createdProvider.text.includes(credential),
		"创建供应商的响应里没有明文 API Key（只有掩码）",
	);
	const provider = createdProvider.body as Record<string, unknown>;
	assert(provider.apiKeyMasked === "sk-****abcd", "供应商出参是掩码 sk-****abcd");
	assert(provider.hasApiKey === true, "供应商 hasApiKey=true");
	const providerId = String(provider.id);

	const providerList = await request("GET", "/api/models/providers", { token: owner });
	assert(
		providerList.status === 200 &&
			Array.isArray(providerList.body.items) &&
			(providerList.body.items as Record<string, unknown>[]).some((item) => item.id === providerId),
		"GET /api/models/providers 列出刚建的供应商",
	);
	assert(!providerList.text.includes(credential), "供应商列表里没有明文 API Key");

	const chat = await request("POST", "/api/models", {
		token: owner,
		body: { providerId, name: `冒烟对话模型-${suffix}`, modelId: `smoke-chat-${suffix}`, kind: "chat" },
	});
	assert(chat.status === 201 && chat.body.kind === "chat", "创建 chat 模型 → 201（kind=chat）");
	const chatModelId = String(chat.body.id);

	const embedding = await request("POST", "/api/models", {
		token: owner,
		body: { providerId, name: `冒烟向量模型-${suffix}`, modelId: `smoke-embedding-${suffix}`, kind: "embedding" },
	});
	assert(embedding.status === 201 && embedding.body.kind === "embedding", "创建 embedding 模型 → 201（kind=embedding）");
	const embeddingModelId = String(embedding.body.id);

	// ---------- 3. ping ----------
	console.log("\n[2] 连通性探测");
	const pingChat = await request("POST", `/api/models/${chatModelId}/ping`, { token: owner });
	assert(pingChat.status === 200 && pingChat.body.ok === true, "ping chat 模型成功（假供应商回 200）");
	assert(typeof pingChat.body.latencyMs === "number", "ping 返回 latencyMs（数字）");

	const pingEmbedding = await request("POST", `/api/models/${embeddingModelId}/ping`, { token: owner });
	assert(pingEmbedding.status === 200 && pingEmbedding.body.ok === true, "ping embedding 模型成功（打 /embeddings）");

	const badProvider = await request("POST", "/api/models/providers", {
		token: owner,
		body: { name: `不可达供应商-${suffix}`, kind: "openai", baseUrl: "http://127.0.0.1:1/v1" },
	});
	const badModel = await request("POST", "/api/models", {
		token: owner,
		body: { providerId: String(badProvider.body.id), modelId: `unreachable-${suffix}`, kind: "chat" },
	});
	const pingBad = await request("POST", `/api/models/${String(badModel.body.id)}/ping`, { token: owner });
	assert(
		pingBad.status === 200 && pingBad.body.ok === false && typeof pingBad.body.error === "string",
		"ping 不可达端点 → ok:false + 中文 error（接口本身 200）",
	);

	// ---------- 4. 当前模型 & /api/models 兼容 ----------
	console.log("\n[3] 当前模型与 /api/models");
	const setCurrent = await request("POST", "/api/models/current", { token: owner, body: { modelId: chatModelId } });
	assert(setCurrent.status === 200 && setCurrent.body.current === `smoke-chat-${suffix}`, "切换当前模型成功");
	const getCurrent = await request("GET", "/api/models/current", { token: owner });
	assert(getCurrent.status === 200 && getCurrent.body.current === `smoke-chat-${suffix}`, "GET /api/models/current 与切换一致");

	const models = await request("GET", "/api/models", { token: owner });
	assert(models.status === 200, "GET /api/models → 200");
	const options = models.body.options;
	assert(
		Array.isArray(options) && (options as Record<string, unknown>[]).every((option) => typeof option.id === "string" && typeof option.label === "string"),
		"options 形状与旧版一致（{ id, label } 数组）",
	);
	assert(typeof models.body.mode === "string" && (models.body.current === null || typeof models.body.current === "string"), "mode/current 字段兼容");
	assert(Array.isArray(models.body.providers) && (models.body.providers as unknown[]).length > 0, "/api/models 扩展出 providers");
	assert(
		Array.isArray(models.body.models) &&
			(models.body.models as Record<string, unknown>[]).some((row) => row.modelId === `smoke-chat-${suffix}`),
		"/api/models 扩展出 models（含刚建的模型）",
	);

	// ---------- 5. 权限矩阵 ----------
	console.log("\n[4] 权限矩阵");
	const operatorProvider = await request("POST", "/api/models/providers", {
		token: operator,
		body: { name: `operator-不该成功-${suffix}`, kind: "openai" },
	});
	assert(operatorProvider.status === 403, "operator 建供应商 → 403");
	assert(
		String(operatorProvider.body.error).includes("当前角色是运营"),
		"403 文案来自 roles.ts（当前角色是运营…）",
	);
	const operatorKeys = await request("GET", "/api/api-keys", { token: operator });
	assert(operatorKeys.status === 403, "operator 访问 /api/api-keys → 403");

	// ---------- 6. API Key ----------
	console.log("\n[5] API Key 管理");
	const createdKey = await request("POST", "/api/api-keys", {
		token: owner,
		body: { name: `开放 API 冒烟-${suffix}`, role: "operator", rateLimitPerMin: 60 },
	});
	assert(createdKey.status === 201, "POST /api/api-keys → 201");
	const apiKey = String((createdKey.body as Record<string, unknown>).key ?? "");
	const keyItem = createdKey.body.item as Record<string, unknown>;
	assert(apiKey.startsWith("bk_") && apiKey.length > 20, "创建响应返回一次明文 key（bk_ 开头）");
	assert(keyItem.prefix === apiKey.slice(0, 8), "返回的 prefix 是明文前 8 位");

	const keyList = await request("GET", "/api/api-keys", { token: owner });
	assert(keyList.status === 200 && Array.isArray(keyList.body.items), "GET /api/api-keys 返回 items");
	assert(!keyList.text.includes(apiKey), "列表里不再出现明文 key");
	assert(!keyList.text.includes(String(keyItem.keyHash ?? "__no_hash__")), "列表里不出现 key 的哈希");

	// ---------- 7. /v1/chat 非流式 ----------
	console.log("\n[6] /v1/chat（非流式）");
	const chatResponse = await request("POST", "/v1/chat", {
		apiKey,
		body: { messages: [{ role: "user", content: "你好，简单介绍一下你自己" }] },
	});
	assert(chatResponse.status === 200 && chatResponse.body.object === "chat.completion", "非流式返回 OpenAI 形状（object=chat.completion）");
	const firstChoice = (chatResponse.body.choices as Record<string, unknown>[])[0]!;
	const message = firstChoice.message as Record<string, unknown>;
	assert(firstChoice.index === 0 && message.role === "assistant" && String(message.content).length > 0, "choices[0] 是 assistant 的非空回复");
	const usage = chatResponse.body.usage as Record<string, unknown>;
	assert(
		typeof usage.prompt_tokens === "number" &&
			typeof usage.completion_tokens === "number" &&
			typeof usage.total_tokens === "number",
		"usage 三个 token 字段齐全",
	);
	const sessionId = String(chatResponse.body.sessionId ?? "");
	assert(sessionId.length > 0, "不传 sessionId 时自动新建会话并回 sessionId");

	const continued = await request("POST", "/v1/chat", {
		apiKey,
		body: { messages: [{ role: "user", content: "接着说一句" }], sessionId },
	});
	assert(continued.status === 200 && continued.body.sessionId === sessionId, "传 sessionId 时续用同一个会话");

	// ---------- 8. /v1/chat 流式 ----------
	console.log("\n[7] /v1/chat（流式 SSE）");
	const stream = await request("POST", "/v1/chat", {
		apiKey,
		body: { messages: [{ role: "user", content: "流式测试" }], stream: true },
	});
	assert(stream.status === 200, "流式请求 → 200");
	const sse = parseSse(stream.text);
	assert(sse.done, "流式响应以 data: [DONE] 结束");
	const streamed = deltasOf(sse.chunks);
	assert(streamed.length > 0, "流式响应至少有一个 delta 正文");

	// ---------- 9. 鉴权与限流 ----------
	console.log("\n[8] 鉴权 / 停用 / 限流");
	const badKey = await request("POST", "/v1/chat", {
		apiKey: "bk_not_a_real_key",
		body: { messages: [{ role: "user", content: "hi" }] },
	});
	assert(badKey.status === 401, "坏 key → 401");
	const badKeyError = badKey.body.error as Record<string, unknown>;
	assert(
		Boolean(badKeyError) && typeof badKeyError.message === "string" && badKeyError.type === "authentication_error",
		"401 错误形状是 { error: { message, type, code } }",
	);

	const disabledKeyCreated = await request("POST", "/api/api-keys", {
		token: owner,
		body: { name: `停用冒烟-${suffix}`, role: "operator" },
	});
	const disabledKey = String((disabledKeyCreated.body as Record<string, unknown>).key ?? "");
	const disabledItem = disabledKeyCreated.body.item as Record<string, unknown>;
	await request("PATCH", `/api/api-keys/${String(disabledItem.id)}`, { token: owner, body: { disabled: true } });
	const disabledResponse = await request("POST", "/v1/chat", {
		apiKey: disabledKey,
		body: { messages: [{ role: "user", content: "hi" }] },
	});
	assert(disabledResponse.status === 401, "停用后的 key → 401");

	const auditorKeyCreated = await request("POST", "/api/api-keys", {
		token: owner,
		body: { name: `审计员冒烟-${suffix}`, role: "auditor" },
	});
	const auditorKey = String((auditorKeyCreated.body as Record<string, unknown>).key ?? "");
	const auditorChat = await request("POST", "/v1/chat", {
		apiKey: auditorKey,
		body: { messages: [{ role: "user", content: "hi" }] },
	});
	assert(auditorChat.status === 403, "auditor 角色的 key 不能调 /v1/chat → 403（同一权限矩阵）");

	const limitedKeyCreated = await request("POST", "/api/api-keys", {
		token: owner,
		body: { name: `限流冒烟-${suffix}`, role: "operator", rateLimitPerMin: 2 },
	});
	const limitedKey = String((limitedKeyCreated.body as Record<string, unknown>).key ?? "");
	const limitedItem = limitedKeyCreated.body.item as Record<string, unknown>;
	const firstLimited = await request("POST", "/v1/chat", {
		apiKey: limitedKey,
		body: { messages: [{ role: "user", content: "第一次" }] },
	});
	const secondLimited = await request("POST", "/v1/chat", {
		apiKey: limitedKey,
		body: { messages: [{ role: "user", content: "第二次" }] },
	});
	assert(firstLimited.status === 200 && secondLimited.status === 200, "容量内的两次请求通过");
	const thirdLimited = await request("POST", "/v1/chat", {
		apiKey: limitedKey,
		body: { messages: [{ role: "user", content: "第三次" }] },
	});
	assert(thirdLimited.status === 429, "超过 rateLimitPerMin → 429");
	assert(Number(thirdLimited.headers.get("retry-after")) >= 1, "429 带 Retry-After 头（秒）");
	const limitedError = thirdLimited.body.error as Record<string, unknown>;
	assert(limitedError?.code === "rate_limited", "429 错误码 rate_limited");

	// ---------- 10. /v1/health 免鉴权 ----------
	console.log("\n[9] /v1/health");
	const v1Health = await request("GET", "/v1/health");
	assert(v1Health.status === 200 && v1Health.body.ok === true, "/v1/health 无需鉴权 → 200");
	assert(typeof v1Health.body.version === "string" && v1Health.body.version.length > 0, "/v1/health 带 version");
	assert(typeof v1Health.body.uptimeMs === "number", "/v1/health 带 uptimeMs");
	assert(
		typeof v1Health.body.model === "object" && typeof v1Health.body.storage === "object",
		"/v1/health 带 model 与 storage 观测字段",
	);

	// ---------- 11. 审计 ----------
	console.log("\n[10] 审计");
	const audit = await request("GET", `/api/audit?action=openapi.chat&actor=${encodeURIComponent(String(keyItem.id))}`, {
		token: owner,
	});
	assert(audit.status === 200 && Array.isArray(audit.body.items), "GET /api/audit?action=openapi.chat 可查");
	const auditItems = audit.body.items as Record<string, unknown>[];
	assert(
		auditItems.length > 0 && auditItems.every((item) => item.actorType === "api_key"),
		"审计里有 api_key 的记录（actor_type=api_key）",
	);
	assert(
		auditItems.some((item) => typeof item.traceId === "string" && String(item.traceId).startsWith("trace-")),
		"每条开放 API 审计都带随机 trace_id",
	);
	const limitedAudit = await request("GET", `/api/audit?action=openapi.chat&actor=${encodeURIComponent(String(limitedItem.id))}`, {
		token: owner,
	});
	assert(limitedAudit.status === 200 && (limitedAudit.body.items as unknown[]).length > 0, "429 的请求也落审计");

	await new Promise<void>((resolve) => fake.server.close(() => resolve()));
	console.log(`\n全部通过：${assertions} 项断言`);
}

await main();
