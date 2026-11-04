/**
 * 分块：把整份文档文字切成「标题 + 段落 + 长度」的块。
 *
 * 参数（路线图 P5 定的）：目标 800 字符、相邻块重叠 120 字符、硬上限 2000 字符。
 * 纯函数，不碰 IO —— 单测直接喂字符串即可。
 *
 * 设计取舍：
 *   - **按段落装**：段落（空行分隔）是天然的语义边界，比按固定长度硬切更容易命中。
 *   - **标题换了就断块**：一个块只挂一个 heading，否则检索结果里的「所属小节」会骗人。
 *   - **重叠只在同一标题内**：跨标题重叠会把上一节的内容带进下一节，反而污染检索。
 *   - **tokens 是粗估**：`ceil(字符数 / 1.6)`，中文约 1.6 字符/token；只用于展示与成本预估。
 */

/** 分块默认参数。 */
export const CHUNK_DEFAULTS = {
	chunkSize: 800,
	overlap: 120,
	maxChars: 2000,
} as const;

export interface ChunkOptions {
	text: string;
	/** 目标块大小（字符），默认 800 */
	chunkSize?: number;
	/** 相邻块重叠（字符），默认 120；超过 chunkSize 一半会被压回去 */
	overlap?: number;
	/** 硬上限（字符），默认 2000 */
	maxChars?: number;
}

/** 一个块。seq 从 1 开始（界面上「第 N 块」直接可用）。 */
export interface TextChunk {
	seq: number;
	heading: string | null;
	content: string;
	tokens: number;
}

/** 粗估 token 数：中文 ~1.6 字符一个 token，英文偏低，够用。 */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 1.6);
}

/**
 * 文本规范化：统一换行、去零宽字符/BOM、去行尾空白、压缩连续空行。
 * 解析层与分块层共用这一份，避免两处规则不一致。
 */
export function normalizeText(text: string): string {
	return text
		.replace(/^\uFEFF/, "")
		.replace(/\r\n?/g, "\n")
		.replace(/[\u200B-\u200D\uFEFF]/g, "")
		.replace(/[ \t\u00A0]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** markdown 的 ATX 标题：`# 一级`、`## 二级`……（代码块里的 # 不识别，见 splitBlocks）。 */
const HEADING_PATTERN = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
/** 句末标点与换行：超长段落优先在这些位置切。 */
const SENTENCE_END = /[。！？；!?;\n]/;
/** 重叠尾巴的断点：别让块从半个词/半句话开始。 */
const BREAK_PATTERN = /[\s，。；、！？：,.!?;:]/;

interface Block {
	heading: string | null;
	text: string;
}

/**
 * 按空行切段落，顺带记录最近的 markdown 标题。
 * 围栏代码块（```）里的行原样当作正文，不把以 # 开头的注释误判成标题。
 */
function splitBlocks(text: string): Block[] {
	const blocks: Block[] = [];
	let heading: string | null = null;
	let paragraph: string[] = [];
	let inFence = false;

	const flushParagraph = (): void => {
		if (paragraph.length === 0) {
			return;
		}
		const joined = paragraph.join("\n").trim();
		paragraph = [];
		if (joined.length > 0) {
			blocks.push({ heading, text: joined });
		}
	};

	for (const line of text.split("\n")) {
		if (/^ {0,3}```/.test(line)) {
			inFence = !inFence;
			flushParagraph();
			paragraph.push(line);
			continue;
		}
		if (!inFence) {
			const headingMatch = HEADING_PATTERN.exec(line);
			if (headingMatch) {
				flushParagraph();
				heading = headingMatch[2]!.trim();
				continue;
			}
		}
		if (line.trim() === "") {
			flushParagraph();
			continue;
		}
		paragraph.push(line);
	}
	flushParagraph();
	return blocks;
}

/** 把超硬上限的段落切开：优先句末标点，其次换行，最后才硬切。 */
export function splitOversized(text: string, maxChars: number): string[] {
	if (text.length <= maxChars) {
		return [text];
	}
	const pieces: string[] = [];
	let rest = text;
	while (rest.length > maxChars) {
		let cut = -1;
		for (let i = maxChars - 1; i >= Math.floor(maxChars * 0.6); i--) {
			if (SENTENCE_END.test(rest[i]!)) {
				cut = i + 1;
				break;
			}
		}
		if (cut <= 0) {
			const newline = rest.lastIndexOf("\n", maxChars - 1);
			cut = newline > 0 ? newline : maxChars;
		}
		pieces.push(rest.slice(0, cut).trim());
		rest = rest.slice(cut).trimStart();
	}
	if (rest.trim().length > 0) {
		pieces.push(rest.trim());
	}
	return pieces.filter((piece) => piece.length > 0);
}

/** 取上一块的尾巴做重叠；尽量从分隔符之后开始，避免半句话。 */
function overlapTail(content: string, overlap: number): string {
	if (overlap <= 0) {
		return "";
	}
	const tail = content.slice(-overlap);
	const match = BREAK_PATTERN.exec(tail);
	if (match && match.index >= 0 && match.index < tail.length - 8) {
		return tail.slice(match.index + 1).trim();
	}
	return tail.trim();
}

/**
 * 分块主函数。
 * 空文本 / 只有空白 → 空数组（上层据此报「文档里没有可读的文字」）。
 */
export function chunkText(input: ChunkOptions): TextChunk[] {
	const chunkSize = Math.max(120, Math.floor(input.chunkSize ?? CHUNK_DEFAULTS.chunkSize));
	const overlap = Math.min(
		Math.max(0, Math.floor(input.overlap ?? CHUNK_DEFAULTS.overlap)),
		Math.floor(chunkSize / 2),
	);
	const maxChars = Math.max(chunkSize, Math.floor(input.maxChars ?? CHUNK_DEFAULTS.maxChars));

	const text = normalizeText(input.text);
	if (text.length === 0) {
		return [];
	}

	const chunks: TextChunk[] = [];
	let buffer = "";
	let bufferHeading: string | null = null;

	const emit = (content: string, heading: string | null): void => {
		const trimmed = content.trim();
		if (trimmed.length === 0) {
			return;
		}
		chunks.push({
			seq: chunks.length + 1,
			heading,
			content: trimmed,
			tokens: estimateTokens(trimmed),
		});
	};

	// 返回重叠尾巴，方便调用方决定要不要接到下一块开头
	const flush = (): string => {
		const content = buffer.trim();
		emit(content, bufferHeading);
		buffer = "";
		return overlapTail(content, overlap);
	};

	for (const block of splitBlocks(text)) {
		if (buffer.length > 0 && bufferHeading !== block.heading) {
			flush();
			buffer = "";
		}
		if (buffer.length === 0) {
			bufferHeading = block.heading;
		}
		// 段落超过目标大小就按句子切（"段落优先"不等于"一段一整块"，
		// 1500 字的大段落直接塞成一个块，召回和向量都不好）
		for (const piece of splitOversized(block.text, chunkSize)) {
			if (buffer.length > 0 && buffer.length + 2 + piece.length > chunkSize) {
				const tail = flush();
				// 重叠尾巴 + 新段落不能超过硬上限，否则宁可丢掉重叠
				buffer = tail.length > 0 && tail.length + 2 + piece.length <= maxChars ? tail : "";
			}
			buffer = buffer.length === 0 ? piece : `${buffer}\n\n${piece}`;
			// 兜底：理论上不会触发（piece ≤ maxChars），但绝不产出超过硬上限的块
			while (buffer.length > maxChars) {
				emit(buffer.slice(0, maxChars), bufferHeading);
				buffer = buffer.slice(maxChars).trimStart();
			}
		}
	}
	if (buffer.trim().length > 0) {
		emit(buffer, bufferHeading);
	}

	// 末尾碎块（<20 字符）能并进上一块就并，省得检索结果里全是「以上。」这种块
	const last = chunks[chunks.length - 1];
	const previous = chunks[chunks.length - 2];
	if (last && previous && last.content.length < 20 && previous.heading === last.heading) {
		const merged = `${previous.content}\n\n${last.content}`;
		if (merged.length <= maxChars) {
			previous.content = merged;
			previous.tokens = estimateTokens(merged);
			chunks.pop();
		}
	}

	return chunks;
}
