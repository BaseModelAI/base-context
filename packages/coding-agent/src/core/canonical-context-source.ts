import type {
	ContextManifestCursor,
	ContextManifestPage,
	ContextRef,
	ContextUpdateRef,
	ContextUpdateTarget,
} from "./history-index.js";
import type { SessionHistoryReadView } from "./session-history-index.js";
import type { SessionEntry } from "./session-manager.js";

export interface CachedContextEntry {
	revision: string;
	entry: SessionEntry;
}

type KnownManifest = Extract<ContextManifestPage, { selection: "known" }>;

/** Read the complete selected manifest and account for every source frame. */
export async function readCanonicalManifest(view: SessionHistoryReadView, maxMessages: number, maxSourceBytes: number) {
	let first: KnownManifest | undefined;
	let cursor: ContextManifestCursor | undefined;
	let expected = 0;
	let sourceBytes = 0;
	const refs: ContextRef[] = [];
	const sourceOrder = new Map<string, number>();
	const countBytes = (ref: { locator: { length: number } }) => {
		sourceBytes += ref.locator.length;
		if (sourceBytes > maxSourceBytes) throw new Error("Canonical context source byte budget exceeded");
	};
	for (;;) {
		const page = await view.contextManifest({ cursor, limit: 128 });
		if (page.selection !== "known") throw new Error(`Canonical context selection is ${page.selection}`);
		if (!first) {
			first = page;
			if (page.activeMessageCount + (page.summaryRef ? 1 : 0) > maxMessages)
				throw new Error("Canonical context message budget exceeded");
			expected = page.activeBase + 1;
			if (page.summaryRef) countBytes(page.summaryRef);
		} else if (
			page.activeBase !== first.activeBase ||
			page.activeMessageCount !== first.activeMessageCount ||
			page.retainedMessageCount !== first.retainedMessageCount ||
			page.summaryRef?.entryId !== first.summaryRef?.entryId ||
			page.summaryRef?.revision !== first.summaryRef?.revision
		) {
			throw new Error("Canonical context manifest changed during its captured read");
		}
		for (const ref of page.refs) {
			if (ref.ordinal !== expected++) throw new Error("Canonical context manifest skipped an active message");
			countBytes(ref);
			refs.push(ref);
			sourceOrder.set(ref.entryId, ref.sequence);
		}
		if (!page.nextCursor) break;
		if (!page.refs.length || page.nextCursor.nextOrdinal !== expected)
			throw new Error("Canonical context manifest did not advance");
		cursor = page.nextCursor;
	}
	if (refs.length !== first.activeMessageCount) throw new Error("Canonical context manifest is incomplete");
	return {
		first,
		refs,
		sourceOrder,
		countBytes,
		get sourceBytes() {
			return sourceBytes;
		},
	};
}

/** Payload cache local to a build. The compiler adopts it only after the whole build succeeds. */
export function canonicalEntryReader(view: SessionHistoryReadView, previous: ReadonlyMap<string, CachedContextEntry>) {
	const next = new Map<string, CachedContextEntry>();
	const hydrate = async (
		ref: ContextRef | ContextUpdateRef,
		target?: ContextUpdateTarget,
		readView: SessionHistoryReadView = view,
	): Promise<SessionEntry> => {
		const cached = previous.get(ref.entryId);
		if (cached?.revision === ref.revision) {
			next.set(ref.entryId, cached);
			return cached.entry;
		}
		const fragments: string[] = [];
		let offset = 0;
		let part = target
			? await readView.readContextUpdatePayload(ref.entryId, target)
			: await readView.readPayload(ref.entryId);
		for (;;) {
			if (!part || part.byteOffset !== offset || part.byteLength <= 0)
				throw new Error("Canonical context payload is unavailable or incomplete");
			offset += part.byteLength;
			if (offset > ref.locator.length) throw new Error("Canonical context payload exceeds its source locator");
			fragments.push(part.text);
			if (!part.nextCursor) break;
			part = target
				? await readView.readContextUpdatePayload(ref.entryId, target, { cursor: part.nextCursor })
				: await readView.readPayload(ref.entryId, { cursor: part.nextCursor });
		}
		const value: unknown = JSON.parse(fragments.join(""));
		if (
			!value ||
			typeof value !== "object" ||
			!("id" in value) ||
			value.id !== ref.entryId ||
			!("type" in value) ||
			value.type !== ref.kind
		)
			throw new Error("Canonical context payload does not match its source reference");
		const entry = value as SessionEntry;
		next.set(ref.entryId, { revision: ref.revision, entry });
		return entry;
	};
	return { next, hydrate };
}
