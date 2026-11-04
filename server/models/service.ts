/**
 * 多模型管理的运行时服务：把「供应商 + 模型 + 当前选择」拼成可用的 Pi 运行时。
 *
 * 关键约定：
 * - `.env` 里的 key 在**首次启动**时自动落成一个 `default` 供应商 + 一条 chat 模型（行为与 P2 一致）；
 * - `LLM_DISABLE=1` 时一律不建、也不用真实模型（冒烟/演示要可复现）；
 * - 会话构造通过 `resolveRuntime(modelKey?)` 注入：返回 LlmRuntime = 用库里的模型；
 *   返回 `undefined` = 库里没有这个模型，交回 `resolveLlm()` 按 .env 处理；
 *   返回 `null` = 明确不连真实模型（模型停用/密文解不开且不是 default 供应商）；
 * - 探测（ping）绕开 Pi，直接对供应商端点发一个极短请求（8 秒超时），失败也只返回文案，不抛。
 */

import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { builtinModels, getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import type { ModelProviderKind, ModelProviderRecord, ModelRecord, Storage } from "../db/types.js";
import type { LlmRuntime, ModelOption } from "../llm.js";
import { currentModelId, envProviderInfo, listModelOptions, llmDisabled, resolveLlm } from "../llm.js";
import { decryptSecret } from "./crypto.js";
import { ModelError, ModelStore } from "./store.js";
import type { ModelView } from "./store.js";

/** `.env` 兜底供应商的名字：`SECRET_KEY` 变了导致解不开时，只有它允许回落 .env。 */
export const DEFAULT_PROVIDER_NAME = "default";
const PING_TIMEOUT_MS = 8000;

export interface HealthModel {
	mode: "live" | "simulated";
	id: string | null;
	label: string;
}

export interface CurrentModelView {
	/** 当前模型在供应商那边的 id（例如 deepseek-v4-pro）；纯 .env 模式下也返回它 */
	current: string | null;
	/** 库里的模型行（纯 .env 模式且没建 default 供应商时为 null） */
	model: ModelView | null;
	mode: "live" | "simulated";
	/** 展示用名字：库里配了模型行就用「供应商 · 模型名」，否则回落 `healthModel()` 的 label */
	label: string;
}

export interface PingResult {
	ok: boolean;
	latencyMs: number;
	error?: string;
}

/** 只依赖 ping 用到的那几个字段，测试里传假 fetch 不需要真 Response。 */
export interface FetchResponseLike {
	ok: boolean;
	status: number;
	text(): Promise<string>;
}

export type FetchLike = (
	url: string,
	init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<FetchResponseLike>;

const defaultFetch: FetchLike = (url, init) => fetch(url, init);

/** pi-ai 的 provider id → 我们的供应商类型。 */
function providerKindToPi(kind: ModelProviderKind): string {
	if (kind === "deepseek" || kind === "openai" || kind === "anthropic") {
		return kind;
	}
	// ollama 与 custom 都走 OpenAI 兼容协议
	return "openai";
}

function providerKindOf(piProvider: string): ModelProviderKind {
	if (piProvider === "deepseek" || piProvider === "openai" || piProvider === "anthropic" || piProvider === "ollama") {
		return piProvider;
	}
	return "custom";
}

function listBuiltin(piProvider: string): Model<any>[] {
	return (getBuiltinModels as unknown as (provider: string) => Model<any>[])(piProvider);
}

/** 优先精确 id；openai 兼容端点要挑 `openai-completions` 那套模板（responses 协议对不上）。 */
function pickTemplate(piProvider: string, modelId: string): Model<any> | undefined {
	const candidates = listBuiltin(piProvider);
	const exact = candidates.find((model) => model.id === modelId);
	if (exact) {
		return exact;
	}
	if (piProvider === "openai") {
		return candidates.find((model) => model.api === "openai-completions") ?? candidates[0];
	}
	return candidates[0];
}

/** 供应商端点：显式 base_url > ollama 默认 > 内置模板；custom 没填就返回 null。 */
function resolveBaseUrl(provider: ModelProviderRecord, templateBase: string | undefined): string | null {
	const configured = provider.baseUrl?.trim().replace(/\/+$/, "");
	if (configured) {
		return configured;
	}
	if (provider.kind === "ollama") {
		return "http://127.0.0.1:11434/v1";
	}
	if (provider.kind === "custom") {
		return null;
	}
	return templateBase ?? null;
}

export class ModelService {
	readonly store: ModelStore;
	private currentKey: string | null;

	constructor(storage: Storage) {
		this.store = new ModelStore(storage);
		this.currentKey = this.pickInitialCurrent();
	}

	/** 首次启动：没配 key 就不建；已经建过任何供应商就完全不动（幂等）。 */
	bootstrapDefaultProvider(): void {
		if (this.store.providerRows().length > 0) {
			return;
		}
		const env = envProviderInfo();
		if (!env) {
			return;
		}
		try {
			const provider = this.store.createProvider({
				name: DEFAULT_PROVIDER_NAME,
				kind: providerKindOf(env.provider),
				baseUrl: env.baseUrl,
				apiKey: env.apiKey,
				enabled: true,
			});
			const model = this.store.createModel({
				providerId: provider.id,
				name: env.modelId,
				modelId: env.modelId,
				kind: "chat",
				enabled: true,
			});
			if (this.currentKey === null) {
				this.currentKey = model.id;
			}
			console.log(`模型管理: 已用 .env 的 key 建出 default 供应商（${env.label} · ${env.modelId}）`);
		} catch (error) {
			console.warn(`模型管理: 初始化 default 供应商失败（${error instanceof Error ? error.message : String(error)}）`);
		}
	}

	private providerEnabled(providerId: string): boolean {
		const provider = this.store.providerRow(providerId);
		return Boolean(provider?.enabled);
	}

	private pickInitialCurrent(): string | null {
		const row = this.store
			.modelRows()
			.find((model) => model.kind === "chat" && model.enabled && this.providerEnabled(model.providerId));
		return row?.id ?? null;
	}

	/** 当前模型行：指向的模型被删/停用时退回第一条可用的 chat 模型。 */
	private currentRow(): ModelRecord | null {
		if (this.currentKey) {
			const row = this.store.modelRow(this.currentKey);
			if (row && row.enabled && row.kind === "chat" && this.providerEnabled(row.providerId)) {
				return row;
			}
		}
		const fallback = this.store
			.modelRows()
			.find((model) => model.kind === "chat" && model.enabled && this.providerEnabled(model.providerId));
		this.currentKey = fallback?.id ?? null;
		return fallback ?? null;
	}

	currentModelKey(): string | undefined {
		return this.currentRow()?.id;
	}

	currentView(): CurrentModelView {
		const row = this.currentRow();
		const model = row ? this.store.model(row.id) ?? null : null;
		const runtime = this.currentRuntime();
		// 库里配了模型行：供应商名 · 模型名；否则用运行时 label（`.env` 模式）/ 模拟模型
		const label =
			model && row
				? `${this.store.provider(row.providerId)?.name ?? "默认供应商"} · ${model.name}`
				: (runtime?.label ?? "模拟模型");
		return {
			current: row?.modelId ?? currentModelId(),
			model,
			mode: runtime ? "live" : "simulated",
			label,
		};
	}

	setCurrent(modelKey: unknown): CurrentModelView {
		if (typeof modelKey !== "string" || modelKey.trim().length === 0) {
			throw new ModelError(400, "modelId 不能为空");
		}
		const row = this.store.findModelByKey(modelKey.trim());
		if (!row) {
			throw new ModelError(404, "模型不存在");
		}
		if (row.kind !== "chat") {
			throw new ModelError(400, "只有对话（chat）模型能设为当前模型");
		}
		if (!row.enabled) {
			throw new ModelError(400, "模型已停用，不能设为当前模型");
		}
		const provider = this.store.providerRow(row.providerId);
		if (!provider || !provider.enabled) {
			throw new ModelError(400, "供应商已停用，不能把它的模型设为当前模型");
		}
		this.currentKey = row.id;
		return this.currentView();
	}

	/** 给界面下拉用：`.env` 的内置模型在前，库里新增的模型在后（按 modelId 去重）。 */
	options(): ModelOption[] {
		const seen = new Set<string>();
		const result: ModelOption[] = [];
		for (const option of listModelOptions()) {
			if (!seen.has(option.id)) {
				seen.add(option.id);
				result.push(option);
			}
		}
		for (const row of this.store.modelRows()) {
			if (row.kind !== "chat" || !row.enabled || !this.providerEnabled(row.providerId)) {
				continue;
			}
			if (seen.has(row.modelId)) {
				continue;
			}
			seen.add(row.modelId);
			result.push({ id: row.modelId, label: row.name });
		}
		return result;
	}

	/**
	 * 会话构造注入点（见 `server/session.ts` 的 `resolveModel`）。
	 * undefined = 不认识，交回 .env；null = 明确不用真实模型。
	 */
	resolveRuntime(modelKey?: string): LlmRuntime | null | undefined {
		if (llmDisabled()) {
			return undefined;
		}
		let row: ModelRecord | null;
		if (modelKey) {
			const found = this.store.findModelByKey(modelKey);
			if (!found) {
				return undefined;
			}
			row = found;
		} else {
			row = this.currentRow();
			if (!row) {
				return undefined;
			}
		}
		if (row.kind !== "chat" || !row.enabled) {
			return null;
		}
		const provider = this.store.providerRow(row.providerId);
		if (!provider || !provider.enabled) {
			return null;
		}
		return this.buildRuntime(row, provider);
	}

	/** `/api/health.model` 与 `/v1/health` 共用（形状与 P2 完全一致）。 */
	currentRuntime(): LlmRuntime | null {
		const resolved = this.resolveRuntime();
		if (resolved !== undefined) {
			return resolved;
		}
		if (llmDisabled()) {
			return null;
		}
		return resolveLlm();
	}

	healthModel(): HealthModel {
		const runtime = this.currentRuntime();
		if (!runtime) {
			return { mode: "simulated", id: null, label: "模拟模型" };
		}
		return { mode: "live", id: runtime.modelId, label: runtime.label };
	}

	providerCount(): number {
		return this.store.providerRows().length;
	}

	modelCount(): number {
		return this.store.modelRows().length;
	}

	ping(modelKey: string, fetchImpl: FetchLike = defaultFetch): Promise<PingResult> {
		const row = this.store.findModelByKey(modelKey) ?? this.store.modelRow(modelKey);
		if (!row) {
			throw new ModelError(404, "模型不存在");
		}
		const provider = this.store.providerRow(row.providerId);
		if (!provider) {
			throw new ModelError(404, "模型对应的供应商不存在");
		}
		return pingModel({ provider, model: row }, fetchImpl);
	}

	private buildRuntime(row: ModelRecord, provider: ModelProviderRecord): LlmRuntime | null | undefined {
		const piProvider = providerKindToPi(provider.kind);
		const template = pickTemplate(piProvider, row.modelId);
		if (!template) {
			return null;
		}
		let apiKey: string | null = null;
		try {
			apiKey = this.store.secretOf(provider);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			if (provider.name === DEFAULT_PROVIDER_NAME) {
				// default 是 .env 的兜底：密文解不开就回落 .env，别让重启把真实模型变成模拟模型
				console.warn(`模型管理: default 供应商的 API Key 解不开（${detail}），回落 .env 配置`);
				return undefined;
			}
			console.warn(`模型管理: 供应商「${provider.name}」的 API Key 解不开（${detail}）`);
			return null;
		}
		const baseUrl = resolveBaseUrl(provider, template.baseUrl);
		if (!baseUrl) {
			return null;
		}
		const model: Model<any> = { ...template, id: row.modelId, name: row.name, provider: piProvider, baseUrl };
		const timeoutMs = Number(process.env.LLM_TIMEOUT_MS ?? 120_000);
		const maxRetries = Number(process.env.LLM_MAX_RETRIES ?? 3);
		const models = builtinModels();
		const baseStream = models.streamSimple.bind(models);
		const streamFn: StreamFn = (requestModel, context, options) =>
			baseStream(requestModel, context, {
				...options,
				apiKey: apiKey ?? undefined,
				timeoutMs,
				maxRetries,
				maxRetryDelayMs: 15_000,
			});
		return {
			model,
			streamFn,
			label: `${provider.name} · ${row.name}`,
			provider: piProvider,
			modelId: row.modelId,
		};
	}
}

/** 启动时调用一次：建 store + 尝试用 .env 兜底建 default 供应商。 */
export function initModels(options: { storage: Storage }): ModelService {
	const service = new ModelService(options.storage);
	service.bootstrapDefaultProvider();
	return service;
}

function truncate(text: string, max: number): string {
	const compact = text.replace(/\s+/g, " ").trim();
	return compact.length > max ? `${compact.slice(0, max)}…` : compact;
}

interface PingInput {
	provider: ModelProviderRecord;
	model: ModelRecord;
}

/** 按供应商类型发一个极短请求；任何失败都变成 `{ ok: false, error }`，不抛。 */
export async function pingModel(
	input: PingInput,
	fetchImpl: FetchLike = defaultFetch,
	timeoutMs: number = PING_TIMEOUT_MS,
): Promise<PingResult> {
	const { provider, model } = input;
	const base = (() => {
		const configured = provider.baseUrl?.trim().replace(/\/+$/, "");
		if (configured) {
			return configured;
		}
		if (provider.kind === "ollama") {
			return "http://127.0.0.1:11434/v1";
		}
		if (provider.kind === "custom") {
			// custom 没有内置端点，猜一个只会把请求打到别人的服务器上
			return null;
		}
		return pickTemplate(providerKindToPi(provider.kind), model.modelId)?.baseUrl ?? null;
	})();
	if (!base) {
		return { ok: false, latencyMs: 0, error: "自定义供应商需要先填写 base_url 才能探测" };
	}
	const isAnthropic = provider.kind === "anthropic";
	const endpoint = isAnthropic
		? `${base.replace(/\/+$/, "")}${/\/v1$/.test(base) ? "/messages" : "/v1/messages"}`
		: `${base.replace(/\/+$/, "")}${model.kind === "embedding" ? "/embeddings" : "/chat/completions"}`;

	let apiKey: string | null = null;
	if (provider.apiKeyEncrypted) {
		try {
			apiKey = decryptSecret(provider.apiKeyEncrypted);
		} catch {
			// 解不开也照样探测（自定义端点可能免鉴权）；失败文案里不会出现密钥本身
			apiKey = null;
		}
	}
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (isAnthropic) {
		if (apiKey) {
			headers["x-api-key"] = apiKey;
		}
		headers["anthropic-version"] = "2023-06-01";
	} else if (apiKey) {
		headers.authorization = `Bearer ${apiKey}`;
	}

	const body = JSON.stringify(
		isAnthropic
			? { model: model.modelId, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }
			: model.kind === "embedding"
				? { model: model.modelId, input: "ping" }
				: { model: model.modelId, max_tokens: 1, messages: [{ role: "user", content: "ping" }], stream: false },
	);

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const startedAt = Date.now();
	try {
		const response = await fetchImpl(endpoint, {
			method: "POST",
			headers,
			body,
			signal: controller.signal,
		});
		const latencyMs = Date.now() - startedAt;
		const text = await response.text().catch(() => "");
		if (!response.ok) {
			const detail = text.length > 0 ? `：${truncate(text, 200)}` : "";
			return { ok: false, latencyMs, error: `模型端点返回 HTTP ${response.status}${detail}` };
		}
		return { ok: true, latencyMs };
	} catch (error) {
		const latencyMs = Date.now() - startedAt;
		if (controller.signal.aborted) {
			return { ok: false, latencyMs, error: `探测超时（${Math.round(timeoutMs / 1000)} 秒）` };
		}
		const message = error instanceof Error ? error.message : String(error);
		// fetch 的失败信息是英文（fetch failed / getaddrinfo ENOTFOUND），界面上要中文人话
		const hint = /fetch failed|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|socket hang up/i.test(message)
			? "连不上这个端点（地址写错了、端口没开，或网络不通）"
			: truncate(message, 200);
		return { ok: false, latencyMs, error: `连接模型端点失败：${hint}` };
	} finally {
		clearTimeout(timer);
	}
}
