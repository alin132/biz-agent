/**
 * 平台对外出口。
 *
 * 用法：
 *   const agent = createBusinessAgent({ workflow: ticketWorkflow, registry, ctx, model, streamFn });
 *   await agent.agent.prompt("处理一下支付回调超时的工单");
 */

export { createBusinessAgent, pipeTextToStdout } from "./core/runtime.js";
export type { BusinessAgent, CreateBusinessAgentOptions } from "./core/runtime.js";
export { ToolRegistry } from "./core/registry.js";
export { WorkflowEngine } from "./core/workflow.js";
export { createPermissionHook } from "./core/permission.js";
export { createAuditHook, MAX_RESULT_CHARS } from "./core/audit.js";
export { createContextTransformer } from "./core/context.js";
export type {
	AuditEntry,
	ApprovalRequest,
	BizContext,
	RiskLevel,
	ToolDef,
	ToolResult,
	WorkflowDef,
	WorkflowState,
	WorkflowStep,
} from "./core/types.js";

export { createStore } from "./store/memory.js";
export type { Store } from "./store/memory.js";

export { createTicketTools } from "./tools/ticket.js";
export { createDataTools } from "./tools/data.js";
export { createApprovalTools } from "./tools/approval.js";

export { ticketWorkflow } from "./workflows/ticket.js";
export { dataWorkflow } from "./workflows/data.js";
export { approvalWorkflow } from "./workflows/approval.js";
/** 平台内置流程列表、工具目录与 id 索引。 */
export { builtinToolFactories, indexWorkflows, workflowList } from "./workflows/index.js";

/** 运行时流程配置：工具目录 + 流程定义校验（控制台新建/编辑流程用）。 */
export { createToolCatalog } from "./core/catalog.js";
export type { ToolCatalog, ToolFactory, ToolSummary } from "./core/catalog.js";
export {
	mergeWorkflowInput,
	validateWorkflowInput,
	WORKFLOW_LIMITS,
	WorkflowSpecError,
} from "./core/workflowSpec.js";
export type { ValidateOptions, WorkflowInput } from "./core/workflowSpec.js";

/** 流程即工具：把一条流程当工具整条跑完。 */
export { flowToolDescription, flowToolName, flowToolParameters, isFlowToolName } from "./core/flowTools.js";
export { lastAssistantTextOf, runSubWorkflow } from "./core/subFlow.js";
export type { SubFlowOptions, SubFlowResult } from "./core/subFlow.js";
