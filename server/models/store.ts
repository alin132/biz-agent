/**
 * 多模型管理的存储门面：DAO 之上只做三件事 —— 校验、加密、掩码。
 *
 * 为什么独立一层：路由只想处理 HTTP，服务层只关心"当前用哪个模型"；
 * 加解密和"永不返回明文 Key"这条约束集中在这里，别处就没机会漏。
 *
 * 错误用 `ModelError(status)` 抛，路由层直接映射状态码（与 WorkflowHttpError 同一个套路）。
 */

import { randomUUID } from "node:crypto";
import type {
	ModelProviderKind,
	ModelProviderRecord,
	ModelRecord,
	ModelType,
	RemoveProviderResult,
	Storage,
} from "../db/types.js";
import { decryptSecret, encryptSecret, maskSecret } from "./crypto.js";

export class ModelError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "ModelError";
	}
}

export const PROVIDER_KINDS: readonly ModelProviderKind[] = ["openai", "deepseek", "ollama", "anthropic", "custom"];
export const MODEL_TYPES: readonly ModelType[] = ["chat", "embedding"];

/** 供应商出参：**只有掩码**，密文与明文都不出去。 */
export interface ProviderView {
	id: string;
	name: string;
	kind: ModelProviderKind;
	baseUrl: string | null;
	enabled: boolean;
	hasApiKey: boolean;
	apiKeyMasked: string | null;
	/** 密文解不开（没配 SECRET_KEY 或换过密钥）：页面据此提示"重新填写 Key"，别让前端猜文案 */
	apiKeyBroken: boolean;
	modelCount: number;
	createdAt: number;
	updatedAt: number;
}

export interface ModelView {
	id: string;
	providerId: string;
	providerName: string;
	name: string;
	modelId: string;
	kind: ModelType;
	enabled: boolean;
	contextWindow: number | null;
	createdAt: number;
	updatedAt: number;
}

const MAX_NAME = 80;
const MAX_MODEL_ID = 200;
const MAX_BASE_URL = 500;
const MAX_API_KEY = 1000;

function requiredString(value: unknown, label: string, maxLength: number): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new ModelError(400, `${label}不能为空`);
	}
	const trimmed = value.trim();
	if (trimmed.length > maxLength) {
		throw new ModelError(400, `${label}不能超过 ${maxLength} 个字符`);
	}
	return trimmed;
}

function optionalString(value: unknown, label: string, maxLength: number): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (value === null) {
		return undefined;
	}
	if (typeof value !== "string") {
		throw new ModelError(400, `${label}必须是字符串`);
	}
	const trimmed = value.trim();
	if (trimmed.length > maxLength) {
		throw new ModelError(400, `${label}不能超过 ${maxLength} 个字符`);
	}
	return trimmed;
}

function parseProviderKind(value: unknown, fallback: ModelProviderKind = "openai"): ModelProviderKind {
	if (value === undefined || value === null) {
		return fallback;
	}
	if (typeof value !== "string" || !PROVIDER_KINDS.includes(value as ModelProviderKind)) {
		throw new ModelError(400, `供应商类型只能是 ${PROVIDER_KINDS.join(" / ")}`);
	}
	return value as ModelProviderKind;
}

function parseModelType(value: unknown, fallback: ModelType = "chat"): ModelType {
	if (value === undefined || value === null) {
		return fallback;
	}
	if (typeof value !== "string" || !MODEL_TYPES.includes(value as ModelType)) {
		throw new ModelError(400, "模型类型只能是 chat / embedding");
	}
	return value as ModelType;
}

function parseBaseUrl(value: unknown): string | null {
	if (value === undefined || value === null || value === "") {
		return null;
	}
	if (typeof value !== "string") {
		throw new ModelError(400, "base_url 必须是字符串");
	}
	const trimmed = value.trim().replace(/\/+$/, "");
	if (trimmed.length === 0) {
		return null;
	}
	if (trimmed.length > MAX_BASE_URL) {
		throw new ModelError(400, `base_url 不能超过 ${MAX_BASE_URL} 个字符`);
	}
	if (!/^https?:\/\//i.test(trimmed)) {
		throw new ModelError(400, "base_url 必须以 http:// 或 https:// 开头");
	}
	return trimmed;
}

/** `null` / 空串 = 清空；非空字符串 = 加密后落库。 */
function parseApiKey(value: unknown): string | null {
	if (value === undefined || value === null) {
		return null;
	}
	if (typeof value !== "string") {
		throw new ModelError(400, "apiKey 必须是字符串");
	}
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		return null;
	}
	if (trimmed.length > MAX_API_KEY) {
		throw new ModelError(400, `apiKey 不能超过 ${MAX_API_KEY} 个字符`);
	}
	return trimmed;
}

function parseContextWindow(value: unknown): number | null {
	if (value === undefined || value === null) {
		return null;
	}
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new ModelError(400, "contextWindow 必须是正整数");
	}
	return Math.trunc(value);
}

function parseEnabled(value: unknown, fallback: boolean): boolean {
	if (value === undefined || value === null) {
		return fallback;
	}
	if (typeof value !== "boolean") {
		throw new ModelError(400, "enabled 必须是布尔值");
	}
	return value;
}

export class ModelStore {
	constructor(private readonly storage: Storage) {}

	providerRows(): ModelProviderRecord[] {
		return this.storage.listModelProviders();
	}

	modelRows(): ModelRecord[] {
		return this.storage.listModels();
	}

	providerRow(id: string): ModelProviderRecord | undefined {
		return this.storage.getModelProvider(id);
	}

	modelRow(id: string): ModelRecord | undefined {
		return this.storage.getModel(id);
	}

	/** 按模型行 id 或供应商那边的 modelId 找（会话的 modelId 两种都认）。 */
	findModelByKey(key: string): ModelRecord | undefined {
		const matches = this.modelRows().filter((row) => row.id === key || row.modelId === key);
		return matches.find((row) => row.enabled) ?? matches[0];
	}

	providers(): ProviderView[] {
		const counts = new Map<string, number>();
		for (const model of this.modelRows()) {
			counts.set(model.providerId, (counts.get(model.providerId) ?? 0) + 1);
		}
		return this.providerRows().map((row) => this.toProviderView(row, counts.get(row.id) ?? 0));
	}

	provider(id: string): ProviderView | undefined {
		const row = this.providerRow(id);
		if (!row) {
			return undefined;
		}
		const modelCount = this.modelRows().filter((model) => model.providerId === id).length;
		return this.toProviderView(row, modelCount);
	}

	models(): ModelView[] {
		const names = new Map(this.providerRows().map((row) => [row.id, row.name]));
		return this.modelRows().map((row) => this.toModelView(row, names.get(row.providerId) ?? ""));
	}

	model(id: string): ModelView | undefined {
		const row = this.modelRow(id);
		if (!row) {
			return undefined;
		}
		const providerName = this.providerRow(row.providerId)?.name ?? "";
		return this.toModelView(row, providerName);
	}

	private toProviderView(row: ModelProviderRecord, modelCount: number): ProviderView {
		const hasApiKey = Boolean(row.apiKeyEncrypted);
		const masked = hasApiKey ? this.maskedKeyOf(row) : { masked: null, broken: false };
		return {
			id: row.id,
			name: row.name,
			kind: row.kind,
			baseUrl: row.baseUrl,
			enabled: row.enabled,
			hasApiKey,
			apiKeyMasked: masked.masked,
			apiKeyBroken: masked.broken,
			modelCount,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
		};
	}

	private toModelView(row: ModelRecord, providerName: string): ModelView {
		return {
			id: row.id,
			providerId: row.providerId,
			providerName,
			name: row.name,
			modelId: row.modelId,
			kind: row.kind,
			enabled: row.enabled,
			contextWindow: row.contextWindow,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
		};
	}

	/** 解密后的明文 Key（只给运行时/探测用，绝不进 HTTP 出参）。 */
	secretOf(row: ModelProviderRecord): string | null {
		if (!row.apiKeyEncrypted) {
			return null;
		}
		return decryptSecret(row.apiKeyEncrypted);
	}

	private maskedKeyOf(row: ModelProviderRecord): { masked: string | null; broken: boolean } {
		try {
			return { masked: maskSecret(this.secretOf(row)), broken: false };
		} catch {
			// 密文解不开（多半是 SECRET_KEY 变了）也不该让列表接口 500，给个占位让用户重填
			return { masked: "****（无法解密，请重新填写）", broken: true };
		}
	}

	createProvider(body: Record<string, unknown>): ProviderView {
		const name = requiredString(body.name, "供应商名称", MAX_NAME);
		const kind = parseProviderKind(body.kind);
		const baseUrl = parseBaseUrl(body.baseUrl);
		const apiKey = parseApiKey(body.apiKey);
		const enabled = parseEnabled(body.enabled, true);
		if (this.providerRows().some((row) => row.name === name)) {
			throw new ModelError(409, `供应商名称「${name}」已存在`);
		}
		const now = Date.now();
		const row = this.storage.createModelProvider({
			id: `prov-${randomUUID().slice(0, 8)}`,
			name,
			kind,
			baseUrl,
			apiKeyEncrypted: apiKey ? encryptSecret(apiKey) : null,
			enabled,
			createdAt: now,
			updatedAt: now,
		});
		return this.toProviderView(row, 0);
	}

	updateProvider(id: string, body: Record<string, unknown>): ProviderView {
		const current = this.providerRow(id);
		if (!current) {
			throw new ModelError(404, "供应商不存在");
		}
		const patch: Parameters<Storage["updateModelProvider"]>[1] = { updatedAt: Date.now() };
		if ("name" in body) {
			const name = requiredString(body.name, "供应商名称", MAX_NAME);
			if (this.providerRows().some((row) => row.name === name && row.id !== id)) {
				throw new ModelError(409, `供应商名称「${name}」已存在`);
			}
			patch.name = name;
		}
		if ("kind" in body) {
			patch.kind = parseProviderKind(body.kind, current.kind);
		}
		if ("baseUrl" in body) {
			patch.baseUrl = parseBaseUrl(body.baseUrl);
		}
		if ("apiKey" in body) {
			const apiKey = parseApiKey(body.apiKey);
			patch.apiKeyEncrypted = apiKey ? encryptSecret(apiKey) : null;
		}
		if ("enabled" in body) {
			patch.enabled = parseEnabled(body.enabled, current.enabled);
		}
		const updated = this.storage.updateModelProvider(id, patch);
		if (!updated) {
			throw new ModelError(404, "供应商不存在");
		}
		const modelCount = this.modelRows().filter((row) => row.providerId === id).length;
		return this.toProviderView(updated, modelCount);
	}

	removeProvider(id: string): RemoveProviderResult {
		const result = this.storage.removeModelProvider(id);
		if (!result.removed) {
			throw new ModelError(404, "供应商不存在");
		}
		return result;
	}

	createModel(body: Record<string, unknown>): ModelView {
		const providerId = requiredString(body.providerId, "providerId", MAX_NAME);
		const provider = this.providerRow(providerId);
		if (!provider) {
			throw new ModelError(404, "供应商不存在");
		}
		const modelId = requiredString(body.modelId, "modelId", MAX_MODEL_ID);
		const name = optionalString(body.name, "模型名称", MAX_NAME) || modelId;
		const kind = parseModelType(body.kind);
		const enabled = parseEnabled(body.enabled, true);
		const contextWindow = parseContextWindow(body.contextWindow);
		const now = Date.now();
		const row = this.storage.createModel({
			id: `model-${randomUUID().slice(0, 8)}`,
			providerId,
			name,
			modelId,
			kind,
			enabled,
			contextWindow,
			createdAt: now,
			updatedAt: now,
		});
		return this.toModelView(row, provider.name);
	}

	updateModel(id: string, body: Record<string, unknown>): ModelView {
		const current = this.modelRow(id);
		if (!current) {
			throw new ModelError(404, "模型不存在");
		}
		const patch: Parameters<Storage["updateModel"]>[1] = { updatedAt: Date.now() };
		if ("providerId" in body) {
			const providerId = requiredString(body.providerId, "providerId", MAX_NAME);
			if (!this.providerRow(providerId)) {
				throw new ModelError(404, "供应商不存在");
			}
			patch.providerId = providerId;
		}
		if ("modelId" in body) {
			patch.modelId = requiredString(body.modelId, "modelId", MAX_MODEL_ID);
		}
		if ("name" in body) {
			patch.name = requiredString(body.name, "模型名称", MAX_NAME);
		}
		if ("kind" in body) {
			patch.kind = parseModelType(body.kind, current.kind);
		}
		if ("enabled" in body) {
			patch.enabled = parseEnabled(body.enabled, current.enabled);
		}
		if ("contextWindow" in body) {
			patch.contextWindow = parseContextWindow(body.contextWindow);
		}
		const updated = this.storage.updateModel(id, patch);
		if (!updated) {
			throw new ModelError(404, "模型不存在");
		}
		const providerName = this.providerRow(updated.providerId)?.name ?? "";
		return this.toModelView(updated, providerName);
	}

	removeModel(id: string): boolean {
		return this.storage.removeModel(id);
	}
}
