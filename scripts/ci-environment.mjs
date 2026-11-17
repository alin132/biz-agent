import { appendFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const environmentFile = process.env.GITHUB_ENV;
if (process.env.GITHUB_ACTIONS !== "true" || !environmentFile) throw new Error("CI 环境文件不可用：请在 GitHub Actions 中运行此脚本");

for (const name of ["SECRET_KEY", "AUTH_SECRET"]) {
	const value = randomBytes(32).toString("hex");
	process.stdout.write(`::add-mask::${value}\n`);
	appendFileSync(environmentFile, `${name}=${value}\n`);
}
