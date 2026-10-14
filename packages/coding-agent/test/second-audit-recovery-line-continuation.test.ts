import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { HistoryIndex } from "../src/core/history-index.js";
import { retainToolOutput } from "../src/core/retained-tool-output.js";
import {
	DEFAULT_NATIVE_RECOVERY_LIMITS,
	NativeRecoveryCursorStore,
	recoverCapturedHistory,
} from "../src/core/selective-recovery.js";
import { createBranchHistoryReadView } from "../src/core/session-history-index.js";
import { APPEND_NATIVE_TOOL_EXECUTION, SessionJournalOwner } from "../src/core/session-journal-owner.js";
import { getSessionArtifactPathForFile } from "../src/core/session-manager.js";

it.each([false, true])("recovers a selected line across the source budget: %s", async (distant) => {
	const dir = mkdtempSync(join(tmpdir(), "bc-recovery-lines-"));
	const journalPath = join(dir, "session.jsonl");
	const owner = await SessionJournalOwner.open({ journalPath, create: true });
	const index = await HistoryIndex.open(join(dir, "history.sqlite"), {
		nodeExecutable: process.env.BASE_CONTEXT_TEST_NODE,
	});
	try {
		await owner.appendJson(JSON.stringify({ type: "session", version: 3, id: "lines", cwd: dir }));
		const prefix = distant ? "x".repeat(DEFAULT_NATIVE_RECOVERY_LIMITS.maxSourceBytes + 64) : "first";
		const retained = await retainToolOutput(
			getSessionArtifactPathForFile(journalPath, "lines"),
			[`${prefix}\nselected line`],
			true,
		);
		await owner[APPEND_NATIVE_TOOL_EXECUTION](
			JSON.stringify({
				type: "message",
				id: "output",
				parentId: null,
				message: {
					role: "toolResult",
					toolCallId: "tool",
					toolName: "ipython",
					isError: false,
					content: [{ type: "text", text: "Bounded preview" }],
					details: { retainedOutput: retained },
				},
			}),
		);
		await index.syncSource("lines", owner.getSnapshot());
		const source = {
			sessionId: "lines",
			sessionFile: journalPath,
			leafId: "output",
			sourceSequence: 1,
			persistent: true,
		};
		const view = createBranchHistoryReadView(index, source, (query) => query());
		const cursors = new NativeRecoveryCursorStore();
		let response = await recoverCapturedHistory(
			view,
			{ action: "read", ref: "output", field: retained.field, startLine: 2, endLine: 2 },
			DEFAULT_NATIVE_RECOVERY_LIMITS,
			undefined,
			cursors,
		);
		if (distant) {
			expect(response.results[0]).toMatchObject({
				status: "partial",
				exhausted: false,
				records: [],
				cursor: expect.any(String),
			});
			await owner.appendJson(
				JSON.stringify({
					type: "message",
					id: "later",
					parentId: "output",
					message: { role: "user", content: "later input" },
				}),
			);
			await index.syncSource("lines", owner.getSnapshot());
			const newer = createBranchHistoryReadView(index, { ...source, leafId: "later", sourceSequence: 2 }, (query) =>
				query(),
			);
			response = await recoverCapturedHistory(
				newer,
				{ action: "read", cursor: response.results[0].cursor },
				DEFAULT_NATIVE_RECOVERY_LIMITS,
				undefined,
				cursors,
			);
		}
		expect(response.scope).toMatchObject({ leafId: "output", sourceSequence: 1 });
		expect(response.results[0]).toMatchObject({ status: "found", coverage: "complete", exhausted: true });
		expect(response.results[0].records).toHaveLength(1);
		expect(response.results[0].records[0]).toMatchObject({
			text: "selected line",
			startByte: Buffer.byteLength(prefix) + 1,
			startLine: 2,
			endLine: 2,
		});
	} finally {
		await index.close();
		await owner.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
