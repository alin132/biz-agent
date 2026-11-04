/**
 * 钉钉回调（P8）：加签校验、AES 解密、文本解析、幂等与多轮会话映射。
 *
 * 两种模式（钉钉后台二选一）：
 *   1. **加签**：`timestamp` + `sign`（query 或 body），
 *      `sign = base64(HmacSHA256(key=appSecret, message="timestamp\nappSecret"))`；
 *      `sign` 可能含 `+/=`：URLSearchParams 会把 `+` 解成空格，所以比较前要把空格换回 `+`。
 *      时间戳与当前差 > 1 小时 → 401「签名已过期」。
 *   2. **AES 加密（可选）**：`encrypt` + `msg_signature` + `nonce` + `timestamp`。
 *      aesKey 补 `=` 成 44 位 base64 → 解出 32 字节 AES key，IV = key 前 16 字节；
 *      密文 = base64(random(16) + len(4, BE) + msg + corpId)，再 PKCS#7 去填充；
 *      `msg_signature = sha1(sort(token, timestamp, nonce, encrypt))`。
 *
 * 处理策略：
 * - 校验通过就立刻回 200 `{ ok: true }`（钉钉要求几秒内响应），真正的模型调用与出站放后台；
 * - 同一 `msgId` 只处理一次：内存 LRU 200 条 + `im_sessions.last_msg_id` 落库双保险；
 * - 同一 `conversationId` 的消息串行处理（promise 链），保证多轮顺序与映射只建一条；
 * - 60 秒没跑完就回「处理超时」并尽力中止会话（Session 暂无公开 abort，见 abortSession）。
 */

import { createDecipheriv, createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ImBotRecord } from "../db/types.js";
import type { SessionHub, WireEvent } from "../session.js";
import { ImError } from "./errors.js";
import { json, readJsonBody } from "./http.js";
import type { OutboundService } from "./outbound.js";
import { IM_DEFAULT_WORKFLOW } from "./store.js";
import type { ImStore } from "./store.js";

/** 签名有效期：与钉钉文档一致，超过 1 小时视为过期（也挡未来时间戳）。 */
export const SIGN_TTL_MS = 60 * 60 * 1000;
/** 一轮对话最多等 60 秒。 */
export const CALLBACK_TIMEOUT_MS = 60 * 1000;
/** 内存幂等窗口：最近 200 个 msgId。 */
export const MSG_ID_LRU_SIZE = 200;

export function paramString(params: Record<string, unknown>, name: string): string | undefined {
	const value = params[name];
	if (typeof value === "string") {
		return value;
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		return String(value);
	}
	return undefined;
}

function firstString(params: Record<string, unknown>, ...names: string[]): string | undefined {
	for (const name of names) {
		const value = paramString(params, name);
		if (value !== undefined && value.length > 0) {
			return value;
		}
	}
	return undefined;
}

/** 钉钉时间戳一般是毫秒（13 位）；兼容秒级写法。解析不了返回 null。 */
export function callbackTimestampMs(raw: string): number | null {
	const trimmed = raw.trim();
	if (!/^\d+$/.test(trimmed)) {
		return null;
	}
	const numeric = Number(trimmed);
	if (!Number.isSafeInteger(numeric) || numeric <= 0) {
		return null;
	}
	return numeric >= 1e12 ? numeric : numeric * 1000;
}

export function isTimestampExpired(raw: string, now: number = Date.now()): boolean {
	const ms = callbackTimestampMs(raw);
	if (ms === null) {
		// 解析不了 = 不可能是新鲜时间戳，按过期处理（由调用方区分文案）
		return true;
	}
	return Math.abs(now - ms) > SIGN_TTL_MS;
}

/**
 * 钉钉加签：HMAC-SHA256（key = appSecret）对 `${timestamp}\n${appSecret}`，再做 base64。
 * 导出给自检脚本构造成真实请求。
 */
export function dingTalkSign(timestamp: string, appSecret: string): string {
	return createHmac("sha256", appSecret).update(`${timestamp}\n${appSecret}`, "utf8").digest("base64");
}

/** 钉钉 AES 回调的 msg_signature：四个字符串排序后拼接，sha1 小写十六进制。 */
export function dingTalkMsgSignature(
	token: string,
	timestamp: string,
	nonce: string,
	encrypt: string,
): string {
	return createHash("sha1").update([token, timestamp, nonce, encrypt].sort().join(""), "utf8").digest("hex");
}

function constantTimeEqual(left: string, right: string): boolean {
	const a = Buffer.from(left, "utf8");
	const b = Buffer.from(right, "utf8");
	if (a.length !== b.length) {
		return false;
	}
	return timingSafeEqual(a, b);
}

/**
 * 规范化签名值：`URLSearchParams` 按 application/x-www-form-urlencoded 解码，
 * 会把 base64 里的 `+` 变成空格；base64 本身不可能含空格，所以这里把空格换回 `+`。
 * `%2B` 解出来的 `+` 不受影响。
 */
export function normalizeSignValue(raw: string): string {
	return raw.trim().replace(/ /g, "+");
}

export interface AuthFailure {
	ok: false;
	status: number;
	error: string;
}

export interface SignedVerifyOk {
	ok: true;
	timestamp: string;
}

export type SignedVerifyResult = SignedVerifyOk | AuthFailure;

/** 明文 JSON + 加签模式。 */
export function verifySignedRequest(
	params: Record<string, unknown>,
	appSecret: string,
	now: number = Date.now(),
): SignedVerifyResult {
	const timestamp = paramString(params, "timestamp");
	const sign = paramString(params, "sign");
	if (!timestamp || !sign) {
		return { ok: false, status: 401, error: "回调缺少 timestamp 或 sign" };
	}
	if (callbackTimestampMs(timestamp) === null) {
		return { ok: false, status: 401, error: "timestamp 不是合法的毫秒时间戳" };
	}
	if (isTimestampExpired(timestamp, now)) {
		return { ok: false, status: 401, error: "签名已过期" };
	}
	const expected = dingTalkSign(timestamp, appSecret);
	if (!constantTimeEqual(expected, normalizeSignValue(sign))) {
		return { ok: false, status: 401, error: "签名校验失败" };
	}
	return { ok: true, timestamp };
}

export interface EncryptedVerifyOk {
	ok: true;
	/** 解密后的 JSON 回调体 */
	body: Record<string, unknown>;
	/** 外层时间戳（加密体里没有时间戳，幂等兜底要用） */
	timestamp: string;
}

export type EncryptedVerifyResult = EncryptedVerifyOk | AuthFailure;

/** AES 加密模式：先校验 msg_signature，再解密。 */
export function verifyEncryptedRequest(
	params: Record<string, unknown>,
	callbackToken: string,
	aesKey: string,
	now: number = Date.now(),
): EncryptedVerifyResult {
	const timestamp = paramString(params, "timestamp");
	const nonce = paramString(params, "nonce");
	const encrypt = paramString(params, "encrypt");
	const msgSignature = firstString(params, "msg_signature", "msgSignature");
	if (!timestamp || !nonce || !encrypt || !msgSignature) {
		return {
			ok: false,
			status: 400,
			error: "加密回调缺少 timestamp / nonce / encrypt / msg_signature",
		};
	}
	if (callbackTimestampMs(timestamp) === null) {
		return { ok: false, status: 401, error: "timestamp 不是合法的毫秒时间戳" };
	}
	if (isTimestampExpired(timestamp, now)) {
		return { ok: false, status: 401, error: "签名已过期" };
	}
	const expected = dingTalkMsgSignature(callbackToken, timestamp, nonce, encrypt);
	if (!constantTimeEqual(expected, normalizeSignValue(msgSignature).toLowerCase())) {
		return { ok: false, status: 401, error: "回调 msg_signature 校验失败" };
	}
	let plaintext: string;
	try {
		plaintext = decryptDingTalkEncrypt(encrypt, aesKey);
	} catch (error) {
		return {
			ok: false,
			status: 400,
			error: `回调解密失败：${error instanceof Error ? error.message : String(error)}`,
		};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(plaintext);
	} catch {
		return { ok: false, status: 400, error: "解密后的回调体不是合法 JSON" };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { ok: false, status: 400, error: "解密后的回调体必须是 JSON 对象" };
	}
	return { ok: true, body: parsed as Record<string, unknown>, timestamp };
}

/** PKCS#7 去填充（钉钉用 32 字节块）。 */
function unpadPkcs7(buffer: Buffer): Buffer {
	if (buffer.length === 0) {
		throw new Error("密文为空");
	}
	const pad = buffer[buffer.length - 1]!;
	if (pad < 1 || pad > 32 || pad > buffer.length) {
		throw new Error("PKCS#7 填充不合法");
	}
	for (let index = buffer.length - pad; index < buffer.length; index += 1) {
		if (buffer[index] !== pad) {
			throw new Error("PKCS#7 填充不合法");
		}
	}
	return buffer.subarray(0, buffer.length - pad);
}

/**
 * 钉钉 AES 解密。
 *
 * aesKey 一般是 43 位 base64（不带 `=`），补一个 `=` 后解出 32 字节；已带 `=` 的 44 位直接用。
 * 明文结构：random(16) + msgLen(4, BE) + msg + corpId，整段带 PKCS#7 填充。
 */
export function decryptDingTalkEncrypt(encrypt: string, aesKey: string): string {
	const normalized = aesKey.trim();
	if (normalized.length === 0) {
		throw new Error("没有配置 aesKey");
	}
	const padded = normalized.endsWith("=") ? normalized : `${normalized}=`;
	const key = Buffer.from(padded, "base64");
	if (key.length !== 32) {
		throw new Error("aesKey 解出来不是 32 字节（应为钉钉后台的 43 位 EncodingAESKey）");
	}
	const iv = key.subarray(0, 16);
	const ciphertext = Buffer.from(encrypt, "base64");
	if (ciphertext.length === 0 || ciphertext.length % 16 !== 0) {
		throw new Error("密文不是合法的 AES 块长度");
	}
	// 钉钉自己做了 PKCS#7，这里关掉 Node 的自动去填充，按官方顺序先 unpad 再读长度
	const decipher = createDecipheriv("aes-256-cbc", key, iv);
	decipher.setAutoPadding(false);
	const decrypted = unpadPkcs7(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
	if (decrypted.length < 20) {
		throw new Error("解密后的内容太短（缺 random / 长度字段）");
	}
	const messageLength = decrypted.readUInt32BE(16);
	if (messageLength === 0 || 20 + messageLength > decrypted.length) {
		throw new Error("解密后的消息长度字段不合法");
	}
	return decrypted.subarray(20, 20 + messageLength).toString("utf8");
}

export interface ParsedDingTalkMessage {
	/** 钉钉消息 id；极少数回调没带，交给网关用内容哈希兜底 */
	msgId: string | null;
	text: string;
	senderStaffId: string | null;
	senderNick: string | null;
	conversationId: string;
	conversationType: string | null;
}

function optionalRawString(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * 去掉群聊里机器人收到的「@机器人」前缀与多余空白。
 *
 * 只剥**开头**的 @提及：正文中间提到的 @ 是用户写给别人的，不能动；
 * emoji / 表情符号原样保留（它们是用户内容的一部分）。
 */
export function cleanDingText(input: string): string {
	let text = input.replace(/[\u00a0\u2005\u3000]/g, " ").trim();
	for (;;) {
		const next = text.replace(/^@[^\s@]+\s*/, "");
		if (next === text) {
			break;
		}
		text = next;
	}
	return text.replace(/\s+/g, " ").trim();
}

/** 解析钉钉回调体；非文本消息返回 null（网关回 200 ignored，避免钉钉重试风暴）。 */
export function parseDingTalkMessage(raw: Record<string, unknown>): ParsedDingTalkMessage | null {
	const msgtype = optionalRawString(raw.msgtype);
	if (msgtype !== null && msgtype !== "text") {
		return null;
	}
	const textField = raw.text;
	const content =
		typeof textField === "object" && textField !== null
			? (textField as Record<string, unknown>).content
			: undefined;
	if (typeof content !== "string") {
		return null;
	}
	const conversationId = optionalRawString(raw.conversationId);
	if (!conversationId) {
		return null;
	}
	const text = cleanDingText(content);
	if (text.length === 0) {
		return null;
	}
	return {
		msgId: optionalRawString(raw.msgId),
		text,
		senderStaffId: optionalRawString(raw.senderStaffId),
		senderNick: optionalRawString(raw.senderNick),
		conversationId,
		conversationType: optionalRawString(raw.conversationType),
	};
}

/** 最近 N 个 msgId 的 LRU（进程内幂等；落库的 last_msg_id 是第二道保险）。 */
export class MsgIdLru {
	private readonly order: string[] = [];
	private readonly members = new Set<string>();

	constructor(private readonly capacity = MSG_ID_LRU_SIZE) {}

	get size(): number {
		return this.members.size;
	}

	has(id: string): boolean {
		return this.members.has(id);
	}

	add(id: string): void {
		if (this.members.has(id)) {
			return;
		}
		this.members.add(id);
		this.order.push(id);
		while (this.order.length > this.capacity) {
			const evicted = this.order.shift();
			if (evicted !== undefined) {
				this.members.delete(evicted);
			}
		}
	}

	clear(): void {
		this.order.length = 0;
		this.members.clear();
	}
}

/** 网关只需要 Session 的这几个方法（便于单测注入，不依赖 Session 的内部字段）。 */
export interface GatewaySession {
	id: string;
	setTitle(title: string): string | null;
	subscribe(listener: (event: WireEvent) => void): () => void;
	send(text: string): Promise<void>;
}

export interface CollectedReply {
	text: string;
	timedOut: boolean;
}

/**
 * 订阅会话 SSE 事件，把流式文本拼成一条回复。
 *
 * `done` 带完整正文就用它（最准）；`error` 把错误文案回给用户；
 * 超时回「处理超时」并尽力中止会话（不阻断后续会话，只是这一轮不再等）。
 */
export function collectSessionReply(
	session: GatewaySession,
	text: string,
	timeoutMs: number = CALLBACK_TIMEOUT_MS,
): Promise<CollectedReply> {
	return new Promise((resolve) => {
		let buffer = "";
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | null = null;
		let unsubscribe: () => void = () => {};

		const finish = (reply: CollectedReply): void => {
			if (settled) {
				return;
			}
			settled = true;
			if (timer) {
				clearTimeout(timer);
			}
			unsubscribe();
			resolve(reply);
		};

		unsubscribe = session.subscribe((event) => {
			if (event.type === "text") {
				buffer += event.delta;
			} else if (event.type === "done") {
				finish({ text: event.text.trim() || buffer.trim() || "（空回复）", timedOut: false });
			} else if (event.type === "error") {
				finish({ text: buffer.trim() || `处理失败：${event.message}`, timedOut: false });
			}
		});

		timer = setTimeout(() => {
			abortSession(session);
			finish({ text: "处理超时", timedOut: true });
		}, timeoutMs);

		void session.send(text).catch((error: unknown) => {
			finish({
				text: `处理失败：${error instanceof Error ? error.message : String(error)}`,
				timedOut: false,
			});
		});
	});
}

/**
 * 尽力中止会话。
 *
 * `Session` 目前没有公开的 abort（本轮改动边界不含 server/session.ts），
 * 这里通过 Pi Agent 的私有字段兜底调用 `abort()`；拿不到就当无事发生，
 * 已经回复「处理超时」，不会再等这一轮。
 */
function abortSession(session: GatewaySession): void {
	const candidate = session as unknown as { agent?: { abort?: () => void } };
	try {
		candidate.agent?.abort?.();
	} catch {
		// 中止失败不影响"处理超时"这句回复
	}
}

type QueuedMessage = ParsedDingTalkMessage & { msgId: string };

export interface DingTalkGatewayOptions {
	store: ImStore;
	hub: Pick<SessionHub, "create" | "get">;
	outbound: OutboundService;
	now?: () => number;
	timeoutMs?: number;
	lru?: MsgIdLru;
}

export class DingTalkGateway {
	private readonly store: ImStore;
	private readonly hub: Pick<SessionHub, "create" | "get">;
	private readonly outbound: OutboundService;
	private readonly now: () => number;
	private readonly timeoutMs: number;
	private readonly seen: MsgIdLru;
	/** 同一外部会话串行处理：多轮必须按顺序落到同一个内部会话 */
	private readonly queues = new Map<string, Promise<void>>();

	constructor(options: DingTalkGatewayOptions) {
		this.store = options.store;
		this.hub = options.hub;
		this.outbound = options.outbound;
		this.now = options.now ?? Date.now;
		this.timeoutMs = options.timeoutMs ?? CALLBACK_TIMEOUT_MS;
		this.seen = options.lru ?? new MsgIdLru();
	}

	/**
	 * 处理一次钉钉回调：校验 → 立刻 200 → 后台跑会话与出站。
	 *
	 * 响应码约定：缺参数/解密失败 400，签名错/过期 401，机器人不存在 404、停用 403。
	 */
	async handleCallback(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
		let body: Record<string, unknown>;
		try {
			body = await readJsonBody(req);
		} catch (error) {
			respondError(res, error);
			return;
		}

		// query 与 body 都认（钉钉的 timestamp/sign 常在 query，encrypt 常在 body）
		const params: Record<string, unknown> = {};
		for (const [key, value] of url.searchParams.entries()) {
			params[key] = value;
		}
		Object.assign(params, body);

		const now = this.now();
		const botId = firstString(params, "botId");
		let bot: ImBotRecord;
		try {
			bot = this.store.findForCallback(botId);
		} catch (error) {
			respondError(res, error);
			return;
		}

		let messageBody: Record<string, unknown>;
		const timestamp = paramString(params, "timestamp");
		const encrypt = paramString(params, "encrypt");
		if (encrypt !== undefined && encrypt.length > 0) {
			const credentials = this.credentials(bot, res);
			if (!credentials) {
				return;
			}
			if (!credentials.aesKey) {
				json(res, 400, { error: "该机器人未配置 aesKey，无法解密加密回调" });
				return;
			}
			const verified = verifyEncryptedRequest(params, credentials.callbackToken, credentials.aesKey, now);
			if (!verified.ok) {
				json(res, verified.status, { error: verified.error });
				return;
			}
			messageBody = verified.body;
		} else {
			const credentials = this.credentials(bot, res);
			if (!credentials) {
				return;
			}
			const verified = verifySignedRequest(params, credentials.appSecret, now);
			if (!verified.ok) {
				json(res, verified.status, { error: verified.error });
				return;
			}
			messageBody = body;
		}

		// 校验通过才更新时间：签名错的请求不算"最近回调"
		this.store.markCallback(bot.id, now);

		const parsed = parseDingTalkMessage(messageBody);
		if (!parsed) {
			json(res, 200, { ok: true, ignored: true });
			return;
		}
		const msgId =
			parsed.msgId ??
			createHash("sha1")
				.update(`${parsed.conversationId}|${parsed.text}|${timestamp ?? now}`, "utf8")
				.digest("hex");
		const key = `${bot.id}:${msgId}`;
		if (this.seen.has(key)) {
			json(res, 200, { ok: true, duplicate: true });
			return;
		}
		const mapping = this.store.findSession(bot.id, parsed.conversationId);
		if (mapping?.lastMsgId === msgId) {
			json(res, 200, { ok: true, duplicate: true });
			return;
		}
		this.seen.add(key);

		// 先回 200：钉钉要求快速响应；模型调用与出站放后台（队列按 conversationId 串行）
		json(res, 200, { ok: true });
		this.enqueue(bot, { ...parsed, msgId });
	}

	/** 等所有后台处理完成（自检/优雅关闭用；生产不需要）。 */
	async drain(): Promise<void> {
		await Promise.all([...this.queues.values()]);
	}

	private credentials(
		bot: ImBotRecord,
		res: ServerResponse,
	): { appSecret: string; callbackToken: string; aesKey: string | null } | null {
		try {
			return this.store.credentialsOf(bot);
		} catch (error) {
			respondError(res, error);
			return null;
		}
	}

	private enqueue(bot: ImBotRecord, message: QueuedMessage): void {
		const key = `${bot.id}:${message.conversationId}`;
		const previous = this.queues.get(key) ?? Promise.resolve();
		const next = previous
			.then(() => this.process(bot, message))
			.catch((error: unknown) => {
				console.error(
					`钉钉回调处理失败（bot ${bot.id} / ${message.conversationId}）: ` +
						(error instanceof Error ? error.stack ?? error.message : String(error)),
				);
			});
		this.queues.set(key, next);
		void next.finally(() => {
			if (this.queues.get(key) === next) {
				this.queues.delete(key);
			}
		});
	}

	private async process(bot: ImBotRecord, message: QueuedMessage): Promise<void> {
		const mapping = this.store.findSession(bot.id, message.conversationId);
		if (mapping?.lastMsgId === message.msgId) {
			// 进程重启后 LRU 空了，但落库的 last_msg_id 还在：这里再挡一次
			return;
		}

		let session = mapping?.sessionId ? this.hub.get(mapping.sessionId) : undefined;
		if (!session) {
			session = this.createSession(bot, message);
		}
		// 先落 last_msg_id 再跑：宁可"处理失败但不再重放"，也不要同一条消息跑两遍
		this.store.upsertSession(bot.id, message.conversationId, {
			sessionId: session.id,
			externalUserId: message.senderStaffId,
			lastMsgId: message.msgId,
			now: this.now(),
		});

		const reply = await collectSessionReply(session, message.text, this.timeoutMs);
		const result = await this.outbound.send(
			this.store.outboundOf(bot),
			// 单聊（conversationType=1）用 staffId 发，群聊用 openConversationId 发；
			// 某个平台没给 conversationType 时按群聊处理（钉钉机器人默认回调带群会话 id）。
			message.conversationType === "1" && message.senderStaffId
				? { staffId: message.senderStaffId }
				: { conversationId: message.conversationId },
			reply.text,
		);
		if (!result.ok) {
			console.error(`钉钉回复发送失败（bot ${bot.id}，尝试 ${result.attempts} 次）: ${result.error ?? "未知错误"}`);
		}
	}

	private createSession(bot: ImBotRecord, message: QueuedMessage): ReturnType<SessionHub["create"]> {
		const title = `钉钉 · ${message.senderNick ?? message.senderStaffId ?? "外部用户"}`;
		let session;
		try {
			session = this.hub.create(bot.workflowId || IM_DEFAULT_WORKFLOW, { ownerId: null });
		} catch {
			// 机器人配置的流程被删掉了：回落到默认的 auto-flow，别让回调整个失败
			session = this.hub.create(IM_DEFAULT_WORKFLOW, { ownerId: null });
		}
		session.setTitle(title);
		return session;
	}
}

function respondError(res: ServerResponse, error: unknown): void {
	if (error instanceof ImError) {
		json(res, error.status, { error: error.message });
		return;
	}
	json(res, 500, { error: error instanceof Error ? error.message : String(error) });
}
