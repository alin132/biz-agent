/**
 * 极简 markdown → HTML。
 *
 * 为什么不引第三方库：控制台没有构建步骤，两百行纯函数足够覆盖模型实际会输出的语法；
 * 而且**先转义再套标签**，任何模型吐出来的 HTML 都只会变成文本，不存在注入面。
 *
 * 支持：标题(#~####)、无序/有序列表、表格、引用、分隔线、围栏代码块（带复制按钮）、
 * 行内代码、粗体、斜体、删除线、链接（只放行 http/https/mailto、站内 / 开头路径与 # 锚点）。
 *
 * 挂在 window 上给浏览器用；单测由 scripts/ui-check.mjs 用 node:vm 加载**同一份文件**跑
 * （本文件是经典脚本，不能写 import/export，仓库的 "type": "module" 也不影响它）。
 */

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function escapeHtml(text) {
	return String(text).replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

/** 链接白名单：只允许这几类协议，其余退化成纯文本，避免 javascript: 之类的注入。 */
function safeHref(href) {
	const value = href.trim();
	if (/^(https?:\/\/|mailto:)/i.test(value) || value.startsWith("/") || value.startsWith("#")) {
		return value;
	}
	return null;
}

/** 行内语法：行内代码 → 链接 → 删除线 → 粗体 → 斜体（行内代码先摘出来，里面的星号不当语法）。 */
function inline(text) {
	const codes = [];
	let out = escapeHtml(text).replace(/`([^`]+)`/g, (_match, code) => {
		codes.push(`<code>${code}</code>`);
		return `\u0001${codes.length - 1}\u0001`;
	});

	out = out
		.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (match, label, href) => {
			const target = safeHref(href);
			if (target === null) return label;
			const external = /^https?:\/\//i.test(target);
			const attrs = external ? ' target="_blank" rel="noopener noreferrer"' : "";
			return `<a href="${target}"${attrs}>${label}</a>`;
		})
		.replace(/~~([^~\n]+)~~/g, "<del>$1</del>")
		.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
		.replace(/(^|[\s(（])\*([^*\n]+)\*/g, "$1<em>$2</em>")
		.replace(/(^|[\s(（])_([^_\n]+)_/g, "$1<em>$2</em>");

	return out.replace(/\u0001(\d+)\u0001/g, (_match, index) => codes[Number(index)]);
}

/** 围栏代码块：带语言标签和「复制」按钮，复制动作由 app.js 用事件委托接。 */
function codeBlockHtml(block) {
	const lang = block.lang === "" ? "text" : escapeHtml(block.lang);
	return [
		'<div class="code-block">',
		`<div class="code-head"><span class="code-lang">${lang}</span>`,
		'<button class="code-copy" type="button" data-role="copy-code">复制</button></div>',
		`<pre><code>${escapeHtml(block.code)}</code></pre>`,
		"</div>",
	].join("");
}

/** 表格单元格：去掉首尾竖线后按 | 切开。 */
function splitRow(line) {
	const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
	return trimmed.split("|").map((cell) => cell.trim());
}

/** 表格分隔行：每个单元格都是 --- / :-- / --: / :-: 这种形式。 */
function isDividerRow(line) {
	if (!line.trim().includes("-")) return false;
	const cells = splitRow(line);
	return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));
}

function renderMarkdown(source) {
	const codeBlocks = [];
	const text = String(source ?? "")
		.replace(/\r\n/g, "\n")
		// 先把代码块摘出来，避免里面的 * _ | 被当成行内/表格语法
		.replace(/```([^\n`]*)\n([\s\S]*?)```/g, (_match, lang, code) => {
			codeBlocks.push({ lang: String(lang).trim(), code: code.replace(/\n$/, "") });
			return `\u0000C${codeBlocks.length - 1}\u0000`;
		});

	const lines = text.split("\n");
	const html = [];
	let listType = null;
	let listItems = [];
	let paragraph = [];

	const flushList = () => {
		if (listType) {
			html.push(`<${listType}>${listItems.join("")}</${listType}>`);
			listType = null;
			listItems = [];
		}
	};
	const flushParagraph = () => {
		if (paragraph.length > 0) {
			html.push(`<p>${paragraph.map(inline).join("<br>")}</p>`);
			paragraph = [];
		}
	};
	const flushAll = () => {
		flushList();
		flushParagraph();
	};

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index].replace(/\s+$/, "");
		const trimmed = line.trim();
		if (trimmed === "") {
			flushAll();
			continue;
		}

		const codeMarker = /^\u0000C(\d+)\u0000$/.exec(trimmed);
		if (codeMarker) {
			flushAll();
			html.push(codeBlockHtml(codeBlocks[Number(codeMarker[1])]));
			continue;
		}

		const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
		if (heading) {
			flushAll();
			const level = Math.min(heading[1].length, 4);
			html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
			continue;
		}

		if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
			flushAll();
			html.push("<hr>");
			continue;
		}

		if (/^>\s?/.test(trimmed)) {
			flushAll();
			html.push(`<blockquote>${inline(trimmed.replace(/^>\s?/, ""))}</blockquote>`);
			continue;
		}

		// 表格：当前行是表头，下一行是 |---| 分隔行
		if (trimmed.startsWith("|") && isDividerRow(lines[index + 1] ?? "")) {
			flushAll();
			const headers = splitRow(trimmed);
			index += 1;
			const rows = [];
			while (index + 1 < lines.length) {
				const next = lines[index + 1].trim();
				if (!next.startsWith("|")) break;
				index += 1;
				rows.push(splitRow(next));
			}
			const head = headers.map((cell) => `<th>${inline(cell)}</th>`).join("");
			const body = rows
				.map((cells) => `<tr>${headers.map((_h, i) => `<td>${inline(cells[i] ?? "")}</td>`).join("")}</tr>`)
				.join("");
			html.push(`<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`);
			continue;
		}

		const ordered = /^(\d+)[.)]\s+(.*)$/.exec(trimmed);
		if (ordered) {
			flushParagraph();
			if (listType !== "ol") {
				flushList();
				listType = "ol";
			}
			listItems.push(`<li>${inline(ordered[2])}</li>`);
			continue;
		}

		const bullet = /^[-*+]\s+(.*)$/.exec(trimmed);
		if (bullet) {
			flushParagraph();
			if (listType !== "ul") {
				flushList();
				listType = "ul";
			}
			listItems.push(`<li>${inline(bullet[1])}</li>`);
			continue;
		}

		flushList();
		paragraph.push(trimmed);
	}

	flushAll();
	return html.join("");
}

// 浏览器里当全局函数用（app.js 不是模块，没有构建步骤）。
// node 单测（scripts/ui-check.mjs）用 node:vm 在同样的"经典脚本"环境里加载这个文件，
// 所以这里只用 window 挂载、不写 import/export —— 仓库是 "type": "module"，别让 node 把它当 ESM 解析。
if (typeof window !== "undefined") {
	window.renderMarkdown = renderMarkdown;
	window.escapeHtml = escapeHtml;
}
