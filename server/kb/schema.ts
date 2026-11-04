/**
 * 知识库表结构（SQLite）。
 *
 * 为什么建在会话库同一个文件里：`DB_PATH` 已经是"这台机器的数据目录"，
 * 知识库跟技能绑定是同一批业务数据，多一个库文件只会多一套备份/清理动作。
 * 表名和 `db/migrations/0001_init.sql` 里预留给 Postgres 的那几张保持一致，
 * 等 Docker 起来之后 DAO 换后端即可，业务代码不用改。
 *
 * 只做"幂等建表"：`CREATE TABLE IF NOT EXISTS` 对已存在的表不动，
 * 所以老库（`data/biz-agent.db`）第一次跑起来就会补上这四张表。
 */

import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

/** 一行知识库（列名转驼峰，映射只在 store.ts 做）。 */
export interface KnowledgeBaseRow {
	id: string;
	name: string;
	description: string | null;
	embeddingModel: string | null;
	chunkSize: number;
	chunkOverlap: number;
	similarityThreshold: number;
	createdAt: number;
	updatedAt: number;
	/** 该库的文档数（列表查询用子查询算出来，不落列） */
	docCount: number;
	/** 该库的块数 */
	chunkCount: number;
	/** 已经有向量的块数：>0 才说明这个库能走语义检索 */
	embeddedChunkCount: number;
}

/** 一份文档。`status` 目前只有 ready / failed，indexing 留给异步解析的将来。 */
export interface KbDocumentRow {
	id: string;
	kbId: string;
	filename: string;
	mime: string | null;
	bytes: number;
	status: string;
	error: string | null;
	chunkCount: number;
	createdAt: number;
	updatedAt: number;
}

/** 一个块。`embedding` 是 JSON 数组文本（模型维度不固定，不假设长度）。 */
export interface KbChunkRow {
	id: number;
	docId: string;
	kbId: string;
	seq: number;
	heading: string | null;
	content: string;
	tokens: number;
	embedding: string | null;
}

/**
 * 表结构。列名/类型与 `db/migrations/0001_init.sql` 的知识库部分一致
 * （那里是 PG 方言的 vector 列；SQLite 先存 JSON 文本，够 dev 规模用）。
 */
const KB_SCHEMA_DDL = `
	CREATE TABLE IF NOT EXISTS knowledge_bases (
		id                   TEXT PRIMARY KEY,
		name                 TEXT NOT NULL UNIQUE,
		description          TEXT,
		embedding_model      TEXT,
		chunk_size           INTEGER NOT NULL DEFAULT 800,
		chunk_overlap        INTEGER NOT NULL DEFAULT 120,
		similarity_threshold REAL NOT NULL DEFAULT 0.2,
		created_at           INTEGER NOT NULL,
		updated_at           INTEGER NOT NULL
	);
	CREATE TABLE IF NOT EXISTS kb_documents (
		id          TEXT PRIMARY KEY,
		kb_id       TEXT NOT NULL,
		filename    TEXT NOT NULL,
		mime        TEXT,
		bytes       INTEGER NOT NULL DEFAULT 0,
		status      TEXT NOT NULL,
		error       TEXT,
		chunk_count INTEGER NOT NULL DEFAULT 0,
		created_at  INTEGER NOT NULL,
		updated_at  INTEGER NOT NULL
	);
	CREATE TABLE IF NOT EXISTS kb_chunks (
		id        INTEGER PRIMARY KEY AUTOINCREMENT,
		doc_id    TEXT NOT NULL,
		kb_id     TEXT NOT NULL,
		seq       INTEGER NOT NULL,
		heading   TEXT,
		content   TEXT NOT NULL,
		tokens    INTEGER NOT NULL DEFAULT 0,
		embedding TEXT
	);
	CREATE TABLE IF NOT EXISTS skill_kb_bindings (
		skill_id TEXT NOT NULL,
		kb_id    TEXT NOT NULL,
		PRIMARY KEY (skill_id, kb_id)
	);
	CREATE INDEX IF NOT EXISTS idx_kb_documents_kb ON kb_documents (kb_id, created_at);
	CREATE INDEX IF NOT EXISTS idx_kb_chunks_kb ON kb_chunks (kb_id, doc_id, seq);
	CREATE INDEX IF NOT EXISTS idx_skill_kb_bindings_kb ON skill_kb_bindings (kb_id);
`;

/** 幂等建表；启动时由 `initKb()` 调一次，单测里也可以直接调。 */
export function ensureKbSchema(db: DatabaseSync): void {
	db.exec(KB_SCHEMA_DDL);
}

/**
 * 默认库位置：与 `server/db/index.ts` 的 `DEFAULT_DB_PATH` 同值（仓库根 data/biz-agent.db）。
 * 这里不 import 它，是为了让知识库模块能独立被单测/独立进程加载，不被存储层改造牵连。
 */
export const DEFAULT_KB_DB_PATH = fileURLToPath(new URL("../../data/biz-agent.db", import.meta.url));

/** 解析库文件路径：显式参数 > `DB_PATH` 环境变量 > 默认位置（与宿主同一套语义）。 */
export function resolveKbDbPath(explicitPath?: string | null): string {
	return resolve(explicitPath ?? process.env.DB_PATH ?? DEFAULT_KB_DB_PATH);
}
