import type {
	Api,
	AssistantMessage,
	Model,
	ProviderAttemptInfo,
	ProviderAttemptOutcome,
	ProviderAttemptReceipt,
	ProviderAttemptUsage,
	ProviderUsageCompleteness,
	StreamOptions,
} from "../types.js";
import type { AssistantMessageEventStream } from "./event-stream.js";

interface ActiveAttempt {
	info: ProviderAttemptInfo;
	id: string;
	queuedAt: number;
	admittedAt: number;
	sentAt?: number;
	firstEventAt?: number;
	firstContentAt?: number;
	lastEventAt?: number;
	status?: number;
	providerRequestId?: string;
	providerResponseId?: string;
	responseModel?: string;
	effectiveEffort?: string;
	effectiveServiceTier?: string | null;
	outcome?: ProviderAttemptOutcome;
	capacityConfirmed?: true;
	rawUsage: unknown[];
	usage: ProviderAttemptUsage;
	usageCompleteness: ProviderUsageCompleteness;
	invalidUsage?: boolean;
}

type AttemptDetails = Partial<Pick<ProviderAttemptInfo, "kind" | "previousResponseId" | "effort" | "serviceTier">>;
type ResponseDetails = Pick<
	ProviderAttemptReceipt,
	"providerRequestId" | "providerResponseId" | "responseModel" | "effectiveEffort" | "effectiveServiceTier"
>;

/** Per-stream transport state only. Admission and durable settlement belong to the embedding runtime. */
export class ProviderAttemptTracker {
	private ordinal = 0;
	private active?: ActiveAttempt;
	private persistenceError?: unknown;
	private details: AttemptDetails = {};

	constructor(
		private readonly model: Pick<Model<Api>, "api" | "provider" | "id">,
		private readonly options?: Pick<StreamOptions, "attempts" | "signal">,
	) {}

	get enabled(): boolean {
		return this.options?.attempts !== undefined;
	}

	configure(details: AttemptDetails): void {
		this.details = { ...this.details, ...details };
	}

	async begin(transport: ProviderAttemptInfo["transport"], details: AttemptDetails = {}): Promise<void> {
		const observer = this.options?.attempts;
		if (!observer) return;
		if (this.persistenceError !== undefined) throw this.persistenceError;
		// An SDK may retry after headers but before handing the body to its caller.
		if (this.active) await this.settle("interrupted");
		const queuedAt = Date.now();
		const info: ProviderAttemptInfo = {
			api: this.model.api,
			provider: this.model.provider,
			model: this.model.id,
			transport,
			ordinal: ++this.ordinal,
			kind: this.ordinal === 1 ? "initial" : "retry",
			...this.details,
			...details,
		};
		let id: string;
		try {
			id = await observer.admit(info);
		} catch (error) {
			this.persistenceError = error;
			throw error;
		}
		this.active = { info, id, queuedAt, admittedAt: Date.now(), rawUsage: [], usage: {}, usageCompleteness: "none" };
	}

	sent(): void {
		if (this.active) this.active.sentAt = Date.now();
	}

	httpResponse(status: number, headers: Headers | Record<string, string>): void {
		if (!this.active) return;
		this.active.status = status;
		const get = (name: string): string | undefined =>
			headers instanceof Headers
				? (headers.get(name) ?? undefined)
				: Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
		this.active.providerRequestId =
			get("x-request-id") ?? get("request-id") ?? get("x-amzn-requestid") ?? get("x-amz-request-id");
	}

	response(details: ResponseDetails): void {
		if (!this.active) return;
		for (const key of Object.keys(details) as (keyof ResponseDetails)[]) {
			const value = details[key];
			if (value !== undefined) Object.assign(this.active, { [key]: value });
		}
	}

	event(content = false): void {
		if (!this.active) return;
		const now = Date.now();
		this.active.firstEventAt ??= now;
		this.active.lastEventAt = now;
		if (content) this.active.firstContentAt ??= now;
	}

	usage(raw: unknown, usage: ProviderAttemptUsage, completeness: "partial" | "complete"): void {
		if (!this.active || raw === undefined || raw === null) return;
		this.active.rawUsage.push(structuredClone(raw));
		for (const key of Object.keys(usage) as (keyof ProviderAttemptUsage)[]) {
			const value = usage[key];
			if (value === undefined) continue;
			if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
				delete this.active.usage[key];
				this.active.invalidUsage = true;
			} else {
				this.active.usage[key] = value;
			}
		}
		const observed = this.active.usage;
		if (observed.input !== undefined && observed.cacheRead !== undefined && observed.cacheWrite !== undefined) {
			const inputTotal = observed.input + observed.cacheRead + observed.cacheWrite;
			if (usage.inputTotal === undefined) observed.inputTotal = inputTotal;
			if (usage.totalTokens === undefined && observed.output !== undefined)
				observed.totalTokens = inputTotal + observed.output;
		}
		for (const key of Object.keys(observed) as (keyof ProviderAttemptUsage)[]) {
			if (!Number.isFinite(observed[key])) {
				delete observed[key];
				this.active.invalidUsage = true;
			}
		}
		const knownInputParts = [observed.input, observed.cacheRead, observed.cacheWrite]
			.filter((value): value is number => value !== undefined)
			.reduce((sum, value) => sum + value, 0);
		if (
			(observed.inputTotal !== undefined && knownInputParts > observed.inputTotal) ||
			(observed.totalTokens !== undefined &&
				((observed.inputTotal !== undefined && observed.inputTotal > observed.totalTokens) ||
					(observed.output !== undefined && observed.output > observed.totalTokens) ||
					(observed.inputTotal !== undefined &&
						observed.output !== undefined &&
						observed.inputTotal + observed.output > observed.totalTokens)))
		) {
			this.active.invalidUsage = true;
		}
		if (
			this.active.invalidUsage ||
			(observed.input === undefined && observed.inputTotal === undefined) ||
			observed.output === undefined
		)
			this.active.usageCompleteness = "partial";
		else if (this.active.usageCompleteness !== "complete") this.active.usageCompleteness = completeness;
	}

	/** Only provider error payloads belong here, never generated text or caller exceptions. */
	providerError(error: unknown): void {
		if (!this.active) return;
		const confirmed = "Selected model is at capacity.";
		let payload = error;
		if (typeof payload === "string" && payload !== confirmed) {
			try {
				payload = JSON.parse(payload);
			} catch {
				return;
			}
		}
		const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : undefined;
		const nested =
			record?.error && typeof record.error === "object" ? (record.error as Record<string, unknown>) : undefined;
		if (
			payload === confirmed ||
			record?.message === confirmed ||
			record?.error === confirmed ||
			nested?.message === confirmed
		) {
			this.active.capacityConfirmed = true;
		}
	}

	/** Provider protocol termination, not the caller's output/checkpoint decision. */
	terminal(outcome: ProviderAttemptOutcome = "completed"): void {
		if (this.active) this.active.outcome = outcome;
	}

	wrapFetch(fetch: typeof globalThis.fetch = globalThis.fetch): typeof globalThis.fetch {
		return this.wrapHttp(fetch);
	}

	/** Wrap an SDK's single-send method, below its retry loop. */
	wrapHttp<TArgs extends unknown[]>(
		send: (...args: TArgs) => Promise<Response>,
	): (...args: TArgs) => Promise<Response> {
		if (!this.enabled) return send;
		return async (...args) => {
			await this.begin("http");
			this.sent();
			let response: Response;
			try {
				response = await send(...args);
			} catch (error) {
				await this.settle(this.options?.signal?.aborted ? "cancelled" : "failed");
				throw error;
			}
			this.httpResponse(response.status, response.headers);
			if (!response.ok) {
				// Observe before the SDK retry erases this response. Retain only the exact marker.
				try {
					this.providerError(await response.clone().text());
				} catch {
					/* No readable provider message. */
				}
				await this.settle("failed");
			}
			return response;
		};
	}

	async settle(outcome: ProviderAttemptOutcome): Promise<void> {
		const attempt = this.active;
		if (!attempt) return;
		this.active = undefined;
		const receipt: ProviderAttemptReceipt = {
			...attempt.info,
			attemptId: attempt.id,
			outcome:
				attempt.outcome ??
				(attempt.status !== undefined && (attempt.status < 200 || attempt.status >= 300) ? "failed" : outcome),
			status: attempt.status,
			capacityConfirmed: attempt.capacityConfirmed,
			providerRequestId: attempt.providerRequestId,
			providerResponseId: attempt.providerResponseId,
			responseModel: attempt.responseModel,
			effectiveEffort: attempt.effectiveEffort,
			effectiveServiceTier: attempt.effectiveServiceTier,
			rawUsage: attempt.rawUsage,
			usage: attempt.usage,
			usageCompleteness: attempt.usageCompleteness,
			timing: {
				queuedAt: attempt.queuedAt,
				admittedAt: attempt.admittedAt,
				sentAt: attempt.sentAt,
				firstEventAt: attempt.firstEventAt,
				firstContentAt: attempt.firstContentAt,
				lastEventAt: attempt.lastEventAt,
				settledAt: Date.now(),
			},
		};
		try {
			await this.options!.attempts!.settle(receipt);
		} catch (error) {
			this.persistenceError = error;
			throw error;
		}
	}

	/** Always terminates the native stream, including when the persistence sink rejects. */
	async finish(stream: AssistantMessageEventStream, output: AssistantMessage): Promise<void> {
		this.response({ providerResponseId: output.responseId, responseModel: output.responseModel });
		try {
			await this.settle(output.stopReason === "aborted" ? "cancelled" : "interrupted");
		} catch (error) {
			output.stopReason = "error";
			output.errorMessage = `Attempt settlement failed: ${error instanceof Error ? error.message : String(error)}`;
		}
		if (output.stopReason === "error" || output.stopReason === "aborted") {
			stream.push({ type: "error", reason: output.stopReason, error: output });
		} else {
			stream.push({ type: "done", reason: output.stopReason, message: output });
		}
		stream.end(output);
	}
}
