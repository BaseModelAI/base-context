import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { HistoryIndex } from "../src/core/history-index.js";

it("drains the close acknowledgement after the worker exits", async () => {
	const dir = mkdtempSync(join(tmpdir(), "history-index-close-"));
	try {
		const index = await HistoryIndex.open(join(dir, "history.sqlite"));
		const child = (index as unknown as { child: ChildProcess }).child;
		const channelKey = Object.getOwnPropertySymbols(child).find((key) => key.description === "kChannelHandle")!;
		const channel = (child as unknown as Record<symbol, { readStop(): void; readStart(): void }>)[channelKey];
		// Hold the native IPC read until exit, which does not imply that IPC has drained.
		channel.readStop();
		child.once("exit", () => channel.readStart());
		await expect(index.close()).resolves.toBeUndefined();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

it("rejects a clean worker exit when the close acknowledgement is missing", async () => {
	const dir = mkdtempSync(join(tmpdir(), "history-index-close-"));
	try {
		const index = await HistoryIndex.open(join(dir, "history.sqlite"));
		const child = (index as unknown as { child: ChildProcess }).child;
		child.removeAllListeners("message");
		await expect(index.close()).rejects.toThrow(/History-index worker (disconnected|exited)/);
		expect(child.exitCode).toBe(0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
