import { rm } from "node:fs/promises";
import { basename } from "node:path";
import type { DeleteSessionFileResult } from "./session-file-removal.js";
import { SessionJournalOwner } from "./session-journal-owner.js";
import { getSessionArtifactPathForFile } from "./session-manager.js";

export type { DeleteSessionFileResult } from "./session-file-removal.js";

export interface DeleteSessionFileOptions {
	afterFileRemoved?: () => void;
}

/**
 * Permanently remove a session's artifact directory (durable schedule state,
 * kernel snapshot, RLM scratch files, …), which lives at
 * `<dirname(sessionDir)>/session-artifacts/<id>`.
 * Only invoked on delete, never on deactivation.
 */
export async function deleteSessionArtifacts(sessionPath: string): Promise<void> {
	// A degenerate name (".jsonl") would resolve to the artifacts root itself.
	if (!basename(sessionPath).replace(/\.jsonl$/, "")) return;
	await rm(getSessionArtifactPathForFile(sessionPath), { recursive: true, force: true });
}

/**
 * Delete a session file, trying the `trash` CLI first, then falling back to unlink.
 * Also permanently removes the session's artifact directory, but only
 * once the session file itself is gone — otherwise a failed delete would orphan a
 * session whose kernel snapshot has already been destroyed.
 */
export async function deleteSessionFile(
	sessionPath: string,
	options: DeleteSessionFileOptions = {},
): Promise<DeleteSessionFileResult> {
	const result = await SessionJournalOwner.remove({ journalPath: sessionPath });
	if (result.ok) {
		options.afterFileRemoved?.();
		await deleteSessionArtifacts(sessionPath);
	}
	return result;
}
