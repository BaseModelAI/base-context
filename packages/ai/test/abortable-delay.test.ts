import { getEventListeners } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { abortableDelay } from "../src/utils/abortable-delay.js";

afterEach(() => vi.useRealTimers());

describe("abortableDelay", () => {
	it("removes its listener after normal completion", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const wait = abortableDelay(25, controller.signal);
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(25);
		await wait;
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("cleans up on abort and rejects an already-aborted signal without a timer", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const wait = abortableDelay(25, controller.signal);
		const rejected = expect(wait).rejects.toThrow("Request was aborted");
		controller.abort();
		await rejected;
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
		expect(vi.getTimerCount()).toBe(0);
		await expect(abortableDelay(25, controller.signal)).rejects.toThrow("Request was aborted");
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
		expect(vi.getTimerCount()).toBe(0);
	});
});
