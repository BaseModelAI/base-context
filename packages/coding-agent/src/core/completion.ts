export interface CompletionBlocker {
	kind: string;
	sessionId?: string;
	id?: string;
	count?: number;
}

export interface CompletionWaitDiagnostics {
	complete: false;
	elapsedMs: number;
	blockers: CompletionBlocker[];
}

export class CompletionWaitTimeoutError extends Error {
	constructor(readonly diagnostics: CompletionWaitDiagnostics) {
		super("Completion wait timed out");
		this.name = "CompletionWaitTimeoutError";
	}
}

export function validateCompletionTimeout(timeoutMs: number | undefined): void {
	if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 0)) {
		throw new Error("timeoutMs must be finite and nonnegative");
	}
}

/** Stop observing a promise without cancelling the work it represents. */
export function observeCompletion<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return work;
	if (signal.aborted) {
		void work.catch(() => undefined);
		return Promise.reject(signal.reason);
	}
	return new Promise<T>((resolve, reject) => {
		const abort = () => {
			signal.removeEventListener("abort", abort);
			reject(signal.reason);
		};
		signal.addEventListener("abort", abort, { once: true });
		work.then(
			(value) => {
				signal.removeEventListener("abort", abort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", abort);
				reject(error);
			},
		);
	});
}

export async function withCompletionDeadline<T>(
	operation: (signal?: AbortSignal) => Promise<T>,
	options: { timeoutMs?: number; signal?: AbortSignal; getBlockers: () => CompletionBlocker[] },
): Promise<T> {
	validateCompletionTimeout(options.timeoutMs);
	if (options.timeoutMs === undefined && !options.signal) return operation();
	const startedAt = performance.now();
	const controller = new AbortController();
	const abort = () => controller.abort(options.signal?.reason);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const schedule = () => {
		const elapsedMs = performance.now() - startedAt;
		const remaining = options.timeoutMs! - elapsedMs;
		if (remaining <= 0) {
			controller.abort(
				new CompletionWaitTimeoutError({ complete: false, elapsedMs, blockers: options.getBlockers() }),
			);
		} else {
			timer = setTimeout(schedule, Math.min(remaining, 2_147_483_647));
		}
	};
	options.signal?.addEventListener("abort", abort, { once: true });
	if (options.signal?.aborted) abort();
	if (options.timeoutMs !== undefined) schedule();
	try {
		controller.signal.throwIfAborted();
		return await observeCompletion(operation(controller.signal), controller.signal);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		options.signal?.removeEventListener("abort", abort);
	}
}
