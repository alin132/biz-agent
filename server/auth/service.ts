/**
 * 认证服务：把「配置 + 用户表 + 令牌 + 限流 + 审计」拼成一个运行时对象。
 *
 * 默认 `AUTH_MODE` 未设置 = `off`：所有接口照旧放行，只多出 `/api/auth/*` 与 `/api/audit`，
 * 且这些新接口看到的是内置的 owner 演示用户（方便前端在没有账号体系时先接界面）。
 * 设成 `required` 时：除 `/api/health`、`/api/auth/login|logout` 与静态资源外，都要 Bearer 令牌。
 *
 * 关键取舍：
 * - 每次请求都按令牌里的 sub 回表查用户（角色改了、账号被停用立刻生效，不等令牌过期）；
 * - 403 文案用中文角色名 + 中文动作（「当前角色是运营，不能修改技能」），直接可上界面；
 * - 审计在 index.ts 的请求收尾处统一记（按 方法 + 路径 + 状态码），登录成功/失败在 routes 里单独记。
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import {
	DEFAULT_WORKSPACE_ID,
	type AuditFilter,
	type AuditLogRecord,
	type Role,
	type Storage,
	type UserPatch,
	type UserRecord,
} from "../db/types.js";
import { bearerToken, DEFAULT_TTL_SECONDS, signToken, verifyToken } from "./jwt.js";
import { hashPassword, randomPassword, verifyPassword } from "./password.js";
import { LoginRateLimiter } from "./rateLimit.js";
import { can, denyMessage, isRole, permissionFor, permissionsOf, ROLE_LABELS, type Permission } from "./roles.js";

export type AuthMode = "off" | "required";

/** 令牌/审计里用的最小用户视图（不含口令哈希）。 */
export interface AuthUser {
	id: string;
	email: string;
	name: string | null;
	role: Role;
	workspaceId: string;
	/** 账号是否停用（成员页要展示；演示用户恒为 false） */
	disabled: boolean;
	/** 建号时间（毫秒时间戳） */
	createdAt: number;
	/** 最近登录时间（毫秒时间戳，从未登录为 null） */
	lastLoginAt: number | null;
}

/** `AUTH_MODE=off` 时的演示用户：前端开发不必先建账号。 */
export const DEMO_USER: AuthUser = {
	id: "demo-owner",
	email: "owner@local",
	name: "演示所有者",
	role: "owner",
	workspaceId: DEFAULT_WORKSPACE_ID,
	disabled: false,
	createdAt: 0,
	lastLoginAt: null,
};

export type LoginOutcome =
	| { ok: true; token: string; user: AuthUser }
	| { ok: false; status: number; error: string };

export interface CreateUserInput {
	email: string;
	password: string;
	role: Role;
	name?: string | null;
}

/**
 * 成员写操作的结果。
 *
 * 状态码语义与 routes 一致：400 入参/保护规则、404 目标不存在；
 * 文案直接上界面（中文），route 只做 `{ error }` 包装。
 */
export type MemberMutation = { ok: true; user: AuthUser } | { ok: false; status: number; error: string };

/** 姓名长度上限：与界面输入框、错误文案保持一致。 */
const NAME_MAX_LENGTH = 40;

export interface AuthRuntime {
	readonly mode: AuthMode;
	/** 每次都回表查的用户（req 上挂着的那个） */
	userOf(req: IncomingMessage): AuthUser | null;
	/** 只验令牌、不回写 req（`/api/auth/me`、`/api/auth/users` 自己验） */
	authenticate(req: IncomingMessage): AuthUser | null;
	/** 认证 + 角色校验；返回 null 表示放行 */
	guard(req: IncomingMessage, method: string, pathname: string): { status: number; error: string } | null;
	/** 请求收尾时记一条写操作审计（按状态码区分成功/被拦） */
	recordWriteAudit(req: IncomingMessage, method: string, pathname: string, status: number): void;
	/** 手工记一条审计（登录、建成员这类要带 detail 的） */
	appendAudit(entry: {
		actorType: string;
		actorId: string | null;
		action: string;
		targetType?: string | null;
		targetId?: string | null;
		detail?: unknown;
		traceId?: string | null;
	}): void;
	login(email: string, password: string, ip: string): LoginOutcome;
	createUser(input: CreateUserInput): { ok: true; user: AuthUser } | { ok: false; status: number; error: string };
	listUsers(): AuthUser[];
	/**
	 * 更新成员（角色 / 停用 / 姓名）。
	 *
	 * `actorId` 是当前令牌用户（route 用 `auth.userOf(req)` 取），用来拦"对自己降级/停用"；
	 * 传 null 表示没有可识别的操作者（off 模式的演示用户 id 也会传进来，只是库里查不到目标）。
	 */
	updateMember(id: string, patch: UserPatch, actorId: string | null): MemberMutation;
	/** 删除成员；保护规则与 updateMember 同一套（不能删自己 / 最后一个启用的所有者）。 */
	removeMember(id: string, actorId: string | null): MemberMutation;
	/** 审计倒序列表（`/api/audit`） */
	listAudit(filter: AuditFilter): AuditLogRecord[];
	/** 审计条数（分页用）；过滤条件与 listAudit 同一套（P9 补了 actorType / targetType / from / to / q） */
	countAudit(filter?: Omit<AuditFilter, "limit" | "offset">): number;
	/** 令牌签发（测试与内部调用） */
	issueToken(user: AuthUser): string;
	/** 附录：`/api/auth/me` 用 */
	permissionsOf(role: Role): Permission[];
}

/** 请求对象上挂认证信息；用可选属性，别改 node:http 的类型。 */
export interface AuthedRequest extends IncomingMessage {
	authUser?: AuthUser;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;
const PASSWORD_MIN = 6;
const PASSWORD_MAX = 200;

/**
 * 免登录的 API 路径（**只放行外部系统直接打进来的回调**）。
 *
 * 钉钉服务器回调时没有本平台的 Bearer 令牌，所以它必须在 `auth.guard` 之前放行；
 * 放行的只是回调本身，机器人管理接口（/api/im/bots*）仍然要登录 + 权限矩阵。
 * 别把整个 `/api/im` 放进白名单——那会把凭证管理接口暴露出去。
 */
const PUBLIC_API_PATHS: ReadonlySet<string> = new Set(["/api/im/dingtalk/callback", "/api/im/wecom/callback"]);

/** 健康探针、登录/退出/me、以及外部回调不需要令牌。 */
export function isPublicApiPath(pathname: string): boolean {
	return pathname === "/api/health" || pathname.startsWith("/api/auth/") || PUBLIC_API_PATHS.has(pathname);
}

/** 邮箱统一规范化：去空白 + 小写。库里的 email 都存这份规范值。 */
export function normalizeEmail(input: unknown): string {
	return typeof input === "string" ? input.trim().toLowerCase() : "";
}

function toAuthUser(user: UserRecord): AuthUser {
	return {
		id: user.id,
		email: user.email,
		name: user.name,
		role: user.role,
		workspaceId: user.workspaceId,
		disabled: user.disabled,
		createdAt: user.createdAt,
		lastLoginAt: user.lastLoginAt,
	};
}

/** 从环境读开关：只认 `required`，其余（含未设置）都是 off。 */
function resolveMode(): AuthMode {
	const raw = (process.env.AUTH_MODE ?? "").trim().toLowerCase();
	if (raw === "required") {
		return "required";
	}
	if (raw !== "" && raw !== "off") {
		console.warn(`AUTH_MODE=${raw} 不认识（只支持 required / off），按 off 处理`);
	}
	return "off";
}

/** 密钥：AUTH_SECRET > 环境（.env 已被 loadEnvFile 读进 process.env）> 启动时随机生成。 */
function resolveSecret(): string {
	const configured = (process.env.AUTH_SECRET ?? "").trim();
	if (configured.length > 0) {
		return configured;
	}
	const generated = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
	console.warn("未配置 AUTH_SECRET：已随机生成一个进程内密钥，重启后旧 token 全部失效（生产环境请显式配置）");
	return generated;
}

/** 把「方法 + 路径」翻成审计动作名。 */
function actionOf(method: string, pathname: string): string {
	const sessionChild = /^\/api\/sessions\/[^/]+\/([a-z]+)$/.exec(pathname);
	if (sessionChild) {
		const child = sessionChild[1]!;
		if (child === "messages") return "session.message";
		if (child === "skills") return "session.skill";
		if (child === "approve") return "session.approve";
		if (child === "permissions") return "session.permissions";
		return `session.${child}`;
	}
	if (pathname === "/api/sessions") {
		return method === "DELETE" ? "session.clear" : "session.create";
	}
	if (/^\/api\/sessions\/[^/]+$/.test(pathname)) {
		return method === "DELETE" ? "session.delete" : "session.update";
	}
	if (pathname === "/api/workflows") {
		return "workflow.create";
	}
	if (/^\/api\/workflows\/[^/]+$/.test(pathname)) {
		return method === "DELETE" ? "workflow.delete" : "workflow.update";
	}
	if (pathname === "/api/auth/users") {
		return "user.create";
	}
	// 成员写接口（PATCH / DELETE /api/auth/users/:id）自己写带 detail 的审计，
	// 这里仍给出动作名，避免以后调整 recordWriteAudit 时错记成 http.patch。
	if (/^\/api\/auth\/users\/[^/]+$/.test(pathname)) {
		return method === "DELETE" ? "user.delete" : "user.update";
	}
	return `http.${method.toLowerCase()}`;
}

/** 从路径里抠出目标 id（`/api/workflows/x` → `x`）；集合接口没有 id，但目标类型是知道的。 */
function targetOf(pathname: string): { targetType: string | null; targetId: string | null } {
	if (pathname === "/api/sessions" || pathname === "/api/workflows") {
		return { targetType: pathname === "/api/sessions" ? "session" : "workflow", targetId: null };
	}
	const workflow = /^\/api\/workflows\/([^/]+)/.exec(pathname);
	if (workflow) {
		return { targetType: "workflow", targetId: safeDecode(workflow[1]!) };
	}
	const session = /^\/api\/sessions\/([^/]+)/.exec(pathname);
	if (session) {
		return { targetType: "session", targetId: safeDecode(session[1]!) };
	}
	if (pathname === "/api/auth/users") {
		return { targetType: "user", targetId: null };
	}
	const member = /^\/api\/auth\/users\/([^/]+)$/.exec(pathname);
	if (member) {
		return { targetType: "user", targetId: safeDecode(member[1]!) };
	}
	return { targetType: null, targetId: null };
}

function safeDecode(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

export interface InitAuthOptions {
	/** 注入时钟与限流参数（测试用）；不传就用默认 */
	limiter?: LoginRateLimiter;
}

/** 启动时调用一次：决定模式、准备密钥、AUTH_MODE=required 时建初始账号。 */
export function initAuth(store: Storage, options: InitAuthOptions = {}): AuthRuntime {
	const mode = resolveMode();
	const secret = resolveSecret();
	const limiter = options.limiter ?? new LoginRateLimiter();

	const appendAudit = (entry: {
		actorType: string;
		actorId: string | null;
		action: string;
		targetType?: string | null;
		targetId?: string | null;
		detail?: unknown;
		traceId?: string | null;
	}): void => {
		store.appendAudit({
			workspaceId: DEFAULT_WORKSPACE_ID,
			actorType: entry.actorType,
			actorId: entry.actorId,
			action: entry.action,
			targetType: entry.targetType ?? null,
			targetId: entry.targetId ?? null,
			detail: entry.detail,
			traceId: entry.traceId ?? `trace-${randomUUID().slice(0, 8)}`,
			createdAt: Date.now(),
		});
	};

	/** 令牌 → 用户；用户不存在或被停用都当未登录（角色改动立刻生效）。 */
	const authenticate = (req: IncomingMessage): AuthUser | null => {
		const token = bearerToken(req.headers.authorization);
		if (!token) {
			return null;
		}
		const verified = verifyToken(token, secret);
		if (!verified.ok) {
			return null;
		}
		const user = store.getUserById(verified.claims.sub);
		if (!user || user.disabled) {
			return null;
		}
		return toAuthUser(user);
	};

	const issueToken = (user: AuthUser): string =>
		signToken(
			{ sub: user.id, role: user.role, workspace_id: user.workspaceId, email: user.email },
			secret,
			{ ttlSeconds: DEFAULT_TTL_SECONDS },
		);

	if (mode === "required") {
		bootstrapOwner(store);
	}

	/** 启用中的所有者数量：最后一个所有者的降级/停用/删除保护要用。 */
	const enabledOwnerCount = (): number =>
		store.listUsers().filter((user) => user.role === "owner" && !user.disabled).length;

	const runtime: AuthRuntime = {
		mode,
		userOf(req: IncomingMessage): AuthUser | null {
			return (req as AuthedRequest).authUser ?? null;
		},
		authenticate,
		appendAudit,
		guard(req, method, pathname) {
			// 探针、登录/退出、外部回调不需要令牌；/api/auth/me 与 /api/auth/users 自己验（见 routes.ts）
			if (isPublicApiPath(pathname)) {
				if (mode === "off") {
					(req as AuthedRequest).authUser = DEMO_USER;
				}
				return null;
			}
			let user: AuthUser | null;
			if (mode === "off") {
				user = DEMO_USER;
			} else {
				user = authenticate(req);
				if (!user) {
					return { status: 401, error: "未登录或登录已过期" };
				}
			}
			(req as AuthedRequest).authUser = user;
			const permission = permissionFor(method, pathname);
			if (permission && !can(user.role, permission)) {
				return { status: 403, error: denyMessage(user.role, permission) };
			}
			return null;
		},
		recordWriteAudit(req, method, pathname, status) {
			const isWrite = method === "POST" || method === "PATCH" || method === "PUT" || method === "DELETE";
			if (!isWrite || !pathname.startsWith("/api/")) {
				return;
			}
			// 登录/退出的审计带 email 与失败原因，在 routes 里单独记，这里跳过免得重复；
			// 成员写接口（建/改/删）在 routes/service 里写带 detail 的审计，同样跳过。
			if (
				pathname === "/api/auth/login" ||
				pathname === "/api/auth/logout" ||
				pathname === "/api/auth/users" ||
				pathname.startsWith("/api/auth/users/")
			) {
				return;
			}
			const user = (req as AuthedRequest).authUser;
			const { targetType, targetId } = targetOf(pathname);
			// off 模式没有真实身份：记成 system（而不是伪造一个 demo-owner 的操作者）
			const authenticated = mode === "required" ? user : null;
			try {
				appendAudit({
					actorType: authenticated ? "user" : "system",
					actorId: authenticated?.id ?? null,
					action: actionOf(method, pathname),
					targetType,
					targetId,
					detail: { method, pathname, status },
				});
			} catch (error) {
				// 审计写失败不能连带把业务请求的响应搞坏（只打日志）
				console.error(`审计落库失败: ${error instanceof Error ? error.message : String(error)}`);
			}
		},
		login(email, password, ip) {
			const normalized = normalizeEmail(email);
			const key = `${normalized}|${ip}`;
			const decision = limiter.check(key);
			if (decision.blocked) {
				const seconds = Math.ceil(decision.retryAfterMs / 1000);
				appendAudit({
					actorType: "anonymous",
					actorId: null,
					action: "auth.login.blocked",
					detail: { email: normalized, retryAfterSeconds: seconds },
				});
				return { ok: false, status: 429, error: `尝试太频繁，请在 ${seconds} 秒后再试` };
			}
			if (normalized.length === 0 || typeof password !== "string" || password.length === 0) {
				limiter.fail(key);
				appendAudit({
					actorType: "anonymous",
					actorId: null,
					action: "auth.login.failed",
					detail: { email: normalized, reason: "missing-credentials" },
				});
				return { ok: false, status: 401, error: "邮箱或密码不对" };
			}

			const record = store.getUserByEmail(normalized);
			// 口令错 / 账号不存在 / 账号停用：对外都是同一句话，不告诉攻击者哪一步错了
			const matched = record !== null && record !== undefined && !record.disabled && verifyPassword(password, record.passwordHash);
			if (!record || !matched) {
				limiter.fail(key);
				appendAudit({
					actorType: "anonymous",
					actorId: null,
					action: "auth.login.failed",
					detail: { email: normalized, reason: record ? "bad-password" : "unknown-account" },
				});
				return { ok: false, status: 401, error: "邮箱或密码不对" };
			}

			limiter.succeed(key);
			store.updateLoginTime(record.id, Date.now());
			const user = toAuthUser(record);
			appendAudit({
				actorType: "user",
				actorId: user.id,
				action: "auth.login",
				targetType: "user",
				targetId: user.id,
				detail: { email: user.email, role: user.role },
			});
			return { ok: true, token: issueToken(user), user };
		},
		createUser(input) {
			const email = normalizeEmail(input.email);
			if (!EMAIL_RE.test(email)) {
				return { ok: false, status: 400, error: "邮箱格式不对" };
			}
			if (typeof input.password !== "string" || input.password.length < PASSWORD_MIN || input.password.length > PASSWORD_MAX) {
				return { ok: false, status: 400, error: `密码长度要在 ${PASSWORD_MIN}~${PASSWORD_MAX} 之间` };
			}
			if (!isRole(input.role)) {
				return { ok: false, status: 400, error: "角色只能是 owner / developer / operator / auditor" };
			}
			if (store.getUserByEmail(email)) {
				return { ok: false, status: 409, error: "该邮箱已经存在" };
			}
			const record = store.createUser({
				id: `user-${randomUUID().slice(0, 8)}`,
				workspaceId: DEFAULT_WORKSPACE_ID,
				email,
				name: input.name ?? null,
				passwordHash: hashPassword(input.password),
				role: input.role,
				disabled: false,
				createdAt: Date.now(),
			});
			return { ok: true, user: toAuthUser(record) };
		},
		listUsers() {
			return store.listUsers().map((record) => toAuthUser(record));
		},
		updateMember(id, patch, actorId) {
			const record = store.getUserById(id);
			if (!record) {
				return { ok: false, status: 404, error: "成员不存在" };
			}
			// 逐字段校验：route 把 body 原样传进来，类型层面不可信
			if (patch.role !== undefined && !isRole(patch.role)) {
				return { ok: false, status: 400, error: "角色只能是 owner/developer/operator/auditor" };
			}
			if (patch.disabled !== undefined && typeof patch.disabled !== "boolean") {
				return { ok: false, status: 400, error: "disabled 只能是 true 或 false" };
			}
			if (patch.name !== undefined && patch.name !== null && typeof patch.name !== "string") {
				return { ok: false, status: 400, error: "姓名必须是字符串" };
			}
			if (typeof patch.name === "string" && patch.name.length > NAME_MAX_LENGTH) {
				return { ok: false, status: 400, error: `姓名最长 ${NAME_MAX_LENGTH} 个字符` };
			}

			const changingRole = patch.role !== undefined && patch.role !== record.role;
			const changingDisabled = patch.disabled !== undefined && patch.disabled !== record.disabled;
			// 自己改自己角色/状态会把自己锁在外面（或直接失去管成员的能力），一律拒绝
			if (actorId !== null && actorId === id && (changingRole || changingDisabled)) {
				return { ok: false, status: 400, error: "不能修改自己的角色或状态" };
			}
			// 最后一个启用中的所有者一旦降级/停用，平台就没人能管成员了
			if (
				record.role === "owner" &&
				!record.disabled &&
				(changingRole || patch.disabled === true) &&
				enabledOwnerCount() <= 1
			) {
				return { ok: false, status: 400, error: "至少要保留一个启用的所有者" };
			}

			const changes: UserPatch = {};
			if (changingRole) changes.role = patch.role;
			if (changingDisabled) changes.disabled = patch.disabled;
			if (patch.name !== undefined && patch.name !== record.name) changes.name = patch.name;

			const updated = store.updateUser(id, patch);
			if (!updated) {
				return { ok: false, status: 404, error: "成员不存在" };
			}
			appendAudit({
				actorType: "user",
				actorId,
				action: "user.update",
				targetType: "user",
				targetId: id,
				detail: { changes, before: { role: record.role, disabled: record.disabled, name: record.name } },
			});
			return { ok: true, user: toAuthUser(updated) };
		},
		removeMember(id, actorId) {
			const record = store.getUserById(id);
			if (!record) {
				return { ok: false, status: 404, error: "成员不存在" };
			}
			if (actorId !== null && actorId === id) {
				return { ok: false, status: 400, error: "不能修改自己的角色或状态" };
			}
			if (record.role === "owner" && !record.disabled && enabledOwnerCount() <= 1) {
				return { ok: false, status: 400, error: "至少要保留一个启用的所有者" };
			}
			if (!store.deleteUser(id)) {
				return { ok: false, status: 404, error: "成员不存在" };
			}
			appendAudit({
				actorType: "user",
				actorId,
				action: "user.delete",
				targetType: "user",
				targetId: id,
				detail: { email: record.email, role: record.role, disabled: record.disabled, name: record.name },
			});
			return { ok: true, user: toAuthUser(record) };
		},
		listAudit(filter) {
			return store.listAudit(filter);
		},
		countAudit(filter = {}) {
			return store.countAudit(filter);
		},
		issueToken,
		permissionsOf,
	};

	return runtime;
}

/** AUTH_MODE=required 且 users 表为空时建初始所有者账号（口令随机生成并打印一次）。 */
function bootstrapOwner(store: Storage): void {
	if (store.countUsers() > 0) {
		return;
	}
	const email = normalizeEmail(process.env.AUTH_BOOTSTRAP_EMAIL ?? "owner@local");
	const configured = (process.env.AUTH_BOOTSTRAP_PASSWORD ?? "").trim();
	const password = configured.length > 0 ? configured : randomPassword(16);
	const user = store.createUser({
		id: `user-${randomUUID().slice(0, 8)}`,
		workspaceId: DEFAULT_WORKSPACE_ID,
		email,
		name: ROLE_LABELS.owner,
		passwordHash: hashPassword(password),
		role: "owner",
		disabled: false,
		createdAt: Date.now(),
	});
	console.log(`鉴权: AUTH_MODE=required，已创建初始账号 ${email}（角色：所有者）`);
	if (configured.length === 0) {
		console.log(`      初始口令: ${password}`);
		console.log("      只打印这一次，请登录后在「成员」里改掉；或用 AUTH_BOOTSTRAP_PASSWORD 指定");
	}
	console.log(`      用户 id: ${user.id}`);
}
