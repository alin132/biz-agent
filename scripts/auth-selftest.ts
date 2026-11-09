/**
 * P3 企业安全自检（**不需要起服务**）：`npm run auth:selftest`
 *
 * 覆盖四块纯逻辑 + 一块真实 DAO：
 *   1. 口令：scrypt 自描述哈希、随机盐、正确/错误口令、被篡改的哈希、坏格式不抛错
 *   2. 令牌：签发/验签、过期、改 payload、换密钥、坏格式、Bearer 解析
 *   3. 矩阵：四角色权限点、路径 → 权限点映射、403 中文文案
 *   4. 限流：连续失败锁定、成功清零、窗口过期解锁、不同 key 独立
 *   5. DAO：临时 SQLite 库上的用户与审计读写（含 updateUser/deleteUser 往返与计数）、
 *      AUTH_MODE=required 的初始账号引导、成员写接口的保护规则（最后一个所有者 / 不能动自己 / 停用后令牌失效）
 *
 * 令牌与口令都不走网络、不落盘，所以这里能直接断言细节；端到端链路看 `npm run smoke:auth`。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import { openStore } from "../server/db/index.js";
import type { Storage } from "../server/db/types.js";
import { bearerToken, DEFAULT_TTL_SECONDS, peekClaims, signToken, verifyToken } from "../server/auth/jwt.js";
import { hashPassword, isPasswordHash, randomPassword, verifyPassword } from "../server/auth/password.js";
import { LoginRateLimiter } from "../server/auth/rateLimit.js";
import { can, denyMessage, permissionFor, permissionsOf, ROLE_LABELS } from "../server/auth/roles.js";
import { DEMO_USER, initAuth, normalizeEmail } from "../server/auth/service.js";
import type { AuthRuntime } from "../server/auth/service.js";

let passed = 0;

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
	await fn();
	passed++;
	console.log(`  ✓ ${name}`);
}

/** 造一个只带 headers 的假请求（guard 只读 Authorization 与 socket）。 */
function fakeRequest(authorization?: string): IncomingMessage {
	return {
		headers: authorization ? { authorization } : {},
		socket: { remoteAddress: "127.0.0.1" },
	} as unknown as IncomingMessage;
}

/** 临时 SQLite 库：每个用例组一份，跑完删掉。 */
function tempStore(): { store: Storage; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "biz-agent-auth-"));
	const store = openStore({ dbPath: join(dir, "auth.db") });
	return {
		store,
		cleanup: () => {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

/** 临时改环境变量后跑一次 initAuth，跑完恢复（initAuth 按环境变量决定模式与初始账号）。 */
function initAuthWithEnv(patch: Record<string, string | undefined>, store: Storage): AuthRuntime {
	const saved = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries(patch)) {
		saved.set(key, process.env[key]);
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
	try {
		return initAuth(store);
	} finally {
		for (const [key, value] of saved) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	}
}

async function testPassword(): Promise<void> {
	console.log("\n[1] 口令哈希（scrypt，自描述格式）");

	await check("哈希是 scrypt$N$r$p$salt$hash 自描述串，且 sha256 之外不落明文", () => {
		const stored = hashPassword("s3cret-pass");
		assert.ok(isPasswordHash(stored), `格式不对: ${stored.slice(0, 20)}…`);
		assert.match(stored, /^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
		assert.ok(!stored.includes("s3cret-pass"), "哈希里不该出现明文口令");
	});

	await check("同一口令两次哈希不同（随机盐）", () => {
		const first = hashPassword("same-pass");
		const second = hashPassword("same-pass");
		assert.notEqual(first, second);
		assert.ok(verifyPassword("same-pass", first) && verifyPassword("same-pass", second));
	});

	await check("正确口令校验通过、错误口令校验失败", () => {
		const stored = hashPassword("correct-horse");
		assert.equal(verifyPassword("correct-horse", stored), true);
		assert.equal(verifyPassword("Correct-Horse", stored), false);
		assert.equal(verifyPassword("", stored), false);
	});

	await check("被篡改的哈希（改一个字节）校验失败", () => {
		const stored = hashPassword("tamper-me");
		const parts = stored.split("$");
		// 改「倒数第二个」base64 字符：末位字符有 4 个填充位，换成另一个字符可能解码出同样的字节，
		// 会让这条断言偶发假失败（曾经踩过）；倒数第二个是完整有效位，改动一定反映到解码结果上。
		const hash = parts[5]!;
		const index = hash.length - 2;
		const flipped = hash.slice(0, index) + (hash[index] === "A" ? "B" : "A") + hash.slice(index + 1);
		const tampered = [...parts.slice(0, 5), flipped].join("$");
		assert.notEqual(tampered, stored);
		assert.equal(verifyPassword("tamper-me", tampered), false);
	});

	await check("坏格式（不是 scrypt 串 / 段数不对 / 空值 / 参数非法）一律 false，不抛错", () => {
		assert.equal(verifyPassword("x", "bcrypt$whatever"), false);
		assert.equal(verifyPassword("x", "scrypt$16384$8"), false);
		assert.equal(verifyPassword("x", ""), false);
		assert.equal(verifyPassword("x", null), false);
		assert.equal(verifyPassword("x", undefined), false);
		// N 被改成天文数字：scrypt 会拒绝，这里必须收敛成 false 而不是抛异常
		assert.equal(verifyPassword("x", "scrypt$1073741824$8$1$c2FsdA$aGFzaA"), false);
	});

	await check("随机口令是 16 位且同时含大小写字母与数字", () => {
		const password = randomPassword(16);
		assert.equal(password.length, 16);
		assert.match(password, /[A-Z]/);
		assert.match(password, /[a-z]/);
		assert.match(password, /\d/);
	});
}

async function testJwt(): Promise<void> {
	console.log("\n[2] JWT（HS256，无第三方库）");

	const secret = "test-secret-0123456789";
	const claims = { sub: "user-abc", role: "developer" as const, workspace_id: "default", email: "dev@local" };

	await check("签发后能验签，claims 与有效期符合预期", () => {
		const token = signToken(claims, secret);
		assert.equal(token.split(".").length, 3);
		const verified = verifyToken(token, secret);
		assert.equal(verified.ok, true);
		if (!verified.ok) return;
		assert.equal(verified.claims.sub, "user-abc");
		assert.equal(verified.claims.role, "developer");
		assert.equal(verified.claims.workspace_id, "default");
		assert.equal(verified.claims.email, "dev@local");
		assert.equal(verified.claims.exp - verified.claims.iat, DEFAULT_TTL_SECONDS);
	});

	await check("过期令牌被拒（reason=expired）", () => {
		const now = 1_700_000_000_000;
		const token = signToken(claims, secret, { ttlSeconds: 60, now });
		assert.equal(verifyToken(token, secret, { now: now + 30_000 }).ok, true, "30 秒后还不该过期");
		const expired = verifyToken(token, secret, { now: now + 70_000 });
		assert.equal(expired.ok, false);
		if (!expired.ok) assert.equal(expired.reason, "expired");
	});

	await check("改 payload（developer → owner）验签失败", () => {
		const token = signToken(claims, secret);
		const [header, , signature] = token.split(".") as [string, string, string];
		const forgedClaims = { ...peekClaims(token), role: "owner" };
		const forgedPayload = Buffer.from(JSON.stringify(forgedClaims), "utf8").toString("base64url");
		const result = verifyToken(`${header}.${forgedPayload}.${signature}`, secret);
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.reason, "bad-signature");
	});

	await check("换密钥验签失败、坏格式被判为 malformed", () => {
		const token = signToken(claims, secret);
		const wrongKey = verifyToken(token, "another-secret");
		assert.equal(wrongKey.ok, false);
		if (!wrongKey.ok) assert.equal(wrongKey.reason, "bad-signature");

		for (const bad of ["", "abc", "a.b", "a.b.c.d"]) {
			const result = verifyToken(bad, secret);
			assert.equal(result.ok, false);
			if (!result.ok) assert.equal(result.reason, "malformed");
		}
	});

	await check("Bearer 头解析：大小写、缺头、空值", () => {
		assert.equal(bearerToken("Bearer abc.def.ghi"), "abc.def.ghi");
		assert.equal(bearerToken("bearer abc"), "abc");
		assert.equal(bearerToken(undefined), null);
		assert.equal(bearerToken("Token abc"), null);
		assert.equal(bearerToken("Bearer  "), null);
	});
}

async function testRoles(): Promise<void> {
	console.log("\n[3] 四角色矩阵与路径映射");

	await check("owner 拥有全部 8 个权限点", () => {
		assert.equal(permissionsOf("owner").length, 8);
		for (const permission of ["workflow.write", "member.manage", "settings.write", "audit.read"] as const) {
			assert.equal(can("owner", permission), true, `owner 应该有 ${permission}`);
		}
	});

	await check("developer：能改技能、能看审计，不能管成员/改设置", () => {
		assert.equal(can("developer", "workflow.write"), true);
		assert.equal(can("developer", "session.run"), true);
		assert.equal(can("developer", "audit.read"), true);
		assert.equal(can("developer", "member.manage"), false);
		assert.equal(can("developer", "settings.write"), false);
	});

	await check("operator：能跑会话，不能改技能、不能读审计（按接口口径）", () => {
		assert.equal(can("operator", "session.run"), true);
		assert.equal(can("operator", "session.write"), true);
		assert.equal(can("operator", "workflow.write"), false);
		assert.equal(can("operator", "audit.read"), false);
	});

	await check("auditor：只读（读会话/审计/技能），不能发言、不能改", () => {
		assert.deepEqual(permissionsOf("auditor").sort(), ["audit.read", "session.read", "workflow.read"]);
		assert.equal(can("auditor", "session.run"), false);
		assert.equal(can("auditor", "session.write"), false);
		assert.equal(can("auditor", "workflow.write"), false);
	});

	await check("方法 + 路径 → 权限点映射", () => {
		assert.equal(permissionFor("GET", "/api/workflows"), "workflow.read");
		assert.equal(permissionFor("POST", "/api/workflows"), "workflow.write");
		assert.equal(permissionFor("PATCH", "/api/workflows/ticket-flow"), "workflow.write");
		assert.equal(permissionFor("DELETE", "/api/workflows/ticket-flow"), "workflow.write");
		assert.equal(permissionFor("GET", "/api/sessions"), "session.read");
		assert.equal(permissionFor("POST", "/api/sessions"), "session.write");
		assert.equal(permissionFor("PATCH", "/api/sessions/s-1"), "session.write");
		assert.equal(permissionFor("POST", "/api/sessions/s-1/messages"), "session.run");
		assert.equal(permissionFor("POST", "/api/sessions/s-1/stop"), "session.run");
		assert.equal(permissionFor("POST", "/api/sessions/s-1/skills"), "session.run");
		assert.equal(permissionFor("POST", "/api/sessions/s-1/pi-tree/navigate"), "session.run");
		assert.equal(permissionFor("GET", "/api/pi/settings"), "workflow.read");
		assert.equal(permissionFor("PUT", "/api/pi/settings"), "settings.write");
		assert.equal(permissionFor("GET", "/api/sessions/s-1/events"), "session.read");
		assert.equal(permissionFor("GET", "/api/agent-groups"), "session.read");
		assert.equal(permissionFor("POST", "/api/agent-groups"), "session.write");
		assert.equal(permissionFor("GET", "/api/agent-groups/group-1"), "session.read");
		assert.equal(permissionFor("POST", "/api/agent-groups/group-1/turns"), "session.run");
		assert.equal(permissionFor("DELETE", "/api/agent-groups/group-1"), "session.write");
		assert.equal(permissionFor("GET", "/api/audit"), "audit.read");
		assert.equal(permissionFor("GET", "/api/health"), null, "探针不需要权限点");
	});

	await check("成员写接口（/api/auth/users/:id）也映射 member.manage，列表权限不变", () => {
		assert.equal(permissionFor("GET", "/api/auth/users"), "member.manage", "成员列表权限不能被改坏");
		assert.equal(permissionFor("PATCH", "/api/auth/users/user-1"), "member.manage");
		assert.equal(permissionFor("DELETE", "/api/auth/users/user-1"), "member.manage");
		assert.equal(can("developer", "member.manage"), false, "非 owner 不能走成员写接口");
		assert.equal(can("owner", "member.manage"), true);
	});

	await check("403 文案是中文人话（角色名 + 动作）", () => {
		assert.equal(denyMessage("operator", "workflow.write"), "当前角色是运营，不能修改技能");
		assert.equal(denyMessage("auditor", "session.run"), "当前角色是审计员，不能让会话发言");
		assert.equal(denyMessage("developer", "member.manage"), "当前角色是开发者，不能管理成员");
		assert.equal(ROLE_LABELS.owner, "所有者");
		assert.equal(normalizeEmail("  Owner@Local.COM "), "owner@local.com");
	});
}

async function testRateLimit(): Promise<void> {
	console.log("\n[4] 登录限流（email + IP，5 次 / 5 分钟）");

	await check("连续失败 5 次后锁定，第 6 次直接拦下并给出剩余时间", () => {
		let clock = 1_000_000;
		const limiter = new LoginRateLimiter({ now: () => clock });
		const key = "a@local|127.0.0.1";
		for (let index = 0; index < 4; index += 1) {
			limiter.fail(key);
			assert.equal(limiter.check(key).blocked, false, `第 ${index + 1} 次还不该锁`);
		}
		limiter.fail(key);
		const decision = limiter.check(key);
		assert.equal(decision.blocked, true);
		assert.equal(decision.retryAfterMs, 5 * 60 * 1000);
		assert.equal(limiter.failuresOf(key), 5);
		clock += 60_000;
		assert.equal(limiter.check(key).retryAfterMs, 4 * 60 * 1000);
	});

	await check("登录成功清零；窗口过去后自动解锁", () => {
		let clock = 2_000_000;
		const limiter = new LoginRateLimiter({ now: () => clock });
		const key = "b@local|127.0.0.1";
		limiter.fail(key);
		limiter.fail(key);
		limiter.succeed(key);
		assert.equal(limiter.failuresOf(key), 0);

		for (let index = 0; index < 5; index += 1) limiter.fail(key);
		assert.equal(limiter.check(key).blocked, true);
		clock += 5 * 60 * 1000 + 1;
		assert.equal(limiter.check(key).blocked, false, "锁定窗口过去后应放行");
	});

	await check("不同 email / IP 互不影响", () => {
		let clock = 3_000_000;
		const limiter = new LoginRateLimiter({ now: () => clock });
		for (let index = 0; index < 5; index += 1) limiter.fail("c@local|10.0.0.1");
		assert.equal(limiter.check("c@local|10.0.0.1").blocked, true);
		assert.equal(limiter.check("c@local|10.0.0.2").blocked, false);
		assert.equal(limiter.check("d@local|10.0.0.1").blocked, false);
		clock += 1;
		assert.ok(limiter.size() >= 1);
	});
}

async function testDao(): Promise<void> {
	console.log("\n[5] DAO：用户与审计（临时 SQLite 库）");

	const { store, cleanup } = tempStore();
	try {
		await check("用户：建 → 按邮箱/按 id 查 → 列表 → 计数 → 更新登录时间", () => {
			assert.equal(store.countUsers(), 0);
			const created = store.createUser({
				id: "user-1",
				workspaceId: "default",
				email: "ops@local",
				name: "运营小王",
				passwordHash: hashPassword("ops-pass"),
				role: "operator",
				disabled: false,
				createdAt: 1_000,
			});
			assert.equal(created.role, "operator");

			const byEmail = store.getUserByEmail("ops@local");
			assert.equal(byEmail?.id, "user-1");
			assert.equal(byEmail?.name, "运营小王");
			assert.equal(byEmail?.lastLoginAt, null);
			assert.ok(isPasswordHash(byEmail?.passwordHash), "库里只存哈希");
			assert.equal(store.getUserById("user-1")?.email, "ops@local");
			assert.equal(store.getUserByEmail("nobody@local"), undefined);

			store.updateLoginTime("user-1", 2_000);
			assert.equal(store.getUserById("user-1")?.lastLoginAt, 2_000);

			store.createUser({
				id: "user-2",
				workspaceId: "default",
				email: "auditor@local",
				name: null,
				passwordHash: null,
				role: "auditor",
				disabled: true,
				createdAt: 1_500,
			});
			assert.equal(store.countUsers(), 2);
			assert.deepEqual(
				store.listUsers().map((user) => user.email),
				["ops@local", "auditor@local"],
				"按创建时间升序",
			);
			assert.equal(store.getUserById("user-2")?.disabled, true);
		});

		await check("updateUser：角色 / 停用 / 姓名 往返，id 不存在返回 undefined", () => {
			assert.equal(store.updateUser("user-1", { role: "developer" })?.role, "developer");
			assert.equal(store.updateUser("user-1", { disabled: true })?.disabled, true);
			assert.equal(store.updateUser("user-1", { name: "改过的名字" })?.name, "改过的名字");
			const reread = store.getUserById("user-1");
			assert.equal(reread?.role, "developer");
			assert.equal(reread?.disabled, true, "停用要真的落库");
			assert.equal(reread?.name, "改过的名字");
			assert.equal(reread?.email, "ops@local", "未传的字段不能被清掉");
			// 姓名可以显式清空（null），与"不传"是两种语义
			assert.equal(store.updateUser("user-1", { name: null })?.name, null);
			assert.equal(store.updateUser("ghost", { role: "owner" }), undefined);
			assert.equal(store.updateUser("user-1", {})?.id, "user-1", "空补丁只回读");
		});

		await check("deleteUser：删除后按 id / 邮箱都查不到，重复删除返回 false", () => {
			assert.equal(store.deleteUser("user-2"), true);
			assert.equal(store.getUserById("user-2"), undefined);
			assert.equal(store.getUserByEmail("auditor@local"), undefined);
			assert.equal(store.deleteUser("user-2"), false);
			assert.equal(store.deleteUser("ghost"), false);
			assert.equal(store.countUsers(), 1);
		});

		await check("审计：写入 → 倒序列表 → action/actor 过滤 → 计数", () => {
			assert.equal(store.countAudit(), 0);
			store.appendAudit({
				workspaceId: "default",
				actorType: "user",
				actorId: "user-1",
				action: "auth.login",
				targetType: "user",
				targetId: "user-1",
				detail: { email: "ops@local", role: "operator" },
				traceId: "trace-1",
				createdAt: 1_000,
			});
			store.appendAudit({
				workspaceId: "default",
				actorType: "user",
				actorId: "user-1",
				action: "session.create",
				targetType: "session",
				targetId: "session-9",
				detail: { method: "POST", status: 201 },
				createdAt: 2_000,
			});
			store.appendAudit({
				workspaceId: "default",
				actorType: "anonymous",
				actorId: null,
				action: "auth.login.failed",
				detail: { email: "bad@local", reason: "unknown-account" },
				createdAt: 3_000,
			});

			const all = store.listAudit({ limit: 50, offset: 0 });
			assert.equal(all.length, 3);
			assert.deepEqual(
				all.map((row) => row.createdAt),
				[3_000, 2_000, 1_000],
				"必须倒序（最新的在前）",
			);
			assert.deepEqual(all[2]!.detail, { email: "ops@local", role: "operator" }, "detail 要还原成对象");
			assert.equal(all[0]!.actorId, null);

			assert.equal(store.countAudit(), 3);
			assert.equal(store.countAudit({ action: "auth.login" }), 1);
			assert.equal(store.countAudit({ actor: "user-1" }), 2);
			const logins = store.listAudit({ limit: 50, offset: 0, action: "auth.login" });
			assert.equal(logins.length, 1);
			assert.equal(logins[0]!.action, "auth.login");

			const page = store.listAudit({ limit: 1, offset: 1 });
			assert.equal(page.length, 1);
			assert.equal(page[0]!.createdAt, 2_000, "分页按倒序偏移");
		});
	} finally {
		cleanup();
	}
}

async function testService(): Promise<void> {
	console.log("\n[6] 认证服务：初始账号引导、登录、guard、off 模式");

	// ---- AUTH_MODE=required + 空库 → 建初始所有者 ----
	const requiredDb = tempStore();
	try {
		const rt = initAuthWithEnv(
			{
				AUTH_MODE: "required",
				AUTH_SECRET: "unit-test-secret",
				AUTH_BOOTSTRAP_EMAIL: "owner@local",
				AUTH_BOOTSTRAP_PASSWORD: "owner-pass-123",
			},
			requiredDb.store,
		);

		await check("AUTH_MODE=required 且 users 为空 → 自动建初始所有者账号", () => {
			assert.equal(rt.mode, "required");
			assert.equal(requiredDb.store.countUsers(), 1);
			const owner = requiredDb.store.getUserByEmail("owner@local");
			assert.ok(owner, "初始账号应存在");
			assert.equal(owner?.role, "owner");
			assert.equal(verifyPassword("owner-pass-123", owner?.passwordHash), true);
		});

		await check("再次 initAuth 不会重复建账号", () => {
			initAuthWithEnv({ AUTH_MODE: "required", AUTH_SECRET: "unit-test-secret" }, requiredDb.store);
			assert.equal(requiredDb.store.countUsers(), 1);
		});

		await check("登录：正确口令发令牌、错误口令 401、unknown 账号也是同一句文案", () => {
			const ok = rt.login("owner@local", "owner-pass-123", "127.0.0.1");
			assert.equal(ok.ok, true);
			if (ok.ok) {
				assert.equal(ok.user.role, "owner");
				assert.equal(verifyToken(ok.token, "unit-test-secret").ok, true);
			}
			const wrong = rt.login("owner@local", "wrong-pass", "127.0.0.1");
			assert.equal(wrong.ok, false);
			if (!wrong.ok) {
				assert.equal(wrong.status, 401);
				assert.equal(wrong.error, "邮箱或密码不对");
			}
			const unknown = rt.login("ghost@local", "whatever", "127.0.0.1");
			assert.equal(unknown.ok, false);
			if (!unknown.ok) assert.equal(unknown.error, "邮箱或密码不对", "不区分账号不存在");
		});

		await check("guard：无令牌 401、坏令牌 401、有效令牌放行", () => {
			assert.equal(rt.guard(fakeRequest(), "GET", "/api/sessions")?.status, 401);
			assert.equal(rt.guard(fakeRequest("Bearer not-a-token"), "GET", "/api/sessions")?.error, "未登录或登录已过期");
			assert.equal(rt.guard(fakeRequest(), "GET", "/api/health"), null, "/api/health 永远放行");
			assert.equal(rt.guard(fakeRequest(), "POST", "/api/auth/login"), null, "登录接口本身不需要令牌");

			const login = rt.login("owner@local", "owner-pass-123", "127.0.0.1");
			assert.equal(login.ok, true);
			if (!login.ok) return;
			const request = fakeRequest(`Bearer ${login.token}`);
			assert.equal(rt.guard(request, "DELETE", "/api/workflows/x"), null, "owner 删技能应放行");
			assert.equal(rt.userOf(request)?.role, "owner", "放行后 req 上应挂着用户");
			assert.equal(rt.listAudit({ limit: 50, offset: 0 }).length > 0, true, "登录应留下审计");
		});

		await check("guard：角色不够时 403 且文案是中文", () => {
			const created = rt.createUser({ email: "ops@local", password: "ops-pass-123", role: "operator", name: "运营" });
			assert.equal(created.ok, true);
			const login = rt.login("ops@local", "ops-pass-123", "10.1.1.1");
			assert.equal(login.ok, true);
			if (!login.ok) return;
			const denied = rt.guard(fakeRequest(`Bearer ${login.token}`), "POST", "/api/workflows");
			assert.equal(denied?.status, 403);
			assert.equal(denied?.error, "当前角色是运营，不能修改技能");
			assert.equal(rt.guard(fakeRequest(`Bearer ${login.token}`), "POST", "/api/sessions"), null, "运营可以建会话");
		});

		await check("登录连续失败 5 次 → 429（内存限流生效）", () => {
			const results = [];
			for (let index = 0; index < 5; index += 1) {
				results.push(rt.login("owner@local", "bad-pass", "192.168.9.9"));
			}
			assert.equal(
				results.every((result) => !result.ok && result.status === 401),
				true,
				"前 5 次应是 401",
			);
			const blocked = rt.login("owner@local", "owner-pass-123", "192.168.9.9");
			assert.equal(blocked.ok, false, "即使口令对，锁定期内也要拦");
			if (!blocked.ok) {
				assert.equal(blocked.status, 429);
				assert.match(blocked.error, /尝试太频繁/);
			}
		});

		await check("停用账号不能登录（口令对也不行）", () => {
			requiredDb.store.createUser({
				id: "user-disabled",
				workspaceId: "default",
				email: "gone@local",
				name: null,
				passwordHash: hashPassword("gone-pass-123"),
				role: "auditor",
				disabled: true,
				createdAt: Date.now(),
			});
			const denied = rt.login("gone@local", "gone-pass-123", "10.2.2.3");
			assert.equal(denied.ok, false);
			if (!denied.ok) {
				assert.equal(denied.status, 401);
				assert.equal(denied.error, "邮箱或密码不对", "停用账号对外也要像口令错一样");
			}
		});

		await check("updateMember：改角色 / 停用 / 姓名，listUsers（toAuthUser）反映 disabled，并写 user.update 审计", () => {
			const owner = requiredDb.store.getUserByEmail("owner@local");
			assert.ok(owner);
			const created = rt.createUser({ email: "member@local", password: "member-pass-123", role: "operator", name: "小运营" });
			assert.equal(created.ok, true);
			if (!created.ok || !owner) return;

			const byRole = rt.updateMember(created.user.id, { role: "developer" }, owner.id);
			assert.equal(byRole.ok, true);
			if (!byRole.ok) return;
			assert.equal(byRole.user.role, "developer", "返回更新后的角色");

			const disabled = rt.updateMember(created.user.id, { disabled: true }, owner.id);
			assert.equal(disabled.ok, true);
			if (!disabled.ok) return;
			assert.equal(disabled.user.disabled, true, "返回的 AuthUser 要反映停用");
			const listed = rt.listUsers().find((user) => user.id === created.user.id);
			assert.equal(listed?.disabled, true, "listUsers 走 toAuthUser，也要反映 disabled");

			const renamed = rt.updateMember(created.user.id, { name: "改名了" }, owner.id);
			assert.equal(renamed.ok, true);
			if (!renamed.ok) return;
			assert.equal(renamed.user.name, "改名了");

			const audit = rt.listAudit({ limit: 50, offset: 0, action: "user.update" });
			assert.ok(audit.length >= 3, "每次成功 update 都要落一条审计");
			assert.equal(audit[0]?.targetType, "user");
			assert.equal(audit[0]?.targetId, created.user.id);
			assert.equal(audit[0]?.actorId, owner.id, "actor 必须是当前操作者");
			assert.equal(audit[0]?.actorType, "user");
			const detail = audit[0]?.detail as { changes?: Record<string, unknown> } | undefined;
			assert.deepEqual(detail?.changes, { name: "改名了" }, "detail 带变化字段");
		});

		await check("updateMember / removeMember：目标不存在 → 404「成员不存在」", () => {
			const owner = requiredDb.store.getUserByEmail("owner@local");
			assert.ok(owner);
			if (!owner) return;
			const update = rt.updateMember("user-ghost", { role: "developer" }, owner.id);
			assert.equal(update.ok, false);
			if (!update.ok) {
				assert.equal(update.status, 404);
				assert.equal(update.error, "成员不存在");
			}
			const remove = rt.removeMember("user-ghost", owner.id);
			assert.equal(remove.ok, false);
			if (!remove.ok) {
				assert.equal(remove.status, 404);
				assert.equal(remove.error, "成员不存在");
			}
		});

		await check("updateMember / removeMember：不能对自己降级 / 停用 / 删除 → 400", () => {
			const owner = requiredDb.store.getUserByEmail("owner@local");
			assert.ok(owner);
			if (!owner) return;
			const demote = rt.updateMember(owner.id, { role: "developer" }, owner.id);
			assert.equal(demote.ok, false);
			if (!demote.ok) {
				assert.equal(demote.status, 400);
				assert.equal(demote.error, "不能修改自己的角色或状态");
			}
			const disable = rt.updateMember(owner.id, { disabled: true }, owner.id);
			assert.equal(disable.ok, false);
			if (!disable.ok) assert.equal(disable.error, "不能修改自己的角色或状态");
			const remove = rt.removeMember(owner.id, owner.id);
			assert.equal(remove.ok, false);
			if (!remove.ok) {
				assert.equal(remove.status, 400);
				assert.equal(remove.error, "不能修改自己的角色或状态");
			}
			// 只改姓名不是"改角色或状态"，应当允许
			assert.equal(rt.updateMember(owner.id, { name: "所有者本人" }, owner.id).ok, true);
		});

		await check("updateMember：非法 role / disabled 非布尔 / 姓名超长 → 400 中文文案", () => {
			const owner = requiredDb.store.getUserByEmail("owner@local");
			assert.ok(owner);
			if (!owner) return;
			const badRole = rt.updateMember("user-disabled", { role: "admin" as never }, owner.id);
			assert.equal(badRole.ok, false);
			if (!badRole.ok) {
				assert.equal(badRole.status, 400);
				assert.equal(badRole.error, "角色只能是 owner/developer/operator/auditor");
			}
			const badDisabled = rt.updateMember("user-disabled", { disabled: "yes" as never }, owner.id);
			assert.equal(badDisabled.ok, false);
			if (!badDisabled.ok) {
				assert.equal(badDisabled.status, 400);
				assert.equal(badDisabled.error, "disabled 只能是 true 或 false");
			}
			const longName = rt.updateMember("user-disabled", { name: "名".repeat(41) }, owner.id);
			assert.equal(longName.ok, false);
			if (!longName.ok) {
				assert.equal(longName.status, 400);
				assert.equal(longName.error, "姓名最长 40 个字符");
			}
			// 40 个字符是边界内，应成功
			assert.equal(rt.updateMember("user-disabled", { name: "名".repeat(40) }, owner.id).ok, true);
		});

		await check("最后一个启用中的 owner 不能被降级 / 停用 / 删除 → 400", () => {
			const owner = requiredDb.store.getUserByEmail("owner@local");
			const member = requiredDb.store.getUserByEmail("member@local");
			assert.ok(owner && member);
			if (!owner || !member) return;
			const enabledOwners = requiredDb.store.listUsers().filter((user) => user.role === "owner" && !user.disabled);
			assert.equal(enabledOwners.length, 1, "此刻只有一个启用 owner");
			// 用另一个账号当操作者，绕开"不能动自己"，单测保护规则本身
			const demote = rt.updateMember(owner.id, { role: "operator" }, member.id);
			assert.equal(demote.ok, false);
			if (!demote.ok) {
				assert.equal(demote.status, 400);
				assert.equal(demote.error, "至少要保留一个启用的所有者");
			}
			const disable = rt.updateMember(owner.id, { disabled: true }, member.id);
			assert.equal(disable.ok, false);
			if (!disable.ok) assert.equal(disable.error, "至少要保留一个启用的所有者");
			const remove = rt.removeMember(owner.id, member.id);
			assert.equal(remove.ok, false);
			if (!remove.ok) {
				assert.equal(remove.status, 400);
				assert.equal(remove.error, "至少要保留一个启用的所有者");
			}
			// 有第二个启用 owner 后，降级原 owner 就应放行
			const second = rt.createUser({ email: "owner2@local", password: "owner2-pass-123", role: "owner" });
			assert.equal(second.ok, true);
			if (!second.ok) return;
			const allowed = rt.updateMember(owner.id, { role: "auditor" }, second.user.id);
			assert.equal(allowed.ok, true, "还有另一个启用 owner 时应允许降级");
			if (allowed.ok) assert.equal(allowed.user.role, "auditor");
		});

		await check("removeMember：删除成功后按 id / 邮箱都查不到，并写 user.delete 审计", () => {
			const actor = requiredDb.store.getUserByEmail("owner2@local");
			const target = requiredDb.store.getUserByEmail("member@local");
			assert.ok(actor && target);
			if (!actor || !target) return;
			const result = rt.removeMember(target.id, actor.id);
			assert.equal(result.ok, true);
			if (!result.ok) return;
			assert.equal(result.user.email, "member@local", "返回值带被删成员快照");
			assert.equal(requiredDb.store.getUserById(target.id), undefined);
			assert.equal(requiredDb.store.getUserByEmail("member@local"), undefined);
			const audit = rt.listAudit({ limit: 20, offset: 0, action: "user.delete" });
			assert.ok(audit.length >= 1, "删除要落 user.delete 审计");
			assert.equal(audit[0]?.targetType, "user");
			assert.equal(audit[0]?.targetId, target.id);
			assert.equal(audit[0]?.actorId, actor.id);
		});

		await check("停用后已签发的令牌立刻被 guard 拒绝（401），重新启用后恢复", () => {
			const owner = requiredDb.store.getUserByEmail("owner2@local");
			assert.ok(owner);
			if (!owner) return;
			const created = rt.createUser({ email: "blocked@local", password: "blocked-pass-123", role: "developer" });
			assert.equal(created.ok, true);
			if (!created.ok) return;
			const login = rt.login("blocked@local", "blocked-pass-123", "10.9.9.9");
			assert.equal(login.ok, true);
			if (!login.ok) return;
			const request = fakeRequest(`Bearer ${login.token}`);
			assert.equal(rt.guard(request, "GET", "/api/sessions"), null, "停用前令牌可用");

			const disabled = rt.updateMember(created.user.id, { disabled: true }, owner.id);
			assert.equal(disabled.ok, true);
			// guard 每次都按令牌里的 sub 回表，所以旧令牌立刻失效
			assert.equal(rt.guard(fakeRequest(`Bearer ${login.token}`), "GET", "/api/sessions")?.status, 401);
			assert.equal(rt.authenticate(fakeRequest(`Bearer ${login.token}`)), null, "停用账号 authenticate 也是 null");

			const enabled = rt.updateMember(created.user.id, { disabled: false }, owner.id);
			assert.equal(enabled.ok, true);
			assert.equal(rt.guard(fakeRequest(`Bearer ${login.token}`), "GET", "/api/sessions"), null, "重新启用后同一个令牌恢复可用");
		});
	} finally {
		requiredDb.cleanup();
	}

	// ---- AUTH_MODE=off（默认）→ 全部放行 + 演示所有者 ----
	const offDb = tempStore();
	try {
		const rt = initAuthWithEnv({ AUTH_MODE: undefined, AUTH_SECRET: "unit-test-secret" }, offDb.store);

		await check("AUTH_MODE=off：guard 全部放行，并挂演示所有者（不建任何账号）", () => {
			assert.equal(rt.mode, "off");
			assert.equal(offDb.store.countUsers(), 0, "off 模式不该建账号");
			for (const [method, path] of [
				["GET", "/api/sessions"],
				["POST", "/api/workflows"],
				["DELETE", "/api/workflows/x"],
				["GET", "/api/audit"],
			] as const) {
				const request = fakeRequest();
				assert.equal(rt.guard(request, method, path), null, `${method} ${path} 应放行`);
				assert.equal(rt.userOf(request)?.id, DEMO_USER.id);
			}
		});

		await check("AUTH_MODE=off：/api/auth/me 的演示用户是 owner 且权限齐全", () => {
			const request = fakeRequest();
			rt.guard(request, "GET", "/api/auth/me");
			const user = rt.userOf(request);
			assert.equal(user?.role, "owner");
			assert.equal(rt.permissionsOf(user!.role).length, 8);
		});
	} finally {
		offDb.cleanup();
	}
}

async function main(): Promise<void> {
	console.log("P3 企业安全自检（不起服务）");
	await testPassword();
	await testJwt();
	await testRoles();
	await testRateLimit();
	await testDao();
	await testService();
	console.log(`\n全部通过：${passed} 项检查`);
}

await main();
