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
import { type SessionEntry, SessionManager } from "../src/core/session-manager.js";
import type { Theme } from "../src/modes/interactive/theme/theme.js";

function exportedHistory(path: string): { entries: SessionEntry[]; leafId: string | null; header: { id: string } } {
	const encoded = readFileSync(path, "utf8").match(
		/<script id="session-data" type="application\/json">([^<]+)<\/script>/,
	)?.[1];
	if (!encoded) throw new Error("Missing exported session data");
	return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
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
			} finally {
				vi.restoreAllMocks();
				await readonly.close();
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
