/**
 * 模型解析：决定这一次会话用真实模型还是模拟模型。
 *
 * 配置优先级：
 *   1. LLM_PROVIDER + (LLM_MODEL) 显式指定
 *   2. 按顺序扫描常见的 *API_KEY 环境变量
 *   3. 都没有 → 返回 null，调用方回落到模拟模型
 *
 * 支持 LLM_BASE_URL 覆盖端点（OpenAI 兼容中转、自建网关、Ollama、vLLM 等），
 * 支持 LLM_API_KEY 给那些不属于内置 provider 的 key。
 */

import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { builtinModels, getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { processPiModelRuntime } from "./piModelRuntime.js";

interface ProviderSpec {
	/** pi-ai 内置的 provider id */
	id: string;
	/** 该 provider 读取的环境变量名 */
	keyEnv: string;
	/** 展示名 */
	label: string;
}

/** 扫描顺序：先国内常用、再国际。 */
const PROVIDERS: ProviderSpec[] = [
	{ id: "deepseek", keyEnv: "DEEPSEEK_API_KEY", label: "DeepSeek" },
	{ id: "openai", keyEnv: "OPENAI_API_KEY", label: "OpenAI" },
	{ id: "moonshotai", keyEnv: "MOONSHOT_API_KEY", label: "Moonshot" },
	{ id: "zai", keyEnv: "ZAI_API_KEY", label: "Z.AI" },
	{ id: "openrouter", keyEnv: "OPENROUTER_API_KEY", label: "OpenRouter" },
	{ id: "anthropic", keyEnv: "ANTHROPIC_API_KEY", label: "Anthropic" },
	{ id: "google", keyEnv: "GEMINI_API_KEY", label: "Google" },
];

/**
 * 每个 provider 的默认模型。
 *
 * DeepSeek 默认用 flash：便宜、够用，项目阶段的联调与测试都跑它。
 * 历史记录（别再踩一次）：高峰期 flash 会持续 503「Service is too busy」、单次要 20 秒以上，
 * v4-pro 约 1~2 秒一次工具调用。做正式演示或批量压测时用 `LLM_MODEL=deepseek-v4-pro` 显式切回去。
 */
const DEFAULT_MODEL: Record<string, string> = {
	deepseek: "deepseek-flash",
};

/** 单次请求超时，防止连接挂死。 */
const DEFAULT_TIMEOUT_MS = 120_000;
/** 瞬时限流/过载的重试次数。 */
const DEFAULT_MAX_RETRIES = 3;

export interface LlmRuntime {
	model: Model<any>;
	streamFn: StreamFn;
	/** 给界面展示的标签，例如 "DeepSeek · deepseek-v4-pro" */
	label: string;
	provider: string;
	modelId: string;
	modelRuntime?: Promise<ModelRuntime>;
	prepareModel?: Promise<Model<any>>;
}

/** 目前支持哪些 key，用于启动日志和错误提示。 */
export function supportedKeyEnvs(): string[] {
	return PROVIDERS.map((spec) => spec.keyEnv);
}

/** `LLM_DISABLE=1` 强制模拟模型（冒烟/演示/离线）。 */
export function llmDisabled(): boolean {
	return process.env.LLM_DISABLE === "1" || process.env.LLM_DISABLE === "true";
}

/**
 * `.env` 里那一份模型配置（P6 的 `default` 供应商用它兜底）。
 * 返回 null = 没配 key（或 `LLM_DISABLE=1`），此时不该建供应商。
 */
export interface EnvProviderInfo {
	/** pi-ai 的 provider id（deepseek / openai / anthropic / ...） */
	provider: string;
	label: string;
	/** 明文 key：只用于加密后落库，不进出参 */
	apiKey: string;
	baseUrl: string | null;
	modelId: string;
}

export function envProviderInfo(): EnvProviderInfo | null {
	const spec = detectProvider();
	if (!spec) {
		return null;
	}
	const runtime = resolveLlm();
	if (!runtime) {
		return null;
	}
	const apiKey = (process.env[spec.keyEnv] ?? process.env.LLM_API_KEY ?? "").trim();
	if (apiKey.length === 0) {
		return null;
	}
	return {
		provider: spec.id,
		label: spec.label,
		apiKey,
		baseUrl: process.env.LLM_BASE_URL?.trim() || null,
		modelId: runtime.modelId,
	};
}

export interface ModelOption {
	id: string;
	label: string;
}

/** 识别当前该用哪个 provider；没有配置任何 key 时返回 null。 */
function detectProvider(): ProviderSpec | null {
	// LLM_DISABLE=1 强制走模拟模型：即使 .env 里配了真 key 也不联网。
	// 用于冒烟测试 / demo / 离线演示，保证结果可复现。
	if (llmDisabled()) {
		return null;
	}
	const forcedProvider = process.env.LLM_PROVIDER?.trim();
	const genericKey = process.env.LLM_API_KEY?.trim();

	if (forcedProvider) {
		const spec = PROVIDERS.find((candidate) => candidate.id === forcedProvider);
		if (!spec) {
			return null;
		}
		if (genericKey && process.env[spec.keyEnv] === undefined) {
			process.env[spec.keyEnv] = genericKey;
		}
		return process.env[spec.keyEnv] ? spec : null;
	}

	const auto = PROVIDERS.find((candidate) => Boolean(process.env[candidate.keyEnv]));
	if (auto) {
		return auto;
	}

	// 只给了 LLM_API_KEY + LLM_BASE_URL：按 OpenAI 兼容端点处理
	if (genericKey) {
		if (process.env.OPENAI_API_KEY === undefined) {
			process.env.OPENAI_API_KEY = genericKey;
		}
		return { id: "openai", keyEnv: "OPENAI_API_KEY", label: "OpenAI 兼容端点" };
	}

	return null;
}

/**
 * 解析可用模型；返回 null 表示没有配置任何 key，应回落到模拟模型。
 * `modelOverride` 用于界面上切换模型。
 */
export function resolveLlm(modelOverride?: string): LlmRuntime | null {
	const spec = detectProvider();
	if (!spec) {
		return null;
	}
	return buildRuntime(spec, modelOverride ?? process.env.LLM_MODEL?.trim(), process.env.LLM_BASE_URL?.trim());
}

/** 当前 provider 下所有可选的对话模型，供界面下拉使用。 */
export function listModelOptions(): ModelOption[] {
	const spec = detectProvider();
	if (!spec) {
		return [];
	}
	const listModels = getBuiltinModels as unknown as (provider: string) => Model<any>[];
	return listModels(spec.id).map((model) => ({ id: model.id, label: model.name ?? model.id }));
}

/** 当前实际使用的模型 id；没有 key 时为 null。 */
export function currentModelId(): string | null {
	return resolveLlm()?.modelId ?? null;
}

function buildRuntime(spec: ProviderSpec, forcedModel: string | undefined, customBaseUrl: string | undefined): LlmRuntime | null {
	const models = builtinModels();

	// getBuiltinModels 的签名要求字面量 provider，这里按动态 id 调用
	const listModels = getBuiltinModels as unknown as (provider: string) => Model<any>[];

	const explicit = forcedModel ? models.getModel(spec.id, forcedModel) : undefined;
	const preferred = DEFAULT_MODEL[spec.id];
	const preferredModel = preferred ? models.getModel(spec.id, preferred) : undefined;
	const base = explicit ?? preferredModel ?? listModels(spec.id)[0];
	if (!base) {
		return null;
	}

	// model 级 baseUrl 优先于 provider 端点
	const model: Model<any> = customBaseUrl ? { ...base, baseUrl: customBaseUrl } : { ...base };

	// 包一层传输策略：超时 + 重试，避免单次抖动把整轮跑挂
	const timeoutMs = Number(process.env.LLM_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
	const maxRetries = Number(process.env.LLM_MAX_RETRIES ?? DEFAULT_MAX_RETRIES);
	const runtimeProviderId = `biz_env_${spec.id}`;
	model.provider = runtimeProviderId;
	const prepareModel = processPiModelRuntime.register({
		model,
		providerId: runtimeProviderId,
		providerName: spec.label,
		apiKey: (process.env[spec.keyEnv] ?? process.env.LLM_API_KEY)?.trim(),
	});
	const modelRuntime = processPiModelRuntime.runtime();
	const streamFn: StreamFn = async (requestModel, context, options) => {
		const piRuntime = await modelRuntime;
		await prepareModel;
		return piRuntime.streamSimple(requestModel, context, {
			...options,
			timeoutMs,
			maxRetries,
			maxRetryDelayMs: 15_000,
		});
	};

	return {
		model,
		streamFn,
		label: `${spec.label} · ${model.id}`,
		provider: spec.id,
		modelId: model.id,
		modelRuntime,
		prepareModel,
	};
}
