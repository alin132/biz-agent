/**
 * 向量化（OpenAI 兼容接口）。
 *
 * **配置来源有两条，先看模型页，再看环境变量**：
 *   ① 模型页里「类型 = 向量」且启用、供应商也启用的那条模型（base_url + 解密的 key + modelId）；
 *   ② 环境变量 EMBEDDING_BASE_URL / EMBEDDING_MODEL / EMBEDDING_API_KEY（部署期配置，仍然支持）。
 * 两条都没有 → `available() === false`，知识库自动走关键词检索。
 * 每次调用都现读（不缓存），所以在模型页改完立刻生效，不用重启。
 *
 * 设计要点：
 *   - **不假设维度**：按模型返回的长度存（JSON 数组文本进 `kb_chunks.embedding`），换模型不会崩。
 *   - 批量 32 条/次、单次超时 30s、失败重试 1 次（4xx 鉴权/参数错不重试，重试也没用）。
 *   - 模型行的来源以`ModelService.embeddingConfig()` 为准，这里只认它给出的纯数据，不 import 模型模块（避免循环依赖）。
 */

import { KbError, errorMessage } from "./errors.js";

export const EMBEDDING_BATCH_SIZE = 32;
export const EMBEDDING_TIMEOUT_MS = 30_000;

export const DEFAULT_EMBEDDING_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";

export interface EmbeddingConfig {
	baseUrl: string;
	model: string;
	apiKey: string;
}

export interface EmbeddingInfo {
	available: boolean;
	model: string;
	baseUrl: string;
	/** 配置从哪来：模型页（model）/ 环境变量（env）/ 都没有（none）。页面据此给不同引导 */
	source: "model" | "env" | "none";
	/** source=model 时是那条模型行的 id，页面据此标出"当前向量模型" */
	modelKey: string | null;
	/** 能拿到配置但实际不可用的原因（比如 key 解不开），页面直接显示 */
	problem: string | null;
}

export interface EmbeddingClient {
	/** 没有 key 就是 false；上层据此决定检索模式 */
	available(): boolean;
	/** 给 `GET /api/kb/embedding` 的展示字段（页面据此显示「语义检索未启用」） */
	info(): EmbeddingInfo;
	/** 批量向量化；未配置 key 直接抛中文错误 */
	embed(texts: string[]): Promise<number[][]>;
}

/** 读环境变量 → 配置（显式覆盖优先，方便单测注入假的端点） */
export function loadEmbeddingConfig(overrides: Partial<EmbeddingConfig> = {}): EmbeddingConfig {
	const baseUrl = (overrides.baseUrl ?? process.env.EMBEDDING_BASE_URL ?? DEFAULT_EMBEDDING_BASE_URL)
		.trim()
		.replace(/\/+$/, "");
	const model = (overrides.model ?? process.env.EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL).trim();
	const apiKey = (overrides.apiKey ?? process.env.EMBEDDING_API_KEY ?? "").trim();
	return { baseUrl, model, apiKey };
}

/** 判断一个错误值不值得重试：网络/超时/5xx/429 值得，401/400 不值得。 */
function isRetryable(error: unknown): boolean {
	if (error instanceof EmbeddingHttpError) {
		return error.status === 429 || error.status >= 500;
	}
	return true;
}

/** 带状态码的 HTTP 错误（内部用，决定要不要重试）。 */
class EmbeddingHttpError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = "EmbeddingHttpError";
		this.status = status;
	}
}

/** 把一批文本拼成 OpenAI `/embeddings` 请求体。 */
function buildRequestBody(model: string, batch: string[]): string {
	return JSON.stringify({ model, input: batch, encoding_format: "float" });
}

/** 解析响应：`data[].embedding`，按 index 排序，保证顺序和输入一致。 */
function parseEmbeddingResponse(raw: unknown, expected: number): number[][] {
	const body = raw as { data?: unknown; error?: { message?: unknown } } | null;
	if (!body || !Array.isArray(body.data)) {
		throw new KbError(400, "向量化服务返回的数据格式不对（缺少 data 数组）");
	}
	const items = body.data as { embedding?: unknown; index?: unknown }[];
	if (items.length !== expected) {
		throw new KbError(400, `向量化服务返回了 ${items.length} 条向量，期望 ${expected} 条`);
	}
	const sorted = [...items].sort((left, right) => {
		const a = typeof left.index === "number" ? left.index : 0;
		const b = typeof right.index === "number" ? right.index : 0;
		return a - b;
	});
	return sorted.map((item) => {
		if (!Array.isArray(item.embedding) || item.embedding.some((value) => typeof value !== "number")) {
			throw new KbError(400, "向量化服务返回的向量不是数字数组");
		}
		return item.embedding as number[];
	});
}

export interface CreateEmbeddingClientOptions {
	/** 显式配置（单测注入假端点）；不传则读环境变量 */
	config?: Partial<EmbeddingConfig>;
	/** 注入 fetch（单测用），默认全局 fetch */
	fetchImpl?: typeof fetch;
	/** 重试等待毫秒数（单测可设为 0） */
	retryDelayMs?: number;
	/**
	 * 模型页那条「向量」模型（服务端运行时注入）。
	 * 返回 null = 模型页没配，回落到环境变量；抛错/带 problem = 有配置但用不了，不再回落（否则会悄悄用错模型）。
	 */
	resolveModelEmbedding?: () => ResolvedEmbedding | null;
}

/** 模型页给出的向量配置（纯数据，避免与 models 模块互相 import）。 */
export interface ResolvedEmbedding {
	modelKey: string;
	config: EmbeddingConfig;
	/** 有配置但拼不出可用客户端时的中文原因 */
	problem?: string;
}

/** 创建客户端。同一次服务里只建一个，配置在调用时现读，避免启动后才配 key 的情况漏掉。 */
export function createEmbeddingClient(options: CreateEmbeddingClientOptions = {}): EmbeddingClient {
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	const retryDelayMs = options.retryDelayMs ?? 300;

	/** 现读当前生效的配置：显式 overrides > 模型页 > 环境变量。 */
	const resolve = (): { config: EmbeddingConfig; info: EmbeddingInfo } => {
		if (options.resolveModelEmbedding) {
			let resolved: ResolvedEmbedding | null = null;
			let problem: string | null = null;
			try {
				resolved = options.resolveModelEmbedding();
			} catch (error) {
				problem = errorMessage(error);
			}
			if (resolved) {
				// 模型页优先：只有它没给的那几项才用显式 overrides 补（overrides 是单测注入用的）
				const merged = loadEmbeddingConfig({
					baseUrl: resolved.config.baseUrl || options.config?.baseUrl,
					model: resolved.config.model || options.config?.model,
					apiKey: resolved.config.apiKey || options.config?.apiKey,
				});
				const usable = problem === null && !resolved.problem && merged.apiKey.length > 0;
				return {
					config: merged,
					info: {
						available: usable,
						model: merged.model,
						baseUrl: merged.baseUrl,
						source: "model",
						modelKey: resolved.modelKey,
						problem: resolved.problem ?? problem,
					},
				};
			}
			if (problem) {
				// 模型页有向量模型但读不出来（key 解不开之类）：如实报不可用，别悄悄退回环境变量
				return {
					config: { ...loadEmbeddingConfig(options.config ?? {}), apiKey: "" },
					info: {
						available: false,
						model: "",
						baseUrl: "",
						source: "model",
						modelKey: null,
						problem,
					},
				};
			}
		}
		const envConfig = loadEmbeddingConfig(options.config ?? {});
		const hasKey = envConfig.apiKey.length > 0;
		return {
			config: envConfig,
			info: {
				available: hasKey,
				model: envConfig.model,
				baseUrl: envConfig.baseUrl,
				source: hasKey ? "env" : "none",
				modelKey: null,
				problem: null,
			},
		};
	};

	const config = (): EmbeddingConfig => resolve().config;

	/** 端点：base_url 末尾带 /embeddings 的（有些供应商直接给完整地址）就别重复拼。 */
	function endpointOf(baseUrl: string): string {
		const base = baseUrl.replace(/\/+$/, "");
		return /\/embeddings$/i.test(base) ? base : `${base}/embeddings`;
	}

	async function requestBatch(batch: string[], cfg: EmbeddingConfig): Promise<number[][]> {
		let response: Response;
		try {
			response = await fetchImpl(endpointOf(cfg.baseUrl), {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${cfg.apiKey}`,
				},
				body: buildRequestBody(cfg.model, batch),
				signal: AbortSignal.timeout(EMBEDDING_TIMEOUT_MS),
			});
		} catch (error) {
			throw new KbError(503, `连不上向量化服务（${cfg.baseUrl}）：${errorMessage(error)}`);
		}
		if (!response.ok) {
			let detail = "";
			try {
				detail = (await response.text()).slice(0, 200);
			} catch {
				detail = "";
			}
			const suffix = detail.length > 0 ? `：${detail}` : "";
			if (response.status === 401 || response.status === 403) {
				throw new EmbeddingHttpError(
					response.status,
					`向量化服务鉴权失败（EMBEDDING_API_KEY 不对）HTTP ${response.status}${suffix}`,
				);
			}
			throw new EmbeddingHttpError(
				response.status,
				`向量化服务返回 HTTP ${response.status}${suffix}`,
			);
		}
		let json: unknown;
		try {
			json = await response.json();
		} catch {
			throw new KbError(502, "向量化服务返回的不是 JSON");
		}
		return parseEmbeddingResponse(json, batch.length);
	}

	return {
		available(): boolean {
			return config().apiKey.length > 0;
		},

		info(): EmbeddingInfo {
			return resolve().info;
		},

		async embed(texts: string[]): Promise<number[][]> {
			const cfg = config();
			if (cfg.apiKey.length === 0) {
				const info = resolve().info;
				throw new KbError(
					400,
					info.problem
						? `向量模型不可用：${info.problem}`
						: "没配置向量模型：到「模型」页加一个类型为「向量」的模型并设为向量模型（或配 EMBEDDING_API_KEY），再重新向量化",
				);
			}
			const inputs = texts.map((text) => text.trim());
			if (inputs.length === 0) {
				return [];
			}
			if (inputs.some((text) => text.length === 0)) {
				throw new KbError(400, "要向量化的文本不能为空");
			}

			const vectors: number[][] = [];
			for (let start = 0; start < inputs.length; start += EMBEDDING_BATCH_SIZE) {
				const batch = inputs.slice(start, start + EMBEDDING_BATCH_SIZE);
				let attempt = 0;
				for (;;) {
					try {
						vectors.push(...(await requestBatch(batch, cfg)));
						break;
					} catch (error) {
						const retryable = !(error instanceof EmbeddingHttpError) || isRetryable(error);
						// 鉴权错/参数错重试也不会好，直接抛
						if (!retryable || attempt >= 1) {
							throw error instanceof KbError ? error : new KbError(502, errorMessage(error));
						}
						attempt++;
						if (retryDelayMs > 0) {
							await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
						}
					}
				}
			}
			return vectors;
		},
	};
}

/** 把向量转成落库的文本（JSON 数组，不假设维度）。 */
export function serializeEmbedding(vector: number[]): string {
	return JSON.stringify(vector.map((value) => Math.round(value * 1e6) / 1e6));
}

/** 从库里读回向量；坏数据（手工改库 / 换过格式）当作没有向量，不整条检索崩掉。 */
export function parseEmbedding(text: string | null): number[] | null {
	if (!text) {
		return null;
	}
	try {
		const parsed = JSON.parse(text) as unknown;
		if (!Array.isArray(parsed) || parsed.length === 0) {
			return null;
		}
		if (parsed.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
			return null;
		}
		return parsed as number[];
	} catch {
		return null;
	}
}
