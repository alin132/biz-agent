/**
 * 会话级内置工具 `kb_search`：把「技能绑定的知识库」接给模型检索。
 *
 * 为什么放在 `server/kb/**` 而不是 `src/tools/*`：业务工具目录（`/api/tools`、技能编辑器）
 * 只认 `builtinToolFactories` 里的工具，那些工具都由流程自己声明；知识库检索要跟着
 * **当前会话加载的技能**走，属于会话能力，所以由 `server/session.ts` 直接注册。
 * 也正因为它不进业务工具目录，`/api/tools` 里看不到它，自定义流程的 `via` 也不能引用它。
 *
 * 技能 id 走 deps 注入（`getActiveSkillId`）而不是构造时的快照：换技能是运行期动作，
 * 工具必须在**调用那一刻**取当前技能，否则切完技能还在查上一条技能的库。
 * 顺带这也让 `server/kb/**` 不必反向 import 会话层，避免循环依赖。
 *
 * 一条硬约定：**查不到不是调用失败**。没绑定知识库、没有命中、知识库模块报错，
 * 都返回一句中文说明让模型照常回答并如实交代，而不是抛错把整轮对话打成失败。
 */

import type { ToolDef } from "../../src/core/types.js";
import { Type } from "typebox";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { errorMessage } from "./errors.js";
import { searchForContext } from "./index.js";
import { getKb } from "./runtime.js";
import type { SearchMode } from "./search.js";
import type { SkillSearchResponse } from "./service.js";

/** 工具名：会话层按这个名字注册与保留（换技能时也不丢）。 */
export const KB_SEARCH_TOOL_NAME = "kb_search";

/** 默认返回条数：够回答一个问题，又不至于把上下文塞满。 */
export const KB_SEARCH_DEFAULT_TOP_K = 5;

/** 工具层自留的上限（比 DAO 的 MAX_TOP_K 小：工具是给模型的，别让它一次拉 50 条）。 */
export const KB_SEARCH_MAX_TOP_K = 20;

/** 构造参数：只有「当前技能是谁」与「当前 Agent 绑了哪些库」要外部注入，其余用 kb 模块自己的单例。 */
export interface KbSearchToolDeps {
	/** 取当前会话正在跑的技能 id；没加载技能时可以返回 null / 空串（工具会给中文说明）。 */
	getActiveSkillId: () => string | null;
	/**
	 * 取绑定 Agent 声明的知识库 id（可选）。
	 *
	 * 与 getActiveSkillId 同理走注入、不在这里 import 会话层：kb 模块不能反向依赖 session。
	 * 不传或返回空数组 = 没有 Agent 绑定，检索落到「对话默认检索」。
	 */
	getAgentKbIds?: () => string[];
}

export interface KbSearchToolInput {
	query: string;
	topK?: number;
}

/** 条数归一：非数字（或 NaN/Infinity）回落默认值，其余就近取整后夹到 1..20。 */
function normalizeTopK(value: unknown): number {
	const numeric =
		typeof value === "number"
			? value
			: typeof value === "string" && value.trim().length > 0
				? Number(value)
				: Number.NaN;
	if (!Number.isFinite(numeric)) {
		return KB_SEARCH_DEFAULT_TOP_K;
	}
	return Math.min(KB_SEARCH_MAX_TOP_K, Math.max(1, Math.round(numeric)));
}

/** 检索模式的中文标注：结果末尾要如实说是怎么查到的，不能假装有向量。 */
function modeLabelOf(mode: SearchMode): string {
	if (mode === "vector") return "语义检索";
	if (mode === "hybrid") return "语义与关键词混合检索";
	return "关键词检索";
}

/** 结果里的 docId → 文件名（检索结果只带 id，展示需要人看得懂的名字）。 */
function filenameOf(docId: string): string {
	try {
		return getKb().store.getDocument(docId)?.filename ?? docId;
	} catch {
		// 查不到文件名不影响片段本身的价值：退回 id，让模型仍能引用来源
		return docId;
	}
}

/** 造一个会话级 `kb_search` 工具定义（不注册，注册由会话层做）。 */
export function createKbSearchTool(deps: KbSearchToolDeps): ToolDef {
	return {
		name: KB_SEARCH_TOOL_NAME,
		description: kbSearchDescription,
		category: "知识库",
		risk: "low",
		parameters: kbSearchParameters,
		example: { query: "退款多久到账", topK: KB_SEARCH_DEFAULT_TOP_K },
		execute: async (args) => ({ content: await executeKbSearch(deps, args as unknown as KbSearchToolInput) }),
	};
}

const kbSearchDescription =
	"检索知识库里的资料片段：用户问到产品手册、政策条款、客服话术这类内部资料时，先查这里再回答。" +
	"优先语义检索，不可用时自动回退关键词检索。" +
	"返回每条片段的稳定来源标记 [kb:<库ID> doc:<文档ID> chunk:<分块ID>]、来源文件名、标题与原文片段；回答引用资料时必须原样保留这个标记。" +
	"不需要先加载技能也能用：技能绑定了知识库就查技能的库，否则查「对话默认检索」的库。" +
	"没有可检索的库、或者没有命中时，会返回一句中文说明而不是报错。";

const kbSearchParameters = {
	type: "object",
	properties: {
		query: {
			type: "string",
			description: "要查的问题或关键词，直接用自然语言描述，例如「退款多久到账」",
		},
		topK: {
			type: "number",
			description: `最多返回几条片段，范围 1-${KB_SEARCH_MAX_TOP_K}，默认 ${KB_SEARCH_DEFAULT_TOP_K}`,
			minimum: 1,
			maximum: KB_SEARCH_MAX_TOP_K,
			default: KB_SEARCH_DEFAULT_TOP_K,
		},
	},
	required: ["query"],
	additionalProperties: false,
} as const;

const piKbSearchParameters = Type.Object({
	query: Type.String({ description: "要查的问题或关键词，直接用自然语言描述" }),
	topK: Type.Optional(Type.Number({ minimum: 1, maximum: KB_SEARCH_MAX_TOP_K, default: KB_SEARCH_DEFAULT_TOP_K })),
}, { additionalProperties: false });

/** Create a Pi-native extension that exposes the same search contract through ExtensionAPI. */
export function createKbPiExtension(deps: KbSearchToolDeps): (pi: ExtensionAPI) => void {
	return (pi) => {
		pi.registerTool(defineTool({
			name: KB_SEARCH_TOOL_NAME,
			label: "知识库检索",
			description: kbSearchDescription,
			promptSnippet: "检索业务知识库，并返回带来源的资料片段",
			promptGuidelines: ["用户咨询内部资料时使用 kb_search，并在回答中原样保留引用资料对应的 [kb:... doc:... chunk:...] 来源标记。"],
			parameters: piKbSearchParameters,
			annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
			async execute(_toolCallId, params) {
				return { content: [{ type: "text", text: await executeKbSearch(deps, params) }], details: undefined };
			},
		}));
	};
}

/** Shared execution path for the legacy business ToolDef and native Pi extension tool. */
export async function executeKbSearch(deps: KbSearchToolDeps, args: KbSearchToolInput): Promise<string> {
	const query = String(args.query ?? "").trim();
	if (query.length === 0) {
		return "检索词不能为空：请把要查的问题写具体一些，再调用 kb_search。";
	}
	const skillId = (deps.getActiveSkillId() ?? "").trim();
	const agentKbIds = deps.getAgentKbIds?.() ?? [];
	const scope = skillId.length > 0
		? `技能 ${skillId}`
		: agentKbIds.length > 0
			? `Agent 绑定（${agentKbIds.length} 个库）`
			: "对话默认知识库";
	const topK = normalizeTopK(args.topK);
	let response: SkillSearchResponse;
	try {
		response = await searchForContext(skillId.length > 0 ? skillId : null, query, topK, agentKbIds);
	} catch (error) {
		return `知识库检索失败（${scope}）：${errorMessage(error)}。可以先基于已有信息回答，并说明这次没能查到知识库。`;
	}
	if (response.results.length === 0) {
		if (response.kbIds.length === 0) {
			return "当前没有可检索的知识库：技能没有绑定、也没有设置「对话默认检索」的库。可以先按已有信息回答，并提示用户到「知识库」页把资料库设为对话默认检索。";
		}
		return `已在 ${response.kbIds.length} 个知识库里检索「${query}」，没有找到相关内容（${modeLabelOf(response.mode)}）。可以换个说法再查，或基于已有信息回答并说明没有查到。`;
	}
	const blocks = response.results.map((result, index) => {
		const heading = result.heading ?? "（无标题）";
		return `[片段 ${index + 1}] [kb:${result.kbId} doc:${result.docId} chunk:${result.chunkId}] 《${filenameOf(result.docId)}》 · ${heading}\n${result.snippet}`;
	});
	blocks.push(`（${modeLabelOf(response.mode)}，共 ${response.results.length} 条）`);
	return blocks.join("\n\n");
}
