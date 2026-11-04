# AGENTS.md —— 给接手这个仓库的 agent

面向"动手改代码的人（或 agent）"的导览。**项目是什么、为什么这么设计**看 [README.md](README.md)；
这里只写：怎么跑、东西在哪、改动的边界在哪、验证怎么闭环、有哪些坑。

---

## 一句话

`biz-agent` = 把业务系统接入 AI 的工作从"写代码"降级为"注册工具 + 组装流程"。
核心层（`src/core/`）不随业务流程变化。流程有两条来源：

- **① 代码内置**：加一个 `src/tools/xxx.ts` + 一个 `src/workflows/xxx.ts`（流程自带 `createTools`）+
  把流程加进 `workflowList`、把工具工厂加进 `builtinToolFactories`。
- **② 控制台新建技能**：右栏「＋ 新建技能」运行时编排已有工具，定义存存储层（默认 SQLite，配 `DATABASE_URL` 则为 Postgres）
  的 `workflows` 表，不改代码、不重启。**界面上叫"技能"，底层就是一条自定义流程**——流程没有单独的 UI 入口。

**两条路径都不用改业务装配**：右栏技能面板自动多一条；每条流程还会自动暴露成 `flow_<id>` 工具，
任何会话里模型都能挑它整条跑完（内部起子 agent，不递归）。

流程还能当**技能**用：把「正文说明 + 该流程的工具集 + 步骤」临时装进当前会话（`src/core/skill.ts`，
模型调 `use_skill` 加载、随时退出）。委托执行（`flow_*`）要结论，技能要过程。

另外有一条特殊的**内置流程 `auto-flow`（自动编排）**：`steps` 为空，`createTools` 给的是整个工具目录，
会话里还装着别的流程的 `flow_*`——由模型自己判断"直接调工具"还是"调一条流程整条跑完"。
它同时是"新建会话不必先选流程"的默认项；`src/core/runtime.ts` 的系统提示与
`WorkflowEngine.nextPrompt()` 对空 `steps` 有专门分支，加流程时别假设步骤一定存在。

---

## 常用命令

```bash
npm install                  # 首次
npm run dev                  # Web 控制台 http://127.0.0.1:4317（tsx 直跑 server/index.ts）
npm run typecheck            # tsc --noEmit，改完必跑
npm run verify               # 核心层边界自检，不需要起服务（55 项）
npm run ui-check             # 前端渲染单测（node:vm 沙盒加载 web/markdown.js，跑的就是浏览器那份文件，14 项）
npm run ui-dom-check         # 控制台接线自检（自造迷你 DOM、零依赖，真跑 web/app.js + markdown.js，232 项）
npm run kb:selftest          # 知识库自检（解析/分块/检索/绑定/kb_search/重新向量化，54 项，SQLite 本地、不需要起服务）
npm run kb:pg:selftest       # 知识库 Postgres/pgvector 自检（16 项，要 DATABASE_URL + 已跑 db:migrate，没配就跳过）
npm run auth:selftest        # 安全自检（scrypt/JWT/RBAC/限流/审计/成员保护，41 项，不需要起服务）
npm run models:selftest      # 多模型自检（AES-256-GCM/掩码/首启 default/ping，22 项，不需要起服务）
npm run mcp:selftest         # MCP 自检（stdio/HTTP/SSE 传输、命名、超时/关闭，30 项，不需要起服务）
npm run obs:selftest         # 可观测自检（trace_id/内存队列/批量落库/聚合/保留期清理，24 项，不需要起服务）
npm run ui-shot              # 观感核对：本机 Edge/Chrome 无头截图到 data/shot.png（不联网、不装依赖；没服务就没图）
npm run smoke                # 端到端 HTTP+SSE 冒烟，必须先有服务在跑（164 项）
npm run smoke:auth           # 鉴权端到端，必须先有 AUTH_MODE=required 实例（51 项）
npm run smoke:openapi        # 开放 API + 多模型端到端，必须先有 AUTH_MODE=required 实例（53 项）
npm run smoke:mcp            # MCP 端到端，模拟模型实例即可，脚本自己起假 MCP Server（45 项）
npm run smoke:monitor        # 监控端到端，必须先有 AUTH_MODE=required 实例（61 项）
npm run im:selftest          # IM Bot 自检（P8：加签/AES/幂等/会话映射/出站重试，26 项，不需要起服务）
npm run smoke:im             # IM 端到端（P8：要 DINGTALK_TRANSPORT=fake 实例，37 项）
npm run demo:ticket|data|approval   # 三个切片的终端 demo（faux provider，不联网）
npm run persist-check -- --write / --read <SESSION_ID> --continue   # 重启后上下文/标题/归档恢复验证（两种后端通用）
npm run db:migrate           # Postgres：跑 db/migrations/*.sql 并打印版本（SQLite 不需要）
npm run db:check             # 存储后端体检：类型 / 位置 / 引擎版本 / 表清单 / 迁移 / 数据量
npm run check-model          # 只发一次极短请求，验证 key 可用
```

环境变量（都可临时覆盖，`.env` 只是模板）：`PORT`、`DB_PATH`、`DATABASE_URL`、`LLM_*`、`LLM_DISABLE=1`；
鉴权 `AUTH_MODE`（`off` 默认 / `required`）、`AUTH_SECRET`、`AUTH_BOOTSTRAP_EMAIL`、`AUTH_BOOTSTRAP_PASSWORD`；
向量化 `EMBEDDING_BASE_URL` / `EMBEDDING_MODEL` / `EMBEDDING_API_KEY`（没 key 时知识库走关键词检索）；
调用链保留 `TRACE_RETENTION_DAYS`（默认 30 天，0 = 不清理）。
没有 `DATABASE_URL` 时存储层恒为 SQLite；配了就走 Postgres（`docker-compose.yml` 起 pgvector，见 README）。

**`LLM_DISABLE=1` 强制走模拟模型**——`.env` 里配了真实 key 时，跑 smoke/demo 一律带上，
否则会打真模型，结果不可复现（冒烟断言会随机失败）。

```powershell
# Windows 推荐的两条线
$env:LLM_DISABLE="1"; npm run dev                                  # 演示/回归用的模拟模型服务
$env:LLM_DISABLE="1"; $env:DB_PATH="$PWD\data\scratch.db"; $env:PORT="4318"; npm run dev   # 别污染正式库
```

---

## 目录与改动边界

| 路径 | 职责 | 改动注意 |
|---|---|---|
| `src/core/runtime.ts` | **唯一**接触 Pi 具体 API 的文件（`Agent` 装配） | 换掉 Pi 只需重写它；其它文件不要 import `@earendil-works/*` |
| `src/core/registry.ts` | `ToolDef` → `AgentTool` | 工具注册语义（重名/未注册引用立即抛错） |
| `src/core/permission.ts` | `beforeToolCall`：RBAC + 高风险审批 | 审批是**同步回调**语义，别在这里塞异步挂起 |
| `src/core/audit.ts` | `afterToolCall`：留痕 + 结果截断 4000 字符 | 截断标记是模型可感知的契约，别去掉 |
| `src/core/context.ts` | `transformContext`：滑动窗口压缩 | 保留 system + 最近 N 条 |
| `src/core/workflow.ts` | 流程状态机：按"哪个工具成功执行过"推进；`lastCallOffTrack` 标记"模型去调了本流程之外的流程/工具" | 推进权在代码手里，不要交给模型；跑偏时要放行收尾（见坑 8） |
| `src/core/catalog.ts` | 工具目录：内置工具 → 可被自定义流程按名字挑 | 新增工具工厂要同时进 `builtinToolFactories`，否则 `/api/tools` 与技能编辑器都看不到 |
| `src/core/workflowSpec.ts` | 自定义流程校验（名称/系统提示/步骤/via 长度与合法性；技能文案 ≤200/≤4000、两段都空 = 没写） | 纯函数，前后端共用；错误文案直接上界面，写人话别写英文技术黑话；`PATCH` 的 `skill` 是替换语义（`null` 清空、不传沿用），别写成深合并 |
| `src/core/flowTools.ts` | 流程即工具：`flow_<id>` 命名、参数、描述 | 命名规则是唯一真相（`-` → `_`），server 与测试都引用它，别手拼前缀 |
| `src/core/subFlow.ts` | 子流程执行：`flow_xxx` 内部起子 agent | 内层只装目标流程自己的工具，**不要装流程工具**（否则递归） |
| `src/core/skill.ts` | 技能：`skillFromWorkflow()` 流程 → 作业指导书（正文 + tools 去重）、`skillCatalogPrompt()` 渐进式披露的目录、`use_skill` 的参数/描述 | 技能不另立定义，步骤仍走 `WorkflowEngine`；正文只在该技能加载后才进上下文，别把 `instructions` 塞进系统提示（见坑 17） |
| `src/tools/*` | 业务工具（含 risk / JSON Schema / execute / example） | 有必填参数的工具必须给 `example`，否则模拟模型演不下去（`verify` 有检查） |
| `src/workflows/*` | 内置流程定义（steps + 该步可用的 via 工具 + `createTools`） | 新增内置流程改这里 + 下面两个清单，别去 `server/` 加 case；自定义流程是运行时数据，不走这里 |
| `src/workflows/index.ts` | `workflowList` + `builtinToolFactories`：内置流程与工具目录的唯一真相 | 列表里加一项 = 右栏技能面板多一条技能；id 重复启动即抛错；新增工具工厂必须同时进 `builtinToolFactories` |
| `src/store/memory.ts` | 内存业务数据（真实项目换 DB/内部 API） | 数据是种子假数据 |
| `server/index.ts` | 路由 + 静态资源（`node:http`，零框架）。挂载顺序：**`/v1/*`（开放 API，自带 API Key 鉴权，必须在静态分支之前）→ 静态资源 → `auth.guard()`（`AUTH_MODE=off` 挂演示所有者，`required` 验 Bearer + 角色矩阵）→ `/api/im*` → `/api/auth/*` → `/api/monitor*` → `/api/kb*`（`handleKb`，模块自包含）→ `/api/models*` → `/api/api-keys*` → `/api/mcp*` → 其余 API（含 `/api/approvals*`）**；P8 的钉钉回调是 `/api/im/dingtalk/callback`，走 im 路由内部放行、**不走 JWT guard** | 新增接口在这里加分支，统一走 `json()`；**审批中心** `GET /api/approvals` 与 `POST /api/approvals/:sessionId` 在会话路由之后、404 之前，判定顺序是 404（会话不存在）→ 400（入参）→ 409（已处理）；`/api/workflows` 的 400/403/404 由 `WorkflowHttpError.status` 映射，别手写状态码；`DELETE /api/workflows/:id` 返回 `{ removed, sessionsRemoved, skillsCleared }`（连带删会话 + 让别的会话退出该技能），改它要同步 smoke 场景 F；`/api/health` 的 `storage: { kind, detail }` 来自存储层 `info()`、`auth: "off" \| "required"` 来自鉴权运行时（smoke 场景 C / smoke:auth 有断言）；`/api/sessions` 的 POST 不传 `modelId` 时取**当前模型**（P6），并把 `createdBy` 落进会话 payload（P9 的 developer 只看自己） |
| `server/session.ts` | 会话对象、SSE `WireEvent` 协议、审批挂起、落库、`flow_xxx` 装配、技能加载（`use_skill` 工具、`skill` 事件）、会话级 `kb_search` 工具注册与换技能保留、MCP 工具并入初始工具集（`isMcpToolName`）、P9 的 trace 打点（`begin/finish`、`traceIds` 最近 20 条、`createdBy`、llm/tool/skill/mcp/approval 事件） | 前端事件协议的唯一真相来源；`SessionView.tools` 是「流程即工具」的观测字段，`SessionView.archived` 是归档的观测字段，`SessionView.skills/activeSkillId` 是技能的观测字段（`activeSkillId` 同时进持久化 payload），`SessionView.traceIds` 是调用链的观测字段，改动要同步 smoke（场景 D / E / F）与 `smoke:monitor`；**审批**：`approvalMeta` 存 `{ requestId, toolName, risk, args, askedAt }`，`pendingApprovalViews()` 给单个会话的挂起列表，`SessionHub.pendingApprovals()` 合并成全局面板（只遍历内存会话、按 `askedAt` 升序、已归档不过滤只标注），改它要同步 smoke 场景 H；`done` / `error` 事件带 `traceId`，别在别处再生成 trace；`kb_search` 不在 `/api/tools` 里，绑定按"当前技能 id（没加载技能时回落到会话自己的流程）"在调用那一刻取；MCP 工具是**会话创建/加载技能时的快照**，新注册的服务不会自动进已开着的会话 |
| `server/workflows.ts` | 运行时流程仓库：内置（代码）+ 自定义（存储层）合并成一份索引；`detail/create/update` 带技能文案 `skill` | 单条定义失效（引用的工具被删）要进 `broken` 并拒绝建会话，别让启动崩掉；`update` 里 `skill` 要显式覆盖（可能是"清空"），不能靠展开旧值 |
| `server/auth/**` | 企业安全（P3）：`roles.ts` 权限矩阵（唯一真相，P4~P9 的方法+路径映射也在这里：models / api-keys / mcp / kb / skills 绑定 / monitor / im / approvals / 成员写接口）、`password.ts` scrypt、`jwt.ts` HS256、`rateLimit.ts` 登录限流、`service.ts` 运行时（`AUTH_MODE` / 建初始账号 / 守卫 / 写审计 / `updateMember` / `removeMember`）、`routes.ts` 的 `/api/auth/*`（含成员 PATCH/DELETE，DAO 走 `updateUser` / `deleteUser`）与 `/api/audit`（P9 起支持 `actorType` / `targetType` / `from` / `to` / `q`） | 矩阵与「方法+路径→权限点」只在 `roles.ts` 维护，别在 `server/index.ts` / 前端 / 各模块 routes 里再抄一份；`AUTH_MODE=off` 必须保持"全部放行 + 演示所有者"（`smoke` 默认跑的就是它）；令牌每次按 `sub` 回表，停用/改角色立刻生效（这是"停用后旧令牌立即 401"的实现方式）；**成员保护规则在 service 层**：不能改自己 / 必须保留一个启用 owner（见坑 32）；403 文案中文上界面；`smoke:auth` 是这块的回归入口（要 `AUTH_MODE=required` 实例）；`audit_logs.actor_type` 现在有 `user` / `anonymous` / `api_key` 三种，写审计的调用方要显式传 |
| `server/kb/**` | 知识库（P5）：`schema.ts` 建 SQLite 表、`store.ts` SQLite DAO（JSON 向量本地余弦，并导出两后端共用的归一化/映射/列表 SELECT）、`pgStore.ts` Postgres DAO（pgvector `<=>` 检索，经同步桥）、`parse.ts` / `chunk.ts` 解析分块、`embedding.ts` 可插拔向量化、`search.ts` 向量/关键词检索（向量排名交给 store）、`service.ts` 编排（含 `reembedKnowledgeBase` 整库重算）、`routes.ts` 的 `/api/kb*`、`tool.ts` 会话级 `kb_search` | 两种后端跟着 `DATABASE_URL` 走（见坑 24）：SQLite 表与会话同 `DB_PATH` 文件、PG 表靠 `0001`+`0007` 迁移；向量化失败要回退关键词、绝不阻断上传；`kb_search` 是**会话级工具**，不进 `/api/tools` / 自定义流程 `via`；改检索/绑定/重新向量化要跑 `kb:selftest` + `kb:pg:selftest`（有 PG 实例时）+ `smoke` 场景 G |
| `server/models/**` | 多模型管理（P6）：`crypto.ts`（AES-256-GCM 加解密 + 掩码 + sha256）、`store.ts`（供应商/模型 DAO 与校验）、`service.ts`（首启 default 供应商、当前模型、ping、给会话注入运行时）、`routes.ts` 的 `/api/models*` | API Key 只以 `{v,iv,tag,data}` 密文落库，出参只有掩码；密钥优先级 `SECRET_KEY` → `AUTH_SECRET` → 进程内随机（warn）；**当前模型只存内存**（重启回落第一条 enabled chat）；ping 永远 200、失败给中文 `error`；改这块跑 `models:selftest` + `smoke:openapi` |
| `server/apiKeys/**` | 开放 API 的 Key（P4）：`store.ts`（`bk_` 生成、sha256、软吊销）、`service.ts`（令牌桶限流）、`routes.ts` 的 `/api/api-keys*` | 明文只在创建响应里出现一次；库里只存 hash + `prefix`；`DELETE` 是软吊销不是物理删除；限流桶在内存（重启清零）；改这块跑 `models:selftest`（Key/限流部分）+ `smoke:openapi` |
| `server/openapi/**` | 开放 API（P4）：`chat.ts`（请求解析、拼 prompt、跑一轮会话）、`routes.ts`（`/v1/chat` 非流式 + SSE、`/v1/health`、统一错误、审计） | `/v1/*` 必须在 `server/index.ts` 的静态分支**之前**接管，否则被当静态资源 404；错误形状固定 `{ error: { message, type, code } }`；每个响应带 `x-trace-id`、每次调用写 `audit_logs(actor_type="api_key")`；改这块跑 `smoke:openapi` |
| `server/mcp/**` | MCP 集成（P7）：`client.ts`（手写 JSON-RPC 2.0，stdio/HTTP/SSE 三种传输）、`registry.ts`（发现/快照/调用/启停）、`names.ts`（工具名唯一真相）、`routes.ts`（`/api/mcp*`）、`index.ts`（挂载 + 把 MCP 工具工厂 push 进 `builtinToolFactories`） | 工具名只用 `mcpToolName()` 生成，slug 后只含 `[a-z0-9_]`；工具默认 `risk:"high"`（见坑 25）；发现失败只落 `last_status/last_error`，不能抛到启动流程；MCP 工具是会话/技能工具集的**快照**；改这块跑 `mcp:selftest` + `smoke:mcp` |
| `server/observability/**` | 监控与可观测（P9）：`trace.ts`（trace_id/token 估算/p95/range/参数摘要，纯函数）、`collector.ts`（内存队列 + 200ms 批量 flush + 聚合查询 + 保留期清理 `purgeExpired`）、`routes.ts`（`/api/monitor/*` 与 developer 收窄） | 采集绝不能阻塞对话（只入内存队列）；flush 失败重试 1 次后丢弃并计数；保留期清理由 `TRACE_RETENTION_DAYS` 控制（默认 30 天，0 关闭），失败只记日志；查询接口先 flush 再查；`summary` 要 `session.read`、`traces` 要 `audit.read`；改这块跑 `obs:selftest` + `smoke:monitor` |
| `server/im/**` | IM Bot 网关（P8）：钉钉加签/AES 回调解析、凭证加密、`im_sessions` 会话映射与幂等 LRU、出站（fake/real 传输 + 重试）、`/api/im*` | **钉钉回调是免登录公开路径**（在 guard 之前 / 路由里单独放行），别把整个 `/api/im` 做成公开；凭证只回掩码；同一 `msgId` 必须幂等（内存 LRU + `last_msg_id` 双保险）；`DINGTALK_TRANSPORT=fake` 不进网络、只写 outbox，冒烟靠它；改这块跑 `im:selftest` + `smoke:im` |
| `server/db/**` | 存储层：`openStore()` 工厂（有 `DATABASE_URL` → Postgres，否则 SQLite）+ 两种实现 + 迁移执行器；`types.ts` 的 DAO 签名与旧 `SessionDb` 逐条一致，业务代码只改 import/类型名；P3 的 `users`/`audit_logs`、P4 的 `api_keys`、P6 的 `model_providers`/`models`、P7 的 `mcp_servers`/`mcp_tools`、P9 的 `traces`/`trace_events` 都在这一层；成员写接口新增 `updateUser(id, patch)` / `deleteUser(id)`（SQLite + PG 两套实现） | **DAO 契约是同步的**（见坑 22），别在 storage 里改成 async；`sessions` 仍是单表 `payload` JSON（`createdBy` / `traceIds` 也在 payload 里，不需要迁移）；`workflows` 只存自定义流程，内置流程不落库；**给表加列必须走 PRAGMA 检查 + `ALTER TABLE` 兜底**（见坑 19）；`trace_events` 的 `(trace_id, seq)` 唯一索引是 flush 幂等的关键，别去掉；`updateUser` 只落真正变化的字段（空 patch 不写），`deleteUser` 是物理删除，返回受影响行数 |
| `db/migrations/**` | Postgres 迁移：`0001_init.sql`（`vector` + `pg_trgm` 扩展、17 张表、`schema_migrations` 记账、单文件一个事务、幂等）+ `0002_auth.sql`（审计平台动作列、放开 `tool_name`/`ok` NOT NULL、`users.email` 小写唯一索引）+ `0003_models.sql`（`model_providers` / `models` 两张表）+ `0004_mcp.sql`（MCP 的 `env` / `last_status` / `last_error` / `last_checked_at` 与索引）+ `0005_observability.sql`（`trace_events.ok/ms`、`(trace_id, seq)` 唯一索引、监控与审计索引）+ `0006_im.sql`（P8：IM 机器人的 `robot_code` / `aes_key_enc` / `last_callback_at` / `last_msg_id` 与索引；后端与控制台页面都已接入）+ `0007_kb_pgvector.sql`（P5 收尾：`kb_chunks.embedding` 由 `vector(1024)` 改成无维度 `vector`、删 HNSW 索引改精确余弦扫描）；执行器是 `server/db/migrations.ts` | **只服务 PG**（SQLite 表结构内建在 `server/db/sqlite.ts` 与 `server/kb/schema.ts`，见坑 23 / 24）；加表要两边都加；改完用 `npm run db:migrate` + `npm run db:check` 验证，别在 SQLite 上跑迁移；PG 侧（含 pgvector）用 PGlite 真内核验证过，但 Docker 镜像本身未实机（见坑 29）；**成员写接口不需要迁移**（`users` 表字段早就齐了，只是 DAO 补了 `updateUser` / `deleteUser`） |
| `server/demoScripts.ts` | 无 key 时的模拟模型（按流程"演"一遍） | 演示参数取自 `ToolDef.example`，总结语有按步骤自动生成的兜底，新流程可以不写这里 |
| `web/` | 控制台前端（**左侧图标栏 = 11 个模块导航**（`data-module`）：对话 / 知识库 / 技能 / 模型 / MCP / IM 机器人 / 审批 / 审计 / 成员 / 监控 / 设置；非对话模块用 `.shell.module-view` 两列 `56px minmax(0,1fr)`，收起 `.sidebar` 与 `#skill-side`、内容区 `#module-main` 整宽，切回对话恢复现场不重拉数据；**11 个模块页全部接真接口，没有空态占位**：`知识库` `/api/kb*`、`模型` `/api/models*`、`MCP` `/api/mcp*`、`IM 机器人` `/api/im*`、`审批` `/api/approvals*`（待办列表 + 批准/拒绝 + 10s 轮询）、`成员` `/api/auth/users`（新建 + 改角色 + 停用/启用 + 删除）、`审计` `/api/audit`、`设置`（含 API Key 管理 `/api/api-keys*`）、`监控` `/api/monitor*`、`技能` `/api/skills`；`AUTH_MODE=required` 时先显示登录页。**对话模块是四列网格** `56px 258px 1fr 288px`：图标栏 + 会话栏 + 对话区 + 右栏技能面板；窄屏 ≤1180px 先收技能面板、≤1080px 再收会话栏。会话栏 = 新聊天 / 置顶（`localStorage`）/ 会话（平铺，不按流程分组；行尾 `.skill-tag` 显示当前技能）/ 已归档折叠区；**没有流程区与新建流程按钮**，新聊天直接开 `auto-flow` 会话；页头技能胶囊是**纯状态**（无下拉）；右栏常驻技能面板 `#skill-side`：当前技能块（名字 + `当前技能 · N 步` + 退出）+ ＋新建技能 + 技能列表（点行加载、⋯ 查看/编辑/删除，自动编排 `auto-flow` 不列）；「运行详情」抽屉只剩当前进度 + 审计流水；技能编辑器（新建/编辑自定义流程 + 技能文案）是唯一的流程编辑入口；空会话引导页三条示例 chip、回答/代码块/工具输出复制、工具卡片折叠（标题行键盘可达：`role=button` + `tabindex=0` + `aria-expanded`，Enter/Space 折叠）、回到底部浮钮、`Ctrl / ⌘ + K` 搜索、流式方块光标），原生 JS，**无构建步骤** | 改完刷新即生效；不引第三方库；用户输入一律 `textContent`；交互/接线改动要过 `npm run ui-dom-check`；**界面文案里不出现"流程"**（用户视角只有技能），`web/index.html` 去注释后不许出现「流程」二字；模块页的「未接入」页不要摆假数据，只写说明 + 接口清单；**只有后端接口 404 / 连不上时才回落空态**（403 要显示「权限不足」，别混进「未接入」）；**审批页操作成功后从本地列表移除，409 只提示并刷新，不弹错** |
| `web/markdown.js` | markdown → HTML 的纯函数（标题/列表/表格/围栏代码块/引用/行内语法；链接白名单；挂 `window.renderMarkdown`） | **先全量转义再套标签**；链接只放行 http/https/mailto 与站内路径（`/` 开头、`#` 锚点，裸相对路径不放行）；新增/改动语法必须同时补 `scripts/ui-check.mjs`；这是经典脚本，**不能写 import/export** |
| `scripts/ui-check.mjs` | 前端渲染单测（`node:vm` 造沙盒加载 `web/markdown.js`，14 项，`npm run ui-check`） | 只测纯函数、不起服务；断言"模型吐出的 HTML 只会变文本"这条安全底线不要删 |
| `scripts/ui-dom-check.mjs` | 控制台接线自检（自造迷你 DOM + HTML 解析器，零依赖、不引 jsdom；真跑 `web/app.js` + `web/markdown.js`，232 项，`npm run ui-dom-check`） | 断言的是"接线"不是观感（布局/视觉仍靠人眼）；只看 DOM/事件/class/aria，别在这里断言像素；加交互先在这里补一条；`querySelectorAll` 必须返回 NodeList 形态（`nodeList()`），返回数组会放过真浏览器才炸的 bug（见坑 18） |
| `scripts/models-selftest.ts` | 多模型自检（22 项，`npm run models:selftest`）：AES-256-GCM 加解密/掩码溯源、首启 default 供应商、切换当前模型、ping 成功与失败、API Key 停用/吊销与参数校验 | 纯进程内、临时 SQLite + 假 fetch（`FetchLike` 注入），不起服务；动 `server/models/**` 或 `server/apiKeys/**` 先跑它，再用 `smoke:openapi` 验真实 HTTP |
| `scripts/mcp-selftest.ts` | MCP 自检（30 项，`npm run mcp:selftest`）：工具名归一、stdio/HTTP/SSE 三种传输握手与调用、中文往返、isError、超时与关闭、子进程退出 | 纯进程内，用 `scripts/fixtures/mcp-stdio-server.mjs` 起假服务；动 `server/mcp/**` 先跑它，再用 `smoke:mcp`；超时阈值是 **1500ms**、慢工具用 `FIXTURE_SLOW_MS` 拉到 6 秒（见坑 30），别再调回贴着实测的阈值 |
| `scripts/observability-selftest.ts` | 可观测自检（24 项，`npm run obs:selftest`）：trace_id 形状、内存队列与 200ms 批量 flush、失败重试/丢弃计数、summary 聚合与 p95、range 解析、幂等、保留期清理 | 纯进程内、临时 SQLite、手动 flush（`autoStart:false`）；动 `server/observability/**` 或 `session.ts` 的 trace 打点要跑它 |
| `scripts/smoke-openapi.ts` | 开放 API + 多模型端到端（53 项，`npm run smoke:openapi`）：要 `AUTH_MODE=required` 实例 | 脚本自己起一个本机假供应商验 ping、自己建 operator 账号；覆盖 Key 明文一次性、流式 `[DONE]`、401/403/429、`/v1/health`、api_key 审计 |
| `scripts/smoke-mcp.ts` | MCP 端到端（45 项，`npm run smoke:mcp`）：模拟模型实例即可 | 脚本用 `process.execPath` 起 stdio 假 MCP Server（路径里的中文/空格也顺带验证 Windows spawn）；覆盖注册→发现→会话可见→启停→调用→删除，开始/结束各清一次 `Smoke` 服务 |
| `scripts/smoke-monitor.ts` | 监控端到端（61 项，`npm run smoke:monitor`）：要 `AUTH_MODE=required` 实例 | 脚本自己建 operator / auditor / developer 账号；从 `/api/health` 拿 SQLite 路径直接种一条 2 天前的调用链验 range（PG 实例会跳过这组），并覆盖 `/api/audit` 的新过滤 |
| `scripts/im-selftest.ts` | IM Bot 自检（26 项，`npm run im:selftest`）：加签/AES 回调、文本解析、幂等 LRU、凭证掩码、会话映射、出站重试与 token 缓存、传输选择与权限映射 | 纯进程内、临时 SQLite + 假传输，不起服务；动 `server/im/**` 先跑它，再用 `smoke:im` 验真实 HTTP |
| `scripts/smoke-im.ts` | IM 端到端（37 项，`npm run smoke:im`）：要 `DINGTALK_TRANSPORT=fake` 实例 | 覆盖建机器人（掩码/明文不回）→ 正确加签回调 → outbox → 同 msgId 幂等 → 错签名/过期 401 → 同 conversationId 只映射一个会话 → ping → 停用 403 → 删除 404 |
| `scripts/kb-selftest.ts` | 知识库自检（54 项，`npm run kb:selftest`）：解析/分块/关键词打分/向量回退/绑定隔离/`kb_search` 工具/重新向量化 | 纯进程内、用临时 SQLite，不起服务；动 `server/kb/**` 先跑它，再用 `smoke` 场景 G 验真实 HTTP |
| `scripts/kb-pg-selftest.ts` | 知识库 Postgres/pgvector 自检（16 项，`npm run kb:pg:selftest`）：DAO 全接口、pgvector 余弦排序/阈值/topK、维度不固定、service 假 embedding（上传即向量化 / 失败回退） | 要 `DATABASE_URL` 且已跑 `db:migrate`（没配打印「跳过」并 exit 0）；没有 Docker 时用 PGlite+pgvector 起 socket 服务跑（见坑 29）；动 `server/kb/pgStore.ts` 必跑 |
| `scripts/auth-selftest.ts` | 安全自检（41 项，`npm run auth:selftest`）：scrypt/JWT 验签过期/RBAC 矩阵/限流/审计 DAO/成员保护（不能改自己、最后 owner、停用后令牌 401） | 纯进程内、临时库；改 `server/auth/**` 或 `roles.ts` 必须让它全绿 |
| `scripts/smoke-auth.ts` | 鉴权端到端（51 项，`npm run smoke:auth`）：要一个 `AUTH_MODE=required` 实例 | 脚本自己建 operator/auditor 账号；实例必须带 `AUTH_BOOTSTRAP_PASSWORD`；覆盖成员 PATCH/DELETE、保护规则 400、401/403 与 user.update/user.delete 审计；跑完删临时库 |
| `scripts/ui-shot.mjs` | 观感核对：本机 Edge/Chrome 无头 + CDP 截图（`npm run ui-shot -- <url> <out> <w> <h> <waitMs> <js>`） | 只管"看一眼对不对"：截图前可执行一段 JS（点开菜单/切技能）再拍；顺手把页面 JS 报错打出来（有报错退出码 2）；找不到浏览器就跳过，不进验证闭环 |
| `scripts/db-migrate.ts` | `npm run db:migrate`：对当前后端跑 `db/migrations/*.sql` 并打印已应用版本 | PG 专用（SQLite 会直接返回"无需迁移"）；迁移文件本身在 `db/migrations/**` |
| `scripts/db-check.ts` | `npm run db:check`：打印后端类型 / 位置 / 引擎版本 / 表清单 / 迁移版本 / 数据量 | 换后端或加表后先跑它；它不写数据 |

`scripts/` 是测试与自检脚本，`examples/` 是终端 demo（`examples/harness.ts` 提供造 `BizContext`/agent 的小工具）。

---

## 代码风格

- **Tab 缩进**，双引号，分号不能省；TS strict + `noUnusedLocals` / `noUnusedParameters`（未使用变量会直接编译失败）。
- 注释、日志、UI 文案、提交信息全部**中文**。注释解释"为什么"，不解释"是什么"。
- 业务层类型集中在 `src/core/types.ts`（`WorkflowDef` / `ToolDef` / `BizContext` / `WorkflowState` / `AuditEntry`）。
- 前端不引框架、不引构建：DOM 用 `make(tag, className, text)` 造，用户输入一律 `textContent`（禁止拼 `innerHTML`）。
- 渲染模型输出一律走 `window.renderMarkdown`（`web/markdown.js`）：它**先把 HTML 全量转义再套标签**，
  所以只有这里能产出可信标签；别为了加个样式在 `app.js` 里手拼 HTML——要加语法就改 markdown.js + 补 ui-check。
- 不为"未来可能用到"抽象；切片式的三个流程就是全部示例。

---

## 验证闭环（改完必须走到"绿"）

```bash
npm run typecheck                 # 1. 类型
npm run verify                    # 2. 核心层 / 工具目录 / 流程校验 / 子流程 / 技能 55 项（不起服务）
npm run ui-check                  # 3. 前端渲染单测 14 项（node:vm 跑 web/markdown.js，不起服务）
npm run ui-dom-check              # 4. 控制台接线自检 232 项（自造迷你 DOM 跑 web/app.js，不起服务）
npm run kb:selftest               # 5. 知识库自检 54 项（解析/分块/检索/绑定/kb_search/重新向量化，SQLite 本地，不起服务）
npm run kb:pg:selftest            # 5b. 知识库 Postgres/pgvector 自检 16 项（要 DATABASE_URL + 已跑 db:migrate，没配就跳过）
npm run auth:selftest             # 6. 安全自检 41 项（scrypt/JWT/RBAC/限流/审计/成员保护，不起服务）
npm run models:selftest           # 7. 多模型自检 22 项（AES-256-GCM/掩码/default 供应商/ping，不起服务）
npm run mcp:selftest              # 8. MCP 自检 30 项（三种传输/命名/超时/关闭，不起服务）
npm run obs:selftest              # 9. 可观测自检 24 项（trace_id/内存队列/flush/聚合/保留期清理，不起服务）
npm run im:selftest               # 10. IM Bot 自检 26 项（P8：加签/AES/幂等/映射/出站，不起服务）
npm run dev                       # 11. 另开一个终端：$env:LLM_DISABLE="1"; npm run dev
npm run smoke                     # 12. 端到端 164 项（默认打 127.0.0.1:4317，可用 SMOKE_BASE 覆盖）
```

鉴权端到端单独跑（**不要**打在默认实例上，它需要 `AUTH_MODE=required`，且脚本会自己建账号）：

```powershell
$env:PORT="4333"; $env:AUTH_MODE="required"; $env:AUTH_BOOTSTRAP_PASSWORD="owner12345"
$env:LLM_DISABLE="1"; $env:DB_PATH="$PWD\data\qa-auth2.db"; npm run dev
$env:SMOKE_AUTH_BASE="http://127.0.0.1:4333"; npm run smoke:auth   # 51 项
```

开放 API / MCP / 监控是另外三个入口，同样别打在 4317 的正式库上：

```powershell
# 开放 API + 多模型（required 实例；脚本自己建运营账号，并用本机假供应商验 ping）
$env:PORT="4340"; $env:AUTH_MODE="required"; $env:AUTH_BOOTSTRAP_PASSWORD="owner12345"; $env:SECRET_KEY="qa-secret"
$env:LLM_DISABLE="1"; $env:DB_PATH="$PWD\data\qa-openapi2.db"; npm run dev
$env:SMOKE_OPENAPI_BASE="http://127.0.0.1:4340"; npm run smoke:openapi   # 53 项

# MCP（off 模拟实例即可，脚本自己起 stdio 假 MCP Server）
$env:PORT="4350"; $env:LLM_DISABLE="1"; $env:DB_PATH="$PWD\data\qa-mcp.db"; npm run dev
$env:SMOKE_MCP_BASE="http://127.0.0.1:4350"; npm run smoke:mcp           # 45 项

# 监控（required 实例：才有 operator / auditor / developer 三种真实角色）
$env:PORT="4370"; $env:AUTH_MODE="required"; $env:AUTH_BOOTSTRAP_PASSWORD="owner12345"
$env:LLM_DISABLE="1"; $env:DB_PATH="$PWD\data\qa-monitor.db"; npm run dev
$env:SMOKE_MONITOR_BASE="http://127.0.0.1:4370"; npm run smoke:monitor   # 61 项

# IM Bot（P8；用 fake 传输，不进网络）
$env:PORT="4380"; $env:DINGTALK_TRANSPORT="fake"; $env:LLM_DISABLE="1"
$env:DB_PATH="$PWD\data\qa-im.db"; npm run dev
$env:SMOKE_IM_BASE="http://127.0.0.1:4380"; npm run smoke:im             # 37 项
```

- 动 `src/core/*` → 至少要过 `verify`，必要时在 `scripts/selftest.ts` 补一项。
- 动前端渲染/纯函数（`web/markdown.js`）→ 必须过 `npm run ui-check`，新增语法先在 `scripts/ui-check.mjs` 补断言。
- 动 `web/*` 的交互/接线（`web/app.js`）→ 必须过 `npm run ui-dom-check`（自造 DOM 真跑 app.js），
  交互有变化先在 `scripts/ui-dom-check.mjs` 补一条；它和 `ui-check` **不互相替代**：一个测渲染纯函数、一个测 DOM 接线。
- 动 `server/*` 或 `web/*` → 必须过 `smoke`（它走真实 HTTP + SSE），并在 `scripts/smoke.ts` 补断言。
- 动鉴权相关（`server/auth/**`、`server/index.ts` 的 guard、成员/审计接口）→ `auth:selftest` + `smoke:auth`
  （要 `AUTH_MODE=required` 实例）+ 默认 `smoke`（off 模式全部放行）都要过。改矩阵先改 `server/auth/roles.ts`，
  再同步 `scripts/auth-selftest.ts` 与 `scripts/smoke-auth.ts` 的期望；403 文案是断言的一部分。
- 动知识库相关（`server/kb/**`、`/api/kb*`、`kb_search`、知识库页）→ `kb:selftest` + `smoke` 场景 G 都要过；
  动 `pgStore.ts` / 迁移 `0007` / 检索下推，还要配 `DATABASE_URL`（+ 已跑 `db:migrate`）跑 `kb:pg:selftest`，
  并起一个 PG 实例跑 `smoke` + `persist-check`（没有 Docker 时用 PGlite+pgvector，见坑 29）。
  本机回归不要配 `EMBEDDING_API_KEY`（会打网络、模式变成 vector），断言默认是 `mode="keyword"`。
- 动 `web/*` 的观感（布局/截断/层级/颜色）→ 起服务后 `npm run ui-shot -- <url> <out> 1440 980 3500 "<点开菜单的 JS>"`
  拍图看一眼；它同时报页面 JS 错（退出码 2）。UI 接线归 `ui-dom-check`，观感归它，两者不互相替代。
- 动流程相关（`workflowSpec` / `catalog` / `flowTools` / `server/workflows.ts` / `subFlow`）→
  `verify` + `smoke` 都要过：`verify` 覆盖纯函数校验与 `runSubWorkflow` 的执行路径，
  `smoke` 场景 D 覆盖 `/api/workflows` 的 CRUD、内置流程 403、以及会话视图 `tools` 里的 `flow_*`。
  **流程没有 UI 入口**：界面只能通过「技能」增删改（`POST/PATCH/DELETE /api/workflows` 是技能的后台存储），
  所以动这块别去 `web/` 找"流程列表"，场景 D / F 就是它的回归入口。
- 动技能相关（`src/core/skill.ts`、`runtime.ts` 的 `activateSkill/clearSkill`、`session.ts` 的
  `use_skill`/`skill` 事件、`GET /api/skills`、`POST /api/sessions/:id/skills`）→
  `verify` 覆盖技能派生、`use_skill` 参数、激活/退出时的工具集与状态机切换；
  `smoke` 场景 F 覆盖两个接口、`activeSkillId`、步骤条与非法入参。
- 动技能面板（右栏 `#skill-side`、技能编辑器、`workflowSpec.ts` 的 `skill` 校验与合并语义、
  `server/workflows.ts` 的 `detail/create/update` 带 skill、`workflows.skill` 列（SQLite 在 `server/db/sqlite.ts`，
  PG 在迁移里）、`DELETE /api/workflows/:id` 连带删会话/退出技能）→
  `verify` 覆盖校验与「不传沿用 / null 清空 / 只带 description = 替换」三态；
  `ui-dom-check` 覆盖面板过滤 `auto-flow`、点行加载、新建/编辑/删除的接线；
  `smoke` 场景 F 覆盖「新建 → 目录 → 改 → 清空回落兜底 → 删除（`sessionsRemoved` / `skillsCleared`）」。
- 动持久化 / 存储层（`server/db/**` / `session.ts` 的 `persist` / `saveWorkflow`）→ 跑 `persist-check --write`，
  重启服务，再 `--read <ID> --continue`（SQLite 默认；配了 `DATABASE_URL` 就是对 PG 跑同一套命令）。
- 动存储层后端或迁移（`server/db/**`、`db/migrations/**`）→ 先 `npm run db:check` 看当前后端与表清单，
  再 `npm run db:migrate`（PG）→ 重启 → `smoke` + `persist-check` 两边都要过。
- 动会话归档（`session.ts` 的 `archived` / `setArchived`、`index.ts` 的 `PATCH /api/sessions/:id`）→
  `smoke` 场景 E 覆盖归档/取消归档/非法入参与"收到消息自动取消归档"；归档是否落库用
  `persist-check --write`（会顺带归档）→ 重启 → `--read <ID>` 断言 `archived=true`。
- 端口被占/想隔离数据：`$env:PORT` + `$env:DB_PATH` 另起一个实例，别杀别人正在跑的服务。
- **smoke 必须打模拟模型实例**（`LLM_DISABLE=1`）：断言依赖模拟模型的固定脚本，
  对真实模型跑会随机失败、还花钱；4317 若是 live，就另起 `PORT=4318` 的模拟实例，
  用 `SMOKE_BASE=http://127.0.0.1:4318` 跑。

---

## 坑（都是踩过的）

1. **`.env` 里有真实 key**：`.env` 被 gitignore，但本机通常配了 `DEEPSEEK_API_KEY`。
   于是 `npm run dev` 默认是真实模型——demo/smoke 断言依赖模拟模型的固定脚本，必须 `LLM_DISABLE=1`。
2. **Node 版本**：`engines` 要求 ≥22.19.0，本机 22.18.0，实测能跑但 npm 会警告；`node:sqlite`
   会打 `ExperimentalWarning`，属正常。
3. **数据库别提交**：`data/` 整个被 gitignore，`data/biz-agent.db` 是本机会话库；
   测试请用 `DB_PATH` 指到 `data/xxx.db` 之类的一次性文件，跑完删掉。
4. **单表 payload 设计**：会话整条序列化进 `payload` 列，只有 id/workflow/时间/done 是列。
   加字段直接进 `PersistedSession` 即可，**不要**为了新字段建迁移或关联表（除非要 SQL 过滤）。
5. **`title` 语义**：`Session.title` 为 `null` 表示"没自定义"，前端用首条用户消息派生标题；
   规范化（折叠空白、控制字符转空格、截断到 `TITLE_MAX_LENGTH=80`）只在 `server/session.ts` 做一次，前端只做长度限制。
6. **SSE 是有状态的**：`server/session.ts` 的 `WireEvent` 是前端唯一输入；新增事件类型要同时改
   `web/app.js` 的 `handle()`，否则前端静默忽略。
7. **审批是同步的**：`beforeToolCall` 里等人工决策会挂住该次工具调用（`Session` 用 Promise + SSE 事件实现）。
   要做外部审批系统的异步恢复，必须改造这个同步语义——不要假装它是异步的。
8. **流程推进权**：模型只负责调工具，`WorkflowEngine` 按成功调用判定步骤；`finishTurn` 返回
   `continue` + 下一步提示。想加"必须按顺序"的约束，改流程定义而不是改提示词。
   **但有一种情况必须放行**：会话开在 A 流程上，用户问的却是 B 的事，模型直接调了 `flow_b`
   整条跑完——这时 `lastCallOffTrack` 为 true，`nextPrompt()` 改口"把结果整理成回答"、
   `finishTurn` 允许收尾。别把这条改回"死催第 1 步"，否则真实模型只会回一句「好的」。
9. **中文乱码**：Windows 控制台里 PowerShell 打印中文可能显示 `?`，那是终端编码问题，不是数据问题；
   用 `Invoke-RestMethod` 断言长度/相等性时不受影响。
10. **自定义流程的 `via` 必须是 `/api/tools` 里的工具名**：工具目录 = `src/tools/*` 里注册、且工厂进了
    `builtinToolFactories` 的工具。校验（`workflowSpec`）只认这个目录；工具之后被删掉，流程会在
    `/api/workflows` 列表里带 `error`、建会话被拒（`WorkflowRepo.reload` 把它记进 `broken`），
    要去技能面板里编辑改掉——别让一条坏定义把服务启动搞崩。
11. **流程工具名只由 `flowToolName()` 生成**（`-` 换成 `_`，如 `ticket-flow` → `flow_ticket_flow`）：
    会话里注册的工具名、`SessionView.tools`、smoke 的断言都依赖它，别在别处手拼 `flow_` 前缀。
12. **`workflows` 是第二张表，不是迁移**：`server/db/sqlite.ts` 用 `CREATE TABLE IF NOT EXISTS workflows` 加表，
    `sessions` 的单表 payload 设计不变；内置流程不落库（库里的自定义流程删掉后，内置四条仍在）。
13. **步骤 id 由服务端重算**（`step-1..n`）：PATCH 改 steps 后会重排，别把步骤 id 当稳定引用；
    要断言只断言 `steps.length` 和标题。
14. **模拟模型不会自己挑 `flow_xxx`**：无 key 时它只按 `engine.currentStep.via[0]` 演当前流程，
    所以「流程即工具」的执行路径靠 `verify` 里对 `runSubWorkflow` 的断言覆盖，
    `smoke` 只断言会话工具列表里有别的流程的 `flow_*`；想演示模型自选流程必须用真实模型。
15. **归档与重命名共用 `PATCH /api/sessions/:id`**：`{ title?, archived? }` 至少传一个，`archived` 非布尔 → 400，
    成功返回 `{ title, archived }` 两个字段。别为归档新开端点；"收到新消息自动取消归档"只在
    `Session.send()` 里做一次（改 `send` 时保住那一行并在 `finally` 落库），别在前端或别处再写一遍。
16. **`web/*.js` 是经典脚本，但仓库是 `"type": "module"`**：`index.html` 用 `<script src>` 直接加载，
    所以 `web/markdown.js` 里**不能写 `import` / `export`**（浏览器会按经典脚本解析，直接语法报错、
    整页 JS 挂掉），也不能用 `module.exports`。它的单测只能像 `scripts/ui-check.mjs` 那样用 `node:vm`
    造 `{ window: {} }` 沙盒跑；直接 `import "../web/markdown.js"` 会失败。改完记得 `npm run ui-check`。
17. **换技能是"替换工具集 + 就地重置状态机"，不重建 agent**：`activateSkill()` 只改
    `agent.state.tools`、`engine.reset(skill.workflow)`（并快照原流程进度），`clearSkill()` 再 `reset` 回去——
    历史对话、审批挂起、SSE 订阅都得留着，所以别在外层重建 `createBusinessAgent`。
    两个连带约定：① `keepToolNames` 只在"换技能"时并入工具集，**初始 `toolNames` 要自己带上
    `use_skill` 和 `flow_*`**（`server/session.ts` 的 `toolNamesFor()` 就是这么拼的，少带的话加载技能后
    才发现少了入口）；② **模拟模型不会自己调 `use_skill`**（它只按 `currentStep.via[0]` 演），
    所以技能加载/退出路径靠 `verify` 与 `smoke` 的接口断言覆盖，想演示"模型自己挑技能"必须用真实模型。
18. **`querySelectorAll` 返回的是 NodeList，没有 `filter` / `map` / `find` / `at`**：写 `xxx.querySelectorAll(".x").filter(...)`
    在 `ui-dom-check` 里曾经能过——因为桩返回的是真数组；换来真浏览器就是一发 `TypeError`，
    整个右栏技能面板点不开（点技能行没反应）。桩现在返回 `nodeList()`（只有 length / item / forEach / 迭代器），
    这种误用会直接在 `npm run ui-dom-check` 里炸；要数组就 `Array.from(...)`。
    视觉与浏览器行为核对用 `npm run ui-shot`（见上），它会把页面 JS 报错打出来——**有报错就别只看图**。
19. **给 `workflows` 表加列必须"PRAGMA 检查 + ALTER TABLE"兜底**：`CREATE TABLE IF NOT EXISTS` 只对
    新库建表，**不会给老库补列**——本机的 `data/biz-agent.db` 是既有库，只在 CREATE 语句里加 `skill TEXT`
    的话，老库读写列时会直接报 `no such column: skill`。`server/db/sqlite.ts` 现在的做法是启动时
    `PRAGMA table_info(workflows)` 查一遍，缺列就 `ALTER TABLE workflows ADD COLUMN skill TEXT`（幂等，跑几次都一样）。
    同理：`WorkflowRow.skill` 是可选字段，落库要 `row.skill ? JSON.stringify(row.skill) : null`，读回再 `JSON.parse`。
    **SQLite 的补列逻辑现在在 `server/db/sqlite.ts`**（P2 把 `db.ts` 拆成了 `server/db/**`）。
20. **技能目录是快照，新建的技能会"看不见"**：`Session` 构造时把 `repo.skills()` 快照进 `this.skills` 与
    `use_skill` 的工具参数枚举；`runtime.activateSkill(id)` 内部也自己存了一份 map。控制台允许**会话开着时新建技能**，
    所以 `Session.activateSkill()` 会先 `refreshSkills()`（`repo.skills()` 灌回 `this.skills`，并**就地改**
    `skillTool.parameters.properties.skillId.enum` 里那个数组——`AgentTool.parameters` 与它是同一个对象引用，
    整个替换 `parameters` 对象 AgentTool 看不到），再把新定义**作为对象**传给 `builtin.activateSkill(skill)`。
    别把调用改回 `activateSkill(id)`：runtime 那份 map 是构造时的，新建技能会抛「未注册的技能」。
    唯一没刷的是**系统提示里的技能目录**（`AgentState.systemPrompt` 只读），所以"模型自己发现新技能"要重开会话；
    控制台点行加载、`use_skill` 的参数枚举不受影响。
21. **右栏技能面板不列 `auto-flow`**：`auto-flow`（自动编排）是默认聊天模式，`steps` 为空、工具是整个目录，
    点它加载等于什么都没换，所以 `web/app.js` 用 `SKILL_LIST_HIDDEN = new Set(["auto-flow"])` 过滤掉。
    `GET /api/skills` 仍照常返回它（模型 `use_skill`、`POST /api/sessions/:id/skills` 都能用）；
    当前技能真是它时，「当前技能」块与页头胶囊照常显示名字。**别把过滤做进 `/api/skills`**——
    接口要给模型和测试完整目录，这只是面板的展示选择。
22. **PG 后端是"同步桥"包出来的，DAO 契约不许改成 async**：`Session` 构造里就落库、`SessionHub`/`WorkflowRepo`
    全是同步链，所以 `server/db/postgresWorker.ts` 在工作线程里跑异步 `pg`，主线程用 `Atomics.wait` 阻塞 +
    `receiveMessageOnPort` 取结果（`syncBridge.ts`）。代价是 PG 后端每次存储调用会阻塞主线程毫秒级；
    高并发 / 多实例不在当前范围（那是连接池 + 全异步改造的事）。别为了"性能"在 storage 层里改成
    返回 Promise——上层一个都 await 不了。
23. **`db/migrations/*.sql` 只给 Postgres 用**：里面是 PG 方言（`vector` / `gin` / `hnsw` / `to_tsvector`），
    SQLite 表结构仍内建在 `server/db/sqlite.ts`（`CREATE TABLE IF NOT EXISTS` + PRAGMA/ALTER 自愈，
    见坑 19），SQLite 的 `migrations()` 返回空数组。**加表要两边都加**：SQLite 改 `sqlite.ts`，PG 加迁移文件
    （新文件用 `0002_xxx.sql` 这种数字前缀，执行器按文件名排序 + `schema_migrations` 记账，幂等）。
    别以为写了迁移 SQLite 就会跑。
24. **知识库有 SQLite / Postgres 两种 DAO，跟着 `DATABASE_URL` 自动选**：契约是 `server/kb/store.ts` 的 `KbStore`，
    SQLite 实现也在它里面（表建在 `DB_PATH` 同一库文件，`server/kb/schema.ts` 幂等建表；向量存 JSON 文本、本地算余弦）；
    Postgres 实现在 `server/kb/pgStore.ts`（表由 `db/migrations/0001_init.sql` + `0007_kb_pgvector.sql` 建；
    向量是 pgvector `vector` 列，检索用 `embedding <=> $vec` 下推，经同一套同步桥阻塞调用）。
    两条约定：① **PG 的 KB 表只由迁移建**，`pgStore` 只查不建，别把 PG DDL 塞进 SQLite 的建表路径；
    ② **向量列没有固定维度**（0007 把 `vector(1024)` 改成无维度 `vector`，HNSW 索引已删、走精确余弦扫描）——
    换 embedding 模型（1536/3072 维）不用迁移，但不同维度的旧块会让 pgvector 检索报错，检索层会回退关键词。
    另一条：后补 `EMBEDDING_API_KEY` 不会让旧文档自动重嵌入，但可点知识库页「重新向量化」或调
    `POST /api/kb/:id/reindex` 整库重算（`service.reembedKnowledgeBase` → `updateChunkEmbeddings`）；
    上传前先看 `GET /api/kb/embedding` 的 `available`。
25. **MCP 工具的 `risk` 用 `high`（`RiskLevel` 没有 `write`）**：平台的 `RiskLevel` 只有 `low` / `medium` / `high`，
    而人工审批只在 `high` 触发（`src/core/permission.ts`）。MCP 工具默认按写操作看待，所以
    `server/mcp/registry.ts` 给的是 `risk: "high"`——**每个 MCP 工具调用都会弹审批卡片**。
    这不只是"保守"：改成 `medium` 等于让它**静默执行外部系统的写操作**。真要让只读 MCP 工具免审批，
    得先扩 `RiskLevel` 语义（加 `read` / `write` 之类）并同步 `permission.ts` 与 `verify`，别只改 registry。
26. **监控 flush 是内存队列，SIGKILL 会丢最后 ≤200ms**：`Observability.record()` 只 push 内存队列，
    `setInterval(..., 200ms)` 才批量落库（队列 ≥200 条提前刷）。优雅退出（SIGINT / SIGTERM / `exit`）
    会补一次 flush，但**进程被 `SIGKILL` / 直接杀终端会丢最后一批**；写失败也只重试 1 次就丢弃并计数。
    所以别拿 `trace_events` 当审计账本（审计是同步落库的），也别在"刚结束的回合"上做毫秒级断言。
    查询接口会先 `flush()` 再查，这是"刚结束的对话立刻可见"的原因——别把这次 flush 去掉。
    另外 `traces` / `trace_events` 有保留期清理（`TRACE_RETENTION_DAYS`，默认 30 天）：
    启动先清一次、之后每小时一次，走 `purgeTracesBefore`（先删事件再删 trace，两种后端都实现）；
    清理失败只打日志，别让它抛到主流程。
27. **当前模型只存内存，重启回落第一条 enabled chat 模型**：`ModelService.currentKey` 是进程内字段，
    `POST /api/models/current` 不落库。重启后 `pickInitialCurrent()` 取库里第一条可用 chat 模型，
    所以"切到 B 模型 → 重启 → 又变回 A"是设计如此，不是 bug。想固定默认值就改 `.env`（首启会建 `default` 供应商）。
    `LLM_DISABLE=1` 时 `resolveRuntime()` 直接返回 `undefined`（强制模拟），当前模型的选择只影响展示。
28. **`/v1/*` 必须放在静态分支之前**：`server/index.ts` 的静态资源分支是 `!pathname.startsWith("/api/")`
    就 `serveStatic`。`/v1/chat` 不带 `/api/` 前缀，**一旦把开放 API 的接管挪到静态分支之后**，
    它会被当成 `web/v1/chat` 静态文件 → 404（且是 HTML 形状的错误），而且 `/v1/*` 不能走 JWT guard
    （Bearer 是 API Key）。同理，`/v1` 本身也要给 JSON 404，别掉进静态分支。
29. **PG 路径没有在真实 Docker 镜像上验证过**：本机 Docker Desktop 起不来（docker 不可用），PG 侧是用
    **PGlite（真 PostgreSQL 18.6 WASM）** 跑通的：`data/_tmp/pgtest/server-vector.mjs` 起 socket 服务
    （PGlite + `@electric-sql/pglite-pgvector` 的 vector 扩展 + pg_trgm），`db:migrate` 跑 `0001`~`0007`、
    `db:check`、`smoke` 164、`persist-check`、`kb:pg:selftest` 16、HTTP 上传+语义检索（mode=vector）都验过。
    **但 `docker-compose.yml` 里 pgvector/pgvector:pg16 镜像本身仍未实机**——别在 README 把 Docker 写成"已验证"，
    也别在没库的情况下声称跑过 `db:migrate`：`npm run db:check` 看到 `类型: postgres` 才算真的连上了。
30. **`mcp:selftest` 的超时用例别再贴着实测阈值调**：那一项起 stdio 子进程做 `initialize` 再调慢工具，
    阈值现在是 **1500ms**（够 `node` 启动），慢工具由 fixture 的 `FIXTURE_SLOW_MS`（现在设 6000）拉长，
    两边留足余量，所以不再是 flaky。别把超时用例删掉——它覆盖的是"超时只拒绝一个请求、迟到响应不污染后续"；
    也别把 1500ms 调回 250ms 那种贴着实测的值。
31. **审批是同步内存态，不是历史表**：`GET /api/approvals` 只遍历 `SessionHub` 内存里的会话，
    读 `Session.approvalMeta` 与 `pendingApprovals` 的 resolver；进程重启后待办全部消失，
    库里**没有** `approvals` 历史表，不能当审批历史查询用（审计里只有 POST 的通用写操作记录）。
    想做"审批中心查历史 / 异步恢复"，得先改 `beforeToolCall` 的同步语义并加审批表，别在现有视图上硬凑。
32. **成员保护规则在服务层，不在数据库**：`cannot modify self` 与"至少保留一个启用 owner"靠
    `AuthService.updateMember()` / `removeMember()` 判定（`enabledOwnerCount()` 现算），数据库没有约束；
    直接改库或并发请求能绕过。**停用后旧令牌立即 401** 不是靠吊销令牌，而是 guard 每次按 `sub` 回表
    查 `users.disabled`——改鉴权链路时别省掉这次回表（省掉就得等 8 小时令牌过期）。

---

## 提交前 checklist

- [ ] `npm run typecheck` 通过
- [ ] `npm run verify` 全绿（55 项）
- [ ] 动了前端渲染再 `npm run ui-check` 全绿（14 项）
- [ ] 动了前端交互再 `npm run ui-dom-check` 全绿（232 项）
- [ ] 动了知识库再 `npm run kb:selftest` 全绿（54 项）
- [ ] 动了知识库重新向量化 / 保留期清理再核对对应 selftest 断言
- [ ] 动了 `server/kb/pgStore.ts` / 迁移 `0007` / 检索下推：配 `DATABASE_URL` 跑 `npm run kb:pg:selftest` 全绿（16 项）
- [ ] 动了鉴权再 `npm run auth:selftest` 全绿（41 项）
- [ ] 动了多模型 / API Key 再 `npm run models:selftest` 全绿（22 项）
- [ ] 动了 MCP 再 `npm run mcp:selftest` 全绿（30 项，超时阈值 1500ms + `FIXTURE_SLOW_MS`，别删用例）
- [ ] 动了可观测再 `npm run obs:selftest` 全绿（24 项）
- [ ] 起了模拟模型服务 + `npm run smoke` 全绿（164 项）
- [ ] 鉴权有变化再起 required 实例 + `npm run smoke:auth` 全绿（51 项）
- [ ] 动了开放 API / 多模型再起 required 实例 + `npm run smoke:openapi` 全绿（53 项）
- [ ] 动了 MCP 再起模拟实例 + `npm run smoke:mcp` 全绿（45 项）
- [ ] 动了监控 / 审计过滤再起 required 实例 + `npm run smoke:monitor` 全绿（61 项）
- [ ] 动了 IM Bot 再 `npm run im:selftest` 全绿（26 项，P8）
- [ ] IM 有变化再起 `DINGTALK_TRANSPORT=fake` 实例 + `npm run smoke:im` 全绿（37 项，P8）
- [ ] 新增/改动行为有对应断言（`scripts/selftest.ts` / `scripts/kb-selftest.ts` / `scripts/kb-pg-selftest.ts` / `scripts/auth-selftest.ts` / `scripts/models-selftest.ts` / `scripts/mcp-selftest.ts` / `scripts/observability-selftest.ts` / `scripts/smoke*.ts`）
- [ ] 接口或交互有变化时同步更新 README（接口清单表、状态项数）
- [ ] 没有提交 `data/`、`.env`、临时 db
