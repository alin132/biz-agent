import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const workflow = readFileSync(new URL("../.github/workflows/verify.yml", import.meta.url), "utf8");
const scripts = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).scripts;
let passed = 0;
function check(name, action) { action(); passed++; console.log(`  ✓ ${name}`); }

check("Node 24、锁文件安装与最小权限", () => {
	assert.match(workflow, /node-version:\s*['"]24['"]/);
	assert.match(workflow, /npm ci(?:\s|$)/);
	assert.match(workflow, /permissions:\s*\n\s+contents: read/);
	assert.doesNotMatch(workflow, /secrets\.|write-all|persist-credentials:\s*true/);
	assert.match(workflow, /persist-credentials:\s*false/);
	assert.match(workflow, /defaults:\s*\n\s+run:\s*\n\s+shell: bash/);
});
check("模拟模型、临时数据库与 fake IM 传输", () => {
	assert.match(workflow, /LLM_DISABLE:\s*['"]1['"]/);
	assert.match(workflow, /DATABASE_URL:\s*['"]['"]/);
	assert.match(workflow, /DB_PATH:\s*\$\{\{ runner\.temp \}\}/);
	assert.match(workflow, /DINGTALK_TRANSPORT:\s*fake/);
	assert.match(workflow, /WECOM_TRANSPORT:\s*fake/);
	assert.doesNotMatch(workflow, /npm run eval:real|npm run live-check|npm run check-model/);
});
check("自检与浏览器入口均存在且被调用", () => {
	const loop = workflow.match(/for script in ([^;]+); do/)?.[1]?.trim().split(/\s+/) ?? [];
	assert.ok(loop.length > 0);
	for (const command of ["verify", "auth:selftest", "models:selftest", "agents:selftest", "agent-groups:selftest", "agent-groups:moderation:selftest", "memory:selftest", "eval:selftest", "im:selftest", "wecom:selftest"]) {
		assert.ok(loop.includes(command), `CI 缺少 ${command}`);
	}
	for (const command of [...loop, "typecheck", "web:build", "contracts:e2e", "agent-groups:e2e", "memory:ownership:e2e", "agent-groups:recovery:e2e", "eval:integration"]) {
		assert.equal(typeof scripts[command], "string", `package.json 缺少 ${command}`);
	}
	for (const command of ["typecheck", "web:build", "contracts:e2e", "agent-groups:e2e", "memory:ownership:e2e", "agent-groups:recovery:e2e", "eval:integration"]) assert.ok(workflow.includes(`npm run ${command}`));
	assert.match(workflow, /npx --no-install playwright install --with-deps chromium/);
});
check("失败时保留日志与浏览器截图", () => {
	assert.match(workflow, /if: failure\(\)/);
	assert.match(workflow, /actions\/upload-artifact@/);
	assert.match(workflow, /data\/ci-logs\//);
	assert.match(workflow, /data\/ui-redesign\/\*\.png/);
	assert.match(workflow, /retention-days:\s*7/);
});
check("每次生成独立随机密钥并在写入环境前屏蔽", () => {
	const dir = mkdtempSync(join(tmpdir(), "biz-ci-env-"));
	try {
		const rejectedPath = join(dir, "outside-actions");
		const rejected = spawnSync(process.execPath, [fileURLToPath(new URL("ci-environment.mjs", import.meta.url))], {
			encoding: "utf8", timeout: 10_000, env: { ...process.env, GITHUB_ACTIONS: "", GITHUB_ENV: rejectedPath },
		});
		assert.notEqual(rejected.status, 0, "普通本地运行必须拒绝，避免打印掩码协议中的原始值");
		assert.equal(rejected.stdout, "");
		assert.equal(existsSync(rejectedPath), false);
		const values = [];
		for (let index = 0; index < 2; index++) {
			const environmentFile = join(dir, `env-${index}`);
			const child = spawnSync(process.execPath, [fileURLToPath(new URL("ci-environment.mjs", import.meta.url))], {
				encoding: "utf8", timeout: 10_000, env: { ...process.env, GITHUB_ACTIONS: "true", GITHUB_ENV: environmentFile },
			});
			assert.equal(child.status, 0, "测试密钥生成脚本应成功");
			const entries = readFileSync(environmentFile, "utf8").trim().split("\n").map((line) => line.split("="));
			assert.deepEqual(entries.map(([name]) => name), ["SECRET_KEY", "AUTH_SECRET"]);
			for (const [, value] of entries) {
				assert.ok(/^[a-f0-9]{64}$/.test(value), "随机密钥应包含 32 字节熵");
				assert.ok(child.stdout.includes(`::add-mask::${value}\n`), "密钥必须先被屏蔽");
				values.push(value);
			}
		}
		assert.equal(new Set(values).size, 4, "密钥不应重复使用");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
console.log(`CI 工作流契约：${passed} 项通过（离线检查，未执行 GitHub Actions）`);
