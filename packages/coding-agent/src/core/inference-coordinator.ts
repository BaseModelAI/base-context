import { randomUUID } from "node:crypto";
import type { StreamFn } from "@ponythewhite/base-context-agent";
import {
	type Api,
	type AssistantMessage,
	assertBuiltInAttemptSupport,
	type Context,
	completeSimple,
	isLocalFauxStream,
	type Model,
	type ProviderAttemptObserver,
	type SimpleStreamOptions,
	streamSimple,
} from "@ponythewhite/base-context-ai";
import type {
	BoundRequestSink,
	NativeRequestMetadata,
	RequestOwnerRef,
	RequestPurpose,
	ResolvedModelContract,
} from "./request-events.js";
import { hashTurnBody, MODEL_REQUEST_ID_HEADER, unwrapSemanticEdgeStreamFn } from "./semantic-edges.js";

export interface InferenceRequestOptions {
	readonly purpose: RequestPurpose;
	readonly purposeDetail?: string;
	readonly operationId?: string;
	readonly parentOperationId?: string;
	readonly semanticEdgeId?: string;
}

export interface InferenceSettlement {
	readonly message: AssistantMessage;
	readonly operationId: string;
	readonly attemptIds: readonly string[];
	/** Reporting is not a guarantee about an opaque adapter's hidden retries. */
	readonly physicalCoverage: "reported" | "unestablished" | "local-simulation";
}

export interface InferenceRun {
	readonly events: Awaited<ReturnType<StreamFn>>;
	readonly settled: Promise<InferenceSettlement>;
}

export interface SessionRuntimeServices {
	readonly requests: InferenceCoordinator;
}

interface SinkUse {
	readonly sink: BoundRequestSink;
	activeUsers: number;
	captures: number;
	release?: Promise<void>;
}

interface BoundOperation {
	readonly binding: SinkUse;
	readonly owner: Omit<RequestOwnerRef, "sessionId">;
	readonly metadata: Omit<NativeRequestMetadata, "source" | "owner">;
}

const REQUEST_STREAM_BINDING = Symbol("base-context.request-stream-binding");
interface StreamBinding {
	readonly coordinator: InferenceCoordinator;
	readonly inner: StreamFn;
}
type BoundStreamFn = StreamFn & { [REQUEST_STREAM_BINDING]?: StreamBinding };

function modelContract(model: Model<Api>): ResolvedModelContract {
	return {
		api: model.api,
		provider: model.provider,
		model: model.id,
		profile: { id: "native-default", status: "unvalidated" },
		pricing: {
			status: "unvalidated",
			currency: "USD",
			unit: "million-tokens",
			catalogRates: {
				input: model.cost.input,
				output: model.cost.output,
				cacheRead: model.cost.cacheRead,
				cacheWrite: model.cost.cacheWrite,
			},
		},
	};
}

const nativeStreamFunctions = new WeakSet<StreamFn>();

/** Internal SDK auth/options resolver; transport stays the known instrumented AI dispatcher. */
export function createNativeInferenceStream(
	resolveOptions: (
		model: Model<Api>,
		context: Context,
		options: SimpleStreamOptions | undefined,
	) => Promise<SimpleStreamOptions>,
): StreamFn {
	const dispatch: StreamFn = async (model, context, options) => {
		const resolved = await resolveOptions(model, context, options);
		return streamSimple(model, context, {
			...resolved,
			signal: options?.signal,
			attempts: options?.attempts,
			requireProviderAttempts: true,
		});
	};
	nativeStreamFunctions.add(dispatch);
	return dispatch;
}

/** Routes physical observations to the source writer. It owns no receipt store. */
export class InferenceCoordinator {
	private retryTurn = false;
	private active = new Set<Promise<void>>();
	private capturedSink?: SinkUse;
	private captureReserved = false;
	private finishCapturePending?: () => void;
	private disposed = false;
	private disposal?: Promise<void>;
	private work = {
		pending: new Set<Promise<void>>(),
		sinks: new WeakMap<BoundRequestSink, SinkUse>(),
		listeners: new Set<() => void>(),
		admissionOpen: true,
		cancellation: new AbortController(),
	};

	get hasPending(): boolean {
		return this.work.pending.size > 0;
	}
	get pendingCount(): number {
		return this.work.pending.size;
	}

	onActivityChange(listener: () => void): () => void {
		this.work.listeners.add(listener);
		return () => this.work.listeners.delete(listener);
	}

	private notifyActivity(): void {
		// Observers can wake an existing owner, but cannot own request settlement.
		for (const listener of this.work.listeners) {
			try {
				listener();
			} catch {
				/* Notification is not execution. */
			}
		}
	}

	/** Owner teardown stops new sends, but never suppresses an admitted request's settlement. */
	stopAdmission(): void {
		this.work.admissionOpen = false;
		this.work.cancellation.abort();
		this.notifyActivity();
	}

	async waitForIdle(): Promise<void> {
		while (this.work.pending.size > 0) await Promise.all([...this.work.pending]);
	}

	prepareTurnRetry(): void {
		this.retryTurn = true;
	}
	clearTurnRetry(): void {
		this.retryTurn = false;
	}

	constructor(
		private readonly bindSink: () => BoundRequestSink,
		private readonly owner: () => Omit<RequestOwnerRef, "sessionId"> = () => ({}),
	) {}

	private assertAdmission(): void {
		if (this.disposed || !this.work.admissionOpen) throw new Error("Inference owner is closing");
	}

	private sinkUse(sink: BoundRequestSink): SinkUse {
		let binding = this.work.sinks.get(sink);
		if (!binding) {
			binding = { sink, activeUsers: 0, captures: 0 };
			this.work.sinks.set(sink, binding);
		}
		return binding;
	}

	private releaseCapture(): void {
		if (this.captureReserved && this.capturedSink) {
			this.captureReserved = false;
			this.capturedSink.captures--;
		}
	}

	/** Capture an auxiliary operation's subject before asynchronous auth or UI work. */
	capture(): InferenceCoordinator {
		this.assertAdmission();
		const owner = Object.freeze({ ...this.owner() });
		const binding = this.sinkUse(this.bindSink());
		binding.sink.retain();
		binding.release = undefined;
		binding.captures++;
		const captured = new InferenceCoordinator(
			() => binding.sink,
			() => owner,
		);
		captured.work = this.work;
		captured.capturedSink = binding;
		captured.captureReserved = true;
		let release!: () => void;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		this.work.pending.add(pending);
		captured.finishCapturePending = () => {
			this.work.pending.delete(pending);
			captured.finishCapturePending = undefined;
			release();
			this.notifyActivity();
		};
		this.notifyActivity();
		return captured;
	}

	/** Release an unused capture, or join this capture's admitted requests. */
	dispose(): Promise<void> {
		this.disposed = true;
		this.disposal ??= (async () => {
			this.releaseCapture();
			try {
				await Promise.all([...this.active]);
				if (this.capturedSink) await this.finishSink(this.capturedSink, [], false, []);
			} finally {
				this.finishCapturePending?.();
			}
		})();
		return this.disposal;
	}

	private bindOperation(model: Model<Api>, request: InferenceRequestOptions, operationId: string): BoundOperation {
		this.assertAdmission();
		const owner = Object.freeze({ ...this.owner() });
		const metadata = Object.freeze({
			operationId,
			parentOperationId: request.parentOperationId,
			semanticEdgeId: request.semanticEdgeId,
			purpose: request.purpose,
			purposeDetail: request.purposeDetail,
			modelContract: modelContract(model),
		});
		return { binding: this.sinkUse(this.bindSink()), owner, metadata };
	}

	private async finishSink(
		binding: SinkUse,
		writes: readonly Promise<void>[],
		activeUser: boolean,
		failures: unknown[],
	): Promise<void> {
		const results = await Promise.allSettled([binding.sink.source, ...writes]);
		for (const result of results) {
			if (result.status === "rejected") failures.push(result.reason);
		}
		if (activeUser) binding.activeUsers--;
		try {
			if (binding.activeUsers === 0 && binding.captures === 0) {
				binding.release ??= binding.sink.release();
				await binding.release;
			}
		} catch (error) {
			failures.push(error);
		}
		const distinct = [...new Set(failures)];
		if (distinct.length === 1) throw distinct[0];
		if (distinct.length > 1) throw new AggregateError(distinct, "Inference request or source cleanup failed");
	}

	private async execute(
		operation: BoundOperation,
		model: Model<Api>,
		context: Context,
		options: SimpleStreamOptions | undefined,
		send: StreamFn,
	): Promise<InferenceRun> {
		let release!: (completion?: PromiseLike<void>) => void;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		this.work.pending.add(pending);
		this.active.add(pending);
		this.notifyActivity();
		const finish = () => {
			this.work.pending.delete(pending);
			this.active.delete(pending);
			this.notifyActivity();
		};
		const attemptIds: string[] = [];
		const receiptWrites: Promise<void>[] = [];
		let activeUser = false;
		let localSimulation = false;
		const settle = async (result: Promise<AssistantMessage>): Promise<InferenceSettlement> => {
			const failures: unknown[] = [];
			let message: AssistantMessage | undefined;
			try {
				message = await result;
			} catch (error) {
				failures.push(error);
			}
			await this.finishSink(operation.binding, receiptWrites, activeUser, failures);
			return {
				message: message!,
				operationId: operation.metadata.operationId,
				attemptIds,
				physicalCoverage: attemptIds.length ? "reported" : localSimulation ? "local-simulation" : "unestablished",
			};
		};
		try {
			this.assertAdmission();
			operation.binding.sink.retain();
			operation.binding.release = undefined;
			operation.binding.activeUsers++;
			activeUser = true;
			this.releaseCapture();
			this.finishCapturePending?.();
			const source = Object.freeze({ ...(await operation.binding.sink.source) });
			const metadata: NativeRequestMetadata = {
				...operation.metadata,
				source,
				owner: Object.freeze({ ...operation.owner, sessionId: source.sessionId }),
			};
			if (send !== streamSimple && !nativeStreamFunctions.has(send)) {
				throw new Error(
					"Native inference cannot admit a custom or proxy StreamFn with unestablished physical-attempt coverage. Use the SDK's instrumented built-in API route instead.",
				);
			}
			assertBuiltInAttemptSupport(model.api);
			if (!this.work.admissionOpen) throw new Error("Inference owner is closing");
			const attempts: ProviderAttemptObserver = {
				admit: async (descriptor) => {
					if (!this.work.admissionOpen) throw new Error("Inference owner is closing");
					const attemptId = randomUUID();
					const write = operation.binding.sink.persist({
						...metadata,
						type: "attempt_admitted",
						attemptId,
						timestamp: Date.now(),
						descriptor,
					});
					receiptWrites.push(write);
					await write;
					attemptIds.push(attemptId);
					return attemptId;
				},
				settle: async (receipt) => {
					const write = operation.binding.sink.persist({
						...metadata,
						type: "attempt_settled",
						attemptId: receipt.attemptId,
						timestamp: Date.now(),
						receipt,
					});
					receiptWrites.push(write);
					await write;
				},
			};
			const signal = options?.signal
				? AbortSignal.any([options.signal, this.work.cancellation.signal])
				: this.work.cancellation.signal;
			const events = await send(model, context, { ...options, signal, attempts, requireProviderAttempts: true });
			localSimulation = isLocalFauxStream(events);
			const settled = settle(events.result());
			events.result = async () => (await settled).message;
			// Idle tracking observes rejection; callers still receive it through settled/result().
			release(settled.then(finish, finish));
			return { events, settled };
		} catch (error) {
			try {
				await settle(Promise.reject(error));
			} finally {
				finish();
				release();
			}
			throw error;
		}
	}

	async start(
		model: Model<Api>,
		context: Context,
		options: SimpleStreamOptions | undefined,
		request: InferenceRequestOptions,
	): Promise<InferenceRun> {
		const semanticEdgeId = request.semanticEdgeId ?? options?.headers?.[MODEL_REQUEST_ID_HEADER];
		const operationId = request.operationId ?? semanticEdgeId ?? randomUUID();
		return this.execute(
			this.bindOperation(model, { ...request, semanticEdgeId }, operationId),
			model,
			context,
			options,
			streamSimple,
		);
	}

	async complete(
		model: Model<Api>,
		context: Context,
		options: SimpleStreamOptions | undefined,
		request: InferenceRequestOptions,
	): Promise<AssistantMessage> {
		return (await (await this.start(model, context, options, request)).settled).message;
	}

	bindStream(streamFn: StreamFn, request: InferenceRequestOptions): StreamFn {
		const unwrapped = unwrapSemanticEdgeStreamFn(streamFn) as BoundStreamFn;
		const inner = unwrapped[REQUEST_STREAM_BINDING]?.inner ?? unwrapped;
		// One Agent stream is serial. Keep only its latest binding for semantic retries.
		// A side question or child gets its own closure, not the parent's source binding.
		let previous: BoundOperation | undefined;
		let previousBody: string | undefined;
		const wrapped: BoundStreamFn = async (model, context, options) => {
			const semanticEdgeId = request.semanticEdgeId ?? options?.headers?.[MODEL_REQUEST_ID_HEADER];
			// Reuse the existing semantic body identity if its best-effort recorder is unavailable.
			const body = semanticEdgeId ? undefined : hashTurnBody(model, context, options);
			const retryId =
				this.retryTurn && body !== undefined && body === previousBody ? previous?.metadata.operationId : undefined;
			this.retryTurn = false;
			const operationId = request.operationId ?? semanticEdgeId ?? retryId ?? randomUUID();
			previousBody = body;
			if (previous?.metadata.operationId !== operationId) {
				previous = this.bindOperation(model, { ...request, semanticEdgeId }, operationId);
			}
			return (await this.execute(previous, model, context, options, inner)).events;
		};
		wrapped[REQUEST_STREAM_BINDING] = { coordinator: this, inner };
		return wrapped;
	}
}

/** Standalone helper embedding stays optional; native session callers always supply requests. */
export function completeInference(
	requests: InferenceCoordinator | undefined,
	model: Model<Api>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	request: InferenceRequestOptions,
): Promise<AssistantMessage> {
	return requests ? requests.complete(model, context, options, request) : completeSimple(model, context, options);
}

export type DisposableInferenceStream = StreamFn & { dispose(): Promise<void> };

/** Side questions keep the subject's writer, but get their own operation and purpose. */
export function bindAuxiliaryInferenceStream(
	streamFn: StreamFn,
	request: InferenceRequestOptions,
): DisposableInferenceStream {
	const inner = unwrapSemanticEdgeStreamFn(streamFn) as BoundStreamFn;
	const binding = inner[REQUEST_STREAM_BINDING];
	const captured = binding?.coordinator.capture();
	const stream: StreamFn =
		captured && binding
			? captured.bindStream(binding.inner, request)
			: (model, context, options) => inner(model, context, options);
	return Object.assign(stream, {
		dispose: async () => {
			await captured?.dispose();
		},
	});
}
