/**
 * 向量化（OpenAI 兼容接口）。
 *
 * 三个环境变量（都有默认值，只有 key 没有默认）：
 *   EMBEDDING_BASE_URL  默认 https://api.openai.com/v1（中转 / Ollama / vLLM 都填这里）
 *   EMBEDDING_MODEL     默认 text-embedding-3-small
 *   EMBEDDING_API_KEY   没配 → `available() === false`，知识库自动走关键词检索
 *
 * 设计要点：
 *   - **不假设维度**：按模型返回的长度存（JSON 数组文本进 `kb_chunks.embedding`），换模型不会崩。
 *   - 批量 32 条/次、单次超时 30s、失败重试 1 次（4xx 鉴权/参数错不重试，重试也没用）。
 *   - `available()` 每次现读环境变量：服务启动后才补 key / 单测里改 env 都能立刻生效。
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
}

/** 创建客户端。同一次服务里只建一个，配置在调用时现读，避免启动后才配 key 的情况漏掉。 */
export function createEmbeddingClient(options: CreateEmbeddingClientOptions = {}): EmbeddingClient {
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	const retryDelayMs = options.retryDelayMs ?? 300;

	const config = (): EmbeddingConfig => loadEmbeddingConfig(options.config ?? {});

	async function requestBatch(batch: string[], cfg: EmbeddingConfig): Promise<number[][]> {
		let response: Response;
		try {
			response = await fetchImpl(`${cfg.baseUrl}/embeddings`, {
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
			const cfg = config();
			return { available: cfg.apiKey.length > 0, model: cfg.model, baseUrl: cfg.baseUrl };
		},

		async embed(texts: string[]): Promise<number[][]> {
			const cfg = config();
			if (cfg.apiKey.length === 0) {
				throw new KbError(
					400,
					"没配置向量化服务（EMBEDDING_API_KEY 为空），无法做语义检索（已自动回退到关键词检索）",
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
