import { randomUUID } from "node:crypto";
import { normalizeHeartbeatSchedule, parseAgentCronSchedule } from "./cron-jobs.js";

export const JOB_WATCH_STATE = "job_watch_state";
export const JOB_WATCH_CAPABILITY = "job_watch_probe_v1";
const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);
const MAX_WATCHES = 16;
const MAX_VISIBLE_BYTES = 2048;
const MAX_STATE_BYTES = 64 * 1024;
const STATE_REFUSAL_RESERVE = 4096;

type CompletionSource = "handle" | "probe";
export interface JobWatchProbeRequest {
	id: string;
	generation: string;
	resource_id: string;
	job_id: string;
	completion_source: CompletionSource;
	command?: string;
	timeout_ms: number;
}
export interface JobObservation {
	observed_at: string;
	job_id: string;
	state: string;
	progress: Record<string, unknown>;
	attention: string[];
	evidence: string[];
	observation_error?: string;
}
export interface WatchDeclaration {
	id: string;
	generation: string;
	resource_id: string;
	job_id: string;
	completion_source: CompletionSource;
	probe_command?: string;
	timeout_ms: number;
	interval_ms: number;
	report_ms?: number;
	next_check: number;
	next_report?: number;
	deadline?: number;
	deadline_reported?: boolean;
	notify: "terminal" | "changes";
	fields: string[];
	active: boolean;
	goal_id?: string;
	latest: JobObservation;
	compared?: string;
	last_problem?: string;
	last_attention?: string;
	last_admitted?: string;
	pending: Array<{ id: string; text: string; admitted?: boolean; uncertain?: boolean; reconcile?: boolean }>;
}
export interface JobWatchSnapshot {
	version: 1;
	session_id: string;
	session_file?: string;
	watches: WatchDeclaration[];
	parked?: { ids: string[]; goal_id?: string };
	unavailable?: string;
}
interface WatchHooks {
	sessionId: string;
	sessionFile?: string;
	current: () => boolean;
	goalId: () => string | undefined;
	probe: (request: JobWatchProbeRequest) => Promise<void>;
	cancelProbe: (id: string, generation: string) => void;
	persist: (state: JobWatchSnapshot) => Promise<void>;
	admit: (text: string, eventId: string) => boolean;
	waitForDelivery?: boolean;
	stateBudgetBytes?: number;
	retain?: (text: string) => Promise<string | undefined>;
	onError: (error: unknown) => void;
	now?: () => number;
}
function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(value: unknown, name: string, max = 512): string {
	if (typeof value !== "string" || !value.length || Buffer.byteLength(value) > max)
		throw new Error(`${name} must be a nonempty string of at most ${max} bytes`);
	return value;
}
function strings(value: unknown, name: string): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > 16) throw new Error(`${name} must contain at most 16 strings`);
	return value.map((v) => text(v, name));
}
function interval(value: unknown, name: string): number {
	const schedule = parseAgentCronSchedule(normalizeHeartbeatSchedule(text(value, name))).schedule;
	if (schedule.kind !== "interval" || !schedule.intervalMs) throw new Error(`${name} must be a recurring interval`);
	return schedule.intervalMs;
}
function bounded(value: Record<string, unknown>): string {
	const out = { ...value };
	if (Buffer.byteLength(JSON.stringify(out)) > MAX_VISIBLE_BYTES) {
		delete out.progress;
		out.omitted = "progress exceeds notification budget; inspect evidence";
	}
	if (Buffer.byteLength(JSON.stringify(out)) > MAX_VISIBLE_BYTES) {
		out.attention = ["attention exceeds notification budget; inspect evidence"];
		out.evidence = Array.isArray(out.evidence) ? out.evidence.slice(0, 1) : [];
	}
	return JSON.stringify(out);
}

/** Session-owned waiting state. Timers never invoke a model or execute notebook code. */
export class JobWatchController {
	private watches = new Map<string, WatchDeclaration>();
	private parked?: JobWatchSnapshot["parked"];
	private timer?: ReturnType<typeof setTimeout>;
	private busy = new Set<string>();
	private queued = new Set<string>();
	private flushing?: Promise<void>;
	private tail: Promise<unknown> = Promise.resolve();
	private stopped = false;
	private unavailable?: string;
	constructor(private readonly hooks: WatchHooks) {}
	private now(): number {
		return this.hooks.now?.() ?? Date.now();
	}
	private owned(): boolean {
		return !this.stopped && this.hooks.current();
	}
	private serialize<T>(work: () => Promise<T>): Promise<T> {
		const operation = this.tail.then(work);
		this.tail = operation.catch(() => undefined);
		return operation;
	}
	isCurrent(): boolean {
		return this.owned();
	}
	snapshot(): JobWatchSnapshot {
		return structuredClone({
			version: 1,
			session_id: this.hooks.sessionId,
			session_file: this.hooks.sessionFile,
			watches: [...this.watches.values()],
			parked: this.parked,
			unavailable: this.unavailable,
		});
	}
	private stateBudget(): number {
		return Math.min(MAX_STATE_BYTES, this.hooks.stateBudgetBytes ?? MAX_STATE_BYTES);
	}
	private stateBytes(state = this.snapshot()): number {
		return Buffer.byteLength(
			JSON.stringify({
				...state,
				watches: state.watches.map((watch) => ({
					...watch,
					pending: watch.pending.map((event) => ({ ...event, admitted: true, uncertain: true, reconcile: true })),
				})),
			}),
		);
	}
	private async refusePendingBudget(watch: WatchDeclaration, previous: WatchDeclaration): Promise<void> {
		const rejected = JSON.stringify({
			observation: watch.latest,
			pending: watch.pending.slice(previous.pending.length),
		});
		Object.assign(watch, previous);
		this.unavailable =
			"Job-watch pending-state budget exhausted; monitoring is unavailable and further checks cannot continue under this hold. Resume delivery and explicitly register again.";
		for (const current of this.watches.values()) {
			current.active = false;
			this.hooks.cancelProbe(current.id, current.generation);
		}
		const retained = await this.hooks.retain?.(rejected);
		if (!this.owned()) return;
		const locator = retained ?? this.hooks.sessionFile ?? `job_watch.status(${JSON.stringify(watch.id)})`;
		const id = randomUUID();
		watch.pending.push({
			id,
			text: bounded({
				event_id: id,
				watch_id: watch.id,
				goal_id: watch.goal_id,
				job_id: watch.job_id,
				state: "unknown",
				previous_state: previous.latest.state,
				reasons: ["monitoring_unavailable"],
				observation_error: this.unavailable,
				evidence: [locator],
			}),
		});
		await this.save();
		await this.flushPending();
		this.schedule();
		this.hooks.onError(new Error(`${this.unavailable} Evidence: ${locator}`));
	}
	private async save(): Promise<void> {
		if (this.owned()) await this.hooks.persist(this.snapshot());
	}
	async watch(input: Record<string, unknown>): Promise<Record<string, unknown>> {
		return this.serialize(async () => {
			if (!this.owned()) throw new Error("Watch owner changed");
			if (this.unavailable) throw new Error(this.unavailable);
			const resource = text(input.resource_id, "resource_id");
			const existing = [...this.watches.values()].find((w) => w.resource_id === resource && w.active);
			if (existing) {
				if (existing.goal_id !== this.hooks.goalId())
					throw new Error("Watch belongs to a different goal; unregister it first");
				return this.status(existing.id);
			}
			if (this.watches.size >= MAX_WATCHES)
				throw new Error("Unregister an old watch before registering more than 16 watches");
			const source = input.completion_source;
			if (source !== "handle" && source !== "probe")
				throw new Error('completion_source must be "handle" or "probe"');
			const command = input.probe_command == null ? undefined : text(input.probe_command, "probe_command", 8192);
			if (source === "probe" && !command) throw new Error("Probe completion requires a read-only probe_command");
			const notify = input.notify ?? "terminal";
			if (notify !== "terminal" && notify !== "changes") throw new Error('notify must be "terminal" or "changes"');
			const fields = strings(input.fields, "fields");
			if (fields.includes("observed_at"))
				throw new Error("Observation timestamps are not meaningful comparison fields");
			if (notify === "changes" && fields.length === 0) throw new Error("changes requires explicit progress fields");
			const now = this.now();
			const intervalMs = interval(input.interval ?? "5m", "interval");
			const reportMs = input.report_every == null ? undefined : interval(input.report_every, "report_every");
			const timeout = input.timeout_ms ?? 30000;
			if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout < 1 || timeout > 300000)
				throw new Error("timeout_ms must be between 1 and 300000");
			const deadline = input.deadline == null ? undefined : Date.parse(text(input.deadline, "deadline"));
			if (deadline !== undefined && !Number.isFinite(deadline)) throw new Error("deadline must be an ISO date");
			const jobId = text(input.job_id ?? resource, "job_id", 256);
			const watch: WatchDeclaration = {
				id: randomUUID(),
				generation: randomUUID(),
				resource_id: resource,
				job_id: jobId,
				completion_source: source,
				probe_command: command,
				timeout_ms: timeout,
				interval_ms: intervalMs,
				report_ms: reportMs,
				next_check: now + intervalMs,
				next_report: reportMs ? now + reportMs : undefined,
				deadline,
				notify,
				fields,
				active: true,
				pending: [],
				goal_id: this.hooks.goalId(),
				latest: {
					observed_at: new Date(now).toISOString(),
					job_id: jobId,
					state: "running",
					progress: {},
					attention: [],
					evidence: strings(input.evidence, "evidence"),
				},
			};
			if (
				this.stateBytes({ ...this.snapshot(), watches: [...this.watches.values(), watch] }) >
				Math.min(48 * 1024, this.stateBudget() - STATE_REFUSAL_RESERVE)
			)
				throw new Error("Job watch declaration budget exceeded; unregister obsolete watches");
			this.watches.set(watch.id, watch);
			await this.save();
			this.schedule();
			return this.status(watch.id);
		});
	}
	status(id?: string): Record<string, unknown> {
		const values = id === undefined ? [...this.watches.values()] : [this.require(id)];
		const statuses = values.map((w) => ({
			id: w.id,
			generation: w.generation,
			active: w.active,
			completion_source: w.completion_source,
			...w.latest,
			...(this.unavailable
				? { state: "unknown", last_observed_state: w.latest.state, monitoring_error: this.unavailable }
				: {}),
			last_admitted: w.last_admitted,
			pending_events: w.pending.length,
		}));
		return id === undefined ? { watches: statuses, parked: this.isParked() } : statuses[0];
	}
	private require(id: string): WatchDeclaration {
		const watch = this.watches.get(id);
		if (!watch) throw new Error(`Unknown watch ${id}`);
		return watch;
	}
	async park(ids: string[]): Promise<Record<string, unknown>> {
		return this.serialize(async () => {
			if (this.unavailable) return { parked: false, reason: "monitoring_unavailable" };
			if (!ids.length) throw new Error("park requires at least one watch");
			const selected = ids.map((id) => this.require(id));
			if (!this.owned() || selected.some((w) => w.goal_id !== this.hooks.goalId()))
				throw new Error("Watch owner changed");
			// A completion racing registration/park is already actionable; do not wait forever.
			if (selected.some((w) => !w.active || w.pending.length > 0))
				return { parked: false, reason: "event_available" };
			this.parked = { ids: [...new Set(ids)], goal_id: this.hooks.goalId() };
			await this.save();
			return { parked: true, ids: this.parked.ids };
		});
	}
	isParked(): boolean {
		return (
			this.owned() &&
			this.parked !== undefined &&
			this.parked.goal_id === this.hooks.goalId() &&
			this.parked.ids.some((id) => this.watches.has(id))
		);
	}
	async unregister(id: string): Promise<Record<string, unknown>> {
		return this.serialize(async () => {
			const watch = this.watches.get(id);
			if (watch) {
				this.hooks.cancelProbe(watch.id, watch.generation);
				this.watches.delete(id);
				if (!this.watches.size) this.unavailable = undefined;
				if (this.parked?.ids.includes(id)) this.parked = undefined;
				await this.save();
			}
			this.schedule();
			return { id, unregistered: true };
		});
	}
	private schedule(): void {
		if (this.timer) clearTimeout(this.timer);
		if (!this.owned() || this.unavailable) return;
		const times = [...this.watches.values()]
			.filter((w) => w.active && w.goal_id === this.hooks.goalId() && !this.busy.has(w.id))
			.flatMap((w) => [
				w.next_check,
				w.next_report ?? Infinity,
				w.deadline_reported ? Infinity : (w.deadline ?? Infinity),
			]);
		if (!times.length) return;
		this.timer = setTimeout(
			() => {
				void this.runDue().catch(this.hooks.onError);
			},
			Math.max(0, Math.min(2147483647, Math.min(...times) - this.now())),
		);
		this.timer.unref?.();
	}
	async runDue(): Promise<void> {
		if (!this.owned() || this.unavailable) return;
		const now = this.now();
		const probes: Promise<void>[] = [];
		for (const watch of this.watches.values()) {
			if (!watch.active || watch.goal_id !== this.hooks.goalId() || this.busy.has(watch.id)) continue;
			if (
				Math.min(
					watch.next_check,
					watch.next_report ?? Infinity,
					watch.deadline_reported ? Infinity : (watch.deadline ?? Infinity),
				) > now
			)
				continue;
			this.busy.add(watch.id);
			// Skip stale checks, not requested reports. Reports retain their own scheduled timestamps.
			if (watch.next_check <= now)
				watch.next_check += (Math.floor((now - watch.next_check) / watch.interval_ms) + 1) * watch.interval_ms;
			probes.push(
				(async () => {
					try {
						await this.hooks.probe({
							id: watch.id,
							generation: watch.generation,
							resource_id: watch.resource_id,
							job_id: watch.job_id,
							completion_source: watch.completion_source,
							command: watch.probe_command,
							timeout_ms: watch.timeout_ms,
						});
					} catch (error) {
						await this.observe({
							id: watch.id,
							generation: watch.generation,
							source: "probe",
							error: String(error),
						});
					}
				})(),
			);
		}
		await Promise.all(probes);
		this.schedule();
	}
	async observe(input: Record<string, unknown>): Promise<Record<string, unknown>> {
		return this.serialize(async () => {
			const watch = typeof input.id === "string" ? this.watches.get(input.id) : undefined;
			if (
				!watch ||
				input.generation !== watch.generation ||
				!this.owned() ||
				!watch.active ||
				watch.goal_id !== this.hooks.goalId()
			)
				return { ignored: true };
			if (input.source === "handle" && watch.completion_source !== "handle") return { ignored: true };
			this.busy.delete(watch.id);
			const now = this.now();
			const previous = watch.latest.state;
			const error = typeof input.error === "string" ? input.error : undefined;
			const observed: unknown = input.observation;
			let evidence: string | undefined;
			if (typeof input.output === "string" && this.hooks.retain) evidence = await this.hooks.retain(input.output);
			if (!this.owned() || this.watches.get(watch.id) !== watch || watch.goal_id !== this.hooks.goalId())
				return { ignored: true };
			const before = structuredClone(watch);
			let observation: JobObservation;
			try {
				if (error) throw new Error(error);
				if (!record(observed)) throw new Error("Probe observation is unavailable");
				const jobId = text(observed.job_id, "job_id", 256);
				if (jobId !== watch.job_id) throw new Error("Probe job identity does not match this watch");
				const state = text(observed.state, "state", 32);
				if (!["running", "pending", "unknown", ...TERMINAL].includes(state))
					throw new Error("Unrecognized job state");
				const observedAt = text(observed.observed_at, "observed_at", 64);
				if (!Number.isFinite(Date.parse(observedAt))) throw new Error("Invalid observation time");
				if (!record(observed.progress ?? {})) throw new Error("progress must be an object");
				observation = {
					observed_at: observedAt,
					job_id: jobId,
					state,
					progress: (observed.progress as Record<string, unknown>) ?? {},
					attention: strings(observed.attention, "attention"),
					evidence: strings(observed.evidence, "evidence"),
				};
				// Handle authority is explicit: progress probes cannot finish a live local handle.
				if (input.source !== "handle" && watch.completion_source === "handle" && TERMINAL.has(state)) {
					if (state !== "succeeded")
						observation.attention.push(`Probe reports job ${state}; waiting for authoritative handle`);
					observation.state = "running";
				}
			} catch (failure) {
				observation = {
					observed_at: new Date(now).toISOString(),
					job_id: watch.job_id,
					state: "unknown",
					progress: {},
					attention: [],
					evidence: watch.latest.evidence,
					observation_error: String(failure).slice(0, 256),
				};
			}
			if (evidence) observation.evidence = [evidence, ...observation.evidence].slice(0, 16);
			const problem =
				observation.observation_error ?? (observation.state === "unknown" ? "Job state unknown" : undefined);
			const selected: Record<string, unknown> = {};
			for (const field of [...new Set([...watch.fields, "exit_code", "duration_seconds"])]) {
				const value = observation.progress[field];
				if (value === undefined) continue;
				if (Buffer.byteLength(JSON.stringify(value)) > 512) {
					selected[field] = { unavailable: "value exceeds 512-byte watch field budget; inspect evidence" };
					observation.attention.push(`Oversized selected field: ${field}`);
				} else selected[field] = value;
			}
			const compared = JSON.stringify(watch.fields.map((field) => [field, selected[field]]));
			const attention = JSON.stringify(observation.attention);
			const reasons: string[] = [];
			if (TERMINAL.has(observation.state)) {
				reasons.push(observation.state === "succeeded" ? "terminal" : "failure");
				watch.active = false;
			}
			if (input.source === "handle" && typeof input.error === "string" && input.error.includes("handle unavailable"))
				watch.active = false;
			if (problem && problem !== watch.last_problem) reasons.push("observability");
			if (observation.attention.length && attention !== watch.last_attention) reasons.push("attention");
			if (watch.notify === "changes" && watch.compared !== undefined && compared !== watch.compared)
				reasons.push("progress");
			if (watch.deadline !== undefined && now >= watch.deadline && !watch.deadline_reported) {
				reasons.push("deadline");
				watch.deadline_reported = true;
			}
			watch.latest = { ...observation, progress: selected };
			watch.compared = compared;
			watch.last_problem = problem;
			watch.last_attention = attention;
			const emit = (eventReasons: string[], due?: number) => {
				const id = randomUUID();
				const value = {
					watch_id: watch.id,
					goal_id: watch.goal_id,
					event_id: id,
					...watch.latest,
					previous_state: previous,
					reasons: eventReasons,
					...(due === undefined
						? {}
						: { scheduled_for: new Date(due).toISOString(), late_by_ms: Math.max(0, now - due) }),
				};
				watch.pending.push({ id, text: bounded(value) });
			};
			if (reasons.length) emit(reasons);
			if (watch.report_ms && watch.next_report !== undefined && watch.next_report <= now) {
				while (watch.next_report <= now) {
					emit(["report"], watch.next_report);
					watch.next_report += watch.report_ms;
					if (this.stateBytes() > this.stateBudget() - STATE_REFUSAL_RESERVE) {
						await this.refusePendingBudget(watch, before);
						return { accepted: false, reason: "monitoring_unavailable" };
					}
				}
			}
			if (this.stateBytes() > this.stateBudget() - STATE_REFUSAL_RESERVE) {
				await this.refusePendingBudget(watch, before);
				return { accepted: false, reason: "monitoring_unavailable" };
			}
			// Persist prepared evidence before native queue admission.
			await this.save();
			await this.flushPending();
			await this.save();
			this.schedule();
			return { accepted: true };
		});
	}
	flushPending(): Promise<void> {
		if (!this.flushing)
			this.flushing = this.flushPrepared().finally(() => {
				this.flushing = undefined;
			});
		return this.flushing;
	}
	private async flushPrepared(): Promise<void> {
		if (!this.owned()) return;
		let changed = false;
		for (const watch of this.watches.values()) {
			for (const event of [...watch.pending]) {
				if (!this.owned()) return;
				if ((!event.admitted && watch.goal_id !== this.hooks.goalId()) || this.queued.has(event.id)) continue;
				let deliveryText = event.text;
				if (event.reconcile) {
					let original: Record<string, unknown> = {};
					try {
						original = JSON.parse(event.text);
					} catch {
						/* unavailable prior body */
					}
					deliveryText = bounded({
						...original,
						event_id: `${event.id}:delivery-unknown`,
						original_event_id: event.id,
						original_state: original.state,
						state: "unknown",
						reasons: ["delivery_unknown"],
						observation_error:
							"Delivery before interrupted shutdown is uncertain; reconcile evidence before repeating actions",
					});
				}
				if (this.hooks.waitForDelivery) {
					event.uncertain = true;
					await this.save();
				}
				if (!this.owned() || (!event.admitted && watch.goal_id !== this.hooks.goalId())) return;
				if (!this.hooks.admit(deliveryText, event.id)) {
					event.uncertain = false;
					await this.save();
					break;
				}
				if (this.hooks.waitForDelivery) {
					event.admitted = true;
					this.queued.add(event.id);
				} else {
					watch.last_admitted = event.id;
					watch.pending.splice(watch.pending.indexOf(event), 1);
				}
				changed = true;
				if (watch.goal_id === this.hooks.goalId() && this.parked?.ids.includes(watch.id)) this.parked = undefined;
			}
		}
		if (changed) {
			await this.save();
			this.schedule();
		}
	}
	acknowledge(id: string): Promise<void> {
		return this.serialize(async () => {
			if (this.stopped) return;
			this.queued.delete(id);
			for (const watch of this.watches.values()) {
				const index = watch.pending.findIndex((event) => event.id === id);
				if (index >= 0) {
					watch.pending.splice(index, 1);
					watch.last_admitted = id;
				}
			}
			await this.save();
		});
	}
	releaseDelivery(id: string, knownUndelivered: boolean): Promise<void> {
		return this.serialize(async () => {
			this.queued.delete(id);
			for (const watch of this.watches.values()) {
				const event = watch.pending.find((item) => item.id === id);
				if (event && knownUndelivered) event.uncertain = false;
			}
			await this.save();
		});
	}
	/** Called only after native request/agent settlement during clean async shutdown. */
	async settleShutdown(undelivered: Set<string>): Promise<void> {
		await this.flushing;
		return this.serialize(async () => {
			for (const watch of this.watches.values())
				for (const event of watch.pending) if (undelivered.has(event.id)) event.uncertain = false;
			this.dispose();
			await this.hooks.persist(this.snapshot());
		});
	}
	async restore(value: unknown): Promise<void> {
		if (
			!record(value) ||
			value.version !== 1 ||
			value.session_id !== this.hooks.sessionId ||
			value.session_file !== this.hooks.sessionFile ||
			!Array.isArray(value.watches) ||
			value.watches.length > MAX_WATCHES
		)
			return;
		this.unavailable = typeof value.unavailable === "string" ? value.unavailable : undefined;
		// Only host-persisted declarations reach here; PID/process objects are deliberately absent.
		for (const item of value.watches as WatchDeclaration[]) {
			if (
				!record(item) ||
				typeof item.id !== "string" ||
				typeof item.generation !== "string" ||
				typeof item.resource_id !== "string" ||
				typeof item.job_id !== "string" ||
				!["handle", "probe"].includes(item.completion_source) ||
				!Number.isFinite(item.interval_ms) ||
				item.interval_ms <= 0 ||
				!Number.isFinite(item.next_check) ||
				!Number.isFinite(item.timeout_ms) ||
				item.timeout_ms < 1 ||
				item.timeout_ms > 300000 ||
				(item.report_ms !== undefined && (!Number.isFinite(item.report_ms) || item.report_ms <= 0)) ||
				(item.probe_command !== undefined &&
					(typeof item.probe_command !== "string" || Buffer.byteLength(item.probe_command) > 8192)) ||
				!Array.isArray(item.fields) ||
				item.fields.some((field) => typeof field !== "string") ||
				!record(item.latest) ||
				!Array.isArray(item.pending) ||
				item.pending.some((event) => !event || typeof event.id !== "string" || typeof event.text !== "string")
			)
				continue;
			const restored = structuredClone(item);
			for (const event of restored.pending) {
				if (event.uncertain) {
					event.reconcile = true;
					event.admitted = true;
				}
			}
			this.watches.set(item.id, restored);
		}
		this.parked =
			record(value.parked) &&
			Array.isArray(value.parked.ids) &&
			value.parked.ids.every((id) => typeof id === "string")
				? (value.parked as JobWatchSnapshot["parked"])
				: undefined;
		await this.flushPending();
		for (const watch of this.watches.values()) {
			if (!watch.active) continue;
			watch.generation = randomUUID();
			if (watch.completion_source === "probe" && watch.probe_command) {
				watch.next_check = this.now();
			} else {
				await this.observe({
					id: watch.id,
					generation: watch.generation,
					error: "Kernel/session restored without an authoritative probe; handle identity is unknown",
				});
				watch.active = false;
			}
		}
		await this.save();
		this.schedule();
	}
	dispose(): void {
		this.stopped = true;
		if (this.timer) clearTimeout(this.timer);
		for (const watch of this.watches.values()) this.hooks.cancelProbe(watch.id, watch.generation);
	}
}
