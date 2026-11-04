# 路线图：从「会话 + 技能」控制台到企业 Agent 平台

对照 `sangshy-go/AgentOne` 的能力清单，把差距拆成 9 个可独立验收的阶段。
用户已确认：**全部都做**，允许 **docker + pgvector**；界面仍是原生 JS、无构建步骤（不引 Vue，避免多一套构建链）。

原则：

1. **每阶段都要能跑**：`typecheck` / `verify` / `ui-check` / `ui-dom-check` / `smoke` 全绿 + 对应新断言。
2. **界面不出现假的**：后端没做好的能力，界面上明确写「未接入 + 需要什么」，不摆假数据。
3. **存储双轨**：默认 SQLite（`DB_PATH`，零依赖、跑测试快）；配了 `DATABASE_URL` 就走 Postgres。
   同一套 DAO 接口，两种实现，测试对两边都要能跑。知识库的 pgvector 表/列已在迁移里预留，
   但这一轮检索仍走 SQLite 本地 JSON 向量（见关键决策「KB 表走 server/kb/schema.ts」）。

---

## 阶段与状态

| # | 阶段 | 内容 | 验收 | 状态 |
|---|---|---|---|---|
| P1 | 侧边栏模块导航壳 | 左侧图标导航（对话/知识库/技能/模型/MCP/IM/审批/审计/成员/监控/设置）+ 模块页骨架；模块页接真实数据，接口 404 / 连不上时才回落到「未接入」说明（最终 11 个模块全部真数据） | `ui-dom-check` 覆盖 11 个模块的切换与占位文案（230 项）；`ui-shot` 截图核对（对话 / 技能 / 模块页 / 模型） | 完成 |
| P2 | 存储层 + Postgres/pgvector | `docker-compose.yml`；`db/migrations/*.sql`；DAO 双实现；启动时迁移；`/api/health` 报存储后端 | `smoke` 在 SQLite 与 PG 上各跑一遍（含 `health.storage`）；`persist-check` 两边都过 | 完成（pgvector 待真镜像复核） |
| P3 | 企业安全 | 登录（scrypt 密码）、JWT、RBAC 四角色（所有者/开发者/运营/审计员）、登录失败限流、写操作审计落库、成员管理写接口（改角色/停用/删除 + 保护规则） | `auth:selftest` 41 项 + `smoke:auth` 51 项（401/403、角色矩阵、限流、审计、成员保护）+ 默认 `smoke`（`AUTH_MODE=off` 放行） | 完成 |
| P4 | 开放 API | API Key 生命周期（`bk_` 明文只出现一次、库里只存 sha256 + 前 8 位 prefix、软吊销）+ 令牌桶限流 + `/v1/chat`（非流式 + SSE `[DONE]`）+ `/v1/health` + 统一错误形状与 api_key 审计 | `smoke:openapi` 53 项（Key 明文一次性 / 非流式 / 流式 / 401 / 403 / 429 + `Retry-After` / 审计） | 完成 |
| P5 | 知识库 RAG | 上传（PDF/Word/MD/TXT/CSV）→ 解析 → 分块（长度/标题/段落）→ 向量化 → 检索；技能可绑定多个知识库 + 相似度阈值；`kb_search` 工具 | `kb:selftest` 52 项 + `smoke` 场景 G 24 项（建库/上传/检索/绑定/删除；无 embedding key 时回退关键词并有断言） | 完成 |
| P6 | 多模型管理 | 供应商与模型两层、OpenAI 协议兼容、按工作空间配置、连通性检测；API Key 用 AES-256-GCM 加密落库、出参只回掩码；首启用 `.env` 的 key 建 `default` 供应商；切当前模型；PG 增量迁移 `0003_models.sql` | `models:selftest` 22 项 + `smoke:openapi` 的 CRUD / ping（成功 + 不可达）/ 切当前模型 / 向后兼容断言 | 完成 |
| P7 | MCP 集成 | stdio / HTTP(Streamable) / SSE 三种传输（手写 JSON-RPC 2.0，零依赖）；注册即发现、工具进 `/api/tools` 与会话工具集、工具启停、调试调用；PG 增量迁移 `0004_mcp.sql` | `mcp:selftest` 30 项 + `smoke:mcp` 45 项（用本地 stdio 假 MCP Server 跑通发现 / 调用 / 启停 / 删除） | 完成 |
| P8 | IM Bot 网关 | 钉钉回调（@对话）+ 加签/AES 回调解密、凭证 AES-256-GCM 加密、多轮会话映射与 msgId 幂等、出站（fake / real 传输 + 重试）；PG 增量迁移 `0006_im.sql` | `im:selftest` 26 项 + `smoke:im` 37 项（用伪造加签请求验签名与回包、同 msgId 幂等、同 conversationId 只映射一个会话、停用 403、删除 404） | 完成 |
| P9 | 监控与可观测 | 对话全量留痕（`trace_id` + 五类事件）、调用链列表/详情、工作台聚合、审计查询增强（`actorType`/`targetType`/时间/关键字）、监控页接真数据；PG 增量迁移 `0005_observability.sql` | `obs:selftest` 22 项 + `smoke:monitor` 61 项（trace_id / summary / 列表 / 详情 / 角色边界 / range / 审计过滤） | 完成 |
| 贯穿项 | 模块页全部接真接口 | **11 个模块页全部接真接口、无空态占位**：`知识库` / `模型` / `MCP` / `IM 机器人` / `审批` / `成员` / `审计` / `设置`（含 API Key 管理）/ `监控` / `技能` 都从「未接入」换成真接口页；`审批` 接 `/api/approvals*`（待办列表 + 批准/拒绝 + 10s 轮询），`成员` 接 `/api/auth/users` 的 PATCH/DELETE（改角色/停用/删除） | `ui-dom-check` 230 项（含各模块页的加载 / 失败 / 403 / 空态接线） | 完成 |

**贯穿项已完成**：11 个模块页全部接真接口、没有空态占位；每个阶段完成后同步 `README.md` / `AGENTS.md`
（接口表、项数、坑）的约定继续有效。

---

## 关键决策

- **前端不引 Vue/构建链**：AgentOne 用 Vue 3 + Naive UI，我们已经是原生 JS + 零构建；引入 Vue 等于重写且多一条构建/发布链。
  用原生 JS 实现同样的信息架构（图标导航 + 模块页 + 表格/表单），观感靠 `ui-shot` 校验。
- **Postgres 用官方的 `pgvector/pgvector:pg16` 镜像**，端口映射到 `5433`（避免和本机既有 5432 冲突）；
  迁移是纯 SQL 文件 + 启动时按 `schema_migrations` 表顺序执行（不引 Flyway/JVM）。
- **Embedding 可插拔 + 关键词兜底**：`EMBEDDING_BASE_URL` / `EMBEDDING_MODEL` / `EMBEDDING_API_KEY` 走 OpenAI 协议
  （`server/kb/embedding.ts`，可指向中转 / Ollama / vLLM）；没配 key 或调用失败时 `server/kb/search.ts` 自动切到
  **关键词检索**（中文 2-gram + 标题加权），响应用 `mode: "vector" | "keyword"` 如实标注，界面明示"语义检索未启用"，
  绝不假装有向量。向量化失败也不阻断上传（文档先落库，检索回退）。
- **KB 表走 `server/kb/schema.ts`，不塞进 `db/migrations/*.sql`**：知识库这一轮只支持 SQLite（DAO 在
  `server/kb/store.ts`），表与会话同 `DB_PATH` 库文件、启动时幂等建表；`db/migrations/0001_init.sql` 里的 PG 建表
  与 `vector` 列只是**预留**，没有任何 DAO 会切过去。等 pgvector 检索真接上时再抽 `KbStorage`，别现在把 PG 方言
  塞进 SQLite 的建表路径。
- **RBAC 权限点矩阵的唯一真相在 `server/auth/roles.ts`**：`permissionFor()`（方法 + 路径 → 权限点）、`can()`、
  中文角色名与 403 文案都只维护这一份；路由层、`/api/auth/me`、`auth:selftest` / `smoke:auth` 全部从它读，
  别在 `server/index.ts` 或前端再抄一份矩阵。
- **密码与令牌零依赖**：`node:crypto` 的 `scrypt`（代替 BCrypt）+ HMAC-SHA256 JWT（代替 Sa-Token）。
- **一个工作空间起步**：表结构留 `workspace_id`，界面上先只有"默认工作空间"，多租户留到需要时开。
- **MCP 的 JSON-RPC 手写、零依赖**：官方 SDK 会把传输、进程管理、会话状态一起带进来，而我们只要
  "initialize → tools/list → tools/call" 这三步；`server/mcp/client.ts` 手写 JSON-RPC 2.0（stdio 按行分帧、
  HTTP 走 Streamable、SSE 先收 endpoint 再 POST 回传），换来零新依赖、Windows 下 spawn 行为可控、
  超时/关闭/子进程退出的语义自己说了算。代价是不做 OAuth、不分页、断线不续传（都写在 README 局限里）。
- **trace 不采样、全量入内存队列 + 批量 flush**：监控要回答"这一轮到底慢在哪"，采样会正好漏掉要查的那一轮。
  所以每轮对话都开一条 `trace_id`，但**采集只写内存队列**（`begin/record/finish` 都是 O(1)），
  每 200ms 批量落一次库（≥200 条提前刷，SQLite 单事务 / PG 单语句，`(trace_id, seq)` 唯一索引保证重试幂等）。
  写失败重试 1 次后整批丢弃并计数——监控绝不能把对话拖挂。代价是 SIGKILL 会丢最后 ≤200ms（见 AGENTS 坑 26）。
- **开放 API 的 Key 只存 sha256 + 前 8 位前缀**：明文 `bk_` + 32 字节随机串只在创建响应里出现一次，
  库里存 `sha256(key)` 与 `prefix`；鉴权时对 hash 做常数时间比较，列表页只显示 prefix 让人辨认。
  这样即使库被读走也拿不到可用 Key；吊销是软删除（`revoked_at`），保证审计能追溯到"这把 Key 什么时候被谁用过"。
- **模型 API Key 用 AES-256-GCM 加密落库、只回掩码**：`node:crypto` 零依赖；密文存
  `{ v: 1, iv, tag, data }`，GCM 自带完整性校验（密钥不对直接抛错，不会返回半截明文）；
  密钥优先级 `SECRET_KEY` → `AUTH_SECRET` → 进程内随机（warn，重启后解不开）；出参永远是
  `sk-****abcd` 这种掩码，明文只在创建/替换的那一次进内存。
- **审批中心只做「同步挂起」的全局视图**：`GET /api/approvals` 合并各会话内存里正在等的审批
  （`approvalMeta` + `pendingApprovals`），批准/拒绝仍走 `Session.resolveApproval()`，不新增审批表、
  不做历史查询。原因是平台的 `beforeToolCall` 是同步回调语义，真正要支持外部审批系统的异步恢复，
  得先改造这条链路并加审批状态表——那是另一类改造，不在 P8/P9 的范围内。
- **成员保护规则在服务层**：不能改自己 / 保留至少一个启用所有者 / 停用后旧令牌立即失效，
  都由 `AuthService.updateMember()`、`removeMember()` 与 guard 每次按 `sub` 回表实现，不做数据库约束；
  单实例、低并发下的控制台够用，直接改库或并发绕过接口不在保护范围内（已在 README 已知限制里写明）。

---

## 环境前置

- **Docker Desktop 需要手动启动**（本 session 里 `com.docker.service` 启动被系统拒绝，daemon 起不来）。
  **它没启动时一切照旧走 SQLite**，功能不受影响（P5 的向量检索目前也在 SQLite 本地算，pgvector 检索尚未接入）。
  启动后按下面这套命令换成 Postgres，复现 P2 的验收：

  ```powershell
  docker compose up -d
  $env:DATABASE_URL="postgres://biz:biz@127.0.0.1:5433/biz"; npm run db:migrate; npm run db:check
  $env:PORT="4330"; $env:LLM_DISABLE="1"; npm run dev
  $env:SMOKE_BASE="http://127.0.0.1:4330"; npm run smoke     # 期望 164 项
  ```

  P2 交付时 PG 侧是用 **PGlite（真 PostgreSQL 18.6 WASM）+ 线上协议代理**验的：迁移、`db:check`、
  `smoke`、`persist-check`、DAO 全接口与失败路径都跑过；**只有 pgvector 的 3 条语句
  （`create extension vector`、`vector(1024)` 列、hnsw 索引）和 Docker 镜像本身没实机验证**。
- 磁盘：C 盘剩余约 8 GB，pgvector 镜像解压约 1 GB，够用但别再加别的镜像。
- 没有 Docker 时一切照旧：`npm run dev` 走 SQLite，功能不受影响（RAG 的向量检索目前走 SQLite 本地 JSON 向量，
  pgvector 检索尚未接入；没配 `EMBEDDING_API_KEY` 时自动回退关键词检索）。
