-- P5 收尾（Postgres/pgvector）：把知识库块向量列改成“无固定维度”。
--
-- 为什么：`0001_init.sql` 里预留的是 `vector(1024)`，但向量维度由 EMBEDDING_MODEL 决定
-- （text-embedding-3-small 是 1536、bge-m3 是 1024、text-embedding-3-large 是 3072），
-- 固定 1024 会让换模型的库直接写失败。pgvector 的 `vector` 不写维度就接受任意长度；
-- 代价是 HNSW 索引必须有固定维度，所以这里把那条索引去掉，检索退回精确余弦扫描
-- （知识库是单机控制台的量级，精确扫描比维护“按模型分列”的复杂度更划算）。
--
-- 幂等：只改列类型并删索引，重放不会报错。

alter table kb_chunks
	alter column embedding type vector
	using embedding::vector;

drop index if exists idx_kb_chunks_embedding;
