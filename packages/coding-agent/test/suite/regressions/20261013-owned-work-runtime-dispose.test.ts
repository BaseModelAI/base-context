import { describe, expect, it } from "vitest";
import { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.js";
import type { AgentSessionServices } from "../../../src/core/agent-session-services.js";
import { createHarness, type Harness } from "../harness.js";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("runtime replacement disposal", () => {
	it("joins admitted replacement setup and never publishes it after disposal starts", async () => {
		const parent = await createHarness({ persistSession: true, provider: "runtime-parent" });
		const services = { cwd: parent.tempDir, agentDir: parent.tempDir } as AgentSessionServices;
		const started = deferred();
		const release = deferred();
		let replacement: Harness | undefined;
		const runtime = new AgentSessionRuntime(parent.session, services, async ({ sessionManager }) => {
			started.resolve();
			await release.promise;
			replacement = await createHarness({ sessionManager, provider: "runtime-replacement" });
			return {
				session: replacement.session,
				extensionsResult: replacement.session.resourceLoader.getExtensions(),
				services,
				diagnostics: [],
			};
		});
		try {
			const replacing = runtime.newSession().then(
				() => undefined,
				(error: unknown) => error,
			);
			await started.promise;
			let disposed = false;
			const disposal = runtime.dispose().then(() => {
				disposed = true;
			});
			await new Promise<void>((resolve) => setImmediate(resolve));
			const disposedBeforeFactoryFinished = disposed;
			release.resolve();
			const [failure] = await Promise.all([replacing, disposal]);
			expect(disposedBeforeFactoryFinished).toBe(false);
			expect(failure).toBeInstanceOf(Error);
			expect(runtime.session).toBe(parent.session);
			expect(Reflect.get(replacement!.session, "_disposed")).toBe(true);
			await expect(runtime.newSession()).rejects.toThrow(/dispos/);
		} finally {
			release.resolve();
			await runtime.dispose();
			await replacement?.cleanup();
			await parent.cleanup();
		}
	});
});
