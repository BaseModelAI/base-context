import type { AgentTool } from "@ponythewhite/base-context-agent";
import { fauxAssistantMessage, fauxToolCall } from "@ponythewhite/base-context-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.js";
import type { HostRequestHandlers } from "../../src/core/kernel/index.js";
import { runPrintMode } from "../../src/modes/print-mode.js";
import { createHarness, type Harness } from "./harness.js";

const output = vi.hoisted(() => ({ write: vi.fn(), flush: vi.fn(async () => {}) }));
vi.mock("../../src/core/output-guard.js", () => ({ writeRawStdout: output.write, flushRawStdout: output.flush }));

const harnesses: Harness[] = [];
const releases: Array<() => void> = [];
function gate() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	releases.push(resolve);
	return { promise, resolve };
}
function runtime(harness: Harness) {
	const disposing = gate();
	const host = {
		session: harness.session,
		setRebindSession: vi.fn(),
		dispose: vi.fn(() => {
			disposing.resolve();
			return harness.session.disposeAsync();
		}),
	};
	return { host: host as unknown as AgentSessionRuntime, dispose: host.dispose, disposing: disposing.promise };
}
const toolCall = (code: string) => fauxAssistantMessage(fauxToolCall("ipython", { code }), { stopReason: "toolUse" });
afterEach(async () => {
	for (const release of releases.splice(0)) release();
	for (const harness of harnesses.splice(0).reverse()) await harness.cleanup();
	vi.restoreAllMocks();
	output.write.mockClear();
});

describe("print-mode owned-work completion", () => {
	it.each(["stop", "error"] as const)(
		"waits for the owned child's %s result and final parent turn before disposal",
		async (stopReason) => {
			const childStarted = gate();
			const childFinished = gate();
			const barrierEntered = gate();
			const child = await createHarness({ settings: { retry: { enabled: false } } });
			harnesses.push(child);
			if (stopReason === "error") {
				const handlers: HostRequestHandlers = Reflect.get(child.session, "_createKernelHostHandlers").call(
					child.session,
				);
				const watch = await handlers["job_watch.watch"]({
					resource_id: "child-owned",
					job_id: "child-owned",
					completion_source: "handle",
				});
				await handlers["job_watch.park"]({ ids: [watch.id] });
			}
			child.setResponses([
				async () => {
					childStarted.resolve();
					await childFinished.promise;
					return fauxAssistantMessage("Child result is ready.", {
						stopReason,
						errorMessage: stopReason === "error" ? "child provider failure" : undefined,
					});
				},
			]);
			let parent!: Harness;
			const tool: AgentTool = {
				name: "ipython",
				label: "ipython",
				description: "Local delegation",
				parameters: Type.Object({ code: Type.String() }),
				execute: async () => {
					await parent.session.runRlmChild("Prepare the result", { name: "result-worker" });
					return { content: [{ type: "text", text: "Child admitted." }], details: {} };
				},
			};
			parent = await createHarness({
				tools: [tool],
				rlmDepth: 0,
				rlmMaxDepth: 1,
				subagentRuntimeHost: {
					createRlmSubagentRuntime: async () => ({ session: child.session }),
					deleteRlmSubagentRuntime: async (_id, session) => {
						await session?.disposeAsync();
					},
				},
			});
			harnesses.push(parent);
			parent.setResponses([
				toolCall("delegate"),
				fauxAssistantMessage("The child is still running."),
				fauxAssistantMessage("Final artifact is complete."),
			]);
			const original = parent.session.waitForRlmQuiescence.bind(parent.session);
			vi.spyOn(parent.session, "waitForRlmQuiescence").mockImplementation((...args) => {
				const waiting = original(...args);
				barrierEntered.resolve();
				return waiting;
			});
			const host = runtime(parent);
			const run = runPrintMode(host.host, { mode: "text", initialMessage: "Finish the artifact using the child." });
			await childStarted.promise;
			try {
				expect(
					await Promise.race([
						barrierEntered.promise.then(() => "waiting"),
						host.disposing.then(() => "shutdown"),
					]),
				).toBe("waiting");
				expect(host.dispose).not.toHaveBeenCalled();
			} finally {
				childFinished.resolve();
				await run;
			}
			expect(await run).toBe(0);
			expect(output.write).toHaveBeenCalledWith("Final artifact is complete.\n");
			expect(output.write).not.toHaveBeenCalledWith("The child is still running.\n");
			expect(parent.faux.state.callCount).toBe(3);
		},
	);

	async function parkedFixture(stopReason: "stop" | "error" = "stop") {
		let handlers!: HostRequestHandlers;
		let watch!: Record<string, unknown>;
		const tool: AgentTool = {
			name: "ipython",
			label: "ipython",
			description: "Local watch bridge",
			parameters: Type.Object({ code: Type.String() }),
			execute: async () => {
				watch = await handlers["job_watch.watch"]({
					resource_id: "owned",
					job_id: "owned",
					completion_source: "handle",
				});
				await handlers["job_watch.park"]({ ids: [watch.id] });
				return { content: [{ type: "text", text: "Owned watch parked." }], details: {} };
			},
		};
		const harness = await createHarness({ tools: [tool], settings: { retry: { enabled: false } } });
		harnesses.push(harness);
		handlers = Reflect.get(harness.session, "_createKernelHostHandlers").call(harness.session);
		harness.setResponses([
			toolCall("park"),
			fauxAssistantMessage("Waiting for the owned job.", {
				stopReason,
				errorMessage: stopReason === "error" ? "fixture provider failure" : undefined,
			}),
			fauxAssistantMessage("Owned job result consumed."),
		]);
		return { harness, handlers, watch: () => watch };
	}

	it.each(["complete", "cancel"] as const)(
		"keeps a parked owned watch alive until %s without polling",
		async (outcome) => {
			const f = await parkedFixture();
			const activityEntered = gate();
			const session = f.harness.session as unknown as {
				_waitForSessionActivityChange: (signal: AbortSignal) => Promise<void>;
			};
			const original = session._waitForSessionActivityChange.bind(session);
			vi.spyOn(session, "_waitForSessionActivityChange").mockImplementation((signal) => {
				const waiting = original(signal);
				activityEntered.resolve();
				return waiting;
			});
			const host = runtime(f.harness);
			const error = vi.spyOn(console, "error").mockImplementation(() => {});
			const run = runPrintMode(host.host, { mode: "text", initialMessage: "Wait for the job and use its result." });
			expect(await Promise.race([activityEntered.promise.then(() => "waiting"), run.then(() => "exited")])).toBe(
				"waiting",
			);
			expect(host.dispose).not.toHaveBeenCalled();
			if (outcome === "cancel") {
				f.harness.session.requestAbort();
				expect(await run).toBe(1);
				expect(error).toHaveBeenCalledWith("RLM quiescence wait cancelled");
			} else {
				await f.handlers["job_watch.observation"]({
					id: f.watch().id,
					generation: f.watch().generation,
					result: {
						source: "handle",
						observation: {
							observed_at: new Date().toISOString(),
							job_id: "owned",
							state: "succeeded",
							progress: {},
							attention: [],
							evidence: [],
						},
					},
				});
				expect(await run).toBe(0);
				expect(output.write).toHaveBeenCalledWith("Owned job result consumed.\n");
			}
		},
	);

	it("does not hide a provider failure arriving after a parked wait begins", async () => {
		const f = await parkedFixture();
		const activityEntered = gate();
		const session = f.harness.session as unknown as {
			_waitForSessionActivityChange: (signal: AbortSignal) => Promise<void>;
		};
		const original = session._waitForSessionActivityChange.bind(session);
		vi.spyOn(session, "_waitForSessionActivityChange").mockImplementation((signal) => {
			const waiting = original(signal);
			activityEntered.resolve();
			return waiting;
		});
		const host = runtime(f.harness);
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const run = runPrintMode(host.host, { mode: "text", initialMessage: "Start the owned job." });
		expect(await Promise.race([activityEntered.promise.then(() => "waiting"), run.then(() => "exited")])).toBe(
			"waiting",
		);
		f.harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "fixture provider failure" }),
		]);
		await f.harness.session.prompt("Work on another part while the job runs.");
		expect(await run).toBe(1);
		expect(error).toHaveBeenCalledWith("fixture provider failure");
		expect(f.harness.faux.state.callCount).toBe(3);
	});
});
