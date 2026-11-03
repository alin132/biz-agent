/**
 * 极简 .env 加载器（不依赖 dotenv）。
 *
 * 规则：
 *   - 文件不存在直接跳过
 *   - 已存在的环境变量优先，不覆盖（方便命令行临时覆盖）
 *   - 支持 # 注释、KEY=VALUE、去掉成对引号
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export function loadEnvFile(path = resolve(process.cwd(), ".env")): void {
	if (!existsSync(path)) {
		return;
	}

	const text = readFileSync(path, "utf8");
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line === "" || line.startsWith("#")) {
			continue;
		}
		const eq = line.indexOf("=");
		if (eq <= 0) {
			continue;
		}
		const key = line.slice(0, eq).trim();
		let value = line.slice(eq + 1).trim();
		if (value.length >= 2) {
			const first = value[0];
			const last = value[value.length - 1];
			if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
				value = value.slice(1, -1);
			}
		}
		if (process.env[key] === undefined) {
			process.env[key] = value;
		}
	}
}
