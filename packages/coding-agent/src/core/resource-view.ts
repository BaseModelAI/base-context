import { stringifyBoundedJson } from "./bounded-json.js";
import type { CapturedKernelLifecycle } from "./kernel/shared.js";
import type { CustomMessage } from "./messages.js";
import type { ViewUnit } from "./view-units.js";

export const RESOURCE_VIEW_CUSTOM_TYPE = "native_resource_view";
export const MAX_RESOURCE_REVISION_BYTES = 256;
const MAX_RESOURCE_VIEW_BYTES = 1024;

/** Owned per-request input. Neither a persisted marker nor public history can supply current state. */
export interface OwnedResourceCapture extends CapturedKernelLifecycle {
	readonly enabled: boolean;
}

export function assertResourceCurrent(capture: OwnedResourceCapture): void {
	if (!capture.isCurrent()) throw new Error("Captured kernel resource changed before request");
}

export function renderResourceView(capture: OwnedResourceCapture): {
	revision: string;
	message: CustomMessage;
	unit: ViewUnit;
	bytes: number;
} {
	const { source, owner, generation, state } = capture.snapshot;
	const revision = stringifyBoundedJson({ source, owner, generation, state }, MAX_RESOURCE_REVISION_BYTES);
	const message: CustomMessage = {
		role: "custom",
		customType: RESOURCE_VIEW_CUSTOM_TYPE,
		content: [
			"<current_kernel_resource>",
			revision,
			"Observed owned lifecycle only; not a health probe. Namespace contents, restoration, and survival are not asserted. Older kernel notes are historical.",
			"</current_kernel_resource>",
		].join("\n"),
		display: false,
		timestamp: 0,
	};
	const bytes = Buffer.byteLength(stringifyBoundedJson(message, MAX_RESOURCE_VIEW_BYTES), "utf8");
	return {
		revision,
		message,
		bytes,
		unit: {
			id: JSON.stringify(["resource-view", revision]),
			sourceRevision: revision,
			kind: "resource-view",
			exactSources: [],
			requiredVisibleDependencies: [],
			authority: "tool-data",
			tokenEstimate: null,
			immutableWithinEpoch: true,
		},
	};
}
