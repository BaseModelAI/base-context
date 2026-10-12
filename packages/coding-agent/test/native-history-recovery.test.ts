import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SessionHistoryIndex } from "../src/core/session-history-index.js";
import { SessionJournalOwner } from "../src/core/session-journal-owner.js";

it("replaces a closed fixture worker and rebuilds a corrupt derived index without changing the journal", async () => {
	const dir = mkdtempSync(join(tmpdir(), "bc-history-restart-"));
	const journalPath = join(dir, "session.jsonl");
	const indexPath = join(dir, "history.sqlite");
	const owner = await SessionJournalOwner.open({ journalPath, create: true });
	let history = new SessionHistoryIndex("restart", indexPath);
	try {
		await owner.appendJson(JSON.stringify({ type: "session", version: 3, id: "restart", cwd: dir }));
		await owner.appendJson(
			JSON.stringify({
				type: "message",
				id: "fact",
				parentId: null,
				message: { role: "user", content: "canonical fact" },
			}),
		);
		const snapshot = owner.getSnapshot();
		const first = await history.synchronize(snapshot);
		await first.close(); // This test's worker only; no host worker is signalled.
		const replacement = await history.synchronize(snapshot);
		expect(replacement).not.toBe(first);
		expect((await replacement.get("restart", "fact"))?.id).toBe("fact");
		await history.invalidate(replacement, new Error("database disk image is malformed"));
		const recoveredRead = await history.synchronize(snapshot);
		expect(recoveredRead).not.toBe(replacement);
		expect((await recoveredRead.get("restart", "fact"))?.id).toBe("fact");
		await history.close();
		const canonical = readFileSync(journalPath);
		writeFileSync(indexPath, "not a sqlite database");
		history = new SessionHistoryIndex("restart", indexPath);
		const rebuilt = await history.synchronize(snapshot);
		expect((await rebuilt.get("restart", "fact"))?.text).toBe("canonical fact");
		expect(readFileSync(journalPath)).toEqual(canonical);
	} finally {
		await history.close();
		await owner.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
