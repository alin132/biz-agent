/**
 * 企业工作流对 Pi Agent Core 原生 turn 生命周期钩子的策略适配。
 *
 * Pi 拥有模型循环；该模块只决定业务流程何时继续、如何推进步骤以及何时停止工具。
 */

import { WorkflowEngine } from "./workflow.js";

export interface WorkflowToolResult {
	toolName: string;
	isError?: boolean;
}

export function createWorkflowTurnPolicy(engine: WorkflowEngine, maxTurns: number) {
	let turns = 0;
	let lastTurnHadError = false;
	let limitReached = false;
	return {
		startRun: () => { turns = 0; lastTurnHadError = false; limitReached = false; },
		finishTurn: (toolResults: WorkflowToolResult[]) => {
			for (const result of toolResults) engine.recordToolResult(result.toolName, !result.isError);
			const hasToolCalls = toolResults.length > 0;
			const hadError = toolResults.some((result) => result.isError);
			turns++;
			if (hasToolCalls && turns >= maxTurns) limitReached = true;
			const terminateTools = hasToolCalls && turns >= maxTurns;
			const shouldContinue = hasToolCalls
				? !terminateTools
				: !engine.done && !lastTurnHadError && !engine.lastCallOffTrack;
			lastTurnHadError = hadError;
			return { continue: shouldContinue, terminateTools, limitReached };
		},
		nextPrompt: () => engine.nextPrompt(),
		limitReached: () => limitReached,
	};
}
