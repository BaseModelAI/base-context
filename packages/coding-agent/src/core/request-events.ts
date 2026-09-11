import type {
	Api,
	AssistantMessage,
	Provider,
	ProviderAttemptInfo,
	ProviderAttemptReceipt,
} from "@ponythewhite/base-context-ai";
import type { SessionHistoryReadView } from "./session-history-index.js";

/** A writer-bound source. It does not move when the UI selects another session or leaf. */
export interface SourceSnapshotRef {
	readonly sessionId: string;
	readonly sessionFile?: string;
	readonly leafId: string | null;
	readonly sourceSequence: number;
	readonly persistent: boolean;
}

/** Descriptive reference to an actually accepted native epoch, never replay/selection authority. */
export interface ContextEpochEntryRef {
	readonly sessionId: string;
	readonly entryId: string;
}

/** Recorded request/source correlation only: not task authority, append ACK or caller delivery. */
export interface NativeRequestOutputAssociation {
	readonly operationId: string;
	/** All admitted attempts of this request; none is identified as the output-producing attempt. */
	readonly attemptIds: readonly string[];
	readonly source: SourceSnapshotRef;
}

export type NativeRequestOutputWriter = (owner: object, message: AssistantMessage) => Promise<string | undefined>;
export type NativeRequestOutputSource = (
	association: NativeRequestOutputAssociation,
) => NativeRequestOutputWriter | undefined;

export type RequestPurpose = "main" | "summary" | "refine" | "learning" | "child" | "native-control" | "other";

export interface RequestOwnerRef {
	readonly sessionId: string;
	readonly parentSessionId?: string;
	readonly rootSessionId?: string;
	readonly agentId?: string;
}

/** Catalog rates are estimates, not validated billing or a compiled model-input contract. */
export interface ResolvedModelContract {
	readonly api: Api;
	readonly provider: Provider;
	readonly model: string;
	readonly profile: { readonly id: string; readonly status: "unvalidated"; readonly revision?: string };
	readonly pricing: {
		readonly status: "unvalidated" | "unavailable";
		readonly currency?: "USD";
		readonly unit?: "million-tokens";
		readonly revision?: string;
		readonly catalogRates?: {
			readonly input: number;
			readonly output: number;
			readonly cacheRead: number;
			readonly cacheWrite: number;
		};
	};
}

export interface NativeRequestMetadata {
	readonly operationId: string;
	readonly parentOperationId?: string;
	readonly semanticEdgeId?: string;
	readonly source: SourceSnapshotRef;
	readonly owner: RequestOwnerRef;
	readonly purpose: RequestPurpose;
	readonly purposeDetail?: string;
	readonly modelContract: ResolvedModelContract;
	/** Absent unless this request actually used the associated compiled epoch. */
	readonly contextEpoch?: ContextEpochEntryRef;
}

export type NativeRequestEvent = NativeRequestMetadata &
	(
		| {
				readonly type: "attempt_admitted";
				readonly attemptId: string;
				readonly timestamp: number;
				readonly descriptor: ProviderAttemptInfo;
		  }
		| {
				readonly type: "attempt_settled";
				readonly attemptId: string;
				readonly timestamp: number;
				readonly receipt: ProviderAttemptReceipt;
		  }
	);

/** The session writer remains the only authoritative request history. */
export interface BoundRequestSink {
	readonly source: Promise<SourceSnapshotRef>;
	/** Native canonical readers use exactly this sink's captured frontier. */
	readHistory?<T>(read: (view: SessionHistoryReadView) => Promise<T>): Promise<T>;
	retain(): void;
	release(): Promise<void>;
	persist(event: NativeRequestEvent): Promise<void>;
}
