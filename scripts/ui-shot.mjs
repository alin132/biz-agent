// 控制台截图：用本机 Edge/Chrome 的无头模式 + CDP 给页面拍图，用来核对「观感」（布局、截断、对比度）。
// ui-dom-check 只能断言接线（DOM/事件/class/aria）；这脚本补的是它管不到的那一半。
//
// 用法：
//   npm run ui-shot                                  # 默认 http://127.0.0.1:4317/ → data/shot.png，1440x980
//   npm run ui-shot -- http://127.0.0.1:4317/ data/menu.png 1440 980 4000 "document.getElementById('skill-chip').click()"
//   参数顺序：url、输出文件、宽、高、等待毫秒、截图前执行的 JS（可省）
//
// 退出码：0 拍到图；1 找不到浏览器或拍图失败（不联网、不装依赖）。
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const [, , urlArg, outArg, widthArg, heightArg, waitArg, evalJs] = process.argv;
const url = urlArg ?? "http://127.0.0.1:4317/";
const outPath = resolve(outArg ?? "data/shot.png");
const width = Number(widthArg ?? 1440);
const height = Number(heightArg ?? 980);
const waitMs = Number(waitArg ?? 3500);
const port = 9333;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** 本机可用的 Chromium 内核浏览器：先 Edge（Windows 自带），再 Chrome。 */
function findBrowser() {
	const candidates =
		process.platform === "win32"
			? [
					`${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
					`${process.env["ProgramFiles(x86)"]}\\Microsoft\\Edge\\Application\\msedge.exe`,
					`${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
					`${process.env["ProgramFiles(x86)"]}\\Google\\Chrome\\Application\\chrome.exe`,
					`${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
				]
			: process.platform === "darwin"
				? ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
				: ["/usr/bin/microsoft-edge", "/usr/bin/google-chrome", "/usr/bin/chromium"];
	return candidates.find((path) => path && existsSync(path)) ?? null;
}

const browser = findBrowser();
if (!browser) {
	console.error("找不到 Edge / Chrome，跳过截图（这只影响观感核对，不影响验证闭环）。");
	process.exit(1);
}

const userDataDir = mkdtempSync(join(tmpdir(), "ui-shot-"));
const child = spawn(
	browser,
	[
		"--headless=new",
		"--disable-gpu",
		"--no-first-run",
		"--no-default-browser-check",
		"--hide-scrollbars",
		`--user-data-dir=${userDataDir}`,
		`--remote-debugging-port=${port}`,
		`--window-size=${width},${height}`,
		"about:blank",
	],
	{ stdio: "ignore" },
);

/** 等 CDP 端点起来，返回页面 target 的 websocket 地址。 */
async function pageTarget() {
	for (let i = 0; i < 80; i += 1) {
		try {
			const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
			const page = list.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
			if (page) return page.webSocketDebuggerUrl;
		} catch {
			/* 浏览器还没监听，继续等 */
		}
		await sleep(150);
	}
	throw new Error("CDP 连不上（浏览器起来了吗？）");
}

const cleanup = () => {
	try {
		child.kill();
	} catch {
		/* 已经退出 */
	}
	try {
		rmSync(userDataDir, { recursive: true, force: true });
	} catch {
		/* Windows 下 Crashpad 文件偶尔还占着，忽略 */
	}
};

try {
	const ws = new WebSocket(await pageTarget());
	let seq = 0;
	const pending = new Map();
	const errors = [];
	ws.addEventListener("message", (event) => {
		const msg = JSON.parse(event.data);
		if (msg.method === "Runtime.exceptionThrown") {
			errors.push(msg.params.exceptionDetails?.exception?.description ?? "unknown");
		}
		if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
			errors.push(msg.params.args.map((arg) => arg.value ?? arg.description).join(" "));
		}
		if (msg.id && pending.has(msg.id)) {
			const { resolve, reject } = pending.get(msg.id);
			pending.delete(msg.id);
			msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
		}
	});
	await new Promise((resolve, reject) => {
		ws.addEventListener("open", resolve, { once: true });
		ws.addEventListener("error", reject, { once: true });
	});
	const send = (method, params = {}) =>
		new Promise((resolve, reject) => {
			const id = ++seq;
			pending.set(id, { resolve, reject });
			ws.send(JSON.stringify({ id, method, params }));
		});

	await send("Page.enable");
	await send("Runtime.enable");
	await send("Emulation.setDeviceMetricsOverride", {
		width,
		height,
		deviceScaleFactor: 1,
		mobile: false,
	});
	await send("Page.navigate", { url });
	await sleep(waitMs);
	if (evalJs) {
		const result = await send("Runtime.evaluate", { expression: evalJs, awaitPromise: true, returnByValue: true });
		if (result.exceptionDetails) {
			console.error("截图前的 JS 执行失败：", result.exceptionDetails.exception?.description ?? "unknown");
		} else if (result.result?.value !== undefined) {
			// 顺手把执行结果打出来：点完之后"到底成没成"不用再靠看图猜
			console.log("截图前 JS 结果：", JSON.stringify(result.result.value));
		}
		await sleep(700);
	}
	const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
	mkdirSync(dirname(outPath), { recursive: true });
	writeFileSync(outPath, Buffer.from(shot.data, "base64"));
	console.log(`截图：${outPath}（${width}x${height}）`);
	// 页面报错比布局更值得先看：静默忽略 JS 异常等于白拍
	console.log("页面 JS 报错：", errors.length === 0 ? "无" : `\n  ${errors.join("\n  ")}`);
	ws.close();
	cleanup();
	process.exit(errors.length === 0 ? 0 : 2);
} catch (error) {
	console.error("截图失败：", error instanceof Error ? error.message : String(error));
	cleanup();
	process.exit(1);
}
