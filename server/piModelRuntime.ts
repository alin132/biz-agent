import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { streamSimple as openAICompletionsStream } from "@earendil-works/pi-ai/api/openai-completions";
import type { Model } from "@earendil-works/pi-ai";

export interface PiModelRuntimeOptions {
	model: Model<any>;
	providerId: string;
	providerName: string;
	apiKey?: string;
}

export class PiModelRuntimeRegistry {
	private runtimePromise: Promise<ModelRuntime> | null = null;
	private readonly registrations = new Map<string, { name: string; apiKey?: string; models: Model<any>[] }>();
	private registrationQueue: Promise<void> = Promise.resolve();

	runtime(): Promise<ModelRuntime> {
		this.runtimePromise ??= ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
			refreshOnCreate: false,
			allowModelNetwork: false,
		});
		return this.runtimePromise;
	}

	async register(options: PiModelRuntimeOptions): Promise<Model<any>> {
		const { model, providerId, providerName, apiKey } = options;
		const models = this.registrations.get(providerId)?.models ?? [];
		const nextModels = models.filter((entry) => entry.id !== model.id);
		nextModels.push(model);
		await this.replaceProvider({ providerId, providerName, apiKey, models: nextModels });
		const registered = (await this.runtime()).getModel(providerId, model.id);
		if (!registered) throw new Error(`Pi 未能注册模型「${model.id}」`);
		return registered;
	}

	/** Replaces a provider's complete model snapshot, removing stale models and credentials. */
	async replaceProvider(options: {
		providerId: string;
		providerName: string;
		apiKey?: string;
		models: Model<any>[];
	}): Promise<void> {
		const { providerId, providerName, apiKey, models } = options;
		if (models.length === 0) {			await this.unregisterProvider(providerId);
			return;
		}
		const registration = { name: providerName, apiKey, models: [...models] };
		this.registrations.set(providerId, registration);

		const update = async () => {
			const runtime = await this.runtime();
			const nativeProviders = new Map(registration.models.map((model) => [model.id, model.provider]));
			const firstModel = registration.models[0]!;
			runtime.registerProvider(providerId, {
				name: registration.name,
				baseUrl: firstModel.baseUrl,
				apiKey: registration.apiKey ?? "",
				authHeader: false,
				api: firstModel.api,
				models: registration.models.map((entry) => ({
					id: entry.id,
					name: entry.name ?? entry.id,
					api: entry.api,
					input: entry.input,
					cost: entry.cost,
					reasoning: entry.reasoning,
					contextWindow: entry.contextWindow,
					maxTokens: entry.maxTokens,
					...(entry.samplingParams ? { samplingParams: entry.samplingParams } : {}),
				})),
				streamSimple: (requestModel, context, streamOptions) => requestModel.api === "openai-completions"
					? openAICompletionsStream(requestModel as Model<"openai-completions">, context, streamOptions)
					: builtinModels().streamSimple({ ...requestModel, provider: nativeProviders.get(requestModel.id) ?? firstModel.provider }, context, streamOptions),
			});
		};
		const queued = this.registrationQueue.then(update);
		this.registrationQueue = queued.catch(() => undefined);
		await queued;
	}

	async unregisterProvider(providerId: string): Promise<void> {
		this.registrations.delete(providerId);
		const update = async () => (await this.runtime()).unregisterProvider(providerId);
		const queued = this.registrationQueue.then(update);
		this.registrationQueue = queued.catch(() => undefined);
		await queued;
	}
}

/** One process-wide registry lets a Pi session switch between .env and database providers. */
export const processPiModelRuntime = new PiModelRuntimeRegistry();

/** Convenience factory used by the isolated runtime transport selftest. */
export async function createPiModelRuntime(options: PiModelRuntimeOptions): Promise<ModelRuntime> {
	const registry = new PiModelRuntimeRegistry();
	await registry.register(options);
	return registry.runtime();
}
