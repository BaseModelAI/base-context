import type { Model } from "@earendil-works/pi-ai";
import {
	buildPrimeInferenceModels,
	fetchPrimeInferenceModelCatalog,
	PRIME_INFERENCE_BASE_URL,
	PrimeInferenceCatalogRequestError,
} from "./prime-inference-model-catalog.js";

export { PRIME_INFERENCE_BASE_URL };

const PRIVATE_MODEL_REFRESH_TIMEOUT_MS = 10_000;

const PRIVATE_PRIME_INFERENCE_MODELS: readonly Model<"openai-completions">[] = [
	{
		id: "internal/glm-5.2-fast",
		name: "GLM 5.2 Fast",
		api: "openai-completions",
		provider: "prime-inference",
		baseUrl: PRIME_INFERENCE_BASE_URL,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 131072,
		featured: true,
		compat: {
			supportsDeveloperRole: false,
			maxTokensField: "max_tokens",
		},
	},
];

export function isPrivatePrimeInferenceModel(model: Pick<Model<string>, "provider" | "id">): boolean {
	return model.provider === "prime-inference" && (model.id.startsWith("internal/") || model.id.startsWith("dev/"));
}

export function getPrivatePrimeInferenceModels(): Model<"openai-completions">[] {
	return PRIVATE_PRIME_INFERENCE_MODELS.map((model) => ({
		...model,
		input: [...model.input],
		cost: { ...model.cost },
		compat: model.compat ? { ...model.compat } : undefined,
	}));
}

export async function fetchAuthorizedPrivatePrimeInferenceModels(
	apiKey: string,
	teamHeaders: Record<string, string>,
	publicModelIds: ReadonlySet<string>,
	fetchFn: typeof fetch = fetch,
	timeoutMs: number = PRIVATE_MODEL_REFRESH_TIMEOUT_MS,
): Promise<Model<"openai-completions">[]> {
	if (!teamHeaders["X-Prime-Team-ID"]) return [];
	try {
		const { entries } = await fetchPrimeInferenceModelCatalog({
			fetchFn,
			timeoutMs,
			headers: { ...teamHeaders, Authorization: `Bearer ${apiKey}` },
		});
		const publicIds = new Set([...publicModelIds].map((id) => id.toLowerCase()));
		const privateEntries = entries.filter((entry) => {
			const id = entry.id.toLowerCase();
			return !publicIds.has(id) && (id.startsWith("internal/") || id.startsWith("dev/") || id.includes(":"));
		});
		return (
			buildPrimeInferenceModels(getPrivatePrimeInferenceModels(), privateEntries, {
				includePrivate: true,
				minimumModels: 0,
			}) ?? []
		);
	} catch (error) {
		if (error instanceof PrimeInferenceCatalogRequestError && (error.status === 401 || error.status === 403)) {
			return [];
		}
		throw error;
	}
}
