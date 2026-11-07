/**
 * 知识库模块入口（宿主只 import 这一个文件）。
 *
 * 典型用法（`server/index.ts` 里三步）：
 *
 *   import { handleKb, initKb } from "./kb/index.js";
 *   initKb({ dbPath: DB_PATH });              // 启动时建表（幂等）
 *   // createServer 回调里、静态资源分支之前：
 *   if (await handleKb(req, res)) return;
 *
 * 下一轮接 `kb_search` 工具时直接用 `searchForSkill(skillId, query, topK)`，
 * 它读 `skill_kb_bindings` 里该技能绑定的知识库，跨库合并结果。
 */

import { getKb } from "./runtime.js";
import type { SkillSearchResponse } from "./service.js";

export { handleKb } from "./routes.js";
export { closeKb, getKb, initKb } from "./runtime.js";
export type { InitKbOptions } from "./runtime.js";
export { createKbService, createKbServiceForPath, mimeOf } from "./service.js";
export type {
	IngestDocumentInput,
	IngestResult,
	KbService,
	KnowledgeBaseView,
	SkillBindingsView,
	SkillSearchResponse,
} from "./service.js";
export { createKbStore, KB_LIMITS } from "./store.js";
export type { KbStore, KnowledgeBaseInput, NewChunkInput, NewDocumentInput } from "./store.js";
export { ensureKbSchema, resolveKbDbPath, DEFAULT_KB_DB_PATH } from "./schema.js";
export type { KbChunkRow, KbDocumentRow, KnowledgeBaseRow } from "./schema.js";
export { chunkText, CHUNK_DEFAULTS, estimateTokens } from "./chunk.js";
export type { ChunkOptions, TextChunk } from "./chunk.js";
export { parseDocument, PARSE_LIMITS, detectKind } from "./parse.js";
export type { ParsedDocument } from "./parse.js";
export { createEmbeddingClient, loadEmbeddingConfig } from "./embedding.js";
export type { EmbeddingClient, EmbeddingInfo } from "./embedding.js";
export { searchInKnowledgeBase, DEFAULT_TOP_K } from "./search.js";
export type { SearchOptions, SearchResponse, SearchResult } from "./search.js";
export { KbError } from "./errors.js";

/**
 * 技能视角的检索（`kb_search` 工具下一轮接它）。
 * 技能没绑定知识库 → 返回空结果（不是错误）。
 */
export function searchForSkill(
	skillId: string,
	query: string,
	topK?: number,
): Promise<SkillSearchResponse> {
	return getKb().searchForSkill(skillId, query, topK);
}

/**
 * 对话视角的检索（`kb_search` 工具用这条）：技能绑定 > Agent 绑定 > 对话默认。
 * 三层都空则返回空结果（不是错误），模型照常回答并如实说明。
 */
export function searchForContext(
	skillId: string | null,
	query: string,
	topK?: number,
	agentKbIds?: string[],
): Promise<SkillSearchResponse> {
	return getKb().searchForContext(skillId, query, topK, agentKbIds);
}
