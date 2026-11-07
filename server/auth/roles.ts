/**
 * 权限矩阵：**唯一真相**。路由层、`/api/auth/me`、测试脚本都从这里读，别在别处再写一份。
 *
 * 为什么按"权限点"而不是按"接口"：接口会变，权限点是产品语义。
 * `permissionFor()` 把「方法 + 路径」映射到权限点，映射也只在这里维护一处。
 */

import type { Role } from "../db/types.js";

/** 平台权限点。 */
export type Permission =
	| "workflow.read"
	| "workflow.write"
	| "session.read"
	| "session.write"
	| "session.run"
	| "audit.read"
	| "member.manage"
	| "settings.write";

export const ALL_PERMISSIONS: Permission[] = [
	"workflow.read",
	"workflow.write",
	"session.read",
	"session.write",
	"session.run",
	"audit.read",
	"member.manage",
	"settings.write",
];

/** 角色中文名：403 文案直接用它（界面文案写人话）。 */
export const ROLE_LABELS: Record<Role, string> = {
	owner: "所有者",
	developer: "开发者",
	operator: "运营",
	auditor: "审计员",
};

/** 权限点在"不能做什么"句式里的说法：例如「当前角色是运营，不能修改技能」。 */
export const PERMISSION_LABELS: Record<Permission, string> = {
	"workflow.read": "查看技能",
	"workflow.write": "修改技能",
	"session.read": "查看会话",
	"session.write": "新建或修改会话",
	"session.run": "让会话发言",
	"audit.read": "查看审计记录",
	"member.manage": "管理成员",
	"settings.write": "修改平台设置",
};

/**
 * 矩阵：
 * - owner（所有者）：全部
 * - developer（开发者）：技能 CRUD + 跑会话 + 看审计
 * - operator（运营）：跑会话、看会话；不能改技能/设置
 * - auditor（审计员）：只读（会话、审计、技能列表），不能发言、不能改
 *
 * 注意：`audit.read` 只给 owner / auditor —— 接口清单与 smoke 断言都要求
 * 「operator 读审计 403」，所以这里按接口口径，而不是"运营也能看审计"那句概述。
 */
const MATRIX: Record<Role, Permission[]> = {
	owner: [...ALL_PERMISSIONS],
	developer: ["workflow.read", "workflow.write", "session.read", "session.write", "session.run", "audit.read"],
	operator: ["workflow.read", "session.read", "session.write", "session.run"],
	auditor: ["workflow.read", "session.read", "audit.read"],
};

export function isRole(value: unknown): value is Role {
	return typeof value === "string" && Object.prototype.hasOwnProperty.call(MATRIX, value);
}

/** 该角色的权限点列表（`/api/auth/me` 直接返回它）。 */
export function permissionsOf(role: Role): Permission[] {
	return [...MATRIX[role]];
}

export function can(role: Role, permission: Permission): boolean {
	return MATRIX[role].includes(permission);
}

/** 403 文案：`当前角色是运营，不能修改技能`。 */
export function denyMessage(role: Role, permission: Permission): string {
	return `当前角色是${ROLE_LABELS[role]}，不能${PERMISSION_LABELS[permission]}`;
}

/**
 * 「方法 + 路径」→ 需要的权限点；`null` 表示登录即可（不需要额外权限）。
 *
 * 只拦**写操作**与审计读取：四种角色都有全部读权限，读接口不必逐个判断。
 */
export function permissionFor(method: string, pathname: string): Permission | null {
	const write = method === "POST" || method === "PATCH" || method === "PUT" || method === "DELETE";
	if (pathname === "/api/agents" || pathname.startsWith("/api/agents/")) {
		return write ? "workflow.write" : "workflow.read";
	}

	if (pathname === "/api/audit") {
		return "audit.read";
	}
	// P9 监控：首页 summary 四种角色都能看（operator 只读这一页）；
	// 调用链（traces / traces/:id）属于审计数据，读走 audit.read —— owner / developer / auditor，
	// operator 会在 guard 层直接 403。这里没有写接口。
	if (pathname === "/api/monitor" || pathname.startsWith("/api/monitor/")) {
		return pathname === "/api/monitor/summary" ? "session.read" : "audit.read";
	}
	// 成员管理（列表 + 改角色/停用/删除）：读和写都只给 owner（member.manage）。
	// `/api/auth/*` 在 service.ts 的公开路径里（登录接口不需要令牌），真正的校验在 routes.ts 再做一次；
	// 这里的映射是权限矩阵的唯一真相，别只精确匹配集合路径（`/api/auth/users/:id` 会漏）。
	if (pathname === "/api/auth/users" || pathname.startsWith("/api/auth/users/")) {
		return "member.manage";
	}
	// P8 IM Bot 网关：机器人 CRUD、ping 走 workflow.write（owner / developer），
	// 列表 / 详情读 workflow.read。钉钉回调本身不经过权限矩阵（在 service.ts 的公开路径里）。
	// outbox 是 fake 传输下的调试/审计视图，按审计数据口径走 audit.read（owner / developer / auditor）。
	if (pathname === "/api/im/outbox") {
		return "audit.read";
	}
	if (pathname === "/api/im" || pathname.startsWith("/api/im/")) {
		return write ? "workflow.write" : "workflow.read";
	}
	if (pathname.startsWith("/api/workflows")) {
		return write ? "workflow.write" : "workflow.read";
	}
	// P6 多模型管理：读沿用 workflow.read（四种角色都能看模型列表，保持旧接口兼容），
	// 写（建/改/删供应商与模型、切当前模型、连通性探测）要求 workflow.write（owner / developer）。
	if (pathname === "/api/models" || pathname.startsWith("/api/models/")) {
		return write ? "workflow.write" : "workflow.read";
	}
	// P4 开放 API 的 Key：读写都要求 owner / developer（泄露一把 key 等于泄露一个角色）
	if (pathname === "/api/api-keys" || pathname.startsWith("/api/api-keys/")) {
		return "workflow.write";
	}
	// P7 MCP 服务注册：读查列表走 workflow.read，注册/刷新/启停/调用走 workflow.write。
	// 映射放在这里（唯一真相），`server/mcp/routes.ts` 只做二次兜底，别再维护第二份。
	if (pathname === "/api/mcp" || pathname.startsWith("/api/mcp/")) {
		return write ? "workflow.write" : "workflow.read";
	}
	// P5 知识库：读走 workflow.read（技能绑定要读库列表），建库/上传/删库/删文档/改绑定走 workflow.write
	if (pathname === "/api/kb" || pathname.startsWith("/api/kb/") || pathname.startsWith("/api/skills/")) {
		return write ? "workflow.write" : "workflow.read";
	}
	if (pathname === "/api/tools" || pathname === "/api/skills") {
		return "workflow.read";
	}
	// 审批中心（全局待办）：看要 session.read（四种角色都能看，审计员只读），
	// 提交决定要 session.run（运营也能批，但审计员不行）。
	// 会话级 /api/sessions/:id/approve 仍走下面的 session.run，两条入口口径一致。
	if (pathname === "/api/approvals" || pathname.startsWith("/api/approvals/")) {
		return write ? "session.run" : "session.read";
	}
	if (pathname.startsWith("/api/sessions")) {
		if (!write) {
			return "session.read";
		}
		// 让模型干活的几个子接口算"运行"，其余算"增删改会话"
		if (/^\/api\/sessions\/[^/]+\/(messages|skills|approve|permissions|stop)$/.test(pathname)) {
			return "session.run";
		}
		return "session.write";
	}
	return null;
}
