import * as fs from "node:fs";
import type { Usage } from "@ponythewhite/base-context-ai";
import type { Component } from "@ponythewhite/base-context-tui";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it, vi } from "vitest";
import { ansiLinesToHtml } from "../src/core/export-html/ansi-to-html.js";
import { exportFromFile, exportSessionToHtml } from "../src/core/export-html/index.js";
import { createToolHtmlRenderer } from "../src/core/export-html/tool-renderer.js";
import type { ToolDefinition } from "../src/core/extensions/types.js";
import { encodeJournalFrame, INITIAL_JOURNAL_CURSOR } from "../src/core/journal-frame.js";
import * as journalIo from "../src/core/journal-io.js";
import { exportSessionBranchToJsonl } from "../src/core/session-jsonl-export.js";
import {
	CURRENT_SESSION_VERSION,
	type SessionEntry,
	type SessionHeader,
	SessionManager,
} from "../src/core/session-manager.js";
import type { Theme } from "../src/modes/interactive/theme/theme.js";

vi.mock("node:fs", async (importOriginal) => {
	const original = await importOriginal<typeof fs>();
	return { ...original, closeSync: vi.fn(original.closeSync), unlinkSync: vi.fn(original.unlinkSync) };
});
vi.mock("../src/core/journal-io.js", async (importOriginal) => {
	const original = await importOriginal<typeof journalIo>();
	return { ...original, writeFullySync: vi.fn(original.writeFullySync) };
});

function exportedHistory(path: string): { entries: SessionEntry[]; leafId: string | null; header: { id: string } } {
	const encoded = readFileSync(path, "utf8").match(
		/<script id="session-data" type="application\/json">([^<]+)<\/script>/,
	)?.[1];
	if (!encoded) throw new Error("Missing exported session data");
	return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
}

function exportedJsonl(path: string): { header: SessionHeader; entries: SessionEntry[] } {
	const text = readFileSync(path, "utf8");
	expect(text.endsWith("\n")).toBe(true);
	const [header, ...entries] = text
		.trimEnd()
		.split("\n")
		.map((line) => JSON.parse(line));
	return { header, entries };
}

describe("export HTML tool output whitespace", () => {
	it("preserves whitespace for plain-text tool output lines without preserving template whitespace", async () => {
		const css = readFileSync(new URL("../src/core/export-html/template.css", import.meta.url), "utf-8");

		expect(css).toMatch(
			/\.output-preview > div:not\(\.expand-hint\),\s*\.output-full > div:not\(\.expand-hint\) \{[\s\S]*?white-space:\s*pre-wrap;/,
		);
		expect(css).toMatch(/\.ansi-line\s*\{[\s\S]*?white-space:\s*pre;/);
		expect(css).not.toMatch(/\.output-preview,\s*\.output-full\s*\{[\s\S]*?white-space:\s*pre-wrap;/);

		const root = mkdtempSync(join(tmpdir(), "bc-html-export-"));
		const manager = await SessionManager.create(root, join(root, "sessions"));
		try {
			const first = await manager.appendMessage({ role: "user", content: "one\n  two", timestamp: 1 });
			const offBranch = await manager.appendMessage({ role: "user", content: "off branch", timestamp: 2 });
			manager.branch(first);
			const uncapped = vi.spyOn(manager, "getEntries").mockImplementation(() => {
				throw new Error("uncapped export read");
			});
			const output = join(root, "captured.html");
			const pending = exportSessionToHtml(manager, undefined, {
				outputPath: output,
				maxEntries: 2,
				maxSourceBytes: 65_536,
				themeName: "dark",
			});
			await manager.appendMessage({ role: "user", content: "later append", timestamp: 3 });
			await pending;
			const captured = exportedHistory(output);
			expect(captured.entries.map((entry) => entry.id)).toEqual([first, offBranch]);
			expect(captured.leafId).toBe(first);
			expect(captured.header.id).toBe(manager.getSessionId());
			expect(captured.entries[0]).toMatchObject({ message: { content: "one\n  two" } });
			expect(uncapped).not.toHaveBeenCalled();
			await expect(
				exportSessionToHtml(manager, undefined, { outputPath: join(root, "count.html"), maxEntries: 1 }),
			).rejects.toThrow("History entry budget exceeded");
			await expect(
				exportSessionToHtml(manager, undefined, { outputPath: join(root, "bytes.html"), maxSourceBytes: 1 }),
			).rejects.toThrow("JSON byte limit exceeded");
			expect(existsSync(join(root, "count.html"))).toBe(false);
			expect(existsSync(join(root, "bytes.html"))).toBe(false);

			// Extend this HTML case with JSONL's captured actual-parent-path export.
			const pathIds = [first, manager.getLeafId()!];
			for (let i = 0; i < 65; i++) {
				pathIds.push(await manager.appendMessage({ role: "user", content: `path żółć ${i}`, timestamp: 10 + i }));
			}
			const usage: Usage = {
				input: 1,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 3,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
			const assistant = await manager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "captured answer" }],
				api: "openai-responses",
				provider: "openai",
				model: "fixture",
				usage,
				stopReason: "stop",
				timestamp: 100,
			});
			pathIds.push(assistant);
			const sibling = await manager.appendMessage({ role: "user", content: "usage branch", timestamp: 101 });
			await manager.appendChildUsageAttribution(assistant, usage, { ...usage, input: 5 });
			const aggregateUsage: Usage = { ...usage, input: 11, output: 22, totalTokens: 33 };
			const attributed = await manager.appendChildUsageAttribution(assistant, usage, aggregateUsage);
			manager.branch(assistant);
			const sink = manager.bindRequestSink();
			try {
				const source = await sink.source;
				await sink.persist({
					type: "attempt_admitted",
					attemptId: "jsonl-attempt",
					operationId: "jsonl-operation",
					timestamp: 102,
					source,
					owner: { sessionId: source.sessionId },
					purpose: "summary",
					modelContract: {
						api: "openai-responses",
						provider: "openai",
						model: "fixture",
						profile: { id: "native", status: "unvalidated" },
						pricing: { status: "unavailable" },
					},
					descriptor: {
						api: "openai-responses",
						provider: "openai",
						model: "fixture",
						transport: "http",
						ordinal: 0,
						kind: "initial",
					},
				});
			} finally {
				await sink.release();
			}
			expect((await manager.pageHistory()).events.map((entry) => entry.id)).toContain(first);
			expect(await manager.getHistoryEntry("jsonl-attempt:attempt_admitted")).toBeDefined();
			const uncappedBranch = vi.spyOn(manager, "getBranch").mockImplementation(() => {
				throw new Error("uncapped JSONL branch read");
			});
			const materialized = vi.spyOn(manager, "materializeParentPathHistory").mockImplementation(() => {
				throw new Error("whole JSONL branch materialization");
			});
			const resident = vi.spyOn(manager, "materializeResidentHistory").mockImplementation(() => {
				throw new Error("resident JSONL canonical fallback");
			});
			const capturedRead = vi.spyOn(manager, "readBranchHistory");
			const originalSessionId = manager.getSessionId();
			const jsonlPath = join(root, "nested", "captured.jsonl");
			const jsonlPending = exportSessionBranchToJsonl(manager, jsonlPath, {
				residentLimits: { maxEntries: 1, maxSourceBytes: 1 },
			});
			const lateUsage = await manager.appendChildUsageAttribution(assistant, usage, {
				...usage,
				input: 111,
				output: 222,
				totalTokens: 333,
			});
			await manager.newSession();
			const replacement = await manager.appendSessionInfo("not the exported source");
			expect(await jsonlPending).toBe(jsonlPath);
			const jsonl = exportedJsonl(jsonlPath);
			expect(jsonl.header).toMatchObject({
				type: "session",
				version: CURRENT_SESSION_VERSION,
				id: originalSessionId,
				cwd: root,
			});
			expect(new Date(jsonl.header.timestamp).toISOString()).toBe(jsonl.header.timestamp);
			expect(jsonl.entries.map((entry) => entry.id)).toEqual(pathIds);
			expect(jsonl.entries.map((entry) => entry.parentId)).toEqual([null, ...pathIds.slice(0, -1)]);
			expect(jsonl.entries.at(-1)).toMatchObject({ id: assistant, message: { usage: aggregateUsage } });
			for (const excluded of [
				offBranch,
				sibling,
				attributed,
				"jsonl-attempt:attempt_admitted",
				lateUsage,
				replacement,
			]) {
				expect(jsonl.entries.map((entry) => entry.id)).not.toContain(excluded);
			}
			expect(uncapped).not.toHaveBeenCalled();
			expect(uncappedBranch).not.toHaveBeenCalled();
			expect(materialized).not.toHaveBeenCalled();
			expect(resident).not.toHaveBeenCalled();
			expect(capturedRead).toHaveBeenCalledTimes(1);
		} finally {
			vi.restoreAllMocks();
			await manager.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not insert source whitespace between ANSI-rendered lines", () => {
		expect(ansiLinesToHtml(["one", "two"])).toBe('<div class="ansi-line">one</div><div class="ansi-line">two</div>');
	});

	it("trims TUI spacing lines from custom tool result HTML", async () => {
		const component: Component = { render: () => ["", "\u001b[31mone\u001b[0m", "two", ""], invalidate: () => {} };
		const tool = {
			name: "custom",
			label: "custom",
			description: "custom",
			renderResult: () => component,
		} as unknown as ToolDefinition;
		const renderer = createToolHtmlRenderer({
			getToolDefinition: () => tool,
			theme: {} as Theme,
			cwd: "/tmp",
		});

		expect(renderer.renderResult("id", "custom", [], undefined, false)?.expanded).toBe(
			'<div class="ansi-line"><span style="color:#800000">one</span></div><div class="ansi-line">two</div>',
		);

		const root = mkdtempSync(join(tmpdir(), "bc-html-limits-"));
		const timestamp = "2026-09-07T00:00:00.000Z";
		const records = [
			{ type: "session", version: 3, id: "retained", timestamp, cwd: root },
			{
				type: "message",
				id: "one",
				parentId: null,
				timestamp,
				message: { role: "user", content: "one\n  two", timestamp: 1 },
			},
			{
				type: "message",
				id: "two",
				parentId: "one",
				timestamp,
				message: { role: "user", content: "two", timestamp: 2 },
			},
		];
		try {
			const raw = records.map((record) => `${JSON.stringify(record)}\n`).join("");
			let cursor = INITIAL_JOURNAL_CURSOR;
			const framed = records
				.map((record) => {
					const frame = encodeJournalFrame(record, cursor, 65_536, "retained-import");
					cursor = frame.next;
					return frame.line;
				})
				.join("");
			for (const [name, source] of [
				["raw", raw],
				["framed", framed],
			]) {
				const input = join(root, `${name}.jsonl`);
				writeFileSync(input, source);
				const output = join(root, `${name}.html`);
				const limits = {
					outputPath: output,
					maxEntries: 2,
					maxSourceBytes: Buffer.byteLength(source),
					themeName: "dark",
				};
				await exportFromFile(input, limits);
				expect(exportedHistory(output)).toMatchObject({
					header: { id: "retained" },
					leafId: "two",
					entries: records.slice(1),
				});
				const original = readFileSync(output);
				await expect(exportFromFile(input, limits)).rejects.toThrow("Export file already exists");
				expect(readFileSync(output)).toEqual(original);
				const refused = join(root, `${name}-refused.html`);
				await expect(exportFromFile(input, { ...limits, outputPath: refused, maxEntries: 1 })).rejects.toThrow(
					"HTML export entry budget exceeded",
				);
				await expect(
					exportFromFile(input, { ...limits, outputPath: refused, maxSourceBytes: Buffer.byteLength(source) - 1 }),
				).rejects.toThrow("HTML export source byte budget exceeded");
				expect(existsSync(refused)).toBe(false);
			}
			const readonly = await SessionManager.openReadOnly(join(root, "raw.jsonl"));
			try {
				appendFileSync(
					join(root, "raw.jsonl"),
					`${JSON.stringify({ ...records[2], id: "later", parentId: "two" })}\n`,
				);
				vi.spyOn(readonly, "getEntries").mockImplementation(() => {
					throw new Error("uncapped readonly export read");
				});
				const output = join(root, "readonly.html");
				await exportSessionToHtml(readonly, undefined, {
					outputPath: output,
					maxEntries: 2,
					maxSourceBytes: 65_536,
					themeName: "dark",
				});
				expect(exportedHistory(output).entries.map((entry) => entry.id)).toEqual(["one", "two"]);
				expect(exportedHistory(output).leafId).toBe("two");
				const snapshot = readonly.materializeResidentHistory({ maxEntries: 2, maxSourceBytes: 65_536 });
				expect(snapshot.retentions).toEqual(["retained-import", "retained-import"]);
				snapshot.header!.id = "changed copy";
				const copied = snapshot.entries[0];
				if (copied.type === "message" && copied.message.role === "user") copied.message.content = "changed copy";
				expect(readonly.getHeader()?.id).toBe("retained");
				expect(readonly.getEntry("one")).toMatchObject({ message: { content: "one\n  two" } });
				const rejected = join(root, "readonly-refused.html");
				await expect(
					exportSessionToHtml(readonly, undefined, { outputPath: rejected, maxEntries: 1 }),
				).rejects.toThrow("Resident history entry budget exceeded");
				await expect(
					exportSessionToHtml(readonly, undefined, { outputPath: rejected, maxSourceBytes: 1 }),
				).rejects.toThrow("JSON byte limit exceeded");
				expect(existsSync(rejected)).toBe(false);

				// Extend this HTML case with bounded old-view JSONL and output cleanup.
				const uncappedBranch = vi.spyOn(readonly, "getBranch").mockImplementation(() => {
					throw new Error("uncapped readonly JSONL branch read");
				});
				const residentLimits = { maxEntries: 2, maxSourceBytes: 65_536 };
				const jsonlPath = join(root, "readonly.jsonl");
				await exportSessionBranchToJsonl(readonly, jsonlPath, { residentLimits });
				const jsonl = exportedJsonl(jsonlPath);
				expect(jsonl.header).toMatchObject({
					type: "session",
					version: CURRENT_SESSION_VERSION,
					id: "retained",
					cwd: root,
				});
				expect(jsonl.entries).toEqual(records.slice(1));
				expect(uncappedBranch).not.toHaveBeenCalled();
				const originalJsonl = readFileSync(jsonlPath);
				vi.mocked(fs.unlinkSync).mockClear();
				await expect(exportSessionBranchToJsonl(readonly, jsonlPath, { residentLimits })).rejects.toThrow(
					`Export output already exists; choose a new filename: ${jsonlPath}`,
				);
				expect(readFileSync(jsonlPath)).toEqual(originalJsonl);
				expect(fs.unlinkSync).not.toHaveBeenCalled();
				const refusedJsonl = join(root, "readonly-refused.jsonl");
				await expect(
					exportSessionBranchToJsonl(readonly, refusedJsonl, {
						residentLimits: { ...residentLimits, maxEntries: 1 },
					}),
				).rejects.toThrow("Resident history entry budget exceeded");
				await expect(
					exportSessionBranchToJsonl(readonly, refusedJsonl, {
						residentLimits: { ...residentLimits, maxSourceBytes: 1 },
					}),
				).rejects.toThrow("JSON byte limit exceeded");
				await expect(
					exportSessionBranchToJsonl(readonly, refusedJsonl, { residentLimits, maxRecordBytes: 1 }),
				).rejects.toThrow();
				expect(existsSync(refusedJsonl)).toBe(false);

				const primary = new Error("JSONL write failed");
				const closeError = new Error("JSONL close failed");
				const unlinkError = new Error("JSONL unlink failed");
				const realFs = await vi.importActual<typeof fs>("node:fs");
				const realJournalIo = await vi.importActual<typeof journalIo>("../src/core/journal-io.js");
				for (const cleanupFails of [false, true]) {
					const failedPath = join(root, `failed-${cleanupFails}.jsonl`);
					let outputFd: number | undefined;
					vi.mocked(journalIo.writeFullySync)
						.mockImplementationOnce(realJournalIo.writeFullySync)
						.mockImplementationOnce((fd) => {
							outputFd = fd;
							throw primary;
						});
					vi.mocked(fs.closeSync).mockClear();
					vi.mocked(fs.unlinkSync).mockClear();
					if (cleanupFails) {
						vi.mocked(fs.closeSync).mockImplementationOnce((fd) => {
							realFs.closeSync(fd);
							throw closeError;
						});
						vi.mocked(fs.unlinkSync).mockImplementationOnce(() => {
							throw unlinkError;
						});
					}
					try {
						const failed = exportSessionBranchToJsonl(readonly, failedPath, { residentLimits });
						if (cleanupFails) {
							await expect(failed).rejects.toBeInstanceOf(AggregateError);
							await expect(failed).rejects.toMatchObject({ errors: [primary, closeError, unlinkError] });
						} else {
							await expect(failed).rejects.toBe(primary);
						}
						expect(outputFd).toBeDefined();
						expect(fs.closeSync).toHaveBeenCalledExactlyOnceWith(outputFd);
						expect(() => realFs.fstatSync(outputFd!)).toThrow();
						expect(fs.unlinkSync).toHaveBeenCalledExactlyOnceWith(failedPath);
						expect(existsSync(failedPath)).toBe(cleanupFails);
					} finally {
						vi.mocked(journalIo.writeFullySync).mockReset();
						vi.mocked(fs.closeSync).mockReset();
						vi.mocked(fs.unlinkSync).mockReset();
					}
				}
			} finally {
				vi.restoreAllMocks();
				await readonly.close();
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
