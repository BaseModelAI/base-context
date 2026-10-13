import { describe, expect, it, vi } from "vitest";
import { AgentDaemon } from "../src/modes/daemon/daemon-mode.js";

const schedule = Reflect.get(AgentDaemon.prototype, "scheduleRosterFlush") as (
	this: object,
	immediate?: boolean,
) => void;
function fixture() {
	const host = Object.assign(Object.create(AgentDaemon.prototype), {
		options: { worker: {} },
		shuttingDown: false,
		rosterFlushPending: false,
		rosterFlushScheduled: false,
		log: vi.fn(),
	}) as { rosterFlushPending: boolean; flushRoster: ReturnType<typeof vi.fn> };
	host.flushRoster = vi.fn(async () => {
		host.rosterFlushPending = false;
	});
	return host;
}

describe("roster presentation coalescing", () => {
	it("coalesces ordinary updates but publishes lifecycle updates immediately", async () => {
		vi.useFakeTimers();
		try {
			const host = fixture();
			for (let i = 0; i < 10; i++) schedule.call(host, false);
			await vi.advanceTimersByTimeAsync(249);
			expect(host.flushRoster).not.toHaveBeenCalled();
			schedule.call(host, true);
			await vi.advanceTimersByTimeAsync(0);
			expect(host.flushRoster).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(250);
			expect(host.flushRoster).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});
	it("keeps the ordinary delay when an earlier flush settles", async () => {
		vi.useFakeTimers();
		try {
			const host = fixture();
			let release = () => {};
			host.flushRoster.mockImplementationOnce(() => {
				host.rosterFlushPending = false;
				return new Promise<void>((resolve) => {
					release = resolve;
				});
			});
			schedule.call(host, true);
			await vi.advanceTimersByTimeAsync(0);
			schedule.call(host, false);
			release();
			await vi.advanceTimersByTimeAsync(0);
			expect(host.flushRoster).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(250);
			await vi.runOnlyPendingTimersAsync();
			expect(host.flushRoster).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});
});
