/**
 * 前端纯函数的单测（目前是 markdown 渲染）。
 *
 * 控制台没有构建步骤，web/*.js 是「经典脚本」：用 node:vm 造一个只有 window 的沙盒去加载
 * web/markdown.js，跑的就是浏览器实际执行的那份文件。
 *
 * 关键断言是「先转义再套标签」——模型吐出来的 HTML 只能变成文本，不能变成标签。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "web", "markdown.js"), "utf8");
const sandbox = { window: {} };
vm.runInNewContext(source, sandbox);
const { renderMarkdown } = sandbox.window;

const results = [];
function check(name, fn) {
	try {
		fn();
		results.push({ name, ok: true });
	} catch (error) {
		results.push({ name, ok: false, message: error instanceof Error ? error.message : String(error) });
	}
}

check("标题渲染成 h1~h4（超过 4 级截断）", () => {
	assert.equal(renderMarkdown("# 一级"), "<h1>一级</h1>");
	assert.equal(renderMarkdown("##### 五级"), "<h4>五级</h4>");
});

check("无序列表与有序列表各自成块", () => {
	assert.equal(renderMarkdown("- 甲\n- 乙"), "<ul><li>甲</li><li>乙</li></ul>");
	assert.equal(renderMarkdown("1. 甲\n2. 乙"), "<ol><li>甲</li><li>乙</li></ol>");
});

check("表格渲染成 table（这是模型最常输出、也最容易被忽略的语法）", () => {
	const html = renderMarkdown("| 区域 | 金额 |\n|---|---|\n| 华南 | ¥215,000 |");
	assert.ok(html.includes("<table>"), "应产出 table");
	assert.ok(html.includes("<th>区域</th>"), "表头单元格");
	assert.ok(html.includes("<td>华南</td>"), "数据单元格");
	assert.ok(html.includes("¥215,000"), "金额原样保留");
});

check("表格单元格里的行内语法照样生效", () => {
	const html = renderMarkdown("| 名称 | 状态 |\n|:--|--:|\n| **TK-1001** | 已归档 |");
	assert.ok(html.includes("<strong>TK-1001</strong>"), "粗体在单元格内生效");
});

check("围栏代码块带语言标签与复制按钮", () => {
	const html = renderMarkdown("```ts\nconst a = 1;\n```");
	assert.ok(html.includes('class="code-block"'), "代码块容器");
	assert.ok(html.includes('class="code-lang">ts<'), "语言标签");
	assert.ok(html.includes('data-role="copy-code"'), "复制按钮");
	assert.ok(html.includes('aria-label="复制代码"'), "复制按钮无障碍名称");
	assert.ok(html.includes('<svg viewBox="0 0 24 24"'), "复制按钮显示图标");
	assert.ok(html.includes("const a = 1;"), "代码内容");
});

check("代码块里的 * 和 | 不被当成语法", () => {
	const html = renderMarkdown("```js\nconst t = a * b;\nconst r = x | y;\n```");
	assert.ok(html.includes("a * b"), "星号保持原样");
	assert.ok(!html.includes("<em>"), "不该出现斜体");
	assert.ok(!html.includes("<table>"), "不该出现表格");
});

check("行内代码优先于粗体/斜体", () => {
	const html = renderMarkdown("`**不是粗体**` 与 **是粗体**");
	assert.ok(html.includes("<code>**不是粗体**</code>"), "行内代码原样保留");
	assert.ok(html.includes("<strong>是粗体</strong>"), "代码外的粗体生效");
});

check("粗体/斜体/删除线", () => {
	const html = renderMarkdown("**粗** *斜* ~~删~~");
	assert.ok(html.includes("<strong>粗</strong>"));
	assert.ok(html.includes("<em>斜</em>"));
	assert.ok(html.includes("<del>删</del>"));
});

check("链接只放行白名单协议，外链带 noopener", () => {
	const html = renderMarkdown("[文档](https://example.com/a)");
	assert.ok(html.includes('href="https://example.com/a"'));
	assert.ok(html.includes('rel="noopener noreferrer"'));
	assert.ok(renderMarkdown("[坏](javascript:alert(1))").includes("坏"), "危险协议退化成纯文本");
	assert.ok(!renderMarkdown("[坏](javascript:alert(1))").includes("javascript:alert"), "危险协议不进 href");
});

check("HTML 全部转义：模型输出标签也只会变成文本", () => {
	const html = renderMarkdown("<script>alert(1)</script> & \"引号\"");
	assert.ok(!html.includes("<script>"), "不能出现真实 script 标签");
	assert.ok(html.includes("&lt;script&gt;"), "尖括号被转义");
	assert.ok(html.includes("&amp;"), "& 被转义");
});

check("引用、分隔线、空行分段", () => {
	assert.equal(renderMarkdown("> 引用"), "<blockquote>引用</blockquote>");
	assert.equal(renderMarkdown("---"), "<hr>");
	assert.equal(renderMarkdown("第一段\n\n第二段"), "<p>第一段</p><p>第二段</p>");
});

check("段落内的换行保留成 <br>，连续空白行不产生空标签", () => {
	assert.equal(renderMarkdown("甲\n乙"), "<p>甲<br>乙</p>");
	assert.equal(renderMarkdown("\n\n甲\n\n\n"), "<p>甲</p>");
});

check("空输入不炸", () => {
	assert.equal(renderMarkdown(""), "");
	assert.equal(renderMarkdown(null), "");
	assert.equal(renderMarkdown(undefined), "");
});

check("一段真实模型输出能整段渲染（表格 + 列表 + 粗体混排）", () => {
	const source = [
		"### 已支付订单汇总",
		"",
		"共 **4 笔**，合计 ¥517,000：",
		"",
		"| 区域 | 金额 |",
		"|---|---|",
		"| 华南 | ¥215,000 |",
		"",
		"- 最高：华南",
		"- 最低：华北",
	].join("\n");
	const html = renderMarkdown(source);
	assert.ok(html.includes("<h3>已支付订单汇总</h3>"));
	assert.ok(html.includes("<strong>4 笔</strong>"));
	assert.ok(html.includes("<table>"));
	assert.ok(html.includes("<ul><li>最高：华南</li>"));
});

const failed = results.filter((item) => !item.ok);
for (const item of results) {
	console.log(`  ${item.ok ? "✓" : "✗"} ${item.name}${item.ok ? "" : `\n      ${item.message}`}`);
}
if (failed.length > 0) {
	console.log(`\n前端单测失败：${failed.length}/${results.length} 项`);
	process.exitCode = 1;
} else {
	console.log(`\n前端单测全部通过：${results.length} 项（markdown 渲染）`);
}
