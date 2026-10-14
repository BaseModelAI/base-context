import { fauxAssistantMessage } from "@ponythewhite/base-context-ai";
import { describe, expect, it, vi } from "vitest";
import { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.js";
import type { AgentSessionServices } from "../../../src/core/agent-session-services.js";
import { SessionManager } from "../../../src/core/session-manager.js";
import { createHarness, type Harness } from "../harness.js";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("runtime replacement shutdown ownership", () => {
	it.each(["shutdown hook", "same-path read"])("preserves the winning session after a stale %s", async (boundary) => {
		const entered = deferred();
		const release = deferred();
		let shutdowns = 0;
		const parent = await createHarness({
			persistSession: true,
			rlmDepth: 0,
			extensionFactories: [
				(pi) => {
					pi.on("session_shutdown", async () => {
						if (++shutdowns === 1 && boundary === "shutdown hook") {
							entered.resolve();
							await release.promise;
						}
					});
				},
			],
		});
		await parent.session.bindExtensions({});
		const openReadOnly = SessionManager.openReadOnly.bind(SessionManager);
		const reader =
			boundary === "same-path read"
				? vi.spyOn(SessionManager, "openReadOnly").mockImplementation(async (...args) => {
						const view = await openReadOnly(...args);
						entered.resolve();
						await release.promise;
						return view;
					})
				: undefined;
		const services = { cwd: parent.tempDir, agentDir: parent.tempDir } as AgentSessionServices;
		const replacements: Harness[] = [];
		const runtime = new AgentSessionRuntime(parent.session, services, async ({ sessionManager }) => {
			const replacement = await createHarness({ sessionManager, rlmDepth: 0 });
			replacements.push(replacement);
			return {
				session: replacement.session,
				extensionsResult: replacement.session.resourceLoader.getExtensions(),
				services,
				diagnostics: [],
			};
		});
		let invalidations = 0;
		runtime.setBeforeSessionInvalidate(() => {
			invalidations++;
		});
		try {
			const losing = (
				boundary === "shutdown hook" ? runtime.newSession() : runtime.switchSession(parent.session.sessionFile!)
			).catch((error: unknown) => error);
			await entered.promise;
			await expect(runtime.newSession()).resolves.toEqual({ cancelled: false });
			const winner = runtime.session;
			release.resolve();
			expect(await losing).toBeInstanceOf(Error);
			expect(runtime.session).toBe(winner);
			expect(Reflect.get(winner, "_disposed")).toBe(false);
			expect(invalidations).toBe(1);
			expect(replacements).toHaveLength(1);
			replacements[0]!.setResponses([fauxAssistantMessage("still active")]);
			await winner.prompt("continue");
		} finally {
			release.resolve();
			reader?.mockRestore();
			runtime.setBeforeSessionInvalidate(undefined);
			await runtime.dispose();
			for (const replacement of replacements) await replacement.cleanup();
			await parent.cleanup();
		}
	});
});
