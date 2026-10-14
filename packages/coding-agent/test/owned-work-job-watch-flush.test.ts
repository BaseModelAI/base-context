import { describe, expect, it } from "vitest";
import { JobWatchController } from "../src/core/job-watch.js";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("job-watch flush ownership", () => {
	it("delivers evidence prepared while the prior flush saves its result", async () => {
		const saving = deferred();
		const release = deferred();
		const prepared = deferred();
		let accepts = false;
		let holdNextSave = false;
		let awaitingSecond = false;
		const notices: string[] = [];
		const controller = new JobWatchController({
			sessionId: "owner",
			current: () => true,
			goalId: () => undefined,
			probe: async () => {},
			cancelProbe: () => {},
			persist: async () => {
				if (holdNextSave) {
					holdNextSave = false;
					saving.resolve();
					await release.promise;
				} else if (awaitingSecond) prepared.resolve();
			},
			admit: (text) => {
				if (!accepts) return false;
				notices.push(text);
				return true;
			},
			onError: (error) => {
				throw error;
			},
		});
		try {
			const watch = await controller.watch({ resource_id: "job", completion_source: "handle" });
			const observation = (state: string, attention: string[]) =>
				controller.observe({
					id: watch.id,
					generation: watch.generation,
					source: "handle",
					observation: { observed_at: new Date().toISOString(), job_id: "job", state, attention },
				});
			await observation("running", ["needs attention"]);
			accepts = true;
			holdNextSave = true;
			const flushing = controller.flushPending();
			await saving.promise;
			awaitingSecond = true;
			const finishing = observation("failed", []);
			await prepared.promise;
			await Promise.resolve();
			release.resolve();
			await Promise.all([flushing, finishing]);
			expect(notices.map((text) => JSON.parse(text).state)).toEqual(["running", "failed"]);
			expect(controller.status(watch.id as string).pending_events).toBe(0);
		} finally {
			release.resolve();
			controller.dispose();
		}
	});
});
