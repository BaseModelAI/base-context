import type { Api, Provider, ProviderAttemptReceipt } from "../types.js";

export type BudgetApi = "openai-codex-responses" | "openai-responses" | "openai-completions";

/** Explicit deployment configuration, NOT inferred from Model catalog defaults or aliases. */
export interface RequestTokenProfile {
	readonly id: string;
	readonly revision: string;
	readonly api: BudgetApi;
	readonly provider: Provider;
	/** Exact HTTP endpoint, without credentials, fragment or query. WebSocket uses the same route. */
	readonly url: string;
	readonly model: string;
	readonly authMode: string;
	readonly templateRevision: string;
	readonly replayFamily: string;
	readonly contextTokens: number;
	/** Route/model ceiling; Codex does not serialize the generic maxTokens option. */
	readonly outputCeilingTokens: number;
	/** Explicit accepted response identities. Absent means the exact request model only. */
	readonly responseModels?: readonly string[];
	readonly estimate: {
		/** Conservative text estimate, not a tokenizer or a proven upper bound. Never bytes/4. */
		readonly tokensPerUtf8Byte: number;
		readonly templateTokens: number;
		readonly marginTokens: number;
	};
}

export interface RequestTokenBudgetOptions {
	/** Observe preserves control thresholds. Enforce refuses unknown or over-budget requests. */
	readonly mode: "observe" | "enforce";
	readonly profiles: readonly RequestTokenProfile[];
}

export interface RetainedContextTokens {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly responseModel?: string;
}

/** In-memory scalar observation; populated only after the existing settlement callback ACK. */
export interface ContextTokenObservation {
	readonly value?: RetainedContextTokens;
}

/** Actual serialized request. No model text, schema, replay unit or prefix is modified. */
export interface ProviderRequestRepresentation {
	readonly api: Api;
	readonly provider: Provider;
	readonly url: string;
	readonly body: string | undefined;
	/** Only the owned exact-match WebSocket continuation path may supply this prefix. */
	readonly retainedPrefix?: RetainedContextTokens & { readonly inputItems: number };
}

export interface RequestTokenCalibration {
	readonly state: "unknown" | "observed";
	readonly samples: number;
	/** Empirical errors only, not a bound on unseen requests. */
	readonly maxUnderestimateTokens: number | null;
	readonly maxOverestimateTokens: number | null;
}

export interface RequestTokenAssessment {
	readonly profile: {
		readonly id: string;
		readonly revision: string;
		readonly authMode: string;
		readonly templateRevision: string;
		readonly replayFamily: string;
	} | null;
	readonly api: Api;
	readonly provider: Provider;
	readonly model: string | null;
	readonly route: string | null;
	readonly limitSource: "explicit-profile" | "unknown";
	readonly counter: "conservative-profile-estimate";
	readonly status: "within-estimate" | "over-budget" | "unknown";
	readonly unknown: readonly string[];
	readonly serializedBytes: number | null;
	readonly estimatedInputTokens: number | null;
	readonly retainedInputTokens: number;
	readonly outputReserveTokens: number | null;
	/** These adapters include reasoning in output; never add another thinking reserve. */
	readonly reasoningReservation: "included-in-output" | "unknown";
	readonly contextTokens: number | null;
	readonly marginTokens: number | null;
	readonly availableInputTokens: number | null;
	readonly calibration: RequestTokenCalibration;
	/** This estimate never certifies aggressive packing, cache hits or replay projection. */
	readonly aggressivePacking: false;
}

export class RequestTokenBudgetError extends Error {
	constructor(readonly assessment: RequestTokenAssessment) {
		super(
			`Request token budget ${assessment.status}: ${assessment.unknown.join(", ") || "configured context limit exceeded"}`,
		);
		this.name = "RequestTokenBudgetError";
	}
}

const unknownCalibration = (): RequestTokenCalibration => ({
	state: "unknown",
	samples: 0,
	maxUnderestimateTokens: null,
	maxOverestimateTokens: null,
});
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const bytes = (value: string): number => new TextEncoder().encode(value).byteLength;
const record = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);

function routeIdentity(raw: string): string | null {
	try {
		const url = new URL(raw);
		if (url.username || url.password || url.search || url.hash) return null;
		if (url.protocol === "wss:") url.protocol = "https:";
		if (url.protocol === "ws:") url.protocol = "http:";
		return url.protocol === "https:" || url.protocol === "http:" ? url.origin + url.pathname : null;
	} catch {
		return null;
	}
}

/** Only typed text/call/result replay is estimable locally. Media, encrypted state and references are unknown. */
function textContent(value: unknown): boolean {
	return (
		value === null ||
		typeof value === "string" ||
		(Array.isArray(value) &&
			value.every(
				(part) =>
					record(part) &&
					["text", "input_text", "output_text", "refusal", "summary_text"].includes(String(part.type)) &&
					(typeof part.text === "string" || typeof part.refusal === "string"),
			))
	);
}

function textInput(api: Api, input: unknown): boolean {
	if (typeof input === "string") return api !== "openai-completions";
	if (!Array.isArray(input)) return false;
	return input.every((item) => {
		if (!record(item)) return false;
		if (api === "openai-completions") {
			return (
				["system", "developer", "user", "assistant", "tool"].includes(String(item.role)) &&
				!item.audio &&
				!item.reasoning_details &&
				textContent(item.content ?? null)
			);
		}
		if (item.type === "function_call") return typeof item.arguments === "string";
		if (item.type === "function_call_output") return textContent(item.output);
		if (item.type === "reasoning") return false;
		return (
			(item.type === undefined || item.type === "message") &&
			["system", "developer", "user", "assistant"].includes(String(item.role)) &&
			textContent(item.content)
		);
	});
}

/** One replaceable, derived calibration bucket. Canonical receipts remain the only durable observations. */
export class RequestTokenBudget {
	private readonly options: RequestTokenBudgetOptions;
	private key?: string;
	private calibration = unknownCalibration();
	private calibrationIdentity: object = {};
	private readonly measured = new WeakMap<
		RequestTokenAssessment,
		{
			identity: object;
			estimate: number;
			models: readonly string[];
		}
	>();

	constructor(options: RequestTokenBudgetOptions) {
		this.options = structuredClone(options);
		if (!["observe", "enforce"].includes(options.mode)) throw new Error("Invalid request token budget mode");
		for (const profile of this.options.profiles) {
			if (
				!["openai-codex-responses", "openai-responses", "openai-completions"].includes(profile.api) ||
				!profile.id ||
				!profile.revision ||
				!profile.model ||
				!profile.provider ||
				!profile.authMode ||
				!profile.templateRevision ||
				!profile.replayFamily ||
				routeIdentity(profile.url) !== profile.url ||
				!count(profile.contextTokens) ||
				profile.contextTokens < 1 ||
				!count(profile.outputCeilingTokens) ||
				profile.outputCeilingTokens < 1 ||
				!Number.isFinite(profile.estimate.tokensPerUtf8Byte) ||
				profile.estimate.tokensPerUtf8Byte < 1 ||
				!count(profile.estimate.templateTokens) ||
				!count(profile.estimate.marginTokens)
			)
				throw new Error("Invalid explicit request token profile");
		}
	}

	measure(request: ProviderRequestRepresentation): RequestTokenAssessment {
		const unknown: string[] = [];
		const route = routeIdentity(request.url);
		let body: Record<string, unknown> = {};
		try {
			const parsed: unknown = request.body === undefined ? undefined : JSON.parse(request.body);
			if (record(parsed)) body = parsed;
			else unknown.push("serialized JSON object unavailable");
		} catch {
			unknown.push("serialized JSON object unavailable");
		}
		const model = typeof body.model === "string" ? body.model : null;
		const profiles = this.options.profiles.filter(
			(p) => p.api === request.api && p.provider === request.provider && p.url === route && p.model === model,
		);
		const profile = profiles.length === 1 ? profiles[0] : undefined;
		if (!profile) unknown.push("exact explicit route/model profile unavailable or ambiguous");
		const inputKey = request.api === "openai-completions" ? "messages" : "input";
		let input = body[inputKey];
		let retained = 0;
		if (request.retainedPrefix) {
			const prefix = request.retainedPrefix;
			const models = profile?.responseModels ?? (model ? [model] : []);
			if (
				request.api !== "openai-codex-responses" ||
				!Array.isArray(input) ||
				!count(prefix.inputItems) ||
				prefix.inputItems > input.length ||
				!count(prefix.inputTokens) ||
				!count(prefix.outputTokens) ||
				!prefix.responseModel ||
				!models.includes(prefix.responseModel)
			)
				unknown.push("retained-state token coverage unknown");
			else {
				retained = prefix.inputTokens + prefix.outputTokens;
				input = input.slice(prefix.inputItems);
			}
		}
		if ((body.previous_response_id || body.conversation) && !request.retainedPrefix)
			unknown.push("external retained-state token coverage unknown");
		if (!textInput(request.api, input)) unknown.push("media, opaque or unsupported replay token coverage unknown");
		if (body.n !== undefined && body.n !== 1) unknown.push("multiple-output reservation unknown");
		if (body.modalities !== undefined && JSON.stringify(body.modalities) !== '["text"]')
			unknown.push("non-text output reservation unknown");
		let output: unknown = profile?.outputCeilingTokens;
		if (request.api === "openai-responses") output = body.max_output_tokens ?? output;
		else if (request.api === "openai-completions") {
			if (body.max_tokens !== undefined && body.max_completion_tokens !== undefined)
				unknown.push("conflicting output limits");
			output = body.max_completion_tokens ?? body.max_tokens ?? output;
		} else if (
			body.max_output_tokens !== undefined ||
			body.max_tokens !== undefined ||
			body.max_completion_tokens !== undefined
		)
			unknown.push("Codex output-option semantics unknown");
		if (!count(output) || output < 1) unknown.push("output reservation unknown");
		const configuration = Object.fromEntries(
			Object.entries(body).filter(
				([key]) => ![inputKey, "instructions", "previous_response_id", "prompt_cache_key"].includes(key),
			),
		);
		const key = JSON.stringify([profile ?? null, configuration]);
		if (this.key !== key) {
			this.key = key;
			this.calibration = unknownCalibration();
			this.calibrationIdentity = {};
		}
		const calibration = { ...this.calibration };
		const measuredBody = request.retainedPrefix ? { ...body, [inputKey]: input } : body;
		const estimate =
			profile && unknown.length === 0
				? Math.ceil(bytes(JSON.stringify(measuredBody)) * profile.estimate.tokensPerUtf8Byte) +
					profile.estimate.templateTokens +
					retained
				: null;
		const margin = profile ? profile.estimate.marginTokens + (calibration.maxUnderestimateTokens ?? 0) : null;
		const available = profile && count(output) && margin !== null ? profile.contextTokens - output - margin : null;
		if ((estimate !== null && !count(estimate)) || !count(retained)) unknown.push("token estimate overflow");
		const status = unknown.length
			? "unknown"
			: profile && count(output) && (output > profile.outputCeilingTokens || estimate! > available!)
				? "over-budget"
				: "within-estimate";
		const assessment: RequestTokenAssessment = Object.freeze({
			profile: profile
				? Object.freeze({
						id: profile.id,
						revision: profile.revision,
						authMode: profile.authMode,
						templateRevision: profile.templateRevision,
						replayFamily: profile.replayFamily,
					})
				: null,
			api: request.api,
			provider: request.provider,
			model,
			route,
			limitSource: profile ? "explicit-profile" : "unknown",
			counter: "conservative-profile-estimate",
			status,
			unknown: Object.freeze(unknown),
			serializedBytes: request.body === undefined ? null : bytes(request.body),
			estimatedInputTokens: unknown.length ? null : estimate,
			retainedInputTokens: retained,
			outputReserveTokens: count(output) ? output : null,
			reasoningReservation: profile ? "included-in-output" : "unknown",
			contextTokens: profile?.contextTokens ?? null,
			marginTokens: margin,
			availableInputTokens: available,
			calibration: Object.freeze(calibration),
			aggressivePacking: false,
		});
		if (profile && estimate !== null && !unknown.length)
			this.measured.set(assessment, {
				identity: this.calibrationIdentity,
				estimate,
				models: profile.responseModels ?? [profile.model],
			});
		return assessment;
	}

	assert(assessment: RequestTokenAssessment): void {
		if (this.options.mode === "enforce" && assessment.status !== "within-estimate")
			throw new RequestTokenBudgetError(assessment);
	}

	/** Call only after the SAME ordinary settlement has been acknowledged by its existing owner. */
	observe(receipt: ProviderAttemptReceipt): void {
		const assessment = receipt.requestBudget;
		const measured = assessment && this.measured.get(assessment);
		if (
			!measured ||
			measured.identity !== this.calibrationIdentity ||
			receipt.outcome !== "completed" ||
			receipt.capacityConfirmed ||
			receipt.usageCompleteness !== "complete" ||
			!count(receipt.usage.inputTotal) ||
			!receipt.responseModel ||
			!measured.models.includes(receipt.responseModel)
		)
			return;
		const error = receipt.usage.inputTotal - measured.estimate;
		this.calibration = {
			state: "observed",
			samples: this.calibration.samples + 1,
			maxUnderestimateTokens: Math.max(this.calibration.maxUnderestimateTokens ?? 0, error),
			maxOverestimateTokens: Math.max(this.calibration.maxOverestimateTokens ?? 0, -error),
		};
	}
}
