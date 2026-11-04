/**
 * 知识库 DAO（Postgres / pgvector）。
 *
 * 与 `store.ts`（SQLite）共用同一份 `KbStore` 契约：上层（service/search/routes/tool）完全不知道
 * 底下是哪种库。差异只有一处——**语义检索**：SQLite 把向量存 JSON 文本、读回内存算余弦；
 * 这里用 pgvector 的 `embedding <=> $vec` 直接把排序下推给数据库，只回命中行。
 *
 * 为什么也是同步接口：`KbStore` 的方法被 service 层的同步代码直接调用（列表/落库/绑定），
 * 改成全异步会把 service/routes/tool/selftest 全改一遍。这里复用宿主存储层那套
 * “主线程 Atomics.wait、工作线程跑 pg”的同步桥（`server/db/syncBridge.ts`），
 * 代价与 dort 的 PostgresStorage 一样：每次调用阻塞主线程毫秒级（单机控制台够用）。
 *
 * 表结构不在本文件建：Postgres 的 DDL 唯一真相是 `db/migrations/*.sql`（启动时 `openStore()` 已跑过迁移，
 * 这里只做“表在不在 + vector 扩展装没装”的体检，缺了给中文人话而不是让 pg 抛内部错误）。
 */

import { randomUUID } from "node:crypto";
import { SyncWorkerBridge } from "../db/syncBridge.js";
import { badRequest, notFound } from "./errors.js";
import { escapeLike, KB_LIMITS, KB_LIST_SELECT, mapChunkRow, mapDocumentRow, mapKnowledgeBaseRow, normalizeKnowledgeBaseInput } from "./store.js";
import type { KbStore, KbVectorHit } from "./store.js";
import type { KbDocumentRow, KnowledgeBaseRow } from "./schema.js";

/** 工作线程入口与宿主存储层共用（同一个通用 SQL 执行器，不新写一套 Worker）。 */
const WORKER_URL = new URL("../db/postgresWorker.ts", import.meta.url);

function vectorLiteral(values: number[]): string {
	return `[${values.map((value) => (Number.isFinite(value) ? value : 0)).join(",")}]`;
}

/** pg 会把 bigint 列（count / created_at）回成字符串，行映射统一在 store.ts 里做 Number()。 */
function rowsOf(result: { rows: Record<string, unknown>[] }): Record<string, unknown>[] {
	return result.rows;
}

export interface CreateKbPgStoreOptions {
	/** 连接串（一般就是宿主进程的 DATABASE_URL） */
	databaseUrl: string;
}

/**
 * 打开 Postgres 知识库 DAO。要求 `db/migrations/*.sql` 已经在这个库上跑过
 * （`openStore()` 在启动阶段会自动跑；单独跑脚本时先 `npm run db:migrate`）。
 */
export function createKbPgStore(options: CreateKbPgStoreOptions): KbStore {
	const databaseUrl = options.databaseUrl.trim();
	if (databaseUrl.length === 0) {
		throw new Error("createKbPgStore 需要 DATABASE_URL（Postgres 连接串）");
	}
	const bridge = new SyncWorkerBridge(WORKER_URL);
	bridge.init(databaseUrl);

	// 表是否已建：迁移没跑就先报中文错误，别让第一个请求 500
	try {
		bridge.query("SELECT 1 FROM knowledge_bases LIMIT 1");
	} catch (error) {
		bridge.close();
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(
		`Postgres 里没有知识库表（${detail}）。请先跑 npm run db:migrate（DATABASE_URL 要指向同一个库）。`,
		);
	}

	// pgvector 扩展：没装时语义检索不可用，但知识库整块仍要能用（关键词检索回退）
	let vectorReady = false;
	try {
		const extension = bridge.query("SELECT extname FROM pg_extension WHERE extname = 'vector'");
		vectorReady = extension.rows.length > 0;
	} catch {
		// 连扩展目录都查不到就当没装
	}
	if (!vectorReady) {
		console.warn(
			"[kb] 这个 Postgres 没装 pgvector 扩展：知识库只能关键词检索（跑迁移或 create extension vector 后重启即可）",
		);
	}

	const parsed = new URL(databaseUrl);
	const displayPath = `${parsed.hostname}:${parsed.port || "5432"}/${parsed.pathname.replace(/^\//, "") || "postgres"}`;

	function query(sql: string, params: unknown[] = []) {
		return bridge.query(sql, params);
	}

	function findKnowledgeBase(id: string): KnowledgeBaseRow | undefined {
		const row = rowsOf(query(`${KB_LIST_SELECT} WHERE kb.id = $1`, [id]))[0];
		return row ? mapKnowledgeBaseRow(row as never) : undefined;
	}

	function findDocument(id: string): KbDocumentRow | undefined {
		const row = rowsOf(query("SELECT * FROM kb_documents WHERE id = $1", [id]))[0];
		return row ? mapDocumentRow(row as never) : undefined;
	}

	function countOf(sql: string, params: unknown[], field = "total"): number {
		const row = rowsOf(query(sql, params))[0];
		return row ? Number(row[field] ?? 0) : 0;
	}

	const store: KbStore = {
		info() {
			return { path: displayPath, kind: "postgres" as const };
		},

		close() {
			bridge.close();
		},

		/* ---------------- 知识库 ---------------- */

		createKnowledgeBase(input) {
			const normalized = normalizeKnowledgeBaseInput(input);
			const existing = rowsOf(query("SELECT id FROM knowledge_bases WHERE name = $1", [normalized.name]));
			if (existing.length > 0) {
				throw badRequest(`同名知识库已存在：${normalized.name}`);
			}
			const id = `kb_${randomUUID()}`;
			const now = Date.now();
			query(
				`INSERT INTO knowledge_bases
					(id, name, description, embedding_model, chunk_size, chunk_overlap, similarity_threshold, created_at, updated_at)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
				[
					id,
					normalized.name,
					normalized.description,
					normalized.embeddingModel,
					normalized.chunkSize,
					normalized.chunkOverlap,
					normalized.similarityThreshold,
					now,
					now,
				],
			);
			return findKnowledgeBase(id)!;
		},

		listKnowledgeBases() {
			const rows = rowsOf(query(`${KB_LIST_SELECT} ORDER BY kb.created_at ASC`));
			return rows.map((row) => mapKnowledgeBaseRow(row as never));
		},

		getKnowledgeBase(id) {
			return findKnowledgeBase(id);
		},

		removeKnowledgeBase(id) {
			if (!findKnowledgeBase(id)) {
				return { removed: false, documentsRemoved: 0, chunksRemoved: 0 };
			}
			const documentsRemoved = countOf("SELECT COUNT(*)::int AS total FROM kb_documents WHERE kb_id = $1", [id]);
			const chunksRemoved = countOf("SELECT COUNT(*)::int AS total FROM kb_chunks WHERE kb_id = $1", [id]);
			// 分块没有 kb_id 外键，必须显式删；文档/绑定有级联，但显式删更直白（迁移没跑全时也不留孤儿）
			bridge.transaction([
				{ sql: "DELETE FROM kb_chunks WHERE kb_id = $1", params: [id] },
				{ sql: "DELETE FROM kb_documents WHERE kb_id = $1", params: [id] },
				{ sql: "DELETE FROM skill_kb_bindings WHERE kb_id = $1", params: [id] },
				{ sql: "DELETE FROM knowledge_bases WHERE id = $1", params: [id] },
			]);
			return { removed: true, documentsRemoved, chunksRemoved };
		},

		/* ---------------- 文档 ---------------- */

		insertDocument(input) {
			if (!findKnowledgeBase(input.kbId)) {
				throw notFound(`知识库不存在：${input.kbId}`);
			}
			const id = `doc_${randomUUID()}`;
			const now = Date.now();
			query(
				`INSERT INTO kb_documents
					(id, kb_id, filename, mime, bytes, status, error, chunk_count, created_at, updated_at)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
				[
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
				],
			);
			return findDocument(id)!;
		},

		updateDocument(id, patch) {
			const current = findDocument(id);
			if (!current) {
				throw notFound(`文档不存在：${id}`);
			}
			query(
				`UPDATE kb_documents
				 SET status = $1, error = $2, chunk_count = $3, updated_at = $4
				 WHERE id = $5`,
				[
					patch.status ?? current.status,
					patch.error === undefined ? current.error : patch.error,
					Math.max(0, Math.round(patch.chunkCount ?? current.chunkCount)),
					Date.now(),
					id,
				],
			);
		},

		listDocuments(kbId) {
			const rows = rowsOf(query("SELECT * FROM kb_documents WHERE kb_id = $1 ORDER BY created_at ASC", [kbId]));
			return rows.map((row) => mapDocumentRow(row as never));
		},

		getDocument(id) {
			return findDocument(id);
		},

		removeDocument(id) {
			if (!findDocument(id)) {
				return { removed: false, chunksRemoved: 0 };
			}
			const chunksRemoved = countOf("SELECT COUNT(*)::int AS total FROM kb_chunks WHERE doc_id = $1", [id]);
			bridge.transaction([
				{ sql: "DELETE FROM kb_chunks WHERE doc_id = $1", params: [id] },
				{ sql: "DELETE FROM kb_documents WHERE id = $1", params: [id] },
			]);
			return { removed: true, chunksRemoved };
		},

		/* ---------------- 分块 ---------------- */

		insertChunks(docId, kbId, chunks) {
			if (chunks.length === 0) {
				return [];
			}
			const now = Date.now();
			const values: unknown[] = [];
			const tuples = chunks.map((chunk, index) => {
				const base = index * 8;
				values.push(
					docId,
					kbId,
					chunk.seq,
					chunk.heading,
					chunk.content,
					chunk.tokens,
					chunk.embedding ?? null,
					now,
				);
				return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}::vector, $${base + 8})`;
			});
			const result = query(
				`INSERT INTO kb_chunks (doc_id, kb_id, seq, heading, content, tokens, embedding, created_at)
				 VALUES ${tuples.join(", ")} RETURNING id`,
				values,
			);
			return rowsOf(result).map((row) => Number(row.id));
		},

		listChunks(kbId, options = {}) {
			const limit = Math.max(1, Math.min(KB_LIMITS.listChunksLimit, Math.round(options.limit ?? KB_LIMITS.listChunksLimit)));
			const where: string[] = ["kb_id = $1"];
			const params: unknown[] = [kbId];
			if (options.onlyEmbedded) {
				where.push("embedding IS NOT NULL");
			}
			const tokens = (options.likeTokens ?? []).filter((token) => token.length > 0);
			if (tokens.length > 0) {
				const clauses: string[] = [];
				for (const token of tokens) {
					const patternIndex = params.length + 1;
					params.push(`%${escapeLike(token)}%`);
					clauses.push(`(content LIKE $${patternIndex} OR COALESCE(heading, '') LIKE $${patternIndex})`);
				}
				where.push(`(${clauses.join(" OR ")})`);
			}
			const limitIndex = params.length + 1;
			params.push(limit);
			const rows = rowsOf(
				query(
					`SELECT * FROM kb_chunks WHERE ${where.join(" AND ")} ORDER BY doc_id, seq LIMIT $${limitIndex}`,
					params,
				),
			);
			return rows.map((row) => mapChunkRow(row as never));
		},

		countChunks(kbId) {
			return countOf("SELECT COUNT(*)::int AS total FROM kb_chunks WHERE kb_id = $1", [kbId]);
		},

		countEmbeddedChunks(kbId) {
			return countOf(
				"SELECT COUNT(*)::int AS total FROM kb_chunks WHERE kb_id = $1 AND embedding IS NOT NULL",
				[kbId],
			);
		},

		updateChunkEmbeddings(updates) {
			if (updates.length === 0) {
				return;
			}
			bridge.transaction(
				updates.map((update) => ({
					sql: "UPDATE kb_chunks SET embedding = $1::vector WHERE id = $2",
					params: [update.embedding, update.id],
				})),
			);
		},

		setEmbeddingModel(id, model) {
			query("UPDATE knowledge_bases SET embedding_model = $1, updated_at = $2 WHERE id = $3", [
				model,
				Date.now(),
				id,
			]);
		},

		searchByEmbedding(kbId, queryVector, options) {
			if (!vectorReady) {
				throw new Error("这个 Postgres 没装 pgvector 扩展（create extension vector），语义检索不可用");
			}
			const topK = Math.max(1, Math.min(KB_LIMITS.topKMax, Math.round(options.topK)));
			const threshold = Number.isFinite(options.threshold) ? options.threshold : 0;
			const literal = vectorLiteral(queryVector);
			const result = query(
				`SELECT
					id, doc_id, kb_id, seq, heading, content, tokens, embedding::text AS embedding,
					1 - (embedding <=> $2::vector) AS score
				 FROM kb_chunks
				 WHERE kb_id = $1 AND embedding IS NOT NULL
				   AND 1 - (embedding <=> $2::vector) >= $3
				 ORDER BY embedding <=> $2::vector ASC, id ASC
				 LIMIT $4`,
				[kbId, literal, threshold, topK],
			);
			const hits: KbVectorHit[] = [];
			for (const row of rowsOf(result)) {
				hits.push({
					chunk: mapChunkRow(row as never),
					score: Math.round(Number(row.score ?? 0) * 10000) / 10000,
				});
			}
			return hits;
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
			const steps: { sql: string; params?: unknown[] }[] = [
				{ sql: "DELETE FROM skill_kb_bindings WHERE skill_id = $1", params: [normalizedSkillId] },
			];
			if (unique.length > 0) {
				const values: unknown[] = [normalizedSkillId];
				const tuples = unique.map((kbId, index) => {
					values.push(kbId);
					return `($1, $${index + 2})`;
				});
				steps.push({
					sql: `INSERT INTO skill_kb_bindings (skill_id, kb_id) VALUES ${tuples.join(", ")}`,
					params: values,
				});
			}
			bridge.transaction(steps);
		},

		getSkillKbIds(skillId) {
			const rows = rowsOf(
				query("SELECT kb_id FROM skill_kb_bindings WHERE skill_id = $1 ORDER BY kb_id", [skillId]),
			);
			return rows.map((row) => String(row.kb_id));
		},

		listKnowledgeBasesByIds(ids) {
			const unique = [...new Set(ids)];
			if (unique.length === 0) {
				return [];
			}
			const rows = rowsOf(
				query(`${KB_LIST_SELECT} WHERE kb.id = ANY($1::text[]) ORDER BY kb.created_at ASC`, [unique]),
			);
			return rows.map((row) => mapKnowledgeBaseRow(row as never));
		},
	};

	return store;
}
