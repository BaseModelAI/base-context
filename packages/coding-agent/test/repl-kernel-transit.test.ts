import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReplKernelManager } from "../src/core/kernel/repl-manager.js";
import { ReplProtocolLineParser } from "../src/core/kernel/repl-protocol-lines.js";

const directories: string[] = [];
const managers: ReplKernelManager[] = [];

afterEach(() => {
	for (const manager of managers.splice(0)) manager.disposeSync();
	vi.restoreAllMocks();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fakeKernel(events: Record<string, unknown>[]) {
	const directory = mkdtempSync(join(tmpdir(), "repl-transit-"));
	directories.push(directory);
	const manager = new ReplKernelManager({
		python: "unused-offline-runtime",
		snapshot: { path: join(directory, "state.bin"), manifestPath: join(directory, "state.json") },
	});
	managers.push(manager);
	const host = manager as unknown as {
		state: string;
		writeLine(request: Record<string, unknown>): Promise<void>;
		handleEvent(event: Record<string, unknown>): void;
		scheduleSnapshot(): void;
	};
	host.state = "running";
	vi.spyOn(manager, "start").mockResolvedValue();
	const write = vi.spyOn(host, "writeLine").mockImplementation(async (request) => {
		for (const event of events) host.handleEvent({ ...event, id: request.id });
		host.handleEvent({ event: "done", id: request.id, status: "ok" });
	});
	const snapshot = vi.spyOn(host, "scheduleSnapshot").mockImplementation(() => {});
	return { manager, directory, write, snapshot };
}

describe("REPL transit", () => {
	it("scans only new decoded fragments and materializes complete lines", () => {
		const parser = new ReplProtocolLineParser();
		const decoder = new StringDecoder("utf8");
		const event = { event: "stdout", text: "abc😀".repeat(256) };
		const text = `${JSON.stringify(event)}\n${JSON.stringify({ event: "done", id: "one" })}\n`;
		const bytes = Buffer.from(text);
		const received: unknown[] = [];
		const indexOf = vi.spyOn(String.prototype, "indexOf");
		let scanned = 0;
		try {
			for (let offset = 0; offset < bytes.length; offset += 7) {
				parser.push(decoder.write(bytes.subarray(offset, offset + 7)), (line) => {
					received.push(JSON.parse(line));
					return true;
				});
			}
			scanned = indexOf.mock.contexts.reduce<number>(
				(total, input, index) => total + String(input).length - (indexOf.mock.calls[index]?.[1] ?? 0),
				0,
			);
		} finally {
			indexOf.mockRestore();
		}
		expect(scanned).toBeLessThanOrEqual(text.length * 2);
		expect(received).toEqual([event, { event: "done", id: "one" }]);
	});

	it("accepts the exact encoded limit and rejects oversized lines with or without a newline", () => {
		const line = '{"n":1}';
		const received: string[] = [];
		const parser = new ReplProtocolLineParser(line.length);
		parser.push(line, () => true);
		parser.push("\n", (value) => {
			received.push(value);
			return true;
		});
		expect(received).toEqual([line]);
		for (const suffix of ["", "\n"]) {
			const oversized = new ReplProtocolLineParser(line.length);
			oversized.push(line, () => true);
			expect(() => oversized.push(` ${suffix}`, () => true)).toThrow("encoded characters");
		}
	});

	it("retains routine output before preview clipping and keeps the diagnostic budget", async () => {
		const text = "x".repeat(5 * 1024);
		const routine = fakeKernel([
			{ event: "stdout", text: text.slice(0, 2048) },
			{ event: "stdout", text: text.slice(2048) },
		]);
		const result = await routine.manager.execute("routine", {
			outputDirectory: routine.directory,
			maxOutputChars: 16,
		});
		expect(result.retainedOutput?.captureComplete).toBe(true);
		expect(result.outputComplete).toBe(true);
		expect(result.stdout).toContain("preview omitted");
		expect(readFileSync(join(routine.directory, result.retainedOutput!.artifactId), "utf8")).toBe(
			`[stdout]\n${text}`,
		);
		const diagnostic = fakeKernel([{ event: "stderr", text }]);
		const error = await diagnostic.manager.execute("diagnostic", { outputDirectory: diagnostic.directory });
		expect(error.retainedOutput).toBeUndefined();
		expect(error.stderr).toBe(text);
		expect(error.outputComplete).toBe(true);
	});

	it.each(["result", "error"])("marks upstream-truncated %s capture incomplete", async (event) => {
		const { manager, directory } = fakeKernel([
			{ event, text: "kept", ename: "Error", evalue: "kept", traceback: ["kept"], upstreamTruncated: true },
		]);
		const result = await manager.execute("truncated", { outputDirectory: directory });
		expect(result.outputComplete).toBe(false);
		expect(result.retainedOutput?.captureComplete).toBe(false);
		expect(readFileSync(join(directory, result.retainedOutput!.artifactId), "utf8")).toContain("kept");
		const unretained = await manager.execute("truncated");
		expect(unretained.outputComplete).toBe(false);
	});

	it("forwards restore cancellation and does not snapshot internal bootstrap cells", async () => {
		const { manager, write, snapshot } = fakeKernel([]);
		const signal = AbortSignal.abort();
		await expect(manager.restoreState({ signal })).resolves.toBeNull();
		expect(write).not.toHaveBeenCalled();
		await manager.execute("bootstrap", { internal: true });
		expect(snapshot).not.toHaveBeenCalled();
		await manager.execute("user");
		expect(snapshot).toHaveBeenCalledOnce();
	});
});
