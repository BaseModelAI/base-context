import { afterEach, describe, expect, it, vi } from "vitest";
import { JobWatchController, type JobWatchProbeRequest, type JobWatchSnapshot } from "../src/core/job-watch.js";

const controllers: JobWatchController[] = [];
afterEach(() => {
	for (const controller of controllers.splice(0)) controller.dispose();
	vi.useRealTimers();
});
function fixture(waitForDelivery = false, stateBudgetBytes?: number, sessionId = "s1") {
	vi.useFakeTimers();
	let now = Date.parse("2026-01-01T00:00:00Z");
	let current = true;
	let goalId: string | undefined = "goal-1";
	let admits = true;
	let stored: JobWatchSnapshot | undefined;
	const notices: Array<Record<string, unknown>> = [];
	const deliveries = new Map<string, "queued" | "selected">();
	const probes: JobWatchProbeRequest[] = [];
	let observation: Record<string, unknown> | undefined;
	const cancelled: string[] = [];
	const errors: unknown[] = [];
	let persist: (state: JobWatchSnapshot) => Promise<void> = async () => {};
	let retain: () => Promise<string | undefined> = async () => "/retained/probe.log";
	const controller = new JobWatchController({
		sessionId,
		sessionFile: `/session/${sessionId}`,
		current: () => current,
		goalId: () => goalId,
		now: () => now,
		persist: async (state) => {
			await persist(state);
			stored = structuredClone(state);
		},
		cancelProbe: (id) => {
			cancelled.push(id);
		},
		probe: async (request) => {
			probes.push(request);
			await controller.observe({
				id: request.id,
				generation: request.generation,
				source: "probe",
				observation: observation ?? {
					observed_at: new Date(now).toISOString(),
					job_id: request.job_id,
					state: "running",
					progress: { updates: 1 },
					attention: [],
					evidence: ["metrics.json"],
				},
			});
		},
		waitForDelivery,
		stateBudgetBytes,
		admit: (text, id) => {
			if (!admits) return false;
			notices.push(JSON.parse(text));
			if (waitForDelivery) deliveries.set(id, "queued");
			return true;
		},
		deliveryPending: (id) => deliveries.has(id),
		revokeQueued: (id) => deliveries.get(id) === "queued" && deliveries.delete(id),
		retain: () => retain(),
		onError: (error) => {
			errors.push(error);
		},
	});
	controllers.push(controller);
	return {
		controller,
		notices,
		deliveries,
		probes,
		cancelled,
		errors,
		snapshot: () => stored!,
		advance: async (ms = 300000) => {
			now += ms;
			await controller.runDue();
		},
		setObservation: (value: Record<string, unknown>) => {
			observation = value;
		},
		setAdmits: (value: boolean) => {
			admits = value;
		},
		setCurrent: (value: boolean) => {
			current = value;
		},
		setGoal: (value: string) => {
			goalId = value;
		},
		setPersist: (value: typeof persist) => {
			persist = value;
		},
		setRetain: (value: typeof retain) => {
			retain = value;
		},
		observation: (state = "running", updates = 1) => ({
			observed_at: new Date(now).toISOString(),
			job_id: "job",
			state,
			progress: { updates },
			attention: [],
			evidence: ["metrics.json"],
		}),
	};
}
async function watch(f: ReturnType<typeof fixture>, extra: Record<string, unknown> = {}) {
	return (await f.controller.watch({
		resource_id: "resource",
		job_id: "job",
		completion_source: "probe",
		probe_command: "project-summary",
		interval: "5m",
		...extra,
	})) as { id: string; generation: string };
}
function observe(
	f: ReturnType<typeof fixture>,
	w: { id: string; generation: string },
	observation: Record<string, unknown>,
	extra = {},
) {
	return f.controller.observe({ ...w, source: "probe", observation, ...extra });
}

describe("job-watch deterministic scheduling", () => {
	it("does not readmit consumed evidence while a resumed flush awaits persistence", async () => {
		const f = fixture(true);
		const first = await watch(f, { report_every: "5m" });
		const second = await watch(f, { resource_id: "second", report_every: "5m" });
		f.setAdmits(false);
		await f.advance();
		const event = f.snapshot().watches[0].pending[0];
		let release!: () => void;
		let started!: () => void;
		const entered = new Promise<void>((resolve) => {
			started = resolve;
		});
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let block = true;
		f.setPersist(async () => {
			if (!block) return;
			block = false;
			started();
			await held;
		});
		f.setAdmits(true);
		const flushing = f.controller.flushPending();
		await entered;
		try {
			expect(await f.controller.consume(first.id)).toEqual({
				events: [JSON.parse(event.text)],
				deferred_event_ids: [],
			});
		} finally {
			release();
			await flushing;
		}
		expect(f.notices).toHaveLength(1);
		expect(f.notices[0]).toMatchObject({ watch_id: second.id, reasons: ["report"] });
		expect(f.deliveries.has(event.id)).toBe(false);
		expect(f.controller.status(first.id)).toMatchObject({ pending_events: 0 });
	});

	it("preserves an earlier unrelated hold when a later park finds consumed completion", async () => {
		const f = fixture(true);
		const active = await watch(f);
		const completed = await watch(f, { resource_id: "completed" });
		await observe(f, completed, f.observation("succeeded"));
		await f.controller.consume(completed.id);
		expect(await f.controller.park([active.id])).toMatchObject({ parked: true });
		expect(await f.controller.park([completed.id])).toEqual({ parked: false, reason: "event_available" });
		expect(f.controller.isParked()).toBe(true);
		expect(f.snapshot().parked?.ids).toEqual([active.id]);
	});
	it("keeps late-park promotion scoped and releases its hold on explicit consume", async () => {
		const f = fixture(true);
		const awaited = await watch(f);
		const background = await watch(f, { resource_id: "background" });
		await observe(f, awaited, f.observation("succeeded"));
		await observe(f, background, f.observation("succeeded"));
		const [awaitedEvent, backgroundEvent] = f.snapshot().watches.map((item) => item.pending[0]);
		expect(f.notices).toEqual([]);
		f.setAdmits(false);

		expect(await f.controller.park([awaited.id])).toMatchObject({ parked: true });
		expect(f.controller.isParked()).toBe(true);
		expect(f.snapshot().watches[0].pending).toEqual([{ ...awaitedEvent, wake: true, uncertain: false }]);
		expect(f.snapshot().watches[1].pending).toEqual([backgroundEvent]);
		expect(f.notices).toEqual([]);

		expect(await f.controller.consume(awaited.id)).toEqual({
			events: [JSON.parse(awaitedEvent.text)],
			deferred_event_ids: [],
		});
		expect(f.controller.isParked()).toBe(false);
		expect(await f.controller.park([awaited.id])).toEqual({ parked: false, reason: "event_available" });
		f.setAdmits(true);
		await f.controller.flushPending();
		expect(f.notices).toEqual([]);
		expect(f.snapshot().watches[1].pending).toEqual([backgroundEvent]);
		expect(await f.controller.consume(background.id)).toEqual({
			events: [JSON.parse(backgroundEvent.text)],
			deferred_event_ids: [],
		});
		expect(await f.controller.consume()).toEqual({ events: [], deferred_event_ids: [] });
	});
	it("checks twenty times without a wake, then admits one terminal event despite callback races", async () => {
		const f = fixture();
		const w = await watch(f, { completion_source: "handle", probe_command: undefined });
		await f.controller.park([w.id]);
		for (let i = 0; i < 20; i++) await f.advance();
		expect(f.probes).toHaveLength(20);
		expect(f.notices).toHaveLength(0);
		expect(f.controller.isParked()).toBe(true);
		await Promise.all([0, 1].map(() => observe(f, w, f.observation("succeeded"), { source: "handle" })));
		expect(f.notices).toHaveLength(1);
		expect(f.controller.isParked()).toBe(false);
		console.info(
			"job-watch-measurement",
			JSON.stringify({
				fixture: "20-unchanged-local",
				checks: f.probes.length,
				noChangeAdmissions: 0,
				terminalAdmissions: f.notices.length,
				notificationBytes: Buffer.byteLength(JSON.stringify(f.notices[0])),
				stateBytes: Buffer.byteLength(JSON.stringify(f.snapshot())),
			}),
		);
		await f.advance();
		expect(f.probes).toHaveLength(20);
	});
	it("delivers five-minute snapshots and terminal results for two jobs without changing checks", async () => {
		const f = fixture();
		let launches = 0;
		for (let job = 0; job < 2; job++) {
			launches++;
			const w = await watch(f, {
				resource_id: "shared-resource",
				job_id: `job-${job}`,
				report_every: "5m",
				fields: ["updates"],
			});
			for (let tick = 1; tick <= 6; tick++) {
				f.setObservation({ ...f.observation(tick === 6 ? "succeeded" : "running", tick), job_id: `job-${job}` });
				await f.advance();
				if (tick < 6) expect(await f.controller.park([w.id])).toMatchObject({ parked: true });
			}
			expect(f.controller.status(w.id)).toMatchObject({ active: false });
			await f.controller.unregister(w.id);
		}
		await f.advance(3600000);
		expect(launches).toBe(2);
		expect(f.probes).toHaveLength(12);
		const reports = f.notices.filter((notice) => (notice.reasons as string[]).includes("report"));
		expect(reports).toHaveLength(10);
		expect(new Set(reports.map((r) => r.event_id)).size).toBe(10);
		expect(reports.map((r) => r.job_id)).toEqual([...Array(5).fill("job-0"), ...Array(5).fill("job-1")]);
		expect(f.notices.filter((notice) => notice.state === "succeeded")).toHaveLength(2);
		expect(f.notices).toHaveLength(12);
		console.info(
			"job-watch-measurement",
			JSON.stringify({
				fixture: "two-sequential-30m",
				launchedJobs: launches,
				checks: f.probes.length,
				reports: reports.length,
				preparedAdmissions: f.notices.length,
				notificationBytes: f.notices.reduce((sum, n) => sum + Buffer.byteLength(JSON.stringify(n)), 0),
				stateBytes: Buffer.byteLength(JSON.stringify(f.snapshot())),
			}),
		);
		expect(reports.every((r) => (r.progress as Record<string, unknown>).updates !== undefined)).toBe(true);
	});
	it("deduplicates observability failures, preserves the first and observed terminal failure", async () => {
		const f = fixture();
		const w = await watch(f);
		await f.controller.observe({ ...w, source: "probe", error: "partial JSON", output: "{" });
		await f.controller.observe({ ...w, source: "probe", error: "partial JSON", output: "{" });
		await f.controller.observe({ ...w, source: "probe", error: "transport lost" });
		await observe(f, w, f.observation());
		await observe(f, w, f.observation("failed"));
		expect(f.notices.map((n) => n.reasons)).toEqual([["observability"], ["observability"], ["failure"]]);
		expect(f.notices[0]).toMatchObject({ state: "unknown", evidence: ["/retained/probe.log"] });
		expect(f.controller.status(w.id)).toMatchObject({ state: "failed", active: false });
	});
	it("compares only selected fields and ignores changing timestamps", async () => {
		const f = fixture();
		const w = await watch(f, { notify: "changes", fields: ["updates"] });
		await observe(f, w, f.observation());
		await observe(f, w, {
			...f.observation(),
			observed_at: "2026-01-02T00:00:00Z",
			progress: { updates: 1, noise: 9 },
		});
		expect(f.notices).toHaveLength(0);
		await observe(f, w, f.observation("running", 2));
		expect(f.notices).toHaveLength(0);
		expect(f.controller.status(w.id)).toMatchObject({ pending_events: 1, progress: { updates: 2 } });
		expect(await f.controller.park([w.id])).toMatchObject({ parked: true });
	});
	it("does not mistake SSH launcher exit for remote completion", async () => {
		const f = fixture();
		const w = await watch(f);
		await observe(f, w, f.observation("succeeded"), { source: "handle" });
		expect(f.notices).toHaveLength(0);
		expect(f.controller.status(w.id)).toMatchObject({ active: true });
		await observe(f, w, f.observation("succeeded"));
		expect(f.notices).toHaveLength(0);
		expect(f.controller.status(w.id)).toMatchObject({ state: "succeeded", pending_events: 1 });
		expect(await f.controller.consume(w.id)).toMatchObject({ events: [{ state: "succeeded" }] });
	});
	it("keeps each requested report while admission is cancelled", async () => {
		const f = fixture();
		const w = await watch(f, { report_every: "5m" });
		await f.controller.park([w.id]);
		f.setAdmits(false);
		await f.advance(900000);
		expect(f.probes).toHaveLength(1);
		expect(f.notices).toHaveLength(0);
		expect(f.snapshot().watches[0].pending).toHaveLength(3);
		f.setAdmits(true);
		await f.controller.flushPending();
		expect(f.notices).toHaveLength(3);
		expect(f.notices.map((notice) => notice.late_by_ms)).toEqual([600000, 300000, 0]);
		expect(f.notices.map((notice) => notice.scheduled_for)).toEqual([
			"2026-01-01T00:05:00.000Z",
			"2026-01-01T00:10:00.000Z",
			"2026-01-01T00:15:00.000Z",
		]);
		expect(f.controller.isParked()).toBe(false);
	});
	it("restores only authoritative probes; handles become unknown and imported/forked owners stay inactive", async () => {
		const f = fixture();
		const w = await watch(f, { completion_source: "handle", probe_command: "progress-only" });
		await f.controller.park([w.id]);
		const saved = f.snapshot();
		f.controller.dispose();
		const resumed = fixture();
		await resumed.controller.restore(saved);
		expect(resumed.notices).toHaveLength(1);
		expect(resumed.controller.status(w.id)).toMatchObject({ state: "unknown", active: false });
		await resumed.advance();
		expect(resumed.probes).toHaveLength(0);
		const fork = fixture();
		await fork.controller.restore({ ...saved, session_id: "another" });
		expect(fork.controller.status()).toMatchObject({ watches: [] });
	});
	it("reconciles a restored external watch without PID attachment or job relaunch", async () => {
		const f = fixture();
		await watch(f);
		const saved = f.snapshot();
		f.controller.dispose();
		const resumed = fixture();
		await resumed.controller.restore(saved);
		await resumed.advance(0);
		expect(resumed.probes).toHaveLength(1);
		expect(resumed.notices).toHaveLength(0);
		expect(resumed.probes[0].command).toBe("project-summary");
	});
	it("unregister is idempotent, cancels only probes, and stale events cannot wake a new owner", async () => {
		const f = fixture();
		const w = await watch(f);
		await f.controller.park([w.id]);
		f.setGoal("goal-2");
		expect(f.controller.isParked()).toBe(false);
		await observe(f, w, f.observation("succeeded"));
		expect(f.notices).toHaveLength(0);
		await f.controller.unregister(w.id);
		await f.controller.unregister(w.id);
		expect(f.cancelled).toEqual([w.id]);
		f.setCurrent(false);
		await observe(f, w, f.observation("failed"));
		expect(f.notices).toHaveLength(0);
	});
	it("rejects goal changes during retention and never flushes old-goal queued evidence", async () => {
		const f = fixture();
		const w = await watch(f);
		let release!: () => void;
		let started!: () => void;
		const retaining = new Promise<void>((resolve) => {
			started = resolve;
		});
		f.setRetain(() => {
			started();
			return new Promise<string>((resolve) => {
				release = () => resolve("/retained/log");
			});
		});
		const inFlight = observe(f, w, f.observation("failed"), { output: "failure details" });
		await retaining;
		f.setGoal("goal-2");
		release();
		await inFlight;
		expect(f.notices).toHaveLength(0);
		f.setGoal("goal-1");
		f.setAdmits(false);
		await observe(f, w, f.observation("failed"));
		expect(f.snapshot().watches[0].pending).toHaveLength(1);
		f.setGoal("goal-2");
		f.setAdmits(true);
		await f.controller.flushPending();
		expect(f.notices).toHaveLength(0);
	});
	it("keeps forty checks and all required report bodies while admission is held", async () => {
		const f = fixture();
		const w = await watch(f, { report_every: "5m", fields: ["updates"] });
		f.setAdmits(false);
		for (let i = 1; i <= 40; i++) {
			f.setObservation(f.observation("running", i));
			await f.advance();
		}
		expect(f.probes).toHaveLength(40);
		expect(f.snapshot().watches[0].pending).toHaveLength(40);
		f.setAdmits(true);
		await f.controller.flushPending();
		expect(f.notices).toHaveLength(40);
		expect(f.controller.status(w.id)).toMatchObject({ pending_events: 0 });
		expect(f.notices.map((notice) => (notice.progress as Record<string, unknown>).updates)).toEqual(
			Array.from({ length: 40 }, (_, index) => index + 1),
		);
	});
	it("keeps five-minute checks when reports and a deadline fall between them", async () => {
		const f = fixture();
		const w = await watch(f, { report_every: "7m", deadline: "2026-01-01T00:02:00Z" });
		const repeated = await watch(f, { deadline: "2026-01-01T01:00:00Z" });
		expect(repeated.id).toBe(w.id);
		expect(f.snapshot().watches[0].deadline).toBe(Date.parse("2026-01-01T00:02:00Z"));
		f.setObservation(f.observation("pending"));
		await f.controller.park([w.id]);
		await f.advance(120000);
		expect(f.probes).toHaveLength(1);
		expect(f.notices).toMatchObject([{ reasons: ["deadline"], state: "pending" }]);
		expect(f.controller.isParked()).toBe(false);
		expect(f.controller.status(w.id)).toMatchObject({ state: "pending", active: true });
		await f.advance(180000);
		expect(f.probes).toHaveLength(2); // 5-minute check
		await f.advance(120000);
		expect(f.probes).toHaveLength(3); // 7-minute report
		await f.advance(180000);
		expect(f.probes).toHaveLength(4); // 10-minute check remains due
		await f.controller.unregister(w.id);
		const renewed = await watch(f, { deadline: "2026-01-01T00:20:00Z" });
		expect(renewed.id).not.toBe(w.id);
		expect(f.snapshot().watches[0].deadline).toBe(Date.parse("2026-01-01T00:20:00Z"));
	});
	it("keeps critical evidence as a barrier while superseding unread routine snapshots", async () => {
		const f = fixture();
		const w = await watch(f, { notify: "changes", fields: ["updates"] });
		f.setAdmits(false);
		await observe(f, w, f.observation("running", 1));
		await observe(f, w, f.observation("running", 2));
		await f.controller.observe({ ...w, source: "probe", error: "transport lost" });
		await observe(f, w, f.observation("running", 3));
		await observe(f, w, f.observation("running", 4));
		await observe(f, w, f.observation("failed", 5));
		expect(f.snapshot().watches[0].pending).toHaveLength(2);
		f.setAdmits(true);
		await f.controller.flushPending();
		expect(f.notices.map((notice) => notice.state)).toEqual(["unknown", "failed"]);
		expect(f.notices[0].reasons).toContain("observability");
		expect(f.notices[1]).toMatchObject({
			reasons: ["failure", "progress"],
			progress: { updates: 5 },
			superseded_snapshots: 2,
		});
	});

	it("retains evidence until native delivery ACK and makes uncertain crash delivery explicit", async () => {
		const f = fixture(true);
		const w = await watch(f);
		await observe(f, w, f.observation("failed"));
		expect(f.snapshot().watches[0].pending).toHaveLength(1);
		await f.controller.flushPending();
		expect(f.notices).toHaveLength(1);
		const saved = f.snapshot();
		f.controller.dispose();
		const recovered = fixture();
		await recovered.controller.restore(saved);
		expect(recovered.notices).toHaveLength(1);
		expect(recovered.notices[0]).toMatchObject({
			state: "unknown",
			original_state: "failed",
			original_event_id: f.notices[0].event_id,
			reasons: ["delivery_unknown"],
		});
		expect(recovered.notices[0].event_id).not.toBe(f.notices[0].event_id);
		const ack = fixture(true);
		const watch2 = await watch(ack);
		await observe(ack, watch2, ack.observation("failed"));
		ack.setGoal("new-goal");
		await ack.controller.acknowledge(String(ack.notices[0].event_id));
		expect(ack.snapshot().watches[0].pending).toHaveLength(0);
	});
	it("transfers complete retired reports and failures without consuming another watch or session", async () => {
		const f = fixture(true);
		const report = await watch(f, { report_every: "5m", fields: ["updates"] });
		await f.advance();
		const failed = await watch(f, { resource_id: "other-resource" });
		await observe(f, failed, { ...f.observation("failed"), attention: ["retained failure detail"] });
		const pending = f.snapshot().watches.flatMap((item) => item.pending);
		await f.controller.unregister(report.id);
		await f.controller.unregister(failed.id);
		expect(f.controller.status()).toMatchObject({ watches: [] });
		const other = fixture(true, undefined, "s2");
		expect(await other.controller.consume(report.id)).toEqual({ events: [], deferred_event_ids: [] });
		const transferred = await f.controller.consume(report.id);
		expect(transferred).toEqual({ events: [JSON.parse(pending[0].text)], deferred_event_ids: [] });
		expect(transferred.events[0]).toMatchObject({
			watch_id: report.id,
			reasons: ["report"],
			scheduled_for: "2026-01-01T00:05:00.000Z",
		});
		expect(f.deliveries.size).toBe(1);
		expect(await f.controller.consume()).toEqual({
			events: [JSON.parse(pending[1].text)],
			deferred_event_ids: [],
		});
		expect(f.deliveries.size).toBe(0);
		expect(f.snapshot().watches).toEqual([]);
		expect(await f.controller.consume()).toEqual({ events: [], deferred_event_ids: [] });
	});

	it("defers selected input and leaves a newer report outside the consumed snapshot", async () => {
		const f = fixture(true);
		const w = await watch(f, { report_every: "5m", fields: ["updates"] });
		await f.advance();
		const first = f.snapshot().watches[0].pending[0];
		f.deliveries.set(first.id, "selected");
		expect(await f.controller.consume(w.id)).toEqual({ events: [], deferred_event_ids: [first.id] });
		expect(f.controller.status(w.id)).toMatchObject({ pending_events: 1 });
		f.deliveries.set(first.id, "queued");
		const consumed = f.controller.consume(w.id);
		const newer = f.advance();
		expect(await consumed).toEqual({ events: [JSON.parse(first.text)], deferred_event_ids: [] });
		await newer;
		expect(f.snapshot().watches[0].pending).toHaveLength(1);
		expect(f.snapshot().watches[0].pending[0].id).not.toBe(first.id);
	});

	it("refuses exhausted critical-evidence budget without stopping the job", async () => {
		const f = fixture(false, 8192);
		const w = await watch(f, { report_every: "5m", fields: ["updates"] });
		f.setAdmits(false);
		let retained = 0;
		f.setRetain(async () => {
			retained++;
			return "/retained/unsupported-observation.json";
		});
		for (let update = 1; update <= 40; update++) {
			f.setObservation({ ...f.observation("running", update), attention: [`warning-${update}`] });
			await f.advance();
		}
		expect(f.probes.length).toBeLessThan(40); // explicit UNSUPPORTED boundary, not cadence preservation
		expect(f.errors).toHaveLength(1);
		expect(String(f.errors[0])).toContain("further checks cannot continue");
		expect(f.controller.status(w.id)).toMatchObject({
			state: "unknown",
			active: false,
			last_observed_state: "running",
		});
		expect(Buffer.byteLength(JSON.stringify(f.snapshot()))).toBeLessThanOrEqual(8192);
		const preserved = f.snapshot().watches[0].pending.map((event) => JSON.parse(event.text));
		expect(
			preserved.filter((event) => event.reasons.includes("attention")).map((event) => event.progress.updates),
		).toEqual(Array.from({ length: f.probes.length - 1 }, (_, i) => i + 1));
		expect(preserved.at(-1)).toMatchObject({
			state: "unknown",
			reasons: ["monitoring_unavailable"],
			evidence: ["/retained/unsupported-observation.json"],
		});
		expect(retained).toBe(1);
		expect(f.cancelled).toEqual([w.id]); // only owned probe cancellation hook
		f.setAdmits(true);
		await f.controller.flushPending();
		expect(f.notices).toHaveLength(preserved.length);
		const checks = f.probes.length;
		await f.advance();
		expect(f.probes).toHaveLength(checks);
	});
	it("keeps notifications bounded and retains large evidence", async () => {
		const f = fixture();
		const w = await watch(f, { fields: ["large"] });
		const evidence = { ...f.observation("failed"), progress: { large: "界".repeat(10000) } };
		await observe(f, w, evidence, { output: JSON.stringify(evidence) });
		expect(Buffer.byteLength(JSON.stringify(f.notices[0]))).toBeLessThanOrEqual(2048);
		expect(f.notices[0].evidence).toContain("/retained/probe.log");
	});
	it("delivers deadline and attention events once without forcing tiny commands through watches", async () => {
		const f = fixture();
		expect(f.probes).toHaveLength(0);
		const w = await watch(f, { deadline: "2026-01-01T00:05:00Z" });
		f.setObservation({ ...f.observation(), attention: ["quality threshold"] });
		await f.advance();
		await f.advance();
		expect(f.notices).toHaveLength(1);
		expect(f.notices[0].reasons).toEqual(["attention", "deadline"]);
		await f.controller.unregister(w.id);
	});
});
