/**
 * 平台对外出口。
 *
 * `createBusinessRuntime` builds business policy; the host uses Pi adapters for agents and sessions.
 */

export { buildBusinessSystemPrompt, createBusinessRuntime } from "./core/runtime.js";
export type { BusinessRuntime, CreateBusinessRuntimeOptions } from "./core/runtime.js";
export { ToolRegistry } from "./core/registry.js";
export { WorkflowEngine } from "./core/workflow.js";
export { createWorkflowTurnPolicy } from "./core/workflowPolicy.js";
export { createPermissionPolicy } from "./core/permission.js";
export { createAuditPolicy, MAX_RESULT_CHARS } from "./core/audit.js";
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
export { runSubWorkflow } from "./core/subFlow.js";
export type { SubFlowOptions, SubFlowResult } from "./core/subFlow.js";
