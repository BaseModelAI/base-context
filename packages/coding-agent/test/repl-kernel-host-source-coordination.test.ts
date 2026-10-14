import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDeferred, ReplKernelManager } from "../src/core/kernel/index.js";
import { createRlmRunHostHandler, type RlmRunRequest } from "../src/core/rlm-runtime.js";

const runtime = resolve(__dirname, "../../../prime-agent-runtime");
const python = join(runtime, ".venv/bin/python");
const describeIfKernel = existsSync(python) ? describe : describe.skip;

describeIfKernel("detached host request source qualification", () => {
	let manager: ReplKernelManager | undefined;
	let dir: string | undefined;

	afterEach(async () => {
		await manager?.shutdown({ drainHostRequests: true });
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	it.each([true, false])(
		"never attributes a detached request to the active newer cell (internal: %s)",
		async (internal) => {
			dir = mkdtempSync(join(tmpdir(), "kernel-host-source-"));
			const release = createDeferred<Record<string, unknown>>();
			const active = createDeferred<void>();
			const finish = createDeferred<Record<string, unknown>>();
			const received = createDeferred<RlmRunRequest>();
			const completed = createDeferred<void>();
			manager = new ReplKernelManager({
				python,
				cwd: dir,
				env: { PYTHONPATH: join(runtime, "src"), BASE_CONTEXT_RLM_DEPTH: "0", BASE_CONTEXT_RLM_MAX_DEPTH: "2" },
				hostHandlers: {
					"test.release": async () => release.promise,
					"test.active": async () => {
						active.resolve();
						return finish.promise;
					},
					"test.completed": async () => {
						completed.resolve();
						return {};
					},
					"rlm.run": createRlmRunHostHandler(async (request) => {
						received.resolve(request);
						return { rlm_child_id: "offline-child", name: "offline", session_dir: dir!, model: "faux/test" };
					}),
				},
			});
			const source = [
				"import asyncio, rlm",
				"async def spawn_later():",
				"    await rlm.host_request('test.release')",
				"    child = await rlm.run('offline prompt', name='offline')",
				"    await rlm.host_request('test.completed')",
				"task = asyncio.create_task(spawn_later())",
			].join("\n");
			expect((await manager.execute(source)).status).toBe("ok");
			const newer = manager.execute("await rlm.host_request('test.active')", { internal });
			await active.promise;
			release.resolve({});
			const request = await received.promise;
			await completed.promise;
			finish.resolve({});
			expect((await newer).status).toBe("ok");
			expect(request.prompt).toBe("offline prompt");
			expect(request.kwargs).toEqual({ name: "offline" });
			expect(request.cellSourceCode).toBe(internal ? source : undefined);
		},
		15_000,
	);
});
