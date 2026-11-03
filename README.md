# biz-agent

**通用业务流程 Agent 平台** —— 基于 [Pi](https://github.com/earendil-works/pi) 的 `pi-agent-core` 构建。

把"一个业务系统接入 AI"从写代码变成**注册工具 + 写流程定义**。新增业务流程不需要改核心层。

---

## 状态

三个垂直切片均已跑通（`npm run demo:*`），并配有一套 Web 控制台（`npm run dev`）：

| 切片 | 流程 | 说明 |
|---|---|---|
| **A 工单流转** | 查询 → 指派 → 改状态 → 通知 | 最典型的顺序写操作流 |
| **B 数据查询分析** | 探查结构 → 查明细 → 聚合 → 出报告 | 自然语言问数 |
| **C 审批流** | 规则校验 → 提交（高风险，需人工确认）→ 归档 | 权限钩子的典型用法 |

`npm run verify` 15 项边界检查、`npm run smoke` 14 项端到端检查全通过。

---

## Web 控制台

```bash
npm run dev          # 启动后打开 http://127.0.0.1:4317
```

界面形态参照 Codex 的三栏布局：

- **左栏**：流程列表 + 会话列表
- **中栏**：对话流。Agent 的文字**逐字流式输出**，每次工具调用渲染成一张卡片——
  工具名、入参、状态（运行中 / 完成 xx ms / 失败）、返回结果，全部可见
- **右栏**：流程进度（实时勾选步骤）+ 审计流水（每次调用的成败与截断标记）

高风险工具会弹出**审批卡片**，点「同意并继续」或「拒绝」，结果实时反映到流程状态。

没有 `DEEPSEEK_API_KEY` 时自动使用**模拟模型**：按流程定义逐步"演"一遍，
用于演示和回归；配置了 key 就切换成真实模型，代码不用改。

接口清单（`server/index.ts`）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/workflows` | 可选流程 |
| GET | `/api/models` | 当前模型 + 可用模型列表 |
| POST | `/api/sessions` | 创建会话 `{ workflowId, modelId? }` |
| GET | `/api/sessions` | 会话列表（含 SQLite 历史） |
| DELETE | `/api/sessions` | 清空全部会话 |
| GET | `/api/sessions/:id` | 会话快照（必要时从 SQLite 恢复） |
| DELETE | `/api/sessions/:id` | 删除会话 |
| GET | `/api/sessions/:id/events` | SSE 事件流 |
| POST | `/api/sessions/:id/messages` | 发送消息 |
| POST | `/api/sessions/:id/approve` | 审批决定 |
| POST | `/api/sessions/:id/permissions` | 权限模式 `full` / `readonly` |

服务端零框架依赖，只用 `node:http`；前端是原生 JS，**没有构建步骤**。

---

## 会话持久化（SQLite）

会话落盘到 `data/biz-agent.db`，用的是 Node 内置 `node:sqlite`，**零第三方依赖、无需编译**。

| 存了什么 | 效果 |
|---|---|
| 对话文本 + 审计流水 | 重启后历史对话、每次工具调用成败都在 |
| 流程进度（第几步、做过哪些调用） | 进度条不会归零 |
| 业务数据（工单/订单/审批单/通知） | 改过的数据重启还在 |
| **Pi 的 AgentMessage 上下文** | **重启后能接着聊，模型记得前文** |

验证方式（先进程内跑一轮，再重启服务，再追问）：

```bash
npm run persist-check -- --write          # 记下输出的 SESSION_ID
# 停掉服务，重新 npm run dev
npm run persist-check -- --read <SESSION_ID> --continue
```

实测结果：追问「刚才那条工单是哪个客户的？」→ 直接答「云图科技」，
**没有调用任何工具** —— 说明上下文是从数据库恢复的，不是重新查的。

存储结构：单表 `sessions`，元数据（id / workflow_id / 时间 / 是否完成）做成可查询列，
完整会话序列化为 `payload` JSON。这样既能按时间排序过滤，又不必维护六张关联表。
改路径用 `DB_PATH` 环境变量。


---

## 快速开始

```bash
npm install
npm run dev              # Web 控制台 → http://127.0.0.1:4317
npm run demo:ticket      # 切片 A（终端）
npm run demo:data        # 切片 B
npm run demo:approval    # 切片 C
npm run verify           # 边界能力自检
npm run smoke            # 端到端冒烟（需先跑 npm run dev）
npm run persist-check -- --write   # 会话持久化验证
npm run typecheck        # 类型检查
```

demo 默认用 Pi 内置的 **faux provider**（脚本化假模型），不花钱、不联网、结果可复现。

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

**DeepSeek 默认用 `deepseek-v4-pro`。** 实测 `deepseek-flash` 在高分期会持续返回
503（`Service is too busy`），且单次响应要 20 秒以上；v4-pro 约 1~2 秒一次工具调用，
一轮 4 步流程 15 秒内跑完。想省钱可以显式指定：

```ini
LLM_MODEL=deepseek-flash
```

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
│   │   └── runtime.ts     装配：配置 → Pi Agent
│   ├── store/memory.ts    内存业务数据（真实项目换 DB/内部 API）
│   ├── tools/             三个切片的业务工具
│   ├── workflows/         三个切片的流程定义
│   └── index.ts           对外出口
├── server/                Web 服务（node:http + SSE，零框架）
│   ├── index.ts           路由与静态资源
│   ├── session.ts         会话管理、事件翻译、审批挂起
│   └── demoScripts.ts     模拟模型（无 key 时按流程演出）
├── web/                   控制台前端（原生 JS，无构建）
│   ├── index.html
│   ├── style.css
│   └── app.js
├── examples/              终端 demo
└── scripts/
    ├── selftest.ts        边界能力自检（15 项）
    └── smoke.ts           端到端冒烟（14 项，走真实 HTTP+SSE）
```

---

## 新增一个业务流程：4 步

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
		execute: async (args, ctx) => {
			// ctx.tenantId / ctx.userId / ctx.traceId 已绑定，天然多租户隔离
			return { content: "结果文本（给模型看）" };
		},
	}];
}
```

**2. 写流程**（`src/workflows/xxx.ts`）

```ts
export const fooWorkflow: WorkflowDef = {
	id: "foo-flow",
	name: "某某流程",
	systemPrompt: "角色设定 + 业务规则",
	steps: [
		{ id: "step1", title: "第一步", via: ["foo_do_something"], hint: "给模型的步骤提示" },
	],
};
```

**3. 注册**（`src/index.ts` 导出即可）

**4. 跑**

```ts
const registry = new ToolRegistry().registerAll(createFooTools(store));
const agent = createBusinessAgent({ workflow: fooWorkflow, registry, ctx, model, streamFn });
await agent.agent.prompt("用户的自然语言请求");
```

核心层一行都不用改。

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

---

## 已知限制

- **业务数据仍是模拟的**：`store/memory.ts` 里是写死的工单/订单种子数据，工具只改内存对象，
  没有对接真实工单系统或数据库。持久化只保证"重启不丢"，不保证数据真实。
- **没有管理后台**：流程定义仍是 TypeScript 文件，没有可视化配置界面。
- **单机 SQLite**：会话库是本地单文件，多实例部署需要换成 PostgreSQL 之类的共享存储。
- **审批是同步回调**：真实审批要走外部审批系统，需要异步挂起/恢复机制，`beforeToolCall` 的同步语义要改造。
- **Node 版本**：Pi 要求 ≥22.19.0，本机是 22.18.0，实测可运行但 npm 会警告，建议升级。
