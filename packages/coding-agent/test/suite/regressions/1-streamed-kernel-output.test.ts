import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@ponythewhite/base-context-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	readRetainedToolOutput,
	retainedToolOutput,
	TOOL_OUTPUT_PREVIEW_BYTES,
} from "../../../src/core/retained-tool-output.js";
import { recoverCapturedHistory } from "../../../src/core/selective-recovery.js";
import { getSessionArtifactPathForFile, SessionManager } from "../../../src/core/session-manager.js";
import {
	createIpythonTool,
	IpythonKernelProvisioner,
	type IpythonPendingExecution,
} from "../../../src/core/tools/ipython.js";
import { createHarness, type Harness } from "../harness.js";

const python =
	process.env.BASE_CONTEXT_KERNEL_PYTHON ?? join(homedir(), ".prime", "agent", "kernel-venv", "bin", "python");
const runtime = resolve(import.meta.dirname, "../../../../../prime-agent-runtime/src");
const logs = process.env.BC_CAPTURE_TEST_LOG_DIR;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
	const cwd = mkdtempSync(join(tmpdir(), "streamed-output-"));
	const sessionManager = await SessionManager.create(cwd, join(cwd, "sessions"));
	const directory = getSessionArtifactPathForFile(sessionManager.getSessionFile()!, sessionManager.getSessionId());
	let pending: IpythonPendingExecution | undefined;
	const provisioner = new IpythonKernelProvisioner(cwd, {
		python,
		env: { PYTHONPATH: runtime },
		snapshotDir: directory,
		onExecutionPending: (execution) => {
			pending = execution;
		},
	});
	const tool = createIpythonTool(cwd, {
		provisioner,
		onExecutionPending: (execution) => {
			pending = execution;
		},
	});
	const harness = await createHarness({
		cwd,
		sessionManager,
		tools: [tool],
		settings: { compaction: { enabled: false }, autoRefine: { enabled: false }, retry: { enabled: false } },
	});
	cleanups.push(async () => {
		await provisioner.dispose({ snapshot: false });
		await harness.cleanup();
		rmSync(cwd, { recursive: true, force: true });
	});
	return {
		directory,
		tool,
		harness,
		wait: async () => {
			await pending?.completion;
		},
	};
}

function save(name: string, body: string) {
	if (!logs) return;
	mkdirSync(logs, { recursive: true });
	writeFileSync(join(logs, name), body);
}

async function retainedEntry(harness: Harness) {
	const entry = (await harness.sessionManager.readBranch())
		.reverse()
		.find(
			(entry) =>
				entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "ipython",
		);
	if (!entry || entry.type !== "message" || entry.message.role !== "toolResult")
		throw new Error("Missing tool result");
	const descriptor = retainedToolOutput((entry.message.details as { retainedOutput?: unknown }).retainedOutput);
	if (!descriptor) throw new Error("Missing retained output");
	const metadata = await harness.sessionManager.getHistoryEntry(entry.id);
	if (!metadata) throw new Error("Missing public history metadata");
	return { entry, descriptor, metadata };
}

describe.skipIf(!existsSync(python))("BC_TOFIX 1: real Python streamed output", () => {
	it("retains 32000 lines and a late needle while the public result stays bounded", async () => {
		const f = await fixture();
		const code = [
			"import sys",
			"for i in range(32000):",
			"    print(f'{i:05d} ' + ('NEEDLE-7731' if i == 18250 else 'ordinary-log').ljust(54, '.'))",
			"print('stderr-kept-separate', file=sys.stderr)",
			"'final-value'",
		].join("\n");
		const finish = fauxAssistantMessage("Captured.");
		f.harness.setResponses([
			fauxAssistantMessage(fauxToolCall("ipython", { code }), { stopReason: "toolUse" }),
			async (context) => {
				const result = [...context.messages].reverse().find((message) => message.role === "toolResult");
				const text = JSON.stringify(result?.content);
				expect(Buffer.byteLength(text)).toBeLessThan(TOOL_OUTPUT_PREVIEW_BYTES);
				const content =
					result?.content
						.filter((part) => part.type === "text")
						.map((part) => part.text)
						.join("\n") ?? "";
				const pending = content.match(/"execution_id":"([^"]+)"/);
				if (pending) {
					await f.wait();
					return fauxAssistantMessage(fauxToolCall("ipython", { action: "status", execution_id: pending[1] }), {
						stopReason: "toolUse",
					});
				}
				return finish;
			},
			finish,
		]);
		await f.harness.session.prompt("Print the full log.");
		const { entry, descriptor, metadata } = await retainedEntry(f.harness);
		expect(descriptor.captureComplete).toBe(true);
		expect(descriptor.byteLength).toBeGreaterThan(1_900_000);
		expect(Buffer.byteLength(JSON.stringify(entry.message))).toBeLessThan(TOOL_OUTPUT_PREVIEW_BYTES);
		const rendered = f.harness.session.messages
			.filter((message) => message.role === "toolResult")
			.flatMap((message) => message.content)
			.find((part) => part.type === "text" && part.text.startsWith("Read retained output with prime_context "));
		expect(rendered?.type).toBe("text");
		const address = JSON.parse(
			rendered!.type === "text" ? rendered!.text.slice("Read retained output with prime_context ".length) : "{}",
		);
		expect(address).toEqual({ action: "read", ref: entry.id, revision: metadata.revision, field: descriptor.field });
		expect(JSON.stringify(entry.message)).not.toContain("Read retained output with prime_context");
		const body = readFileSync(join(f.directory, descriptor.artifactId), "utf8");
		expect(body).toContain("18250 NEEDLE-7731");
		expect(body).toContain("31999 ordinary-log");
		expect(body).toContain("[stderr]\nstderr-kept-separate");
		expect(body).toContain("[result]\n'final-value'");
		const offset = Buffer.byteLength(body.slice(0, body.indexOf("18250 NEEDLE-7731")));
		const recovered = await f.harness.sessionManager.readBranchHistory((view) =>
			recoverCapturedHistory(view.branchContext, {
				action: "read",
				ref: entry.id,
				revision: metadata.revision,
				field: descriptor.field,
				startByte: offset,
				endByte: offset + 100,
			}),
		);
		expect(JSON.stringify(recovered)).toContain("18250 NEEDLE-7731");
		expect(recovered.status).toBe("found");
		if (logs) {
			mkdirSync(logs, { recursive: true });
			copyFileSync(join(f.directory, descriptor.artifactId), join(logs, "large-output.log"));
		}
		save("large-result.json", JSON.stringify({ descriptor, preview: entry.message, recovered }, null, 2));
	});

	it("keeps captured stdout/stderr on cancellation without claiming complete output", async () => {
		const f = await fixture();
		const controller = new AbortController();
		let result = await f.tool.execute(
			"cancel-output",
			{
				code: "import asyncio, sys\nprint('x' * 70000)\nprint('CANCEL-READY', file=sys.stderr)\nawait asyncio.sleep(30)",
			},
			controller.signal,
			(update) => {
				if (JSON.stringify(update.content).includes("CANCEL-READY")) controller.abort();
			},
		);
		const details = result.details as { status: string; executionId?: string; retainedOutput?: unknown };
		if (details.status === "pending") {
			await f.wait();
			result = await f.tool.execute("cancel-collect", { action: "status", execution_id: details.executionId });
		}
		const final = result.details as { status: string; retainedOutput?: unknown };
		expect(final.status).toBe("aborted");
		const descriptor = retainedToolOutput(final.retainedOutput)!;
		expect(descriptor.captureComplete).toBe(false);
		expect(descriptor.byteLength).toBeGreaterThan(70000);
		expect(JSON.stringify(result.content)).toContain("partial/unknown capture");
		const tail = await readRetainedToolOutput(f.directory, descriptor, 69900, 4096);
		expect(tail.text).toContain("[stderr]\nCANCEL-READY");
		expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(TOOL_OUTPUT_PREVIEW_BYTES);
		save("cancel-result.json", JSON.stringify({ result, tail }, null, 2));
	});
});
