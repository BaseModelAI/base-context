import { fauxAssistantMessage } from "@ponythewhite/base-context-ai";
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

describe("runtime replacement callback ownership", () => {
	it.each([false, true])("keeps callbacks on their replacement (superseded: %s)", async (superseded) => {
		const parent = await createHarness({ persistSession: true, rlmDepth: 0 });
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
		const entered = deferred();
		const release = deferred();
		let rebinds = 0;
		runtime.setRebindSession(async () => {
			if (++rebinds === 1) {
				entered.resolve();
				await release.promise;
			}
		});
		const notified: string[] = [];
		runtime.onSessionReplaced((session) => {
			notified.push(session.sessionId);
		});
		let callbacks = 0;
		try {
			const first = runtime
				.newSession({
					withSession: async (ctx) => {
						callbacks++;
						await ctx.sendMessage({
							customType: "replacement-callback",
							content: "first replacement only",
							display: false,
						});
					},
				})
				.catch((error: unknown) => error);
			await entered.promise;
			if (superseded) await runtime.newSession();
			const winner = runtime.session;
			release.resolve();
			const result = await first;
			expect(callbacks).toBe(superseded ? 0 : 1);
			expect(notified).toEqual([winner.sessionId]);
			if (superseded) expect(result).toBeInstanceOf(Error);
			else expect(result).toEqual({ cancelled: false });
			expect(
				winner.messages.some(
					(message) => message.role === "custom" && message.customType === "replacement-callback",
				),
			).toBe(!superseded);
			replacements.at(-1)!.setResponses([fauxAssistantMessage("still active")]);
			await winner.prompt("continue");
		} finally {
			release.resolve();
			runtime.setRebindSession(undefined);
			await runtime.dispose();
			for (const replacement of replacements) await replacement.cleanup();
			await parent.cleanup();
		}
	});
});
