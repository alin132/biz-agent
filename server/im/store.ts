/**
 * IM Bot 的存储门面（P8）：DAO 之上只做三件事 —— 校验、加密、掩码。
 *
 * 与 `server/models/store.ts` 同一套路：
 * - 凭证（appSecret / callbackToken / aesKey）**只以 AES-256-GCM 密文落库**；
 * - 出参永远只有掩码，密文与明文都不出去；
 * - 路由只处理 HTTP，错误统一抛 `ImError(status)`。
 *
 * 凭证字段与 0001 列的映射见 `server/db/types.ts` 的 `ImBotRecord` 注释
 * （callbackToken → sign_secret_enc，避免两列语义重叠）。
 */

import { randomUUID } from "node:crypto";
import type {
	ImBotPatch,
	ImBotRecord,
	ImSessionRecord,
	Storage,
} from "../db/types.js";
import { DEFAULT_WORKSPACE_ID } from "../db/types.js";
import { decryptSecret, encryptSecret, maskSecret } from "../models/crypto.js";
import { ImError } from "./errors.js";
import type { OutboundBot } from "./outbound.js";

/** 回调默认落的内部流程：`auto-flow` 是不带步骤的默认技能。 */
export const IM_DEFAULT_WORKFLOW = "auto-flow";

const MAX_NAME = 80;
const MAX_APP_KEY = 200;
const MAX_SECRET = 500;
const MAX_ROBOT_CODE = 200;
const MAX_WORKFLOW_ID = 100;
const MASK_DECRYPT_FAILED = "****（无法解密，请重新填写）";

/** 机器人出参：**只有掩码**，明文与密文都不出去。 */
export interface ImBotView {
	id: string;
	name: string;
	platform: "dingtalk";
	appKey: string;
	hasAppSecret: boolean;
	appSecretMasked: string | null;
	hasCallbackToken: boolean;
	callbackTokenMasked: string | null;
	hasAesKey: boolean;
	robotCode: string;
	workflowId: string;
	enabled: boolean;
	/** 最近一次通过校验的回调时间（毫秒时间戳）；从没调过是 null */
	lastCallbackAt: number | null;
	/** 映射到的外部会话数（含尚未收到消息的） */
	sessionCount: number;
	createdAt: number;
	updatedAt: number;
}

function requiredString(value: unknown, label: string, maxLength: number): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new ImError(400, `${label}不能为空`);
	}
	const trimmed = value.trim();
	if (trimmed.length > maxLength) {
		throw new ImError(400, `${label}不能超过 ${maxLength} 个字符`);
	}
	return trimmed;
}

function optionalString(value: unknown, label: string, maxLength: number): string | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	if (typeof value !== "string") {
		throw new ImError(400, `${label}必须是字符串`);
	}
	const trimmed = value.trim();
	if (trimmed.length > maxLength) {
		throw new ImError(400, `${label}不能超过 ${maxLength} 个字符`);
	}
	return trimmed;
}

function parseEnabled(value: unknown, fallback: boolean): boolean {
	if (value === undefined || value === null) {
		return fallback;
	}
	if (typeof value !== "boolean") {
		throw new ImError(400, "enabled 必须是布尔值");
	}
	return value;
}

/**
 * 钉钉后台给的 EncodingAESKey 是 43 位 base64（补一个 `=` 后解出 32 字节）。
 * 这里提前校验，别等回调来了才发现密钥形状不对。
 */
function parseAesKey(value: unknown): string | null {
	if (value === undefined || value === null) {
		return null;
	}
	if (typeof value !== "string") {
		throw new ImError(400, "aesKey 必须是字符串");
	}
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		return null;
	}
	if (trimmed.length > MAX_SECRET) {
		throw new ImError(400, `aesKey 不能超过 ${MAX_SECRET} 个字符`);
	}
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) {
		throw new ImError(400, "aesKey 只能是 base64 字符（钉钉后台的 43 位 EncodingAESKey）");
	}
	const padded = trimmed.endsWith("=") ? trimmed : `${trimmed}=`;
	if (Buffer.from(padded, "base64").length !== 32) {
		throw new ImError(400, "aesKey 必须是钉钉后台的 43 位 EncodingAESKey（base64 解出 32 字节）");
	}
	return trimmed;
}

function parseWorkflowId(value: unknown, fallback: string): string {
	const candidate = optionalString(value, "workflowId", MAX_WORKFLOW_ID);
	if (candidate === undefined) {
		return fallback;
	}
	return candidate.length > 0 ? candidate : fallback;
}

export class ImStore {
	constructor(private readonly storage: Storage) {}

	/** 列表：掩码 + enabled + 最近回调时间 + 会话数。 */
	list(): ImBotView[] {
		return this.storage.listImBots().map((row) => this.toView(row, this.storage.countImSessions(row.id)));
	}

	view(id: string): ImBotView {
		return this.toView(this.requireRow(id), this.storage.countImSessions(id));
	}

	row(id: string): ImBotRecord | undefined {
		return this.storage.getImBot(id);
	}

	requireRow(id: string): ImBotRecord {
		const row = this.storage.getImBot(id);
		if (!row) {
			throw new ImError(404, "机器人不存在");
		}
		return row;
	}

	/** 回调入口：按 botId 找启用的机器人；没传 botId 时只在"唯一启用"时兜底。 */
	findForCallback(botId?: string): ImBotRecord {
		if (botId !== undefined && botId.length > 0) {
			const row = this.storage.getImBot(botId);
			if (!row) {
				throw new ImError(404, "机器人不存在");
			}
			if (!row.enabled) {
				throw new ImError(403, "机器人已停用");
			}
			return row;
		}
		const enabled = this.storage.listImBots().filter((row) => row.enabled);
		if (enabled.length === 0) {
			throw new ImError(404, "还没有启用的机器人");
		}
		if (enabled.length > 1) {
			// 多机器人必须显式指定：把回调路由到哪一个是运维配置，不能靠猜
			throw new ImError(400, "存在多个启用的机器人，回调地址必须带 botId 参数");
		}
		return enabled[0]!;
	}

	create(body: Record<string, unknown>): ImBotView {
		const name = requiredString(body.name, "机器人名称", MAX_NAME);
		const appKey = requiredString(body.appKey, "appKey", MAX_APP_KEY);
		const appSecret = requiredString(body.appSecret, "appSecret", MAX_SECRET);
		const robotCode = requiredString(body.robotCode, "robotCode", MAX_ROBOT_CODE);
		const callbackToken = requiredString(body.callbackToken, "callbackToken", MAX_SECRET);
		const aesKey = parseAesKey(body.aesKey);
		const enabled = parseEnabled(body.enabled, true);
		const workflowId = parseWorkflowId(body.workflowId, IM_DEFAULT_WORKFLOW);
		const now = Date.now();
		const row = this.storage.createImBot({
			id: `imb-${randomUUID().slice(0, 8)}`,
			workspaceId: DEFAULT_WORKSPACE_ID,
			name,
			platform: "dingtalk",
			appKey,
			appSecretEnc: encryptSecret(appSecret),
			callbackTokenEnc: encryptSecret(callbackToken),
			robotCode,
			aesKeyEnc: aesKey ? encryptSecret(aesKey) : null,
			workflowId,
			enabled,
			createdAt: now,
			updatedAt: now,
		});
		return this.toView(row, 0);
	}

	update(id: string, body: Record<string, unknown>): ImBotView {
		const current = this.requireRow(id);
		const patch: ImBotPatch = { updatedAt: Date.now() };
		if ("name" in body) {
			patch.name = requiredString(body.name, "机器人名称", MAX_NAME);
		}
		if ("appKey" in body) {
			patch.appKey = requiredString(body.appKey, "appKey", MAX_APP_KEY);
		}
		if ("appSecret" in body) {
			// appSecret 是必填凭证：可以替换，但不能"清空"（清空后机器人直接不可用）
			patch.appSecretEnc = encryptSecret(requiredString(body.appSecret, "appSecret", MAX_SECRET));
		}
		if ("callbackToken" in body) {
			patch.callbackTokenEnc = encryptSecret(requiredString(body.callbackToken, "callbackToken", MAX_SECRET));
		}
		if ("robotCode" in body) {
			patch.robotCode = requiredString(body.robotCode, "robotCode", MAX_ROBOT_CODE);
		}
		if ("aesKey" in body) {
			// aesKey 是可选项：传 null / "" 表示不启用 AES 回调
			const aesKey = parseAesKey(body.aesKey);
			patch.aesKeyEnc = aesKey ? encryptSecret(aesKey) : null;
		}
		if ("workflowId" in body) {
			patch.workflowId = parseWorkflowId(body.workflowId, current.workflowId);
		}
		if ("enabled" in body) {
			patch.enabled = parseEnabled(body.enabled, current.enabled);
		}
		const updated = this.storage.updateImBot(id, patch);
		if (!updated) {
			throw new ImError(404, "机器人不存在");
		}
		return this.toView(updated, this.storage.countImSessions(id));
	}

	remove(id: string): { removed: boolean; sessionsRemoved: number } {
		this.requireRow(id);
		const sessionsRemoved = this.storage.countImSessions(id);
		const removed = this.storage.removeImBot(id);
		return { removed, sessionsRemoved };
	}

	/** 通过校验的回调：记一下最近回调时间（列表页展示；失败不影响业务）。 */
	markCallback(id: string, at: number): void {
		try {
			this.storage.updateImBot(id, { lastCallbackAt: at, updatedAt: at });
		} catch (error) {
			console.error(`更新机器人最近回调时间失败: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/** 解密后的出站凭证（只在运行时内存里出现，别进 HTTP 出参）。 */
	outboundOf(row: ImBotRecord): OutboundBot {
		return {
			id: row.id,
			name: row.name,
			appKey: row.appKey,
			appSecret: this.decrypt(row.appSecretEnc, "appSecret"),
			robotCode: row.robotCode,
		};
	}

	/** 回调用到的明文凭据（appSecret / callbackToken / aesKey）。 */
	credentialsOf(row: ImBotRecord): { appSecret: string; callbackToken: string; aesKey: string | null } {
		return {
			appSecret: this.decrypt(row.appSecretEnc, "appSecret"),
			callbackToken: this.decrypt(row.callbackTokenEnc, "callbackToken"),
			aesKey: row.aesKeyEnc ? this.decrypt(row.aesKeyEnc, "aesKey") : null,
		};
	}

	findSession(botId: string, conversationId: string): ImSessionRecord | undefined {
		return this.storage.getImSession(botId, conversationId);
	}

	/**
	 * 建/更新外部会话映射。
	 *
	 * 同一 (botId, conversationId) 只保留一行；`lastMsgId` 随消息更新，
	 * 用于"进程重启后同一个 msgId 不重复处理"的第二道保险。
	 */
	upsertSession(
		botId: string,
		conversationId: string,
		input: { sessionId: string; externalUserId: string | null; lastMsgId: string | null; now: number },
	): ImSessionRecord {
		const existing = this.storage.getImSession(botId, conversationId);
		if (existing) {
			const updated = this.storage.updateImSession(existing.id, {
				sessionId: input.sessionId,
				externalUserId: input.externalUserId,
				lastMsgId: input.lastMsgId,
				updatedAt: input.now,
			});
			if (updated) {
				return updated;
			}
		}
		return this.storage.createImSession({
			id: `ims-${randomUUID().slice(0, 8)}`,
			botId,
			conversationId,
			externalUserId: input.externalUserId,
			sessionId: input.sessionId,
			lastMsgId: input.lastMsgId,
			createdAt: input.now,
			updatedAt: input.now,
		});
	}

	countSessions(botId: string): number {
		return this.storage.countImSessions(botId);
	}

	private decrypt(blob: string, label: string): string {
		if (!blob) {
			throw new ImError(500, `机器人缺少 ${label}，请重新填写`);
		}
		try {
			return decryptSecret(blob);
		} catch {
			throw new ImError(500, `${label} 无法解密（SECRET_KEY / AUTH_SECRET 可能变过），请重新填写`);
		}
	}

	private maskedSecret(blob: string): string | null {
		try {
			return maskSecret(this.decrypt(blob, "凭证"));
		} catch {
			// 密文解不开（多半是 SECRET_KEY 变了）也不该让列表接口 500，给个占位让用户重填
			return MASK_DECRYPT_FAILED;
		}
	}

	private toView(row: ImBotRecord, sessionCount: number): ImBotView {
		return {
			id: row.id,
			name: row.name,
			platform: "dingtalk",
			appKey: row.appKey,
			hasAppSecret: Boolean(row.appSecretEnc),
			appSecretMasked: row.appSecretEnc ? this.maskedSecret(row.appSecretEnc) : null,
			hasCallbackToken: Boolean(row.callbackTokenEnc),
			callbackTokenMasked: row.callbackTokenEnc ? this.maskedSecret(row.callbackTokenEnc) : null,
			hasAesKey: Boolean(row.aesKeyEnc),
			robotCode: row.robotCode,
			workflowId: row.workflowId,
			enabled: row.enabled,
			lastCallbackAt: row.lastCallbackAt,
			sessionCount,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
		};
	}
}
