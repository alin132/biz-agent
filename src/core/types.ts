/**
 * 业务层类型定义。
 *
 * 这一层刻意不依赖 Pi 的运行时类型：业务流程的"配置"应该能被序列化、存库、
 * 被管理后台编辑。只有 runtime.ts 负责把它翻译成 Pi 的 Agent。
 */

/** 工具风险等级，决定是否需要人工审批。 */
export type RiskLevel = "low" | "medium" | "high";

/** 一条工具调用审计记录。 */
export interface AuditEntry {
	traceId: string;
	tenantId: string;
	userId: string;
	toolName: string;
	args: Record<string, unknown>;
	ok: boolean;
	/** 工具返回的原始字符数。 */
	outputChars: number;
	/** 结果是否被截断（防止撑爆上下文）。 */
	truncated: boolean;
	at: number;
}

/** 人工审批请求。 */
export interface ApprovalRequest {
	traceId: string;
	tenantId: string;
	userId: string;
	toolName: string;
	args: Record<string, unknown>;
	risk: RiskLevel;
}

/**
 * 一次会话的业务上下文。
 *
 * 它被权限钩子、审计钩子、工具实现共同读取，是"租户隔离"在业务层的落点。
 */
export interface BizContext {
	tenantId: string;
	userId: string;
	traceId: string;
	/** 当前角色允许调用的工具名；`"*"` 表示全允许。 */
	allow: string[];
	/** 额外要求人工审批的工具名（高风险工具由 risk 自动推导，无需在此重复）。 */
	requireApproval: string[];
	/** 审计出口，默认不落地；生产环境接 pi-telemetry 或数据库。 */
	audit?: (entry: AuditEntry) => void;
	/** 审批出口；返回 true 表示放行。未提供时，需要审批的工具一律阻断。 */
	requestApproval?: (req: ApprovalRequest) => Promise<boolean>;
}

/** 业务工具的执行结果。 */
export interface ToolResult {
	/** 给模型看的文本结果。 */
	content: string;
	isError?: boolean;
}

/**
 * 一个业务能力。
 *
 * 这是平台"可配置"的关键：新增一个业务系统 = 注册一个 ToolDef，不改核心代码。
 */
export interface ToolDef {
	name: string;
	description: string;
	category: string;
	risk: RiskLevel;
	/** JSON Schema，直接作为 function calling 的 parameters。 */
	parameters: Record<string, unknown>;
	execute: (args: Record<string, unknown>, ctx: BizContext) => Promise<ToolResult>;
}

/** 流程中的一个步骤。 */
export interface WorkflowStep {
	id: string;
	title: string;
	/** 命中其中一个工具（且成功）即视为该步骤完成。 */
	via: string[];
	/** 进入该步骤时追加给模型的提示。 */
	hint: string;
}

/** 一个可配置的业务流程。 */
export interface WorkflowDef {
	id: string;
	name: string;
	systemPrompt: string;
	steps: WorkflowStep[];
}

/** 一次工具调用记录，用于驱动流程状态机。 */
export interface ToolCallRecord {
	name: string;
	ok: boolean;
}

/** 流程运行时状态。 */
export interface WorkflowState {
	workflowId: string;
	stepIndex: number;
	completed: string[];
	calls: ToolCallRecord[];
}
