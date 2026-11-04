/**
 * 模型 API Key 的加解密工具（AES-256-GCM，零第三方依赖）。
 *
 * 取舍：
 * - 密文落库前序列化成 `{ v: 1, iv, tag, data }`（每段 base64），`v` 留给以后换算法；
 * - 密钥优先级 `SECRET_KEY` → `AUTH_SECRET` → **进程内随机生成**（只打一次 warn，重启后旧密文解不开）；
 * - GCM 自带完整性校验：密钥不对或密文被改，`decryptSecret()` 会直接抛错，不会返回半截明文；
 * - 对外永远只给掩码（`sk-****abcd`），明文只在创建/替换的那一刻进一次内存。
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** 密文格式版本：以后换算法/换 KDF 时靠它分流。 */
const VERSION = 1;
const IV_BYTES = 12;
const ALGORITHM = "aes-256-gcm";

const SECRET_ENVS = ["SECRET_KEY", "AUTH_SECRET"] as const;

let cachedSecret: string | null = null;
let warnedRandomSecret = false;

/**
 * 加密密钥来源（进程内缓存，一次运行只解析一次）。
 * 显式配置缺失时随机生成——安全上不弱，但重启后解不开旧密文，所以必须 warn。
 */
export function encryptionSecret(): string {
	if (cachedSecret !== null) {
		return cachedSecret;
	}
	for (const name of SECRET_ENVS) {
		const configured = (process.env[name] ?? "").trim();
		if (configured.length > 0) {
			cachedSecret = configured;
			return cachedSecret;
		}
	}
	cachedSecret = randomBytes(32).toString("hex");
	if (!warnedRandomSecret) {
		warnedRandomSecret = true;
		console.warn(
			"未配置 SECRET_KEY / AUTH_SECRET：模型 API Key 用进程内随机密钥加密，重启后旧密文解不开（生产环境请显式配置）",
		);
	}
	return cachedSecret;
}

/** 测试用：清掉缓存，让下一次 `encryptionSecret()` 重新读环境变量。 */
export function resetEncryptionSecretCache(): void {
	cachedSecret = null;
	warnedRandomSecret = false;
}

/** 把任意长度的密钥串压成 32 字节 AES 密钥。 */
function deriveKey(secret: string): Buffer {
	return createHash("sha256").update(secret, "utf8").digest();
}

/** 落库的密文结构（JSON.stringify 之后存 TEXT / text）。 */
export interface EncryptedSecret {
	v: number;
	/** 初始化向量（base64） */
	iv: string;
	/** GCM 认证标签（base64） */
	tag: string;
	/** 密文正文（base64） */
	data: string;
}

export function encryptSecret(plaintext: string, secret: string = encryptionSecret()): string {
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv(ALGORITHM, deriveKey(secret), iv);
	const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
	const payload: EncryptedSecret = {
		v: VERSION,
		iv: iv.toString("base64"),
		tag: cipher.getAuthTag().toString("base64"),
		data: data.toString("base64"),
	};
	return JSON.stringify(payload);
}

export function decryptSecret(blob: string, secret: string = encryptionSecret()): string {
	let parsed: Partial<EncryptedSecret>;
	try {
		parsed = JSON.parse(blob) as Partial<EncryptedSecret>;
	} catch {
		throw new Error("密文不是合法 JSON（可能被截断或不是这把密钥加密的）");
	}
	if (
		parsed.v !== VERSION ||
		typeof parsed.iv !== "string" ||
		typeof parsed.tag !== "string" ||
		typeof parsed.data !== "string"
	) {
		throw new Error("密文格式不正确（缺 iv/tag/data 或版本不认识）");
	}
	const decipher = createDecipheriv(ALGORITHM, deriveKey(secret), Buffer.from(parsed.iv, "base64"));
	decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
	const plaintext = Buffer.concat([decipher.update(Buffer.from(parsed.data, "base64")), decipher.final()]);
	return plaintext.toString("utf8");
}

/**
 * 掩码：保留前缀（`sk-` 这类标识）与末 4 位，中间一律 `****`。
 * 例：`sk-1234567890abcd` → `sk-****abcd`。
 */
export function maskSecret(secret: string | null | undefined): string | null {
	if (typeof secret !== "string") {
		return null;
	}
	const value = secret.trim();
	if (value.length === 0) {
		return null;
	}
	const dash = value.indexOf("-");
	const head = dash > 0 && dash <= 9 ? value.slice(0, dash + 1) : value.slice(0, 2);
	const tail = value.length > head.length + 4 ? value.slice(-4) : "";
	return `${head}****${tail}`;
}

/** API Key 的哈希：sha256 十六进制（库里的 `key_hash` 就是这个）。 */
export function sha256Hex(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

/** 定长十六进制串的常数时间比较（防时序侧信道）。 */
export function safeEqualHex(a: string, b: string): boolean {
	const left = Buffer.from(a, "utf8");
	const right = Buffer.from(b, "utf8");
	if (left.length !== right.length) {
		return false;
	}
	return timingSafeEqual(left, right);
}
