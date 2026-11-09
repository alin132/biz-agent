/**
 * 知识库引擎自检（`npm run kb:selftest`）——零网络、零真实模型、临时 SQLite。
 *
 * 覆盖：
 *   分块（长文/标题/重叠/硬上限/tokens/空文本）
 *   解析（TXT/MD/CSV 原生 + **真实 PDF/DOCX**（脚本内现造二进制，不依赖仓库里的样例）+ 中文报错 + 413）
 *   存储（建库/唯一名/文档/分块/级联删除/技能绑定）
 *   检索（关键词打分排序、topK、阈值、空查询、404；向量模式的余弦/阈值/失败回退）
 *   向量化客户端（无 key 不可用、批量 32、失败重试 1 次）
 *   HTTP（只挂 `handleKb` 的极小服务，随机端口，跑完就关；不碰 4317）
 *
 * PDF/DOCX fixture 在脚本里现造：DOCX 用 jszip 拼一个最小 OOXML，PDF 手写一套最小 xref，
 * 这样 `npm run kb:selftest` 在任何机器上都能跑，不用提交二进制样例。
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { Agent } from "@earendil-works/pi-agent-core";
import { AgentSession, DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createPiSessionHistory } from "../server/piSessionHistory.js";

import { CHUNK_DEFAULTS, chunkText, estimateTokens } from "../server/kb/chunk.js";
import { createEmbeddingClient } from "../server/kb/embedding.js";
import type { EmbeddingClient } from "../server/kb/embedding.js";
import { KbError } from "../server/kb/errors.js";
import { handleKb, initKb, closeKb, searchForSkill } from "../server/kb/index.js";
import { PARSE_LIMITS, parseCsvToText, parseDocument, splitCsvLine } from "../server/kb/parse.js";
import { ensureKbSchema } from "../server/kb/schema.js";
import type { KbChunkRow } from "../server/kb/schema.js";
import { buildSnippet, cosineSimilarity, rankKeywordChunks, tokenizeQuery } from "../server/kb/search.js";
import { ATTACHMENT_MAX_CHARS, createKbService, createKbServiceForPath } from "../server/kb/service.js";
import { createKbStore } from "../server/kb/store.js";
import { KB_SEARCH_TOOL_NAME, createKbPiExtension, createKbSearchTool } from "../server/kb/tool.js";
import { DatabaseSync } from "node:sqlite";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const TMP_DIR = resolve(ROOT, "data/_tmp");
const UNIT_DB = resolve(TMP_DIR, "kb-selftest.db");
const HTTP_DB = resolve(TMP_DIR, "kb-selftest-http.db");
const TOOL_DB = resolve(TMP_DIR, "kb-selftest-tool.db");

let passed = 0;

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
	try {
		await fn();
		passed++;
		console.log(`  ✓ ${name}`);
	} catch (error) {
		console.error(`  ✗ ${name}`);
		console.error(error instanceof Error ? `    ${error.message}` : `    ${String(error)}`);
		throw error;
	}
}

/** 断言「抛 KbError，状态码与文案都对」。 */
async function expectKbError(
	action: () => Promise<unknown> | unknown,
	status: number,
	contains?: string,
): Promise<void> {
	await assert.rejects(
		async () => {
			await action();
		},
		(error: unknown) => {
			assert.ok(error instanceof KbError, `应当是 KbError，实际是 ${String(error)}`);
			assert.equal(error.status, status);
			if (contains) {
				assert.ok(
					error.message.includes(contains),
					`错误文案应包含「${contains}」，实际：「${error.message}」`,
				);
			}
			return true;
		},
	);
}

/** 清掉库文件与 WAL/SHM 旁路文件。 */
function removeDbFiles(base: string): void {
	for (const suffix of ["", "-wal", "-shm"]) {
		const file = `${base}${suffix}`;
		if (existsSync(file)) {
			rmSync(file, { force: true });
		}
	}
}

/* ---------------- 真实二进制 fixture ---------------- */

/** 现造一个最小 DOCX（OOXML 就是个 zip：内容类型 + 关系 + 正文 XML）。 */
async function buildDocx(paragraphs: string[]): Promise<Buffer> {
	const escapeXml = (text: string): string =>
		text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	const body = paragraphs
		.map(
			(paragraph) =>
				`<w:p><w:r><w:t xml:space="preserve">${escapeXml(paragraph)}</w:t></w:r></w:p>`,
		)
		.join("");
	const zip = new JSZip();
	zip.file(
		"[Content_Types].xml",
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
		 <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
		 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
		 <Default Extension="xml" ContentType="application/xml"/>
		 <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
		 </Types>`,
	);
	zip.file(
		"_rels/.rels",
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
		 <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
		 <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
		 </Relationships>`,
	);
	zip.file(
		"word/document.xml",
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
		 <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
		 <w:body>${body}<w:sectPr/></w:body></w:document>`,
	);
	return zip.generateAsync({ type: "nodebuffer" });
}

/** 现造一个最小 PDF（Helvetica、纯 ASCII 文本、手写 xref）。 */
function buildPdf(pages: string[][]): Buffer {
	const escapePdfText = (text: string): string =>
		text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
	const streams = pages.map((lines) => {
		const parts = ["BT", "/F1 14 Tf", "1 0 0 1 72 760 Tm", "16 TL"];
		for (const line of lines) {
			parts.push(`(${escapePdfText(line)}) Tj`, "T*");
		}
		parts.push("ET");
		return parts.join("\n");
	});

	const objects: string[] = [];
	objects.push("<< /Type /Catalog /Pages 2 0 R >>");
	const fontId = 3 + pages.length * 2;
	const kids = pages.map((_, index) => `${3 + index * 2} 0 R`).join(" ");
	objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
	pages.forEach((_, index) => {
		const pageId = 3 + index * 2;
		const contentId = pageId + 1;
		objects.push(
			`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`,
		);
		objects.push(
			`<< /Length ${Buffer.byteLength(streams[index]!, "latin1")} >>\nstream\n${streams[index]}\nendstream`,
		);
	});
	objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

	let output = "%PDF-1.4\n";
	const offsets: number[] = [];
	objects.forEach((body, index) => {
		offsets.push(Buffer.byteLength(output, "latin1"));
		output += `${index + 1} 0 obj\n${body}\nendobj\n`;
	});
	const xrefStart = Buffer.byteLength(output, "latin1");
	output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets) {
		output += `${String(offset).padStart(10, "0")} 00000 n \n`;
	}
	output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
	return Buffer.from(output, "latin1");
}

/* ---------------- 假 embedding 客户端 ---------------- */

/** 按关键词出现次数给固定向量：够验证「向量模式 + 余弦排序 + 阈值」，不打任何网络。 */
function vectorFor(text: string): number[] {
	const refund = (text.match(/退款/g) ?? []).length;
	const invoice = (text.match(/发票/g) ?? []).length;
	return [refund, invoice, 0.5];
}

function stubEmbeddingClient(overrides: Partial<EmbeddingClient> = {}): EmbeddingClient {
	return {
		available: () => true,
		info: () => ({ available: true, model: "stub-embedding", baseUrl: "stub://local", source: "env" as const, modelKey: null, problem: null }),
		embed: async (texts: string[]) => texts.map((text) => vectorFor(text)),
		...overrides,
	};
}

/** 造一条假 chunk（纯函数排序测试用）。 */
function fakeChunk(id: number, content: string, heading: string | null = null): KbChunkRow {
	return { id, docId: `doc_${id}`, kbId: "kb_test", seq: id, heading, content, tokens: estimateTokens(content), embedding: null };
}

/* ---------------- 主流程 ---------------- */

async function main(): Promise<void> {
	mkdirSync(TMP_DIR, { recursive: true });
	removeDbFiles(UNIT_DB);
	removeDbFiles(HTTP_DB);
	// 自检不读 .env：把向量化相关环境变量清干净，保证「无 key」分支可复现
	delete process.env.EMBEDDING_API_KEY;
	delete process.env.EMBEDDING_BASE_URL;
	delete process.env.EMBEDDING_MODEL;
	delete process.env.DATABASE_URL;

	const store = createKbStore({ path: UNIT_DB });
	const noEmbedding = createEmbeddingClient({ config: { apiKey: "" } });
	const service = createKbService({ store, embedding: noEmbedding });

	let httpServer: ReturnType<typeof createServer> | null = null;
	try {
		/* ---------- 分块 ---------- */

		await check("分块：短文本 1 块，seq 从 1 开始，heading 为 null", () => {
			const chunks = chunkText({ text: "这是一个很短的段落，只应该产生一个块。" });
			assert.equal(chunks.length, 1);
			assert.equal(chunks[0]!.seq, 1);
			assert.equal(chunks[0]!.heading, null);
			assert.ok(chunks[0]!.content.includes("很短的段落"));
		});

		await check("分块：markdown 标题写入 heading，换标题就断块", () => {
			const text = "# 员工手册\n\n第一段落内容。\n\n## 考勤\n\n第二段落内容。";
			const chunks = chunkText({ text });
			assert.equal(chunks.length, 2);
			assert.equal(chunks[0]!.heading, "员工手册");
			assert.equal(chunks[1]!.heading, "考勤");
			assert.ok(!chunks[1]!.content.includes("第一段落内容"));
		});

		await check("分块：长文切成多块，每块都不超过硬上限", () => {
			const paragraph = "员工考勤与请假制度说明。".repeat(160);
			const chunks = chunkText({ text: paragraph, chunkSize: 400, overlap: 60, maxChars: 800 });
			assert.ok(chunks.length > 2, `应当切成多块，实际 ${chunks.length} 块`);
			for (const chunk of chunks) {
				assert.ok(chunk.content.length <= 800, `块长度 ${chunk.content.length} 超过硬上限 800`);
			}
			assert.deepEqual(
				chunks.map((chunk) => chunk.seq),
				chunks.map((_, index) => index + 1),
			);
		});

		await check("分块：相邻块有 120 字符重叠（默认参数）", () => {
			const paragraph = "这是一段用于验证分块重叠的员工手册正文说明，内容足够长以便产生多个块。";
			const long = Array.from({ length: 40 }, () => paragraph).join("\n\n");
			const chunks = chunkText({ text: long });
			assert.ok(chunks.length >= 2, `长文应当至少两块，实际 ${chunks.length} 块`);
			const headOfNext = chunks[1]!.content.slice(0, 8);
			assert.ok(
				chunks[0]!.content.includes(headOfNext),
				`下一块开头应来自上一块结尾（重叠）：${headOfNext}`,
			);
			assert.equal(CHUNK_DEFAULTS.overlap, 120);
		});

		await check("分块：单个超长段落按 2000 硬上限切开", () => {
			const huge = "没有标点的超长段落".repeat(400);
			const chunks = chunkText({ text: huge, maxChars: 1000 });
			assert.ok(chunks.length >= 2);
			for (const chunk of chunks) {
				assert.ok(chunk.content.length <= 1000);
			}
		});

		await check("分块：tokens = ceil(字符数 / 1.6)", () => {
			const chunks = chunkText({ text: "一二三四五六七八九十".repeat(10) });
			const chunk = chunks[0]!;
			assert.equal(chunk.tokens, Math.ceil(chunk.content.length / 1.6));
			assert.equal(estimateTokens("abcdefghij"), 7);
		});

		await check("分块：空文本 / 纯空白返回空数组", () => {
			assert.deepEqual(chunkText({ text: "" }), []);
			assert.deepEqual(chunkText({ text: "   \n\n\t  " }), []);
		});

		/* ---------- 解析 ---------- */

		await check("解析：TXT 去 BOM、统一换行、kind 与 title", async () => {
			const parsed = await parseDocument({
				filename: "员工须知.txt",
				data: Buffer.from("\uFEFF第一行\r\n\r\n\r\n第二行\r\n"),
			});
			assert.equal(parsed.meta.kind, "txt");
			assert.equal(parsed.meta.title, "员工须知");
			assert.equal(parsed.text, "第一行\n\n第二行");
		});

		await check("解析：Markdown 标题当 title", async () => {
			const parsed = await parseDocument({
				filename: "手册.md",
				data: Buffer.from("# 员工手册\n\n正文第一段。\n"),
			});
			assert.equal(parsed.meta.kind, "md");
			assert.equal(parsed.meta.title, "员工手册");
		});

		await check("解析：CSV 首行表头 + 行解析，引号里的逗号不切列", async () => {
			const csv = '姓名,部门,说明\n张三,研发,"负责, 核心模块"\n李四,运营,客户支持\n';
			const parsed = await parseDocument({ filename: "员工.csv", data: Buffer.from(csv) });
			assert.equal(parsed.meta.kind, "csv");
			assert.ok(parsed.text.includes("姓名: 张三"), parsed.text);
			assert.ok(parsed.text.includes("负责, 核心模块"), parsed.text);
			const direct = parseCsvToText(csv);
			assert.deepEqual(direct.header, ["姓名", "部门", "说明"]);
			assert.equal(direct.rows, 2);
			assert.deepEqual(splitCsvLine('a,"b,c","d""e"', ","), ["a", "b,c", 'd"e']);
		});

		await check("解析：不支持的扩展名报中文 400", async () => {
			await expectKbError(
				() => parseDocument({ filename: "报表.xlsx", data: Buffer.from("PK\u0003\u0004") }),
				400,
				"暂不支持",
			);
		});

		await check("解析：老的 .doc 给出「另存为 .docx」提示", async () => {
			await expectKbError(
				() => parseDocument({ filename: "旧文档.doc", data: Buffer.from("legacy word bytes") }),
				400,
				"另存为 .docx",
			);
		});

		await check("解析：超过 20 MB 直接 413（不读内容）", async () => {
			await expectKbError(
				() => parseDocument({ filename: "big.txt", data: Buffer.alloc(PARSE_LIMITS.maxBytes + 1) }),
				413,
				"20 MB",
			);
		});

		await check("解析：真实 PDF 读出文字与页数", async () => {
			const pdf = buildPdf([
				["Enterprise knowledge base test", "page one line"],
				["second page text"],
			]);
			const parsed = await parseDocument({ filename: "sample.pdf", data: pdf });
			assert.equal(parsed.meta.kind, "pdf");
			assert.equal(parsed.meta.pages, 2);
			assert.ok(parsed.text.includes("Enterprise knowledge base test"), parsed.text);
			assert.ok(parsed.text.includes("second page text"), parsed.text);
		});

		await check("解析：没有文字的 PDF 报「可能是扫描件」", async () => {
			await expectKbError(
				() => parseDocument({ filename: "scan.pdf", data: buildPdf([[]]) }),
				400,
				"可能是扫描件",
			);
		});

		await check("解析：真实 DOCX 读出中文正文", async () => {
			const docx = await buildDocx(["企业知识库 RAG 测试", "第二段：上传 Word 文档后应能解析出文字。"]);
			const parsed = await parseDocument({ filename: "说明.docx", data: docx });
			assert.equal(parsed.meta.kind, "docx");
			assert.ok(parsed.text.includes("企业知识库 RAG 测试"), parsed.text);
			assert.ok(parsed.text.includes("第二段"), parsed.text);
		});

		/* ---------- 存储 ---------- */

		await check("存储：建库后列表里计数为 0", () => {
			const kb = store.createKnowledgeBase({ name: "售后知识库", description: "退款/发票" });
			assert.ok(kb.id.startsWith("kb_"));
			assert.equal(kb.name, "售后知识库");
			const list = store.listKnowledgeBases();
			assert.equal(list.length, 1);
			assert.equal(list[0]!.docCount, 0);
			assert.equal(list[0]!.chunkCount, 0);
			assert.equal(list[0]!.embeddedChunkCount, 0);
			assert.equal(store.getKnowledgeBase(kb.id)!.similarityThreshold, 0.2);
		});

		await check("存储：同名知识库 400，超长名称 400", () => {
			assert.throws(() => store.createKnowledgeBase({ name: "售后知识库" }), (error: unknown) => {
				return error instanceof KbError && error.status === 400 && error.message.includes("同名知识库已存在");
			});
			assert.throws(() => store.createKnowledgeBase({ name: "长".repeat(81) }), (error: unknown) => {
				return error instanceof KbError && error.status === 400;
			});
		});

		const kb = store.listKnowledgeBases()[0]!;
		let refundDocId = "";
		let invoiceDocId = "";
		let auditDocId = "";

		await check("存储：上传文档后 chunkCount/docCount 正确", async () => {
			const refund = await service.ingestDocument({
				kbId: kb.id,
				filename: "退款流程.md",
				data: Buffer.from("# 退款流程\n\n退款需要财务审批，3 个工作日内到账。\n\n提交退款申请后可在订单页查询进度。"),
			});
			refundDocId = refund.document.id;
			assert.equal(refund.document.status, "ready");
			assert.ok(refund.chunkCount >= 1);
			assert.equal(refund.embedded, false, "没配 key 时不应该有向量");

			const invoice = await service.ingestDocument({
				kbId: kb.id,
				filename: "发票说明.md",
				data: Buffer.from("# 发票开具\n\n发票在订单完成后开具，可下载电子发票。"),
			});
			invoiceDocId = invoice.document.id;

			const audit = await service.ingestDocument({
				kbId: kb.id,
				filename: "审批规则.md",
				data: Buffer.from("# 审批规则\n\n所有退款都要审批，审批由财务负责。"),
			});
			auditDocId = audit.document.id;

			const refreshed = store.getKnowledgeBase(kb.id)!;
			assert.equal(refreshed.docCount, 3);
			assert.equal(refreshed.chunkCount, refund.chunkCount + 2);
		});

		await check("存储：分块按 seq 连续落库且内容可读", () => {
			const chunks = store.listChunks(kb.id);
			assert.ok(chunks.length >= 3);
			for (const chunk of chunks) {
				assert.ok(chunk.content.length > 0);
				assert.equal(chunk.tokens, estimateTokens(chunk.content));
				assert.equal(chunk.embedding, null);
			}
			const first = chunks.find((chunk) => chunk.docId === refundDocId)!;
			assert.equal(first.seq, 1);
			assert.equal(first.heading, "退款流程");
		});

		await check("存储：删除文档只删自己的分块", () => {
			const before = store.listChunks(kb.id).length;
			const result = service.removeDocument(invoiceDocId);
			assert.equal(result.removed, true);
			assert.ok(result.chunksRemoved >= 1);
			assert.equal(store.listChunks(kb.id).length, before - result.chunksRemoved);
			assert.equal(store.getDocument(invoiceDocId), undefined);
			assert.ok(store.getDocument(refundDocId));
			assert.equal(service.removeDocument("doc_nope").removed, false);
		});

		await check("存储：删库级联删文档/分块/技能绑定", () => {
			const temp = store.createKnowledgeBase({ name: "临时库" });
			const doc = store.insertDocument({
				kbId: temp.id,
				filename: "a.txt",
				bytes: 10,
				status: "ready",
				chunkCount: 1,
			});
			store.insertChunks(doc.id, temp.id, [
				{ seq: 1, heading: null, content: "临时内容", tokens: 3 },
			]);
			store.setSkillBindings("flow_ticket", [temp.id]);
			const result = store.removeKnowledgeBase(temp.id);
			assert.equal(result.removed, true);
			assert.equal(result.documentsRemoved, 1);
			assert.equal(result.chunksRemoved, 1);
			assert.equal(store.getKnowledgeBase(temp.id), undefined);
			assert.equal(store.getSkillKbIds("flow_ticket").length, 0);
			assert.equal(store.removeKnowledgeBase(temp.id).removed, false);
		});

		/* ---------- 检索：纯函数 ---------- */

		await check("检索：分词把中文切成 2-gram", () => {
			const tokens = tokenizeQuery("知识库检索");
			assert.ok(tokens.includes("知识库检索"));
			assert.ok(tokens.includes("知识"));
			assert.ok(tokens.includes("检索"));
			assert.deepEqual(tokenizeQuery("   ，。!  "), []);
		});

		await check("检索：余弦相似度与 snippet 窗口", () => {
			assert.equal(cosineSimilarity([1, 0, 0], [1, 0, 0]), 1);
			assert.equal(cosineSimilarity([1, 0, 0], [0, 1, 0]), 0);
			assert.equal(cosineSimilarity([1, 0], [1, 0, 0]), 0, "维度不一致要安全返回 0");
			const long = `${"背景说明。".repeat(60)}退款需要审批${"补充说明。".repeat(60)}`;
			const snippet = buildSnippet(long, ["退款"]);
			assert.ok(snippet.includes("退款"));
			assert.ok(snippet.startsWith("…"));
		});

		await check("检索：关键词打分排序、topK、显式阈值过滤", () => {
			const chunks = [
				fakeChunk(1, "退款需要财务审批，3 个工作日到账。", "退款流程"),
				fakeChunk(2, "所有退款都要审批，审批由财务负责。", "审批规则"),
				fakeChunk(3, "发票在订单完成后开具。", "发票开具"),
			];
			const tokens = tokenizeQuery("退款审批");
			const ranked = rankKeywordChunks(chunks, tokens);
			assert.ok(ranked.length >= 2);
			assert.equal(ranked[0]!.mode, "keyword");
			assert.equal(ranked[0]!.chunkId, 2, "审批命中更多的块要排在前面");
			assert.ok(ranked[0]!.score > 0 && ranked[0]!.score <= 1);
			assert.equal(rankKeywordChunks(chunks, tokens, { topK: 1 }).length, 1);
			const strict = rankKeywordChunks(chunks, tokens, { threshold: 0.99 });
			assert.equal(strict.length, 0, "阈值 0.99 时应当全部过滤");
		});

		await check("检索：关键词检索命中并带 heading/snippet（mode=keyword）", async () => {
			const response = await service.search(kb.id, "退款");
			assert.equal(response.mode, "keyword");
			assert.ok(response.results.length >= 1);
			const top = response.results[0]!;
			assert.equal(top.mode, "keyword");
			assert.ok(top.score > 0);
			assert.ok(top.snippet.includes("退款"), top.snippet);
			assert.ok([refundDocId, auditDocId].includes(top.docId));
			assert.ok(top.heading === "退款流程" || top.heading === "审批规则");
		});

		await check("附件解析：纯文本直接出文本，并如实给出原始字数", async () => {
			const result = await service.extractText({
				filename: "说明.txt",
				data: Buffer.from("退款一般三个工作日到账。", "utf8"),
			});
			assert.equal(result.text, "退款一般三个工作日到账。");
			assert.equal(result.totalChars, result.text.length);
			assert.equal(result.kind, "txt");
		});

		await check("附件解析：markdown 标题保留、超长文本按上限截断且 totalChars 是截断前的值", async () => {
			const md = await service.extractText({
				filename: "手册.md",
				data: Buffer.from("# 安装\n\n先装依赖。", "utf8"),
			});
			assert.ok(md.text.includes("安装"), md.text);

			// 构造一份超过上限的文本，确认截断后 totalChars 仍报原文长度（前端据此提示「已截断」）
			const long = "字".repeat(ATTACHMENT_MAX_CHARS + 500);
			const truncated = await service.extractText({ filename: "长文.txt", data: Buffer.from(long, "utf8") });
			assert.equal(truncated.text.length, ATTACHMENT_MAX_CHARS, "文本要截到上限");
			assert.equal(truncated.totalChars, long.length, "totalChars 是截断前的原文长度");
		});

		await check("附件解析：不支持的格式给中文错误（不落库、不建库）", async () => {
			await expectKbError(
				() => service.extractText({ filename: "老文档.doc", data: Buffer.from("x", "utf8") }),
				400,
				"不支持",
			);
		});

		await check("检索：空搜索词 400，库不存在 404", async () => {
			await expectKbError(() => service.search(kb.id, "   "), 400, "不能为空");
			await expectKbError(() => service.search("kb_nope", "退款"), 404, "知识库不存在");
		});

		/* ---------- 向量化客户端 ---------- */

		await check("向量化：没配置 key 时 available=false，embed 抛中文", async () => {
			const client = createEmbeddingClient({ config: { apiKey: "" } });
			assert.equal(client.available(), false);
			assert.equal(client.info().available, false);
			assert.equal(client.info().model, "text-embedding-3-small");
			await expectKbError(() => client.embed(["退款"]), 400, "没配置向量模型");
		});

		await check("向量化：OpenAI 兼容请求按 32 条分批并解析向量", async () => {
			const calls: string[][] = [];
			const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
				const payload = JSON.parse(String(init?.body)) as { model: string; input: string[] };
				assert.equal(payload.model, "stub-model");
				assert.ok(String((init?.headers as Record<string, string>)["Authorization"]).startsWith("Bearer "));
				calls.push(payload.input);
				return new Response(
					JSON.stringify({
						data: payload.input.map((_, index) => ({ index, embedding: [index, 1, 0] })),
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}) as typeof fetch;
			const client = createEmbeddingClient({
				config: { apiKey: "test-key", baseUrl: "http://stub.invalid/v1", model: "stub-model" },
				fetchImpl: fakeFetch,
				retryDelayMs: 0,
			});
			assert.equal(client.available(), true);
			const inputs = Array.from({ length: 40 }, (_, index) => `文本${index}`);
			const vectors = await client.embed(inputs);
			assert.equal(vectors.length, 40);
			assert.equal(vectors[0]!.length, 3);
			assert.deepEqual(calls.map((batch) => batch.length), [32, 8]);
		});

		await check("向量化：失败重试 1 次后成功", async () => {
			let attempt = 0;
			const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
				attempt++;
				if (attempt === 1) {
					return new Response("upstream boom", { status: 500 });
				}
				const payload = JSON.parse(String(init?.body)) as { input: string[] };
				return new Response(
					JSON.stringify({ data: payload.input.map((_, index) => ({ index, embedding: [1, 0, 0] })) }),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}) as typeof fetch;
			const client = createEmbeddingClient({
				config: { apiKey: "test-key", baseUrl: "http://stub.invalid/v1", model: "stub-model" },
				fetchImpl: fakeFetch,
				retryDelayMs: 0,
			});
			const vectors = await client.embed(["退款"]);
			assert.equal(vectors.length, 1);
			assert.equal(attempt, 2, "应当重试一次");
		});

		/* ---------- 向量检索 / 回退 ---------- */

		await check("检索：有向量时 mode=vector，按余弦排序且阈值生效", async () => {
			const vectorDb = resolve(TMP_DIR, "kb-selftest-vector.db");
			removeDbFiles(vectorDb);
			const vectorService = createKbServiceForPath(vectorDb, stubEmbeddingClient());
			const vectorKb = vectorService.createKnowledgeBase({ name: "向量库" });
			assert.equal(vectorKb.embedding, false);
			const refund = await vectorService.ingestDocument({
				kbId: vectorKb.id,
				filename: "退款.md",
				data: Buffer.from("# 退款政策\n\n退款需要审批，3 个工作日到账。"),
			});
			assert.equal(refund.embedded, true, "有 embedding 时上传应当写向量");
			await vectorService.ingestDocument({
				kbId: vectorKb.id,
				filename: "发票.md",
				data: Buffer.from("# 发票政策\n\n发票在订单完成后开具。"),
			});
			const searched = await vectorService.search(vectorKb.id, "退款怎么处理");
			assert.equal(searched.mode, "hybrid");
			assert.ok(searched.results.length >= 1);
			assert.equal(searched.results[0]!.docId, refund.document.id);
			assert.equal(searched.results[0]!.mode, "hybrid");
			assert.ok(searched.results[0]!.score > 0.9);
			const filtered = await vectorService.search(vectorKb.id, "退款怎么处理", { threshold: 0.99 });
			assert.equal(filtered.results.length, 0, "高于相似度的阈值应当过滤掉");
			assert.equal(vectorService.listKnowledgeBases()[0]!.embedding, true);
			vectorService.close();
			const withoutEmbedding = createKbServiceForPath(vectorDb, createEmbeddingClient({ config: { apiKey: "" } }));
			const lexicalOnly = await withoutEmbedding.ingestDocument({
				kbId: vectorKb.id,
				filename: "未向量化.md",
				data: Buffer.from("# 特殊编号\n\n客户保留编号 ZX-4817，后续核对时必须原样使用。"),
			});
			assert.equal(lexicalOnly.embedded, false, "without an embedding key, new chunks remain lexical-only");
			withoutEmbedding.close();
			const hybridService = createKbServiceForPath(vectorDb, stubEmbeddingClient());
			const hybrid = await hybridService.search(vectorKb.id, "ZX-4817");
			assert.equal(hybrid.mode, "hybrid", "partially embedded libraries use both retrieval paths");
			assert.ok(hybrid.results.some((result) => result.docId === lexicalOnly.document.id), "keyword retrieval includes chunks missing embeddings");
			hybridService.close();
			removeDbFiles(vectorDb);
		});

		await check("重新向量化：补 key 后整库补向量、语义检索可用；没配 key 400、库不存在 404", async () => {
			const reDb = resolve(TMP_DIR, "kb-selftest-reembed.db");
			removeDbFiles(reDb);
			const reStore = createKbStore({ path: reDb });
			const noKey = createKbService({ store: reStore, embedding: createEmbeddingClient({ config: { apiKey: "" } }) });
			const reKb = noKey.createKnowledgeBase({ name: "补向量库" });
			await noKey.ingestDocument({
				kbId: reKb.id,
				filename: "退款.md",
				data: Buffer.from("# 退款政策\n\n退款需要审批，3 个工作日到账。"),
			});
			await noKey.ingestDocument({
				kbId: reKb.id,
				filename: "发票.md",
				data: Buffer.from("# 发票政策\n\n发票在订单完成后开具。"),
			});
			assert.equal((await noKey.search(reKb.id, "退款")).mode, "keyword");
			await expectKbError(() => noKey.reembedKnowledgeBase(reKb.id), 400, "向量化");
			const withKey = createKbService({ store: reStore, embedding: stubEmbeddingClient() });
			const result = await withKey.reembedKnowledgeBase(reKb.id);
			assert.ok(result.chunks >= 2, `应重算至少 2 块，实际 ${result.chunks}`);
			assert.equal(result.embedded, true);
			assert.equal(withKey.listKnowledgeBases()[0]!.embedding, true);
			const after = await withKey.search(reKb.id, "退款怎么处理");
			assert.equal(after.mode, "hybrid");
			assert.ok(after.results.length >= 1);
			await expectKbError(() => withKey.reembedKnowledgeBase("kb_nope"), 404, "知识库不存在");
			withKey.close();
			removeDbFiles(reDb);
		});

		await check("向量模型来自模型页：resolveModelEmbedding 生效，info.source=model；报错就不再回落环境变量", async () => {
			const calls: string[] = [];
			const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
				calls.push(String(url));
				const payload = JSON.parse(String(init?.body)) as { model: string; input: string[] };
				assert.equal(payload.model, "bge-m3");
				return new Response(
					JSON.stringify({ data: payload.input.map((_, index) => ({ index, embedding: [1, index, 0] })) }),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}) as typeof fetch;
			const client = createEmbeddingClient({
				fetchImpl: fakeFetch,
				retryDelayMs: 0,
				// 环境变量那条路留着，用来验证"模型页优先"
				config: { apiKey: "env-key", baseUrl: "http://env.invalid/v1", model: "env-model" },
				resolveModelEmbedding: () => ({
					modelKey: "model-1",
					config: { baseUrl: "http://model.invalid/v1", model: "bge-m3", apiKey: "model-key" },
				}),
			});
			const info = client.info();
			assert.equal(info.available, true);
			assert.equal(info.source, "model", "模型页配了就用模型页的");
			assert.equal(info.modelKey, "model-1");
			assert.equal(info.model, "bge-m3");
			assert.equal(info.problem, null);
			await client.embed(["退款"]);
			assert.equal(calls[0], "http://model.invalid/v1/embeddings", "端点来自模型页那条模型");

			// 模型页有配置但读不出来（比如 key 解不开）：如实不可用，别悄悄用环境变量顶上去
			const broken = createEmbeddingClient({
				config: { apiKey: "env-key", baseUrl: "http://env.invalid/v1", model: "env-model" },
				resolveModelEmbedding: () => {
					throw new Error("向量模型「default · bge-m3」的 API Key 解不开");
				},
			});
			const brokenInfo = broken.info();
			assert.equal(brokenInfo.available, false);
			assert.equal(brokenInfo.source, "model");
			assert.ok(brokenInfo.problem?.includes("解不开"), brokenInfo.problem ?? "");
			await expectKbError(() => broken.embed(["退款"]), 400, "向量模型不可用");

			// 模型页没配：回落到环境变量，source=env
			const envOnly = createEmbeddingClient({
				config: { apiKey: "env-key", baseUrl: "http://env.invalid/v1", model: "env-model" },
				resolveModelEmbedding: () => null,
			});
			assert.equal(envOnly.info().source, "env");
			assert.equal(envOnly.info().model, "env-model");
		});

		await check("检索：向量化失败自动回退关键词并说明原因", async () => {
			const fallbackDb = resolve(TMP_DIR, "kb-selftest-fallback.db");
			removeDbFiles(fallbackDb);
			const brokenEmbedding = stubEmbeddingClient({
				embed: async () => {
					throw new KbError(503, "连不上向量化服务（模拟故障）");
				},
			});
			// 先让库里有一条带向量的块（上传时用正常 stub），再把客户端换成坏的
			const healthy = stubEmbeddingClient();
			const tempStore = createKbStore({ path: fallbackDb });
			const ingestService = createKbService({ store: tempStore, embedding: healthy });
			const fallbackKb = ingestService.createKnowledgeBase({ name: "回退库" });
			await ingestService.ingestDocument({
				kbId: fallbackKb.id,
				filename: "退款.md",
				data: Buffer.from("退款需要审批。"),
			});
			const brokenService = createKbService({ store: tempStore, embedding: brokenEmbedding });
			const response = await brokenService.search(fallbackKb.id, "退款");
			assert.equal(response.mode, "keyword");
			assert.ok(response.results.length >= 1);
			assert.ok(response.fallbackReason?.includes("连不上向量化服务"), response.fallbackReason);
			brokenService.close();
			removeDbFiles(fallbackDb);
		});

		/* ---------- 技能绑定 ---------- */

		await check("绑定：覆盖式设置 + 校验不存在的知识库", () => {
			const second = store.createKnowledgeBase({ name: "运维知识库" });
			const view = service.setSkillBindings("flow_ticket", [kb.id, second.id]);
			assert.deepEqual(view.kbIds, [kb.id, second.id].sort());
			assert.equal(view.knowledgeBases.length, 2);
			const replaced = service.setSkillBindings("flow_ticket", [second.id]);
			assert.deepEqual(replaced.kbIds, [second.id]);
			assert.deepEqual(store.getSkillKbIds("flow_ticket"), [second.id]);
			assert.throws(() => service.setSkillBindings("flow_ticket", ["kb_nope"]), (error: unknown) => {
				return error instanceof KbError && error.status === 400 && error.message.includes("不存在");
			});
			assert.throws(() => service.setSkillBindings("", [kb.id]), (error: unknown) => {
				return error instanceof KbError && error.status === 400;
			});
		});

		await check("绑定：searchForSkill 跨库合并 + topK + 未绑定返回空", async () => {
			service.setSkillBindings("flow_refund", [kb.id]);
			const merged = await service.searchForSkill("flow_refund", "退款", 2);
			assert.equal(merged.mode, "keyword");
			assert.ok(merged.results.length >= 1);
			assert.ok(merged.results.length <= 2);
			assert.deepEqual(merged.kbIds, [kb.id]);
			const unbound = await service.searchForSkill("flow_not_bound", "退款");
			assert.deepEqual(unbound.results, []);
			assert.deepEqual(unbound.kbIds, []);
			// 顶层导出走模块单例：先把它钉到本用例的临时库，
			// 否则 getKb() 会按默认 DB_PATH 打开本机正式库（data/biz-agent.db），断言会读到真实数据
			process.env.DB_PATH = UNIT_DB;
			initKb({ dbPath: UNIT_DB });
			const viaIndex = await searchForSkill("flow_refund", "退款", 1);
			assert.ok(viaIndex.results.length <= 1);
		});

		/* ---------- HTTP ---------- */

		process.env.DB_PATH = HTTP_DB;
		// 单例已经在上一段被钉到 UNIT_DB（为了验顶层导出）；HTTP 用例要自己的库，先关掉再建
		closeKb();
		initKb({ dbPath: HTTP_DB });
		httpServer = createServer((req, res) => {
			void (async () => {
				if (await handleKb(req, res)) {
					return;
				}
				res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
				res.end(JSON.stringify({ error: "宿主没处理" }));
			})().catch((error: unknown) => {
				res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
				res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
			});
		});
		await new Promise<void>((resolveListen) => httpServer!.listen(0, "127.0.0.1", resolveListen));
		const port = (httpServer.address() as AddressInfo).port;
		const baseUrl = `http://127.0.0.1:${port}`;

		async function api<T>(
			pathname: string,
			init: { method?: string; body?: unknown } = {},
		): Promise<{ status: number; body: T }> {
			const response = await fetch(`${baseUrl}${pathname}`, {
				method: init.method ?? "GET",
				headers: { "Content-Type": "application/json" },
				...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
			});
			const text = await response.text();
			return { status: response.status, body: (text.length > 0 ? JSON.parse(text) : {}) as T };
		}

		await check("HTTP：非知识库路径返回 false（宿主继续匹配）", async () => {
			const fakeReq = {
				url: "/api/sessions",
				method: "GET",
				headers: {},
			} as unknown as IncomingMessage;
			let written = false;
			const fakeRes = {
				writeHead: () => {
					written = true;
					return fakeRes;
				},
				end: () => {
					written = true;
				},
			} as unknown as ServerResponse;
			assert.equal(await handleKb(fakeReq, fakeRes), false);
			assert.equal(written, false);
		});

		let httpKbId = "";
		let httpDocId = "";

		await check("HTTP：GET /api/kb 空列表 → 200 []", async () => {
			const response = await api<unknown[]>(`/api/kb`);
			assert.equal(response.status, 200);
			assert.deepEqual(response.body, []);
		});

		await check("HTTP：POST /api/kb 201；缺 name 400 中文", async () => {
			const created = await api<{ id: string; name: string; docCount: number }>(`/api/kb`, {
				method: "POST",
				body: { name: "HTTP 知识库", description: "接口自检" },
			});
			assert.equal(created.status, 201);
			assert.ok(created.body.id.startsWith("kb_"));
			httpKbId = created.body.id;
			assert.equal(created.body.docCount, 0);
			const bad = await api<{ error: string }>(`/api/kb`, { method: "POST", body: {} });
			assert.equal(bad.status, 400);
			assert.ok(bad.body.error.includes("名称不能为空"), bad.body.error);
			const list = await api<unknown[]>(`/api/kb`);
			assert.equal(list.status, 200);
			assert.equal(list.body.length, 1);
		});

		await check("HTTP：上传文档 201 ready，文档列表可见", async () => {
			const content = Buffer.from("# 考勤制度\n\n迟到超过 30 分钟扣款，每月可补卡 3 次。");
			const uploaded = await api<{
				document: { id: string; status: string; filename: string };
				chunkCount: number;
				embedded: boolean;
			}>(`/api/kb/${httpKbId}/documents`, {
				method: "POST",
				body: { filename: "考勤制度.md", contentBase64: content.toString("base64") },
			});
			assert.equal(uploaded.status, 201);
			assert.equal(uploaded.body.document.status, "ready");
			assert.equal(uploaded.body.document.filename, "考勤制度.md");
			assert.ok(uploaded.body.chunkCount >= 1);
			assert.equal(uploaded.body.embedded, false);
			httpDocId = uploaded.body.document.id;

			const documents = await api<{ id: string; chunkCount: number }[]>(
				`/api/kb/${httpKbId}/documents`,
			);
			assert.equal(documents.status, 200);
			assert.equal(documents.body.length, 1);
			assert.equal(documents.body[0]!.id, httpDocId);
		});

		await check("HTTP：POST /api/kb/:id/reindex 未配向量化 → 400 中文", async () => {
			const created = await api<{ id: string }>(`/api/kb`, { method: "POST", body: { name: "重算库" } });
			assert.equal(created.status, 201);
			const response = await api<{ error: string }>(`/api/kb/${created.body.id}/reindex`, { method: "POST", body: {} });
			assert.equal(response.status, 400);
			assert.ok(response.body.error.includes("向量化"), response.body.error);
		});

		await check("HTTP：检索 200 mode=keyword；非法 query 400", async () => {
			const searched = await api<{ mode: string; results: { snippet: string }[] }>(
				`/api/kb/${httpKbId}/search`,
				{ method: "POST", body: { query: "迟到扣款" } },
			);
			assert.equal(searched.status, 200);
			assert.equal(searched.body.mode, "keyword");
			assert.ok(searched.body.results.length >= 1);
			assert.ok(searched.body.results[0]!.snippet.includes("迟到"));
			const bad = await api<{ error: string }>(`/api/kb/${httpKbId}/search`, {
				method: "POST",
				body: { query: "  " },
			});
			assert.equal(bad.status, 400);
		});

		await check("HTTP：GET /api/kb/embedding 如实报告未启用", async () => {
			const info = await api<{ available: boolean; model: string; baseUrl: string }>(
				`/api/kb/embedding`,
			);
			assert.equal(info.status, 200);
			assert.equal(info.body.available, false);
			assert.equal(typeof info.body.model, "string");
			assert.ok(info.body.baseUrl.length > 0);
		});

		await check("HTTP：技能绑定 PUT/GET 与非法 kbIds 400", async () => {
			const put = await api<{ kbIds: string[]; knowledgeBases: unknown[] }>(
				`/api/skills/auto-flow/kb`,
				{ method: "PUT", body: { kbIds: [httpKbId] } },
			);
			assert.equal(put.status, 200);
			assert.deepEqual(put.body.kbIds, [httpKbId]);
			assert.equal(put.body.knowledgeBases.length, 1);
			const got = await api<{ skillId: string; kbIds: string[] }>(`/api/skills/auto-flow/kb`);
			assert.equal(got.status, 200);
			assert.equal(got.body.skillId, "auto-flow");
			assert.deepEqual(got.body.kbIds, [httpKbId]);
			const bad = await api<{ error: string }>(`/api/skills/auto-flow/kb`, {
				method: "PUT",
				body: { kbIds: "not-an-array" },
			});
			assert.equal(bad.status, 400);
			const missing = await api<{ error: string }>(`/api/skills/auto-flow/kb`, {
				method: "PUT",
				body: { kbIds: ["kb_nope"] },
			});
			assert.equal(missing.status, 400);
			assert.ok(missing.body.error.includes("不存在"), missing.body.error);
		});

		await check("HTTP：对话默认检索 GET/PUT、列表带 isDefault、非法入参 400", async () => {
			const empty = await api<{ kbIds: string[] }>(`/api/kb/defaults`);
			assert.equal(empty.status, 200);
			assert.deepEqual(empty.body.kbIds, []);

			const put = await api<{ kbIds: string[]; knowledgeBases: { id: string }[] }>(`/api/kb/defaults`, {
				method: "PUT",
				body: { kbIds: [httpKbId] },
			});
			assert.equal(put.status, 200);
			assert.deepEqual(put.body.kbIds, [httpKbId]);
			assert.equal(put.body.knowledgeBases.length, 1);

			// 列表每行带 isDefault：页面开关直接读它
			const list = await api<{ id: string; isDefault: boolean }[]>(`/api/kb`);
			assert.equal(list.status, 200);
			assert.equal(list.body.find((kb) => kb.id === httpKbId)?.isDefault, true);

			const bad = await api<{ error: string }>(`/api/kb/defaults`, { method: "PUT", body: { kbIds: "x" } });
			assert.equal(bad.status, 400);
			const missing = await api<{ error: string }>(`/api/kb/defaults`, {
				method: "PUT",
				body: { kbIds: ["kb_nope"] },
			});
			assert.equal(missing.status, 400);
			assert.ok(missing.body.error.includes("不存在"), missing.body.error);

			// 清空：库还在，但不再参与对话检索
			const cleared = await api<{ kbIds: string[] }>(`/api/kb/defaults`, { method: "PUT", body: { kbIds: [] } });
			assert.equal(cleared.status, 200);
			assert.equal(cleared.body.kbIds.length, 0);
			const afterClear = await api<{ id: string; isDefault: boolean }[]>(`/api/kb`);
			assert.equal(afterClear.body.find((kb) => kb.id === httpKbId)?.isDefault, false);
		});

		await check("HTTP：未知路径 404、方法不支持 405", async () => {
			const unknown = await api<{ error: string }>(`/api/kb/a/b/c`);
			assert.equal(unknown.status, 404);
			assert.ok(unknown.body.error.includes("知识库接口不存在"), unknown.body.error);
			const wrongMethod = await api<{ error: string }>(`/api/kb`, { method: "PATCH" });
			assert.equal(wrongMethod.status, 405);
		});

		await check("HTTP：删文档 / 删库（级联计数）与重复删除 404", async () => {
			// 再传一份，单独验证 DELETE 文档；剩下的那份留给删库做级联计数
			const extra = await api<{ document: { id: string } }>(`/api/kb/${httpKbId}/documents`, {
				method: "POST",
				body: { filename: "临时.txt", content: "这是一份临时文档，用于验证删除接口。" },
			});
			assert.equal(extra.status, 201);
			const removedDoc = await api<{ removed: boolean; chunksRemoved: number }>(
				`/api/kb/documents/${extra.body.document.id}`,
				{ method: "DELETE" },
			);
			assert.equal(removedDoc.status, 200);
			assert.equal(removedDoc.body.removed, true);
			assert.ok(removedDoc.body.chunksRemoved >= 1);

			const documentsRemovedBefore = await api<{ documentsRemoved: number; chunksRemoved: number }>(
				`/api/kb/${httpKbId}`,
				{ method: "DELETE" },
			);
			assert.equal(documentsRemovedBefore.status, 200);
			assert.equal(documentsRemovedBefore.body.documentsRemoved, 1);
			assert.ok(documentsRemovedBefore.body.chunksRemoved >= 1);
			const again = await api<{ error: string }>(`/api/kb/${httpKbId}`, { method: "DELETE" });
			assert.equal(again.status, 404);
			// 文档随库一起删掉，再单独删文档也应当是 404
			const docDelete = await api<{ error: string }>(`/api/kb/documents/${httpDocId}`, {
				method: "DELETE",
			});
			assert.equal(docDelete.status, 404);
		});

		/* ---------- 建表幂等 ---------- */

		await check("schema：ensureKbSchema 幂等（重复执行不报错）", () => {
			const sqliteCheck = resolve(TMP_DIR, "kb-selftest-schema.db");
			removeDbFiles(sqliteCheck);
			const db = new DatabaseSync(sqliteCheck);
			try {
				ensureKbSchema(db);
				ensureKbSchema(db);
				const tables = (
					db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
				).map((row) => row.name);
				for (const table of ["knowledge_bases", "kb_documents", "kb_chunks", "skill_kb_bindings"]) {
					assert.ok(tables.includes(table), `缺少表 ${table}`);
				}
			} finally {
				db.close();
				removeDbFiles(sqliteCheck);
			}
		});

		/* ---------- kb_search 工具（会话级内置工具） ---------- */

		// 工具执行时走 kb 模块的单例（createKbSearchTool → searchForSkill → getKb()），
		// 所以先把单例切到一份一次性库文件；HTTP 段已经跑完，换库不影响它。
		closeKb();
		removeDbFiles(TOOL_DB);
		const toolService = initKb({ dbPath: TOOL_DB });

		const refundKb = toolService.createKnowledgeBase({ name: "工具检索库" });
		const attendanceKb = toolService.createKnowledgeBase({ name: "隔离对照库" });
		// 小粒度分块 + 0 重叠：每段都自成一（<250 字符），用来验证 topK 的默认值与上下限
		const bulkKb = toolService.createKnowledgeBase({ name: "多块库", chunkSize: 250, chunkOverlap: 0 });

		const toolRefundDocument = await toolService.ingestDocument({
			kbId: refundKb.id,
			filename: "退款流程.md",
			data: Buffer.from("# 退款流程\n\n退款需要财务审批，3 个工作日内到账。\n\n提交退款申请后可在订单页查询进度。"),
		});
		await toolService.ingestDocument({
			kbId: refundKb.id,
			filename: "发票说明.md",
			data: Buffer.from("# 发票开具\n\n发票在订单完成后开具，可下载电子发票。"),
		});
		await toolService.ingestDocument({
			kbId: attendanceKb.id,
			filename: "考勤制度.md",
			data: Buffer.from("# 考勤制度\n\n迟到超过 30 分钟扣款，每月可补卡 3 次。"),
		});
		const bulkSentence =
			"考勤以打卡记录为准，员工应当在每个工作日上下班各打卡一次，忘记打卡需要在当日内提交补卡申请并说明原因。";
		const bulkParagraphs = Array.from(
			{ length: 25 },
			(_, index) =>
				`第 ${index + 1} 条考勤规则：${bulkSentence}${bulkSentence}${bulkSentence}（编号 ${index + 1}）`,
		);
		await toolService.ingestDocument({
			kbId: bulkKb.id,
			filename: "考勤细则.md",
			data: Buffer.from(`# 考勤细则\n\n${bulkParagraphs.join("\n\n")}`),
		});

		toolService.setSkillBindings("flow_refund_tool", [refundKb.id]);
		toolService.setSkillBindings("flow_attendance_tool", [attendanceKb.id]);
		toolService.setSkillBindings("flow_bulk_tool", [bulkKb.id]);

		const kbTool = createKbSearchTool({ getActiveSkillId: () => "flow_refund_tool" });
		const toolCtx = {
			tenantId: "tenant-demo",
			userId: "u-001",
			traceId: "trace-kb-selftest",
			allow: ["*"],
			requireApproval: [],
		};
		const runTool = async (
			tool: ReturnType<typeof createKbSearchTool>,
			args: Record<string, unknown>,
		): Promise<string> => {
			const result = await tool.execute(args, toolCtx);
			return result.content;
		};
		const countFragments = (text: string): number => (text.match(/\[片段 \d+\]/g) ?? []).length;

		await check("工具：kb_search 契约（名称/中文描述/参数 schema/风险/示例）", () => {
			assert.equal(KB_SEARCH_TOOL_NAME, "kb_search");
			assert.equal(kbTool.name, "kb_search");
			assert.equal(kbTool.category, "知识库");
			assert.equal(kbTool.risk, "low");
			assert.ok(/[\u4e00-\u9fff]/.test(kbTool.description), "description 应当有中文说明");
			const parameters = kbTool.parameters as {
				type: string;
				properties: Record<string, Record<string, unknown>>;
				required: string[];
			};
			assert.equal(parameters.type, "object");
			assert.deepEqual(parameters.required, ["query"]);
			assert.equal(parameters.properties.query!.type, "string");
			assert.equal(parameters.properties.topK!.type, "number");
			assert.equal(parameters.properties.topK!.minimum, 1);
			assert.equal(parameters.properties.topK!.maximum, 20);
			assert.equal(parameters.properties.topK!.default, 5);
			assert.equal(kbTool.example?.query, "退款多久到账");
		});

		await check("Pi 扩展：真实 AgentSession 加载并调用 Pi 原生 kb_search 工具", async () => {
			const model = {
				id: "kb-pi-selftest",
				name: "KB Pi selftest",
				api: "openai-completions" as const,
				provider: "kb-pi-selftest",
				baseUrl: "http://127.0.0.1:9/v1",
				reasoning: false,
				input: ["text"] as ("text")[],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 4096,
				maxTokens: 512,
			};
			const agent = new Agent({
				streamFn: () => { throw new Error("Pi extension selftest must not call a model"); },
				initialState: { model, systemPrompt: "KB extension selftest", tools: [] },
			});
			const loader = new DefaultResourceLoader({
				cwd: process.cwd(),
				agentDir: process.cwd(),
				settingsManager: SettingsManager.inMemory(),
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
				extensionFactories: [createKbPiExtension({ getActiveSkillId: () => "flow_refund_tool" })],
			});
			await loader.reload();
			const session = new AgentSession({
				agent,
				sessionManager: createPiSessionHistory({ sessionId: "kb-pi-extension-selftest" }),
				settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
				cwd: process.cwd(),
				resourceLoader: loader,
				modelRuntime: {
					getModel: () => model,
					getPhysicalModel: () => model,
					getModels: () => [model],
					getAvailableSnapshot: () => [model],
					hasConfiguredAuth: () => true,
					checkAuth: async () => ({}),
					isUsingOAuth: () => false,
					getAuth: async () => ({ auth: { apiKey: "test-only" } }),
					getError: () => undefined,
					getProvider: () => undefined,
					getModelOfType: () => undefined,
					getCompatibilityRequestConfig: () => ({}),
					getProviderAuthStatus: () => ({ configured: true }),
					refresh: async () => ({ added: 0, removed: 0, updated: 0 }),
				} as never,
				initialActiveToolNames: [KB_SEARCH_TOOL_NAME],
			});
			try {
				assert.ok(session.getAllTools().some((tool) => tool.name === KB_SEARCH_TOOL_NAME));
				const definition = session.getToolDefinition(KB_SEARCH_TOOL_NAME);
				assert.ok(definition, "Pi registers the kb_search definition");
				const result = await definition.execute("kb-call", { query: "退款" }, undefined, undefined, {} as never);
				const text = result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
				assert.ok(text.includes("退款流程.md"), text);
				assert.ok(text.includes(`[kb:${refundKb.id} doc:${toolRefundDocument.document.id} chunk:`), text);
				assert.ok(text.includes("3 个工作日内到账"), text);
				assert.ok(!agent.state.messages.some((message) => message.role === "user"), "calling the Pi tool directly does not append a user turn");
			} finally {
				session.dispose();
			}
		});

		await check("工具：绑定知识库后命中，文本含片段编号/文件名/标题/模式与条数", async () => {
			const text = await runTool(kbTool, { query: "退款" });
			assert.ok(text.includes(`[片段 1] [kb:${refundKb.id} doc:${toolRefundDocument.document.id} chunk:`), text);
			assert.ok(text.includes("《退款流程.md》 · 退款流程"), text);
			assert.ok(text.includes("退款需要财务审批"), text);
			assert.ok(text.includes("（关键词检索，共 1 条）"), text);
		});

		await check("工具：没有可检索的库时返回中文说明，不抛错", async () => {
			const unbound = createKbSearchTool({ getActiveSkillId: () => "flow_without_kb" });
			const unboundText = await runTool(unbound, { query: "退款" });
			assert.ok(unboundText.includes("没有可检索的知识库"), unboundText);
			assert.equal(unboundText.includes("[片段"), false);

			// 没加载技能、也没有「对话默认检索」的库：同样只是一句说明
			const noSkill = createKbSearchTool({ getActiveSkillId: () => null });
			const noSkillText = await runTool(noSkill, { query: "退款" });
			assert.ok(noSkillText.includes("没有可检索的知识库"), noSkillText);
		});

		await check("对话默认检索：不加载技能也能查到资料（RAG）", async () => {
			toolService.setDefaultBindings([refundKb.id]);
			const noSkill = createKbSearchTool({ getActiveSkillId: () => null });
			const text = await runTool(noSkill, { query: "退款" });
			assert.ok(text.includes("退款流程.md"), text);
			assert.ok(text.includes("（关键词检索，共 1 条）"), text);

			// 没传技能 id 也要能查：不能因为"没加载技能"就退化
			const emptySkill = createKbSearchTool({ getActiveSkillId: () => "" });
			const emptyText = await runTool(emptySkill, { query: "退款" });
			assert.ok(emptyText.includes("退款流程.md"), emptyText);
		});

		await check("对话默认检索：技能绑定优先，不被默认库污染", async () => {
			toolService.setDefaultBindings([refundKb.id]);
			const attendance = createKbSearchTool({ getActiveSkillId: () => "flow_attendance_tool" });
			const text = await runTool(attendance, { query: "退款" });
			assert.equal(text.includes("退款流程.md"), false, "技能绑了考勤库时不应该查默认的退款库");
			assert.ok(text.includes("没有找到相关内容"), text);
		});

		await check("对话默认检索：覆盖式设置、校验不存在的库、删除库后自动剔除", () => {
			const created = toolService.createKnowledgeBase({ name: "临时默认库" });
			toolService.setDefaultBindings([refundKb.id, created.id]);
			assert.deepEqual(toolService.getDefaultBindings().kbIds.slice().sort(), [refundKb.id, created.id].sort());

			// 再设一次就是整体覆盖，不是追加
			toolService.setDefaultBindings([attendanceKb.id]);
			assert.deepEqual(toolService.getDefaultBindings().kbIds, [attendanceKb.id]);
			assert.equal(toolService.getDefaultBindings().knowledgeBases[0]?.name, "隔离对照库");

			assert.throws(() => toolService.setDefaultBindings(["kb_not_exists"]), /这些知识库不存在/);

			// 库被删掉后，残留绑定不能让检索 404：getDefaultKbIds 直接过滤掉
			toolService.setDefaultBindings([refundKb.id, created.id]);
			toolService.removeKnowledgeBase(created.id);
			assert.deepEqual(toolService.getDefaultBindings().kbIds, [refundKb.id]);
			toolService.setDefaultBindings([]);
			assert.equal(toolService.getDefaultBindings().kbIds.length, 0);
		});


		await check("Agent 绑定：技能没绑时用 Agent 的库（第二优先级）", async () => {
			toolService.setDefaultBindings([attendanceKb.id]);
			// 技能没绑库、Agent 绑了退款库：应该查 Agent 的库，而不是落回默认的考勤库
			const tool = createKbSearchTool({
				getActiveSkillId: () => "flow_without_kb",
				getAgentKbIds: () => [refundKb.id],
			});
			const text = await runTool(tool, { query: "退款" });
			assert.ok(text.includes("退款流程.md"), text);
		});

		await check("Agent 绑定：技能绑定优先于 Agent 绑定（第一优先级）", async () => {
			// 技能绑了考勤库、Agent 绑了退款库：技能更具体，必须赢
			const tool = createKbSearchTool({
				getActiveSkillId: () => "flow_attendance_tool",
				getAgentKbIds: () => [refundKb.id],
			});
			const text = await runTool(tool, { query: "退款" });
			assert.equal(text.includes("退款流程.md"), false, "技能绑了库时不该被 Agent 的库盖过");
			assert.ok(text.includes("没有找到相关内容"), text);
		});

		await check("Agent 绑定：空绑定视为没绑，落回对话默认（不挡掉默认库）", async () => {
			toolService.setDefaultBindings([refundKb.id]);
			const empty = createKbSearchTool({ getActiveSkillId: () => null, getAgentKbIds: () => [] });
			const emptyText = await runTool(empty, { query: "退款" });
			assert.ok(emptyText.includes("退款流程.md"), "空数组不能让默认库失效");

			// 全是空白串的绑定同样按"没绑"处理
			const blank = createKbSearchTool({ getActiveSkillId: () => null, getAgentKbIds: () => ["  "] });
			const blankText = await runTool(blank, { query: "退款" });
			assert.ok(blankText.includes("退款流程.md"), blankText);
		});

		await check("Agent 绑定：声明了不存在的库 → 空结果说明，不抛错", async () => {
			toolService.setDefaultBindings([]);
			const tool = createKbSearchTool({
				getActiveSkillId: () => null,
				getAgentKbIds: () => ["kb_not_exists"],
			});
			const text = await runTool(tool, { query: "退款" });
			assert.ok(text.includes("没有可检索的知识库"), text);
		});
		await check("工具：已绑定但没有命中 → 中文说明（空结果不报错）", async () => {
			const text = await runTool(kbTool, { query: "量子纠缠" });
			assert.ok(text.includes("没有找到相关内容"), text);
			assert.ok(text.includes("1 个知识库"), text);
			assert.ok(text.includes("量子纠缠"), text);
			assert.equal(text.includes("[片段"), false);
		});

		await check("工具：topK 默认 5、上限裁剪到 20、下限裁剪到 1、非数字回落默认", async () => {
			assert.ok(toolService.store.countChunks(bulkKb.id) >= 21, "夹具应当产出至少 21 个块");
			const bulk = createKbSearchTool({ getActiveSkillId: () => "flow_bulk_tool" });
			const defaults = await runTool(bulk, { query: "考勤" });
			assert.equal(countFragments(defaults), 5, "不传 topK 时默认 5 条");
			assert.ok(defaults.includes("共 5 条"), defaults);
			const capped = await runTool(bulk, { query: "考勤", topK: 99 });
			assert.equal(countFragments(capped), 20, "topK 上限应当裁剪到 20");
			assert.ok(capped.includes("共 20 条"), capped);
			const floored = await runTool(bulk, { query: "考勤", topK: 0 });
			assert.equal(countFragments(floored), 1, "topK 下限应当裁剪到 1");
			const garbage = await runTool(bulk, { query: "考勤", topK: "不是数字" });
			assert.equal(countFragments(garbage), 5, "topK 非数字回落默认 5");
		});

		await check("工具：空检索词返回中文提示，不抛错", async () => {
			const blank = await runTool(kbTool, { query: "   " });
			assert.ok(blank.includes("检索词不能为空"), blank);
			const missing = await runTool(kbTool, {});
			assert.ok(missing.includes("检索词不能为空"), missing);
		});

		await check("工具：技能隔离——只检索当前技能绑定的库", async () => {
			const attendance = createKbSearchTool({ getActiveSkillId: () => "flow_attendance_tool" });
			const text = await runTool(attendance, { query: "考勤" });
			assert.ok(text.includes("考勤制度.md"), text);
			assert.equal(text.includes("退款流程.md"), false);
			const refundText = await runTool(kbTool, { query: "考勤" });
			assert.ok(refundText.includes("没有找到相关内容"), refundText);
		});

		await check("工具：调用时实时读 getActiveSkillId（换技能后跟着走）", async () => {
			let active = "flow_refund_tool";
			const dynamic = createKbSearchTool({ getActiveSkillId: () => active });
			const before = await runTool(dynamic, { query: "退款" });
			assert.ok(before.includes("退款流程.md"), before);
			active = "flow_attendance_tool";
			const after = await runTool(dynamic, { query: "退款" });
			assert.ok(after.includes("没有找到相关内容"), after);
			assert.equal(after.includes("退款流程.md"), false);
			active = "flow_bulk_tool";
			const bulkText = await runTool(dynamic, { query: "考勤", topK: 1 });
			assert.ok(bulkText.includes("考勤细则.md"), bulkText);
			assert.equal(countFragments(bulkText), 1);
		});

		console.log(`\n知识库自检通过：${passed} 项`);
	} finally {
		if (httpServer) {
			await new Promise<void>((resolveClose) => httpServer!.close(() => resolveClose()));
		}
		closeKb();
		store.close();
		removeDbFiles(UNIT_DB);
		removeDbFiles(HTTP_DB);
		removeDbFiles(TOOL_DB);
	}
}

main().catch((error: unknown) => {
	console.error("\n知识库自检失败：", error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
