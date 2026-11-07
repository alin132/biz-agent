import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "@playwright/test";

const dir = mkdtempSync(join(tmpdir(), "biz-contract-http-"));
const children = [];
const email = "contract-owner@example.invalid";
const password = randomUUID();
let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log(`  ✓ ${name}`); }
async function start(mode) {
	const socket = createServer();
	await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
	const port = socket.address().port;
	await new Promise((resolve) => socket.close(resolve));
	const child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
		cwd: process.cwd(), windowsHide: true, stdio: "ignore",
		env: { ...process.env, PORT: String(port), DB_PATH: join(dir, `${mode}.db`), DATABASE_URL: "",
			LLM_DISABLE: "1", AUTH_MODE: mode, AUTH_SECRET: randomUUID(), SECRET_KEY: randomUUID(),
			AUTH_BOOTSTRAP_EMAIL: email, AUTH_BOOTSTRAP_PASSWORD: password,
			DINGTALK_TRANSPORT: "fake" },
	});
	children.push(child);
	const base = `http://127.0.0.1:${port}`;
	for (let n = 0; n < 100; n++) {
		if (child.exitCode !== null) throw new Error(`隔离服务启动失败：${child.exitCode}`);
		try { if ((await fetch(base + "/api/health")).ok) return base; } catch { /* 等待监听 */ }
		await delay(200);
	}
	throw new Error("隔离服务启动超时");
}

let browser;
try {
	const base = await start("required");
	browser = await chromium.launch();
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
	const errors = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await check("强制鉴权显示登录页，错误密码如实报错", async () => {
		await page.goto(base);
		await page.getByPlaceholder("请输入邮箱", { exact: true }).fill(email);
		await page.getByPlaceholder("请输入密码", { exact: true }).fill(randomUUID());
		await page.getByRole("button", { name: "登录", exact: true }).click();
		await page.getByRole("alert").waitFor();
		assert.equal(await page.locator(".app-shell").count(), 0);
	});
	await check("正确登录后请求携带 Bearer，刷新保留登录", async () => {
		await page.getByPlaceholder("请输入密码", { exact: true }).fill(password);
		await page.getByRole("button", { name: "登录", exact: true }).click();
		await page.locator(".app-shell").waitFor();
		const response = page.waitForResponse((response) => response.url().endsWith("/api/auth/me"));
		await page.reload();
		const me = await response;
		assert.equal(me.status(), 200);
		assert.ok(me.request().headers().authorization?.startsWith("Bearer "));
		await page.locator(".app-shell").waitFor();
	});
	await check("鉴权 SSE 真正连接，发送后显示模型回答", async () => {
		await page.goto(base + "/#/chat");
		const streamResponse = page.waitForResponse((response) => /\/api\/sessions\/[^/]+\/events$/.test(response.url()));
		await page.getByRole("button", { name: "新对话", exact: true }).first().click();
		const stream = await streamResponse;
		assert.equal(stream.status(), 200);
		assert.ok(stream.request().headers().authorization?.startsWith("Bearer "));
		await page.getByPlaceholder("说点什么", { exact: false }).fill("契约浏览器测试");
		await page.getByRole("button", { name: "发送", exact: true }).click();
		await page.locator(".chat-msg.assistant .chat-bubble").first().waitFor({ timeout: 10000 });
	});
	await check("无效令牌触发重新登录并卸载对话", async () => {
		await page.evaluate(() => sessionStorage.setItem("biz-agent-token", "invalid-test-token"));
		await page.reload();
		await page.getByPlaceholder("请输入密码", { exact: true }).waitFor();
		assert.equal(await page.locator(".app-shell").count(), 0);
	});
	await check("退出登录清除令牌，登录页无脚本异常", async () => {
		await page.getByPlaceholder("请输入邮箱", { exact: true }).fill(email);
		await page.getByPlaceholder("请输入密码", { exact: true }).fill(password);
		await page.getByRole("button", { name: "登录", exact: true }).click();
		await page.getByRole("button", { name: "退出登录", exact: true }).click();
		await page.getByPlaceholder("请输入密码", { exact: true }).waitFor();
		assert.equal(await page.evaluate(() => sessionStorage.getItem("biz-agent-token")), null);
		assert.deepEqual(errors, []);
		mkdirSync("data", { recursive: true });
		await page.screenshot({ path: "data/contracts-login.png", fullPage: true });
	});

	const off = await start("off");
	await check("停用 Agent 的旧会话消息接口返回 409，历史仍可读", async () => {
		async function call(path, body) {
			const response = await fetch(off + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
			return { status: response.status, body: await response.json() };
		}
		const agent = await call("/api/agents", { name: "HTTP 停用契约" });
		assert.equal(agent.status, 201);
		const subject = await call("/api/sessions", { workflowId: "auto-flow", agentId: agent.body.id });
		assert.equal(subject.status, 201);
		await call(`/api/agents/${agent.body.id}/actions`, { action: "publish" });
		await call(`/api/agents/${agent.body.id}/actions`, { action: "stop" });
		const blocked = await call(`/api/sessions/${subject.body.id}/messages`, { text: "blocked" });
		assert.equal(blocked.status, 409);
		assert.equal(blocked.body.code, "stopped_not_chattable");
		assert.equal((await fetch(off + `/api/sessions/${subject.body.id}`)).status, 200);
	});
	await check("关闭鉴权仍可直接进入工作台", async () => {
		await page.goto(off);
		await page.locator(".app-shell").waitFor();
		assert.equal(await page.getByRole("button", { name: "登录", exact: true }).count(), 0);
	});
	for (const [command, args] of [["ui:e2e", ["scripts/ui-redesign-e2e.mjs"]], ["smoke:agents", ["--import", "tsx", "scripts/smoke-agents.ts"]], ["smoke", ["--import", "tsx", "scripts/smoke.ts"]]]) {
		await check(`现有 ${command} 在隔离实例通过`, async () => {
			const child = spawn(process.execPath, args, { windowsHide: true, stdio: "inherit", env: { ...process.env, BASE: off, SMOKE_BASE: off, LLM_DISABLE: "1" } });
			const code = await new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
			assert.equal(code, 0);
		});
	}
} finally {
	await browser?.close();
	await Promise.all(children.map((child) => new Promise((resolve) => {
		if (child.exitCode !== null) return resolve();
		child.once("exit", resolve);
		child.kill();
	})));
	if (dirname(dir) === resolve(tmpdir()) && basename(dir).startsWith("biz-contract-http-")) rmSync(dir, { recursive: true });
}
console.log(`功能契约端到端：${passed} 项通过`);
