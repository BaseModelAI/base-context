import { describe, expect, it, vi } from "vitest";
import { AgentDaemon } from "../src/modes/daemon/daemon-mode.js";

const spawn = Reflect.get(AgentDaemon.prototype, "createRlmSubagentRuntime") as (
	this: object,
	parent: unknown,
	options: unknown,
) => Promise<unknown>;
function fixture() {
	const parent = {
		sessionId: "parent",
		sessionFile: "/parent.jsonl",
		requests: { getRequestTokenBudgetOptions: () => undefined },
	};
	const state = { activeSessionId: "parent-active", runtime: { session: parent } };
	const admission = { parent, assertCurrent: vi.fn(), claimFactory: vi.fn(), settle: vi.fn() };
	const host = Object.assign(Object.create(AgentDaemon.prototype), {
		sessions: new Map([[state.activeSessionId, state]]),
		pendingSessionNames: new Set(),
		assertFamilySessionNameAvailable: vi.fn(async () => {}),
		createAdmittedRlmSubagentRuntime: vi.fn(async () => "child"),
	}) as {
		assertFamilySessionNameAvailable: ReturnType<typeof vi.fn>;
		createAdmittedRlmSubagentRuntime: ReturnType<typeof vi.fn>;
	};
	return { host, state, admission, options: { parentSession: parent, admission, sessionName: "worker", rlmDepth: 1 } };
}

describe("daemon child naming admission", () => {
	it("checks the family name before claiming the factory", async () => {
		const f = fixture();
		await expect(spawn.call(f.host, f.state, f.options)).resolves.toBe("child");
		expect(f.host.assertFamilySessionNameAvailable).toHaveBeenCalledWith(
			expect.objectContaining({ name: "worker", depth: 1 }),
			f.state,
			true,
		);
		expect(f.host.assertFamilySessionNameAvailable.mock.invocationCallOrder[0]).toBeLessThan(
			f.admission.claimFactory.mock.invocationCallOrder[0],
		);
	});
	it("rejects a concurrent duplicate before its factory is claimed", async () => {
		const f = fixture();
		let resolve = () => {};
		f.host.createAdmittedRlmSubagentRuntime.mockImplementationOnce(
			() =>
				new Promise<void>((done) => {
					resolve = done;
				}),
		);
		const first = spawn.call(f.host, f.state, f.options);
		const duplicate = { ...f.admission, claimFactory: vi.fn() };
		await expect(spawn.call(f.host, f.state, { ...f.options, admission: duplicate })).rejects.toThrow("worker");
		expect(duplicate.claimFactory).not.toHaveBeenCalled();
		resolve();
		await first;
	});

	it("holds the rename boundary through a failed admission and then releases the name", async () => {
		const f = fixture();
		let fail = (_error: Error) => {};
		f.host.createAdmittedRlmSubagentRuntime.mockImplementationOnce(
			() =>
				new Promise((_resolve, reject) => {
					fail = reject;
				}),
		);
		const first = spawn.call(f.host, f.state, f.options);
		const failed = expect(first).rejects.toThrow("factory failed");
		await Promise.resolve();
		const reserve = Reflect.get(AgentDaemon.prototype, "withSessionNameReservation") as (
			this: object,
			owner: object,
			action: () => Promise<void>,
		) => Promise<void>;
		const rename = vi.fn(async () => {});
		await expect(
			reserve.call(f.host, { name: "worker", depth: 1, parentSessionPath: "/parent.jsonl" }, rename),
		).rejects.toThrow("worker");
		expect(rename).not.toHaveBeenCalled();
		fail(new Error("factory failed"));
		await failed;
		await expect(spawn.call(f.host, f.state, { ...f.options, admission: { ...f.admission } })).resolves.toBe("child");
	});
});
