/**
 * 知识库 DAO（SQLite / `node:sqlite`）。
 *
 * 为什么不用 `server/db/**` 那套 `Storage` 契约：那层的 DAO 签名要同时满足 Postgres 的同步桥，
 * 塞进知识库的十来张查询只会把两边都绑死；所以知识库自己定义一个 `KbStore` 契约，
 * SQLite（本文件，本地 JSON 向量）与 Postgres（`pgStore.ts`，pgvector）各实现一份，
 * 归一化校验/行映射/列表 SELECT 放在本文件导出给两边共用。SQLite 实现只依赖库文件路径，
 * 不 import 宿主存储层，单测可以直接拿一个临时文件建一套。
 *
 * 约定：
 *   - 所有 SQL 参数化（`?`），没有字符串拼 SQL。
 *   - 写多表的操作走显式事务（BEGIN / COMMIT / ROLLBACK）。
 *   - 返回的行一律转成驼峰命名，SQL 列名细节只留在本文件。
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseEmbedding } from "./embedding.js";
import { badRequest, notFound } from "./errors.js";
import { cosineSimilarity } from "./search.js";
import { ensureKbSchema, resolveKbDbPath } from "./schema.js";
import type { KbChunkRow, KbDocumentRow, KnowledgeBaseRow } from "./schema.js";

/** 默认分块参数（与 `chunk.ts` 的默认值保持一致）。 */
const DEFAULT_CHUNK_SIZE = 800;
const DEFAULT_CHUNK_OVERLAP = 120;
const DEFAULT_SIMILARITY_THRESHOLD = 0.2;

/** 名称/描述长度上限：直接上界面，别让用户传 2000 字的名字。 */
export const KB_LIMITS = {
	nameMaxLength: 80,
	descriptionMaxLength: 1000,
	topKMax: 50,
	listChunksLimit: 5000,
} as const;

export interface KnowledgeBaseInput {
	name: string;
	description?: string | null;
	/** 建库时记下用的向量模型；没配 embedding 就留空，语义检索未启用 */
	embeddingModel?: string | null;
	chunkSize?: number;
	chunkOverlap?: number;
	similarityThreshold?: number;
}

export interface NewDocumentInput {
	kbId: string;
	filename: string;
	mime?: string | null;
	bytes: number;
	status: string;
	error?: string | null;
	chunkCount?: number;
}

export interface NewChunkInput {
	seq: number;
	heading: string | null;
	content: string;
	tokens: number;
	/** 已经算好的向量（JSON 文本），没有就是 null */
	embedding?: string | null;
}

export interface RemoveKnowledgeBaseResult {
	removed: boolean;
	documentsRemoved: number;
	chunksRemoved: number;
}

export interface RemoveDocumentResult {
	removed: boolean;
	chunksRemoved: number;
}

export interface ListChunksOptions {
	/** 只要已经向量化的块（语义检索候选集） */
	onlyEmbedded?: boolean;
	/** 关键词预筛（>5000 块时先用 LIKE 缩小候选，别把整个库读进内存） */
	likeTokens?: string[];
	limit?: number;
}

/** 语义检索命中：块 + 相似度（0..1，已四舍五入到 4 位）。 */
export interface KbVectorHit {
	chunk: KbChunkRow;
	score: number;
}

export interface KbStore {
	/** 后端种类：sqlite 存 JSON 向量（本地余弦），postgres 用 pgvector 的余弦距离运算符。 */
	info(): { path: string; kind: "sqlite" | "postgres" };
	close(): void;

	createKnowledgeBase(input: KnowledgeBaseInput): KnowledgeBaseRow;
	listKnowledgeBases(): KnowledgeBaseRow[];
	getKnowledgeBase(id: string): KnowledgeBaseRow | undefined;
	removeKnowledgeBase(id: string): RemoveKnowledgeBaseResult;

	insertDocument(input: NewDocumentInput): KbDocumentRow;
	updateDocument(
		id: string,
		patch: { status?: string; error?: string | null; chunkCount?: number },
	): void;
	listDocuments(kbId: string): KbDocumentRow[];
	getDocument(id: string): KbDocumentRow | undefined;
	removeDocument(id: string): RemoveDocumentResult;

	insertChunks(docId: string, kbId: string, chunks: NewChunkInput[]): number[];
	listChunks(kbId: string, options?: ListChunksOptions): KbChunkRow[];
	countChunks(kbId: string): number;
	countEmbeddedChunks(kbId: string): number;
	updateChunkEmbeddings(updates: { id: number; embedding: string }[]): void;
	/** 记下这个库最近一次用的向量模型（重新向量化后刷新展示）。 */
	setEmbeddingModel(id: string, model: string | null): void;

	/**
	 * 语义检索：由**存储后端**负责排名。SQLite 读 JSON 向量在本地算余弦；
	 * Postgres 直接下推给 pgvector（`embedding <=> $vec`），只回命中行。
	 * 只返回已经带向量的块，调用方不再需要把整库块读进内存。
	 */
	searchByEmbedding(kbId: string, queryVector: number[], options: { topK: number; threshold: number }): KbVectorHit[];

	setSkillBindings(skillId: string, kbIds: string[]): void;
	getSkillKbIds(skillId: string): string[];
	listKnowledgeBasesByIds(ids: string[]): KnowledgeBaseRow[];

	/** 「对话默认检索」的库（不依赖技能）：问答时按这张表兜底。 */
	setDefaultKbIds(kbIds: string[]): void;
	getDefaultKbIds(): string[];
}

/** 知识库表的原始行（列名与 DDL 一致，只在这一层出现）。 */
interface KnowledgeBaseDbRow {
	id: string;
	name: string;
	description: string | null;
	embedding_model: string | null;
	chunk_size: number;
	chunk_overlap: number;
	similarity_threshold: number;
	created_at: number;
	updated_at: number;
	doc_count: number;
	chunk_count: number;
	embedded_chunk_count: number;
}

interface DocumentDbRow {
	id: string;
	kb_id: string;
	filename: string;
	mime: string | null;
	bytes: number;
	status: string;
	error: string | null;
	chunk_count: number;
	created_at: number;
	updated_at: number;
}

interface ChunkDbRow {
	id: number;
	doc_id: string;
	kb_id: string;
	seq: number;
	heading: string | null;
	content: string;
	tokens: number;
	embedding: string | null;
}

/** 建库入参归一化 + 校验（SQLite / Postgres 共用；错误文案直接上界面，不写英文技术黑话）。 */
export interface NormalizedKnowledgeBaseInput {
	name: string;
	description: string | null;
	embeddingModel: string | null;
	chunkSize: number;
	chunkOverlap: number;
	similarityThreshold: number;
}

export function normalizeKnowledgeBaseInput(input: KnowledgeBaseInput): NormalizedKnowledgeBaseInput {
	const name = (input.name ?? "").trim();
	if (name.length === 0) {
		throw badRequest("知识库名称不能为空");
	}
	if (name.length > KB_LIMITS.nameMaxLength) {
		throw badRequest(`知识库名称最多 ${KB_LIMITS.nameMaxLength} 个字符`);
	}
	const description = (input.description ?? "").trim();
	if (description.length > KB_LIMITS.descriptionMaxLength) {
		throw badRequest(`知识库说明最多 ${KB_LIMITS.descriptionMaxLength} 个字符`);
	}
	return {
		name,
		description: description.length > 0 ? description : null,
		embeddingModel: input.embeddingModel ?? null,
		chunkSize: Math.round(clampNumber(input.chunkSize, DEFAULT_CHUNK_SIZE, 200, 4000)),
		chunkOverlap: Math.round(clampNumber(input.chunkOverlap, DEFAULT_CHUNK_OVERLAP, 0, 1000)),
		similarityThreshold: clampNumber(input.similarityThreshold, DEFAULT_SIMILARITY_THRESHOLD, 0, 1),
	};
}

/** 列表/详情共用的一段 SELECT：三个计数用子查询算，读的时候不用再拆表（两种后端语法一致）。 */
export const KB_LIST_SELECT = `
	SELECT
		kb.*,
		(SELECT COUNT(*) FROM kb_documents d WHERE d.kb_id = kb.id)                        AS doc_count,
		(SELECT COUNT(*) FROM kb_chunks c WHERE c.kb_id = kb.id)                           AS chunk_count,
		(SELECT COUNT(*) FROM kb_chunks c WHERE c.kb_id = kb.id AND c.embedding IS NOT NULL) AS embedded_chunk_count
	FROM knowledge_bases kb
`;

/** 行 → 驼峰视图（SQLite 与 Postgres 的列名一致，两边共用）。 */
export function mapKnowledgeBaseRow(row: KnowledgeBaseDbRow): KnowledgeBaseRow {
	return {
		id: row.id,
		name: row.name,
		description: row.description,
		embeddingModel: row.embedding_model,
		chunkSize: Number(row.chunk_size),
		chunkOverlap: Number(row.chunk_overlap),
		similarityThreshold: Number(row.similarity_threshold),
		createdAt: Number(row.created_at),
		updatedAt: Number(row.updated_at),
		docCount: Number(row.doc_count),
		chunkCount: Number(row.chunk_count),
		embeddedChunkCount: Number(row.embedded_chunk_count),
	};
}

export function mapDocumentRow(row: DocumentDbRow): KbDocumentRow {
	return {
		id: row.id,
		kbId: row.kb_id,
		filename: row.filename,
		mime: row.mime,
		bytes: Number(row.bytes),
		status: row.status,
		error: row.error,
		chunkCount: Number(row.chunk_count),
		createdAt: Number(row.created_at),
		updatedAt: Number(row.updated_at),
	};
}

export function mapChunkRow(row: ChunkDbRow): KbChunkRow {
	return {
		id: Number(row.id),
		docId: row.doc_id,
		kbId: row.kb_id,
		seq: Number(row.seq),
		heading: row.heading,
		content: row.content,
		tokens: Number(row.tokens),
		embedding: row.embedding,
	};
}

/** LIKE 预筛时把用户词里的通配符转义掉，避免查询语义被 `%` 带偏（两种后端共用）。 */
export function escapeLike(token: string): string {
	return token.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
	const number = typeof value === "number" && Number.isFinite(value) ? value : fallback;
	return Math.min(max, Math.max(min, number));
}

export interface CreateKbStoreOptions {
	/** 库文件路径；不传则按 `DB_PATH` → 仓库默认位置 */
	path?: string;
}

/** 打开知识库 DAO。同一个进程里建议只开一个（`server/kb/runtime.ts` 负责单例）。 */
export function createKbStore(options: CreateKbStoreOptions = {}): KbStore {
	const path = resolveKbDbPath(options.path);
	mkdirSync(dirname(path), { recursive: true });
	const db = new DatabaseSync(path);
	ensureKbSchema(db);
	try {
		// 先试 WAL（不在 busy handler 生效前等锁）：WAL 让「读知识库」和「会话落库」互不阻塞，
		// 老库从 rollback 切过来也只需要一次；拿不到锁就直接放弃，退回默认模式也能用
		db.exec("PRAGMA journal_mode = WAL");
	} catch {
		// 只读挂载 / 网络盘 / 别的连接正在写：退回默认日志模式
	}
	// 会话库是同一个文件，宿主进程也在写：给锁冲突留 5 秒重试窗口
	db.exec("PRAGMA busy_timeout = 5000");

	function tx<T>(work: () => T): T {
		db.exec("BEGIN");
		try {
			const result = work();
			db.exec("COMMIT");
			return result;
		} catch (error) {
			try {
				db.exec("ROLLBACK");
			} catch {
				// 已经回滚过就忽略
			}
			throw error;
		}
	}

	function findKnowledgeBase(id: string): KnowledgeBaseRow | undefined {
		const row = db.prepare(`${KB_LIST_SELECT} WHERE kb.id = ?`).get(id) as KnowledgeBaseDbRow | undefined;
		return row ? mapKnowledgeBaseRow(row) : undefined;
	}

	const store: KbStore = {
		info() {
			return { path, kind: "sqlite" as const };
		},

		close() {
			db.close();
		},

		/* ---------------- 知识库 ---------------- */

		createKnowledgeBase(input) {
			const normalized = normalizeKnowledgeBaseInput(input);
			const existing = db.prepare("SELECT id FROM knowledge_bases WHERE name = ?").get(normalized.name) as
				| { id: string }
				| undefined;
			if (existing) {
				throw badRequest(`同名知识库已存在：${normalized.name}`);
			}
			const id = `kb_${randomUUID()}`;
			const now = Date.now();
			db.prepare(
				`INSERT INTO knowledge_bases
					(id, name, description, embedding_model, chunk_size, chunk_overlap, similarity_threshold, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				id,
				normalized.name,
				normalized.description,
				normalized.embeddingModel,
				normalized.chunkSize,
				normalized.chunkOverlap,
				normalized.similarityThreshold,
				now,
				now,
			);
			return findKnowledgeBase(id)!;
		},

		listKnowledgeBases() {
			const rows = db.prepare(`${KB_LIST_SELECT} ORDER BY kb.created_at ASC`).all() as unknown as KnowledgeBaseDbRow[];
			return rows.map(mapKnowledgeBaseRow);
		},

		getKnowledgeBase(id) {
			return findKnowledgeBase(id);
		},

		removeKnowledgeBase(id) {
			if (!findKnowledgeBase(id)) {
				return { removed: false, documentsRemoved: 0, chunksRemoved: 0 };
			}
			return tx(() => {
				const documents = db.prepare("SELECT COUNT(*) AS total FROM kb_documents WHERE kb_id = ?").get(id) as {
					total: number;
				};
				const chunks = db.prepare("SELECT COUNT(*) AS total FROM kb_chunks WHERE kb_id = ?").get(id) as {
					total: number;
				};
				// 先删关联数据再删主表：SQLite 没开外键级联，漏一步就会留孤儿行
				db.prepare("DELETE FROM kb_chunks WHERE kb_id = ?").run(id);
				db.prepare("DELETE FROM kb_documents WHERE kb_id = ?").run(id);
				db.prepare("DELETE FROM skill_kb_bindings WHERE kb_id = ?").run(id);
				db.prepare("DELETE FROM knowledge_bases WHERE id = ?").run(id);
				return {
					removed: true,
					documentsRemoved: Number(documents.total),
					chunksRemoved: Number(chunks.total),
				};
			});
		},

		/* ---------------- 文档 ---------------- */

		insertDocument(input) {
			if (!findKnowledgeBase(input.kbId)) {
				throw notFound(`知识库不存在：${input.kbId}`);
			}
			const id = `doc_${randomUUID()}`;
			const now = Date.now();
			db.prepare(
				`INSERT INTO kb_documents
					(id, kb_id, filename, mime, bytes, status, error, chunk_count, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				id,
				input.kbId,
				input.filename,
				input.mime ?? null,
				Math.max(0, Math.round(input.bytes)),
				input.status,
				input.error ?? null,
				Math.max(0, Math.round(input.chunkCount ?? 0)),
				now,
				now,
			);
			return store.getDocument(id)!;
		},

		updateDocument(id, patch) {
			const current = store.getDocument(id);
			if (!current) {
				throw notFound(`文档不存在：${id}`);
			}
			db.prepare(
				`UPDATE kb_documents
				 SET status = ?, error = ?, chunk_count = ?, updated_at = ?
				 WHERE id = ?`,
			).run(
				patch.status ?? current.status,
				patch.error === undefined ? current.error : patch.error,
				Math.max(0, Math.round(patch.chunkCount ?? current.chunkCount)),
				Date.now(),
				id,
			);
		},

		listDocuments(kbId) {
			const rows = db
				.prepare(
					`SELECT * FROM kb_documents WHERE kb_id = ? ORDER BY created_at ASC`,
				)
				.all(kbId) as unknown as DocumentDbRow[];
			return rows.map(mapDocumentRow);
		},

		getDocument(id) {
			const row = db.prepare("SELECT * FROM kb_documents WHERE id = ?").get(id) as DocumentDbRow | undefined;
			return row ? mapDocumentRow(row) : undefined;
		},

		removeDocument(id) {
			const current = store.getDocument(id);
			if (!current) {
				return { removed: false, chunksRemoved: 0 };
			}
			return tx(() => {
				const result = db.prepare("DELETE FROM kb_chunks WHERE doc_id = ?").run(id);
				db.prepare("DELETE FROM kb_documents WHERE id = ?").run(id);
				return { removed: true, chunksRemoved: Number(result.changes) };
			});
		},

		/* ---------------- 分块 ---------------- */

		insertChunks(docId, kbId, chunks) {
			if (chunks.length === 0) {
				return [];
			}
			return tx(() => {
				const statement = db.prepare(
					`INSERT INTO kb_chunks (doc_id, kb_id, seq, heading, content, tokens, embedding)
					 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				);
				const ids: number[] = [];
				for (const chunk of chunks) {
					const result = statement.run(
						docId,
						kbId,
						chunk.seq,
						chunk.heading,
						chunk.content,
						chunk.tokens,
						chunk.embedding ?? null,
					);
					ids.push(Number(result.lastInsertRowid));
				}
				return ids;
			});
		},

		listChunks(kbId, options = {}) {
			const limit = Math.max(1, Math.min(KB_LIMITS.listChunksLimit, Math.round(options.limit ?? KB_LIMITS.listChunksLimit)));
			const where: string[] = ["kb_id = ?"];
			const params: (string | number)[] = [kbId];
			if (options.onlyEmbedded) {
				where.push("embedding IS NOT NULL");
			}
			const tokens = (options.likeTokens ?? []).filter((token) => token.length > 0);
			if (tokens.length > 0) {
				// 兜底 OR 预筛：正文或标题命中都算候选，宁可多取一些也不要漏
				where.push(
					`(${tokens
						.map(() => "(content LIKE ? ESCAPE '\\' OR heading LIKE ? ESCAPE '\\')")
						.join(" OR ")})`,
				);
				for (const token of tokens) {
					const pattern = `%${escapeLike(token)}%`;
					params.push(pattern, pattern);
				}
			}
			const rows = db
				.prepare(
					`SELECT * FROM kb_chunks WHERE ${where.join(" AND ")} ORDER BY doc_id, seq LIMIT ?`,
				)
				.all(...params, limit) as unknown as ChunkDbRow[];
			return rows.map(mapChunkRow);
		},

		countChunks(kbId) {
			const row = db.prepare("SELECT COUNT(*) AS total FROM kb_chunks WHERE kb_id = ?").get(kbId) as {
				total: number;
			};
			return Number(row.total);
		},

		countEmbeddedChunks(kbId) {
			const row = db
				.prepare("SELECT COUNT(*) AS total FROM kb_chunks WHERE kb_id = ? AND embedding IS NOT NULL")
				.get(kbId) as { total: number };
			return Number(row.total);
		},

		updateChunkEmbeddings(updates) {
			if (updates.length === 0) {
				return;
			}
			tx(() => {
				const statement = db.prepare("UPDATE kb_chunks SET embedding = ? WHERE id = ?");
				for (const update of updates) {
					statement.run(update.embedding, update.id);
				}
			});
		},

		setEmbeddingModel(id, model) {
			db.prepare("UPDATE knowledge_bases SET embedding_model = ?, updated_at = ? WHERE id = ?").run(
				model,
				Date.now(),
				id,
			);
		},

		searchByEmbedding(kbId, queryVector, options) {
			const topK = Math.max(1, Math.min(KB_LIMITS.topKMax, Math.round(options.topK)));
			const threshold = Number.isFinite(options.threshold) ? options.threshold : 0;
			const rows = db
				.prepare("SELECT * FROM kb_chunks WHERE kb_id = ? AND embedding IS NOT NULL ORDER BY doc_id, seq")
				.all(kbId) as unknown as ChunkDbRow[];
			const hits: KbVectorHit[] = [];
			for (const row of rows) {
				const vector = parseEmbedding(row.embedding);
				if (!vector) {
					continue;
				}
				const score = Math.round(cosineSimilarity(queryVector, vector) * 10000) / 10000;
				if (score < threshold) {
					continue;
				}
				hits.push({ chunk: mapChunkRow(row), score });
			}
			hits.sort((left, right) => {
				if (right.score !== left.score) {
					return right.score - left.score;
				}
				return left.chunk.id - right.chunk.id;
			});
			return hits.slice(0, topK);
		},

		/* ---------------- 技能绑定 ---------------- */

		setSkillBindings(skillId, kbIds) {
			const normalizedSkillId = (skillId ?? "").trim();
			if (normalizedSkillId.length === 0) {
				throw badRequest("技能 id 不能为空");
			}
			const unique = [...new Set(kbIds.map((id) => id.trim()).filter((id) => id.length > 0))];
			const missing: string[] = [];
			for (const kbId of unique) {
				if (!findKnowledgeBase(kbId)) {
					missing.push(kbId);
				}
			}
			if (missing.length > 0) {
				throw badRequest(`这些知识库不存在：${missing.join("、")}`);
			}
			tx(() => {
				db.prepare("DELETE FROM skill_kb_bindings WHERE skill_id = ?").run(normalizedSkillId);
				const statement = db.prepare("INSERT INTO skill_kb_bindings (skill_id, kb_id) VALUES (?, ?)");
				for (const kbId of unique) {
					statement.run(normalizedSkillId, kbId);
				}
			});
		},

		getSkillKbIds(skillId) {
			const rows = db
				.prepare("SELECT kb_id FROM skill_kb_bindings WHERE skill_id = ? ORDER BY kb_id")
				.all(skillId) as { kb_id: string }[];
			return rows.map((row) => row.kb_id);
		},

		listKnowledgeBasesByIds(ids) {
			const unique = [...new Set(ids)];
			if (unique.length === 0) {
				return [];
			}
			const rows = db
				.prepare(`${KB_LIST_SELECT} WHERE kb.id IN (${unique.map(() => "?").join(", ")}) ORDER BY kb.created_at ASC`)
				.all(...unique) as unknown as KnowledgeBaseDbRow[];
			return rows.map(mapKnowledgeBaseRow);
		},

		setDefaultKbIds(kbIds) {
			const unique = [...new Set(kbIds.map((id) => id.trim()).filter((id) => id.length > 0))];
			const missing: string[] = [];
			for (const kbId of unique) {
				if (!findKnowledgeBase(kbId)) {
					missing.push(kbId);
				}
			}
			if (missing.length > 0) {
				throw badRequest(`这些知识库不存在：${missing.join("、")}`);
			}
			tx(() => {
				db.prepare("DELETE FROM kb_default_bindings").run();
				const statement = db.prepare("INSERT INTO kb_default_bindings (kb_id) VALUES (?)");
				for (const kbId of unique) {
					statement.run(kbId);
				}
			});
		},

		getDefaultKbIds() {
			const rows = db
				.prepare("SELECT kb_id FROM kb_default_bindings ORDER BY kb_id")
				.all() as { kb_id: string }[];
			// 库被删后残留的绑定要跳过，否则检索会 404
			return rows.map((row) => row.kb_id).filter((kbId) => Boolean(findKnowledgeBase(kbId)));
		},
	};

	return store;
}
