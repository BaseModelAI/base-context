import { randomUUID } from "node:crypto";
import type { StreamFn } from "@ponythewhite/base-context-agent";
import {
	type Api,
	type AssistantMessage,
	assertBuiltInAttemptSupport,
	type Context,
	completeSimple,
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
	readonly physicalCoverage: "reported" | "unestablished";
}

export interface InferenceRun {
	readonly events: Awaited<ReturnType<StreamFn>>;
	readonly settled: Promise<InferenceSettlement>;
}

export interface SessionRuntimeServices {
	readonly requests: InferenceCoordinator;
}

interface BoundOperation {
	readonly sink: BoundRequestSink;
	readonly metadata: NativeRequestMetadata;
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
	private work = {
		pending: new Set<Promise<void>>(),
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

	/** Capture an auxiliary operation's subject before asynchronous auth or UI work. */
	capture(): InferenceCoordinator {
		const sink = this.bindSink();
		const owner = { ...this.owner() };
		const captured = new InferenceCoordinator(
			() => sink,
			() => owner,
		);
		captured.work = this.work;
		return captured;
	}

	private bindOperation(model: Model<Api>, request: InferenceRequestOptions, operationId: string): BoundOperation {
		const sink = this.bindSink();
		return {
			sink,
			metadata: {
				operationId,
				parentOperationId: request.parentOperationId,
				semanticEdgeId: request.semanticEdgeId,
				source: Object.freeze({ ...sink.source }),
				owner: Object.freeze({ ...this.owner(), sessionId: sink.source.sessionId }),
				purpose: request.purpose,
				purposeDetail: request.purposeDetail,
				modelContract: modelContract(model),
			},
		};
	}

	private async execute(
		operation: BoundOperation,
		model: Model<Api>,
		context: Context,
		options: SimpleStreamOptions | undefined,
		send: StreamFn,
	): Promise<InferenceRun> {
		if (send !== streamSimple && !nativeStreamFunctions.has(send)) {
			throw new Error(
				"Native inference cannot admit a custom or proxy StreamFn with unestablished physical-attempt coverage. Use the SDK's instrumented built-in API route instead.",
			);
		}
		assertBuiltInAttemptSupport(model.api);
		if (!this.work.admissionOpen) throw new Error("Inference owner is closing");
		const attemptIds: string[] = [];
		const settlementWrites: Promise<void>[] = [];
		const attempts: ProviderAttemptObserver = {
			admit: async (descriptor) => {
				if (!this.work.admissionOpen) throw new Error("Inference owner is closing");
				const attemptId = randomUUID();
				await operation.sink.persist({
					...operation.metadata,
					type: "attempt_admitted",
					attemptId,
					timestamp: Date.now(),
					descriptor,
				});
				attemptIds.push(attemptId);
				return attemptId;
			},
			settle: async (receipt) => {
				const write = operation.sink.persist({
					...operation.metadata,
					type: "attempt_settled",
					attemptId: receipt.attemptId,
					timestamp: Date.now(),
					receipt,
				});
				settlementWrites.push(write);
				await write;
			},
		};
		let release!: () => void;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		this.work.pending.add(pending);
		this.notifyActivity();
		const finish = () => {
			this.work.pending.delete(pending);
			release();
			this.notifyActivity();
		};
		try {
			const signal = options?.signal
				? AbortSignal.any([options.signal, this.work.cancellation.signal])
				: this.work.cancellation.signal;
			const events = await send(model, context, { ...options, signal, attempts, requireProviderAttempts: true });
			const settled = events.result().then(async (message): Promise<InferenceSettlement> => {
				await Promise.all(settlementWrites);
				return {
					message,
					operationId: operation.metadata.operationId,
					attemptIds,
					physicalCoverage: attemptIds.length ? "reported" : "unestablished",
				};
			});
			// Both success and failure release ownership only after the receipt writes settle.
			void settled.then(finish, finish);
			return { events, settled };
		} catch (error) {
			await Promise.allSettled(settlementWrites);
			finish();
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

/** Side questions keep the subject's writer, but get their own operation and purpose. */
export function bindAuxiliaryInferenceStream(streamFn: StreamFn, request: InferenceRequestOptions): StreamFn {
	const inner = unwrapSemanticEdgeStreamFn(streamFn) as BoundStreamFn;
	const binding = inner[REQUEST_STREAM_BINDING];
	return binding ? binding.coordinator.capture().bindStream(binding.inner, request) : inner;
}
