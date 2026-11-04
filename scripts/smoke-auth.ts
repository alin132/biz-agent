/**
 * P3 企业安全端到端冒烟（要一个 `AUTH_MODE=required` 的实例在跑）：`npm run smoke:auth`
 *
 * 起服务（隔离实例，别碰 4317）：
 *   PowerShell:
 *     $env:PORT="4327"; $env:AUTH_MODE="required"; $env:DB_PATH="data\auth-smoke.db"
 *     $env:AUTH_BOOTSTRAP_PASSWORD="owner12345"; $env:LLM_DISABLE="1"; npm run dev
 *   然后：
 *     $env:SMOKE_AUTH_BASE="http://127.0.0.1:4327"; npm run smoke:auth
 *
 * 脚本自己会用 owner 令牌建出 operator / auditor 两个账号（成员管理接口），
 * 另建一个一次性成员来验 PATCH/DELETE，跑完把 `data/auth-smoke.db` 删掉即可。
 *
 * 覆盖：健康探针公开、无令牌 401、登录成功/失败/限流 429、四角色 403 文案、
 *       成员写接口（改角色/停用启用/删除/保护规则/旧令牌失效/审计）、
 *       审计倒序与过滤、审计对非授权角色 403、令牌被篡改失效。
 */

const BASE = (process.env.SMOKE_AUTH_BASE ?? "http://127.0.0.1:4327").replace(/\/$/, "");
const OWNER_EMAIL = process.env.SMOKE_AUTH_OWNER_EMAIL ?? "owner@local";
const OWNER_PASSWORD = process.env.SMOKE_AUTH_OWNER_PASSWORD ?? "owner12345";
const OPERATOR_EMAIL = process.env.SMOKE_AUTH_OPERATOR_EMAIL ?? "operator@local";
const OPERATOR_PASSWORD = process.env.SMOKE_AUTH_OPERATOR_PASSWORD ?? "operator12345";
const AUDITOR_EMAIL = process.env.SMOKE_AUTH_AUDITOR_EMAIL ?? "auditor@local";
const AUDITOR_PASSWORD = process.env.SMOKE_AUTH_AUDITOR_PASSWORD ?? "auditor12345";

let assertions = 0;

function fail(message: string): never {
	console.error(`✗ ${message}`);
	process.exit(1);
}

function assert(condition: boolean, message: string): void {
	if (!condition) fail(message);
	assertions += 1;
	console.log(`  ✓ ${message}`);
}

interface Wire {
	status: number;
	body: Record<string, unknown>;
}

async function request(method: string, path: string, options: { token?: string; body?: unknown } = {}): Promise<Wire> {
	const headers: Record<string, string> = {};
	if (options.token) {
		headers.authorization = `Bearer ${options.token}`;
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
	return { status: response.status, body };
}

/** 登录并返回令牌；失败就带着提示退出（多半是实例没按脚本头部的环境变量起）。 */
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
	if (response.status === 201) {
		return;
	}
	if (response.status === 409) {
		return;
	}
	fail(`建成员失败（${email} / ${response.status} ${JSON.stringify(response.body)}）`);
}

function isDescending(items: Record<string, unknown>[]): boolean {
	for (let index = 1; index < items.length; index += 1) {
		if (Number(items[index]!.createdAt) > Number(items[index - 1]!.createdAt)) {
			return false;
		}
	}
	return true;
}

async function main(): Promise<void> {
	console.log(`P3 企业安全冒烟：${BASE}`);

	// ---------- 0. 前置：确认打的是 required 实例 ----------
	const health = await request("GET", "/api/health");
	if (health.status !== 200 || health.body.auth !== "required") {
		fail(
			`健康探针不可用或实例不是 AUTH_MODE=required（auth=${String(health.body.auth)}）：` +
				"请按脚本头部注释起一个 required 实例，或用 SMOKE_AUTH_BASE 指向它",
		);
	}
	assert(health.status === 200 && health.body.auth === "required", "健康探针公开可访问，且实例是 AUTH_MODE=required");

	// ---------- 1. 无令牌 ----------
	console.log("\n[1] 未登录访问");
	const anonSessions = await request("GET", "/api/sessions");
	assert(anonSessions.status === 401, "无令牌访问 /api/sessions → 401");
	const anonMe = await request("GET", "/api/auth/me");
	assert(anonMe.status === 401, "无令牌访问 /api/auth/me → 401");
	const anonDelete = await request("DELETE", "/api/sessions/whatever");
	assert(anonDelete.status === 401, "无令牌访问 DELETE /api/sessions/:id → 401");

	// ---------- 2. 登录 ----------
	console.log("\n[2] 登录");
	const badLogin = await request("POST", "/api/auth/login", { body: { email: OWNER_EMAIL, password: "definitely-wrong" } });
	assert(badLogin.status === 401 && badLogin.body.error === "邮箱或密码不对", "错口令 → 401，文案不区分账号/口令");
	// 每次跑换一个不存在的邮箱：限流按「email + IP」计数，固定值会让第二次跑直接被 429
	const ghostEmail = `ghost-${Date.now()}@local`;
	const limitEmail = `limit-${Date.now()}@local`;
	const unknownLogin = await request("POST", "/api/auth/login", { body: { email: ghostEmail, password: "x" } });
	assert(unknownLogin.status === 401 && unknownLogin.body.error === "邮箱或密码不对", "不存在的账号 → 同样 401 文案");

	const ownerToken = await login(OWNER_EMAIL, OWNER_PASSWORD);
	const me = await request("GET", "/api/auth/me", { token: ownerToken });
	assert(me.status === 200 && (me.body.user as Record<string, unknown>)?.role === "owner", "owner 登录后 /api/auth/me 返回角色 owner");
	assert(Array.isArray(me.body.permissions) && me.body.permissions.length === 8, "owner 权限矩阵返回 8 个权限点");
	// 登录响应要把 mode 与 permissions 一起给出来（前端登录后不必再等一次 /me 才知道按钮该不该置灰）
	const loginBody = await request("POST", "/api/auth/login", { body: { email: OWNER_EMAIL, password: OWNER_PASSWORD } });
	assert(
		loginBody.status === 200 && Array.isArray(loginBody.body.permissions) && loginBody.body.mode === "required",
		"登录响应带 mode 与 permissions",
	);

	const sessions = await request("GET", "/api/sessions", { token: ownerToken });
	assert(sessions.status === 200 && Array.isArray(sessions.body), "带令牌访问 /api/sessions → 200 列表");
	const tampered = `${ownerToken.slice(0, -2)}${ownerToken.endsWith("aa") ? "bb" : "aa"}`;
	const tamperedRes = await request("GET", "/api/auth/me", { token: tampered });
	assert(tamperedRes.status === 401, "令牌被篡改（签名不符）→ 401");

	// ---------- 3. 成员与多角色 ----------
	console.log("\n[3] 多角色（脚本自建 operator / auditor）");
	await ensureUser(ownerToken, OPERATOR_EMAIL, OPERATOR_PASSWORD, "operator");
	await ensureUser(ownerToken, AUDITOR_EMAIL, AUDITOR_PASSWORD, "auditor");
	const users = await request("GET", "/api/auth/users", { token: ownerToken });
	assert(users.status === 200 && Array.isArray(users.body.items) && (users.body.items as unknown[]).length >= 3, "owner 能列成员（≥3 个账号）");

	const operatorToken = await login(OPERATOR_EMAIL, OPERATOR_PASSWORD);
	const auditorToken = await login(AUDITOR_EMAIL, AUDITOR_PASSWORD);

	// 运营：能看会话、能建会话，不能改技能、不能读审计
	const opSessions = await request("GET", "/api/sessions", { token: operatorToken });
	assert(opSessions.status === 200, "operator 能看会话列表");
	const workflows = await request("GET", "/api/workflows", { token: operatorToken });
	assert(workflows.status === 200 && Array.isArray(workflows.body), "operator 能看技能列表");
	const workflowId = String((workflows.body[0] as Record<string, unknown>)?.id ?? "auto-flow");

	const opCreateWorkflow = await request("POST", "/api/workflows", { token: operatorToken, body: { name: "运营不该能建", systemPrompt: "x", steps: [] } });
	assert(opCreateWorkflow.status === 403, "operator 建技能 → 403");
	assert(String(opCreateWorkflow.body.error).includes("运营"), `operator 的 403 文案带角色名（实际：${String(opCreateWorkflow.body.error)}）`);

	const opAudit = await request("GET", "/api/audit", { token: operatorToken });
	assert(opAudit.status === 403, "operator 读审计 → 403");

	const opSession = await request("POST", "/api/sessions", { token: operatorToken, body: { workflowId } });
	assert(opSession.status === 201, "operator 能建会话（跑会话是允许的）");
	const operatorSessionId = String((opSession.body as Record<string, unknown>).id ?? "");

	// 审计员：只读，不能发言、不能建会话
	const auditSessions = await request("GET", "/api/sessions", { token: auditorToken });
	assert(auditSessions.status === 200, "auditor 能看会话列表");
	const auditorCreate = await request("POST", "/api/sessions", { token: auditorToken, body: { workflowId } });
	assert(auditorCreate.status === 403, "auditor 建会话 → 403（只读）");
	if (operatorSessionId.length > 0) {
		const auditorSpeak = await request("POST", `/api/sessions/${operatorSessionId}/messages`, {
			token: auditorToken,
			body: { text: "审计员不该能发言" },
		});
		assert(auditorSpeak.status === 403, "auditor 让会话发言 → 403");
		assert(String(auditorSpeak.body.error).includes("审计员"), `auditor 的 403 文案带角色名（实际：${String(auditorSpeak.body.error)}）`);
	}

	// ---------- 4. 成员写接口（改角色 / 停用启用 / 删除） ----------
	console.log("\n[4] 成员写接口（PATCH / DELETE /api/auth/users/:id）");
	const ownerId = String((me.body.user as Record<string, unknown>)?.id ?? "");
	const memberEmail = `member-${Date.now()}@local`;
	const memberPassword = "member-pass-123";
	const memberCreate = await request("POST", "/api/auth/users", {
		token: ownerToken,
		body: { email: memberEmail, password: memberPassword, role: "auditor", name: "待改成员" },
	});
	assert(
		memberCreate.status === 201 && typeof (memberCreate.body.user as Record<string, unknown>)?.id === "string",
		"owner 建待改成员 → 201",
	);
	const memberId = String((memberCreate.body.user as Record<string, unknown>)?.id ?? "");
	const memberToken = await login(memberEmail, memberPassword, "（脚本自建成员）");
	const memberBefore = await request("GET", "/api/sessions", { token: memberToken });
	assert(memberBefore.status === 200, "成员登录后旧令牌可用");

	const patchRole = await request("PATCH", `/api/auth/users/${memberId}`, { token: ownerToken, body: { role: "developer" } });
	const patchedRole = patchRole.body.user as Record<string, unknown>;
	assert(patchRole.status === 200 && patchedRole?.role === "developer", "owner PATCH 改开发者角色 → 200，响应带新角色");
	assert(patchedRole?.roleLabel === "开发者", "PATCH 响应带 roleLabel");
	const listAfterRole = await request("GET", "/api/auth/users", { token: ownerToken });
	const roleRows = (listAfterRole.body.items ?? []) as Record<string, unknown>[];
	assert(
		roleRows.some((row) => row.id === memberId && row.role === "developer"),
		"成员列表反映新角色（developer）",
	);

	const disableRes = await request("PATCH", `/api/auth/users/${memberId}`, { token: ownerToken, body: { disabled: true } });
	assert(
		disableRes.status === 200 && (disableRes.body.user as Record<string, unknown>)?.disabled === true,
		"owner PATCH 停用账号 → 200 且 disabled=true",
	);
	const oldTokenAfterDisable = await request("GET", "/api/sessions", { token: memberToken });
	assert(oldTokenAfterDisable.status === 401, "停用后该账号旧令牌请求 → 401");

	const enableRes = await request("PATCH", `/api/auth/users/${memberId}`, { token: ownerToken, body: { disabled: false } });
	assert(
		enableRes.status === 200 && (enableRes.body.user as Record<string, unknown>)?.disabled === false,
		"再启用 → 200 且 disabled=false",
	);
	const oldTokenAfterEnable = await request("GET", "/api/sessions", { token: memberToken });
	assert(oldTokenAfterEnable.status === 200, "重新启用后旧令牌恢复可用（guard 每次回表）");

	const badRoleRes = await request("PATCH", `/api/auth/users/${memberId}`, { token: ownerToken, body: { role: "admin" } });
	assert(
		badRoleRes.status === 400 && badRoleRes.body.error === "角色只能是 owner/developer/operator/auditor",
		"PATCH 非法 role → 400 中文文案",
	);

	const selfPatch = await request("PATCH", `/api/auth/users/${ownerId}`, { token: ownerToken, body: { role: "developer" } });
	assert(
		selfPatch.status === 400 && String(selfPatch.body.error).includes("自己"),
		"owner PATCH 自己 → 400（不能修改自己的角色或状态）",
	);

	const opPatch = await request("PATCH", `/api/auth/users/${memberId}`, { token: operatorToken, body: { role: "operator" } });
	assert(
		opPatch.status === 403 && String(opPatch.body.error).includes("运营"),
		`operator PATCH 成员 → 403，文案带角色名（实际：${String(opPatch.body.error)}）`,
	);
	const opDelete = await request("DELETE", `/api/auth/users/${memberId}`, { token: operatorToken });
	assert(opDelete.status === 403, "operator DELETE 成员 → 403");

	const removed = await request("DELETE", `/api/auth/users/${memberId}`, { token: ownerToken });
	assert(removed.status === 200 && removed.body.removed === true, "owner DELETE 成员 → 200 { removed: true }");
	const patchGone = await request("PATCH", `/api/auth/users/${memberId}`, { token: ownerToken, body: { name: "再改" } });
	assert(patchGone.status === 404 && patchGone.body.error === "成员不存在", "删除后再 PATCH → 404「成员不存在」");
	const deleteGone = await request("DELETE", `/api/auth/users/${memberId}`, { token: ownerToken });
	assert(deleteGone.status === 404, "删除后再 DELETE → 404");

	const updateAudit = await request("GET", "/api/audit?action=user.update&limit=50", { token: ownerToken });
	const updateItems = (updateAudit.body.items ?? []) as Record<string, unknown>[];
	assert(
		updateAudit.status === 200 && updateItems.some((item) => item.targetId === memberId && item.actorType === "user"),
		"审计里有 user.update 记录（actor 是令牌用户）",
	);
	const deleteAudit = await request("GET", "/api/audit?action=user.delete&limit=50", { token: ownerToken });
	const deleteItems = (deleteAudit.body.items ?? []) as Record<string, unknown>[];
	assert(deleteAudit.status === 200 && deleteItems.some((item) => item.targetId === memberId), "审计里有 user.delete 记录");

	// ---------- 5. 审计落库 ----------
	console.log("\n[5] 审计");
	const auditList = await request("GET", "/api/audit?limit=50", { token: ownerToken });
	assert(auditList.status === 200 && Array.isArray(auditList.body.items), "owner 读审计 → 200 列表");
	const auditItems = (auditList.body.items ?? []) as Record<string, unknown>[];
	assert(auditItems.length > 0 && isDescending(auditItems), "审计按时间倒序（最新的在前）");
	const loginAudit = await request("GET", "/api/audit?action=auth.login", { token: ownerToken });
	const loginItems = (loginAudit.body.items ?? []) as Record<string, unknown>[];
	assert(loginItems.length > 0 && loginItems.every((item) => item.action === "auth.login"), "审计支持按 action 过滤（auth.login 命中）");
	assert(loginItems.every((item) => item.actorType === "user"), "登录成功的审计 actorType=user");
	const failedAudit = await request("GET", "/api/audit?action=auth.login.failed", { token: ownerToken });
	const failedItems = (failedAudit.body.items ?? []) as Record<string, unknown>[];
	assert(failedItems.length > 0 && failedItems.every((item) => item.actorType === "anonymous"), "登录失败的审计 actorType=anonymous");
	const writeAudit = await request("GET", "/api/audit?action=session.create", { token: ownerToken });
	const writeItems = (writeAudit.body.items ?? []) as Record<string, unknown>[];
	assert(writeItems.length > 0 && writeItems.some((item) => item.targetType === "session"), "写操作（建会话）也落了审计，且带 target");

	// ---------- 6. 限流 ----------
	console.log("\n[6] 登录限流（5 次失败锁 5 分钟）");
	const statuses: number[] = [];
	for (let index = 0; index < 5; index += 1) {
		const attempt = await request("POST", "/api/auth/login", { body: { email: limitEmail, password: "bad" } });
		statuses.push(attempt.status);
	}
	const blocked = await request("POST", "/api/auth/login", { body: { email: limitEmail, password: "bad" } });
	assert(statuses.every((status) => status === 401), "前 5 次失败都是 401");
	assert(blocked.status === 429, "第 6 次失败 → 429");
	assert(String(blocked.body.error).includes("尝试太频繁"), `429 文案是中文人话（实际：${String(blocked.body.error)}）`);

	// ---------- 7. 收尾 ----------
	console.log("\n[7] 收尾");
	const logout = await request("POST", "/api/auth/logout", { token: ownerToken });
	assert(logout.status === 200 && logout.body.ok === true, "退出接口返回 { ok: true }");
	if (operatorSessionId.length > 0) {
		const removed = await request("DELETE", `/api/sessions/${operatorSessionId}`, { token: ownerToken });
		assert(removed.status === 200, "收尾：owner 删掉测试会话");
	}

	console.log(`\n全部通过：${assertions} 项检查`);
}

await main();
