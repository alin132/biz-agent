/**
 * 口令哈希：`node:crypto` 的 scrypt，零第三方依赖（不引 bcrypt）。
 *
 * 存储格式是**自描述**的一行字符串：
 *   scrypt$<N>$<r>$<p>$<salt-base64url>$<hash-base64url>
 * 好处：以后调参数（N/r/p/keylen）时，老用户的哈希仍能按它自己记的参数校验，
 * 不需要"全部重设密码"这种运维动作。
 *
 * 校验用 `timingSafeEqual`：避免按比较耗时猜哈希（哪怕只差一个字节也走同样时间）。
 */

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/** 参数：N=16384 时约 16MB 内存、几十毫秒一次，够拦住离线爆破又不拖慢登录。 */
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
/** scrypt 需要 128*N*r 字节；给 64MB 上限，留足余量避免 Node 抛 "memory limit exceeded"。 */
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

function base64url(buffer: Buffer): string {
	return buffer.toString("base64url");
}

/** 生成一行自描述哈希（每次调用都换随机盐，同一口令两次结果不同）。 */
export function hashPassword(plain: string): string {
	const salt = randomBytes(SALT_LENGTH);
	const derived = scryptSync(plain, salt, KEY_LENGTH, {
		N: SCRYPT_N,
		r: SCRYPT_R,
		p: SCRYPT_P,
		maxmem: SCRYPT_MAXMEM,
	});
	return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${base64url(salt)}$${base64url(derived)}`;
}

/**
 * 校验口令。任何格式问题（不是 scrypt 串、段数不对、base64 坏了、参数非法）
 * 一律返回 false —— 不抛错、不泄露"这个账号的哈希坏了"这种信息。
 */
export function verifyPassword(plain: string, stored: string | null | undefined): boolean {
	if (typeof stored !== "string" || stored.length === 0) {
		return false;
	}
	const parts = stored.split("$");
	if (parts.length !== 6 || parts[0] !== "scrypt") {
		return false;
	}
	const n = Number(parts[1]);
	const r = Number(parts[2]);
	const p = Number(parts[3]);
	if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p) || n <= 0 || r <= 0 || p <= 0) {
		return false;
	}
	let salt: Buffer;
	let expected: Buffer;
	try {
		salt = Buffer.from(parts[4]!, "base64url");
		expected = Buffer.from(parts[5]!, "base64url");
	} catch {
		return false;
	}
	if (salt.length === 0 || expected.length === 0) {
		return false;
	}
	let derived: Buffer;
	try {
		derived = scryptSync(plain, salt, expected.length, { N: n, r, p, maxmem: SCRYPT_MAXMEM });
	} catch {
		// 参数超出内存上限等：当作校验失败
		return false;
	}
	if (derived.length !== expected.length) {
		return false;
	}
	return timingSafeEqual(derived, expected);
}

/** 判断一段字符串是不是本模块产出的哈希格式（备份/导入时用得上，也是测试断言的抓手）。 */
export function isPasswordHash(value: unknown): boolean {
	return (
		typeof value === "string" &&
		/^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/.test(value)
	);
}

/** `AUTH_BOOTSTRAP_PASSWORD` 未配时打印一次的口令：16 位大小写字母 + 数字。 */
export function randomPassword(length = 16): string {
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
	const bytes = randomBytes(length);
	let out = "";
	for (let index = 0; index < length; index += 1) {
		out += alphabet[bytes[index]! % alphabet.length];
	}
	return out;
}
