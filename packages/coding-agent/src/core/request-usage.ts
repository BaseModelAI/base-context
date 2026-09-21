import type { ProviderAttemptUsage } from "@ponythewhite/base-context-ai";
import type { NativeRequestEvent, RequestPurpose } from "./request-events.js";

export type RequestUsagePurpose = RequestPurpose | "compaction" | "status";

/** Known generation usage only. Missing usage and prices are not treated as free. */
export interface RequestUsageTotals {
	attempts: number;
	settledAttempts: number;
	partialUsageAttempts: number;
	missingUsageAttempts: number;
	unsettledAttempts: number;
	unpricedAttempts: number;
	input: number;
	inputTotal: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	processedTokens: number;
	catalogEstimateUsd: number;
}

export interface OwnRequestUsage {
	sessionId: string;
	byPurpose: Partial<Record<RequestUsagePurpose, RequestUsageTotals>>;
	total: RequestUsageTotals;
}

export function emptyRequestUsageTotals(): RequestUsageTotals {
	return {
		attempts: 0,
		settledAttempts: 0,
		partialUsageAttempts: 0,
		missingUsageAttempts: 0,
		unsettledAttempts: 0,
		unpricedAttempts: 0,
		input: 0,
		inputTotal: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		processedTokens: 0,
		catalogEstimateUsd: 0,
	};
}

export function addRequestUsageTotals(total: RequestUsageTotals, usage: RequestUsageTotals): void {
	for (const field of Object.keys(total) as (keyof RequestUsageTotals)[]) total[field] += usage[field];
}

function purpose(event: NativeRequestEvent): RequestUsagePurpose {
	if (event.purpose === "native-control" && event.purposeDetail === "daemon-status") return "status";
	if (
		event.purpose === "summary" &&
		(event.purposeDetail === "compaction" || event.purposeDetail === "compaction-turn-prefix")
	)
		return "compaction";
	return event.purpose;
}

function inputTotal(usage: Readonly<ProviderAttemptUsage>): number | undefined {
	if (usage.inputTotal !== undefined) return usage.inputTotal;
	if (usage.input !== undefined && usage.cacheRead !== undefined && usage.cacheWrite !== undefined)
		return usage.input + usage.cacheRead + usage.cacheWrite;
	if (usage.totalTokens !== undefined && usage.output !== undefined) return usage.totalTokens - usage.output;
	return undefined;
}

/** Temporary reduction of existing receipts, never an additional persisted accounting source. */
export class RequestUsageAccumulator {
	private readonly attempts = new Map<string, { purpose: RequestUsagePurpose; totals: RequestUsageTotals }>();

	constructor(private readonly sessionId: string) {}

	add(event: NativeRequestEvent): void {
		if (
			event.source.sessionId !== this.sessionId ||
			(event.purpose === "native-control" && event.purposeDetail === "input-token-count")
		)
			return;
		const previous = this.attempts.get(event.attemptId);
		// An admission cannot replace a settlement. Later settled receipts replace earlier copies.
		if (event.type === "attempt_admitted" && previous) return;
		const totals = emptyRequestUsageTotals();
		totals.attempts = 1;
		if (event.type === "attempt_admitted") {
			totals.unsettledAttempts = 1;
		} else {
			totals.settledAttempts = 1;
			const { usage, usageCompleteness } = event.receipt;
			const incompleteBuckets = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite].some(
				(value) => value === undefined,
			);
			totals.partialUsageAttempts =
				usageCompleteness === "partial" || (usageCompleteness !== "none" && incompleteBuckets) ? 1 : 0;
			totals.missingUsageAttempts = usageCompleteness === "none" ? 1 : 0;
			totals.input = usage.input ?? 0;
			totals.inputTotal = inputTotal(usage) ?? (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
			totals.output = usage.output ?? 0;
			totals.cacheRead = usage.cacheRead ?? 0;
			totals.cacheWrite = usage.cacheWrite ?? 0;
			const input = inputTotal(usage);
			totals.processedTokens =
				input !== undefined && usage.output !== undefined
					? input + usage.output
					: (usage.totalTokens ?? totals.inputTotal + totals.output);
			const pricing = event.modelContract.pricing;
			const rates =
				pricing.status !== "unavailable" && pricing.currency === "USD" && pricing.unit === "million-tokens"
					? pricing.catalogRates
					: undefined;
			if (
				rates &&
				usage.input !== undefined &&
				usage.output !== undefined &&
				usage.cacheRead !== undefined &&
				usage.cacheWrite !== undefined
			) {
				totals.catalogEstimateUsd =
					(usage.input * rates.input +
						usage.output * rates.output +
						usage.cacheRead * rates.cacheRead +
						usage.cacheWrite * rates.cacheWrite) /
					1_000_000;
			} else {
				totals.unpricedAttempts = 1;
			}
		}
		this.attempts.set(event.attemptId, { purpose: purpose(event), totals });
	}

	finish(): OwnRequestUsage | undefined {
		if (this.attempts.size === 0) return undefined;
		const result: OwnRequestUsage = { sessionId: this.sessionId, byPurpose: {}, total: emptyRequestUsageTotals() };
		for (const attempt of this.attempts.values()) {
			const bucket = result.byPurpose[attempt.purpose] ?? emptyRequestUsageTotals();
			result.byPurpose[attempt.purpose] = bucket;
			addRequestUsageTotals(bucket, attempt.totals);
			addRequestUsageTotals(result.total, attempt.totals);
		}
		return result;
	}
}
