/**
 * 解析：文件字节 → 纯文本。
 *
 * 支持 `.txt / .md / .markdown / .csv`（原生）+ `.pdf`（unpdf）+ `.docx`（mammoth）。
 * 两个依赖都是纯 JS、无 native 编译、不 spawn 子进程，`npm install` 完就能跑；
 * 只在真正需要时动态 import，避免每次启动都加载 pdf.js。
 *
 * 失败一律抛 `KbError`（中文文案，直接能上界面）；大小上限 20 MB、解析超时 60s。
 */

import { KbError, badRequest, tooLarge } from "./errors.js";
import { normalizeText } from "./chunk.js";

/** 解析上限：20 MB / 60 秒（与任务规格一致）。 */
export const PARSE_LIMITS = {
	maxBytes: 20 * 1024 * 1024,
	timeoutMs: 60_000,
} as const;

/** 支持的扩展名 → 内部 kind。 */
const TEXT_KINDS = new Set(["txt", "md", "markdown", "csv"]);

export type DocumentKind = "txt" | "md" | "markdown" | "csv" | "pdf" | "docx";

export interface ParsedDocument {
	text: string;
	meta: {
		/** 优先取文档内部标题（PDF 元数据 / Markdown 首个一级标题），否则用文件名 */
		title?: string;
		/** 页数，只有 PDF 有 */
		pages?: number;
		kind: DocumentKind;
	};
}

/** 扩展名（小写、不含点）；没有则空串。 */
export function extensionOf(filename: string): string {
	const dot = filename.lastIndexOf(".");
	if (dot < 0 || dot === filename.length - 1) {
		return "";
	}
	return filename.slice(dot + 1).toLowerCase();
}

/** 文件名去扩展名，当作标题兜底。 */
export function baseName(filename: string): string {
	const dot = filename.lastIndexOf(".");
	return (dot > 0 ? filename.slice(0, dot) : filename).trim() || "未命名文档";
}

/**
 * 判断文档类型：先看扩展名，再按魔数兜底（真实场景里 .pdf 被改名、邮件附件标错扩展名都常见）。
 * 明确不支持的老格式（.doc）单独给一条可操作的中文提示。
 */
export function detectKind(filename: string, data: Uint8Array): DocumentKind | null {
	const ext = extensionOf(filename);
	if (TEXT_KINDS.has(ext)) {
		return ext as DocumentKind;
	}
	if (ext === "pdf" || ext === "docx") {
		return ext;
	}
	if (ext === "doc") {
		// 有些系统把 .docx 存成 .doc；内容对得上（zip 魔数）就当 docx 读，对不上就让用户另存
		return sniffMagic(data) === "docx" ? "docx" : null;
	}
	// 只有"没有扩展名"时才猜类型：.xlsx/.pptx 也是 zip，按魔数猜会把它们当 docx 硬读
	if (ext === "") {
		return sniffMagic(data);
	}
	return null;
}

/** 按文件头判断 PDF / DOCX；判断不出返回 null。 */
function sniffMagic(data: Uint8Array): DocumentKind | null {
	const head = Buffer.from(data.subarray(0, 8));
	if (head.subarray(0, 4).toString("latin1") === "%PDF") {
		return "pdf";
	}
	if (head[0] === 0x50 && head[1] === 0x4b) {
		// ZIP（docx 就是 zip）；只认 PK\x03\x04 开头，避免把别的 zip 当文档
		return head[2] === 0x03 && head[3] === 0x04 ? "docx" : null;
	}
	return null;
}

/** 中文大小描述，报错时给用户看。 */
function formatBytes(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes} 字节`;
	}
	if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)} KB`;
	}
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 给解析加超时：底层（pdf.js / mammoth）没有 abort 接口，只能放弃等待。 */
async function withTimeout<T>(task: Promise<T>, ms: number, message: string): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			task,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(badRequest(message)), ms);
				timer.unref?.();
			}),
		]);
	} finally {
		if (timer) {
			clearTimeout(timer);
		}
	}
}

/* ---------------- CSV ---------------- */

export interface CsvParseResult {
	/** 拼成「表头行 + 每行 `列: 值；列: 值`」，让关键词检索也能命中列名 */
	text: string;
	header: string[];
	rows: number;
}

/** 按第一行出现最多的候选分隔符切（逗号 / 分号 / 制表符 / 竖线）。 */
function detectDelimiter(line: string): string {
	const candidates = [",", ";", "\t", "|"];
	let best = ",";
	let bestCount = 0;
	for (const candidate of candidates) {
		const count = line.split(candidate).length - 1;
		if (count > bestCount) {
			best = candidate;
			bestCount = count;
		}
	}
	return best;
}

/** 拆一行 CSV：支持双引号包裹、`""` 转义；不处理引号里的换行（简单实现，够业务表格用）。 */
export function splitCsvLine(line: string, delimiter: string): string[] {
	const cells: string[] = [];
	let current = "";
	let quoted = false;
	for (let i = 0; i < line.length; i++) {
		const char = line[i]!;
		if (char === '"') {
			if (quoted && line[i + 1] === '"') {
				current += '"';
				i++;
				continue;
			}
			quoted = !quoted;
			continue;
		}
		if (char === delimiter && !quoted) {
			cells.push(current.trim());
			current = "";
			continue;
		}
		current += char;
	}
	cells.push(current.trim());
	return cells;
}

/**
 * CSV → 可检索文本。首行当表头，每行拼成 `姓名: 张三；部门: 研发`，
 * 同时保留一行表头，保证「按列名搜」也能命中。
 */
export function parseCsvToText(raw: string): CsvParseResult {
	const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
	if (lines.length === 0) {
		return { text: "", header: [], rows: 0 };
	}
	const delimiter = detectDelimiter(lines[0]!);
	const header = splitCsvLine(lines[0]!, delimiter).map((cell) => cell.trim());
	const body: string[] = [];
	for (const line of lines.slice(1)) {
		const cells = splitCsvLine(line, delimiter);
		const pairs: string[] = [];
		for (let i = 0; i < Math.max(cells.length, header.length); i++) {
			const name = header[i] || `列${i + 1}`;
			const value = (cells[i] ?? "").trim();
			if (value.length > 0) {
				pairs.push(`${name}: ${value}`);
			}
		}
		if (pairs.length > 0) {
			body.push(pairs.join("；"));
		}
	}
	const text = [header.join(" | "), ...body].filter((line) => line.trim().length > 0).join("\n");
	return { text, header, rows: body.length };
}

/* ---------------- 各格式解析 ---------------- */

/** UTF-8 解码 + 二进制嗅探（解码后替换符太多 / 含 NUL 就认为是二进制）。 */
export function decodeText(data: Uint8Array): string {
	const text = new TextDecoder("utf-8", { fatal: false }).decode(data);
	let replacement = 0;
	for (const char of text) {
		if (char === "\uFFFD") {
			replacement++;
		}
	}
	const ratio = text.length > 0 ? replacement / text.length : 0;
	if (data.includes(0) || ratio > 0.02) {
		throw badRequest("文件不是 UTF-8 文本（看起来是二进制文件），请上传 PDF / Word / Markdown / TXT / CSV");
	}
	return text.replace(/^\uFEFF/, "");
}

/** Markdown 首个一级标题，没有再看二级。 */
function firstMarkdownHeading(text: string): string | undefined {
	for (const line of text.split("\n")) {
		const match = /^ {0,3}#{1,2}\s+(.+?)\s*#*\s*$/.exec(line);
		if (match) {
			return match[1]!.trim();
		}
	}
	return undefined;
}

function parseTextDocument(filename: string, data: Uint8Array, kind: DocumentKind): ParsedDocument {
	const raw = decodeText(data);
	if (kind === "csv") {
		const csv = parseCsvToText(raw);
		const text = normalizeText(csv.text);
		if (text.length === 0) {
			throw badRequest(`CSV「${filename}」里没有可用的数据（至少要有表头和数据行）`);
		}
		return { text, meta: { title: baseName(filename), kind } };
	}
	const text = normalizeText(raw);
	if (text.length === 0) {
		throw badRequest(`文件「${filename}」里没有可读的文字（可能是空文件）`);
	}
	const title = kind === "md" || kind === "markdown" ? (firstMarkdownHeading(text) ?? baseName(filename)) : baseName(filename);
	return { text, meta: { title, kind } };
}

async function parsePdf(filename: string, data: Uint8Array): Promise<ParsedDocument> {
	// 动态 import：只有用户真的上传 PDF 时才加载 pdf.js（几 MB，启动时没必要）
	const { extractText, getDocumentProxy } = await import("unpdf");
	const document = await withTimeout(
		getDocumentProxy(new Uint8Array(data)),
		PARSE_LIMITS.timeoutMs,
		`解析 PDF「${filename}」超时（超过 60 秒），文件可能太大或损坏`,
	);

	let pages = 0;
	let text = "";
	let title = baseName(filename);
	try {
		const result = await withTimeout(
			extractText(document, { mergePages: true }),
			PARSE_LIMITS.timeoutMs,
			`解析 PDF「${filename}」超时（超过 60 秒），文件可能太大或损坏`,
		);
		pages = result.totalPages;
		text = result.text;
		// 元数据必须在 destroy 之前读，destroy 之后拿不到
		try {
			const metadata = await document.getMetadata();
			const info = metadata.info as { Title?: unknown } | undefined;
			if (info && typeof info.Title === "string" && info.Title.trim().length > 0) {
				title = info.Title.trim();
			}
		} catch {
			// 元数据读不到就用文件名
		}
	} catch (error) {
		if (error instanceof KbError) {
			throw error;
		}
		throw badRequest(`这个 PDF 打不开或已损坏：${filename}（${errorMessageOf(error)}）`);
	} finally {
		try {
			// unpdf 的类型声明里没有暴露 destroy（运行时是 pdf.js 的 PDFDocumentProxy，有这个方法）
			await (document as unknown as { destroy?: () => Promise<void> }).destroy?.();
		} catch {
			// 关闭失败不影响已经拿到的文本
		}
	}

	const normalized = normalizeText(text);
	if (normalized.length === 0) {
		// 扫描件是 PDF 最常见的「解析成功但没字」情形，直接告诉用户为什么
		throw badRequest(`这个 PDF 没读到文字，可能是扫描件（暂不支持 OCR）：${filename}`);
	}

	return { text: normalized, meta: { title, pages, kind: "pdf" } };
}

async function parseDocx(filename: string, data: Uint8Array): Promise<ParsedDocument> {
	const mammothModule = await import("mammoth");
	const mammoth = (mammothModule as { default?: { extractRawText: typeof mammothModule.extractRawText } }).default ??
		mammothModule;
	let raw = "";
	try {
		const result = await withTimeout(
			mammoth.extractRawText({ buffer: Buffer.from(data) }),
			PARSE_LIMITS.timeoutMs,
			`解析 Word「${filename}」超时（超过 60 秒），文件可能太大或损坏`,
		);
		raw = result.value;
	} catch (error) {
		if (error instanceof KbError) {
			throw error;
		}
		throw badRequest(`这个 Word 文档打不开或已损坏：${filename}（${errorMessageOf(error)}）`);
	}
	const text = normalizeText(raw);
	if (text.length === 0) {
		throw badRequest(`这个 Word 文档没读到文字（可能只有图片或表格对象）：${filename}`);
	}
	// Word 没有可靠的「标题」元数据（mammoth 的 extractRawText 只给正文），用文件名
	return { text, meta: { title: baseName(filename), kind: "docx" } };
}

function errorMessageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * 统一入口：字节 → 文本 + 元数据。
 * @throws KbError 413 太大 / 400 不支持的格式、解析失败、没有文字、超时
 */
export async function parseDocument(input: {
	filename: string;
	data: Uint8Array | Buffer;
}): Promise<ParsedDocument> {
	const filename = (input.filename ?? "").trim();
	if (filename.length === 0) {
		throw badRequest("缺少文件名，无法判断文档类型");
	}
	const data = input.data instanceof Uint8Array ? input.data : new Uint8Array(input.data);
	if (data.byteLength === 0) {
		throw badRequest(`文件「${filename}」是空的（0 字节）`);
	}
	if (data.byteLength > PARSE_LIMITS.maxBytes) {
		throw tooLarge(
			`文件「${filename}」超过 20 MB 上限（当前 ${formatBytes(data.byteLength)}），请拆分后再上传`,
		);
	}

	const kind = detectKind(filename, data);
	if (!kind) {
		const ext = extensionOf(filename);
		if (ext === "doc") {
			throw badRequest(`暂不支持老的 .doc 格式：${filename}。请用 Word 另存为 .docx 后再上传`);
		}
		throw badRequest(
			`暂不支持「${ext ? `.${ext}` : "未知"}」文件：${filename}。请上传 PDF / Word(.docx) / Markdown / TXT / CSV`,
		);
	}

	if (kind === "pdf") {
		return parsePdf(filename, data);
	}
	if (kind === "docx") {
		return parseDocx(filename, data);
	}
	return parseTextDocument(filename, data, kind);
}
