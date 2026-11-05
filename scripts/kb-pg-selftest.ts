/**
 * 知识库 Postgres / pgvector 自检（`npm run kb:pg:selftest`）。
 *
 * 前置：`DATABASE_URL` 指向一个已跑过 `npm run db:migrate` 的 Postgres；
 * 没有 Docker 时用 `data/_tmp/pgtest/server-vector.mjs`（PGlite + pgvector，真 PG 18 内核）
 * 起一个本机 socket 服务即可。没配 `DATABASE_URL` 时打印「跳过」并 exit 0（不阻断默认验证闭环）。
 *
 * 覆盖：DAO 全接口（建库/唯一名/文档/分块/向量写入/计数/绑定/级联删除）、
 * pgvector 余弦检索（排序/阈值/topK/维度不固定）、service 层假 embedding 注入后的
 * “上传即向量化 + 语义检索 mode=vector”、向量化失败回退关键词并带 fallbackReason。
 */

import assert from "node:assert/strict";
import { createKbPgStore } from "../server/kb/pgStore.js";
import { cosineSimilarity } from "../server/kb/search.js";
import { createKbService } from "../server/kb/service.js";
import type { EmbeddingClient } from "../server/kb/embedding.js";
import type { KbStore } from "../server/kb/store.js";

const databaseUrl = (process.env.DATABASE_URL ?? "").trim();
if (databaseUrl.length === 0) {
	console.log("未配置 DATABASE_URL，跳过 Postgres/pgvector 自检（先 npm run db:migrate 建库再跑）");
	process.exit(0);
}

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

function expectBadRequest(action: () => unknown, contains: string): void {
	assert.throws(
		() => action(),
		(error: unknown) => {
			assert.ok(error instanceof Error, "应当是 Error");
			assert.ok(error.message.includes(contains), `错误文案应包含「${contains}」，实际：「${(error as Error).message}」`);
			return true;
		},
	);
}

function vectorText(values: number[]): string {
	return `[${values.join(",")}]`;
}

/** 假 embedding：按文本关键词给固定向量，避免打真实网络。 */
function fakeEmbedding(dim = 3, behavior: "ok" | "throw" = "ok"): EmbeddingClient {
	return {
		available: () => true,
		info: () => ({ available: true, model: `fake-embedding-${dim}d`, baseUrl: "in-process", source: "env" as const, modelKey: null, problem: null }),
		async embed(texts: string[]): Promise<number[][]> {
			if (behavior === "throw") {
				throw new Error("假向量化服务故意失败（验证关键词回退）");
			}
			return texts.map((text) => {
				const vector = new Array(dim).fill(0) as number[];
				// 关键词 → 固定语义方向：苹果/红色 → 第 1 维；香蕉/黄色 → 第 2 维；其它 → 第 3 维
				if (text.includes("苹果") || text.includes("红色")) {
					vector[0] = 1;
				} else if (text.includes("香蕉") || text.includes("黄色")) {
					vector[1] = 1;
				} else {
					vector[2 % dim] = 1;
				}
				return vector;
			});
		},
	};
}

const store: KbStore = createKbPgStore({ databaseUrl });
const cleaned: string[] = [];

try {
	await check("info：后端是 postgres，路径带连接目标", () => {
		const info = store.info();
		assert.equal(info.kind, "postgres");
		assert.ok(info.path.length > 0);
	});

	const kb = store.createKnowledgeBase({ name: `pg-selftest-${Date.now()}`, description: null });
	cleaned.push(kb.id);
	await check("建库：默认分块参数落库（chunkSize=800 / overlap=120 / 阈值 0.2）", () => {
		assert.equal(kb.chunkSize, 800);
		assert.equal(kb.chunkOverlap, 120);
		assert.equal(kb.similarityThreshold, 0.2);
		assert.equal(kb.docCount, 0);
		assert.equal(kb.chunkCount, 0);
		assert.equal(kb.embeddedChunkCount, 0);
	});
	await check("建库：同名重复 → 400 中文", () => {
		expectBadRequest(() => store.createKnowledgeBase({ name: kb.name }), "同名知识库已存在");
	});
	await check("建库：名称为空 / 说明超长 → 400 中文", () => {
		expectBadRequest(() => store.createKnowledgeBase({ name: "  " }), "名称不能为空");
		expectBadRequest(
			() => store.createKnowledgeBase({ name: `x-${Date.now()}`, description: "长".repeat(1001) }),
			"说明最多",
		);
	});
	await check("列表/详情：能查回，计数一致", () => {
		const list = store.listKnowledgeBases();
		assert.equal(list.length, 1);
		assert.equal(store.getKnowledgeBase(kb.id)?.name, kb.name);
		assert.equal(store.getKnowledgeBase("kb_missing") , undefined as never);
	});

	const doc = store.insertDocument({ kbId: kb.id, filename: "水果.txt", mime: "text/plain", bytes: 10, status: "ready", chunkCount: 3 });
	const chunkIds = store.insertChunks(doc.id, kb.id, [
		{ seq: 0, heading: "苹果", content: "苹果是红色的水果", tokens: 6 },
		{ seq: 1, heading: "香蕉", content: "香蕉是黄色的水果", tokens: 6 },
		{ seq: 2, heading: null, content: "西瓜是绿色的水果", tokens: 6 },
	]);
	await check("分块：insertChunks 返回 3 个 bigserial id，计数/onlyEmbedded 正确", () => {
		assert.equal(chunkIds.length, 3);
		assert.ok(chunkIds.every((id) => Number.isInteger(id) && id > 0));
		assert.equal(store.countChunks(kb.id), 3);
		assert.equal(store.countEmbeddedChunks(kb.id), 0);
		const onlyEmbedded = store.listChunks(kb.id, { onlyEmbedded: true });
		assert.equal(onlyEmbedded.length, 0);
		const all = store.listChunks(kb.id);
		assert.equal(all.length, 3);
		assert.equal(all[0]!.seq, 0);
		assert.equal(all[0]!.heading, "苹果");
	});

	store.updateChunkEmbeddings([
		{ id: chunkIds[0]!, embedding: vectorText([1, 0, 0]) },
		{ id: chunkIds[1]!, embedding: vectorText([0, 1, 0]) },
		{ id: chunkIds[2]!, embedding: vectorText([0, 0, 1]) },
	]);
	await check("向量写入：countEmbedded=3，读回的 embedding 是可解析的向量文本", () => {
		assert.equal(store.countEmbeddedChunks(kb.id), 3);
		const chunks = store.listChunks(kb.id, { onlyEmbedded: true });
		assert.equal(chunks.length, 3);
		assert.equal(chunks[0]!.embedding, "[1,0,0]");
	});

	await check("pgvector 检索：余弦排序、阈值、topK", () => {
		const all = store.searchByEmbedding(kb.id, [1, 0, 0], { topK: 6, threshold: 0 });
		assert.equal(all.length, 3);
		assert.equal(all[0]!.chunk.heading, "苹果");
		// 余弦 1 的排第一，香蕉/西瓜是 0；三个都是分数降序
		assert.equal(all[0]!.score, 1);
		assert.equal(all[1]!.score, 0);
		assert.equal(all[2]!.score, 0);
		// 苹果 [1,0,0] 相似度 1，香蕉/西瓜 0 → 阈值 0.2 只剩 1 条，阈值 0.5 同样只剩 1 条
		assert.equal(store.searchByEmbedding(kb.id, [1, 0, 0], { topK: 6, threshold: 0.2 }).length, 1);
		assert.equal(store.searchByEmbedding(kb.id, [1, 0, 0], { topK: 6, threshold: 0.5 }).length, 1);
		assert.equal(store.searchByEmbedding(kb.id, [1, 0, 0], { topK: 1, threshold: 0 }).length, 1);
		const loose = store.searchByEmbedding(kb.id, [1, 1, 0], { topK: 6, threshold: 0 });
		assert.equal(loose.length, 3);
		assert.ok(loose[0]!.score >= loose[1]!.score);
		// 余弦分与 SQL 里的 1 - distance 一致
		assert.ok(Math.abs(loose[0]!.score - cosineSimilarity([1, 1, 0], [1, 0, 0])) < 0.001);
	});

	await check("pgvector：维度不固定（换 5 维向量也能写回，0007 迁移去掉 vector(1024) 的意义）", () => {
		const doc2 = store.insertDocument({ kbId: kb.id, filename: "维度.txt", mime: "text/plain", bytes: 1, status: "ready" });
		const ids = store.insertChunks(doc2.id, kb.id, [{ seq: 0, heading: null, content: "任意维度", tokens: 2 }]);
		store.updateChunkEmbeddings([{ id: ids[0]!, embedding: vectorText([1, 2, 3, 4, 5]) }]);
		assert.equal(store.countEmbeddedChunks(kb.id), 4);
		// 维度混合时检索应当报错（pgvector 的语义），不能假装成功——上层 search 会回退关键词
		assert.throws(
			() => store.searchByEmbedding(kb.id, [1, 0, 0], { topK: 6, threshold: 0 }),
			/dimension|维度/i,
		);
		store.removeDocument(doc2.id);
	});

	await check("技能绑定：覆盖式设置/读回/不存在库 400", () => {
		const kb2 = store.createKnowledgeBase({ name: `pg-selftest-b2-${Date.now()}` });
		cleaned.push(kb2.id);
		store.setSkillBindings("skill_pg_test", [kb.id, kb2.id]);
		assert.deepEqual(store.getSkillKbIds("skill_pg_test"), [kb.id, kb2.id].sort());
		store.setSkillBindings("skill_pg_test", [kb.id]);
		assert.deepEqual(store.getSkillKbIds("skill_pg_test"), [kb.id]);
		expectBadRequest(() => store.setSkillBindings("skill_pg_test", ["kb_missing"]), "不存在");
		assert.equal(store.listKnowledgeBasesByIds([kb2.id])[0]?.id, kb2.id);
		store.removeKnowledgeBase(kb2.id);
	});

	await check("级联删除：删文档 → 分块清零；删库 → 计数与绑定一起没", () => {
		const removedDoc = store.removeDocument(doc.id);
		assert.equal(removedDoc.removed, true);
		assert.equal(removedDoc.chunksRemoved, 3);
		assert.equal(store.countChunks(kb.id), 0);
		const removed = store.removeKnowledgeBase(kb.id);
		assert.equal(removed.removed, true);
		// 两份文档都已经在上一段删掉了，所以这里两个计数都是 0
		assert.equal(removed.chunksRemoved, 0);
		assert.equal(removed.documentsRemoved, 0);
		assert.equal(store.getKnowledgeBase(kb.id), undefined as never);
		assert.deepEqual(store.getSkillKbIds("skill_pg_test"), []);
		cleaned.splice(cleaned.indexOf(kb.id), 1);
	});

	// ---- service 层：假 embedding → 上传即向量化 → 检索走 vector ----
	const svcKb = store.createKnowledgeBase({ name: `pg-selftest-svc-${Date.now()}` });
	cleaned.push(svcKb.id);
	const service = createKbService({ store, embedding: fakeEmbedding(3) });
	const ingest = await service.ingestDocument({
		kbId: svcKb.id,
		filename: "水果.txt",
		mime: "text/plain",
		data: Buffer.from("苹果是红色的水果，香蕉是黄色的水果。", "utf8"),
	});
	await check("service：上传即向量化（embedded=true，块有向量）", () => {
		assert.equal(ingest.embedded, true);
		assert.ok(ingest.chunkCount >= 1);
		assert.equal(store.countEmbeddedChunks(svcKb.id), ingest.chunkCount);
	});
	await check("service：语义检索 mode=vector 且命中苹果", async () => {
		const response = await service.search(svcKb.id, "红色的水果是什么", { topK: 3 });
		assert.equal(response.mode, "vector");
		assert.ok(response.results.length >= 1);
		assert.ok(response.results[0]!.snippet.includes("苹果"));
		assert.equal(response.results[0]!.mode, "vector");
	});

	// 换一个“查询时向量化失败”的客户端：库里有向量 → 仍进向量分支 → 失败必须回退关键词
	const brokenService = createKbService({ store, embedding: fakeEmbedding(3, "throw") });
	await check("service：查询向量化失败 → 回退关键词 + fallbackReason（绝不 500）", async () => {
		const response = await brokenService.search(svcKb.id, "水果", { topK: 3 });
		assert.equal(response.mode, "keyword");
		assert.ok(response.fallbackReason && response.fallbackReason.includes("故意失败"));
		assert.ok(response.results.length >= 1);
	});

	await check("service：上传时向量化失败不阻断落库（embedded=false + warning）", async () => {
		const failing = createKbService({ store, embedding: fakeEmbedding(3, "throw") });
		const result = await failing.ingestDocument({
			kbId: svcKb.id,
			filename: "香蕉.txt",
			mime: "text/plain",
			data: Buffer.from("香蕉是黄色的水果。", "utf8"),
		});
		assert.equal(result.embedded, false);
		assert.ok(result.warning && result.warning.includes("向量化失败"));
	});

	store.setSkillBindings("skill_pg_svc", [svcKb.id]);
	await check("service.searchForSkill：按技能绑定跨库检索", async () => {
		const response = await service.searchForSkill("skill_pg_svc", "水果", 3);
		assert.deepEqual(response.kbIds, [svcKb.id]);
		assert.equal(response.mode, "vector");
	});
} finally {
	for (const id of cleaned) {
		try {
			store.removeKnowledgeBase(id);
		} catch {
			// 已经删掉/不存在就忽略
		}
	}
	store.close();
}

console.log(`\n知识库 Postgres/pgvector 自检通过：${passed} 项`);
