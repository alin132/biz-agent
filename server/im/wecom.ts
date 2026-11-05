/** 企业微信自建应用回调：验签解密后立即确认，模型回复通过应用消息异步发送。 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ImBotRecord } from "../db/types.js";
import type { SessionHub } from "../session.js";
import { collectSessionReply, MsgIdLru, CALLBACK_TIMEOUT_MS, isTimestampExpired } from "./dingtalk.js";
import { ImError } from "./errors.js";
import { MAX_BODY_BYTES } from "./http.js";
import type { OutboundService } from "./outbound.js";
import { IM_DEFAULT_WORKFLOW, type ImStore } from "./store.js";

export function wecomMsgSignature(token: string, timestamp: string, nonce: string, encrypt: string): string {
	return createHash("sha1").update([token, timestamp, nonce, encrypt].sort().join(""), "utf8").digest("hex");
}

function aesKeyOf(encodingAESKey: string): Buffer {
	if (!/^[A-Za-z0-9+/]{43}$/.test(encodingAESKey)) {
		throw new ImError(400, "企业微信 aesKey 必须为 43 位 Base64 字符");
	}
	const key = Buffer.from(encodingAESKey + "=", "base64");
	if (key.length !== 32) throw new ImError(400, "企业微信 aesKey 长度错误");
	return key;
}

/** 企业微信使用 32 字节填充块，不能使用 Node 默认的 16 字节填充。 */
export function encryptWecomMessage(message: string, encodingAESKey: string, corpId: string): string {
	const key = aesKeyOf(encodingAESKey);
	const text = Buffer.from(message, "utf8");
	const length = Buffer.alloc(4);
	length.writeUInt32BE(text.length);
	const raw = Buffer.concat([randomBytes(16), length, text, Buffer.from(corpId, "utf8")]);
	const padding = 32 - raw.length % 32;
	const cipher = createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
	cipher.setAutoPadding(false);
	return Buffer.concat([cipher.update(Buffer.concat([raw, Buffer.alloc(padding, padding)])), cipher.final()]).toString("base64");
}

export function decryptWecomMessage(encrypt: string, encodingAESKey: string, corpId: string): string {
	const key = aesKeyOf(encodingAESKey);
	try {
		if (!corpId || encrypt.length > MAX_BODY_BYTES || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encrypt)) throw new Error();
		const ciphertext = Buffer.from(encrypt, "base64");
		if (ciphertext.length === 0 || ciphertext.length % 16 !== 0) throw new Error();
		const decipher = createDecipheriv("aes-256-cbc", key, key.subarray(0, 16));
		decipher.setAutoPadding(false);
		const padded = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
		const padding = padded[padded.length - 1]!;
		if (padded.length % 32 !== 0 || padding < 1 || padding > 32 || !padded.subarray(-padding).every((byte) => byte === padding)) throw new Error();
		const raw = padded.subarray(0, -padding);
		if (raw.length < 20) throw new Error();
		const length = raw.readUInt32BE(16);
		if (length > raw.length - 20 || !raw.subarray(20 + length).equals(Buffer.from(corpId, "utf8"))) throw new Error();
		return new TextDecoder("utf-8", { fatal: true }).decode(raw.subarray(20, 20 + length));
	} catch {
		// 不把底层填充、企业标识等差异暴露给外部请求。
		throw new ImError(400, "企业微信回调解密失败或企业 ID 不匹配");
	}
}

function decodeXmlText(text: string): string {
	if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(text)) throw new ImError(400, "XML 实体无效");
	return text.replace(/&([^;]+);/g, (_match, entity: string) => {
		const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
		if (named[entity] !== undefined) return named[entity]!;
		const code = entity.startsWith("#x") ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
		if (!(code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff))) throw new ImError(400, "XML 字符无效");
		return String.fromCodePoint(code);
	});
}

/** 只接受回调所需的 XML 子集；禁止 DTD/实体声明/属性，限制字节数、节点数和深度。 */
export function parseWecomXml(xml: string): Record<string, string> {
	if (Buffer.byteLength(xml) > MAX_BODY_BYTES) throw new ImError(413, "XML 超过 1 MB");
	if (/<!DOCTYPE|<!ENTITY/i.test(xml) || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(xml)) throw new ImError(400, "XML 包含禁止的声明或字符");
	const source = xml.trim().replace(/^<\?xml\s+version=["']1\.0["'](?:\s+encoding=["']UTF-8["'])?\s*\?>/i, "").trim();
	const fields: Record<string, string> = Object.create(null) as Record<string, string>;
	const stack: { name: string; text: string; children: boolean; names: Set<string> }[] = [];
	let nodes = 0;
	let rootClosed = false;
	let offset = 0;
	const invalid = (): never => { throw new ImError(400, "企业微信回调 XML 格式错误"); };
	while (offset < source.length) {
		if (source.startsWith("<![CDATA[", offset)) {
			const end = source.indexOf("]]>", offset + 9);
			if (end < 0 || !stack.length) invalid();
			stack[stack.length - 1]!.text += source.slice(offset + 9, end);
			offset = end + 3;
		} else if (source[offset] === "<") {
			const end = source.indexOf(">", offset);
			if (end < 0) invalid();
			const tag = source.slice(offset, end + 1);
			const closing = /^<\/([A-Za-z_][A-Za-z0-9_]*)\s*>$/.exec(tag);
			if (closing) {
				const node = stack.pop();
				if (!node || node.name !== closing[1]) return invalid();
				if (stack.length === 1 && !node.children) fields[node.name] = node.text;
				if (stack.length === 0) rootClosed = true;
			} else {
				const opening = /^<([A-Za-z_][A-Za-z0-9_]*)\s*(\/)?>$/.exec(tag);
				if (!opening || rootClosed || ++nodes > 256 || stack.length >= 8) return invalid();
				const name = opening[1]!;
				const parent = stack.at(-1);
				if (!parent && name !== "xml") invalid();
				if (parent) {
					if (parent.names.has(name)) invalid();
					parent.names.add(name);
					parent.children = true;
				}
				if (opening[2]) {
					if (stack.length === 1) fields[name] = "";
					if (!parent) rootClosed = true;
				} else stack.push({ name, text: "", children: false, names: new Set() });
			}
			offset = end + 1;
		} else {
			let end = source.indexOf("<", offset);
			if (end < 0) end = source.length;
			const text = source.slice(offset, end);
			if (text.includes("]]>")) invalid();
			if (!stack.length) { if (text.trim()) invalid(); }
			else stack[stack.length - 1]!.text += decodeXmlText(text);
			offset = end;
		}
	}
	if (stack.length || !rootClosed) invalid();
	return fields;
}

function plain(res: ServerResponse, status: number, text: string): void {
	res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Content-Length": Buffer.byteLength(text) });
	res.end(text);
}

export interface WeComGatewayOptions {
	store: ImStore;
	hub: Pick<SessionHub, "create" | "get">;
	outbound: OutboundService;
	now?: () => number;
	timeoutMs?: number;
}

type TextMessage = { sender: string; text: string; msgId: string; conversationId: string };

export class WeComGateway {
	private readonly seen = new MsgIdLru();
	private readonly pending = new Set<string>();
	private readonly queues = new Map<string, Promise<void>>();
	private readonly now: () => number;
	constructor(private readonly options: WeComGatewayOptions) {
		this.now = options.now ?? Date.now;
	}

	async handleCallback(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
		try {
			if (req.method !== "GET" && req.method !== "POST") {
				res.setHeader("Allow", "GET, POST");
				throw new ImError(405, "企业微信回调仅支持 GET 和 POST");
			}
			const param = (name: string): string => {
				const values = url.searchParams.getAll(name);
				if (values.length !== 1 || !values[0] || values[0].length > MAX_BODY_BYTES) throw new ImError(400, "缺少或重复回调参数：" + name);
				return values[0];
			};
			// 沿用存储契约：appKey 保存 CorpID，robotCode 保存 AgentID。
			const bot = this.options.store.findForCallback(param("botId"), "wecom");
			const credentials = this.options.store.credentialsOf(bot);
			if (!credentials.aesKey || !credentials.callbackToken || !bot.appKey) throw new ImError(400, "企业微信回调凭证未配置完整");
			const timestamp = param("timestamp");
			const nonce = param("nonce");
			const signature = param("msg_signature");
			if (isTimestampExpired(timestamp, this.now())) throw new ImError(401, "企业微信回调签名已过期或时间戳无效");
			let encrypted: string;
			if (req.method === "GET") encrypted = param("echostr");
			else {
				let total = 0;
				const chunks: Buffer[] = [];
				for await (const chunk of req) {
					const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
					if ((total += buffer.length) > MAX_BODY_BYTES) throw new ImError(413, "企业微信回调请求体超过 1 MB");
					chunks.push(buffer);
				}
				encrypted = parseWecomXml(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))).Encrypt ?? "";
				if (!encrypted) throw new ImError(400, "企业微信回调缺少 Encrypt");
			}
			const expected = wecomMsgSignature(credentials.callbackToken, timestamp, nonce, encrypted);
			if (!/^[a-fA-F0-9]{40}$/.test(signature) || !timingSafeEqual(Buffer.from(signature.toLowerCase()), Buffer.from(expected))) throw new ImError(401, "企业微信回调签名错误");
			const decrypted = decryptWecomMessage(encrypted, credentials.aesKey, bot.appKey);
			if (req.method === "GET") {
				this.options.store.markCallback(bot.id, this.now());
				plain(res, 200, decrypted);
				return;
			}
			const fields = parseWecomXml(decrypted);
			if (fields.ToUserName !== bot.appKey) throw new ImError(400, "企业微信消息企业 ID 不匹配");
			if (fields.AgentID && fields.AgentID !== bot.robotCode) throw new ImError(400, "企业微信消息应用 ID 不匹配");
			this.options.store.markCallback(bot.id, this.now());
			if (fields.MsgType !== "text" || !fields.Content?.trim()) { plain(res, 200, "success"); return; }
			if (!fields.FromUserName?.trim() || !fields.MsgId?.trim()) throw new ImError(400, "企业微信文本消息缺少发送者或 MsgId");
			const message: TextMessage = { sender: fields.FromUserName, text: fields.Content.trim(), msgId: fields.MsgId, conversationId: fields.FromUserName };
			const key = JSON.stringify([bot.id, message.msgId]);
			const mapping = this.options.store.findSession(bot.id, message.conversationId);
			if (!this.seen.has(key) && !this.pending.has(key) && mapping?.lastMsgId !== message.msgId) {
				this.pending.add(key);
				this.enqueue(bot, message, key);
			}
			plain(res, 200, "success");
		} catch (error) {
			plain(res, error instanceof ImError ? error.status : 400, error instanceof ImError ? error.message : "企业微信回调处理失败");
		}
	}

	async drain(): Promise<void> { await Promise.all([...this.queues.values()]); }

	private enqueue(bot: ImBotRecord, message: TextMessage, messageKey: string): void {
		const key = JSON.stringify([bot.id, message.conversationId]);
		const next = (this.queues.get(key) ?? Promise.resolve())
			.then(() => this.process(bot, message))
			.catch((error: unknown) => { console.error("企业微信回调处理失败：", error instanceof Error ? error.message : "未知错误"); })
			.finally(() => {
				this.pending.delete(messageKey);
				this.seen.add(messageKey);
				if (this.queues.get(key) === next) this.queues.delete(key);
			});
		this.queues.set(key, next);
	}

	private async process(bot: ImBotRecord, message: TextMessage): Promise<void> {
		const { store, hub, outbound } = this.options;
		const mapping = store.findSession(bot.id, message.conversationId);
		if (mapping?.lastMsgId === message.msgId) return;
		let session = mapping ? hub.get(mapping.sessionId) : undefined;
		if (!session) {
			session = hub.create(bot.workflowId || IM_DEFAULT_WORKFLOW, { ownerId: null });
			session.setTitle("企业微信 · " + message.sender);
		}
		// 与钉钉一致：先记幂等标识，再执行可能有业务副作用的一轮。
		store.upsertSession(bot.id, message.conversationId, { sessionId: session.id, externalUserId: message.sender, lastMsgId: message.msgId, now: this.now() });
		const reply = await collectSessionReply(session, message.text, this.options.timeoutMs ?? CALLBACK_TIMEOUT_MS);
		const result = await outbound.send({ ...store.outboundOf(bot), platform: "wecom" }, { staffId: message.sender }, reply.text);
		if (!result.ok) console.error("企业微信回复发送失败：" + (result.error ?? "未知错误"));
	}
}
