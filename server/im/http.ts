/**
 * IM 路由共用的小工具：JSON 响应、请求体解析、方法不匹配。
 *
 * 和 models/routes.ts 的写法一致（`node:http` 零框架），但请求体上限收到 1 MB：
 * 钉钉回调体很小，凭证接口也只有几个字段，没必要允许大 payload。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { ImError } from "./errors.js";

export const MAX_BODY_BYTES = 1024 * 1024;

export function json(res: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(payload),
	});
	res.end(payload);
}

export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of req) {
		const buffer = chunk as Buffer;
		total += buffer.length;
		if (total > MAX_BODY_BYTES) {
			throw new ImError(413, "请求体超过 1 MB");
		}
		chunks.push(buffer);
	}
	if (total === 0) {
		return {};
	}
	const raw = Buffer.concat(chunks).toString("utf8");
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new ImError(400, "请求体不是合法 JSON");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new ImError(400, "请求体必须是 JSON 对象");
	}
	return parsed as Record<string, unknown>;
}

export function methodNotAllowed(res: ServerResponse, method: string, allowed: string): void {
	json(res, 405, { error: `不支持 ${method}，这个接口只接受 ${allowed}` });
}
