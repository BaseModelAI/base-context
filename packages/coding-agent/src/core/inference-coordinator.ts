import { randomUUID } from "node:crypto";
import type { AgentMessage, AgentOwnedStreamFn, StreamFn } from "@ponythewhite/base-context-agent";
import {
	type Api,
	type AssistantMessage,
	assertBuiltInAttemptSupport,
	type Context,
	completeSimple,
	invokeRequestMeasurement,
	isLocalFauxStream,
	type Model,
	type ProviderAttemptObserver,
	RequestTokenBudget,
	type RequestTokenBudgetOptions,
	type SimpleStreamOptions,
	streamSimple,
} from "@ponythewhite/base-context-ai";
import type {
	BoundRequestSink,
	ContextEpochEntryRef,
	NativeCompactionRequestOutputAssociation,
	NativeRequestMetadata,
	NativeRequestOutputWriter,
	RequestOwnerRef,
	RequestPurpose,
	ResolvedModelContract,
	SourceSnapshotRef,
} from "./request-events.js";
import {
	type CapturedRequestViewBoundary,
	captureRequestViewBoundary,
	matchesRequestView,
	prepareFixedRequestView,
	type RequestViewCommit,
	type RequestViewFixedPrepare,
	type RequestViewValidate,
	selectRequestView,
} from "./request-view-selection.js";
import { hashTurnBody, MODEL_REQUEST_ID_HEADER, unwrapSemanticEdgeStreamFn } from "./semantic-edges.js";
import type { SessionHistoryReadView } from "./session-history-index.js";
import { captureNativeCompactionOutputSource, captureNativeRequestOutputSource } from "./session-manager.js";

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

/** Private completion identity carries this actual source, never descriptive sink labels. */
export interface NativeCompactionOutputBinding {
	readonly sink: BoundRequestSink;
	readonly output: NativeCompactionRequestOutputAssociation;
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
	readonly metadata: Omit<NativeRequestMetadata, "source" | "owner" | "contextEpoch">;
}

const REQUEST_STREAM_BINDING = Symbol("base-context.request-stream-binding");
/** Internal AgentSession built-in compaction entry, not a public inference option. */
export const captureNativeCompactionRequests = Symbol("base-context.native-compaction-requests");
interface StreamBinding {
	readonly coordinator: InferenceCoordinator;
	readonly inner: StreamFn;
}
type BoundStreamFn = AgentOwnedStreamFn & { [REQUEST_STREAM_BINDING]?: StreamBinding };

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
	#nativeCompactionOutput = false;
	private retryTurn = false;
	private requestViewBoundary?: CapturedRequestViewBoundary;
	private active = new Set<Promise<void>>();
	private capturedSink?: SinkUse;
	private captureReserved = false;
	private finishCapturePending?: () => void;
	private disposed = false;
	private disposal?: Promise<void>;
	private work = {
		pending: new Set<Promise<void>>(),
		sinks: new WeakMap<BoundRequestSink, SinkUse>(),
		mainOutputs: new WeakMap<AssistantMessage, NativeRequestOutputWriter>(),
		compactionSettlements: new WeakMap<InferenceSettlement, NativeCompactionOutputBinding>(),
		compactionCompletions: new WeakMap<Promise<AssistantMessage>, NativeCompactionOutputBinding>(),
		listeners: new Set<() => void>(),
		admissionOpen: true,
		cancellation: new AbortController(),
		budget: undefined as RequestTokenBudget | undefined,
		budgetMode: undefined as RequestTokenBudgetOptions["mode"] | undefined,
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

	/** Consume only this owner's real returned object. Labels and replacement messages remain unassociated. */
	appendMainOutput(message: AssistantMessage, owner: object): Promise<string | undefined> | undefined {
		const write = this.work.mainOutputs.get(message);
		this.work.mainOutputs.delete(message);
		return write?.(owner, message);
	}

	/** Opt in only this new native invocation capture. Ordinary capture() deliberately does not inherit it. */
	[captureNativeCompactionRequests](): InferenceCoordinator {
		const captured = InferenceCoordinator.prototype.capture.call(this);
		captured.#nativeCompactionOutput = true;
		return captured;
	}

	/** Only the original completion promise and captured source can supply a projected-output link. */
	takeCompactionOutput(completion: Promise<AssistantMessage>): NativeCompactionOutputBinding | undefined {
		const binding = this.work.compactionCompletions.get(completion);
		this.work.compactionCompletions.delete(completion);
		return binding?.sink === this.capturedSink?.sink ? binding : undefined;
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
		requestTokenBudget?: RequestTokenBudgetOptions,
	) {
		if (requestTokenBudget) {
			this.work.budget = new RequestTokenBudget(requestTokenBudget);
			this.work.budgetMode = requestTokenBudget.mode;
		}
	}

	/** Copy the configured policy, not this owner's learned request observations. */
	getRequestTokenBudgetOptions(): RequestTokenBudgetOptions | undefined {
		return this.work.budget?.getOptions();
	}

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
	capture(sink?: BoundRequestSink): InferenceCoordinator {
		this.assertAdmission();
		const owner = Object.freeze({ ...this.owner() });
		const binding = this.sinkUse(sink ?? this.bindSink());
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

	/** Explicit Root-owned epoch boundary, on this same captured MAIN source only. */
	bindRequestViewBoundary(
		messages: readonly AgentMessage[],
		commit: RequestViewCommit,
		validate?: RequestViewValidate,
		fixedPrepare?: RequestViewFixedPrepare,
	): void {
		this.assertAdmission();
		if (!this.capturedSink) throw new Error("Request view boundary requires a captured inference owner");
		if (this.requestViewBoundary) throw new Error("Request view boundary is already bound");
		this.requestViewBoundary = captureRequestViewBoundary(messages, commit, validate, fixedPrepare);
	}

	/** Read through an explicit capture, never by recapturing the mutable current session. */
	async readHistory<T>(read: (view: SessionHistoryReadView) => Promise<T>): Promise<T> {
		this.assertAdmission();
		const sink = this.capturedSink?.sink;
		if (!sink?.readHistory) throw new Error("Captured canonical history is unavailable");
		let finish!: () => void;
		const pending = new Promise<void>((resolve) => {
			finish = resolve;
		});
		this.work.pending.add(pending);
		this.active.add(pending);
		this.notifyActivity();
		try {
			return await sink.readHistory(read);
		} finally {
			this.active.delete(pending);
			this.work.pending.delete(pending);
			finish();
			this.notifyActivity();
		}
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
		bindMainOutput = false,
	): Promise<InferenceRun> {
		const outputSource = bindMainOutput ? captureNativeRequestOutputSource(operation.binding.sink) : undefined;
		const part =
			operation.metadata.purpose === "summary"
				? operation.metadata.purposeDetail === "compaction"
					? "history"
					: operation.metadata.purposeDetail === "compaction-turn-prefix"
						? "turn-prefix"
						: undefined
				: undefined;
		const compactionSource =
			this.#nativeCompactionOutput && part && this.capturedSink?.sink === operation.binding.sink
				? captureNativeCompactionOutputSource(operation.binding.sink)
				: undefined;
		let outputSourceRef: SourceSnapshotRef | undefined;
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
		const admittedAttempts: Array<{ attemptId: string; contextEpoch?: ContextEpochEntryRef }> = [];
		const receiptWrites: Promise<void>[] = [];
		let activeUser = false;
		let localSimulation = false;
		let budgetFailure: unknown;
		const settle = async (result: Promise<AssistantMessage>): Promise<InferenceSettlement> => {
			const failures: unknown[] = [];
			let message: AssistantMessage | undefined;
			try {
				message = await result;
			} catch (error) {
				failures.push(error);
			}
			if (budgetFailure !== undefined && !failures.includes(budgetFailure)) failures.push(budgetFailure);
			await this.finishSink(operation.binding, receiptWrites, activeUser, failures);
			if (message && outputSource && outputSourceRef) {
				const write = outputSource({
					operationId: operation.metadata.operationId,
					attemptIds: admittedAttempts.map(({ attemptId }) => attemptId),
					source: outputSourceRef,
				});
				if (write) this.work.mainOutputs.set(message, write);
			}
			const settlement: InferenceSettlement = {
				message: message!,
				operationId: operation.metadata.operationId,
				attemptIds: admittedAttempts.map(({ attemptId }) => attemptId),
				physicalCoverage: admittedAttempts.length
					? "reported"
					: localSimulation
						? "local-simulation"
						: "unestablished",
			};
			if (part && compactionSource && outputSourceRef) {
				const output = compactionSource({
					operationId: settlement.operationId,
					attemptIds: settlement.attemptIds,
					source: outputSourceRef,
				});
				if (output)
					this.work.compactionSettlements.set(settlement, {
						sink: operation.binding.sink,
						output: { ...output, part },
					});
			}
			return settlement;
		};
		try {
			this.assertAdmission();
			operation.binding.sink.retain();
			operation.binding.release = undefined;
			operation.binding.activeUsers++;
			activeUser = true;
			this.releaseCapture();
			this.finishCapturePending?.();
			// Capture the opted-in budgeted invocation before source/auth waits. Callbacks and signals stay live handles.
			if (this.work.budget || (this.requestViewBoundary && operation.metadata.purpose === "main")) {
				model = structuredClone(model);
				// Agent tool objects also carry live executors. Snapshot only the native Tool definition.
				context = structuredClone({
					...context,
					...(context.tools
						? {
								tools: context.tools.map(({ name, description, parameters }) => ({
									name,
									description,
									parameters,
								})),
							}
						: {}),
				});
				options = options
					? {
							...options,
							headers: options.headers ? { ...options.headers } : undefined,
							thinkingBudgets: options.thinkingBudgets ? { ...options.thinkingBudgets } : undefined,
							metadata: options.metadata ? structuredClone(options.metadata) : undefined,
						}
					: undefined;
			}
			const source = Object.freeze({ ...(await operation.binding.sink.source) });
			outputSourceRef = source;
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
			const parentBudget = this.work.budget;
			const boundary = operation.metadata.purpose === "main" ? this.requestViewBoundary : undefined;
			const budget = boundary ? parentBudget?.capture() : parentBudget;
			let measuredForAdmission = false;
			const measureRequest: ProviderAttemptObserver["measureRequest"] =
				budget || boundary?.validate
					? (representation) => {
							try {
								const assessment = budget?.measure(representation);
								boundary?.validate?.(representation, assessment);
								if (budget && assessment) budget.assert(assessment);
								measuredForAdmission = true;
								return assessment;
							} catch (error) {
								budgetFailure = error;
								throw error;
							}
						}
					: undefined;
			const canSelect =
				(budget || boundary?.fixedPrepare) && boundary && matchesRequestView(boundary, source, context);
			const requiredPublic = Boolean(boundary?.pendingPublicMessageGroups?.length);
			if (requiredPublic && (!canSelect || boundary?.fixedPrepare))
				throw new Error("Tool continuation requires a selectable native public request boundary");
			let publicAccepted = false;
			let selectedContextEpoch: ContextEpochEntryRef | undefined;
			const attempts: ProviderAttemptObserver = {
				...(requiredPublic
					? { pendingPublicMessageGroups: boundary!.pendingPublicMessageGroups!.map((group) => [...group]) }
					: {}),
				...(measureRequest ? { measureRequest } : {}),
				...(canSelect
					? ({
							prepareRequest: async (representation, projection) => {
								try {
									selectedContextEpoch = undefined;
									publicAccepted = false;
									if (JSON.parse(representation.body!).model !== model.id) return;
									if (boundary!.fixedPrepare) {
										const assessment = budget?.measure(representation);
										if (budget && assessment) budget.assert(assessment);
										const accepted = await prepareFixedRequestView(
											boundary!,
											representation,
											projection,
											assessment,
										);
										if (accepted) selectedContextEpoch = Object.freeze({ ...accepted });
										return;
									}
									return await selectRequestView(
										{
											...boundary!,
											commit: async (candidate) => {
												const accepted = await boundary!.commit(candidate);
												if (accepted) selectedContextEpoch = Object.freeze({ ...accepted });
												publicAccepted = Boolean(
													accepted &&
														candidate.publicMessages &&
														candidate.projection.publicWindow &&
														!candidate.projection.pendingPublicMessageGroups?.length,
												);
												return accepted || undefined;
											},
										},
										representation,
										projection,
										budget!,
										this.work.budgetMode === "enforce",
									);
								} catch (error) {
									budgetFailure = error;
									throw error;
								}
							},
						} satisfies Pick<ProviderAttemptObserver, "prepareRequest">)
					: {}),
				admit: async (descriptor) => {
					if (requiredPublic && !publicAccepted)
						throw new Error("Unaccepted tool continuation cannot enter native transport");
					if (!this.work.admissionOpen) throw new Error("Inference owner is closing");
					// An adapter without a serializer meter must not bypass an enforced budget.
					if (measureRequest && !descriptor.requestBudget && (budget || !measuredForAdmission)) {
						const assessment = invokeRequestMeasurement(attempts, {
							api: descriptor.api,
							provider: descriptor.provider,
							url: "",
							body: undefined,
						});
						if (assessment) descriptor = { ...descriptor, requestBudget: assessment };
					}
					measuredForAdmission = false;
					const attemptId = randomUUID();
					const contextEpoch = selectedContextEpoch ? Object.freeze({ ...selectedContextEpoch }) : undefined;
					const write = operation.binding.sink.persist({
						...metadata,
						...(contextEpoch ? { contextEpoch } : {}),
						type: "attempt_admitted",
						attemptId,
						timestamp: Date.now(),
						descriptor,
					});
					receiptWrites.push(write);
					await write;
					admittedAttempts.push({ attemptId, contextEpoch });
					return attemptId;
				},
				settle: async (receipt) => {
					const contextEpoch = admittedAttempts.find(
						(attempt) => attempt.attemptId === receipt.attemptId,
					)?.contextEpoch;
					const write = operation.binding.sink.persist({
						...metadata,
						...(contextEpoch ? { contextEpoch } : {}),
						type: "attempt_settled",
						attemptId: receipt.attemptId,
						timestamp: Date.now(),
						receipt,
					});
					receiptWrites.push(write);
					await write;
					parentBudget?.observe(receipt);
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

	complete(
		model: Model<Api>,
		context: Context,
		options: SimpleStreamOptions | undefined,
		request: InferenceRequestOptions,
	): Promise<AssistantMessage> {
		let completion!: Promise<AssistantMessage>;
		completion = (async () => {
			const settlement = await (await this.start(model, context, options, request)).settled;
			const binding = this.work.compactionSettlements.get(settlement);
			this.work.compactionSettlements.delete(settlement);
			if (binding) this.work.compactionCompletions.set(completion, binding);
			return settlement.message;
		})();
		return completion;
	}

	bindStream(streamFn: StreamFn, request: InferenceRequestOptions): AgentOwnedStreamFn {
		const unwrapped = unwrapSemanticEdgeStreamFn(streamFn) as BoundStreamFn;
		const inner = unwrapped[REQUEST_STREAM_BINDING]?.inner ?? unwrapped;
		// One Agent stream is serial. Keep only its latest binding for semantic retries.
		// A side question or child gets its own closure, not the parent's source binding.
		let previous: BoundOperation | undefined;
		let previousBody: string | undefined;
		const wrapped: BoundStreamFn = async (model, context, options, streamContext) => {
			let captured: InferenceCoordinator | undefined;
			if (streamContext !== undefined) {
				if (
					!(streamContext instanceof InferenceCoordinator) ||
					streamContext.work !== this.work ||
					!streamContext.capturedSink
				)
					throw new Error("Native stream context is not a capture of this inference owner");
				captured = streamContext;
			}
			const executor = captured ?? this;
			const semanticEdgeId = request.semanticEdgeId ?? options?.headers?.[MODEL_REQUEST_ID_HEADER];
			// Reuse the existing semantic body identity if its best-effort recorder is unavailable.
			const body = semanticEdgeId ? undefined : hashTurnBody(model, context, options);
			const retryId =
				this.retryTurn && body !== undefined && body === previousBody ? previous?.metadata.operationId : undefined;
			this.retryTurn = false;
			const operationId = request.operationId ?? semanticEdgeId ?? retryId ?? randomUUID();
			previousBody = body;
			if (captured || previous?.metadata.operationId !== operationId) {
				// A semantic retry can reuse its operation ID, but compilation owns this exact source frontier.
				previous = executor.bindOperation(model, { ...request, semanticEdgeId }, operationId);
			}
			return (
				await executor.execute(
					previous,
					model,
					context,
					options,
					inner,
					captured !== undefined && request.purpose === "main",
				)
			).events;
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
