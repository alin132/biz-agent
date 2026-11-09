/**
 * 检索：向量、关键词和混合三种模式，返回结构统一，`mode` 如实反映实际召回路径。
 *
 * 有 embedding：向量与关键词分别取候选，再用 RRF 融合，避免未向量化块漏召回。
 * 向量候选按后端余弦相似度与阈值排名（Postgres 下推 pgvector）。
 * 无 embedding（或向量化失败）：关键词检索 —— 分词 + `LIKE` 命中 + 词频打分，中文用 2-gram 兜底。
 *
 * 打分/切片都是纯函数，方便单测；只有 `searchInKnowledgeBase` 碰 DAO。
 */

import { badRequest, notFound, errorMessage } from "./errors.js";
import type { EmbeddingClient } from "./embedding.js";
import type { KbChunkRow } from "./schema.js";
import type { KbStore } from "./store.js";

/** 默认返回条数 / 上限。 */
export const DEFAULT_TOP_K = 6;
export const MAX_TOP_K = 50;

/** 候选集超过这个数量才启用 LIKE 预筛（dev 规模全量算更准）。 */
export const VECTOR_PRE_FILTER_THRESHOLD = 5000;

/** snippet 长度：够看清上下文，又不至于把整块塞进响应。 */
export const SNIPPET_LENGTH = 180;

/** 查询词切出的 token 上限：太多会让打分分母虚高、排序失真。 */
const MAX_QUERY_TOKENS = 24;

export type SearchMode = "vector" | "keyword" | "hybrid";

export interface SearchResult {
	chunkId: number;
	docId: string;
	kbId: string;
	heading: string | null;
	snippet: string;
	score: number;
	mode: SearchMode;
}

export interface SearchResponse {
	mode: SearchMode;
	results: SearchResult[];
	/** 为什么没用语义检索（向量化失败/没配置），页面可以顺手显示；正常时缺省 */
	fallbackReason?: string;
}

export interface SearchOptions {
	topK?: number;
	threshold?: number;
}

/** 四舍五入到 4 位：分数要稳定可断言，别把浮点尾巴带上界面。 */
function round4(value: number): number {
	return Math.round(value * 10000) / 10000;
}

function clampTopK(topK: number | undefined): number {
	if (typeof topK !== "number" || !Number.isFinite(topK)) {
		return DEFAULT_TOP_K;
	}
	return Math.min(MAX_TOP_K, Math.max(1, Math.round(topK)));
}

/**
 * 查询词 → token 列表。
 * 拉丁词按空白/标点切；中文没有空格，整段 + 所有 2-gram 一起进（"知识库检索" →
 * "知识库检索"、"知识"、"识库"、"库检"、"检索"），保证「检索」这种词也能命中。
 */
export function tokenizeQuery(query: string, limit = MAX_QUERY_TOKENS): string[] {
	const tokens: string[] = [];
	const push = (token: string): void => {
		const normalized = token.trim().toLowerCase();
		if (normalized.length === 0 || normalized.length > 32 || tokens.includes(normalized)) {
			return;
		}
		tokens.push(normalized);
	};
	const runs = query
		.toLowerCase()
		.split(/[\s\p{P}\p{S}]+/u)
		.filter((run) => run.length > 0);
	for (const run of runs) {
		push(run);
		if (run.length > 2 && /[\u3400-\u9fff]/.test(run)) {
			for (let i = 0; i + 2 <= run.length; i++) {
				push(run.slice(i, i + 2));
			}
		}
	}
	return tokens.slice(0, limit);
}

/** 一个 token 在文本里出现几次（封顶，避免某个词刷屏把一条结果顶上天）。 */
function countOccurrences(text: string, token: string, cap = 5): number {
	let count = 0;
	let from = 0;
	while (count < cap) {
		const index = text.indexOf(token, from);
		if (index < 0) {
			break;
		}
		count++;
		from = index + token.length;
	}
	return count;
}

/**
 * 关键词打分，归一到 0..1：
 * 正文命中一次算 1 分（同一个词最多算 5 次），标题命中算 2 分；除以 `token 数 × 2` 归一。
 * 只用于排序与阈值过滤，不是概率，配合 `threshold` 用即可。
 */
export function keywordScore(input: { content: string; heading: string | null; tokens: string[] }): number {
	if (input.tokens.length === 0) {
		return 0;
	}
	const content = input.content.toLowerCase();
	const heading = (input.heading ?? "").toLowerCase();
	let raw = 0;
	for (const token of input.tokens) {
		if (heading.length > 0 && heading.includes(token)) {
			raw += 2;
		}
		raw += countOccurrences(content, token);
	}
	return round4(Math.min(1, raw / (input.tokens.length * 2)));
}

/** 截一段带上下文的片段：有命中词就把窗口挪到命中处，否则取开头。 */
export function buildSnippet(content: string, tokens: string[], maxLength = SNIPPET_LENGTH): string {
	const flat = content.replace(/\s+/g, " ").trim();
	if (flat.length <= maxLength) {
		return flat;
	}
	const lower = flat.toLowerCase();
	let position = -1;
	for (const token of tokens) {
		const index = lower.indexOf(token);
		if (index >= 0 && (position < 0 || index < position)) {
			position = index;
		}
	}
	const start = position <= 0 ? 0 : Math.max(0, position - Math.floor(maxLength / 3));
	let snippet = flat.slice(start, start + maxLength);
	if (start > 0) {
		snippet = `…${snippet}`;
	}
	if (start + maxLength < flat.length) {
		snippet = `${snippet}…`;
	}
	return snippet;
}

/** 余弦相似度；维度对不上（换过模型）返回 0，不让一条坏向量把整次检索炸掉。 */
export function cosineSimilarity(left: number[], right: number[]): number {
	if (left.length === 0 || left.length !== right.length) {
		return 0;
	}
	let dot = 0;
	let leftNorm = 0;
	let rightNorm = 0;
	for (let i = 0; i < left.length; i++) {
		const a = left[i]!;
		const b = right[i]!;
		dot += a * b;
		leftNorm += a * a;
		rightNorm += b * b;
	}
	if (leftNorm === 0 || rightNorm === 0) {
		return 0;
	}
	return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

/** 关键词命中 → 结果（纯函数部分，方便单测排序/阈值）。 */
export function rankKeywordChunks(
	chunks: KbChunkRow[],
	tokens: string[],
	options: { topK?: number; threshold?: number } = {},
): SearchResult[] {
	const topK = clampTopK(options.topK);
	// 关键词模式默认只看「有没有命中」；调用方显式给了 threshold 才按分值过滤
	const threshold = typeof options.threshold === "number" && Number.isFinite(options.threshold) ? options.threshold : 0;
	const scored: { chunk: KbChunkRow; score: number }[] = [];
	for (const chunk of chunks) {
		const score = keywordScore({ content: chunk.content, heading: chunk.heading, tokens });
		if (score <= 0 || score < threshold) {
			continue;
		}
		scored.push({ chunk, score });
	}
	scored.sort((left, right) => {
		if (right.score !== left.score) {
			return right.score - left.score;
		}
		// 同分按 id 升序：结果顺序稳定，测试和界面都不会跳
		return left.chunk.id - right.chunk.id;
	});
	return scored.slice(0, topK).map(({ chunk, score }) => ({
		chunkId: chunk.id,
		docId: chunk.docId,
		kbId: chunk.kbId,
		heading: chunk.heading,
		snippet: buildSnippet(chunk.content, tokens),
		score,
		mode: "keyword" as const,
	}));
}

/** Reciprocal-rank fusion combines semantic and lexical candidates without comparing unlike scores. */
function fuseHybridResults(vector: SearchResult[], keyword: SearchResult[], topK: number): SearchResult[] {
	const fused = new Map<number, { result: SearchResult; score: number }>();
	const addRanked = (items: SearchResult[]) => {
		items.forEach((result, index) => {
			const rankScore = 1 / (60 + index + 1);
			const existing = fused.get(result.chunkId);
			if (existing) existing.score += rankScore;
			else fused.set(result.chunkId, { result, score: rankScore });
		});
	};
	addRanked(vector);
	addRanked(keyword);
	const maxScore = 2 / 61;
	return [...fused.values()]
		.sort((left, right) => right.score - left.score || left.result.chunkId - right.result.chunkId)
		.slice(0, topK)
		.map(({ result, score }) => ({ ...result, score: round4(score / maxScore), mode: "hybrid" as const }));
}

/** 余弦相似度候选 → 结果（纯函数部分）。 */
export function rankVectorChunks(
	chunks: { chunk: KbChunkRow; vector: number[] }[],
	queryVector: number[],
	options: { topK?: number; threshold?: number } = {},
): SearchResult[] {
	const topK = clampTopK(options.topK);
	const threshold = typeof options.threshold === "number" && Number.isFinite(options.threshold) ? options.threshold : 0;
	const scored: { chunk: KbChunkRow; score: number }[] = [];
	for (const { chunk, vector } of chunks) {
		const score = round4(cosineSimilarity(queryVector, vector));
		if (score < threshold) {
			continue;
		}
		scored.push({ chunk, score });
	}
	scored.sort((left, right) => {
		if (right.score !== left.score) {
			return right.score - left.score;
		}
		return left.chunk.id - right.chunk.id;
	});
	return scored.slice(0, topK).map(({ chunk, score }) => ({
		chunkId: chunk.id,
		docId: chunk.docId,
		kbId: chunk.kbId,
		heading: chunk.heading,
		// 语义检索的结果通常整块都相关，直接取块开头，避免 snippet 里没有直接命中的词
		snippet: buildSnippet(chunk.content, []),
		score,
		mode: "vector" as const,
	}));
}

/** 取候选块：>limit 时按关键词 LIKE 预筛，避免把所有块读进内存。 */
function loadKeywordCandidates(store: KbStore, kbId: string, tokens: string[]): KbChunkRow[] {
	const total = store.countChunks(kbId);
	const preFilter = total > VECTOR_PRE_FILTER_THRESHOLD && tokens.length > 0 ? tokens : undefined;
	return store.listChunks(kbId, {
		likeTokens: preFilter,
		limit: Math.max(VECTOR_PRE_FILTER_THRESHOLD, total),
	});
}

function keywordSearch(input: {
	store: KbStore;
	kbId: string;
	tokens: string[];
	options: SearchOptions;
}): SearchResponse {
	if (input.tokens.length === 0) {
		throw badRequest("搜索词里没有可用的关键词（去掉标点后再试）");
	}
	const chunks = loadKeywordCandidates(input.store, input.kbId, input.tokens);
	return { mode: "keyword", results: rankKeywordChunks(chunks, input.tokens, input.options) };
}

/**
 * 单库检索。
 * @throws KbError 400 搜索词为空；404 库不存在
 */
export async function searchInKnowledgeBase(input: {
	store: KbStore;
	embedding: EmbeddingClient;
	kbId: string;
	query: string;
	options?: SearchOptions;
}): Promise<SearchResponse> {
	const query = (input.query ?? "").trim();
	if (query.length === 0) {
		throw badRequest("搜索词不能为空");
	}
	const knowledgeBase = input.store.getKnowledgeBase(input.kbId);
	if (!knowledgeBase) {
		throw notFound(`知识库不存在：${input.kbId}`);
	}
	const options = input.options ?? {};
	const tokens = tokenizeQuery(query);
	// 语义检索要求两件事：服务可用 + 这个库真的有向量（老库没配 key 时只有文本）
	const vectorEligible = input.embedding.available() && input.store.countEmbeddedChunks(input.kbId) > 0;
	if (vectorEligible) {
		try {
			const vectors = await input.embedding.embed([query]);
			const queryVector = vectors[0];
			if (!queryVector || queryVector.length === 0) {
				throw badRequest("向量化服务返回了空向量");
			}
			// 排名下推给存储后端：SQLite 本地算余弦，Postgres 交给 pgvector（只回命中行）
			const topK = clampTopK(options.topK);
			const candidateLimit = Math.min(MAX_TOP_K, topK * 3);
			const hits = input.store.searchByEmbedding(input.kbId, queryVector, {
				topK: candidateLimit,
				// 没传 threshold 就用库上配置的相似度阈值
				threshold: options.threshold ?? knowledgeBase.similarityThreshold,
			});
			const vectorResults = hits.map((hit) => ({
					chunkId: hit.chunk.id,
					docId: hit.chunk.docId,
					kbId: hit.chunk.kbId,
					heading: hit.chunk.heading,
					// 语义检索的命中通常整块都相关，直接取块开头（与旧的 JS 排名行为一致）
					snippet: buildSnippet(hit.chunk.content, []),
					score: hit.score,
					mode: "vector" as const,
			}));
			const keywordResults = keywordSearch({
				store: input.store,
				kbId: input.kbId,
				tokens,
				options: { topK: candidateLimit, threshold: options.threshold },
			}).results;
			return {
				mode: "hybrid",
				results: fuseHybridResults(vectorResults, keywordResults, topK),
			};
		} catch (error) {
			// 向量化失败不能让检索不可用：退回关键词，并把原因如实带回去
			const fallback = keywordSearch({ store: input.store, kbId: input.kbId, tokens, options: { topK: options.topK, threshold: options.threshold } });
			return { ...fallback, fallbackReason: errorMessage(error) };
		}
	}
	return keywordSearch({ store: input.store, kbId: input.kbId, tokens, options });
}
