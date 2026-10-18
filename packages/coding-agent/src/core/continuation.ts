import type { SessionManager } from "./session-manager.js";

export interface ContinuationHold {
	kind: "external_blocker";
	reason: string;
}

export interface ContinuationStatus {
	status: "ready" | "blocked_external";
	hold?: ContinuationHold;
}

export const CONTINUATION_HOLD_CUSTOM_TYPE = "continuation_hold";

export async function readContinuationHold(
	manager: SessionManager,
	maxSourceBytes: number,
): Promise<ContinuationHold | undefined> {
	const read = (state: unknown): ContinuationHold | undefined => {
		if (typeof state !== "object" || !state || !("hold" in state))
			throw new Error("Invalid persisted continuation hold");
		const data = state.hold;
		if (data === null) return undefined;
		if (
			typeof data !== "object" ||
			!data ||
			!("kind" in data) ||
			data.kind !== "external_blocker" ||
			!("reason" in data) ||
			typeof data.reason !== "string" ||
			!data.reason.trim()
		) {
			throw new Error("Invalid persisted continuation hold");
		}
		return { kind: "external_blocker", reason: data.reason };
	};
	if (!manager.isPersisted()) {
		const entry = manager
			.getBranch()
			.slice()
			.reverse()
			.find((entry) => entry.type === "custom" && entry.customType === CONTINUATION_HOLD_CUSTOM_TYPE);
		return entry?.type === "custom" ? read(entry.data) : undefined;
	}
	return manager.readBranchHistory(async (view) => {
		let id = view.source.leafId;
		while (id) {
			const metadata = await view.get(id);
			if (!metadata) throw new Error("Continuation hold source is unavailable");
			if (
				metadata.kind === "custom" &&
				metadata.retention !== "retained-import" &&
				metadata.text.startsWith(CONTINUATION_HOLD_CUSTOM_TYPE)
			) {
				const hydrated = await view.hydrateEntry(id, maxSourceBytes);
				if (!hydrated) throw new Error("Continuation hold source exceeds the source budget");
				if (hydrated.entry.type === "custom" && hydrated.entry.customType === CONTINUATION_HOLD_CUSTOM_TYPE)
					return read(hydrated.entry.data);
			}
			id = metadata.parentId;
		}
		return undefined;
	});
}
