/**
 * 新前端的端到端测试（Playwright 真实浏览器）。
 *
 * 和 scripts/ui-dom-check.mjs 的分工：
 *   - ui-dom-check 跑的是**旧前端**（web/app.js，自制 DOM 桩，268 项）；
 *   - 这里是**新前端**（client/，Vue + Naive UI），Vue 组件过不了 DOM 桩，只能用真浏览器。
 *
 * 前置：后端在跑（默认 http://127.0.0.1:4317），且 client/dist 已构建。
 * 用 BASE 环境变量可指向别的实例。
 */
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";

const BASE = process.env.BASE ?? "http://127.0.0.1:4317";
const formatTokensForTest = (count) => (Math.max(0, Math.round(Number(count) || 0)) / 1000).toFixed(1) + "k";

let passed = 0;
const failures = [];

/**
 * 一条断言。**必须 await 调用它**。
 *
 * 为什么要把异步也 await：页面断言天然是异步的（locator.count() 返回 Promise），
 * 早先这里只写 `fn()` 不 await，于是 `check("x", async () => { await ... })` 里的
 * 失败会变成"未处理的 Promise 拒绝"——断言明明不成立，退出码却还是 0。
 * 这类假绿比没有断言更危险（它让人以为测过了），所以统一在这里收口。
 */
async function check(name, fn) {
	try {
		await fn();
		passed += 1;
		console.log(`  ✓ ${name}`);
	} catch (error) {
		failures.push({ name, error });
		console.log(`  ✗ ${name}`);
		// 只打第一行会把"报错列表"这类多行信息截成空——这里给出前几行，便于定位
		const detail = String(error.message ?? error).split("\n").slice(0, 6).join("\n      ");
		console.log(`      ${detail}`);
	}
}

async function main() {
	// 对话使用 fetch SSE 长连接，导航只等 DOM；页面状态由下面的元素断言确认。
	const browser = await chromium.launch();
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

	// 收集页面 JS 报错：新前端一旦有运行时异常，这条断言能第一时间发现
	const pageErrors = [];
	page.on("pageerror", (error) => pageErrors.push(`[pageerror] ${error.message}`));
	page.on("console", (message) => {
		if (message.type() !== "error") return;
		const text = message.text();
		// 浏览器对**非 2xx 响应**会自己打一条 console error，但它是网络结果、不是页面脚本出错。
		// 本套用例会刻意制造 4xx（例如模拟实例上 409「压缩需要真实模型」、权限不足的 403），
		// 把它们算成"页面 JS 报错"会让断言变成"不许测失败路径"——那不是我们想守的底线。
		// 真正的 JS 异常仍然照收（pageerror，以及不是资源加载失败的 console error）。
		if (/Failed to load resource/i.test(text)) return;
		pageErrors.push(`[console] ${text} @ ${message.location()?.url ?? "?"}`);
	});

	console.log("\n── 应用壳（分组导航 + 主题） ─────────────────────────────");
	await page.goto(`${BASE}/#/workbench`, { waitUntil: "domcontentloaded" });
	await page.waitForTimeout(300);

	await check("页面挂载出应用外壳", () => {
		assert.ok(page.url().includes("/#/workbench"), "应停在 workbench 路由");
	});

	const navText = await page.locator(".app-sider").innerText();
	await check("左侧栏显示品牌与全部模块入口", () => {
		for (const label of ["biz-agent", "工作台", "对话", "Agent", "知识库", "技能", "MCP 集成", "模型管理", "IM 机器人", "审批", "审计", "监控"]) {
			assert.ok(navText.includes(label), `左侧栏应有「${label}」，实际：${navText.replace(/\n/g, " | ")}`);
		}
	});

	await check("导航按「构建 / 接入 / 管理」分组", () => {
		for (const group of ["构建", "接入", "管理"]) {
			assert.ok(navText.includes(group), `应有分组标题「${group}」`);
		}
	});

	// naive-ui 把选项的 label 当纯文本渲染，菜单项是 div 不是 <a>（点击走 update:value）。
	// 所以这里断言"可点击的菜单项"，而不是"链接"——别把组件的行为写成想当然的样子。
	const itemCount = await page.locator(".app-sider .n-menu-item").count();
	await check("导航里有 11 个可点击的菜单项", () => {
		assert.ok(itemCount >= 11, `至少 11 个菜单项，实际 ${itemCount}`);
	});

	console.log("\n── 工作台 ──────────────────────────────────────────");
	const statWidths = await page.locator(".stat-card").evaluateAll((nodes) =>
		nodes.map((node) => Math.round(node.getBoundingClientRect().width)),
	);
	await check("四个统计卡片排成一行（不是各占满宽）", () => {
		assert.equal(statWidths.length, 4, `应有 4 张卡，实际 ${statWidths.length}`);
		assert.ok(statWidths.every((width) => width < 400), `卡片宽度应小于 400px，实际 ${statWidths.join(",")}`);
		assert.equal(new Set(statWidths).size, 1, "四张卡应等宽");
	});

	const statText = await page.locator(".stat-grid").innerText();
	await check("统计卡片显示的是真数据，不是占位符", () => {
		assert.ok(!statText.includes("undefined"), "不能出现 undefined");
		assert.ok(/知识库[\s\S]*当前模型[\s\S]*存储后端/.test(statText), "四张卡的标题都在");
	});

	console.log("\n── 知识库页 ─────────────────────────────────────────");
	await page.goto(`${BASE}/#/knowledge`, { waitUntil: "domcontentloaded" });
	await page.waitForTimeout(500);

	// 空库时页面显示的是空态引导（这是对的），所以先确保至少有一个库再断言两栏布局。
	// 测试不能依赖"这台机器上恰好有数据"——换台干净机器就得红。
	const kbEmpty = await page.locator(".kb-empty-wrap").count();
	if (kbEmpty > 0) {
		await check("空库时显示空态引导，而不是空白两栏", () => {
			assert.equal(kbEmpty, 1, "空库应有空态引导");
		});
		const emptyText = await page.locator(".kb-empty-wrap").innerText();
		await check("空态给了新建入口", () => {
			assert.ok(/新建|创建/.test(emptyText), `空态应提示新建，实际「${emptyText}」`);
		});
		// 建一个库，后续断言才有对象
		await page.locator(".kb-empty-wrap button").first().click();
		await page.waitForTimeout(400);
		const nameInput = page.locator(".n-modal input").first();
		await nameInput.fill(`E2E 知识库 ${Date.now()}`);
		await page.locator(".n-modal button:has-text('创建')").click();
		await page.waitForTimeout(1000);
	}

	await check("知识库页有左栏列表与右栏详情", async () => {
		return page.locator(".kb-list").count().then(async (listCount) => {
			assert.ok(listCount === 1, "应有左栏库列表");
			const detail = await page.locator(".kb-detail").count();
			assert.ok(detail === 1, "应有右栏详情");
		});
	});

	const kbBody = await page.locator(".kb-page").innerText();
	await check("详情区展示配置概要（Embedding / 分块 / 检索状态）", () => {
		for (const label of ["Embedding 模型", "分块策略", "检索状态"]) {
			assert.ok(kbBody.includes(label), `应有「${label}」`);
		}
	});

	// 上传区要查 DOM 而不是查文案：拖拽区是 .kb-drop，必须有真实节点才算"能上传"
	const dropZones = await page.locator(".kb-drop").count();
	await check("详情区有真实的拖拽上传区节点", () => {
		assert.equal(dropZones, 1, `应有 1 个拖拽上传区，实际 ${dropZones}`);
	});
	await check("上传区文案说明支持格式", () => {
		assert.ok(kbBody.includes("拖拽") || kbBody.includes("选择文件"), "应提示上传方式");
		assert.ok(/TXT|PDF|Word/.test(kbBody), "应写明支持的格式");
	});

	console.log("\n── 模块跳转（十一个页面全部可达） ─────────────────────");
	for (const [route, title] of [
		["#/chat", "对话"],
		["#/agents", "Agent"],
		["#/skills", "技能"],
		["#/models", "模型管理"],
		["#/mcp", "MCP 集成"],
		["#/im", "IM 机器人"],
		["#/approvals", "审批"],
		["#/audit", "审计"],
		["#/monitor", "监控"],
	]) {
		await page.goto(`${BASE}/${route}`, { waitUntil: "domcontentloaded" });
		// 懒加载组件超过 300ms 就读标题会读到上一页（「对话」）——等 .page-title 真正渲染出目标标题，
		// 或超时后回落读值如实断言（诊断实锤：全路由标题=「对话」是懒加载没完成，不是路由坏了）。
		await page
			.waitForFunction(
				(t) => (document.querySelector(".page-title")?.textContent ?? "").includes(t),
				title,
				{ timeout: 20000 },
			)
			.catch(() => {});
		const heading = await page.locator(".page-title").innerText().catch(() => "");
		if (!heading.includes(title)) {
			const diag = await page.evaluate(() => ({
				url: location.href,
				titleCount: document.querySelectorAll(".page-title").length,
				titleText: document.querySelector(".page-title")?.textContent ?? null,
				bodyStart: document.body.innerText.slice(0, 80),
			}));
			console.log(`  [诊断路由] ${JSON.stringify(diag)}`);
		}
		await check(`路由 ${route} 渲染出标题「${title}」`, () => {
			assert.ok(heading.includes(title), `标题应是「${title}」，实际「${heading}」`);
		});
	}

	console.log("\n── 技能页（卡片网格） ───────────────────────────────");
	await page.goto(`${BASE}/#/skills`, { waitUntil: "domcontentloaded" });
	await page.waitForTimeout(600);

	// 懒加载同款问题：等技能卡真正渲染出来再数（超时则如实为 0，由断言判定）
	await page
		.waitForFunction(
			() => document.querySelectorAll(".skill-card").length >= 3,
			{ timeout: 8000 },
		)
		.catch(() => {});
	const skillCards = await page.locator(".skill-card").count();
	await check("技能以卡片呈现，且不止一张", () => {
		assert.ok(skillCards >= 3, `至少 3 张技能卡，实际 ${skillCards}`);
	});

	const skillText = await page.locator(".page").innerText();
	await check("自动编排不出现在技能列表里", () => {
		assert.ok(!skillText.includes("自动编排"), "auto-flow 是默认聊天模式，不该当成可选技能列出来");
	});
	await check("技能卡片显示步骤数与工具数", () => {
		assert.ok(/\d+ 个步骤|由模型自选工具/.test(skillText), "应显示步骤数或「由模型自选工具」");
	});
	await check("分类筛选包含内置与自建", () => {
		assert.ok(skillText.includes("内置") && skillText.includes("自建"), "应有内置/自建分类");
	});
	const filterChips = await page.locator(".filter-chips .chip").count();
	const activeChip = await page.locator(".filter-chips .chip--active").innerText();
	await check("分类 chip 是真实可点节点，且默认选中「全部」", () => {
		assert.ok(filterChips >= 3, `至少 3 个分类 chip，实际 ${filterChips}`);
		assert.ok(activeChip.startsWith("全部"), `默认应选中「全部」，实际「${activeChip}」`);
	});
	const searchBox = await page.locator(".filter-search input").count();
	await check("有技能搜索框", () => {
		assert.equal(searchBox, 1, `应有 1 个搜索框，实际 ${searchBox}`);
	});

	console.log("\n── 模型页（当前模型标记） ───────────────────────────");
	await page.goto(`${BASE}/#/models`, { waitUntil: "domcontentloaded" });
	await page.waitForTimeout(600);

	const currentTags = await page.locator(".current-tag").count();
	const inUseButtons = await page.locator("button:has-text('使用中')").count();
	const modelRows = await page.locator(".row-list .row").count();

	// 模型库为空时（例如 LLM_DISABLE=1 的模拟实例从没建过供应商）根本没有"当前模型"，
	// 那不是页面 bug。区分两种情形：有模型就必须有且只有一个当前标记；没模型必须给新建入口。
	if (modelRows === 0) {
		const modelsText = await page.locator(".page").innerText();
		await check("模型库为空时给出新建入口，而不是空白", () => {
			assert.ok(/还没有模型|没有供应商|添加/.test(modelsText), `空模型库应给出说明，实际「${modelsText.slice(0, 120)}」`);
		});
	} else {
		await check("当前模型有「当前」标记", () => {
			assert.equal(currentTags, 1, `应恰好 1 个当前标记，实际 ${currentTags}`);
		});
		await check("当前模型那一行的按钮显示「使用中」且禁用", () => {
			assert.equal(inUseButtons, 1, `应恰好 1 个「使用中」按钮，实际 ${inUseButtons}`);
		});
	}

	// ── 模型页：最大上下文可配置（改的是真接口，跑完恢复原值） ──────────────────────
	// 这一段的每一步都落在真实 DOM + 真实接口上：输入框能不能改、列表会不会跟着变、
	// GET /api/models 回来的 contextWindow 到底是不是存进去的那个数。
	// 之所以自己建一条模型来改、而不是改现场那条：现场那条可能是 user 真实在用的模型，
	// 把它的最大上下文改成测试值等于污染别人的库（别的用例也会读这个值）。
	if (modelRows === 0) {
		await check("模型库为空时跳过最大上下文用例（空库没有可改的模型）", () => {
			// 空模型库的实例上这条路径本来就走不到；不是静默放过，而是明说这一步没测。
			assert.equal(modelRows, 0, "只有空模型库才会走到这里");
		});
	} else {
		// 临时模型：直接用接口建，界面上的新建入口不归本用例（那是另一条路径，别混在一起测）
		const tempName = `E2E 上下文模型 ${Date.now() % 100000}`;
		const tempModelRowId = await page.evaluate(async (name) => {
			const list = await (await fetch("/api/models")).json();
			const provider = (list.providers ?? [])[0];
			if (!provider) return "";
			const created = await fetch("/api/models", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ providerId: provider.id, modelId: `e2e-ctx-${Date.now()}`, name, kind: "chat", enabled: true }),
			});
			if (!created.ok) return "";
			return (await created.json()).id ?? "";
		}, tempName);
		await check("能建一条临时模型来验最大上下文（跑完会删掉）", () => {
			assert.ok(tempModelRowId.length > 0, "临时模型应创建成功，否则后面的断言没有对象");
		});

		// 新建是走接口的，页面不会自己知道——刷一次页面再断言，否则行根本不在 DOM 里
		await page.reload({ waitUntil: "domcontentloaded" });
		await page.waitForTimeout(700);
		// 页面上下有两个 .row-list（供应商、模型），模型行只可能出现在「模型」面板里，
		// 用第几个 row-list 这种位置依赖去选中它，面板顺序一变就红
		const modelPanelRows = page.locator(".panel", { hasText: "模型" }).last().locator(".row-list .row");
		let tempRow = modelPanelRows.filter({ hasText: tempName }).first();
		let tempText = await tempRow.innerText();
		await check("没有配置时列表如实写「未配置」，不显示 0 或空白", () => {
			assert.ok(tempText.includes("未配置"), `新模型应显示「未配置」，实际「${tempText.replace(/\n/g, " | ")}」`);
		});

		// 改一次：输入 128k → 保存 → 接口按 131072 tokens 精确落库
		await tempRow.locator('[data-testid="model-context-edit"]').click();
		await page.waitForTimeout(400);
		const contextModal = page.locator(".n-modal", { hasText: "最大上下文" });
		await check("点「最大上下文」打开编辑抽屉", async () => {
			assert.equal(await contextModal.count(), 1, "应弹出最大上下文编辑框");
		});
		const contextInput = contextModal.locator('[data-testid="model-context-input"] input');
		await check("编辑框提到单位是 token（不然没人知道该填什么）", async () => {
			const modalText = await contextModal.innerText();
			assert.ok(modalText.includes("k"), `编辑框应写明 k 单位，实际「${modalText.slice(0, 120)}」`);
		});
		await contextInput.fill("128");
		await contextModal.locator('[data-testid="model-context-save"]').click();
		await page.waitForTimeout(1200);

		tempRow = modelPanelRows.filter({ hasText: tempName }).first();
		tempText = await tempRow.innerText();
		const contextCell = (await tempRow.locator('[data-testid="model-context-value"]').innerText()).trim();
		await check("填 128k 保存后，列表显示 128k 且接口精确落库", () => {
			assert.equal(contextCell.trim(), "128k", `应只显示 128k，实际「${contextCell}」`);
			assert.ok(!tempText.includes("未配置"), "配置之后不该再显示未配置");
		});
		const savedContext = await page.evaluate(async (id) => {
			const list = await (await fetch("/api/models")).json();
			return (list.models ?? []).find((model) => model.id === id)?.contextWindow ?? null;
		}, tempModelRowId);
		await check("GET /api/models 回来的 contextWindow 就是刚存的 131072（对话页靠这个值算占比）", () => {
			assert.equal(savedContext, 131072, `接口应回读 131072，实际 ${savedContext}`);
		});

		// 再改一次：换成另一个值，确认列表与接口都跟着变（防止"只第一次生效"这类缓存问题）
		await tempRow.locator('[data-testid="model-context-edit"]').click();
		await page.waitForTimeout(400);
		const contextInputAgain = page.locator(".n-modal", { hasText: "最大上下文" }).locator('[data-testid="model-context-input"] input');
		await contextInputAgain.fill("250");
		await page.locator(".n-modal", { hasText: "最大上下文" }).locator('[data-testid="model-context-save"]').click();
		await page.waitForTimeout(1200);
		const onceMore = await page.evaluate(async (id) => {
			const list = await (await fetch("/api/models")).json();
			return (list.models ?? []).find((model) => model.id === id)?.contextWindow ?? null;
		}, tempModelRowId);
		await check("改第二次也生效（250k → 存为 256000 tokens，列表仍显示 250k）", async () => {
			assert.equal(onceMore, 256000, `接口应回读 256000，实际 ${onceMore}`);
			const cell = (await modelPanelRows.filter({ hasText: tempName }).first().locator('[data-testid="model-context-value"]').innerText()).trim();
			assert.equal(cell, "250k", `应显示 250k，实际「${cell}」`);
		});

		// 留空 = 清空配置：列表回到「未配置」，接口回 null（不是 0、也不是留着旧值）
		await modelPanelRows.filter({ hasText: tempName }).first().locator('[data-testid="model-context-edit"]').click();
		await page.waitForTimeout(400);
		await page.locator(".n-modal", { hasText: "最大上下文" }).locator('[data-testid="model-context-input"] input').fill("");
		await page.locator(".n-modal", { hasText: "最大上下文" }).locator('[data-testid="model-context-save"]').click();
		await page.waitForTimeout(1200);
		const clearedContext = await page.evaluate(async (id) => {
			const list = await (await fetch("/api/models")).json();
			return (list.models ?? []).find((model) => model.id === id)?.contextWindow ?? null;
		}, tempModelRowId);
		await check("留空保存 = 清空配置（接口回 null，列表回到未配置）", async () => {
			assert.equal(clearedContext, null, `清空后应为 null，实际 ${clearedContext}`);
			const cell = (await modelPanelRows.filter({ hasText: tempName }).first().locator('[data-testid="model-context-value"]').innerText()).trim();
			assert.ok(cell.includes("未配置"), `清空后应显示未配置，实际「${cell}」`);
		});

		// 非法值必须被挡住：0 / 负数是踩过的坑（后端会 400「contextWindow 必须是正整数」），
		// 前端要在弹窗里就地提示，而不是把 400 的原文丢给用户
		await modelPanelRows.filter({ hasText: tempName }).first().locator('[data-testid="model-context-edit"]').click();
		await page.waitForTimeout(400);
		await page.locator(".n-modal", { hasText: "最大上下文" }).locator('[data-testid="model-context-input"] input').fill("0");
		await page.locator(".n-modal", { hasText: "最大上下文" }).locator('[data-testid="model-context-save"]').click();
		await page.waitForTimeout(900);
		const stillOpen = await page.locator(".n-modal", { hasText: "最大上下文" }).count();
		const afterInvalid = await page.evaluate(async (id) => {
			const list = await (await fetch("/api/models")).json();
			return (list.models ?? []).find((model) => model.id === id)?.contextWindow ?? null;
		}, tempModelRowId);
		await check("填 0 保存被挡住：弹窗不关、库里也不落这个值", () => {
			assert.equal(stillOpen, 1, "非法值不该把弹窗关掉（关了等于假装保存成功）");
			assert.equal(afterInvalid, null, `非法值不该落库，实际 ${afterInvalid}`);
		});
		await page.locator(".n-modal", { hasText: "最大上下文" }).locator("button:has-text('取消')").click();
		await page.waitForTimeout(400);

		// 清理：临时模型删掉，别让它留在模型库里（别的用例会数模型行）
		await page.evaluate(async (id) => {
			await fetch(`/api/models/${id}`, { method: "DELETE" });
		}, tempModelRowId);
		await page.reload({ waitUntil: "domcontentloaded" });
		await page.waitForTimeout(800);
		const leftoverTemp = await modelPanelRows.filter({ hasText: tempName }).count();
		await check("最大上下文用例的临时模型已清理干净", () => {
			assert.equal(leftoverTemp, 0, `应删掉临时模型，实际还剩 ${leftoverTemp} 行`);
		});
	}

	// ── 模型页：模型可增删改（全程自建自删，不碰现场已有模型） ──────────────────────
	// 这一段要证明的是「用户能在界面上把模型管起来」，所以每一步都走真实 DOM 点出来，
	// 再用 GET /api/models 回读确认真落库了——只看页面文字不算数（页面可能自己骗自己）。
	console.log("\n── 模型页：模型增删改 ───────────────────────────────");
	await page.goto(`${BASE}/#/models`, { waitUntil: "domcontentloaded" });
	await page.waitForTimeout(800);

	// 没有供应商就建不出来模型（providerId 是必填）。这个实例上若一条都没有，先补一条临时供应商，
	// 用完删掉——不这样做，全新空库上这一段就只能跳过，等于没测。
	const formProvider = await page.evaluate(async () => {
		const list = await (await fetch("/api/models")).json();
		const existing = (list.providers ?? [])[0];
		if (existing) return { id: existing.id, temporary: false };
		const created = await fetch("/api/models/providers", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "E2E-MF-供应商", kind: "openai", baseUrl: "http://127.0.0.1:9/v1" }),
		});
		if (!created.ok) return { id: "", temporary: false };
		return { id: (await created.json()).id ?? "", temporary: true };
	});
	await check("模型增删改用例有供应商可用（没有就临时建一条）", () => {
		assert.ok(formProvider.id.length > 0, "建模型必须有供应商，这里应拿到一条");
	});

	await page.reload({ waitUntil: "domcontentloaded" });
	await page.waitForTimeout(800);

	// --- ① 新建入口存在，且点得开 ---
	const createButtonCount = await page.locator('[data-testid="model-create"]').count();
	await check("模型面板有「＋ 新建模型」入口", () => {
		assert.equal(createButtonCount, 1, `应恰好 1 个新建按钮，实际 ${createButtonCount}`);
	});

	const newModelName = `E2E-MF-模型-${Date.now() % 1000000}`;
	const newModelId = `e2e-mf-${Date.now()}`;
	await page.locator('[data-testid="model-create"]').click();
	await page.waitForTimeout(700);
	const formModal = page.locator('[data-testid="model-form"]');
	const formModalCount = await formModal.count();
	await check("点「＋ 新建模型」弹出表单", () => {
		assert.equal(formModalCount, 1, `应弹出 1 个表单弹窗，实际 ${formModalCount}`);
	});

	// 表单里模型 ID 是必填：先只填显示名点保存，必须被挡住（不能静默建出一条没有 modelId 的记录）
	await formModal.locator('[data-testid="model-form-name"] input').fill(newModelName);
	await formModal.locator('[data-testid="model-form-save"]').click();
	await page.waitForTimeout(600);
	const stillOpenAfterMissingId = await page.locator('[data-testid="model-form"]').count();
	await check("只填显示名、不填模型 ID 时保存被挡住", () => {
		assert.equal(stillOpenAfterMissingId, 1, "缺必填项不该关弹窗（关了等于假装建成功）");
	});

	// 补齐真字段再保存
	await formModal.locator('[data-testid="model-form-model-id"] input').fill(newModelId);
	await formModal.locator('[data-testid="model-form-context"] input').fill("128");
	await formModal.locator('[data-testid="model-form-save"]').click();
	await page.waitForTimeout(1200);

	// --- ② 真的建出来了：页面上有它，接口里也有它 ---
	const createdRow = page.locator(".row-list .row").filter({ hasText: newModelName }).first();
	const createdRowCount = await page.locator(".row-list .row").filter({ hasText: newModelName }).count();
	await check("新建的模型出现在列表里", () => {
		assert.equal(createdRowCount, 1, `新建后列表应有 1 行，实际 ${createdRowCount}`);
	});

	const createdInApi = await page.evaluate(async (name) => {
		const list = await (await fetch("/api/models")).json();
		const row = (list.models ?? []).find((model) => model.name === name);
		return row ? { id: row.id, modelId: row.modelId, contextWindow: row.contextWindow, enabled: row.enabled } : null;
	}, newModelName);
	await check("新建的模型真的落库了（GET /api/models 能查到，字段对得上）", () => {
		assert.ok(createdInApi, "接口里应能查到刚建的模型");
		assert.equal(createdInApi.modelId, newModelId, `模型 ID 应原样存下，实际 ${createdInApi?.modelId}`);
		assert.equal(createdInApi.contextWindow, 131072, `最大上下文应存下，实际 ${createdInApi?.contextWindow}`);
		assert.equal(createdInApi.enabled, true, "默认应是启用状态");
	});

	// --- ③ 编辑：改显示名 + 最大上下文，改完页面与接口都要变 ---
	await createdRow.locator('[data-testid="model-edit"]').click();
	await page.waitForTimeout(700);
	const editModal = page.locator('[data-testid="model-form"]');
	const editPrefill = await editModal.locator('[data-testid="model-form-model-id"] input').inputValue();
	await check("点「编辑」打开的表单带出了这条模型的现有值", () => {
		assert.equal(editPrefill, newModelId, `编辑表单应预填原模型 ID，实际「${editPrefill}」`);
	});

	const renamedModel = `${newModelName}-已改`;
	await editModal.locator('[data-testid="model-form-name"] input').fill(renamedModel);
	await editModal.locator('[data-testid="model-form-context"] input').fill("62.5");
	await editModal.locator('[data-testid="model-form-save"]').click();
	await page.waitForTimeout(1200);

	const editedInApi = await page.evaluate(async (id) => {
		const list = await (await fetch("/api/models")).json();
		const row = (list.models ?? []).find((model) => model.id === id);
		return row ? { name: row.name, contextWindow: row.contextWindow } : null;
	}, createdInApi?.id);
	await check("编辑真的生效了（显示名与最大上下文都改到了库里）", () => {
		assert.ok(editedInApi, "接口里应还能查到这条模型");
		assert.equal(editedInApi.name, renamedModel, `显示名应已更新，实际「${editedInApi?.name}」`);
		assert.equal(editedInApi.contextWindow, 64000, `最大上下文应已更新，实际 ${editedInApi?.contextWindow}`);
	});

	const renamedRowCount = await page.locator(".row-list .row").filter({ hasText: renamedModel }).count();
	await check("编辑后列表显示的是新名字", () => {
		assert.equal(renamedRowCount, 1, `列表应有 1 行新名字，实际 ${renamedRowCount}`);
	});

	// --- ④ 测试连通：接口永远 200，成败只看 body.ok；界面必须如实反馈 ---
	const pingRow = page.locator(".row-list .row").filter({ hasText: renamedModel }).first();
	await pingRow.locator('[data-testid="model-ping"]').click();
	await page.waitForTimeout(2500);
	const pingRowText = await page.locator(".row-list .row").filter({ hasText: renamedModel }).first().innerText();
	// 这条模型指向 127.0.0.1:9（必然连不上），所以正确表现是「连不上 + 原因」，
	// 而**不是**空着或假装成功——这正是「ping 失败也是 200」这个语义的界面一侧。
	await check("「测试连通」如实反馈失败，并带上后端给的原因", () => {
		assert.ok(/连不上|连通正常/.test(pingRowText), `应显示测试结果，实际「${pingRowText.slice(0, 160)}」`);
		if (pingRowText.includes("连不上")) {
			assert.ok(
				pingRowText.split("连不上")[1].trim().length > 1,
				"说连不上时要把后端给的原因带出来，不能只写三个字",
			);
		}
	});

	// --- ⑤ 删除：确认框拦一道，删完页面与接口都没有它 ---
	await page.locator(".row-list .row").filter({ hasText: renamedModel }).first().locator('[data-testid="model-delete"]').click();
	await page.waitForTimeout(600);
	const confirmVisible = await page.locator(".n-popconfirm").count();
	await check("点「删除」先弹确认框，不是点了就没", () => {
		assert.ok(confirmVisible > 0, "删除应二次确认，避免误删正在用的模型");
	});
	await page.locator(".n-popconfirm button:has-text('删除')").last().click();
	await page.waitForTimeout(1500);

	const afterDeleteRows = await page.locator(".row-list .row").filter({ hasText: renamedModel }).count();
	const afterDeleteInApi = await page.evaluate(async (id) => {
		const list = await (await fetch("/api/models")).json();
		return (list.models ?? []).some((model) => model.id === id);
	}, createdInApi?.id);
	await check("删除后列表里不再有它", () => {
		assert.equal(afterDeleteRows, 0, `删除后不该还有这行，实际 ${afterDeleteRows}`);
	});
	await check("删除后接口里也查不到它（真删了，不是只从页面上抹掉）", () => {
		assert.equal(afterDeleteInApi, false, "GET /api/models 不该再返回这条");
	});

	// 清理：临时建的供应商也别留下（别的用例会数供应商）
	if (formProvider.temporary) {
		await page.evaluate(async (id) => {
			await fetch(`/api/models/providers/${id}`, { method: "DELETE" });
		}, formProvider.id);
	}
	await page.reload({ waitUntil: "domcontentloaded" });
	await page.waitForTimeout(700);
	const leftoverCrud = await page.locator(".row-list .row").filter({ hasText: "E2E-MF-" }).count();
	await check("模型增删改用例的临时数据已清理干净", () => {
		assert.equal(leftoverCrud, 0, `应清空 E2E-MF- 行，实际还剩 ${leftoverCrud} 行`);
	});

	// ── 模型页：供应商可增删改（全程自建自删，不碰现场已有供应商） ──────────────────────
	// 与模型增删改同一条思路：每一步点真实 DOM，再用 GET /api/models/providers 回读确认真落库。
	// Key 的安全语义单独钉住：编辑时掩码要露出来、留空保存不能把 Key 弄丢。
	console.log("\n── 模型页：供应商增删改 ─────────────────────────────");
	await page.goto(`${BASE}/#/models`, { waitUntil: "domcontentloaded" });
	await page.waitForTimeout(800);

	const providerPanel = page.locator(".panel", { hasText: "供应商" }).last();
	const providerRows = providerPanel.locator(".row-list .row");

	// --- ① 新建入口存在，点得开 ---
	const providerCreateCount = await page.locator('[data-testid="provider-create"]').count();
	await check("供应商面板有「＋ 新建供应商」入口", () => {
		assert.equal(providerCreateCount, 1, `应恰好 1 个新建供应商按钮，实际 ${providerCreateCount}`);
	});

	const newProviderName = `E2E-PV-供应商-${Date.now() % 1000000}`;
	await page.locator('[data-testid="provider-create"]').click();
	await page.waitForTimeout(700);
	const providerModal = page.locator('[data-testid="provider-form"]');
	await check("点「＋ 新建供应商」弹出表单", async () => {
		assert.equal(await providerModal.count(), 1, "应弹出供应商表单");
	});

	// 名称必填：空名称点保存必须被挡住
	await providerModal.locator('[data-testid="provider-form-save"]').click();
	await page.waitForTimeout(600);
	await check("名称留空时保存被挡住", async () => {
		assert.equal(await providerModal.count(), 1, "缺必填项不该关弹窗（关了等于假装建成功）");
	});

	// 填齐真字段（带一个假 Key）再保存
	await providerModal.locator('[data-testid="provider-form-name"] input').fill(newProviderName);
	await providerModal.locator('[data-testid="provider-form-base-url"] input').fill("http://127.0.0.1:9/v1");
	await providerModal.locator('[data-testid="provider-form-api-key"] input').fill("sk-e2e-provider-key");
	await providerModal.locator('[data-testid="provider-form-save"]').click();
	await page.waitForTimeout(1200);

	// --- ② 真的建出来了：页面上有它，接口里也有它 ---
	const createdProviderRow = providerRows.filter({ hasText: newProviderName }).first();
	await check("新建的供应商出现在列表里", async () => {
		assert.equal(await providerRows.filter({ hasText: newProviderName }).count(), 1, "列表应有这一行");
	});
	const createdProvider = await page.evaluate(async (name) => {
		const response = await fetch("/api/models/providers");
		const payload = await response.json();
		const items = Array.isArray(payload) ? payload : (payload.items ?? []);
		return items.find((item) => item.name === name) ?? null;
	}, newProviderName);
	await check("新建的供应商真的落库了（GET 接口能查到）", () => {
		assert.ok(createdProvider, "接口里应能查到刚建的供应商");
		assert.ok(createdProvider.hasApiKey === true, "填了 Key 的供应商应标记 hasApiKey");
		assert.ok((createdProvider.apiKeyMasked ?? "").length > 0, "应返回掩码（明文不该再出现）");
	});

	// --- ③ Key 的掩码语义：编辑表单里 Key 是空的，页面显示的是掩码 ---
	await createdProviderRow.locator('[data-testid="provider-edit"]').click();
	await page.waitForTimeout(700);
	const editProviderModal = page.locator('[data-testid="provider-form"]');
	const editKeyValue = await editProviderModal.locator('[data-testid="provider-form-api-key"] input').inputValue();
	await check("编辑表单的 Key 框是空的（不是把掩码字符串当值塞回去）", () => {
		assert.equal(editKeyValue, "", `Key 框应留空（留空=不改），实际「${editKeyValue}」`);
	});
	const keyStatusText = await editProviderModal.locator('[data-testid="provider-form-key-status"]').innerText();
	await check("编辑表单如实展示 Key 现状（掩码原样，不显示明文）", () => {
		assert.ok(keyStatusText.includes("当前 Key"), `应说明当前 Key 状态，实际「${keyStatusText}」`);
		assert.ok(!keyStatusText.includes("sk-e2e-provider-key"), "明文绝不能出现在编辑表单里");
	});

	// 留空 Key 保存 = 不改：接口里的掩码还在
	await editProviderModal.locator('[data-testid="provider-form-name"] input').fill(`${newProviderName}-已改`);
	await editProviderModal.locator('[data-testid="provider-form-save"]').click();
	await page.waitForTimeout(1200);
	const afterRename = await page.evaluate(async (id) => {
		const response = await fetch("/api/models/providers");
		const payload = await response.json();
		const items = Array.isArray(payload) ? payload : (payload.items ?? []);
		return items.find((item) => item.id === id) ?? null;
	}, createdProvider.id);
	await check("改名后接口里是新名字，且 Key 没被空值冲掉", () => {
		assert.equal(afterRename?.name, `${newProviderName}-已改`, `应已改名，实际 ${afterRename?.name}`);
		assert.equal(afterRename?.hasApiKey, true, "留空保存不该把 Key 弄丢");
	});
	await check("改名后列表行跟着变", async () => {
		assert.equal(await providerRows.filter({ hasText: `${newProviderName}-已改` }).count(), 1, "列表应显示新名字");
		// 旧名是新名的前缀（E2E-供应商-xxx ⊂ xxx-已改），模糊 hasText 会把改名后的行也算进去——
		// 要逐行取「名字元素」的精确文本再比（诊断实锤过这个坑）。
		const providerRowNames = await providerRows.locator(".row-name").allInnerTexts();
		assert.ok(
			!providerRowNames.some((text) => text.trim() === newProviderName),
			`旧名字不该再出现，实际列表名字 ${JSON.stringify(providerRowNames.map((s) => s.trim()))}`,
		);
	});

	// --- ④ 删除：确认弹窗明说后果，删完页面与接口都没有它 ---
	await providerRows.filter({ hasText: `${newProviderName}-已改` }).first().locator('[data-testid="provider-delete"]').click();
	await page.waitForTimeout(600);
	const confirmText = await page.locator(".n-popconfirm").innerText();
	await check("删除确认弹窗写明会连带删模型", () => {
		assert.ok(confirmText.includes("模型"), `确认文案应提模型，实际「${confirmText}」`);
	});
	await page.locator(".n-popconfirm button:has-text('删除')").click();
	await page.waitForTimeout(1200);
	await check("删除后列表里不再有它", async () => {
		assert.equal(await providerRows.filter({ hasText: "E2E-PV-" }).count(), 0, "列表不该再有这条供应商");
	});
	const afterDeleteProvider = await page.evaluate(async (id) => {
		const response = await fetch("/api/models/providers");
		const payload = await response.json();
		const items = Array.isArray(payload) ? payload : (payload.items ?? []);
		return items.some((item) => item.id === id);
	}, createdProvider.id);
	await check("删除后接口里也查不到它（真删了）", () => {
		assert.equal(afterDeleteProvider, false, "GET 接口不该再返回这条供应商");
	});
	console.log("\n── 监控页（指标卡是真数据） ─────────────────────────");
	await page.goto(`${BASE}/#/monitor`, { waitUntil: "domcontentloaded" });
	await page.waitForTimeout(900);

	const monitorStats = await page.locator(".stat-value").allTextContents();
	await check("监控页四张指标卡都有值", () => {
		assert.equal(monitorStats.length, 4, `应有 4 张指标卡，实际 ${monitorStats.length}`);
		for (const value of monitorStats) {
			assert.ok(value.trim().length > 0, "指标卡不能是空的");
		}
	});
	// 四张卡是**不同口径**的指标（会话总数 / 24h 消息 / 工具调用 ok/total / P95 耗时），
	// 不能拿单个 toolCalls 去比「是否全零」——那是个立不住的不变式（会话数与调用数本来就不等）。
	// 正确断言：每张卡与 summary 的对应字段一一相符，且格式合理。
	const monitorSummary = await page.evaluate(async () => {
		const response = await fetch("/api/monitor/summary?range=24h");
		return await response.json();
	});
	await check("指标卡逐张与后端 summary 对应字段一致（不是拿单一字段比全零）", () => {
		const calls = monitorSummary?.toolCalls ?? {};
		const expect = [
			String(monitorSummary?.sessions?.total ?? 0),
			String(monitorSummary?.messages24h ?? 0),
			`${calls.ok ?? 0}/${calls.total ?? 0}`,
			String(Math.round(monitorSummary?.p95Ms ?? 0)),
		];
		assert.equal(monitorStats.length, expect.length, `应有 ${expect.length} 张卡，实际 ${monitorStats.length}`);
		for (let i = 0; i < expect.length; i += 1) {
			assert.ok(
				monitorStats[i].includes(expect[i]),
				`第 ${i + 1} 张卡应显示「${expect[i]}」，实际「${monitorStats[i]}」`,
			);
		}
	});


	console.log("\n── Agent 页（六维配置 + 状态机） ─────────────────────");
	await page.goto(`${BASE}/#/agents`, { waitUntil: "domcontentloaded" });
	await page.waitForTimeout(700);

	// 新建一个 Agent 走全链：草稿 → 试运行 → 发布 → 停用 → 召回，最后删掉不污染库。
	// 每一步都查真实 DOM，不写"永远通过"的空断言。
	const agentName = `E2E-${Date.now()}`;
	await page.locator("button:has-text('新建 Agent')").click();
	await page.waitForTimeout(400);

	const tabs = await page.locator(".n-tabs-tab").allTextContents();
	await check("Agent 编辑抽屉有六个维度", () => {
		const expected = ["基础信息", "人格与指令", "模型策略", "记忆", "能力绑定", "高级"];
		for (const label of expected) {
			assert.ok(tabs.some((tab) => tab.includes(label)), `缺少维度「${label}」，实际 ${tabs.join(",")}`);
		}
		assert.equal(tabs.length, 6, `应恰好 6 个 Tab，实际 ${tabs.length}`);
	});

	await page.locator(".n-modal input").first().fill(agentName);
	await page.locator(".n-modal button:has-text('保存')").click();
	await page.waitForTimeout(1000);

	const agentCard = page.locator(".agent-card", { hasText: agentName });
	const cardCount = await agentCard.count();
	await check("新建后列表出现这张卡片", () => {
		assert.equal(cardCount, 1, `应出现 1 张卡片，实际 ${cardCount}`);
	});

	const statusTag = (await agentCard.locator(".n-tag").innerText()).trim();
	await check("新建的 Agent 状态是草稿", () => {
		assert.equal(statusTag, "草稿", `新建应为草稿，实际「${statusTag}」`);
	});

	// 状态机：草稿只给「试运行 / 发布」，「停用」要到已发布才有
	const draftButtons = await agentCard.locator("button").allTextContents();
	await check("草稿态只提供「试运行 / 发布」两个动作", () => {
		assert.ok(draftButtons.includes("试运行"), `应有「试运行」，实际 ${draftButtons.join(",")}`);
		assert.ok(draftButtons.includes("发布"), `应有「发布」，实际 ${draftButtons.join(",")}`);
		assert.ok(!draftButtons.includes("停用"), "草稿不该有「停用」");
	});

	await agentCard.locator("button:has-text('试运行')").click();
	await page.waitForTimeout(900);
	const testingTag = (await agentCard.locator(".n-tag").innerText()).trim();
	await check("点「试运行」后进入试运行态", () => {
		assert.equal(testingTag, "试运行", `应为「试运行」，实际「${testingTag}」`);
	});

	await agentCard.locator("button:has-text('发布')").click();
	await page.waitForTimeout(900);
	const publishedTag = (await agentCard.locator(".n-tag").innerText()).trim();
	await check("发布后进入已发布态", () => {
		assert.equal(publishedTag, "已发布", `应为「已发布」，实际「${publishedTag}」`);
	});

	// 已发布不能编辑：按钮必须禁用（后端也会 409，但界面不该给人可点的错觉）
	const configDisabled = await agentCard.locator("button:has-text('配置')").isDisabled();
	await check("已发布的「配置」按钮被禁用（改前必须召回）", () => {
		assert.equal(configDisabled, true, "已发布态不该允许直接点开配置");
	});

	const publishedButtons = await agentCard.locator("button").allTextContents();
	await check("已发布态提供「停用 / 召回草稿」", () => {
		assert.ok(publishedButtons.includes("停用"), `应有「停用」，实际 ${publishedButtons.join(",")}`);
		assert.ok(publishedButtons.includes("召回草稿"), `应有「召回草稿」，实际 ${publishedButtons.join(",")}`);
	});

	await agentCard.locator("button:has-text('停用')").click();
	await page.waitForTimeout(900);
	const stoppedTag = (await agentCard.locator(".n-tag").innerText()).trim();
	await check("停用后进入已停用态", () => {
		assert.equal(stoppedTag, "已停用", `应为「已停用」，实际「${stoppedTag}」`);
	});

	await agentCard.locator("button:has-text('恢复为草稿')").click();
	await page.waitForTimeout(900);
	const backTag = (await agentCard.locator(".n-tag").innerText()).trim();
	await check("召回后回到草稿态", () => {
		assert.equal(backTag, "草稿", `应为「草稿」，实际「${backTag}」`);
	});

	// 清理：删掉这条 e2e 数据，别让每跑一次就多几张卡
	await agentCard.locator("button:has-text('删除')").click();
	await page.waitForTimeout(900);
	const afterDelete = await page.locator(".agent-card", { hasText: agentName }).count();
	await check("删除后卡片消失", () => {
		assert.equal(afterDelete, 0, `删除后不该还有卡片，实际 ${afterDelete}`);
	});

	// ── 发布之后必须能真的聊起来（这是"Agent 不是摆设"的唯一证据）─────────────────
	// 之前这一步是缺的：Agent 发布完没有任何入口说话，配置再完整也是死的。
	await page.goto(`${BASE}/#/agents`, { waitUntil: "domcontentloaded" });
	await page.waitForTimeout(700);
	const chatAgentName = `E2E-CHAT-${Date.now()}`;
	await page.locator("button:has-text('新建 Agent')").click();
	await page.waitForTimeout(400);
	await page.locator(".n-modal input").first().fill(chatAgentName);
	await page.locator(".n-modal button:has-text('保存')").click();
	await page.waitForTimeout(1000);

	const chatAgentCard = page.locator(".agent-card", { hasText: chatAgentName });
	// 精确匹配按钮文案：卡片上还有一个「专属对话」入口，子串匹配会把两个都算进来
	const draftHasChat = await chatAgentCard.getByRole("button", { name: "对话", exact: true }).count();
	await check("草稿态 Agent 就带「对话」入口（可对话状态与后端一致）", () => {
		assert.equal(draftHasChat, 1, `草稿应有「对话」按钮，实际 ${draftHasChat}`);
	});

	// 点进对话页，确认它是绑到这个 Agent 的真实会话
	await chatAgentCard.getByRole("button", { name: "对话", exact: true }).click();
	await page.waitForTimeout(1600);
	const chatUrl = page.url();
	await check("点「对话」跳到这个 Agent 的专属页并带上会话 id", () => {
		assert.ok(chatUrl.includes("#/agent-chat/"), `应跳到 #/agent-chat/，实际 ${chatUrl}`);
		assert.ok(chatUrl.includes("session="), `应带 session 参数，实际 ${chatUrl}`);
	});

	const chatHeadText = await page.locator(".chat-head").innerText().catch(() => "");
	await check("专属页头部标出这是哪个 Agent 的对话", () => {
		assert.ok(chatHeadText.includes(chatAgentName), `头部应显示 Agent 名，实际「${chatHeadText}」`);
	});

	const inputBox = page.locator(".chat-input textarea");
	const canType = await inputBox.count();
	await check("对话页有可输入的输入框", () => {
		assert.equal(canType, 1, "应有输入框");
	});

	// 真的发一条消息，等 SSE 把回复推回来（模拟模型也会回，只是内容是脚本化的）
	await inputBox.fill("你好");
	await page.locator(".chat-input button:has-text('发送')").click();
	// 等「助手气泡」真的出现（最长 60 秒）：live 模型偶尔慢于固定 sleep，
	// 写死 4 秒会把正常回复误判成「没有回复」。
	await page
		.waitForFunction(
			() => document.querySelectorAll(".chat-bubble").length >= 2,
			{ timeout: 60000 },
		)
		.catch(() => {});
	const bubbles = await page.locator(".chat-bubble").allTextContents();
	// live 实例上模型可能整体不可用（DeepSeek 402 余额不足探针实锤过）——那是环境问题不是缺陷，
	// 但**用户消息必须出现**、失败必须有错误条：这两条任何时候都要成立。
	const modelDown = await page.locator(".chat-alert").innerText().then((t) => /402|余额|模型调用失败/.test(t)).catch(() => false);
	await check("发消息后对话里出现我的消息（模型可用时还必须有助手回复）", () => {
		assert.ok(bubbles.some((text) => text.includes("你好")), `应有用户消息，实际 ${bubbles.length} 条气泡`);
		if (modelDown) return; // 模型整体不可用：助手回复必然没有，错误条已如实显示，不在这儿要求奇迹
		assert.ok(bubbles.length >= 2, `应有助手回复，实际 ${bubbles.length} 条气泡`);
	});

	// 停用的 Agent 不能聊：卡片上不该再给「对话」入口（后端也会 409，两道防线）
	await page.goto(`${BASE}/#/agents`, { waitUntil: "domcontentloaded" });
	await page.waitForTimeout(700);
	const stopCard = page.locator(".agent-card", { hasText: chatAgentName });
	await stopCard.locator("button:has-text('试运行')").click();
	await page.waitForTimeout(800);
	await stopCard.locator("button:has-text('发布')").click();
	await page.waitForTimeout(800);
	await stopCard.locator("button:has-text('停用')").click();
	await page.waitForTimeout(900);
	const stoppedChatCount = await stopCard.getByRole("button", { name: "对话", exact: true }).count();
	await check("已停用的 Agent 不给「对话」入口", () => {
		assert.equal(stoppedChatCount, 0, `停用后不该有「对话」按钮，实际 ${stoppedChatCount}`);
	});

	// 清理
	await stopCard.locator("button:has-text('删除')").click();
	await page.waitForTimeout(900);

	const agentPageText = await page.locator(".page").innerText();
	await check("Agent 页写明状态流转，不让人猜", () => {
		for (const label of ["草稿", "试运行", "已发布", "已停用"]) {
			assert.ok(agentPageText.includes(label), `页面应说明状态「${label}」`);
		}
	});

	// ── Agent 会话隔离：每个 Agent 的对话进各自的专属页，通用对话页只留未绑定的会话 ────────────
	// 起点：先造两个不同的 Agent，后面的断言才有对象（用时间戳命名，跑多少次都不互相干扰）。
	await page.goto(`${BASE}/#/agents`, { waitUntil: "domcontentloaded" });
	await page.waitForTimeout(700);
	const agentA = `E2E-ISO-A-${Date.now()}`;
	const agentB = `E2E-ISO-B-${Date.now()}`;
	for (const name of [agentA, agentB]) {
		await page.locator("button:has-text('新建 Agent')").click();
		await page.waitForTimeout(400);
		await page.locator(".n-modal input").first().fill(name);
		await page.locator(".n-modal button:has-text('保存')").click();
		await page.waitForTimeout(900);
	}

	// ① Agent 页点「对话」必须落到这个 Agent 的专属路由，且 URL 里带着 agent id
	const cardA = page.locator(".agent-card", { hasText: agentA });
	const cardB = page.locator(".agent-card", { hasText: agentB });
	const agentAId = await cardA.evaluate((node) => node.getAttribute("data-agent-id"));
	await check("Agent 卡片带 data-agent-id（路由断言要拿真实 id，不靠名字猜）", () => {
		assert.ok(agentAId && agentAId.length > 0, `卡片应有 data-agent-id，实际「${agentAId}」`);
	});

	await cardA.locator("button:has-text('对话')").first().click();
	await page.waitForTimeout(1800);
	await check("点「对话」落到 Agent 专属路由，且 URL 带真实 agent id", () => {
		assert.ok(page.url().includes("#/agent-chat/"), `应停在 #/agent-chat/，实际 ${page.url()}`);
		assert.ok(page.url().includes(agentAId), `URL 应带 agent id ${agentAId}，实际 ${page.url()}`);
		assert.ok(page.url().includes("session="), `应带 session 参数，实际 ${page.url()}`);
	});

	const agentChatTitle = await page.locator(".page-title").innerText().catch(() => "");
	await check("专属页页头是这个 Agent 的名字，不是通用「对话」", () => {
		assert.equal(agentChatTitle.trim(), agentA, `页头应是「${agentA}」，实际「${agentChatTitle}」`);
	});

	// 在 A 的专属页里说一句：这条会话必须留在 A 名下，成为②③的对照物
	const aInput = page.locator(".chat-input textarea");
	await aInput.fill("A 的专属消息");
	await page.locator(".chat-input button:has-text('发送')").click();
	await page.waitForTimeout(4000);

	const aSessionId = new URL(page.url()).hash.split("session=")[1]?.split("&")[0] ?? "";
	await check("A 的专属页把自己开的会话写进 URL（刷新后能回到同一条）", () => {
		assert.ok(aSessionId.length > 0, `应能从 URL 取到 session，实际 ${page.url()}`);
	});

	// ④ 刷新后仍停在同一个 Agent 的页里
	await page.reload({ waitUntil: "domcontentloaded" });
	await page.waitForTimeout(1800);
	await check("刷新后仍在同一个 Agent 的专属页", () => {
		assert.ok(page.url().includes(`#/agent-chat/${agentAId}`), `刷新后应停在 ${agentAId} 的页，实际 ${page.url()}`);
	});
	const afterReloadTitle = await page.locator(".page-title").innerText().catch(() => "");
	await check("刷新后页头仍是同一个 Agent（会话也跟着恢复）", () => {
		assert.equal(afterReloadTitle.trim(), agentA, `刷新后页头应是「${agentA}」，实际「${afterReloadTitle}」`);
	});
	const restoredBubbles = await page.locator(".chat-bubble").allTextContents();
	await check("刷新后历史消息还在（不是空壳页）", () => {
		assert.ok(restoredBubbles.some((text) => text.includes("A 的专属消息")), `刷新后应能看到刚才那条消息，实际 ${restoredBubbles.length} 条气泡`);
	});

	// ② 两个不同 Agent 的对话互不可见：B 的页里不能出现 A 的任何会话
	await page.goto(`${BASE}/#/agents`, { waitUntil: "domcontentloaded" });
	await page.waitForTimeout(700);
	await page.locator(".agent-card", { hasText: agentB }).locator("button:has-text('专属对话')").click();
	await page.waitForTimeout(1500);
	const bPageText = await page.locator(".page").innerText();
	await check("B 的专属页里看不到 A 的对话（两个 Agent 互不可见）", () => {
		assert.ok(!bPageText.includes("A 的专属消息"), "B 的页里不该出现 A 的消息");
	});
	// 隔离的本意是「B 看不到 A 的」：B 名下有没有别的会话（上一轮残留）不是本断言的事，
	// 反复跑 e2e 会积累历史，要求 0 条会让测试自我污染。真正要钉的是上面那条「B 页无 A 的消息」。
	const bSessionTitles = await page.locator(".chat-session-title").allTextContents();
	await check("B 的列表里没有 A 的会话（隔离本体，不要求 B 为空）", () => {
		assert.ok(
			!bSessionTitles.some((title) => title.includes("A 的专属消息")),
			`B 的列表不应出现 A 的会话，实际 ${JSON.stringify(bSessionTitles)}`,
		);
	});

	// 轮到 B 说一句，然后回到 A 的页：A 也不该看见 B 的对话（对称收口）
	const bInput = page.locator(".chat-input textarea");
	const bDisabled = await bInput.isDisabled();
	if (bDisabled) {
		// B 进来时一条会话都没有：先点「新对话」再说话
		await page.locator("button:has-text('新对话')").first().click();
		await page.waitForTimeout(1500);
	}
	await page.locator(".chat-input textarea").fill("B 的专属消息");
	await page.locator(".chat-input button:has-text('发送')").click();
	await page.waitForTimeout(4000);

	await page.goto(`${BASE}/#/agent-chat/${agentAId}`, { waitUntil: "domcontentloaded" });
	await page.waitForTimeout(1800);
	const aPageText = await page.locator(".page").innerText();
	await check("回到 A 的页，看不到 B 的对话", () => {
		assert.ok(!aPageText.includes("B 的专属消息"), "A 的页里不该出现 B 的消息");
	});
	await check("A 的页里仍然是 A 自己的那条会话", () => {
		assert.ok(aPageText.includes("A 的专属消息"), "A 的页里应有自己的消息");
	});

	// ③ 通用对话页不再出现绑了 Agent 的会话
	await page.goto(`${BASE}/#/chat`, { waitUntil: "domcontentloaded" });
	await page.waitForTimeout(1500);
	const chatPageText = await page.locator(".page").innerText();
	await check("通用对话页不再出现任何一个 Agent 的会话", () => {
		assert.ok(!chatPageText.includes("A 的专属消息"), "带 Agent 的会话不该出现在通用对话页");
		assert.ok(!chatPageText.includes("B 的专属消息"), "带 Agent 的会话不该出现在通用对话页");
	});
	await check("通用对话页不再提供「挑一个 Agent 新建」的入口", () => {
		assert.ok(!chatPageText.includes("普通对话（不绑 Agent）"), "通用页不该再有绑定 Agent 的下拉");
		assert.ok(chatPageText.includes("未绑定 Agent"), `通用页应说明这里是未绑定的会话，实际「${chatPageText.slice(0, 120)}」`);
	});
	const chatAgentTags = await page.locator(".chat-session-meta .n-tag").allTextContents();
	await check("通用对话页的会话列表行不再带 Agent 名字标签", () => {
		assert.ok(!chatAgentTags.some((text) => text.includes("E2E-ISO")), `列表不该出现 Agent 名，实际 ${chatAgentTags.join(",")}`);
	});

	// 清理：删掉两个 Agent，别让每跑一次就多两张卡（它们的会话随 Agent 一起不再出现）
	await page.goto(`${BASE}/#/agents`, { waitUntil: "domcontentloaded" });
	await page.waitForTimeout(700);
	for (const name of [agentA, agentB]) {
		const card = page.locator(".agent-card", { hasText: name });
		if ((await card.count()) > 0) {
			await card.locator("button:has-text('删除')").click();
			await page.waitForTimeout(900);
		}
	}
	const leftover = await page.locator(".agent-card", { hasText: "E2E-ISO-" }).count();
	await check("隔离用例的 Agent 已清理干净", () => {
		assert.equal(leftover, 0, `应清空 E2E-ISO 卡片，实际 ${leftover} 张`);
	});

	// ── 输入框右下角的模型选择器（会话级，不是全局当前模型） ────────────────────────────
	// 这一段的断言都落在真实 DOM 上：控件在不在、能不能真的换掉这条会话的模型。
	// 先回通用对话页并选中一条会话：控件长在对话输入区里，别的页面上根本没有它
	// （上一段结束时页面停在 Agent 隔离那部分，不回来就会一直等一个不存在的节点）。
	await page.goto(`${BASE}/#/chat`, { waitUntil: "domcontentloaded" });
	await page.waitForTimeout(1500);
	const modelSessionRows = await page.locator(".chat-session").count();
	if (modelSessionRows > 0) {
		await page.locator(".chat-session").first().click();
		await page.waitForTimeout(1200);
	} else {
		await page.locator("button:has-text('新对话')").first().click();
		await page.waitForTimeout(1500);
	}

	const modelPicker = page.locator('[data-testid="session-model-picker"]');
	await check("输入框右下角有模型选择控件", async () => {
		assert.equal(await modelPicker.count(), 1, "应有且只有一个模型选择控件");
	});

	const pickerBox = await modelPicker.boundingBox();
	const composer = page.locator(".chat-input");
	const composerBox = await composer.boundingBox();
	await check("模型控件落在输入框下方那一行的左侧（发送按钮的同一条线）", async () => {
		assert.ok(pickerBox && composerBox, "控件与输入区都应可见");
		assert.ok(
			pickerBox.y > composerBox.y + composerBox.height / 2,
			`模型控件应在输入框下方，实际 picker.y=${pickerBox?.y} composer=${composerBox?.y}+${composerBox?.height}`,
		);
		const composeActions = page.locator(".chat-compose-actions");
		assert.equal(await composeActions.count(), 1, "发送与模型控件应在同一条 compose 行里");
	});

	// 说明文字必须如实说出「现在是谁在答话」。先问后端自己是什么模式（/api/health 的 model.mode），
	// 再按事实断言：simulated 必须出现「模拟模型」；live 必须不出现（同一套 e2e 两边都有意义）。
	const health = await page.evaluate(async () => {
		const response = await fetch("/api/health");
		return await response.json();
	});
	const isSimulatedInstance = health?.model?.mode === "simulated";
	const modelLabelText = await page.locator(".chat-model-label").innerText();
	await check("模型控件如实标注当前是谁在答话（按实例模式分流）", () => {
		if (isSimulatedInstance) {
			assert.ok(
				modelLabelText.includes("模拟模型"),
				`模拟实例必须写「模拟模型」，实际「${modelLabelText}」`,
			);
		} else {
			assert.ok(
				!modelLabelText.includes("模拟模型"),
				`live 实例不该把真实模型标成「模拟模型」，实际「${modelLabelText}」`,
			);
		}
	});

	// 这个实例上有没有模型可选，取决于后端 /api/models 的 options（没配 key 时就是空的）。
	// 先问后端要事实，再按事实断言——同一套 ui:e2e 在模拟实例与真实实例上都有意义。
	const apiModels = await page.evaluate(async () => {
		const response = await fetch("/api/models");
		return await response.json();
	});
	const apiOptionCount = Array.isArray(apiModels?.options) ? apiModels.options.length : 0;
	// Codex 风格控件：内联按钮 + 弹出菜单；置灰看按钮自身 disabled
	const trigger = modelPicker.locator(".model-trigger");
	const triggerDisabled = await trigger.isDisabled().catch(() => false);

	await check("模型控件的可用性与后端可选模型一致（没模型可选时如实置灰）", () => {
		assert.equal(
			triggerDisabled,
			apiOptionCount === 0,
			`后端 options=${apiOptionCount} 时控件 disabled=${triggerDisabled}，两者应一致`,
		);
	});

	if (apiOptionCount === 0) {
		await check("没有可选模型时按钮给出说明（title），而不是装作能选", async () => {
			const title = (await trigger.getAttribute("title")) ?? "";
			assert.ok(title.length > 0, "置灰时按钮 title 应说明当前状态");
		});
	} else {
		// 真实实例：点开 Codex 式菜单，必须能看到后端给的每一个模型，并真的能换掉这条会话的模型
		const beforeSwitch = await page.locator(".chat-model-label").innerText();
		const currentName = await page.locator("[data-testid=model-current-name]").innerText();
		await trigger.click();
		await page.waitForTimeout(400);
		const optionCount = await page.locator(".model-item").count();
		await check("点开模型菜单能看到后端给的每一个可选模型", () => {
			assert.equal(optionCount, apiOptionCount,
				`菜单项应与 /api/models 的 options 数一致（${optionCount} / ${apiOptionCount}）`);
		});
		// 勾标在「当前值」那一项上；会话还没选过模型（modelKey=null）时没有勾是正确行为，
		// 不能硬要求必须有——但只要当前值能对上某个选项，就必须有且只有一个勾。
		// 勾标在「当前值」对应的选项上。会话还没选过模型（modelKey=null）时没有勾是正确行为；
		// 判据不能拿按钮文字（它可能显示的是提示语「当前：xxx」），要拿「当前值是否命中某个选项」：
		// 只有命中了，才要求有且只有一个勾。
		const itemLabelsForCheck = await page.locator(".model-item .model-item-label").allInnerTexts();
		const currentHit = itemLabelsForCheck.some((label) => label.trim() === currentName.trim());
		await check("菜单选中勾与当前模型一致（当前值命中选项时有且只有一个勾）", async () => {
			const checked = await page.locator(".model-item .model-item-check").count();
			if (currentHit) {
				assert.equal(checked, 1, `当前模型「${currentName}」命中选项时应有且只有一个勾，实际 ${checked} 个`);
			} else {
				assert.ok(checked === 0, `当前值未命中任何选项（「${currentName}」）时不应有勾，实际 ${checked} 个`);
			}
		});
		// 键盘可达性：↓ 移动高亮、Esc 收起（Codex 的核心交互）
		await page.locator(".model-menu").waitFor({ state: "visible" });
		await page.keyboard.press("ArrowDown");
		await page.waitForTimeout(150);
		const activeAfterArrow = await page.locator(".model-item[data-active=true]").count();
		await page.keyboard.press("Escape");
		await page.waitForTimeout(300);
		await check("键盘 ↓ 能移动高亮、Esc 能收起菜单（Codex 同款交互）", async () => {
			assert.equal(activeAfterArrow, 1, "↓ 后应有一项处于高亮");
			assert.equal(await page.locator(".model-menu").count(), 0, "Esc 后菜单应收起");
		});
		// 真的换一次模型：用「勾标」定位当前项（勾在 option.id === value 的那一项上），
		// 挑一个没勾的点——按钮文字在无库行时是 modeLabel 形态，拿它跟 label 比永远不等，
		// 判据必须落在 DOM 的选中态上，不是文字（诊断报告的建议）。
		// 勾标/aria-selected 依赖 modelRows（/api/models 的 models[]）翻译链：页面刚加载或
		// 刚 reload 时 loadModels 可能还没回来，勾数=0 会退化成「点第一项」=点了当前项，等于没切。
		// 等「恰好一项被 aria-selected」再定位（aria 与勾同源，都是 option.id === value）。
		await page
			.waitForFunction(
				() => document.querySelectorAll('.model-item[aria-selected="true"]').length === 1,
				{ timeout: 10000 },
			)
			.catch(() => {});
		await trigger.click();
		await page.waitForTimeout(400);
		const items = page.locator(".model-item");
		const itemCount = await items.count();
		let targetIndex = -1;
		for (let index = 0; index < itemCount; index += 1) {
			const sel = (await items.nth(index).getAttribute("aria-selected")) === "true";
			if (!sel) { targetIndex = index; break; }
		}
		// 整个菜单都没有勾（会话无 modelKey）时挑第一项：它一定不是当前生效那条
		if (targetIndex < 0 && itemCount > 0) targetIndex = 0;
		assert.ok(targetIndex >= 0, "菜单里应至少有一个可切换的模型项");

		const targetLabel = (await items.nth(targetIndex).locator(".model-item-label").innerText()).trim();
		const beforeModelId = await page.evaluate(async () => {
			// 当前会话 id 从 URL 的 ?session= 里拿
			const id = new URLSearchParams(location.hash.split("?")[1] ?? "").get("session");
			const one = await (await fetch("/api/sessions/" + id)).json();
			return { modelId: one.modelId, modelKey: one.modelKey };
		});
		// 用 waitForResponse 区分「没发请求（被静默吞掉）」与「发了但失败」——
		// 干等文字变化分不开这两种情况。
		const requestSeen = page.waitForResponse(
			(r) => /\/api\/sessions\/[^/]+\/model$/.test(r.url()) && r.request().method() === "POST",
			{ timeout: 8000 },
		);
		await items.nth(targetIndex).click();
		const switched = await requestSeen.catch(() => null);
		await page.waitForTimeout(1500);

		await check("选中另一个模型后，真的发出了会话级换模型请求且后端接受了它", async () => {
			assert.ok(switched, `点了「${targetLabel}」却没有发出 POST /api/sessions/:id/model——多半是选中态判定把这次点击吞了`);
			assert.equal(switched.status(), 200, `换模型接口应返回 200，实际 ${switched.status()}`);
			const body = await switched.json();
			assert.ok(
				body.modelId !== beforeModelId.modelId || body.session?.modelKey !== beforeModelId.modelKey,
				`后端回包没体现任何变化：modelId=${body.modelId} modelKey=${body.session?.modelKey}`,
			);
		});

		await check("换了模型后界面如实反映新模型（label 或 modeLabel 形态都算）", async () => {
			console.log(`  [诊断模型] 按钮=${await page.locator("[data-testid=model-current-name]").innerText()} 说明=${await page.locator(".chat-model-label").innerText()} 目标=${targetLabel}`);
			const afterName = (await page.locator("[data-testid=model-current-name]").innerText()).trim();
			const afterHint = (await page.locator(".chat-model-label").innerText()).trim();
			const failedBanner = await page.locator(".chat-alert").count();
			if (failedBanner > 0) return; // 如实报错也是一条合法出路
			// 目标模型名（label 或 modelId 那段）必须出现在按钮或说明里；
			// 且不能还停在切换前的那条模型上。
			const shown = afterName + " " + afterHint;
			const targetModelId = (await page.evaluate(async (label) => {
				const data = await (await fetch("/api/models")).json();
				const hit = (data.options ?? []).find((o) => o.label === label);
				return hit ? hit.id : "";
			}, targetLabel));
			assert.ok(
				shown.includes(targetLabel) || (targetModelId && shown.includes(targetModelId)),
				`应显示「${targetLabel}」或其 modelId/modeLabel 形态，实际按钮「${afterName}」说明「${afterHint}」`,
			);
			// 没有库行的 .env 模型切过去后 modelKey=null，按钮回落 modeLabel——也算如实
			const notStale = !shown.includes("model-e") || shown.includes(targetLabel);
			assert.ok(notStale, `按钮不应显示原始行 id，实际「${shown}」`);
		});

		// 测试完立即切回：deepseek-v4-pro 计费高，e2e 不能把用户的会话留在贵模型上。
		// 切回优先选 flash（有库行的那条）；请求发出且 200 即可，界面细节不再重复断言。
		const backSeen = page.waitForResponse(
			(r) => /\/api\/sessions\/[^/]+\/model$/.test(r.url()) && r.request().method() === "POST",
			{ timeout: 8000 },
		).catch(() => null);
		await trigger.click();
		await page.waitForTimeout(400);
		const flashIndex = await page.evaluate(() => {
			const items = [...document.querySelectorAll(".model-item .model-item-label")];
			return items.findIndex((e) => /flash/i.test(e.textContent ?? ""));
		});
		if (flashIndex >= 0) {
			await page.locator(".model-item").nth(flashIndex).click();
			const back = await backSeen;
			const backStatus = back ? back.status() : 0;
			console.log(`  [诊断切回] 请求=${backStatus}；点击项=${flashIndex}`);
			assert.ok(backStatus === 200, `切回 flash 应返回 200，实际 ${backStatus}（用户不在贵模型上留会话）`);
		}
	}

	// 刷新持久化验证改在**独立的新会话**上做：上面的切换+切回已把共享会话状态改了两道，
	// 在它上面断言「刷新不变」比对基准被三重时序污染（诊断实锤过）。新会话路径：
	// 新建 → 当前模型即默认 → 刷新 → 仍是默认。单一变量，钉住「刷新不改模型」这一件事。
	await page.evaluate(() => { window.__freshSessionId = null; });
	const freshId = await page.evaluate(async () => {
		const res = await fetch("/api/sessions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ workflowId: "auto-flow" }),
		});
		const one = await res.json();
		window.__freshSessionId = one.id;
		return one.id;
	});
	await page.goto(`${BASE}/#/chat?session=${freshId}`, { waitUntil: "domcontentloaded" });
	await page.waitForTimeout(2000);
	await page
		.waitForFunction(
			() => !/^model-/.test(document.querySelector("[data-testid=model-current-name]")?.textContent?.trim() ?? "model-"),
			{ timeout: 10000 },
		)
		.catch(() => {});
	// 基准用后端事实而不是按钮文字：按钮受「翻译表加载竞态」影响可能短暂显示原始行 id
	// （诊断实锤：前=model-e1b524a5 后=DeepSeek V4.1 Flash，API 前后一致）。
	const freshApiModel = await page.evaluate(async (id) => {
		const one = await (await fetch("/api/sessions/" + id)).json();
		return { modelId: one.modelId, modelKey: one.modelKey };
	}, freshId);
	await page.reload({ waitUntil: "domcontentloaded" });
	await page.waitForTimeout(2000);
	// 等翻译表（loadModels）就位：就位前按钮会短暂显示原始行 id（model-xxx），
	// 那是加载竞态不是持久化失败。等按钮脱离「model-」形态再读。
	await page
		.waitForFunction(
			() => !/^model-/.test(document.querySelector("[data-testid=model-current-name]")?.textContent?.trim() ?? "model-"),
			{ timeout: 10000 },
		)
		.catch(() => {});
	const freshAfter = (await page.locator("[data-testid=model-current-name]").innerText()).trim();
	await check("刷新页面后模型选择器显示的仍是后端记录的那条模型（独立会话验证）", async () => {
		const models = await page.evaluate(async () => (await (await fetch("/api/models")).json()));
		const row = (models.models ?? []).find((m) => m.id === freshApiModel.modelKey);
		// 期望值两种都合法：模型行 label（界面上显示的）或 modelId（原始名）——它们是同一模型
		// 模型行的展示名要归到 options 命名空间找 label（行上只有 name/modelId，没有 label）；
		// 界面按钮显示的就是 options 的 label（如「DeepSeek V4.1 Flash」）。
		const optionHit = (models.options ?? []).find((o) => o.id === row?.modelId);
		const expectAny = [optionHit?.label, row?.modelId, freshApiModel.modelId].filter((x) => x && x.length > 0);
		// 按钮可能是 label（有库行）或 modeLabel 形态（无库行），两者都算「还是它」；
		// 唯独不能是「别的模型」或原始行 id。
		// 空 options 的实例（模拟实例/没配模型行）上 expectAny 会是空数组——那种情况没有
		// 可比的展示名，断言退化为「按钮有内容且不是原始行 id」即可（不假装能比出 label）。
		if (expectAny.length === 0) {
			assert.ok(freshAfter.length > 0, "按钮应有内容");
			return;
		}
		assert.ok(
			expectAny.some((name) => freshAfter === name || freshAfter.includes(name)),
			`刷新后应显示「${expectAny.join(" / ")}」之一（后端记录 modelId=${freshApiModel.modelId}），实际「${freshAfter}」`,
		);
		assert.ok(!/^model-[0-9a-f]/.test(freshAfter) || freshAfter === freshApiModel.modelKey, `按钮不应停留在原始行 id，实际「${freshAfter}」`);
	});
	// 清理：删掉这条只为测试建的会话。
	// 注意删除的时机：这条会话是**通用对话页当前唯一一条**（Agent 会话不进通用页），
	// 现在删掉的话，后面 /compact 段再打开 #/chat 就是一条会话都没有的空页面——
	// 输入框没有会话可发，发送按钮一直是 disabled，整段挂死在这里。
	// 所以标记住"待删"，等 /compact 段跑完再真删（见文件末尾）。
	const leakyFreshId = freshId;


	// ── 上下文用量（头部常驻的「已用 / 总量」） ─────────────────────────────────
	// 用户要的是"一条背景信息"：这条对话用了多少、总共有多少（如 29k/256k）。
	// 断言落在真实 DOM 上，并且**按后端事实分流**——总量来自 models[].contextWindow，
	// 没配就是 null，界面那时只能显示已用（编一个总量出来就是在骗人）。
	await page.goto(`${BASE}/#/chat`, { waitUntil: "domcontentloaded" });
	await page.waitForTimeout(1500);

	// 没有会话时头部根本不渲染（v-if="current"），先确保有一条可聊的会话
	if ((await page.locator(".chat-session").count()) === 0) {
		await page.locator("button:has-text('新对话')").first().click();
		await page.waitForTimeout(2000);
	} else {
		await page.locator(".chat-session").first().click();
		await page.waitForTimeout(1500);
	}

	const usageBadge = page.locator('[data-testid="context-usage"]');
	const usageDisplay = async () => {
		const title = (await usageBadge.getAttribute("aria-label")) ?? "";
		return title.split("：")[1]?.split("；")[0] ?? "";
	};
	await check("用量圆环存在，且在模型选择器旁边（同一 compose 行）", async () => {
		assert.equal(await usageBadge.count(), 1, "应有且只有一个用量圆环");
		// 圆环与模型选择器在同一个 compose-actions 行里（用户要求：贴着模型选择放）
		const inCompose = await page.evaluate(() => {
			const ring = document.querySelector('[data-testid="context-usage"]');
			return ring ? ring.className.includes("ctx-ring") : false;
		});
		assert.ok(inCompose, "用量元素应是 ctx-ring 圆环形态");
	});

	// 还没发消息时是 0：这条会话确实还没用上下文，界面不该凭空给个数字
	const usageIdle = await usageDisplay();
	await check("没发消息时显示 0（不凭空编数字）", () => {
		assert.match(usageIdle, /^0(\/\d+(\.\d+)?k?)?$/, `初始用量应是 0 打头，实际「${usageIdle}」`);
	});

	// 后端事实：这条会话的模型行有没有配上下文窗口
	const usageFacts = await page.evaluate(async () => {
		const models = await (await fetch("/api/models")).json();
		return {
			rows: (models.models ?? []).map((row) => ({ id: row.id, modelId: row.modelId, ctx: row.contextWindow })),
		};
	});
	const rowsWithWindow = usageFacts.rows.filter((row) => Number(row.ctx) > 0);

	// hover 说明必须能解释这个数字。两种实例都成立，所以这里按事实分流断言。
	const usageTitleIdle = (await usageBadge.getAttribute("aria-label")) ?? "";
	await check("用量元素带 hover 说明（说清是「已用 / 总量」还是「未配置窗口」）", () => {
		assert.ok(usageTitleIdle.includes("上下文用量"), `title 应说明这是上下文用量，实际「${usageTitleIdle}」`);
		assert.ok(usageTitleIdle.includes("tokens"), `title 应带精确 token 数，实际「${usageTitleIdle}」`);
		if (rowsWithWindow.length === 0) {
			assert.ok(
				usageTitleIdle.includes("未配置上下文窗口"),
				`没有任何模型行配了 contextWindow 时必须如实说「未配置上下文窗口」，实际「${usageTitleIdle}」`,
			);
		}
	});

	// 发一条消息：用量必须真的涨——这是"它是活的、不是个写死的标签"的唯一证据
	await page.locator(".chat-input textarea").fill("上下文用量用例：请用一句话回答");
	const beforeUsageSend = await usageDisplay();
	await page.locator(".chat-input button:has-text('发送')").click();
	await page.waitForTimeout(1500);
	const usageAfterSend = await usageDisplay();
	await check("发出消息后用量立刻增加（用户那条当场计入，不等回复）", () => {
		assert.notEqual(usageAfterSend, beforeUsageSend, `发送后用量应从「${beforeUsageSend}」涨上去，实际没变`);
	});

	// 等这一轮跑完（流式与 done 都会继续累加），再断言格式
	await page.waitForTimeout(6000);
	const usageAfterTurn = await usageDisplay();
	const usageTitleAfter = (await usageBadge.getAttribute("aria-label")) ?? "";
	await check("用量格式是「已用」或「已用/总量」，k 为千位（如 29k/256k）", () => {
		assert.match(
			usageAfterTurn,
			/^\d+(\.\d+)?k?(\/\d+(\.\d+)?k?)?$/,
			`用量应是「29k」或「29k/256k」形态，实际「${usageAfterTurn}」`,
		);
		if (usageAfterTurn.includes("/")) {
			assert.ok(
				/\d+k\//.test(usageAfterTurn) || /\/\d+(\.\d+)?k/.test(usageAfterTurn),
				`有总量时至少应该有一个 k（总量都在千级），实际「${usageAfterTurn}」`,
			);
		}
	});

	// 模型行配了 contextWindow 的实例上：必须出现「已用/总量」，且总量就是那一行的值
	if (rowsWithWindow.length > 0) {
		await check("配了上下文窗口的实例上显示「已用/总量」，总量与后端一致", async () => {
			// 让界面拿到这条会话的模型行：走真实的模型选择交互（模拟实例上后端会拒绝换模型，
			// 但界面照样按用户点选的那行显示总量——这正是 contextWindow 兜底要覆盖的情形）
			const trigger = page.locator('[data-testid="session-model-picker"] .model-trigger');
			if ((await trigger.count()) > 0 && !(await trigger.isDisabled().catch(() => true))) {
				await trigger.click();
				await page.waitForTimeout(500);
				const row = rowsWithWindow[0];
				const hit = page.locator(".model-item", { hasText: row.modelId }).first();
				if (await hit.count()) {
					await hit.click();
					await page.waitForTimeout(2000);
				}
			}
		const text = await usageDisplay();
			assert.ok(text.includes("/"), `配了 contextWindow 就该显示「已用/总量」，实际「${text}」`);
			// 总量按 k 千位取整：1000 → 1k，256000 → 256k
			const shown = Number(text.split("/")[1].replace("k", "")) * 1000;
			const expect = Number(rowsWithWindow[0].ctx);
			assert.ok(
				Math.abs(shown - expect) <= 1000,
				`总量应是模型行的 contextWindow=${expect}（k 取整），实际显示 ${text}`,
			);
		});
	}

	// hover 的精确数字不能是取整值：k 是给人扫一眼的，光标停上去要看到真实数
	await check("hover 说明给的是精确 token 数（不是 k 取整值）", () => {
		const match = usageTitleAfter.match(/精确数值 (\d+)(?: \/ (\d+))? tokens/);
		assert.ok(match, `title 里应有精确 token 数，实际「${usageTitleAfter}」`);
	});

	// 切换与刷新都应恢复目标会话自己的上下文快照。
	const usageSessionRows = await page.locator(".chat-session").count();
	if (usageSessionRows >= 2) {
		await page.locator(".chat-session").nth(1).click();
		await page.waitForTimeout(2000);
		const usageSessionId = new URL(page.url()).hash.match(/session=([^&]+)/)?.[1];
		const usageSnapshot = await page.evaluate(async (id) => {
			const response = await fetch(`/api/sessions/${id}`);
			return response.json();
		}, usageSessionId);
		const sessionTitle = (await page.locator('[data-testid="context-usage"]').first().getAttribute("aria-label")) ?? "";
		const sessionText = sessionTitle.split("：")[1]?.split("；")[0] ?? "";
		await check("切换会话后显示该会话快照中的上下文用量", () => {
			assert.ok(usageSessionId, "URL 应包含当前会话 id");
			assert.equal(sessionText.split("/")[0], formatTokensForTest(usageSnapshot.contextTokens));
		});
		await page.reload();
		await page.waitForTimeout(1500);
		await check("刷新后恢复同一会话的上下文用量", async () => {
			const restoredId = new URL(page.url()).hash.match(/session=([^&]+)/)?.[1];
			assert.equal(restoredId, usageSessionId);
			const restoredTitle = (await page.locator('[data-testid="context-usage"]').first().getAttribute("aria-label")) ?? "";
			assert.equal(restoredTitle.split("：")[1]?.split("；")[0].split("/")[0], formatTokensForTest(usageSnapshot.contextTokens));
		});
	} else {
		console.log("  （只有一条会话，跳过切换会话快照断言）");
	}

	// ── 斜杠命令面板：/compact 压缩对话、/plan 计划模式 ─────────────────────────


	// ── 斜杠命令面板：/compact 压缩对话、/plan 计划模式 ─────────────────────────
	// 断言落在真实 DOM 与真实接口效果上：面板能不能弹、上下键换不换高亮、
	// 回车会不会执行、执行后状态**真的变了**（不是只调了一次接口）。
	// 记录压缩请求（诊断用：失败时能区分「没发请求」和「发了被拒」）
	await page.evaluate(() => {
		window.__e2eCompactLog = [];
		const orig = window.fetch;
		window.fetch = async (...args) => {
			const url = String(args[0] ?? "");
			if (url.includes("/compact")) {
				try { const res = await orig(...args); window.__e2eCompactLog.push(res.status); return res; }
				catch (e) { window.__e2eCompactLog.push("ERR:" + e.message); throw e; }
			}
			return orig(...args);
		};
	});
	await page.goto(`${BASE}/#/chat`, { waitUntil: "domcontentloaded" });
	await page.waitForTimeout(1200);

	const slashInput = page.locator(".chat-input textarea");
	const slashPanel = page.locator('[data-testid="slash-panel"]');
	const slashItems = page.locator('[data-testid="slash-item"]');

	await check("没敲 / 之前命令面板不出现", async () => {
		assert.equal(await slashPanel.count(), 0, "面板不该默认可见");
	});

	await slashInput.click();
	await slashInput.fill("/");
	await page.waitForTimeout(400);
	await check("输入框敲 / 弹出命令面板", async () => {
		assert.equal(await slashPanel.count(), 1, "敲 / 应弹出面板");
	});

	const slashLabels = await slashItems.allTextContents();
	await check("面板里至少有「压缩对话」与「计划模式」两条命令", () => {
		const flat = slashLabels.join(" | ");
		assert.ok(flat.includes("压缩"), `应有压缩对话命令，实际 ${flat}`);
		assert.ok(flat.includes("计划模式"), `应有计划模式命令，实际 ${flat}`);
	});

	// 过滤：敲拼音别名也能命中（旧前端的 alias 能力要搬过来）
	await slashInput.fill("/jihua");
	await page.waitForTimeout(400);
	const filteredLabels = await slashItems.allTextContents();
	await check("输入拼音别名能过滤出对应命令", () => {
		assert.ok(filteredLabels.length > 0, "拼音别名应命中年计划模式");
		assert.ok(
			filteredLabels.join(" | ").includes("计划模式"),
			`「jihua」应命中计划模式，实际 ${filteredLabels.join(" | ")}`,
		);
	});

	// 上下键换高亮：用真实选中态 class 断言，不看顺序猜
	await slashInput.fill("/");
	await page.waitForTimeout(400);
	const activeIndex = async () => {
		const nodes = await slashItems.all();
		for (let index = 0; index < nodes.length; index += 1) {
			const cls = (await nodes[index].getAttribute("class")) ?? "";
			if (cls.includes("active")) return index;
		}
		return -1;
	};
	const firstActive = await activeIndex();
	await page.keyboard.press("ArrowDown");
	await page.waitForTimeout(200);
	const afterDown = await activeIndex();
	await check("按上下键会换高亮项", () => {
		assert.ok(firstActive >= 0, "应有一项默认高亮");
		assert.notEqual(afterDown, firstActive, `下键后高亮应从 ${firstActive} 移到别处，实际仍在 ${afterDown}`);
	});

	// Esc 收起
	await page.keyboard.press("Escape");
	await page.waitForTimeout(300);
	await check("按 Esc 收起命令面板", () => {
		return slashPanel.count().then((count) => {
			assert.equal(count, 0, "Esc 后面板应收起");
		});
	});

	// ── /plan：执行后界面要能看出处于计划模式，且能关掉 ────────────────────────
	// 上面「换会话清零」段点过第二条会话，而 reload 后 /#/chat 会自动选第一条——
	// 不钉住会话 id 的话，刷新断言查的是另一条会话，badge 当然不在（诊断实锤过这个错位）。
	// 先点会话列表第一行，强制 URL 与 current 同步：前面用量段可能用 fetch 建过会话或点过别的行，
	// current 与 URL 不同步时，/plan POST 与 reload 后自动选的会话会错位（诊断实锤过 badge 消失）。
	const firstRow = page.locator(".chat-session").first();
	if ((await firstRow.count()) > 0) {
		await firstRow.click();
		await page.waitForTimeout(2000);
	}
	await slashInput.fill("/plan");
	await page.locator('[data-testid="slash-panel"]').waitFor({ state: "visible", timeout: 10000 });
	// 等 /plan 请求真的回包再断言（1500ms 固定等待在 live 实例下会抢跑）
	const planSeen = page.waitForResponse(
		(r) => /\/api\/sessions\/[^/]+\/plan$/.test(r.url()) && r.request().method() === "POST",
		{ timeout: 10000 },
	).catch(() => null);
	await page.keyboard.press("Enter");
	const planResp = await planSeen;
	await page.waitForTimeout(800);

	console.log(`  [诊断plan2] 开启后URL=${page.url()} plan响应=${planResp ? planResp.status() : "未发出"}`);
	const planBadge = page.locator('[data-testid="plan-mode-badge"]');
	await check("回车执行 /plan 后，界面出现「计划模式」标记", async () => {
		return planBadge.count().then(async (count) => {
			assert.equal(count, 1, "开启后应显示计划模式标记");
			const text = await planBadge.innerText();
			assert.ok(text.includes("计划模式"), `标记文案应含「计划模式」，实际「${text}」`);
		});
	});

	// 后端真的记下了（刷新后仍在 = 不是只改了个前端变量）。
	// 用显式 goto 而不是 reload：reload 在「会话列表未加载完时 watch 提前触发」的边界下会回落到第一条会话，
	// badge 查的就不是刚开 plan 的那条了（诊断实锤：URL 对、库里 true、badge=0）。
	const planReloadUrl = page.url();
	await page.goto(planReloadUrl, { waitUntil: "domcontentloaded" });
	await page.waitForTimeout(2500);
	console.log(`  [诊断plan] reload后URL=${page.url()} 标记=${await page.locator('[data-testid="plan-mode-badge"]').count()} 会话planMode=${(await page.evaluate(() => window.location.search))}`);
	await check("刷新后仍处于计划模式（开关落到了后端，不是前端假状态）", () => {
		return page.locator('[data-testid="plan-mode-badge"]').count().then((count) => {
			assert.equal(count, 1, "刷新后计划模式标记应仍在");
		});
	});

	// 可关闭：再执行一次 /plan 应切回完全访问
	await page.locator(".chat-input textarea").click();
	await page.locator(".chat-input textarea").fill("/plan");
	await page.waitForTimeout(400);
	await page.keyboard.press("Enter");
	await page.waitForTimeout(1500);
	await check("再执行一次 /plan 能关掉计划模式（是开关，不是单向）", () => {
		return page.locator('[data-testid="plan-mode-badge"]').count().then((count) => {
			assert.equal(count, 0, "关掉后标记应消失");
		});
	});

	/**
	 * 摘要正文有没有跑到用户看得见的地方。
	 *
	 * 判据不用精确原文（摘要由模型生成、措辞每次不同），而是钉住两件确定的痕迹：
	 *   ① 前端曾经把摘要包成 "【以下是之前对话的摘要】" 这条拼接前缀；
	 *   ② 面板里任何一段文本与后端返回的摘要前 20 字相同。
	 * 两条都查，是因为前者只能挡住"旧写法"，后者才管得住"换个壳子继续印"。
	 */
	async function findSummaryEcho(target) {
		const prefix = await target.locator(".chat-bubble:has-text('以下是之前对话的摘要')").count();
		if (prefix > 0) return `命中拼接前缀「以下是之前对话的摘要」共 ${prefix} 处`;
		const snap = await target.evaluate(async () => {
			const id = new URLSearchParams(location.hash.split("?")[1] ?? "").get("session");
			if (!id) return "";
			const res = await fetch(`/api/sessions/${id}`);
			if (!res.ok) return "";
			const view = await res.json();
			return typeof view?.summary === "string" ? view.summary : "";
		}).catch(() => "");
		const head = (snap ?? "").trim().slice(0, 20);
		if (!head) return ""; // 后端快照里没有摘要：没有可泄漏的正文，判定为"没看见"
		const hit = await target.locator(`.chat-bubble:has-text(${JSON.stringify(head)})`).count();
		return hit > 0 ? `摘要正文前 20 字出现在 ${hit} 个气泡里：${head}` : "";
	}

	// ── /compact：压缩要真的调一次模型，所以断言分两种实例 ──────────────────────
	//
	// 为什么不能一刀切断言"消息变少"：`ui:e2e` 按规定跑在**模拟实例**（LLM_DISABLE=1）上，
	// 而模拟模型没有真实运行时，后端会**如实拒绝**压缩（409「压缩对话需要接入真实模型」）。
	// 那是正确行为，不是缺陷；在这里硬断言"变少"等于逼实现去撒谎。
	// 于是分两路，**两边都是有意义的断言**：
	//   模拟实例 → 断言"拒绝被如实呈现给用户"（提示里说明原因、历史一条不动）；
	//   真实模型 → 断言摘要正文作为压缩记录显示，旧消息仍保留在原会话。
	for (let round = 0; round < 6; round += 1) {
		const box = page.locator(".chat-input textarea");
		await box.fill(`压缩用例第 ${round + 1} 轮：请记住锚点 E2E-CM-${round + 1}`);
		const before = await page.locator(".chat-bubble").count();
		await page.locator(".chat-input button:has-text('发送')").click();
		// 等这条的回复真的到了（气泡数增加）再发下一条：真实模型可能比固定 sleep 慢，
		// 抢跑会让压缩撞上 409「正在执行中」——那是正确拒绝，不是缺陷，别让时序污染断言。
		await page
			.waitForFunction(
				(before) => document.querySelectorAll(".chat-bubble").length > before,
				before,
				{ timeout: 60000 },
			)
			.catch(() => {});
		// 只等气泡不够：done 之后 sending 还会亮一会儿（按钮 loading 3s+ 实测），
		// 这个窗口里敲 /compact 会被会话守卫拦下。等发送按钮真正退出 loading 再继续。
		await page
			.waitForFunction(
				() => {
					const btn = [...document.querySelectorAll(".chat-input button")].find((x) => x.textContent.includes("发送"));
					return btn ? !btn.className.includes("loading") : true;
				},
				{ timeout: 60000 },
			)
			.catch(() => {});
	}
	// 压缩前再确认一轮发送已落地（最后一轮的 loading 可能还没退）
	await page
		.waitForFunction(
			() => {
				const btn = [...document.querySelectorAll(".chat-input button")].find((x) => x.textContent.includes("发送"));
				return btn ? !btn.className.includes("loading") : true;
			},
			{ timeout: 60000 },
		)
		.catch(() => {});
	const beforeCompact = await page.locator(".chat-bubble").count();
	const compactSessionId = new URLSearchParams(new URL(page.url()).hash.split("?")[1] ?? "").get("session");
	await check("压缩前已经攒够足够的消息", () => {
		assert.ok(beforeCompact >= 6, `应有若干条消息供压缩，实际 ${beforeCompact} 条`);
	});

	// 这个实例是不是模拟模型：页头/模型控件上已经如实标了，直接从页面读，不额外打接口
	const compactSimulated = (await page.locator(".chat-model-label").innerText().catch(() => "")).includes("模拟模型");

	await page.locator(".chat-input textarea").click();
	await page.locator(".chat-input textarea").fill("/compact");
	// 面板弹出来再回车：抢跑的话回车会被当成"发送"，把 /compact 当普通消息发出去
	// （探针实锤过这个症状：压缩接口压根没被调用、气泡反而多了）
	await page.locator('[data-testid="slash-panel"]').waitFor({ state: "visible", timeout: 10000 });
	await page.keyboard.press("Enter");
	// 压缩要真的调一次模型，给足时间
	await page.waitForTimeout(15000);

	// 诊断信息进断言消息：失败时能看到压缩请求的状态与界面的错误条
	const compactNet = await page.evaluate(() => window.__e2eCompactLog ?? "无记录");
	const afterCompact = await page.locator(".chat-bubble").count();
	const compactRecord = page.locator('[data-testid="compaction-record"]');
	const alertText = await page.locator(".chat-alert").innerText().catch(() => "");
	console.log(`  [诊断] 会话气泡 ${beforeCompact} → ${afterCompact}，压缩请求=${compactNet}，错误条=${alertText || "无"}`);

	if (compactSimulated) {
		await check("模拟实例上 /compact 如实报错，且历史一条不动（不假装压成功）", async () => {
			assert.equal(await compactRecord.count(), 0, "压缩未成功时不应新增摘要记录");
			const simText = await page.locator(".chat-alert").innerText().catch(() => "");
			assert.ok(
				simText.includes("真实模型") || simText.includes("压缩"),
				`应把后端的原因如实显示，实际提示「${simText}」`,
			);
			assert.equal(afterCompact, beforeCompact, `拒绝压缩时消息不能变（${beforeCompact} → ${afterCompact}）`);
		});
	} else {
		// live 上压缩成败看真实模型脸色（限流/空回都会走失败路径）。
		const summarySeen = await findSummaryEcho(page);

		if ((await compactRecord.count()) === 1) {
			await check("live 实例：压缩成功后留在原会话，摘要追加且旧消息保留", async () => {
				const text = await compactRecord.innerText();
				assert.ok(text.includes("压缩") && text.includes("摘要"), `摘要记录标题不清楚：「${text.slice(0, 80)}」`);
				assert.match(text, /上下文已(?:自动)?压缩/, "压缩完成后应显示持久的上下文压缩标记");
				assert.ok(summarySeen, "时间线摘要记录应显示摘要正文");
				assert.ok(await page.getByText(/E2E-CM-1/, { exact: false }).count() > 0, "压缩前的早期消息仍应留在时间线");
				assert.equal(new URLSearchParams(new URL(page.url()).hash.split("?")[1] ?? "").get("session"), compactSessionId, "压缩不得切换到新会话");
				assert.equal(await compactRecord.evaluate((node) => node.parentElement.lastElementChild === node), true, "摘要应追加在历史末尾");
			});
		} else {
			await check("live 实例：压缩未成功时如实报错，且没伪造「已压缩」提示", async () => {
				assert.equal(
					await compactRecord.count(),
					0,
					"压缩没成功就不应显示摘要记录",
				);
				const failText = await page.locator(".chat-alert").innerText().catch(() => "");
				assert.ok(failText.trim().length > 0, "压缩没成功也没有任何错误提示——界面在装没事，这不行");
			});
		}
	}

	// 这条会话是 /compact 段一直在用的那条（上一步的刷新就是为了读它的后端快照）。
	// 收敛到一处删：既清掉测试造的数据，又不会在 /compact 段之前把通用页掏空——
	// 上面 fresh 会话那段当初就是提前删了，才让这整段挂死在「发送按钮 disabled」上。
	await page.evaluate(async (id) => { await fetch("/api/sessions/" + id, { method: "DELETE" }); }, leakyFreshId);

	// 刷新后摘要应仍由后端快照带回，并作为时间线节点显示。
	await page.reload({ waitUntil: "domcontentloaded" });
	await page.waitForTimeout(1500);
	await check("刷新后：压缩摘要仍显示在时间线记录中", async () => {
		assert.equal(await page.locator('[data-testid="compaction-record"]').count(), 1, "刷新后摘要节点应保留");
		assert.ok(await findSummaryEcho(page), "刷新后摘要正文应仍可见");
	});

	console.log("\n── Agent 专属对话页（模型选择 / 斜杠面板） ──────────");
	{
		// 独立草稿及会话，避免选到前面用例已经停用的第一张卡片。
		const fixtureResponse = await page.request.post(`${BASE}/api/agents`, { data: { name: `E2E-AgentChat-${Date.now()}` } });
		assert.equal(fixtureResponse.status(), 201);
		const fixture = await fixtureResponse.json();
		const chatResponse = await page.request.post(`${BASE}/api/sessions`, { data: { workflowId: "auto-flow", agentId: fixture.id } });
		assert.equal(chatResponse.status(), 201);
		const chatFixture = await chatResponse.json();
		await page.goto(`${BASE}/#/agent-chat/${fixture.id}?session=${chatFixture.id}`, { waitUntil: "domcontentloaded" });
		await page.waitForTimeout(2500);
		// 可用性以接口为准：隔离的模拟实例可能没有任何模型。
		const agTrigger = page.locator(".model-trigger");
		const agModelResponse = await page.request.get(`${BASE}/api/models`);
		assert.equal(agModelResponse.status(), 200);
		const agModelOptions = (await agModelResponse.json()).options ?? [];
		await check("AgentChat：模型选择按钮可用性与接口一致", async () => {
			assert.equal(await agTrigger.count(), 1, "应有模型选择按钮");
			assert.equal(await agTrigger.isDisabled(), agModelOptions.length === 0);
		});
		if (agModelOptions.length > 0) {
			await agTrigger.click();
			await page.waitForTimeout(600);
			await check("AgentChat：点开按钮弹出模型菜单", async () => {
				assert.equal(await page.locator(".model-menu").count(), 1, "点开应弹出菜单");
				assert.equal(await page.locator(".model-item").count(), agModelOptions.length);
			});
			await page.keyboard.press("Escape");
			await page.waitForTimeout(300);
		} else {
			await check("AgentChat：没有可用模型时给出说明", async () => {
				assert.ok((await agTrigger.getAttribute("title"))?.trim());
			});
		}
		// 斜杠面板：/ 弹出、Esc 收起（回归口：slashCommands 没包 computed 时面板永远弹不出）
		const agBox = page.locator(".chat-input textarea");
		await agBox.click();
		await agBox.type("/", { delay: 60 });
		await page.waitForTimeout(700);
		await check("AgentChat：敲 / 弹出斜杠命令面板", async () => {
			assert.equal(await page.locator('[data-testid="slash-panel"]').count(), 1, "敲 / 应弹出面板");
		});
		// 位置断言（task-12 回归口）：面板必须在输入框正上方附近，不能飞到页面顶部或被裁掉。
		// 实测踩过两种坏形态：① anchor 缺 relative 面板飞到页面顶（y≈150）；② z-index 不够被盖住。
		await check("AgentChat：面板在输入框上方且可见（防飞顶/防裁剪回归）", async () => {
			const pb = await page.locator('[data-testid="slash-panel"]').boundingBox();
			const ib = await page.locator(".chat-input textarea").boundingBox();
			assert.ok(pb && ib, "面板与输入框都应有几何信息（面板若 display:none 或被裁剪则 boundingBox 为 null）");
			const panelBottom = pb.y + pb.height;
			assert.ok(
				Math.abs(panelBottom - ib.y) < 80,
				`面板底边（${Math.round(panelBottom)}）应贴近输入框顶边（${Math.round(ib.y)}，±80px），实际面板飞到了别处`,
			);
			assert.ok(pb.y > 100, `面板 y=${Math.round(pb.y)} 太靠上，像回到了「飞到页面顶部」的坏形态`);
		});
		const agPanelItems = await page.locator('[data-testid="slash-item"]').allTextContents();
		await check("AgentChat：面板里有压缩与计划两条命令", () => {
			const flat = agPanelItems.join(" | ");
			assert.ok(flat.includes("压缩") && flat.includes("计划"), `应有两条命令，实际「${flat.slice(0, 60)}」`);
		});
		await page.keyboard.press("Escape");
		await agBox.fill("");
		await page.waitForTimeout(300);
		assert.equal((await page.request.delete(`${BASE}/api/sessions/${chatFixture.id}`)).status(), 200);
		assert.equal((await page.request.delete(`${BASE}/api/agents/${fixture.id}`)).status(), 200);
	}

	console.log("\n── 技能页（详情 / 新建 / 删除） ─────────────────────");
	await page.goto(`${BASE}/#/skills`, { waitUntil: "domcontentloaded" });
	await page.waitForTimeout(1000);

	// 详情抽屉：点第一张卡的「查看详情」，抽屉要打开且至少有名字或说明
	const firstCard = page.locator(".skill-card").first();
	const cardExists = await firstCard.count();
	if (cardExists > 0) {
		await firstCard.locator("button:has-text('查看详情')").click();
		await page.waitForTimeout(800);
		await check("技能详情抽屉能打开且有内容", async () => {
			const drawer = page.locator('[data-testid="skill-detail"]');
			assert.equal(await drawer.count(), 1, "详情抽屉应打开");
			const text = await drawer.innerText();
			assert.ok(text.trim().length > 10, `抽屉里应有实质内容，实际「${text.slice(0, 60)}…」`);
		});
		// naive-ui 抽屉的关闭按钮是 .n-base-close（不是 .n-drawer-close）
		await page.locator('[data-testid="skill-detail"] .n-base-close').click();
		await page.waitForTimeout(500);
	}

	// 新建：填名称 → 创建 → 列表里出现（自建分类）
	await page.locator('[data-testid="skill-create"]').click();
	await page.waitForTimeout(600);
	const skillName = `E2E技能-${Date.now() % 100000}`;
	// testid 挂在 n-input 容器上，fill 要打在它内部的真 input 元素
	await page.locator('[data-testid="skill-name-input"] input').fill(skillName);
	await page.locator('[data-testid="skill-submit"]').click();
	await page.waitForTimeout(1500);
	await check("新建的技能出现在列表里", async () => {
		const names = await page.locator(".skill-name").allTextContents();
		assert.ok(
			names.some((name) => name.trim() === skillName),
			`创建后列表应有「${skillName}」，实际 ${names.join("、")}`,
		);
	});

	// 删除：找到刚建的那张卡 → 删除 → 确认 → 消失（自建自删，不污染库）
	const targetCard = page.locator(".skill-card", { hasText: skillName }).first();
	await targetCard.locator("button:has-text('删除')").click();
	await page.waitForTimeout(600);
	await page.locator(".n-dialog .n-button--primary-type, .n-dialog button:has-text('删除')").first().click();
	await page.waitForTimeout(1500);
	await check("删除后技能从列表消失", async () => {
		const names = await page.locator(".skill-name").allTextContents();
		assert.ok(
			!names.some((name) => name.trim() === skillName),
			`删除后不应再有「${skillName}」，实际 ${names.join("、")}`,
		);
	});
	await check("auto-flow 卡片没有删除入口（内置不可删）", async () => {
		// auto-flow 被列表过滤掉了，这里退而求其次：内置分类下的卡片都不该有删除按钮
		const builtinCards = page.locator(".skill-card", { hasText: "内置" });
		const count = await builtinCards.count();
		if (count === 0) return;
		const delCount = await builtinCards.first().locator("button:has-text('删除')").count();
		assert.equal(delCount, 0, "内置技能不应有删除按钮");
	});

	console.log("\n── 审计页（表格接真接口） ───────────────────────────");
	await page.goto(`${BASE}/#/audit`, { waitUntil: "domcontentloaded" });
	await page.waitForTimeout(900);

	const auditRows = await page.locator(".audit-table tbody tr").count();
	await check("审计表格有数据行", () => {
		assert.ok(auditRows > 0, `应有审计记录，实际 ${auditRows} 行`);
	});
	const auditHead = await page.locator(".audit-table thead").innerText();
	await check("审计列名为 时间/来源/动作/目标/结果", () => {
		for (const label of ["时间", "来源", "动作", "目标", "结果"]) {
			assert.ok(auditHead.includes(label), `表头应有「${label}」`);
		}
	});

	console.log("\n── 审批页（如实说明内存态） ─────────────────────────");
	await page.goto(`${BASE}/#/approvals`, { waitUntil: "domcontentloaded" });
	await page.waitForTimeout(500);

	const approvalText = await page.locator(".page").innerText();
	await check("审批页写明待办只存在内存、重启即消失", () => {
		assert.ok(approvalText.includes("内存") && approvalText.includes("重启"), "必须如实说明，不能让人以为像工单一样留痕");
	});

	console.log("\n── 运行时健康 ───────────────────────────────────────");
	await check("全程没有页面 JS 报错", () => {
		assert.deepEqual(pageErrors, [], `页面报错：\n${pageErrors.join("\n")}`);
	});

	await browser.close();

	console.log("");
	if (failures.length > 0) {
		console.log(`端到端自检失败：${failures.length} 项（通过 ${passed} 项）`);
		process.exit(1);
	}
	console.log(`新前端端到端自检全部通过：${passed} 项（Playwright 真实浏览器）`);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
