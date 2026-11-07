# biz-agent

**通用业务流程 Agent 平台** —— 基于 [Pi](https://github.com/earendil-works/pi) 的 `pi-agent-core` 构建。

把"一个业务系统接入 AI"从写代码变成**注册工具 + 组装流程**：新增业务流程不需要改核心层。
流程有两条来源——写进代码的**内置流程**，和控制台「＋ 新建技能」在运行时新建的自定义流程（存 SQLite、重启不丢）。
**界面上的"技能"就是流程**：流程给步骤与工具，技能再补「一句话说明 + 正文」；界面上不再单独暴露"流程管理"。

---

## 状态

三个垂直切片均已跑通（`npm run demo:*`），并配有一套 Web 控制台（`npm run dev`）：
| 切片 | 流程 | 说明 |
|---|---|---|
| **A 工单流转** | 查询 → 指派 → 改状态 → 通知 | 最典型的顺序写操作流 |
| **B 数据查询分析** | 探查结构 → 查明细 → 聚合 → 出报告 | 自然语言问数 |
| **C 审批流** | 规则校验 → 提交（高风险，需人工确认）→ 归档 | 权限钩子的典型用法 |

流程本身现在是**运行时可配置**的（不再只有写死的三种）：

- **A 运行时技能编排**：控制台右栏「＋ 新建技能」可以填技能名/系统提示、逐步挑工具（工具来自
  `GET /api/tools` 的业务工具目录）、写步骤提示与技能文案；保存即出现在技能面板，定义落存储层（默认 SQLite）。
  内置技能只读（`builtin=true`），自定义技能可改可删。底层还是 `/api/workflows`——技能就是带文案的流程。
- **B 流程即工具**：每条流程还会自动暴露成 `flow_<id>` 工具（例如 `flow_ticket_flow`）。
  任何会话里模型都能自己挑一条流程整条跑完——内部起子 agent，只装目标流程自己的工具，天然不递归。
  会话视图的 `tools` 字段可以看本次会话装了哪些工具。用户不需要先选流程：实测在工单会话里说
  「帮我提交张明的 3200 元客户拜访差旅报销」，模型自己挑了 `flow_approval_flow` 并整条跑完
  （审批 → 提交 → 归档）。流程工具返回的就是给用户看的结果，**调用之后模型会把它整理成回答**；
  如果这次问的事本来就不属于当前会话的流程，引擎会放行收尾（`WorkflowEngine.lastCallOffTrack`），
  不会硬把用户的问题塞回本流程的第 1 步。
- **C 自动编排（新建会话的默认项）**：一条**没有写死步骤**的内置流程，手上是整个工具目录 + 所有
  `flow_<id>`，由模型自己判断——简单的事直接调工具，整条的活就调流程工具。实测同一个会话里：
  问「把已支付订单按区域汇总金额」→ 直接调 `data_aggregate`；说「处理 TK-1001 的支付超时工单，
  指派李工并通知用户」→ 自己挑 `flow_ticket_flow` 整条跑完。
- **D 插件扩展**：插件页可导入 `biz-agent.plugin.v1` JSON 清单，声明技能与外部 HTTP/SSE MCP 服务；插件技能进入统一技能目录，可启停和卸载。清单只承载数据，不执行脚本；不接受 stdio 命令、凭证或非 HTTPS 远程地址。MCP 凭证在 MCP 页面单独配置。
- **E 技能**：上面每条流程还能当**技能**加载进当前会话（正文说明 + 该技能的工具集 + 步骤条切换），
  过程可见、中途能插话、能随时换回原流程。和 `flow_*` 委托执行互补，详见下文「技能（Skill）」。

平台化改造按 [docs/ROADMAP.md](docs/ROADMAP.md) 分阶段推进，**P1–P9 全部完成**（P8 的控制台页面也已接上）；P10 插件包首版已实现。
每个阶段都留了可重跑的入口（项数是本机实测）：

| 阶段 | 内容 | 验收入口（实测项数） | 状态 |
|---|---|---|---|
| P1 | 侧边栏模块导航壳（12 个模块） | `ui-dom-check` 268 项 | 完成 |
| P2 | 存储层 + Postgres/pgvector 路径 | `smoke` / `persist-check` / `db:check` 双后端、`kb:pg:selftest` 16 项 | 完成（PG 用 PGlite 真内核验证；Docker 镜像本身未实机） |
| P3 | 企业安全（登录 / JWT / 四角色 / 限流 / 审计） | `auth:selftest` 41 项 + `smoke:auth` 51 项 | 完成 |
| P4 | 开放 API（API Key + `/v1/chat` + `/v1/health`） | `smoke:openapi` 53 项 | 完成 |
| P5 | 知识库 RAG（上传/解析/分块/检索/绑定/`kb_search`/对话默认检索/整库重新向量化） | `kb:selftest` 66 项 + `kb:pg:selftest` 16 项（pgvector）+ `smoke` 场景 G 29 项 + 场景 G2 14 项 | 完成 |
| P6 | 多模型管理（供应商 + 模型 + 当前选择 + 连通性探测） | `models:selftest` 24 项 | 完成 |
| P7 | MCP 集成（stdio / HTTP / SSE 三种传输） | `mcp:selftest` 30 项 + `smoke:mcp` 45 项 | 完成 |
| P8 | IM Bot 网关（钉钉 + 企业微信自建应用、加密回调、测试发送与 fake outbox） | `im:selftest`、`wecom:selftest`、`smoke:im`、`smoke:wecom` | 完成（平台实网待配置凭证联调） |
| P9 | 监控与可观测（trace_id / 调用链 / 聚合 / 保留期自动清理） | `obs:selftest` 24 项 + `smoke:monitor` 61 项 | 完成 |
| P10 | 插件包（清单导入、技能贡献、MCP HTTP/SSE 声明、启停 / 卸载） | `smoke` 插件场景 I 9 项 | 首版完成 |

`npm run typecheck` 通过、`npm run verify` 55 项边界检查、`npm run ui-check` 14 项前端渲染单测、
`npm run ui-dom-check` **268 项**控制台接线自检、`npm run kb:selftest` 66 项知识库自检、
`npm run kb:pg:selftest` 16 项 Postgres/pgvector 自检、
`npm run auth:selftest` 41 项安全自检、`npm run models:selftest` 24 项多模型自检、
`npm run mcp:selftest` 30 项 MCP 自检、`npm run obs:selftest` 24 项可观测自检、
`npm run smoke` 204 项端到端检查（含插件生命周期场景 I 与对话默认检索）、`npm run smoke:auth` 51 项鉴权端到端、
`npm run smoke:openapi` 53 项开放 API / 多模型端到端、`npm run smoke:mcp` 45 项 MCP 端到端、
`npm run smoke:monitor` 61 项监控端到端、`npm run im:selftest` 26 项 IM 自检、
`npm run smoke:im` 37 项 IM 端到端（P8，要 `DINGTALK_TRANSPORT=fake` 实例）全部通过；
新前端另有 `npm run ui:e2e` 18 组 Playwright 真实浏览器回归、`npm run agents:selftest` 40 项 Agent 实体自检、
`npm run smoke:agents` 25 项 Agent HTTP 冒烟；
界面观感用 `npm run ui-shot`（本机 Edge/Chrome 无头截图）核对。
**12 个模块页全部接真接口，没有空态占位**（新前端另加一个 Agent 页，见下文）；只有接口 404 / 连不上时页面才回落到说明 + 接口清单
（403 显示「权限不足」，不混进「未接入」）。

---

## Web 控制台

```bash
npm run dev          # 启动后打开 http://127.0.0.1:4317
```

**对话**模块是三列网格（模块导航 + 会话栏 + 对话区）；技能在对话工具栏选择，在「技能」页管理。
助手消息从对话区左侧展开，用户消息靠右并限制宽度；输入框与对话区对齐，不限制消息区高度。≤900px 收起会话栏，小屏自动换行。
其它模块切成两列（模块导航 + 整宽模块页）：

- **模块导航**（最左 76px 导航栏，12 个图标及中文名称）：`对话` / `知识库` / `技能` / `模型` / `MCP` / `IM 机器人` /
  `审批` / `审计` / `成员` / `监控` / `插件` / `设置`。`对话` 就是上面的三列工作台；点其它图标切到模块页
  ——`.shell.module-view` 收成两列（导航 + 整宽内容），会话栏与右栏技能面板一起收起，切回 `对话`
  恢复会话列表 / 当前会话 / 技能状态（不重拉数据）。
- **会话栏**：`新聊天` → `置顶`（本地收藏，会话行菜单里可置顶/取消，存 `localStorage`）→
  `会话`（平铺，不按流程分组；行尾小徽标显示这条会话当前加载的技能）→ `已归档`（默认收起）。
  **没有"先选流程"这一步**：新聊天直接开一个会话（默认自动编排），模型按你的话自己决定要不要加载技能
- **对话区**：普通会话和 Agent 会话都显示当前技能、步骤、任务耗时及工具调用记录；工具记录可展开查看参数、结果、状态和耗时，带 `command` 参数的调用会突出显示命令。
  工具摘要与每轮任务耗时随会话持久化，重新打开历史会话仍可查看。上下文用量以 `k` 显示，优先采用模型返回的输入 token 数，缺失时按当前上下文估算；悬停可查看来源与 token 数。
- **技能**：在对话工具栏选择和退出；技能页提供新建、查看、编辑与删除。**自动编排（`auto-flow`）不在技能目录里**，它是默认聊天模式。
- **Agent 对话**：从 Agent 页单独进入，Agent 会话与普通会话分开显示；创建会话时固定模型、记忆和高级策略快照。

### Agent 实体（新前端的「Agent」页）

新前端（`client/`）在「构建」分组下多了一个 **Agent** 页：把模型、技能、知识库与人格指令打包成一个
**可发布、可停用**的智能体。它的实体模型照搬 AgentOne 的实体模型，没有再发明一套：

- **六维配置**（编辑抽屉里就是六个 Tab）：基础信息（名称 / 简介 / 分类）/ **人格与指令**（`agentsMd`，
  AGENTS.md 风格的 Markdown）/ **模型策略**（`modelConfig`：对话模型、温度、Top P、最大 token、流式）/
  **记忆**（`memoryConfig`：短期保留轮数、溢出策略）/ **能力绑定**（`skillIds` + `kbIds`）/ **高级**（`advancedConfig`）
- **状态机**：`draft → testing → published → stopped`，任意状态可 `revert` 回草稿。两条硬规则（来自 AgentOne §2）：
  **已发布不能直接改配置**（`PATCH` 返回 409 + `code: "published_locked"`，必须先召回草稿）；
  **已停用不能对话**（`code: "stopped_not_chattable"`）。卡片上的动作按钮跟着状态走，已发布态的「配置」按钮直接禁用
- 后端是自包含模块 `server/agents/**`（`service.ts` 状态机 + `routes.ts` 的 `/api/agents*`），表在 `agents`
  （SQLite 内建 + PG 迁移 `0008_agents.sql`），**与会话解耦**：Agent 是配置，会话是运行实例
- 参数越界是**钳制**不是报错（`temperature` 钳到 0–2、`topP` 到 0–1、`maxTokens` 到 1–128000、记忆轮数到 1–100），
  调参手滑不会丢掉整张表单

执行策略在创建会话时保存快照，之后修改 Agent 不改变已有会话的模型参数、记忆策略和高级设置。
短期记忆按用户轮次保留完整工具交互；选择「摘要」时，超出轮数先调用模型总结，失败如实报错。
关闭流式输出会等最终答案生成后一次展示；隐藏思考只影响前端事件，不改变模型内部推理。
最大推理轮数按每条用户消息重新计数，达到上限明确提示停止。停用 Agent 后，已有会话也拒绝新消息，历史仍可查看。

功能契约回归：`npm run contracts:selftest` 使用临时 SQLite 和假模型验证执行行为；
`npm run ui:e2e` 运行新前端真实浏览器回归，覆盖 14 个模块、Agent 对话活动记录、按钮与移动端布局，并将截图写到 `data/ui-redesign/`；
`npm run contracts:e2e` 自动启动隔离实例，验证登录鉴权、SSE、停用限制及 UI / Agent HTTP 回归。
运行浏览器回归前先执行 `npm run web:build`，并启动服务；测试使用模拟模型，不调用真实模型。

模块页的数据来源，界面上如实区分：

- **真数据**：`技能`（和右栏同一份技能目录，仍过滤 `auto-flow`）、`知识库`（库列表 / 新建 / 上传文档 /
  文档状态 / 检索试跑 / 删库，接 `/api/kb*`；`GET /api/kb/embedding` 决定显示「语义检索」还是「关键词检索」）、
  `模型`（供应商 / 模型两层 CRUD + 连通性探测 + 切当前模型，接 `/api/models*`）、
  `MCP`（注册 / 发现 / 工具启停 / 调试调用 / 删除，接 `/api/mcp*`，失败服务的 `lastError` 原样展示）、
  `IM 机器人`（钉钉 / 企业微信机器人 CRUD + 测试发送 + 模拟 outbox，接 `/api/im*`；页头两个按钮成组，平台配置说明收进「配置说明」折叠区，空态就地给添加入口）、
  `审批`（跨会话待办列表 + 批准 / 拒绝 / 去会话，10 秒轮询，接 `/api/approvals*`）、
  `成员`（`/api/auth/users`：新建 + 改角色 + 停用/启用 + 删除，自己那行置灰）、
  `审计`（`/api/audit`，过滤 + 分页 + traceId 列）、
  `设置`（当前模型、权限模式、**存储后端**、会话数、技能数、运行时长，以及 **API Key 管理**：新建（明文只显示一次）/
  停用 / 吊销，接 `/api/api-keys*`）、
  `监控`（KPI + 技能 / MCP / 模型的调用分组 + 调用链列表与事件时间轴，接 `/api/monitor*`）、`插件`（JSON 清单导入、启停与卸载，接 `/api/plugins*`）；`对话` 就是工作台
- **12 个模块页全部接真接口，没有空态占位**；只有接口 404 / 连不上时才回落到「未接入」说明 +
  接口清单（403 显示「权限不足」，不混进「未接入」）。
- 审批页**只列当前挂起中的待办**：进程重启后没有历史审批可查（见「已知限制」）。

`AUTH_MODE=required` 时先显示登录页（`POST /api/auth/login` 换 Bearer 令牌）；登录后按角色权限置灰不能用的操作
（例如运营没有 `workflow.write`，就看不到「＋新建技能」的可点状态）。`AUTH_MODE=off`（默认）免登录，
控制台按演示所有者（owner）渲染。

高风险工具会在对话里弹出**审批卡片**，点「同意并继续」或「拒绝」，结果实时反映到流程状态；
跨会话的待办在同名的「审批」模块里集中处理（10 秒轮询，批准 / 拒绝后会话继续跑）。

阅读体验按 Codex 的手感做：回复用 `web/markdown.js` 渲染（表格、围栏代码块带语言标签与「复制」按钮、
链接只放行 http/https/mailto 与站内路径（`/` 开头或 `#` 锚点），其余语法和 HTML 全部转义成文本）；
回答 hover 出现「复制」；
工具卡片点标题行可折叠（长输出默认收起），展开后可「复制输出」；标题行也支持键盘——`Tab` 聚焦后
`Enter` / `Space` 折叠/展开，焦点环可见且 `aria-expanded` 同步；滚动离底部时右下角浮出「回到底部」。
空会话有一张引导页（徽标 + 「今天想处理什么？」+ 三条示例 chip，点了只**填进输入框**、不替用户发送）；
`Ctrl / ⌘ + K` 随时聚焦会话搜索；流式输出时末尾有一个闪烁的方块光标。

右栏顶部的「＋ 新建技能」是技能编辑器：填技能名称与系统提示，逐步「添加步骤」——每步从
工具目录里按分类勾选工具（就是该步的 `via`）、写一句给模型的提示，另有两栏可选的技能文案。
保存后技能立刻出现在右栏面板、可以直接点开用（底层是 `POST /api/workflows`，就是一条带技能文案的流程）。
内置技能以只读方式打开（只能「查看技能」），自定义技能才允许修改与删除。
**界面上没有单独的"流程管理"入口**：流程是技能的后台存储，API 仍是 `/api/workflows` 的增删改查（见下表）。

会话标题**点击即可就地改名**（走 `PATCH /api/sessions/:id`），标题随会话一起落库、重启后仍在；
清空标题则恢复成按首条用户消息派生的默认标题。

会话可以**归档**：会话行「⋯」菜单里选「归档」，它就从会话栏主列表收进「已归档」折叠区
（有归档会话时才出现，默认收起；搜索会话时会临时展开，命中的归档会话也能看到）。
打开归档会话时标题旁会标「已归档」，右上角可直接「取消归档」。归档只是"从主列表收起来"——
会话照常能打开、能继续聊，**一发新消息就自动取消归档**；归档状态随会话落库，重启后仍在。

没有 `DEEPSEEK_API_KEY` 时自动使用**模拟模型**：按流程定义逐步"演"一遍，
用于演示和回归；配置了 key 就切换成真实模型，代码不用改。

接口清单（`server/index.ts`，按能力分表）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 存活探针：运行时长、会话数、当前模型、**存储后端** `storage: { kind: "sqlite" \| "postgres", detail }`（detail 是库文件路径或 `host:port/db`，不含口令）、**鉴权模式** `auth: "off" \| "required"` |
| POST | `/api/auth/login` | 登录 `{ email, password }` → `{ token, user, mode, permissions }`；口令错/账号不存在 401，失败过多 429 |
| POST | `/api/auth/logout` | 退出（无状态 JWT，只记审计并让前端清 token）→ `{ ok: true }` |
| GET | `/api/auth/me` | 当前用户 + 角色与权限清单 `{ mode, user, permissions }`；`AUTH_MODE=off` 返回演示所有者 |
| GET | `/api/auth/users` | 成员列表 `{ items: [{ id, email, name, role, roleLabel, disabled, createdAt, lastLoginAt }] }`（需要 `member.manage`，即 owner） |
| POST | `/api/auth/users` | 新建成员 `{ email, password, role, name? }` → 201；邮箱重复 409、角色/口令不合法/姓名超 40 字 400 |
| PATCH | `/api/auth/users/:id` | 改成员 `{ role?, disabled?, name? }`（至少传一个）→ `{ user: { id, email, name, role, roleLabel, disabled, createdAt, lastLoginAt } }`；非法 role / `disabled` 非布尔 / 姓名超 40 / 改自己的角色或状态 / 最后一个启用 owner → 400，未知 404，角色不够 403 |
| DELETE | `/api/auth/users/:id` | 删除成员 → `{ removed: true }`；不能删自己、必须保留一个启用 owner（同 PATCH），未知 404 |
| GET | `/api/audit` | 全局审计倒序列表 `?limit&offset&action&actor&actorType&targetType&from&to&q` → `{ total, limit, offset, items }`（owner / 开发者 / 审计员；`from`/`to` 支持毫秒时间戳或 ISO 串，非法 400） |
| GET | `/api/tools` | 业务工具目录（名称 / 描述 / 分类 / 风险 / 有无演示参数），技能编辑器从这里挑工具 |
| GET | `/api/skills` | 技能目录（内置 + 自定义流程都能当技能：`id/name/description/steps/tools/builtin`） |
| GET | `/api/workflows` | 流程清单（内置 + 自定义；每项带 `builtin` 与步骤 `id/title/via`） |
| GET | `/api/workflows/:id` | 流程详情（含 `systemPrompt`、每步 `hint` 与技能文案 `skill`）；未知 → 404 |
| POST | `/api/workflows` | 新建自定义流程 `{ name, systemPrompt, steps, skill? }` → 201；校验失败 → 400 |
| PATCH | `/api/workflows/:id` | 部分更新自定义流程（name / systemPrompt / steps / skill：不传沿用、传 `null` 清空）→ 200；内置 → 403，未知 → 404 |
| DELETE | `/api/workflows/:id` | 删除自定义流程 → `{ removed: true, sessionsRemoved, skillsCleared }`：连带删掉用它的会话、并让别的会话退出这条技能；内置 → 403，未知 → 404 |
| POST | `/api/sessions` | 创建会话 `{ workflowId, modelId? }`（`workflowId` 可以是自定义流程 id；未知 → 400；不传 `modelId` 用当前模型） |
| GET | `/api/sessions` | 会话列表（含存储层里的历史） |
| DELETE | `/api/sessions` | 清空全部会话 |
| GET | `/api/sessions/:id` | 会话快照（必要时从存储层恢复；含本次会话的 `tools` 列表） |
| PATCH | `/api/sessions/:id` | 重命名 / 归档会话 `{ title?, archived? }`（至少传一个；`archived` 须为布尔；空白标题清除、超长截断 80） |
| DELETE | `/api/sessions/:id` | 删除会话 |
| GET | `/api/sessions/:id/events` | SSE 事件流 |
| POST | `/api/sessions/:id/messages` | 发送消息 |
| POST | `/api/sessions/:id/approve` | 会话内审批决定（旧入口，保留；审批中心用 `POST /api/approvals/:sessionId`） |
| GET | `/api/approvals` | 审批中心全局待办 `{ items: [{ sessionId, sessionTitle, workflowId, workflowName, archived, requestId, toolName, risk, args, askedAt }], total }`（按 `askedAt` 升序；只含内存里正在挂起的审批；`session.read`） |
| POST | `/api/approvals/:sessionId` | 在审批中心处理某条审批 `{ requestId, approved }` → `{ ok, resolved, sessionId, requestId }`；会话不存在 404、参数不合法 400、已处理 / 不存在 409「这条审批已经处理过了」；`session.run` |
| POST | `/api/sessions/:id/permissions` | 权限模式 `full` / `readonly` |
| POST | `/api/sessions/:id/skills` | 加载 / 退出技能 `{ skillId: string \| null }` → `{ activeSkillId, tools, skills, steps, current, done }`；未知技能 → 400 |
| GET | `/api/kb` | 知识库列表（每项带 `docCount` / `chunkCount` / `embedding`，`embedding` 表示该库已有向量） |
| POST | `/api/kb` | 新建知识库 `{ name, description?, chunkSize?, chunkOverlap?, similarityThreshold? }` → 201；空名/重名 400 |
| DELETE | `/api/kb/:id` | 删库 → `{ removed, documentsRemoved, chunksRemoved }`（连带清技能绑定）；未知 404 |
| GET | `/api/kb/:id/documents` | 文档列表（`status` / `chunkCount` / `error`） |
| POST | `/api/kb/:id/documents` | 上传文档 `{ filename, contentBase64 }`（纯文本可传 `content`）→ 201 `{ document, chunkCount, embedded, warning? }`；单文件 20 MB |
| DELETE | `/api/kb/documents/:docId` | 删文档 → `{ removed, chunksRemoved }`；未知 404 |
| POST | `/api/kb/:id/search` | 检索 `{ query, topK?, threshold? }` → `{ mode: "vector" \| "keyword", results, fallbackReason? }` |
| POST | `/api/kb/:id/reindex` | 用当前 embedding 配置整库重算向量 → `{ chunks, embedded }`；没配 key 400、库不存在 404、块数超 5000 400 |
| GET | `/api/kb/embedding` | 向量化配置状态 `{ available, model, baseUrl }`（没配 `EMBEDDING_API_KEY` 时 `available=false`） |
| GET | `/api/skills/:skillId/kb` | 技能绑定的知识库 `{ skillId, kbIds, knowledgeBases }` |
| PUT | `/api/skills/:skillId/kb` | 覆盖式设置绑定 `{ kbIds: string[] }` → 同 GET；绑定不存在的库 400 |

**多模型管理（P6）**：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/models` | 当前模型 + 选项 + 库里的两层数据 `{ mode, current, label, options, providers, models }`（`options` 仍是 `{ id, label }`，兼容旧版） |
| GET | `/api/models/current` | 当前模型 `{ current, model, mode, label }` |
| POST | `/api/models/current` | 切当前模型 `{ modelId }`（只影响新会话、重启回落；非 chat / 已停用 → 400，未知 → 404） |
| GET | `/api/models/providers` | 供应商列表 `{ items }`（key 只有掩码 `apiKeyMasked`，不回明文/密文；密文解不开时 `apiKeyBroken:true`，页面据此给「重新填写 Key」提示） |
| POST | `/api/models/providers` | 新建供应商 `{ name, kind, baseUrl?, apiKey?, enabled? }` → 201；重名 409 |
| GET / PATCH / DELETE | `/api/models/providers/:id` | 详情 / 改 / 删（连带删它下面的模型） |
| POST | `/api/models` | 新建模型 `{ providerId, modelId, name?, kind?, enabled?, contextWindow? }` → 201 |
| GET / PATCH / DELETE | `/api/models/:id` | 详情 / 改 / 删 |
| POST | `/api/models/:id/ping` | 连通性探测 → **始终 200** `{ id, ok, latencyMs, error? }`（8 秒超时，失败给中文原因） |

**Agent 实体（六维配置 + 状态机）**：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/agents` | 列表 `{ items }`（按 `updatedAt` 倒序，每项带中文 `statusLabel`） |
| POST | `/api/agents` | 新建 → 201。**一律从 `draft` 起步**（不允许直接建出已发布的）；名称为空/超 60 字 → 400 |
| GET | `/api/agents/:id` | 详情；不存在 → 404 |
| PATCH | `/api/agents/:id` | 改配置（PATCH 语义：不传不改）。**已发布 → 409 `code:"published_locked"`**，须先召回草稿 |
| DELETE | `/api/agents/:id` | 物理删除 → `{ removed: true }` |
| POST | `/api/agents/:id/actions` | 状态机 `{ action: "test" \| "publish" \| "stop" \| "revert" }`；非法迁移 → 409 `code:"illegal_transition"`。合法迁移只有：草稿→试运行/已发布、试运行→已发布/草稿、已发布→已停用/草稿、已停用→草稿 |

**API Key 与开放 API（P4）**：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/api-keys` | Key 列表 `{ items }`（只有 `prefix`，永远不回明文/哈希） |
| POST | `/api/api-keys` | 新建 `{ name?, role?, rateLimitPerMin? }` → 201 `{ item, key }`，**明文 `bk_...` 只出现这一次** |
| PATCH | `/api/api-keys/:id` | 改 `{ name?, role?, rateLimitPerMin?, disabled? }`；已吊销 → 409 |
| DELETE | `/api/api-keys/:id` | **软吊销** → `{ removed, item }`（记录保留供审计，之后用这把 Key 一律 401） |
| POST | `/v1/chat` | OpenAI 形状：非流式 JSON / `stream:true` 的 SSE（末尾 `data: [DONE]`）；Bearer API Key；限流 429 带 `Retry-After` |
| GET | `/v1/health` | 免鉴权探针 `{ ok, version, model, storage, uptimeMs }` |

**MCP（P7）**：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/mcp/servers` | 服务列表 `{ items }`（每个带发现到的工具、`toolCount`、`lastStatus` / `lastError`） |
| POST | `/api/mcp/servers` | 注册并**立即发现** `{ name, transport: "stdio"\|"http"\|"sse", command?, args?, url?, headers?, env?, enabled? }` → 201 |
| GET / PATCH / DELETE | `/api/mcp/servers/:id` | 详情 / 改（连接相关字段变了会重发现）/ 删（连带删工具、关连接） |
| POST | `/api/mcp/servers/:id/refresh` | 重新 `initialize` + `tools/list`（幂等，工具启停状态保留） |
| GET | `/api/mcp/servers/:id/tools` | 工具列表 `{ items }`（含已停用的，前端要能切换） |
| PATCH | `/api/mcp/tools/:id` | 工具启停 `{ enabled }` |
| POST | `/api/mcp/servers/:id/call` | 直接调一次 `{ tool, arguments? }` → `{ serverId, serverName, tool, toolName, isError, text, content }` |

**监控与可观测（P9）**：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/monitor/summary` | 聚合 `?range=30m\|1h\|24h\|7d`（默认 24h；写法不对 400）：会话 / 消息 / 工具成功率 / 平均与 p95 / 技能 / MCP / 模型 / 错误数 |
| GET | `/api/monitor/traces` | 调用链列表 `?limit&offset&sessionId` → `{ total, items }`（`ms`、`status`、`toolCount`、`model`） |
| GET | `/api/monitor/traces/:id` | 调用链详情 `{ trace, events }`（事件按 `seq` 升序）；未知 → 404 |

**IM Bot 网关（P8）**：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET / POST | `/api/im/bots` | 机器人列表 / 新建（凭证 AES-256-GCM 加密落库，出参只有掩码） |
| GET / PATCH / DELETE | `/api/im/bots/:id` | 详情 / 改 / 删（连带删会话映射） |
| POST | `/api/im/bots/:id/ping` | 发一条测试消息（`DINGTALK_TRANSPORT=fake` 时进 outbox） |
| POST | `/api/im/dingtalk/callback` | 钉钉回调（**免登录**：验加签或 AES 加密；同一 `msgId` 幂等） |
| GET / POST | `/api/im/wecom/callback?botId=<id>` | 企业微信自建应用 URL 验证 / 加密 XML 消息回调（公开入口，必须验签解密） |
| GET | `/api/im/outbox` | 任一平台使用 fake 时可用，只含模拟消息（调试/审计视图，读 `audit.read`） |

**企业微信接入**：在「IM 机器人 → 添加机器人」选择「企业微信 · 自建应用」，填写 CorpID、应用 Secret、数字 AgentId、接收消息 Token 和 43 位 EncodingAESKey。保存后复制卡片的专属回调地址，在企业微信应用「接收消息」中配置可公网访问的 HTTPS 地址及相同密钥；配置应用可信 IP 与员工可见范围。URL 验证通过后，员工向应用发送文本即可建立独立的多轮会话，回复通过企业微信应用消息接口发回该员工。

当前企业微信支持自建应用的员工文本消息，不包含群机器人 Webhook、图片、语音与外部联系人。测试消息弹窗填写员工 UserID；钉钉可选择群会话 ID 或员工 ID。停用机器人会拒绝测试发送和回调。

企业微信模拟传输配置 `WECOM_TRANSPORT=fake`（未配置时沿用 `DINGTALK_TRANSPORT`）；正式传输使用 `real`。本地测试必须同时配置 `LLM_DISABLE=1`。凭证仍密文存储，企业微信 CorpID 复用 `appKey` 字段、AgentId 复用 `robotCode`，接口创建时传 `platform: "wecom"`。加密回调对企业 ID 与应用 ID 校验，重复消息按 MsgId 去重，同一员工消息串行执行。

协议参考：[企业微信回调配置](https://developer.work.weixin.qq.com/document/path/90930)、[发送应用消息](https://developer.work.weixin.qq.com/document/path/90236)。

权限点（都在 `server/auth/roles.ts`）：`/api/models*` 的写、`/api/api-keys*` 的读写 → `workflow.write`；
`/api/mcp*` 读 `workflow.read` / 写 `workflow.write`；`/api/kb*` 与 `/api/skills/:id/kb` 写 → `workflow.write`；
`/api/monitor/summary` → `session.read`，`/api/monitor/traces*` → `audit.read`；
`/api/approvals` 读 `session.read` / 写 `session.run`（审计员只读，不能批）；
`/api/auth/users*` 的读写都走 `member.manage`（只有所有者）。

流程校验规则（`src/core/workflowSpec.ts`，控制台与后端共用同一份）：名称 1–40 字、系统提示 1–4000 字、
0–10 个步骤（0 = 纯技能：只写「什么时候用」和正文，调哪些工具交给模型自己判断）、每步标题 1–40 字、`hint` ≤200 字、`via` 1–8 个且必须是工具目录里的工具名；流程重名 → 400。
技能文案同样在这里校验：一句话说明 ≤200 字、正文 ≤4000 字，两段都空 = 没写（仍能当技能用，目录里走兜底描述）。

服务端零框架依赖，只用 `node:http`；前端是原生 JS，**没有构建步骤**。
markdown 渲染单独放在 `web/markdown.js`（经典脚本，挂 `window.renderMarkdown`，先转义再套标签），
它不是 ES module，所以单测用 `npm run ui-check` 在 `node:vm` 沙盒里跑浏览器那份文件。

---

## 技能（Skill）

每条流程都能当**技能**加载进当前会话，等于把这条流程的「作业指导书 + 工具集」临时装进模型手上：

- **正文** = 流程的技能文案（`skill.description` 进技能目录，`skill.instructions` 是加载后的正文）+ 步骤清单；
  正文写职责边界、坑和汇报要求，步骤仍由 `WorkflowEngine` 按 `steps` 推进——技能和流程共用同一份定义。
- **工具集** = 该流程步骤用到的工具（`via` 去重）；没有步骤的技能（自动编排、或零步骤的自定义技能）沿用会话现有工具，模型自己挑。
- **编辑形态照着 Agent Skills 来**：主表单只有「技能名称 / 什么时候用它（必填，模型靠这句决定是否加载）/ 指导书正文」，
  步骤与系统提示收在「高级」里——大多数技能不需要固定步骤。
- **渐进式披露**：系统提示里只放一行「`id`（名称）：一句话描述」，模型判断需要时才调 `use_skill` 加载。
  加十条技能只多十行目录，不会把十份正文塞进上下文。
- **加载 / 退出**：右栏技能面板里点一条技能就装进当前会话（等价 `POST /api/sessions/:id/skills`），
  「当前技能」块与步骤条一起变；块里的「退出技能」回到会话自己的流程，且**恢复加载前的进度**
  （`engine.reset(workflow, 快照)`）。页头技能胶囊只显示状态、不做入口；模型自己调 `use_skill` 也走
  同一个接口——控制台手动加载与模型自动加载结果一致。
- **和 `flow_*` 怎么选**：只想把整条流程丢出去、只要结论 → 调 `flow_xxx` 工具（内部子 agent 执行，
  省上下文、定序强、过程不可见）；需要过程可见、中途能插话、能换技能 → 加载技能（正文占上下文，模型自己按步骤做）。
  加载技能后 `flow_*` 仍在工具集里，所以随时可以改成委托执行。

### 技能模块（查看 / 加载 / 新建 / 编辑 / 删除）

从左侧「技能」入口管理技能；**底层仍是流程**：一条技能 = 一条流程 + 它的技能文案。目录支持按名称或说明搜索，并筛选内置、自定义和使用中的技能。

- **查看**：技能条目「⋯ → 查看技能」只读打开（内置技能只有这一项；能看说明、正文与步骤，不能改）；
- **加载**：点技能条目 = 装进当前会话；没有打开的会话时提示先开会话，已经是当前技能再点幂等（不重复发请求）；
- **新建**：「＋」打开技能编辑器（标题「新建技能」，焦点直接落在技能说明）——填名称、系统提示、
  技能说明、技能正文与步骤，保存后即出现在技能目录里；底层就是 `POST /api/workflows`（带 `skill` 文案）；
- **编辑**：自定义技能「⋯ → 编辑技能」，说明/正文/步骤一起改。`PATCH /api/workflows/:id` 对 `skill` 是**替换语义**：
  只传说明时旧正文会被清掉（不会和旧值合并）；传 `null` 清空技能文案，目录里回落到「按固定步骤完成「<流程名>」。」；
- **删除**：「⋯ → 删除技能」二次确认后 `DELETE /api/workflows/:id`。删的是整条定义，所以服务端会：
  ① 连带删掉用这条流程建的会话（响应里 `sessionsRemoved`，否则会话找不到流程会变孤儿）；
  ② 让别的会话退出这条技能（`skillsCleared`，正在加载它的会话收到 `skill` 事件、`activeSkillId` 回到 `null`）。
  内置技能只读，没有编辑/删除。
- **不列入自动编排**：`auto-flow`（默认聊天模式）不在列表里——它没有固定步骤、手上是整个工具目录，
  列进去只会让人以为"要手动选它"。但 `GET /api/skills` 仍返回它，模型也能 `use_skill("auto-flow")`；
  当前技能真是它时，「当前技能」块照常显示名字。

技能文案存在存储层（默认 SQLite）的 `workflows.skill` 里，重启后还在；它的"正文"就是你写的那段作业指导书，加载后进上下文。

---

## 企业安全（P3）

默认 `AUTH_MODE=off`：所有接口照旧放行，开发/回归不用先建账号（`/api/auth/me` 返回内置的演示所有者
`owner@local`）。设成 `AUTH_MODE=required` 后，除 `/api/health`、`/api/auth/login|logout` 与静态资源外，
都要带 `Authorization: Bearer <token>`；控制台会先显示登录页。

### 四角色与权限矩阵

矩阵的唯一真相在 `server/auth/roles.ts`：`permissionFor()` 把「方法 + 路径」映射到权限点，`can()` 判角色，
路由层、`/api/auth/me`、测试脚本都从这里读，别在别处再写一份。

| 权限点 | 说明 | 所有者 | 开发者 | 运营 | 审计员 |
|---|---|---|---|---|---|
| `workflow.read` | 查看技能 / 工具目录 / 模型 | ✓ | ✓ | ✓ | ✓ |
| `workflow.write` | 新建、修改、删除技能（`/api/workflows` 写操作） | ✓ | ✓ | — | — |
| `session.read` | 查看会话 | ✓ | ✓ | ✓ | ✓ |
| `session.write` | 新建 / 重命名 / 归档 / 删除会话 | ✓ | ✓ | ✓ | — |
| `session.run` | 让会话发言、加载技能、审批、改权限模式 | ✓ | ✓ | ✓ | — |
| `audit.read` | 读 `/api/audit` | ✓ | ✓ | — | ✓ |
| `member.manage` | 成员管理 `/api/auth/users`（列表 / 新建 / 改角色 / 停用 / 删除） | ✓ | — | — | — |
| `settings.write` | 修改平台设置（预留给 P6 / P9） | ✓ | — | — | — |

- 403 文案直接上界面，例如「当前角色是运营，不能修改技能」。
- 认证按令牌里的 `sub` **每次回表查用户**：角色被改、账号被停用立刻生效，不用等令牌过期；令牌本身 8 小时过期。
- 登录限流：同一「邮箱 + IP」连续失败 **5 次锁 5 分钟**，锁定期间返回 429「尝试太频繁，请在 N 秒后再试」；
  登录成功清空计数。限流是进程内 Map，重启清零（单实例部署够用）。
- 审计：所有写操作（POST / PATCH / PUT / DELETE）在请求收尾自动落 `audit_logs`（动作名、目标类型/id、
  方法/路径/状态码），登录成功与失败、建成员、改技能、建/删会话都有记录；`GET /api/audit` 倒序返回，
  支持 `limit` / `offset` / `action` / `actor` 过滤，owner / 开发者 / 审计员可读（运营 403，矩阵见上表）。
  审计写失败只打日志，不影响业务响应。
- 密码与令牌零第三方依赖：`node:crypto` 的 **scrypt**（N=16384 / r=8 / p=1，自描述哈希串 + 随机盐，
  `timingSafeEqual` 校验）+ **HMAC-SHA256 JWT**（手写 `header.payload.signature`，`timingSafeEqual` 验签）。
- 首次以 `AUTH_MODE=required` 启动且 `users` 表为空时，会建一个所有者账号：邮箱取 `AUTH_BOOTSTRAP_EMAIL`
  （默认 `owner@local`）、口令取 `AUTH_BOOTSTRAP_PASSWORD`（未配置则随机生成并**只在启动日志打印一次**）。
  `AUTH_SECRET` 未配置时每次启动随机生成，重启后旧令牌全部失效；生产环境请显式配置。

### 成员管理（改角色 / 停用 / 删除）

成员的增删改都在控制台「成员」页，接口是 `/api/auth/users`（`member.manage`，只有所有者）：

- `GET` 列表带 `id/email/name/role/roleLabel/disabled/createdAt/lastLoginAt`；`POST` 新建（邮箱重复 409）。
- `PATCH /api/auth/users/:id`：`{ role?, disabled?, name? }` 至少传一个；改角色、停用/启用、改姓名。
  非法角色、`disabled` 非布尔、姓名超 40 字 → 400；成员不存在 → 404。
- `DELETE /api/auth/users/:id` → `{ removed: true }`；记录从 `users` 表删掉，**不可恢复**，旧令牌立即失效。
- **保护规则（在服务层）**：
  - 不能改自己的角色或状态，也不能删自己（否则会把自己锁在外面）——400「不能修改自己的角色或状态」；
    姓名字段后端不拦自己（界面上自己那行三个操作一起置灰，不提供入口）；
  - 必须保留至少一个**启用中的所有者**：最后一个启用 owner 被降级 / 停用 / 删除 → 400「至少要保留一个启用的所有者」；
  - 停用或删除后旧令牌立刻 401：guard 每次请求都按令牌 `sub` 回表查用户，`disabled` 直接当未登录。
- 每次写操作落 `user.update` / `user.delete` 审计，带改动前后字段。
- 保护规则只在服务层（没有数据库约束）；直接改库或并发请求绕过接口不受它保护（见「已知限制」）。

---

## 审批中心

高风险工具调用（`risk: "high"`，例如切片 C 的 `approval_submit` 与所有 MCP 工具）会在 `beforeToolCall`
里**同步挂起**，等人工决定后才继续。控制台有两条入口：

- **会话内联审批卡片**：对话流里弹出，点「同意并继续 / 拒绝」。
- **审批中心（全局待办）**：左侧 `审批` 模块 + `GET /api/approvals`，把**所有会话**里正在挂起的审批合并成一份，
  按 `askedAt` 升序（先问先显示）。每条带 `sessionId / sessionTitle / workflowId / workflowName / archived /
  requestId / toolName / risk / args / askedAt`；已归档会话**不过滤**，只标 `archived`——藏起来只会让那次调用永远卡住。
- 界面**10 秒轮询**一次（切走模块停、标签页隐藏暂停），等待超 60 秒标红；没有待办时显示空态说明。
- 批准 / 拒绝走 `POST /api/approvals/:sessionId`，body `{ requestId, approved }`：
  - 批准 → 那次工具调用继续跑，会话继续；
  - 拒绝 → 只让这一次调用失败，会话本身继续（可以接着追问或换个方式办）；
  - 同一条再提交（或 requestId 已不存在）→ **409「这条审批已经处理过了」**，界面提示并刷新队列；
    会话不存在 404、缺 `requestId` / `approved` 非布尔 400。
- 权限：GET 要 `session.read`、POST 要 `session.run`——**审计员只读**（能看列表，按钮置灰、后端 403）。
  批准 / 拒绝会记一条 `approval` 事件（含等待毫秒），并随 POST 落一条通用写操作审计。
- 旧接口 `POST /api/sessions/:id/approve` 保留，两条入口最终都走 `Session.resolveApproval()`，口径一致。

**语义仍是同步的**：`beforeToolCall` 会一直等这次人工决策，`pendingApprovals` 是内存里的 Promise resolver，
`approvalMeta` 只保存元数据。所以审批中心只反映**此刻正在挂起**的调用：进程重启、审批被处理或会话解析完成后，
这条待办就消失；**没有历史审批表**，不能当审批历史查询用。要做外部审批系统的异步恢复，得先改造这个同步语义。

---

## 知识库（P5）

`server/kb/**` 把「上传 → 解析 → 分块 → 落库 → 检索」接通，技能可绑定多个知识库；会话里模型用 `kb_search`
工具检索当前技能（没加载技能时回落到会话自己的流程）绑定的库（`server/kb/tool.ts`，会话级工具，**不进**
`/api/tools` 业务工具目录，自定义流程的 `via` 也不能引用它）。

**存储后端与检索下推**：知识库 DAO 有 `KbStore` 这一份契约、两种实现，跟着宿主的 `DATABASE_URL` 自动选：

| 后端 | 表 | 向量存法 | 语义检索在哪算 |
|---|---|---|---|
| SQLite（默认） | `DB_PATH` 同一个库文件（`server/kb/schema.ts` 建表） | `kb_chunks.embedding` 存 JSON 文本 | `server/kb/store.ts` 读回内存算余弦 |
| Postgres（配了 `DATABASE_URL`） | `db/migrations/0001_init.sql` + `0007_kb_pgvector.sql` | `kb_chunks.embedding` 是 pgvector 的 `vector` 列 | `server/kb/pgStore.ts` 用 `embedding <=> $vec` 排序，只回命中行 |

- 两边的 SQLite / PG 表名、列名与行映射一致（共用 `server/kb/store.ts` 的归一化与映射），所以 service / routes / `kb_search` 不知道底下是哪种库。
- **向量维度不固定**：`0007_kb_pgvector.sql` 把 `embedding` 从 `vector(1024)` 改成无维度 `vector`（默认模型是 1536 维、可换 1024/3072）；
  代价是 HNSW 索引必须有固定维度，所以删掉那条索引、语义检索走精确余弦扫描（单机控制台规模够用）。
- PG 分支的 `KbStore` 方法也是同步的，复用存储层那套「工作线程跑 pg + 主线程 Atomics.wait」的同步桥；
  没装 pgvector 扩展时启动会 warn，检索自动回退关键词。

### 支持的文件与上传

- 格式：`txt` / `md` / `markdown` / `csv` / `pdf` / `docx`；单文件上限 **20 MB**（请求体上限 32 MB），解析超时 60 秒。
- 上传走 `POST /api/kb/:id/documents`，请求体 `{ filename, contentBase64 }`（浏览器里 `FileReader` 拿到的
  `data:...;base64,` 前缀也接受）；纯文本调试可用 `content` 代替 `contentBase64`。
- 解析、分块、落库在请求内同步做完再返回 201：`document.status === "ready"`，`chunkCount` 是本文件写入的块数。
- 分块默认 800 字符、相邻块重叠 120 字符（每个库可用 `chunkSize` / `chunkOverlap` 覆盖）；建库时可用
  `similarityThreshold`（默认 0.2）控制语义检索的相似度门槛。
- CSV 会先摊平成 `列名: 值；…`；PDF 用 `unpdf`、Word 用 `mammoth`，都是纯 JS、无系统依赖。

### 向量化与检索模式

**向量模型有两条配置来源，优先用模型页那条**（每次调用现读，改完不用重启）：

| 来源 | 怎么配 | 检索行为 |
|---|---|---|
| ① 模型页（推荐） | 模型页建一条 `kind: "embedding"` 的模型（供应商要有 `/embeddings` 端点），在模型表对应行点「设为向量模型」 | 上传时按批（32 条/次）向量化；检索走向量余弦，`mode: "vector"` |
| ② 环境变量 | `EMBEDDING_BASE_URL` + `EMBEDDING_MODEL` + `EMBEDDING_API_KEY` | 同上（部署期配置的老路子，仍然支持） |
| 都没有 | —— | 自动走关键词检索（中文分词 + 2-gram + 标题加权），`mode: "keyword"` |
| 配了但调用失败 | —— | 回退关键词检索，`mode: "keyword"`，响应里带中文 `fallbackReason` |

- 模型页那条模型**优先于环境变量**；它存在但用不了（Key 解不开、没填 base_url）时，`available=false` 并在
  `GET /api/kb/embedding` 的 `problem` 里如实写原因，**不会**悄悄换成环境变量那条（否则会用错模型还不自知）。
- `GET /api/kb/embedding` 返回 `{ available, model, baseUrl, source, modelKey, problem }`：
  `source` 是 `model` / `env` / `none`，`modelKey` 是模型页那条模型的行 id，页面据此标「已启用 / 未启用 / 配置有误」。
- 具体某个库有没有向量看库行的 `embedding`（`embeddedChunkCount > 0`）——换模型后旧文档要
  「重新向量化」或 `POST /api/kb/:id/reindex` 才带新模型算出的向量；模型可用但某个库仍有缺向量的块时，库详情会显示「待补齐」横幅和缺失块数，点「补齐向量（N 块）」即可重算整库。
- `TRACE_RETENTION_DAYS`（默认 30）：调用链保留天数，`0` 关闭自动清理（见「监控」章节）。
- **向量化失败绝不阻断上传**：文档与分块先落库（`ready`），检索退回关键词，响应里带 `warning`。
- 换模型不会崩：向量按模型返回的维度存（SQLite 是 JSON 文本、PG 是 pgvector 的无维度 `vector` 列），不假设维度；
  维度确实对不上时 SQLite 按相似度 0 处理，PG 会让 pgvector 报错 → 检索层回退关键词并带 `fallbackReason`。

### 技能绑定与 `kb_search`

- `GET /api/skills/:skillId/kb` → `{ skillId, kbIds, knowledgeBases }`；
  `PUT` 同一路径、body `{ kbIds: string[] }` 是**覆盖式**设置（重复/空白 id 会归一，绑定不存在的库 → 400，
  单技能最多 50 个）。
- 绑定关系落 `skill_kb_bindings`；删库会连带清掉绑定。
- 会话里 `kb_search` 按当前技能 id（没加载技能时回落到会话自己的流程）查绑定并聚合检索（多库按分值合并、取 topK）；
  没绑定 / 没命中 / 知识库模块报错都返回一句中文说明，**不把工具调用打成失败**，模型可以照常回答并说明没查到。

### 对话默认检索（不加载技能也能 RAG）

绑给技能是"按技能查"，但日常问答不该强制先挑技能，所以还有一条**对话默认检索**：

- `GET /api/kb/defaults` → `{ kbIds, knowledgeBases }`；`PUT` 同一路径、body `{ kbIds: string[] }` 覆盖式设置
  （不存在的库 → 400；最多 50 个）。`GET /api/kb` 每行多一个 `isDefault`，控制台开关直接读它。
- **解析顺序**：当前技能绑定了库 → 用技能的；没绑定 / 没加载技能 → 用对话默认库。
  这样"加载了绑定技能"的会话不会被默认库污染，而普通问答又能直接查资料。
- 有默认库时，会话的系统提示里会多一段「# 知识库」点名这些库该怎么用（先 `kb_search` 再回答、
  引用要标来源、没查到就说没查到）——模型不知道有这条路就永远不会调工具。
- 绑定关系落 `kb_default_bindings`（SQLite 在 `server/kb/schema.ts` 建表，PG 走 `0010_kb_defaults.sql`）；
  删库时残留绑定会在读取时被过滤掉，不会让检索 404。

### 控制台页面

- **一个库都没有时给一张空态卡**（讲清知识库是干什么的 + 主按钮「新建知识库」），不是两栏各一句占位话；
  进页面会自动选中第一个库，右侧直接是文档与检索试跑。
- 顶部状态条说清检索模式：`关键词检索`（按字面词匹配）/ `语义检索`（配好 embedding 后按意思召回）；
  库标题旁显示 `N 文档 · M 块`，语义检索开启时再显示 `已向量化 x/M`。
- 上传是同步解析：按钮先变「上传中…」并禁用（防连点），完成后提示写入的分块数；解析失败按 5xx 归类，
  提示「这个文件没解析出文字（扫描件、加密或文件损坏）」而不是抛英文报错。
- 「删除知识库」用危险色并带二次确认（会连带删文档与分块）；窄屏下文档表改成一条一张卡，
  库列表与详情上下叠放（5 列表格在 300px 里放不下）。

### 已知限制

- PDF 没有 OCR：扫描件解析不出文字会直接报「可能是扫描件（暂不支持 OCR）」。
- 上传后再补 `EMBEDDING_API_KEY`，旧文档不会自动重嵌入；但在知识库页点「重新向量化」或调
  `POST /api/kb/:id/reindex` 就能把整库分块按当前模型重算一遍（补向量），不用重新上传。
- **pgvector 只保证"能检索"，没有 HNSW 索引**：`0007` 迁移把向量列改成无维度、删掉 HNSW 索引，
  语义检索走精确余弦扫描（知识库是单机控制台规模；要上千万级块再按固定维度 + 分表建 HNSW）。
- **PG 的 pgvector 检索没有在真实 Docker 镜像里跑过**：本机 Docker Desktop 起不来，PG 侧（含 pgvector）
  是用 PGlite（真 PostgreSQL 18.6 WASM + pgvector 扩展）+ 线上协议代理验的，`docker-compose.yml` 的镜像本身未实机；
  没装 `vector` 扩展的 Postgres 会自动回退关键词检索。
- 上传在请求内同步解析：20 MB 大文件会让这次请求等一会儿（还没有异步任务队列）。

---

## 多模型管理（P6）

`server/models/**` 把「供应商 → 模型 → 当前选择」做成两层数据，会话构造时按模型行注入运行时：

- **供应商**（`model_providers`）：`name` / `kind`（`openai` / `deepseek` / `ollama` / `anthropic` / `custom`）/
  `base_url` / `api_key_encrypted` / `enabled`。
- **模型**（`models`）：挂在供应商下，`model_id` 是供应商那边的模型名（例如 `deepseek-v4-pro`），`name` 是展示名，
  `kind` 是 `chat` / `embedding`，可单独停用。
- 只有 `chat` + `enabled`、且供应商也 `enabled` 的模型才能被设为当前模型。
- `embedding` 类型的模型给知识库用：模型页的「向量模型（知识库语义检索）」区块选一条，选完立刻生效（见「知识库」章节）。

### API Key 的加密与掩码

- 用 **AES-256-GCM**（`node:crypto`，零依赖）加密后落库，密文是 `{ v: 1, iv, tag, data }` 的 JSON（每段 base64）；
  GCM 自带完整性校验，密钥不对或密文被改直接抛错，不会返回半截明文。
- 密钥来源优先级：`SECRET_KEY` → `AUTH_SECRET` → **进程内随机生成并 warn**（重启后旧密文解不开，生产必须显式配置）。
- 出参**永远只有掩码**（`sk-****abcd`）；明文只在创建/替换的那一次进内存，接口不回明文、不回密文。

### 首启自动建 default 供应商

- 库里一个供应商都没有、且 `.env` 里有可识别的 key 时，自动建一个名为 `default` 的供应商 + 一条 `chat` 模型，
  并把当前模型指向它——行为与 P2 完全一致，不用先到页面上配。
- 已经建过任何供应商就完全不动（幂等）；`LLM_DISABLE=1` 时一律不建、也不用真实模型（冒烟/演示要可复现）。
- `default` 供应商的密文解不开时（例如换了 `SECRET_KEY`）回落 `.env`，别让一次重启把真实模型变成模拟模型。

### 向量模型（知识库语义检索）

- `GET /api/models/embedding` → `{ modelKey, options }`（`options` 只含 `kind: "embedding"` 且启用、供应商也启用的模型）；
  `POST` 同一路径 `{ modelId }` 设为向量模型——只能选 `embedding` 类型，选 `chat` 会 400。
- 知识库那边通过 `initKb({ resolveEmbedding })` 拿到「端点 + 模型名 + 明文 Key」，配置每次调用现读，
  所以**改完即时生效**（不用重启、不用重新上传；已上传的旧文档点「重新向量化」补向量）。
- 没手动选过时，读取会自动挑第一条可用的向量模型（重启后也是这套规则）。
- 供应商端点不支持 `/embeddings`（例如 `deepseek` / `anthropic` 没填自定义 `base_url`）时，
  知识库页会显示「向量模型不可用 + 原因」，不会静默降级到"看起来能用"。

### 切当前模型

- `GET/POST /api/models/current`。**选择只存在进程内存**，不进库：重启后回落到第一条可用的 `chat` 模型
  （见「已知限制」）。
- 切换**只影响之后新建的会话**（`POST /api/sessions` 不传 `modelId` 时取当前模型）；已经开着的会话模型不变。
- 指向的模型被删/停用、或供应商被停用时，读取时自动退回第一条可用模型，不会 500。

### 连通性探测（ping）

- `POST /api/models/:id/ping`：绕开 Pi，按供应商类型直接对端点发一个极短请求
  （`/chat/completions`、`/embeddings`，Anthropic 走 `/messages`），**8 秒超时**。
- **不管成功失败都返回 200**，body 是 `{ id, ok, latencyMs, error? }`；`ok=false` 时 `error` 是中文人话
  （「连不上这个端点（地址写错了、端口没开，或网络不通）」「探测超时（8 秒）」），密钥本身不会出现在错误文案里。
- `custom` 供应商没填 `base_url` 时直接回 `ok:false`（不猜地址，免得把请求打到别人的服务器上）。

---

## 开放 API（P4）

外部系统用 **API Key** 调 `/v1/*`：不需要 JWT、不需要先建会话，`/v1/*` 在 `server/index.ts` 里**先于静态资源分支**接管。

### API Key 生命周期

- `POST /api/api-keys` 生成 `bk_` + 32 字节随机串（base64url）。**明文只在这一次响应里出现**（`{ item, key }`）；
  库里只存 `sha256` + 前 8 位 `prefix`，之后列表/详情只有 `prefix`、角色、限额、最近使用时间。
- 每把 Key 带 `role`（默认 `operator`）与 `rateLimitPerMin`（默认 60，范围 1–6000）。调用时按同一份权限矩阵判
  `session.run`：`auditor` 的 Key 调 `/v1/chat` 会 403（和 JWT 用户走同一套矩阵）。
- `PATCH` 改名称/角色/限额/停用；`DELETE` 是**软吊销**（置 `revoked_at` + `disabled`），记录留在库里和审计里，
  之后用这把 Key 一律 401。
- 鉴权固定走 `Authorization: Bearer bk_...`。令牌桶**在内存**（单实例部署，重启清零，与登录限流一致），
  容量 = `rateLimitPerMin`，每 `60000 / rateLimitPerMin` 毫秒回一个令牌。

### `/v1/chat`

请求（OpenAI 形状；`model` 字段目前不参与路由，实际用的是当前模型）：

```json
{
  "model": "deepseek-v4-pro",
  "messages": [{ "role": "user", "content": "把 TK-1001 指派给李工" }],
  "stream": false,
  "sessionId": "可选：续聊同一个会话"
}
```

非流式响应：

```json
{
  "id": "chatcmpl-1a2b3c4d5e6f7890",
  "object": "chat.completion",
  "created": 1760000000,
  "model": "deepseek-v4-pro",
  "choices": [
    { "index": 0, "message": { "role": "assistant", "content": "已把 TK-1001 指派给李工。" }, "finish_reason": "stop" }
  ],
  "usage": { "prompt_tokens": 12, "completion_tokens": 30, "total_tokens": 42 },
  "sessionId": "ses-..."
}
```

`stream: true` 时是 SSE，每个 `data:` 是一条 `chat.completion.chunk`（首块带 `role`、之后带 `delta.content`、
末尾 `finish_reason: "stop"`），最后一行固定 `data: [DONE]`：

```text
data: {"id":"chatcmpl-...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

data: {"id":"chatcmpl-...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"已把"},"finish_reason":null}]}

data: {"id":"chatcmpl-...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

- 不传 `sessionId` 就新开一个 `auto-flow` 会话（用当前模型），响应里回 `sessionId` 供下次续聊；
  会话照常出现在控制台会话列表里。
- `messages` 最多 200 条、单条 content 最多 20 万字符；续聊时只送最后一条 user 消息（历史在会话上下文里）。

### `/v1/health`

免鉴权探针：`{ ok, version, model, storage, uptimeMs }`。给外部系统做存活检查用，不含任何密钥。

### 限流与统一错误

- 超限回 **429** + `Retry-After`（秒），文案「请求太频繁，请在 N 秒后再试」。
- `/v1/*` 的错误统一是 `{ "error": { "message": "中文说明", "type": "...", "code": "..." } }`：
  `invalid_api_key` / `forbidden` / `rate_limited` / `invalid_request` / `session_not_found` /
  `model_error`（上游模型失败 502）/ `not_found`。
- 每个响应都带 `x-trace-id` 头；`/v1/*` 的每次调用（含 401/429/404）都写一条审计，
  `actor_type="api_key"`，可按 `traceId` 和调用链对账。

---

## MCP 集成（P7）

`server/mcp/**` 把外部 MCP 服务器的工具接进平台（**手写 JSON-RPC 2.0，零第三方依赖**）：

- **三种传输**：`stdio`（`command` + `args` + `env`，起子进程）、`http`（Streamable HTTP，回传 `Mcp-Session-Id`）、
  `sse`（先收 `endpoint` 事件，再 POST 回传，按 `id` 在流里配对）。
- **命名**：工具名 `mcp_<server>_<tool>`，唯一真相在 `server/mcp/names.ts`；slug 后只含 `[a-z0-9_]`，
  大小写/空格/连字符/中文都会**变成下划线**（不是删除），例如 `CRM Server` + `Get-Weather` → `mcp_crm_server_get_weather`。
- **注册即发现**：`POST /api/mcp/servers` 当场 `initialize` + `tools/list`，把工具落库并进快照；
  `POST /:id/refresh` 幂等重发现（按原始工具名对齐，启停状态保留）。
- **状态与错误**：每个服务带 `lastStatus`（`ok` / `error` / `unknown`）与 `lastError`（中文原因）；
  发现失败不会把启动带崩，工具沿用上次成功的结果。
- **工具启停**：`PATCH /api/mcp/tools/:id { enabled }`，停用后立刻从 `/api/tools`、会话工具集、技能 `via` 里消失。
- **调试调用**：`POST /api/mcp/servers/:id/call { tool, arguments }` 直接调一次，回 `{ isError, text, content }`。
- MCP 工具会进 `/api/tools`（分类「MCP」）、会话工具集和技能编辑器；工具名冲突时注册表加数字后缀。

局限：

- 不做 OAuth；`tools/list` 的 `nextCursor` **不分页**（只取一页）；调用失败/断线**不自动重连、不续传**。
- 已经开着的会话，工具集是**创建/加载技能时的快照**：之后新注册的 MCP 服务要新开会话（或重新加载技能）才看得到。
- MCP 工具默认 `risk: "high"`（平台的 `RiskLevel` 只有 low/medium/high，**没有 `write`**），
  而审批只在 `high` 触发——所以**每次 MCP 工具调用都会走人工审批**。

---

## 监控与可观测（P9）

- **trace_id**：每轮用户消息开一条调用链，形状 `tr_` + 12 位 base36（`server/observability/trace.ts`）；
  `done` / `error` 事件带 `traceId`，`SessionView.traceIds` 保留最近 20 条（倒序），审计条目也带 `traceId`。
- **事件模型**：`traces` 一行一轮（`status` / `startedAt` / `finishedAt` / `error`）；`trace_events` 按
  `(trace_id, seq)` 唯一，`kind` 是 `llm` / `tool` / `skill` / `mcp` / `approval`，带 `ok` / `ms` / `name` /
  `payload`（工具参数摘要 ≤200 字）。MCP 工具除 `tool` 事件外再记一条 `mcp` 事件（服务名）。
- **flush 策略**：采集只写内存队列，**每 200ms 批量落库**（队列到 200 条提前刷；SQLite 单事务、PG 单语句，
  `(trace_id, seq)` 唯一索引保证重试幂等）；写失败重试 1 次后整批丢弃并计数，**绝不阻断对话**。
  查询接口先 flush 再查，刚结束的一轮立刻可见。
- **接口**：`GET /api/monitor/summary?range=24h`（会话 / 消息 / 工具成功率 / 平均与 p95 / 技能 / MCP / 模型 / 错误数）、
  `GET /api/monitor/traces?limit&offset&sessionId`、`GET /api/monitor/traces/:id`（trace + 事件时间轴）。
- **`/api/audit` 过滤增强**：新增 `actorType` / `targetType` / `from` / `to` / `q`（`from`/`to` 支持毫秒时间戳
  或 ISO 字符串，非法 → 400），出参仍是 `{ total, limit, offset, items }`。
- **权限**：`summary` 要 `session.read`（四种角色都能看首页）；`traces` 走 `audit.read`（运营 403）；
  **developer 只能看自己创建的会话的调用链**（`PersistedSession.createdBy`，按 sessionId 过滤或看详情都 403）。
- 控制台「监控」模块已接这三个接口（KPI 卡 + 技能/MCP/模型分组 + 调用链列表与事件时间轴）。

---

## 会话持久化（SQLite / Postgres）

存储层在 `server/db/`：`openStore()` 工厂按环境选实现——有 `DATABASE_URL` 走 **Postgres**，否则走
**SQLite**（`data/biz-agent.db`，Node 内置 `node:sqlite`，零第三方依赖、无需编译）。两种后端是**同一套 DAO**，
业务代码只改 import/类型名，换库不改逻辑。

| 存了什么 | 效果 |
|---|---|
| 对话文本 + 审计流水 | 重启后历史对话、每次工具调用成败都在 |
| **自定义标题** | **改过的会话名重启后仍在，不会退回按首条消息派生** |
| **归档状态** | **归档过的会话重启后仍在归档区；发新消息会自动取消归档并落库** |
| 流程进度（第几步、做过哪些调用） | 进度条不会归零 |
| 业务数据（工单/订单/审批单/通知） | 改过的数据重启还在 |
| **自定义流程定义** | **控制台新建/改过的技能（= 自定义流程）重启后仍在**（内置流程仍写在代码里） |
| **Pi 的 AgentMessage 上下文** | **重启后能接着聊，模型记得前文** |

验证方式（先进程内跑一轮，再重启服务，再追问）：

```bash
npm run persist-check -- --write          # 记下输出的 SESSION_ID
# 停掉服务，重新 npm run dev
npm run persist-check -- --read <SESSION_ID> --continue
```

实测结果：追问「刚才那条工单是哪个客户的？」→ 直接答「云图科技」，
**没有调用任何工具** —— 说明上下文是从存储恢复的（脚本会打印「从存储恢复: 是」），不是重新查的。
同一套命令对 SQLite 与 Postgres 都成立：配了 `DATABASE_URL` 就自动打 PG，措辞不再写死 SQLite。

存储结构（SQLite 内建 **17 张表**，全部在 `DB_PATH` 同一个库文件里；`npm run db:check` 实测表清单）：

- `sessions`：元数据（id / workflow_id / 时间 / 是否完成）做成可查询列，完整会话序列化为 `payload` JSON。
  这样既能按时间排序过滤，又不必维护六张关联表。P9 的 `createdBy` / `traceIds` 也在这个 payload 里。
- `workflows`：自定义流程定义（id / name / system_prompt / steps JSON / **skill JSON（技能文案）** / 创建更新时间）。
  内置流程不落库——它们仍是 `src/workflows/` 里的代码，`WorkflowRepo` 负责把两个来源合并成一份索引。
- `users` / `audit_logs`：P3 的成员与平台审计（`audit_logs` 记 actor / action / target / detail，
  写操作自动落库；P9 起可查 `trace_id`，支持 `actorType` / `targetType` / 时间范围 / 关键字过滤）。
- `knowledge_bases` / `kb_documents` / `kb_chunks` / `skill_kb_bindings`：P5 的知识库、文档、分块与技能绑定。
  SQLite 的表内建在 `server/kb/schema.ts`（向量存 JSON 文本列）；PG 的表在 `0001_init.sql`，向量列由
  `0007_kb_pgvector.sql` 改成无维度 `vector`（pgvector 检索，见「知识库」章节）。
- `model_providers` / `models`：P6 的供应商与模型两层；`api_key_encrypted` 存 AES-256-GCM 密文，永不存明文。
- `api_keys`：P4 的开放 API Key（`prefix` + `key_hash`（sha256） + 角色 / 限额 / 停用 / 吊销时间 / 最近使用）。
- `mcp_servers` / `mcp_tools`：P7 的 MCP 服务配置（传输、命令/地址、headers/env、`last_status` / `last_error`）
  与发现到的工具（原始名 + `input_schema` + 启停）。
- `traces` / `trace_events`：P9 的调用链与事件（`(trace_id, seq)` 唯一索引），无 TTL、不会自动清理。
- `im_bots` / `im_sessions`：P8 IM Bot 网关的机器人与"群会话 → 内部会话"映射（接口与控制台页面都已接入）。

Postgres 路径（P2）：

- `docker-compose.yml` 拉起 `pgvector/pgvector:pg16`：宿主端口 **5433**（避开本机 5432），库/用户/密码都是
  `biz`，数据卷在 `data/pg`；应用本身仍在本机 `npm run dev`，不打包进镜像。
- 五步切到 PG：`docker compose up -d` → 设 `DATABASE_URL=postgres://biz:biz@127.0.0.1:5433/biz` →
  `npm run db:migrate`（建表）→ `npm run db:check`（确认后端是 postgres、表清单 **19 张**）→ `npm run dev`。
- `db/migrations/0001_init.sql`：`vector` + `pg_trgm` 扩展、共 17 张表（业务/预留表 16 张 + `schema_migrations`
  记账表；P2 的 `sessions`/`workflows` 在前，其余是 P3~P9 预留）、单文件一个事务、按 `schema_migrations`
  版本号幂等执行；`0002_auth.sql` 给 `audit_logs` 补平台动作列（actor/action/target/detail）、
  放开 `tool_name`/`ok` 的 NOT NULL，并给 `users.email` 加大小写不敏感唯一索引。
  之后每个阶段再加增量（都只服务 PG，DDL 幂等、可在已有库上重复执行）：

  | 迁移 | 内容 |
  |---|---|
  | `0003_models.sql` | P6 新建 `model_providers` / `models` 两张表（+ `idx_models_provider`），PG 表数到 19 |
  | `0004_mcp.sql` | P7 给 `mcp_servers` 补 `env` / `last_status` / `last_error` / `last_checked_at` 与三个索引（0001 已建两张 MCP 表，不重建） |
  | `0005_observability.sql` | P9 给 `trace_events` 补 `ok` / `ms` 列、加 `(trace_id, seq)` 唯一索引与三个查询索引，并加 `audit_logs` 的 `actor_type` / `target_type` 索引 |
  | `0006_im.sql` | P8 IM 机器人回调相关列与索引（`robot_code` / `aes_key_enc` / `last_callback_at` / `last_msg_id`）；后端与控制台页面都已接入 |
  | `0007_kb_pgvector.sql` | P5 收尾：`kb_chunks.embedding` 从 `vector(1024)` 改成无维度 `vector`（换 embedding 模型不再被维度卡死），删掉 HNSW 索引改精确余弦扫描；PG 知识库检索就此接上 |

  **迁移只服务 PG**——SQLite 表结构内建在 `server/db/sqlite.ts` 与 `server/kb/schema.ts`
  （`CREATE TABLE IF NOT EXISTS` + PRAGMA/ALTER 自愈），加表要两边都加。
- 启动日志多一行「会话库: SQLite（<路径>）/ Postgres（host:port/db）」，`GET /api/health` 的
  `storage: { kind, detail }` 同源；前端「设置」模块展示的就是它（只显示库文件名，不暴露绝对路径 / 口令）。
- **同步契约**：`Session` 构造里就落库、`SessionHub`/`WorkflowRepo` 全是同步链，所以 PG 侧用
  「工作线程 + `Atomics.wait` + `receiveMessageOnPort`」把异步 `pg` 转同步（`server/db/syncBridge.ts`）。
  代价是 PG 后端**每次存储调用都会阻塞主线程毫秒级**；单用户开发够用，高并发 / 多实例不在当前范围
  （那需要连接池 + 全异步改造）。别为了"性能"把 storage 层改成返回 Promise——上层一个都 await 不了。
- 只有 `DATABASE_URL` 存在时才加载 worker；依赖只有 `pg` + `@types/pg`。
- **知识库跟着 `DATABASE_URL` 走**：配了 PG 时 KB 四张表也在 PG 里，语义检索由 pgvector（`server/kb/pgStore.ts`）执行；
  没配时仍落 `DB_PATH` 的 SQLite 文件、向量在本地算余弦。启动日志会打一行 `[kb] 知识库存储后端：sqlite / postgres`。

改路径用 `DB_PATH`（SQLite）或 `DATABASE_URL`（Postgres）环境变量。


---

## 编码 Agent（CLI）

前面那些都是"配置面"：用页面管 Agent、知识库、技能。这一层是**执行面**——一个能在本地仓库里真正干活的编码 Agent，
形态对齐 Codex：cd 到项目里，说一句"把这个 bug 修了"，它自己读文件、改代码、跑测试。

```bash
npm run code                      # 在当前目录开工
npm run code -- --cwd ../别的仓库   # 换个工作目录
npm run code -- --model deepseek-v4-pro
npm run code -- --yes             # 跳过逐次审批（只在自己完全信任的任务里用）
```

**它复用平台的 core，不另写一套 agent 循环**：`createBusinessAgent`（Pi 的五个钩子）、`ToolRegistry`、
`permission.ts` 的风险审批、`audit.ts` 的留痕，全是业务侧同一套代码。差别只在工具集与系统提示：

| 工具 | 风险 | 干什么 |
|---|---|---|
| `fs_read` / `fs_list` / `fs_grep` / `fs_glob` | low | 读文件、列目录、按内容/文件名搜索 |
| `fs_write` | **high** | 写文件（覆盖或新建，自动建目录） |
| `shell_run` | **high** | 在**工作目录内**执行命令（跑测试、构建、git），120 秒超时 |
| `git_status` / `git_diff` | low | 看改动 |
| `git_commit` | **high** | 只提交已暂存的改动，**不自动 `git add`、不 push** |

三条安全边界是**硬实现**，不是靠提示词约束（`code:selftest` 逐条断言）：

1. **路径锁死在工作目录内**：`../` 和指向外部的绝对路径会被直接拒绝（`resolveInside`），写不出去；
2. **高风险逐次当场审批**：写文件、跑命令、提交都要按 `y` 才执行，拒绝就把拒绝原因回给模型（它绕不过去）；
3. **输出截断并标注**：单次结果超 2 万字符会截断并写明原始长度，不让一条 `ls` 撑爆上下文。

已知边界（如实写在这里，免得用起来才发现）：

- **不持久化会话**：`/clear` 清上下文，退出即丢；持久化在上面的 Web 会话里，不在 CLI；
- **没有沙箱进程隔离**：`shell_run` 在工作目录里跑，但命令本身能访问整台机器（它不 `cd` 出去而已）。
  真要强隔离得套容器，当前没做；
- **需要真实模型**：`LLM_DISABLE=1` 会直接报错退出——模拟模型演不了文件操作任务；
- **不做自动 `git add`**：提交前要自己 stage，这是有意的（避免把无关文件塞进 commit）。
## 快速开始

```bash
npm install
npm run dev              # Web 控制台 → http://127.0.0.1:4317（默认 SQLite）
npm run demo:ticket      # 切片 A（终端）
npm run demo:data        # 切片 B
npm run demo:approval    # 切片 C
npm run verify           # 边界能力自检（55 项）
npm run ui-check         # 前端渲染单测（markdown，node:vm 沙盒，14 项）
npm run ui-dom-check     # 控制台接线自检（自造迷你 DOM 跑 app.js，不引 jsdom，268 项）
npm run web:build        # 新前端（client/，Vue 3 + Naive UI + Vite）构建到 client/dist
npm run web:dev          # 新前端开发服务器 5173（/api 与 /v1 代理到 4317）
npm run ui:e2e           # 新前端端到端（Playwright 真实浏览器，18 组；需服务在跑 + 已 web:build）
npm run agents:selftest  # Agent 实体自检（六维配置/状态机全路径/已发布锁定/参数钳制，40 项）
npm run code               # 编码 Agent（CLI）：cd 到任意仓库用，直接读写文件、跑命令、提交（见下文）
npm run code:selftest      # 编码 Agent 自检（工具 / 路径越界 / 审批钩子 / 装配，25 项，不起服务）
npm run kb:selftest      # 知识库自检（解析/分块/检索/绑定/工具/重新向量化/向量配置来源，66 项，SQLite 本地）
npm run kb:pg:selftest   # 知识库 Postgres/pgvector 自检（16 项；需 DATABASE_URL + 已跑 db:migrate，没配就跳过）
npm run auth:selftest    # 安全自检（scrypt/JWT/RBAC/限流/审计/成员保护，41 项）
npm run models:selftest  # 多模型自检（AES-256-GCM/掩码/密文解不开/首启 default/ping，23 项）
npm run mcp:selftest     # MCP 自检（stdio/HTTP/SSE、命名、超时与关闭，30 项）
npm run obs:selftest     # 可观测自检（trace_id/内存队列/批量落库/聚合/保留期清理，24 项）
npm run smoke            # 端到端冒烟（需先跑 npm run dev，204 项）
npm run smoke:agents     # Agent 端到端 HTTP（建号→状态机→锁定→删除，14 项；需先跑 npm run dev）
npm run smoke:auth       # 鉴权端到端（需 AUTH_MODE=required 实例，51 项）
npm run smoke:openapi    # 开放 API + 多模型端到端（需 AUTH_MODE=required 实例，53 项）
npm run smoke:mcp        # MCP 端到端（模拟模型实例即可，45 项）
npm run smoke:monitor    # 监控端到端（需 AUTH_MODE=required 实例，61 项）
npm run wecom:selftest   # 企业微信加密回调、本机 HTTP 与注入发送自检（43 项，不联网）
npm run smoke:wecom     # 完整服务企业微信收发验证（SMOKE_IM_BASE 指向 fake 隔离服务）
npm run im:selftest      # IM Bot 自检（加签/AES/幂等/映射/出站，26 项，P8）
npm run smoke:im         # IM 端到端（需 DINGTALK_TRANSPORT=fake 实例，37 项，P8）
npm run persist-check -- --write   # 会话持久化验证
npm run typecheck        # 类型检查
npm run db:migrate       # 仅 Postgres：建表 / 跑迁移（SQLite 不需要）
npm run db:check         # 看当前存储后端：类型 / 位置 / 引擎版本 / 表清单 / 迁移 / 数据量
```

demo 默认用 Pi 内置的 **faux provider**（脚本化假模型），不花钱、不联网、结果可复现。

**跑 `smoke` / `persist-check` 前建议用模拟模型起服务**：`.env` 里配了真 key 时服务默认走真实模型，
断言会随模型输出漂移、结果不可复现。带上 `LLM_DISABLE=1` 强制模拟模型即可：

```powershell
$env:LLM_DISABLE="1"; npm run dev                       # 终端 1：模拟模型服务
npm run smoke                                           # 终端 2：端到端 204 项断言

# 想隔离数据、不动正式会话库（端口自选）
$env:LLM_DISABLE="1"; $env:PORT="4318"; $env:DB_PATH="$PWD\data\qa-smoke.db"; npm run dev
$env:SMOKE_BASE="http://127.0.0.1:4318"; npm run smoke
```

鉴权端到端要另起一个 `AUTH_MODE=required` 的实例（脚本会自己建运营/审计员账号）：

```powershell
$env:PORT="4319"; $env:AUTH_MODE="required"; $env:AUTH_BOOTSTRAP_PASSWORD="owner12345"
$env:LLM_DISABLE="1"; $env:DB_PATH="$PWD\data\qa-auth.db"; npm run dev
$env:SMOKE_AUTH_BASE="http://127.0.0.1:4319"; npm run smoke:auth   # 期望 51 项
```

开放 API / MCP / 监控各有自己的端到端脚本（都要独立实例，别打在 4317 的正式库上）：

```powershell
# 开放 API + 多模型（要 AUTH_MODE=required，脚本自己建运营账号；模型 key 用 SECRET_KEY 加密）
$env:PORT="4320"; $env:AUTH_MODE="required"; $env:AUTH_BOOTSTRAP_PASSWORD="owner12345"; $env:SECRET_KEY="qa-secret"
$env:LLM_DISABLE="1"; $env:DB_PATH="$PWD\data\qa-openapi.db"; npm run dev
$env:SMOKE_OPENAPI_BASE="http://127.0.0.1:4320"; npm run smoke:openapi   # 期望 53 项

# MCP（off 模式模拟实例即可；脚本自己起一个 stdio 假 MCP Server）
$env:PORT="4322"; $env:LLM_DISABLE="1"; $env:DB_PATH="$PWD\data\qa-mcp.db"; npm run dev
$env:SMOKE_MCP_BASE="http://127.0.0.1:4322"; npm run smoke:mcp           # 期望 45 项

# 监控（要 AUTH_MODE=required，才有 operator / auditor / developer 三种真实角色）
$env:PORT="4321"; $env:AUTH_MODE="required"; $env:AUTH_BOOTSTRAP_PASSWORD="owner12345"
$env:LLM_DISABLE="1"; $env:DB_PATH="$PWD\data\qa-monitor.db"; npm run dev
$env:SMOKE_MONITOR_BASE="http://127.0.0.1:4321"; npm run smoke:monitor   # 期望 61 项

# IM Bot（P8；用 fake 传输，不连钉钉）
$env:PORT="4323"; $env:DINGTALK_TRANSPORT="fake"; $env:LLM_DISABLE="1"
$env:DB_PATH="$PWD\data\qa-im.db"; npm run dev
$env:SMOKE_IM_BASE="http://127.0.0.1:4323"; npm run smoke:im            # 期望 37 项
```

### 切到 Postgres（可选）

不配 `DATABASE_URL` 就是 SQLite，功能完全一样；想跑 PG（P2 的双轨验证 / 为 RAG 的向量检索做准备）：

```powershell
docker compose up -d                                    # pgvector/pgvector:pg16，宿主 5433
$env:DATABASE_URL="postgres://biz:biz@127.0.0.1:5433/biz"
npm run db:migrate                                      # 建表（db/migrations/*.sql，按版本幂等）
npm run db:check                                        # 后端应是 postgres，表清单 19 张（0001 的 17 张 + 0003 的两张模型表）
$env:LLM_DISABLE="1"; npm run dev                       # 启动日志会打「会话库: Postgres（…）」
$env:SMOKE_BASE="http://127.0.0.1:4330"; npm run smoke   # 期望 204 项
```

`db:migrate` 会依次应用 `0001_init.sql`、`0002_auth.sql`；`db:check` 的「schema 迁移」段会打印已应用版本。
PG 后端每次存储调用都经同步桥阻塞主线程毫秒级——单用户开发够用，高并发 / 多实例不在当前范围。

Docker Desktop 没启动时跳过这一段即可（一切照旧走 SQLite）。

### 接真实模型（三步）

```bash
# 1. 复制配置模板
cp .env.example .env        # Windows: Copy-Item .env.example .env

# 2. 在 .env 里填 key（任选其一）
#    DEEPSEEK_API_KEY=sk-...
#    OPENAI_API_KEY=sk-...
#    MOONSHOT_API_KEY=... / ZAI_API_KEY=... / OPENROUTER_API_KEY=...

# 3. 验证 key 可用，然后重启服务
npm run check-model         # 会发一次极短请求，打印模型回复与耗时
npm run dev
```

支持的 key 会自动识别：`DEEPSEEK_API_KEY` / `OPENAI_API_KEY` / `MOONSHOT_API_KEY` /
`ZAI_API_KEY` / `OPENROUTER_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY`。

也可以完全自定义（中转、自建网关、Ollama、vLLM）：

```ini
LLM_PROVIDER=openai
LLM_MODEL=gpt-4o-mini
LLM_BASE_URL=https://your-gateway.example.com/v1
LLM_API_KEY=sk-xxx
```

配置后界面右上角徽章会从「模拟模型」变成真实的 `provider · model`。
没有 key 时自动回落到模拟模型，功能不中断。

**DeepSeek 默认用 `deepseek-flash`。** 便宜、够用，联调与测试都跑它。

但它的历史记录要看一眼：高峰期会持续返回 503（`Service is too busy`），单次响应可能 20 秒以上；
v4-pro 约 1~2 秒一次工具调用，一轮 4 步流程 15 秒内跑完。**正式演示或批量压测**时显式切回去：

```ini
LLM_MODEL=deepseek-v4-pro
```

（界面上也能切：「模型」页设为当前模型即可，但当前模型只存内存，重启回落默认值。）

传输层参数（可选）：

```ini
LLM_TIMEOUT_MS=120000    # 单次请求超时，默认 120 秒
LLM_MAX_RETRIES=3        # 限流/过载重试次数，默认 3
```

---

## 核心设计：Pi 的五个钩子，各管一件事

Pi 的 `Agent` 只提供机制，不提供策略。企业场景需要的五件事全部挂在这五个钩子上：

| Pi 钩子 | 平台能力 | 实现 |
|---|---|---|
| `AgentTool[]` | 业务能力注册 | `core/registry.ts` |
| `beforeToolCall` | 权限校验 + 人工审批 | `core/permission.ts` |
| `afterToolCall` | 审计留痕 + 结果截断 | `core/audit.ts` |
| `transformContext` | 上下文滑动窗口压缩 | `core/context.ts` |
| `finishTurn` + `prepareNextTurnWithContext` | 流程状态机推进 | `core/workflow.ts` |

`core/runtime.ts` 是**唯一**接触 Pi 具体 API 的文件，其余都是纯业务代码。换掉 Pi 只需重写这一个文件。

---

## 目录结构

```
biz-agent/
├── src/
│   ├── core/
│   │   ├── types.ts       业务层类型（WorkflowDef / ToolDef / BizContext）
│   │   ├── registry.ts    工具注册表：业务能力 → AgentTool
│   │   ├── permission.ts  beforeToolCall：RBAC + 审批
│   │   ├── audit.ts       afterToolCall：审计 + 结果截断
│   │   ├── context.ts     transformContext：滑动窗口压缩
│   │   ├── workflow.ts    流程状态机
│   │   ├── catalog.ts     工具目录：内置工具 → 可被自定义流程按名字挑选
│   │   ├── workflowSpec.ts 自定义流程校验（长度/步骤/via/重名，前后端共用）
│   │   ├── flowTools.ts   流程即工具：flow_<id> 命名、参数与描述
│   │   ├── subFlow.ts     子流程执行（flow_xxx 内部起子 agent，不递归）
│   │   ├── skill.ts       技能：流程 → 作业指导书（渐进式披露、use_skill 参数）
│   │   └── runtime.ts     装配：配置 → Pi Agent
│   ├── store/memory.ts    内存业务数据（真实项目换 DB/内部 API）
│   ├── tools/             三个切片的业务工具（= /api/tools 的工具目录来源）
│   ├── workflows/         内置流程定义：三个切片 + index.ts 里的 autoWorkflow
│   │                      （workflowList + builtinToolFactories 是唯一真相）
│   └── index.ts           对外出口
├── server/                Web 服务（node:http + SSE，零框架）
│   ├── index.ts           路由与静态资源：`/v1/*`（开放 API，静态分支之前）→ 静态 → 鉴权守卫 → im → auth → monitor → kb → models → apiKeys → mcp → 其余 API（含 `/api/approvals*`）
│   ├── session.ts         会话管理、事件翻译、审批挂起与全局待办（`approvalMeta` / `pendingApprovalViews` / `pendingApprovals`）、flow_xxx 装配、技能加载/退出、kb_search、MCP 工具并入、trace 打点（traceIds/createdBy）
│   ├── workflows.ts       运行时流程仓库：内置（代码）+ 自定义（存储层）合并成索引（含技能文案）
│   ├── auth/              企业安全（P3）：scrypt 口令、HS256 JWT、四角色权限矩阵、登录限流、审计与成员接口（含 PATCH/DELETE 成员写接口）
│   ├── kb/                知识库（P5）：两种 DAO 后端（store.ts=SQLite JSON 向量 / pgStore.ts=PG pgvector）、解析/分块/向量化/检索/技能绑定/会话级 kb_search 工具
│   ├── models/            多模型管理（P6）：AES-256-GCM 加解密（crypto.ts）、供应商/模型 DAO、运行时与 ping（service.ts）、/api/models*
│   ├── apiKeys/           开放 API 的 Key（P4）：`bk_` 生成 + sha256 落库 + 令牌桶限流 + /api/api-keys*
│   ├── openapi/           开放 API（P4）：/v1/chat（非流式 + SSE）、/v1/health、统一错误与审计
│   ├── mcp/               MCP 集成（P7）：手写 JSON-RPC 客户端（client.ts）、注册表（registry.ts）、命名（names.ts）、/api/mcp*
│   ├── observability/     监控与可观测（P9）：trace_id/纯函数（trace.ts）、内存队列 + 批量 flush（collector.ts）、/api/monitor*
│   ├── im/                IM Bot 网关（P8）：钉钉回调/加签、凭证 AES、会话映射、fake outbox、/api/im*
│   ├── db/                存储层（openStore 工厂：DATABASE_URL → Postgres，否则 SQLite）
│   │   ├── types.ts       DAO 接口（与旧 SessionDb 方法签名逐条一致；P4~P9 的 Key/模型/MCP/调用链也在这层；成员写接口用 `updateUser` / `deleteUser`）
│   │   ├── sqlite.ts      SQLite 实现（node:sqlite；建表内建 + PRAGMA/ALTER 补列自愈）
│   │   ├── postgres.ts    Postgres 实现（pg 连接池，经同步桥调用）
│   │   ├── postgresWorker.ts  工作线程：跑异步 pg，主线程靠 Atomics.wait 取结果
│   │   ├── syncBridge.ts  同步桥：异步 → 同步（receiveMessageOnPort）
│   │   ├── migrations.ts  迁移执行器（读 db/migrations/*.sql，事务 + schema_migrations 记账）
│   │   └── index.ts       openStore() 工厂与对外导出
│   └── demoScripts.ts     模拟模型（无 key 时按流程演出）
├── db/migrations/         Postgres 迁移（0001_init.sql：vector + pg_trgm、17 张表；0002_auth.sql：审计列/邮箱索引；
│                          0003_models.sql：供应商/模型表；0004_mcp.sql：MCP 运行时列/索引；0005_observability.sql：事件列/唯一索引/审计索引；
│                          0006_im.sql：IM 回调列/索引；0007_kb_pgvector.sql：KB 向量列去维度 + 去 HNSW）；SQLite 不跑
├── web/                   控制台前端（原生 JS，无构建）
│   ├── index.html
│   ├── style.css
│   ├── app.js             页面逻辑：登录页、模块导航、三列对话布局、SSE、审批（内联卡片 + 跨会话待办轮询）、知识库、技能面板/编辑器、置顶、归档；
│   │                      模块页：知识库 / 模型 / MCP / IM 机器人 / 审批 / 成员（含改角色/停用/删除）/ 审计 / 设置（含 API Key）/ 监控
│   └── markdown.js        纯函数：markdown → HTML（表格/代码块/链接白名单，先转义再套标签）
├── examples/              终端 demo
└── scripts/
    ├── selftest.ts        边界能力自检（55 项）
    ├── kb-selftest.ts     知识库自检（66 项，SQLite 本地，解析/分块/检索/绑定/工具/重新向量化/向量配置来源，不起服务）
    ├── kb-pg-selftest.ts  知识库 Postgres/pgvector 自检（16 项，需 DATABASE_URL + 迁移，没配就跳过）
    ├── auth-selftest.ts   安全自检（41 项，scrypt/JWT/RBAC/限流/审计/成员保护，不起服务）
    ├── models-selftest.ts 多模型自检（24 项，AES-256-GCM/掩码/首启 default/ping，不起服务）
    ├── mcp-selftest.ts    MCP 自检（30 项，stdio/HTTP/SSE 传输、命名、超时/关闭，不起服务）
    ├── observability-selftest.ts  可观测自检（24 项，trace_id/队列/批量落库/聚合/保留期清理，不起服务）
    ├── ui-check.mjs       前端渲染单测（14 项，node:vm 加载 web/markdown.js）
    ├── ui-dom-check.mjs   控制台 DOM 桩自检（268 项，自造迷你 DOM，不起服务、不引 jsdom）
    ├── ui-shot.mjs        观感核对：用本机 Edge/Chrome 无头截图（不联网、不装依赖，可选）
    ├── db-migrate.ts      Postgres 迁移（npm run db:migrate，打印版本）
    ├── db-check.ts        存储后端体检（npm run db:check：类型/位置/引擎/表/迁移/数据量）
    ├── fixtures/mcp-stdio-server.mjs  冒烟/自检用的假 MCP Server（stdio，零依赖）
    ├── smoke.ts           端到端冒烟（204 项，走真实 HTTP+SSE，含知识库场景 G / G2 与审批中心场景 H）
    ├── smoke-auth.ts      鉴权端到端（51 项，要 AUTH_MODE=required 实例）
    ├── smoke-openapi.ts   开放 API + 多模型端到端（53 项，要 AUTH_MODE=required 实例）
    ├── smoke-mcp.ts       MCP 端到端（45 项，起假 MCP Server，模拟模型实例即可）
    ├── smoke-monitor.ts   监控端到端（61 项，要 AUTH_MODE=required 实例）
    ├── im-selftest.ts     IM Bot 自检（26 项，加签/AES/幂等/映射/出站，不起服务）
    └── smoke-im.ts        IM 端到端（37 项，要 DINGTALK_TRANSPORT=fake 实例）
```

---

## 新增一个业务流程

两条路径，按"要不要改代码"选。

### 路径 ①：界面新建技能（运行时，不改代码、不重启）

右栏技能面板顶部的「＋」打开技能编辑器：

1. 填**技能名称**（≤40 字）与**系统提示**（≤4000 字，写清角色与业务规则）；
2. 写**技能一句话说明**（≤200 字，技能列表/技能目录里露出的那句）与**技能正文**（≤4000 字，加载后进上下文）；
   两段都可选，两段都不填也能当技能用（正文回落系统提示、描述走兜底句式）；
3. 「添加步骤」1–10 步：每步写标题（≤40 字）、可选的步骤提示（≤200 字），
   再从工具目录里勾选这一步可用的工具（`via`，每步 1–8 个）。工具目录就是 `GET /api/tools`，
   也就是代码里注册过的全部业务工具，按分类分组展示；
4. 保存。后端会按同一套规则再校验一遍（`src/core/workflowSpec.ts`），不合法直接 400 并给出人话错误。

保存后它立刻出现在右栏技能面板（底层是 `POST /api/workflows`，定义存在存储层的 `workflows` 表里，重启不丢）；
它还会自动获得一个 `flow_<id>` 工具，别的会话里模型也能挑它整条跑完。
内置技能只读（`builtin=true`，PATCH / DELETE 返回 403），想改内置流程得走路径 ②。

> 自定义流程只能**编排**已有工具，不能新增业务能力——副作用永远只存在于代码里。

### 路径 ②：代码内置（随代码发布）

**1. 写工具**（`src/tools/xxx.ts`）

```ts
export function createFooTools(store: Store): ToolDef[] {
	return [{
		name: "foo_do_something",
		description: "做什么，什么时候该调用",
		category: "业务域",
		risk: "medium",          // low | medium | high，high 会触发人工审批
		parameters: {            // JSON Schema，直接给 function calling 用
			type: "object",
			properties: { id: { type: "string", description: "业务 ID" } },
			required: ["id"],
		},
		example: { id: "ID-1" }, // 可选：无 key 时模拟模型拿它演流程；有必填参数才需要
		execute: async (args, ctx) => {
			// ctx.tenantId / ctx.userId / ctx.traceId 已绑定，天然多租户隔离
			return { content: "结果文本（给模型看）" };
		},
	}];
}
```

**2. 写流程**（`src/workflows/xxx.ts`）—— 流程自带工具装配

```ts
export const fooWorkflow: WorkflowDef = {
	id: "foo-flow",
	name: "某某流程",
	systemPrompt: "角色设定 + 业务规则",
	createTools: createFooTools,   // ← 关键：流程自己声明用哪些工具
	steps: [
		{ id: "step1", title: "第一步", via: ["foo_do_something"], hint: "给模型的步骤提示" },
	],
};
```

**3. 注册**（`src/workflows/index.ts`）

```ts
// 技能清单：右栏技能面板的展示顺序
export const workflowList: WorkflowDef[] = [ticketWorkflow, dataWorkflow, approvalWorkflow, fooWorkflow];
// 工具目录：自定义流程只能在这里按名字挑工具，新增工具别忘了加进来
export const builtinToolFactories: ToolFactory[] = [
	createTicketTools, createDataTools, createApprovalTools, createFooTools,
];
```

完事。**右栏技能面板自动多出这一项，工具自动装配，模拟模型自动按 `example` 演一遍**——
`server/` 和 `src/core/` 一行都不用改（`npm run verify` 里有专门的检查守着这个约定：
步骤引用的工具必须由流程自己的 `createTools` 装配、有必填参数的工具必须给 `example`）。

想脱离平台单独跑某个流程（不给控制台用）也可以：

```ts
const registry = new ToolRegistry().registerAll(fooWorkflow.createTools(store));
const agent = createBusinessAgent({ workflow: fooWorkflow, registry, ctx, model, streamFn });
await agent.agent.prompt("用户的自然语言请求");
```

---

## 关键设计决策

**为什么用 `pi-agent-core` 而不是 `pi-coding-agent`？**
后者自带文件/shell 工具和编码场景的系统提示，做业务流程 agent 反而是负担。前者只给 `Agent` 循环，工具、权限、流程全部自己定。

**为什么流程状态机放在代码里，而不是让模型自己记？**
模型会跳步、会漏步、会重复。`WorkflowEngine` 根据"哪个工具成功执行过"来判定步骤完成，模型只管调用工具，**流程推进权在代码手里**。模型停早了，`finishTurn` 返回 `continue` 并注入下一步提示；全部走完才放行收尾。

**为什么工具结果要截断？**
一次大查询就能撑爆上下文窗口，模型会开始丢指令、答非所问。所以在 `afterToolCall` 里统一截到
4000 字符，并在末尾标注原始长度，让模型知道结果被截断过。

**权限为什么必须自己写？**
Pi 官方 README 明确写了：不提供文件系统/进程/网络/凭据的权限系统，默认以启动用户的权限运行。企业场景这块必须自建。

**为什么流程定义里带 `createTools`，而不是在 server 里按 id 分派工具？**
早期是 `switch (workflowId)` 硬编码，结果是"加一条业务流"要改四处：流程文件、server 的映射表、server 的 switch、
模拟模型脚本——README 写着"注册即可"，实际做不到。现在改由流程自带工具装配函数，
`src/workflows/index.ts` 的 `workflowList` 成了唯一真相：列表里加一项，右栏技能面板、工具注册、
模拟演示全部自动跟上。`npm run verify` 里有两条检查守着这个约定（步骤里引用的工具必须由流程自己装配；
有必填参数的工具必须给 `example` 演示参数）。

**为什么把流程也包成工具（`flow_<id>`）？**
真实场景里用户常常上来就用自然语言描述需求，不知道"该选哪条流程"——所以控制台干脆不暴露流程选择。
但"人决定"仍然有价值，于是每条流程再暴露成一个工具：会话里模型可以直接挑一条整条跑完——内部起子 agent，
**只装目标流程自己的工具**（不装流程工具，天然不递归），`task` 参数就是用户原话。
两种用法并存：右栏技能面板点一条技能 = 人决定；模型调 `flow_xxx` = 模型决定。
会话视图的 `tools` 字段能看到本次会话装了哪些工具（含别的流程）。

**为什么自定义流程只存"编排"，不存代码？**
自定义流程的定义里只有 `name / systemPrompt / steps[{title, via}]`，`via` 只是工具名——真正干活的工具全在
`src/tools/*`。这样运行时的流程数据不会带来任何新的副作用面（没人能往数据库里塞一段代码就获得读文件的能力），
权限、审计、审批仍然统一起作用在工具层。

**为什么存储层是"同步 DAO + 两种实现"，而不是全面 async？**
`Session` 构造里就落库、`SessionHub`/`WorkflowRepo` 全是同步链，DAO 一旦变成 Promise，整条链路
（构造、事件、`repo.reload()`）都得异步化，波及面巨大。P2 的选择是**接口保持同步、实现按后端切换**：
SQLite 天生同步；Postgres 用「工作线程跑异步 `pg` + 主线程 `Atomics.wait` 阻塞等结果 + `receiveMessageOnPort`
取回数据」把它包成同步（`server/db/syncBridge.ts`）。代价是 PG 后端每次存储调用阻塞主线程毫秒级，
换来业务代码零改动、两种后端用同一套 `smoke` / `persist-check` 验证。

**为什么迁移只服务 Postgres？**
`db/migrations/*.sql` 里用的是 PG 方言（`vector` 扩展、`gin` / `hnsw` 索引、`to_tsvector`），SQLite 没有对应能力。
SQLite 的表结构继续内建在 `server/db/sqlite.ts`，知识库的四张表在 `server/kb/schema.ts`，老库缺列靠 PRAGMA + ALTER 自愈
（见 AGENTS 坑 19 / 23 / 24）。反过来，PG 的知识库表全部由迁移建（`0001` + `0007`），
`server/kb/pgStore.ts` 只查询不建表。所以加表/改列要两边都加，迁移不是"两边通用"的机制。

---

## 已知限制

- **业务数据仍是模拟的**：`store/memory.ts` 里是写死的工单/订单种子数据，工具只改内存对象，
  没有对接真实工单系统或数据库。持久化只保证"重启不丢"，不保证数据真实。
- **流程没有版本化 / 回滚**：编辑流程是原地覆盖（`workflows.updated_at`），改坏了只能凭记忆改回去；
  也没有导入导出、变更审批。要做需要加流程版本表。
- **内置流程不可改**：四条内置流程（自动编排 + 三个切片）写死在代码里（`builtin=true`），右栏面板里只能
  「查看技能」，想改行为得改代码发版。自定义流程可以照它的样子重新建一条，但内置的那几条不会消失。
- **自动编排离不开真模型**：那条流程没有写死步骤，完全靠模型判断该用哪些工具、该挑哪条流程；
  模拟模型（无 key）只会回一段说明。它也不是"万能"：判断失误时照样会挑错流程，需要人纠一句。
- **自定义流程只能编排已有工具**：界面不能新增业务能力（工具必须在 `src/tools/*` 里写）。
  它引用的工具如果之后被删掉，该流程会在列表里标 `error` 并拒绝建会话，需要在技能面板里改掉；
  自定义流程数量上限 50（防控制台被灌爆）。
- **模拟模型不会自己挑流程**：无 key 时它只按当前流程的 `engine.currentStep.via[0]` 演，
  所以「流程即工具」的执行路径由 `npm run verify` 里的 `runSubWorkflow` 断言覆盖；
  `smoke` 只断言会话工具列表里出现了其他流程的 `flow_*` 且不含自身。想演示 B 需要配真实模型。
- **markdown 是自写的极小实现**：`web/markdown.js` 只覆盖模型常见输出（标题/列表/表格/围栏代码块/引用/行内语法），
  不是完整 CommonMark（嵌套列表、HTML 块、脚注等不支持）——换来零依赖、零构建，语法不够时先补 `ui-check` 的断言。
- **技能要靠模型自己加载**：无 key 时模拟模型只按 `currentStep.via[0]` 演，不会主动调 `use_skill`；
  想演示"模型自己挑技能"得配真实模型。控制台在右栏技能面板点一条（或直接打 `POST /api/sessions/:id/skills`）可以随时手工加载/退出。
  另外技能正文会占上下文，步骤越多越长——这正是它和 `flow_*` 委托执行的分工。
- **默认单机 SQLite**：不配 `DATABASE_URL` 时存储层就是本地单文件（会话 / 技能 / 成员 / 审计 / 知识库 / 模型 / API Key /
  MCP / 调用链都在里面），部署多实例要切 Postgres。PG 路径已通（P2），但有边界：**Docker 镜像本身没在真实库上跑过**
  （本机 Docker Desktop 起不来；迁移 `0001`~`0007`、`db:check`、`smoke`、`persist-check`、pgvector 检索是用
  PGlite（真 PostgreSQL 18.6 WASM + pgvector 扩展）跑通的，`docker-compose.yml` 里的镜像未实机）；
  PG 后端每次存储调用会阻塞主线程毫秒级（同步桥），高并发 / 多实例不在当前范围。知识库在 PG 后端同样落 PG 表，
  语义检索走 pgvector（见「知识库」章节）。
- **当前模型选择不持久化**：`/api/models/current` 只改进程内存，重启后回落到第一条可用的 `chat` 模型；
  想固定默认模型得改 `.env`（或首启自动建的 `default` 供应商）。
- **MCP 工具默认 `high` 风险**：平台的 `RiskLevel` 只有 low/medium/high（没有 `write`），而审批只在 `high` 触发——
  所以每个 MCP 工具调用都会弹审批卡片；想让只读 MCP 工具免审批，得先扩 RiskLevel 语义并同步 `permission.ts`。
- **OpenAPI 建的会话没有 `ownerId`**：`/v1/chat` 自动新开的会话 `createdBy` 为空，
  developer 在监控页按"只看自己创建的会话"过滤时**看不到这些调用链**（owner / auditor 不受影响）。
- **调用链按保留期自动清理**：默认保留 30 天（启动先清一次、之后每小时清一次），用 `TRACE_RETENTION_DAYS` 调
  （0 = 永不清理）；清理失败只打日志、不影响对话。要长期归档请自己接外部存储（清理后数据不可恢复）。
- **审批中心只有"当前挂起"**：`GET /api/approvals` 读的是内存里 `pendingApprovals` 的 Promise 与 `approvalMeta`，
  进程重启后待办全部消失；**没有审批历史表**，不能当历史审批查询用（审计里只有通用写操作记录）。
- **审批是同步回调**：真实审批要走外部审批系统，需要异步挂起/恢复机制，`beforeToolCall` 的同步语义要改造；
  审批中心只是这层同步语义的全局视图。
- **成员保护规则只在服务层**：不能改自己、必须保留一个启用所有者、停用后令牌失效，都靠 `AuthService` 与
  guard 回表实现，数据库没有约束；直接改库或并发请求绕过接口不受保护。
- **Node 版本**：Pi 要求 ≥22.19.0，本机是 22.18.0，实测可运行但 npm 会警告，建议升级。
