import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDeferred, ReplKernelManager } from "../src/core/kernel/index.js";

const runtime = resolve(__dirname, "../../../prime-agent-runtime");
const python = join(runtime, ".venv/bin/python");
const describeIfKernel = existsSync(python) ? describe : describe.skip;

describeIfKernel("background output across internal kernel requests", () => {
	let manager: ReplKernelManager | undefined;
	let dir: string | undefined;

	afterEach(async () => {
		await manager?.shutdown({ drainHostRequests: true });
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	it.each([false, true])(
		"keeps detached output for the next user cell (state requests: %s)",
		async (stateRequests) => {
			dir = mkdtempSync(join(tmpdir(), "kernel-background-state-"));
			const release = createDeferred<Record<string, unknown>>();
			const printed = createDeferred<void>();
			const internalStarted = createDeferred<void>();
			const finishInternal = createDeferred<Record<string, unknown>>();
			const nextOutput = createDeferred<Record<string, unknown>>();
			const printedDuring = createDeferred<void>();
			manager = new ReplKernelManager({
				python,
				cwd: dir,
				env: { PYTHONPATH: join(runtime, "src"), BASE_CONTEXT_RLM_DEPTH: "0", BASE_CONTEXT_RLM_MAX_DEPTH: "2" },
				snapshot: { path: join(dir, "state.dill"), manifestPath: join(dir, "state.json"), debounceMs: 60_000 },
				hostHandlers: {
					"test.release": async () => release.promise,
					"test.printed": async () => {
						printed.resolve();
						return {};
					},
					"test.internal": async () => {
						internalStarted.resolve();
						return finishInternal.promise;
					},
					"test.next": async () => nextOutput.promise,
					"test.printedDuring": async () => {
						printedDuring.resolve();
						return {};
					},
				},
			});
			const first = await manager.execute(
				[
					"import asyncio, rlm",
					"async def late():",
					"    await rlm.host_request('test.release')",
					"    print('detached-output', flush=True)",
					"    await rlm.host_request('test.printed')",
					...(stateRequests
						? [
								"    await rlm.host_request('test.next')",
								"    print('during-internal', flush=True)",
								"    await rlm.host_request('test.printedDuring')",
							]
						: []),
					"task = asyncio.create_task(late())",
				].join("\n"),
			);
			expect(first.status).toBe("ok");
			release.resolve({});
			await printed.promise;
			if (stateRequests) {
				expect(await manager.listNamespaceNames()).toContain("task");
				expect(await manager.snapshotState()).not.toBeNull();
				const internal = manager.execute("await rlm.host_request('test.internal')", { internal: true });
				await internalStarted.promise;
				nextOutput.resolve({});
				await printedDuring.promise;
				finishInternal.resolve({});
				expect((await internal).status).toBe("ok");
			}
			const second = await manager.execute("print('own-output')");
			expect(second.status).toBe("ok");
			expect(second.stdout).toBe("own-output\n");
			expect(second.backgroundOutput).toBe(`detached-output\n${stateRequests ? "during-internal\n" : ""}`);
			const third = await manager.execute("pass");
			expect(third.backgroundOutput).toBeUndefined();
		},
		15_000,
	);
});
