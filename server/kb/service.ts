/**
 * 知识库服务层：把「解析 → 分块 → 落库 → 向量化」和「检索 → 技能绑定」串起来。
 *
 * 分三层的原因：纯函数（chunk/parse/search 的打分部分）不碰 IO 好测；
 * DAO（store）只管 SQL；这一层只做编排与"失败也要可用"的兜底决策。
 *
 * 一条硬约定：**向量化失败绝不阻断上传**。文档和分块先落库（status=ready），
 * 语义检索用不了就回退关键词；页面上通过 `embedding` 字段与检索结果的 `mode` 如实展示。
 */

import { chunkText } from "./chunk.js";
import { createEmbeddingClient, serializeEmbedding } from "./embedding.js";
import type { EmbeddingClient, EmbeddingInfo } from "./embedding.js";
import { badRequest, notFound, errorMessage } from "./errors.js";
import { parseDocument } from "./parse.js";
import { DEFAULT_TOP_K, MAX_TOP_K, searchInKnowledgeBase } from "./search.js";
import type { SearchOptions, SearchResponse } from "./search.js";
import type { KbDocumentRow, KnowledgeBaseRow } from "./schema.js";
import { KB_LIMITS, createKbStore } from "./store.js";
import type { KbStore, KnowledgeBaseInput, RemoveDocumentResult, RemoveKnowledgeBaseResult } from "./store.js";

/** 给接口用的知识库视图：比 DAO 行多一个「这个库现在能不能语义检索」的布尔。 */
export interface KnowledgeBaseView extends KnowledgeBaseRow {
	/** 库里有带向量的块才算 true（页面据此显示「语义检索已启用 / 未启用」） */
	embedding: boolean;
}

export interface IngestDocumentInput {
	kbId: string;
	filename: string;
	mime?: string | null;
	data: Uint8Array | Buffer;
}

export interface IngestResult {
	document: KbDocumentRow;
	/** 实际写入的分块数 */
	chunkCount: number;
	/** 这次上传是否成功算出了向量 */
	embedded: boolean;
	/** 向量化失败时的中文提示（文档仍然可用，关键词检索） */
	warning?: string;
}

/** 对话附件解析结果：纯文本 + 类型与页数，够前端提示用。 */
export interface ExtractTextResult {
	/** 解析出的纯文本（已按附件上限截断） */
	text: string;
	/** 原始字符数（截断前），前端据此提示「已截断」 */
	totalChars: number;
	kind: string;
	pages?: number;
}

export interface ReembedResult {
	/** 本次重新向量化的块数 */
	chunks: number;
	/** 是否真的算出了向量（没配 key 会在前面就报 400） */
	embedded: boolean;
}

export interface SkillBindingsView {
	skillId: string;
	kbIds: string[];
	knowledgeBases: KnowledgeBaseView[];
}

/** 「对话默认检索」的库：不走技能，问答时直接兜底检索这几个库。 */
export interface DefaultBindingsView {
	kbIds: string[];
	knowledgeBases: KnowledgeBaseView[];
}

export interface SkillSearchResponse extends SearchResponse {
	/** 这次检索覆盖了哪些知识库 */
	kbIds: string[];
}

export interface KbService {
	store: KbStore;
	embedding: EmbeddingClient;

	listKnowledgeBases(): KnowledgeBaseView[];
	createKnowledgeBase(input: KnowledgeBaseInput): KnowledgeBaseView;
	removeKnowledgeBase(id: string): RemoveKnowledgeBaseResult;

	ingestDocument(input: IngestDocumentInput): Promise<IngestResult>;
	/**
	 * 只解析、不落库：把上传的文档转成纯文本，供「对话附件」使用。
	 * 复用知识库的解析器（PDF/DOCX/MD/CSV），不建库、不分块、不向量化。
	 */
	extractText(input: { filename: string; data: Uint8Array | Buffer }): Promise<ExtractTextResult>;
	listDocuments(kbId: string): KbDocumentRow[];
	removeDocument(docId: string): RemoveDocumentResult;

	search(kbId: string, query: string, options?: SearchOptions): Promise<SearchResponse>;
	searchForSkill(skillId: string, query: string, topK?: number): Promise<SkillSearchResponse>;
	/** 按给定库列表跨库检索（技能绑定与对话默认库共用这一条合并逻辑）。 */
	searchInBases(kbIds: string[], query: string, topK?: number): Promise<SkillSearchResponse>;
	/**
	 * 对话侧检索：技能绑定 > Agent 绑定 > 对话默认。
	 * `agentKbIds` 是绑定 Agent 声明的知识库（不传或空数组 = 没有 Agent 绑定）。
	 */
	searchForContext(
		skillId: string | null,
		query: string,
		topK?: number,
		agentKbIds?: string[],
	): Promise<SkillSearchResponse>;

	getSkillBindings(skillId: string): SkillBindingsView;
	setSkillBindings(skillId: string, kbIds: string[]): SkillBindingsView;

	getDefaultBindings(): DefaultBindingsView;
	setDefaultBindings(kbIds: string[]): DefaultBindingsView;

	/**
	 * 用当前 embedding 配置把整个知识库的块重算一遍向量（补 `EMBEDDING_API_KEY` 后让旧文档也能语义检索）。
	 * 库不存在 404、没配向量化 400、块数超上限 400。
	 */
	reembedKnowledgeBase(kbId: string): Promise<ReembedResult>;

	embeddingInfo(): EmbeddingInfo;
	close(): void;
}

/** 文件大小展示（错误文案里用）。 */
function toKnowledgeBaseView(row: KnowledgeBaseRow): KnowledgeBaseView {
	return { ...row, embedding: row.embeddedChunkCount > 0 };
}

function clampTopK(topK: number | undefined): number {
	if (typeof topK !== "number" || !Number.isFinite(topK)) {
		return DEFAULT_TOP_K;
	}
	return Math.min(MAX_TOP_K, Math.max(1, Math.round(topK)));
}

/** 从文件名猜 MIME，只用于落库展示，不参与解析判断。 */
export function mimeOf(filename: string): string | null {
	const dot = filename.lastIndexOf(".");
	if (dot < 0) {
		return null;
	}
	const ext = filename.slice(dot + 1).toLowerCase();
	const table: Record<string, string> = {
		txt: "text/plain",
		md: "text/markdown",
		markdown: "text/markdown",
		csv: "text/csv",
		pdf: "application/pdf",
		docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	};
	return table[ext] ?? null;
}

/**
 * 对话附件最多送进模型的字符数。
 * 比知识库分块宽：附件是"一次性读全文"，但也要挡住超长 PDF 把上下文撑爆。
 */
export const ATTACHMENT_MAX_CHARS = 60_000;

export interface CreateKbServiceOptions {
	store: KbStore;
	/** 不传则读环境变量建默认客户端（单测可注入假的，避免打网络） */
	embedding?: EmbeddingClient;
}

export function createKbService(options: CreateKbServiceOptions): KbService {
	const store = options.store;
	const embedding = options.embedding ?? createEmbeddingClient();

	/**
	 * 跨库检索并合并：技能绑定与「对话默认检索」共用同一条合并逻辑
	 * （按分数降序、同分按块 id、取前 topK），避免两条路径各写一份排序规则。
	 */
	async function searchAcrossBases(
		kbIds: string[],
		query: string,
		topK: number | undefined,
	): Promise<SkillSearchResponse> {
		const unique = [...new Set(kbIds)];
		if (unique.length === 0) {
			// 没绑定知识库不是错误（新技能都这样），返回空结果让上层照常回答
			return { mode: "keyword", results: [], kbIds: [] };
		}
		const limit = clampTopK(topK);
		const responses = await Promise.all(
			unique.map((kbId) => searchInKnowledgeBase({ store, embedding, kbId, query, options: { topK: limit } })),
		);
		const results = responses
			.flatMap((response) => response.results)
			.sort((left, right) => {
				if (right.score !== left.score) {
					return right.score - left.score;
				}
				return left.chunkId - right.chunkId;
			})
			.slice(0, limit);
		const allVector = responses.every((response) => response.mode === "vector");
		const allKeyword = responses.every((response) => response.mode === "keyword");
		const fallbackReasons = responses
			.map((response) => response.fallbackReason)
			.filter((reason): reason is string => typeof reason === "string" && reason.length > 0);
		return {
			mode: allVector ? "vector" : allKeyword ? "keyword" : "hybrid",
			results,
			kbIds: unique,
			...(fallbackReasons.length > 0 ? { fallbackReason: fallbackReasons.join("；") } : {}),
		};
	}

	/** 向量化一批块：成功就写回 embedding 列，返回是否全部成功。 */
	async function embedChunks(chunkIds: number[], texts: string[]): Promise<boolean> {
		if (chunkIds.length === 0 || !embedding.available()) {
			return false;
		}
		const vectors = await embedding.embed(texts);
		if (vectors.length !== chunkIds.length) {
			throw badRequest(`向量化返回条数与分块数不一致（${vectors.length} / ${chunkIds.length}）`);
		}
		store.updateChunkEmbeddings(
			chunkIds.map((id, index) => ({ id, embedding: serializeEmbedding(vectors[index]!) })),
		);
		return true;
	}

	const service: KbService = {
		store,
		embedding,

		listKnowledgeBases() {
			return store.listKnowledgeBases().map(toKnowledgeBaseView);
		},

		createKnowledgeBase(input) {
			// 建库时把当前用的向量模型记下来；没配 key 就先留空，后面补 key 再上传的文档会带向量
			const embeddingModel = input.embeddingModel ?? (embedding.available() ? embedding.info().model : null);
			return toKnowledgeBaseView(store.createKnowledgeBase({ ...input, embeddingModel }));
		},

		removeKnowledgeBase(id) {
			return store.removeKnowledgeBase(id);
		},

		async ingestDocument(input) {
			const knowledgeBase = store.getKnowledgeBase(input.kbId);
			if (!knowledgeBase) {
				throw notFound(`知识库不存在：${input.kbId}`);
			}
			const bytes = input.data.byteLength;
			// 1. 解析（格式/大小/超时的错误都在这一层抛，中文文案）
			const parsed = await parseDocument({ filename: input.filename, data: input.data });
			// 2. 分块（按库上配置的 chunk_size/overlap，允许不同库不同粒度）
			const chunks = chunkText({
				text: parsed.text,
				chunkSize: knowledgeBase.chunkSize,
				overlap: knowledgeBase.chunkOverlap,
			});
			if (chunks.length === 0) {
				throw badRequest(`文档「${input.filename}」没有可用的文字，分块结果为空`);
			}

			// 3. 先落库：即使向量化失败，关键词检索也要立刻可用
			const document = store.insertDocument({
				kbId: knowledgeBase.id,
				filename: input.filename,
				mime: input.mime ?? mimeOf(input.filename),
				bytes,
				status: "ready",
				chunkCount: chunks.length,
			});
			const chunkIds = store.insertChunks(
				document.id,
				knowledgeBase.id,
				chunks.map((chunk) => ({
					seq: chunk.seq,
					heading: chunk.heading,
					content: chunk.content,
					tokens: chunk.tokens,
				})),
			);

			// 4. 尽力向量化：标题也拼进待向量化文本，标题里的关键词能帮上召回
			let embedded = false;
			let warning: string | undefined;
			if (embedding.available()) {
				try {
					embedded = await embedChunks(
						chunkIds,
						chunks.map((chunk) => (chunk.heading ? `${chunk.heading}\n\n${chunk.content}` : chunk.content)),
					);
				} catch (error) {
					warning = `向量化失败：${errorMessage(error)}（文本已入库，当前用关键词检索）`;
					console.warn(`[kb] 文档 ${input.filename} ${warning}`);
				}
			}

			const saved = store.getDocument(document.id)!;
			return { document: saved, chunkCount: chunks.length, embedded, ...(warning ? { warning } : {}) };
		},

		async extractText(input) {
			// 走与知识库完全相同的解析器：支持的格式、大小上限、中文错误文案都复用一份，
			// 别为对话附件再写一套 PDF/DOCX 解析（两份实现必然漂移）
			const parsed = await parseDocument({ filename: input.filename, data: input.data });
			const totalChars = parsed.text.length;
			return {
				text: parsed.text.slice(0, ATTACHMENT_MAX_CHARS),
				totalChars,
				kind: parsed.meta.kind,
				...(typeof parsed.meta.pages === "number" ? { pages: parsed.meta.pages } : {}),
			};
		},

		listDocuments(kbId) {
			if (!store.getKnowledgeBase(kbId)) {
				throw notFound(`知识库不存在：${kbId}`);
			}
			return store.listDocuments(kbId);
		},

		removeDocument(docId) {
			return store.removeDocument(docId);
		},

		async reembedKnowledgeBase(kbId) {
			const knowledgeBase = store.getKnowledgeBase(kbId);
			if (!knowledgeBase) {
				throw notFound(`知识库不存在：${kbId}`);
			}
			if (!embedding.available()) {
				throw badRequest("没配置向量化服务（EMBEDDING_API_KEY），无法重新向量化");
			}
			const total = store.countChunks(kbId);
			if (total === 0) {
				return { chunks: 0, embedded: false };
			}
			if (total > KB_LIMITS.listChunksLimit) {
				throw badRequest(`分块数 ${total} 超过 ${KB_LIMITS.listChunksLimit}，请拆分文档后再试`);
			}
			const chunks = store.listChunks(kbId, { limit: total });
			const vectors = await embedding.embed(
				chunks.map((chunk) => (chunk.heading ? `${chunk.heading}\n\n${chunk.content}` : chunk.content)),
			);
			if (vectors.length !== chunks.length) {
				throw badRequest(`向量化返回条数与分块数不一致（${vectors.length} / ${chunks.length}）`);
			}
			store.updateChunkEmbeddings(
				chunks.map((chunk, index) => ({ id: chunk.id, embedding: serializeEmbedding(vectors[index]!) })),
			);
			store.setEmbeddingModel(kbId, embedding.info().model);
			return { chunks: chunks.length, embedded: true };
		},

		async search(kbId, query, searchOptions = {}) {
			return searchInKnowledgeBase({ store, embedding, kbId, query, options: searchOptions });
		},

		searchInBases(kbIds, query, topK) {
			return searchAcrossBases(kbIds, query, topK);
		},

		searchForSkill(skillId, query, topK) {
			return searchAcrossBases(store.getSkillKbIds(skillId), query, topK);
		},

		searchForContext(skillId, query, topK, agentKbIds) {
			// 三层优先级，越具体越优先（与"绑定 Agent = 收窄能力范围"的直觉一致）：
			//   ① 当前技能绑的库   —— 会话里显式加载了技能，它的绑定最具体；
			//   ② 当前 Agent 绑的库 —— 整段对话的能力范围，技能没绑时生效；
			//   ③ 「对话默认检索」   —— 什么都没绑时的兜底，保证不加载技能也能查资料。
			// 空数组一律视为"没绑"，继续往下落——否则一个空绑定会把默认库挡掉。
			const fromSkill = (skillId ?? "").trim().length > 0 ? store.getSkillKbIds((skillId ?? "").trim()) : [];
			// Agent 声明的是**存下来的 id**，库可能早被删了：和 getDefaultKbIds 一样要先剔除，
			// 否则一次陈旧绑定会让每一次检索都报「知识库不存在」。
			// 先 listKnowledgeBasesByIds 再取 id，等于用"库还在不在"过一遍。
			const agentRaw = (agentKbIds ?? []).map((id) => id.trim()).filter((id) => id.length > 0);
			const fromAgent = store.listKnowledgeBasesByIds(agentRaw).map((kb) => kb.id);
			const kbIds = fromSkill.length > 0 ? fromSkill : fromAgent.length > 0 ? fromAgent : store.getDefaultKbIds();
			return searchAcrossBases(kbIds, query, topK);
		},

		getDefaultBindings() {
			const kbIds = store.getDefaultKbIds();
			return { kbIds, knowledgeBases: store.listKnowledgeBasesByIds(kbIds).map(toKnowledgeBaseView) };
		},

		setDefaultBindings(kbIds) {
			store.setDefaultKbIds(kbIds);
			return service.getDefaultBindings();
		},

		getSkillBindings(skillId) {
			const normalized = (skillId ?? "").trim();
			if (normalized.length === 0) {
				throw badRequest("技能 id 不能为空");
			}
			const kbIds = store.getSkillKbIds(normalized);
			return {
				skillId: normalized,
				kbIds,
				knowledgeBases: store.listKnowledgeBasesByIds(kbIds).map(toKnowledgeBaseView),
			};
		},

		setSkillBindings(skillId, kbIds) {
			const normalized = (skillId ?? "").trim();
			if (normalized.length === 0) {
				throw badRequest("技能 id 不能为空");
			}
			store.setSkillBindings(normalized, kbIds);
			return service.getSkillBindings(normalized);
		},

		embeddingInfo() {
			return embedding.info();
		},

		close() {
			store.close();
		},
	};

	return service;
}

/** 便捷构造：直接按库路径建一套（脚本/测试用；服务端走 runtime.ts 的单例）。 */
export function createKbServiceForPath(path: string, embedding?: EmbeddingClient): KbService {
	return createKbService({ store: createKbStore({ path }), ...(embedding ? { embedding } : {}) });
}
