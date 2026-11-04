/**
 * 钉钉出站（P8）：真实 `https` 调钉钉机器人 API；测试/本地用 fake 传输把消息写进内存 outbox。
 *
 * 关键取舍：
 * - **测试绝不打真钉钉**：`DINGTALK_TRANSPORT=fake`（或 `NODE_ENV=test`）时只进 outbox，
 *   outbox 通过 `GET /api/im/outbox` 暴露（真传输下该接口 404）。
 * - access token 缓存 1 小时（钉钉实际给 2 小时，提前一小时换更稳）；
 * - 发送失败重试 2 次（共 3 次尝试），退避 300ms / 900ms；最终失败写一条 `audit_logs`
 *   （`action = im.send.failed`），别让失败静默消失；
 * - HTTP 细节收在 `httpsPostJson` 里，测试可以注入 `request` 假实现，不必联网。
 */

import { randomUUID } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { DEFAULT_WORKSPACE_ID } from "../db/types.js";
import type { Storage } from "../db/types.js";
import { ImError } from "./errors.js";

/** 出站传输：fake = 内存 outbox（测试），real = 真钉钉。 */
export type DingTalkTransport = "fake" | "real";

/** 出站只需要凭证里的这几项（不要传整行记录，避免密文到处流）。 */
export interface OutboundBot {
	id: string;
	name: string;
	appKey: string;
	appSecret: string;
	robotCode: string;
}

export interface OutboundTarget {
	conversationId?: string;
	staffId?: string;
}

/** 一条 fake 出站消息（`GET /api/im/outbox` 的每一项）。 */
export interface OutboxItem {
	id: string;
	botId: string;
	botName: string;
	target: OutboundTarget;
	content: string;
	at: number;
	attempts: number;
}

export interface SendResult {
	ok: boolean;
	transport: DingTalkTransport;
	attempts: number;
	messageId?: string;
	error?: string;
}

export interface HttpJsonResponse {
	status: number;
	body: unknown;
}

/** HTTP 注入点：真实实现走 node:https，单测注入假实现。 */
export type HttpJsonPost = (
	url: string,
	body: unknown,
	headers: Record<string, string>,
) => Promise<HttpJsonResponse>;

const TOKEN_URL = "https://api.dingtalk.com/v1.0/oauth2/accessToken";
const GROUP_SEND_URL = "https://api.dingtalk.com/v1.0/robot/groupMessages/send";
const SINGLE_SEND_URL = "https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend";

/** 两次重试的退避（毫秒）：需求固定为 300ms / 900ms。 */
export const RETRY_DELAYS = [300, 900] as const;
const MAX_ATTEMPTS = RETRY_DELAYS.length + 1;
const TOKEN_TTL_MS = 60 * 60 * 1000;
const OUTBOX_LIMIT = 500;

/** 传输选择：显式 fake / real 优先；否则测试环境默认 fake，其余默认 real。 */
export function resolveDingTalkTransport(explicit = process.env.DINGTALK_TRANSPORT): DingTalkTransport {
	const raw = (explicit ?? "").trim().toLowerCase();
	if (raw === "fake" || raw === "real") {
		return raw;
	}
	if (raw.length > 0) {
		console.warn(`DINGTALK_TRANSPORT=${raw} 不认识（只支持 fake / real），按默认处理`);
	}
	return (process.env.NODE_ENV ?? "").trim().toLowerCase() === "test" ? "fake" : "real";
}

export interface OutboundOptions {
	storage: Storage;
	/** 不传就按环境变量 / NODE_ENV 决定 */
	transport?: DingTalkTransport;
	/** 注入 HTTP（单测用） */
	request?: HttpJsonPost;
	/** 注入时钟（token 缓存 / outbox 时间） */
	now?: () => number;
	/** 注入 sleep（单测跳过真实退避） */
	sleep?: (ms: number) => Promise<void>;
}

export class OutboundService {
	readonly transport: DingTalkTransport;
	private readonly storage: Storage;
	private readonly request: HttpJsonPost;
	private readonly now: () => number;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly outboxItems: OutboxItem[] = [];
	private readonly tokens = new Map<string, { value: string; expiresAt: number }>();

	constructor(options: OutboundOptions) {
		this.storage = options.storage;
		this.transport = resolveDingTalkTransport(options.transport);
		this.request = options.request ?? httpsPostJson;
		this.now = options.now ?? Date.now;
		this.sleep =
			options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
	}

	/** 是否 fake 传输（`GET /api/im/outbox` 只在 fake 下可用）。 */
	get fake(): boolean {
		return this.transport === "fake";
	}

	/** outbox 快照（拷贝一份，外部改不动内部状态）。 */
	outbox(): OutboxItem[] {
		return this.outboxItems.map((item) => ({ ...item, target: { ...item.target } }));
	}

	clearOutbox(): void {
		this.outboxItems.length = 0;
	}

	/**
	 * 发一条文本消息。
	 *
	 * - fake：直接进 outbox，一次成功；
	 * - real：换 token → 调对应 API，失败按 300ms / 900ms 退避重试 2 次；
	 *   最终失败写审计并返回 `{ ok: false }`（不抛异常，调用方自己决定要不要再提示）。
	 */
	async send(bot: OutboundBot, target: OutboundTarget, content: string): Promise<SendResult> {
		if (!target.conversationId && !target.staffId) {
			throw new ImError(400, "出站消息必须指定 conversationId 或 staffId");
		}
		const text = content.trim();
		if (text.length === 0) {
			throw new ImError(400, "回复内容不能为空");
		}

		if (this.fake) {
			const item: OutboxItem = {
				id: `out-${randomUUID().slice(0, 8)}`,
				botId: bot.id,
				botName: bot.name,
				target: { ...target },
				content: text,
				at: this.now(),
				attempts: 1,
			};
			this.pushOutbox(item);
			return { ok: true, transport: "fake", attempts: 1, messageId: item.id };
		}

		let lastError = "未知错误";
		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
			try {
				const token = await this.accessToken(bot);
				const response = target.conversationId
					? await this.request(
							GROUP_SEND_URL,
							{
								robotCode: bot.robotCode,
								openConversationId: target.conversationId,
								msgKey: "sampleText",
								msgParam: JSON.stringify({ content: text }),
							},
							{ "x-acs-dingtalk-access-token": token },
						)
					: await this.request(
							SINGLE_SEND_URL,
							{
								robotCode: bot.robotCode,
								userIds: [target.staffId],
								msgKey: "sampleText",
								msgParam: JSON.stringify({ content: text }),
							},
							{ "x-acs-dingtalk-access-token": token },
						);
				if (response.status >= 200 && response.status < 300) {
					return {
						ok: true,
						transport: "real",
						attempts: attempt,
						messageId: messageIdOf(response.body),
					};
				}
				if (response.status === 401) {
					// token 可能被提前吊销：清缓存，下一次尝试重新换
					this.tokens.delete(bot.appKey);
				}
				lastError = `钉钉返回 HTTP ${response.status}：${describeBody(response.body)}`;
			} catch (error) {
				lastError = error instanceof Error ? error.message : String(error);
			}
			if (attempt < MAX_ATTEMPTS) {
				await this.sleep(RETRY_DELAYS[attempt - 1]!);
			}
		}

		this.recordFailure(bot, target, text, lastError, MAX_ATTEMPTS);
		return { ok: false, transport: "real", attempts: MAX_ATTEMPTS, error: lastError };
	}

	private pushOutbox(item: OutboxItem): void {
		this.outboxItems.push(item);
		if (this.outboxItems.length > OUTBOX_LIMIT) {
			this.outboxItems.splice(0, this.outboxItems.length - OUTBOX_LIMIT);
		}
	}

	/** 换 access token（缓存 1 小时）；失败抛错，由 send 的重试循环接住。 */
	private async accessToken(bot: OutboundBot): Promise<string> {
		const cached = this.tokens.get(bot.appKey);
		if (cached && cached.expiresAt > this.now()) {
			return cached.value;
		}
		const response = await this.request(TOKEN_URL, { appKey: bot.appKey, appSecret: bot.appSecret }, {});
		if (response.status < 200 || response.status >= 300) {
			throw new Error(`换 access token 失败：HTTP ${response.status}：${describeBody(response.body)}`);
		}
		const data = response.body as Record<string, unknown> | null;
		const token = typeof data?.accessToken === "string" ? data.accessToken : "";
		if (token.length === 0) {
			throw new Error("钉钉没有返回 accessToken");
		}
		this.tokens.set(bot.appKey, { value: token, expiresAt: this.now() + TOKEN_TTL_MS });
		return token;
	}

	/** 最终失败落审计：监控/审计页能直接看到是哪条消息、失败了几次、原因是什么。 */
	private recordFailure(
		bot: OutboundBot,
		target: OutboundTarget,
		content: string,
		error: string,
		attempts: number,
	): void {
		try {
			this.storage.appendAudit({
				workspaceId: DEFAULT_WORKSPACE_ID,
				actorType: "system",
				actorId: null,
				action: "im.send.failed",
				targetType: "im_bot",
				targetId: bot.id,
				detail: {
					conversationId: target.conversationId ?? null,
					staffId: target.staffId ?? null,
					attempts,
					error,
					contentLength: content.length,
				},
				traceId: null,
				createdAt: this.now(),
			});
		} catch (auditError) {
			// 审计写失败不能把出站失败的原因吞掉：只打日志
			console.error(`IM 出站失败审计落库失败: ${auditError instanceof Error ? auditError.message : String(auditError)}`);
		}
	}
}

function messageIdOf(body: unknown): string | undefined {
	if (typeof body !== "object" || body === null) {
		return undefined;
	}
	const record = body as Record<string, unknown>;
	for (const key of ["processQueryKey", "messageId", "taskId"]) {
		if (typeof record[key] === "string" && record[key].length > 0) {
			return record[key] as string;
		}
	}
	return undefined;
}

function describeBody(body: unknown): string {
	const text = typeof body === "string" ? body : JSON.stringify(body ?? "");
	return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

/** 真实 HTTP 实现：node:https，POST JSON，15 秒超时。 */
function httpsPostJson(url: string, body: unknown, headers: Record<string, string>): Promise<HttpJsonResponse> {
	return new Promise((resolve, reject) => {
		const payload = Buffer.from(JSON.stringify(body), "utf8");
		const target = new URL(url);
		const request = httpsRequest(
			{
				protocol: target.protocol,
				hostname: target.hostname,
				port: target.port || 443,
				path: `${target.pathname}${target.search}`,
				method: "POST",
				headers: {
					"content-type": "application/json; charset=utf-8",
					"content-length": payload.length,
					...headers,
				},
				timeout: 15000,
			},
			(response) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk: Buffer) => chunks.push(chunk));
				response.on("end", () => {
					const text = Buffer.concat(chunks).toString("utf8");
					let parsed: unknown = text;
					try {
						parsed = JSON.parse(text);
					} catch {
						// 钉钉正常都回 JSON；解析不了就原样带回去，报错里能看到
					}
					resolve({ status: response.statusCode ?? 0, body: parsed });
				});
			},
		);
		request.on("timeout", () => request.destroy(new Error("钉钉请求超时（15 秒）")));
		request.on("error", reject);
		request.end(payload);
	});
}
