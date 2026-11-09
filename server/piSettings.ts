import type { IncomingMessage, ServerResponse } from "node:http";
import type { Storage } from "./db/types.js";

const KEY = "pi.settings.v1";
const DEFAULTS = { compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 } };

function read(storage: Storage) {
	const value = storage.getModelSetting(KEY);
	if (!value) return DEFAULTS;
	try {
		const parsed = JSON.parse(value) as typeof DEFAULTS;
		return parsed.compaction && typeof parsed.compaction.enabled === "boolean" ? parsed : DEFAULTS;
	} catch {
		return DEFAULTS;
	}
}

function send(res: ServerResponse, status: number, value: unknown): void {
	res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(value));
}

export async function handlePiSettingsRoute(req: IncomingMessage, res: ServerResponse, storage: Storage): Promise<boolean> {
	const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
	if (url.pathname !== "/api/pi/settings") return false;
	if (req.method === "GET") {
		send(res, 200, read(storage));
		return true;
	}
	if (req.method !== "PUT") return false;
	let body = "";
	for await (const chunk of req) {
		body += chunk;
		if (Buffer.byteLength(body) > 16_384) {
			send(res, 413, { error: "Pi 设置请求过大" });
			return true;
		}
	}
	let input: unknown;
	try { input = JSON.parse(body); } catch {
		send(res, 400, { error: "请求内容不是有效 JSON" });
		return true;
	}
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		send(res, 400, { error: "Pi 设置必须是对象" });
		return true;
	}
	const compaction = (input as { compaction?: unknown }).compaction;
	if (!compaction || typeof compaction !== "object" || Array.isArray(compaction)) {
		send(res, 400, { error: "缺少 Pi 压缩设置" });
		return true;
	}
	const value = compaction as Record<string, unknown>;
	if (typeof value.enabled !== "boolean" || !Number.isSafeInteger(value.reserveTokens) || !Number.isSafeInteger(value.keepRecentTokens)
		|| (value.reserveTokens as number) < 0 || (value.reserveTokens as number) > 1_000_000
		|| (value.keepRecentTokens as number) < 0 || (value.keepRecentTokens as number) > 1_000_000) {
		send(res, 400, { error: "自动压缩必须为开关，压缩阈值与保留量须为 0 至 1,000,000 的整数" });
		return true;
	}
	const settings = { compaction: { enabled: value.enabled, reserveTokens: value.reserveTokens as number, keepRecentTokens: value.keepRecentTokens as number } };
	storage.setModelSetting(KEY, JSON.stringify(settings));
	send(res, 200, settings);
	return true;
}
