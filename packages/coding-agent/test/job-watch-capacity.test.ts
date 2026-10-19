import { afterEach, describe, expect, it } from "vitest";
import { JobWatchController, type WatchDeclaration } from "../src/core/job-watch.js";

const controllers: JobWatchController[] = [];
afterEach(() => {
	for (const controller of controllers.splice(0)) controller.dispose();
});

function fixture() {
	const clock = { now: Date.parse("2026-01-01T00:00:00Z") };
	const deliveries = new Map<string, "queued" | "selected">();
	const controller = new JobWatchController({
		sessionId: "capacity-owner",
		current: () => true,
		goalId: () => undefined,
		now: () => clock.now,
		probe: async () => {},
		cancelProbe: () => {},
		persist: async () => {},
		waitForDelivery: true,
		admit: (_text, id) => {
			deliveries.set(id, "queued");
			return true;
		},
		deliveryPending: (id) => deliveries.has(id),
		revokeQueued: (id) => deliveries.get(id) === "queued" && deliveries.delete(id),
		onError: (error) => {
			throw error;
		},
	});
	controllers.push(controller);
	return {
		controller,
		clock,
		deliveries,
		add: async (index: number, report_every?: string) => {
			const result = await controller.watch({
				resource_id: `resource-${index}`,
				job_id: `job-${index}`,
				completion_source: "probe",
				probe_command: "read-only-status",
				report_every,
			});
			return controller.snapshot().watches.find((watch) => watch.id === result.id)!;
		},
		observe: (watch: WatchDeclaration, state: string) =>
			controller.observe({
				id: watch.id,
				generation: watch.generation,
				source: "probe",
				observation: {
					observed_at: new Date(clock.now).toISOString(),
					job_id: watch.job_id,
					state,
					progress: {},
					attention: [],
					evidence: [`job-${watch.job_id}.log`],
				},
			}),
	};
}

describe("job-watch capacity", () => {
	it("reuses drained terminal slots while retaining cached results across restore", async () => {
		const f = fixture();
		for (let index = 0; index < 17; index++) {
			const watch = await f.add(index);
			await f.observe(watch, "succeeded");
			expect((await f.controller.consume(watch.id)).events).toHaveLength(1);
		}
		const snapshot = f.controller.snapshot();
		expect(snapshot.watches).toHaveLength(17);
		const first = snapshot.watches[0];
		expect(f.controller.status(first.id)).toMatchObject({ state: "succeeded", pending_events: 0 });

		const restored = fixture();
		await restored.controller.restore(snapshot);
		expect(restored.controller.snapshot().watches).toEqual(snapshot.watches);
		expect(restored.controller.status(first.id)).toEqual(f.controller.status(first.id));
		await restored.add(17);
		expect(restored.controller.snapshot().watches).toHaveLength(18);
	});

	it("keeps queued reports and selected evidence in the sixteen-slot limit until drained", async () => {
		const f = fixture();
		const watched = await f.add(0, "10s");
		for (let index = 1; index < 16; index++) await f.add(index);
		f.clock.now += 10_000;
		await f.observe(watched, "running");
		const selected = f.controller.snapshot().watches[0].pending[0];
		f.deliveries.set(selected.id, "selected");
		f.clock.now += 10_000;
		await f.observe(watched, "running");
		await f.observe(watched, "failed");
		const pending = f.controller.snapshot().watches[0].pending;
		expect(pending).toHaveLength(3);
		await expect(f.add(16)).rejects.toThrow("16 active or unresolved watches");
		expect(f.controller.snapshot().watches[0].pending).toEqual(pending);

		const consumed = await f.controller.consume(watched.id);
		expect(consumed.deferred_event_ids).toEqual([selected.id]);
		expect(consumed.events).toEqual(pending.slice(1).map((event) => JSON.parse(event.text)));
		expect(consumed.events.map((event) => event.reasons)).toEqual([["report"], ["failure"]]);
		expect(f.controller.snapshot().watches[0].pending).toEqual([selected]);
		await expect(f.add(16)).rejects.toThrow("16 active or unresolved watches");

		f.deliveries.delete(selected.id);
		await f.controller.acknowledge(selected.id);
		await f.add(16);
		expect(f.controller.status(watched.id)).toMatchObject({
			state: "failed",
			pending_events: 0,
			evidence: [`job-${watched.job_id}.log`],
		});
		expect(f.controller.snapshot().watches).toHaveLength(17);
	});
});
