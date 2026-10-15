import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ReplKernelManager } from "../src/core/kernel/index.js";

const python = process.env.BASE_CONTEXT_KERNEL_PYTHON ?? resolve("../../prime-agent-runtime/.venv/bin/python");
const managers: ReplKernelManager[] = [];
const directories: string[] = [];
afterEach(async () => {
	for (const manager of managers.splice(0)) await manager.shutdown({ snapshot: false });
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function create(hostHandlers = {}) {
	const cwd = mkdtempSync(join(tmpdir(), "job-watch-kernel-"));
	directories.push(cwd);
	const manager = new ReplKernelManager({ python, cwd, hostHandlers });
	managers.push(manager);
	return { manager, cwd };
}
const skillSource = resolve("skills/job-watch/src");
const load = `import sys
sys.path.insert(0, ${JSON.stringify(skillSource)})
import job_watch
from rlm import bash
import asyncio`;

describe("job-watch native kernel bridge", () => {
	it("delivers completion after the initiating cell and transfers reports through the thin skill API", async () => {
		let complete!: (value: Record<string, unknown>) => void;
		const completion = new Promise<Record<string, unknown>>((resolve) => {
			complete = resolve;
		});
		const calls: string[] = [];
		const { manager } = create({
			"job_watch.watch": async (payload: Record<string, unknown>) => {
				calls.push("watch");
				expect(payload.completion_source).toBe("handle");
				expect(payload.deadline).toBeNull();
				return { id: "watch", generation: "generation" };
			},
			"job_watch.observation": async (payload: Record<string, unknown>) => {
				const observation = (payload.result as { observation: { observed_at: string } }).observation;
				console.info(
					"job-watch-measurement",
					JSON.stringify({
						fixture: "native-completion-bridge",
						completionCallbackToHostMs: Date.now() - Date.parse(observation.observed_at),
					}),
				);
				complete(payload);
				return {};
			},
			"job_watch.status": async () => {
				calls.push("status");
				return { state: "running" };
			},
			"job_watch.consume": async (payload: Record<string, unknown>) => {
				calls.push("consume");
				expect(payload.id).toBe("watch");
				return {
					events: [{ event_id: "completion", watch_id: "watch", state: "succeeded" }],
					deferred_event_ids: [],
				};
			},
			"job_watch.park": async () => {
				calls.push("park");
				return { parked: true };
			},
			"job_watch.unregister": async () => {
				calls.push("unregister");
				return { unregistered: true };
			},
		});
		const registered = await manager.execute(`${load}
job = bash(${JSON.stringify(`${python} -c "import time; time.sleep(0.1)"`)})
w = await job_watch.watch(job, job_id="local", completion_source="handle")
await job_watch.park([w["id"]])`);
		expect(registered.status).toBe("ok");
		expect(await completion).toMatchObject({
			id: "watch",
			generation: "generation",
			result: { source: "handle", observation: { job_id: "local", state: "succeeded" } },
		});
		const transferred = await manager.execute(`await job_watch.status("watch")
await job_watch.unregister("watch")
transferred = await job_watch.consume("watch")
assert transferred == {"events": [{"event_id": "completion", "watch_id": "watch", "state": "succeeded"}], "deferred_event_ids": []}`);
		expect(transferred.status, JSON.stringify(transferred)).toBe("ok");
		expect(transferred.stdout).toContain(
			'"terminal_events":[{"event_id":"completion","watch_id":"watch","state":"succeeded"}]',
		);
		expect(transferred.stdout).toContain("Inspect the full returned events");
		expect(calls).toEqual(["watch", "park", "status", "unregister", "consume"]);
	});
	it("passes an all-watch consume request through without changing deferred evidence", async () => {
		const { manager } = create({
			"job_watch.consume": async (payload: Record<string, unknown>) => {
				expect(payload.id).toBeUndefined();
				return { events: [], deferred_event_ids: ["selected-event"] };
			},
		});
		const result = await manager.execute(`${load}
result = await job_watch.consume()
assert result == {"events": [], "deferred_event_ids": ["selected-event"]}`);
		expect(result.status, JSON.stringify(result)).toBe("ok");
		expect(result.stdout).toBe("");
	});
	it("maps probe wait budgets to the existing deadline without changing probe timeouts", async () => {
		const deadlines: number[] = [];
		const before = Date.now();
		const { manager } = create({
			"job_watch.watch": async (payload: Record<string, unknown>) => {
				deadlines.push(Date.parse(String(payload.deadline)));
				expect(payload.wait_budget).toBeUndefined();
				expect(payload.timeout_ms).toBe(30000);
				return { id: "watch", generation: "generation" };
			},
		});
		const result = await manager.execute(`${load}
_ = await job_watch.watch(job_id="default", completion_source="probe", probe_command="printf pending")
_ = await job_watch.watch(job_id="explicit", completion_source="probe", probe_command="printf pending", wait_budget=60)
_ = await job_watch.watch(job_id="absolute", completion_source="probe", probe_command="printf pending", deadline="2026-01-01T00:05:00Z")
_ = await job_watch.watch(job_id="fractional", completion_source="probe", probe_command="printf pending", wait_budget=0.125)
_ = await job_watch.watch(job_id="tiny", completion_source="probe", probe_command="printf pending", wait_budget=5e-324)`);
		expect(result.status, JSON.stringify(result)).toBe("ok");
		const after = Date.now();
		expect(deadlines[0]).toBeGreaterThanOrEqual(before + 900000);
		expect(deadlines[0]).toBeLessThanOrEqual(after + 900000);
		expect(deadlines[1]).toBeGreaterThanOrEqual(before + 60000);
		expect(deadlines[1]).toBeLessThanOrEqual(after + 60000);
		expect(deadlines[2]).toBe(Date.parse("2026-01-01T00:05:00Z"));
		expect(deadlines[3]).toBeGreaterThanOrEqual(before + 125);
		expect(deadlines[3]).toBeLessThanOrEqual(after + 125);
		expect(deadlines[4]).toBeGreaterThanOrEqual(before);
		expect(deadlines[4]).toBeLessThanOrEqual(after);
	});
	it("rejects conflicting, invalid, or unrepresentable wait budgets before registration", async () => {
		let registrations = 0;
		const { manager } = create({
			"job_watch.watch": async () => {
				registrations++;
				return {};
			},
		});
		const result = await manager.execute(`${load}
for options in ({"wait_budget": 60, "deadline": "2026-01-01T00:05:00Z"}, *({"wait_budget": value} for value in (0, -1, float("inf"), float("nan"), True, "60", 1e300, 10**1000))):
    try:
        await job_watch.watch(job_id="remote", completion_source="probe", probe_command="printf pending", **options)
    except ValueError:
        pass
    else:
        raise AssertionError("invalid budget registered")`);
		expect(result.status, JSON.stringify(result)).toBe("ok");
		expect(registrations).toBe(0);
	});
	it("bounds assigned terminal receipts and explains failed parking without exposing payloads", async () => {
		const events = Array.from({ length: 10 }, (_, index) => ({
			event_id: `event-${index}`,
			watch_id: "watch",
			state: index === 0 ? "failed" : "succeeded",
			progress: { private_payload: "do not print this payload" },
		}));
		const { manager } = create({
			"job_watch.consume": async () => ({ events, deferred_event_ids: ["in-flight"] }),
			"job_watch.park": async () => ({ parked: false, reason: "event_available" }),
		});
		const result = await manager.execute(`${load}
transferred = await job_watch.consume("watch")
assert len(transferred["events"]) == 10
assert transferred["events"][0]["progress"]["private_payload"] == "do not print this payload"
assert transferred["deferred_event_ids"] == ["in-flight"]
parked = await job_watch.park(["watch"])
assert parked == {"parked": False, "reason": "event_available"}`);
		expect(result.status, JSON.stringify(result)).toBe("ok");
		expect(Buffer.byteLength(result.stdout)).toBeLessThan(2048);
		expect(result.stdout).toContain('"additional_terminal_events":2');
		expect(result.stdout).toContain('"state":"failed"');
		expect(result.stdout).not.toContain("private_payload");
		expect(result.stdout).not.toContain("do not print this payload");
		expect(result.stdout).toContain("no new continuation hold for the requested watches");
		expect(result.stdout).toContain("An earlier hold may remain");
		expect(result.stdout).toContain("Do not assume a later automatic turn");
	});
	it("shows assigned monitoring refusal without changing its return", async () => {
		const { manager } = create({
			"job_watch.park": async () => ({ parked: false, reason: "monitoring_unavailable" }),
		});
		const result = await manager.execute(`${load}
parked = await job_watch.park(["watch"])
assert parked == {"parked": False, "reason": "monitoring_unavailable"}`);
		expect(result.status, JSON.stringify(result)).toBe("ok");
		expect(result.stdout).toContain("monitoring unavailable; no new continuation hold");
		expect(result.stdout).toContain("An earlier hold may remain");
		expect(result.stdout).toContain("retained partial evidence");
		expect(result.stdout).toContain("Do not relaunch the job or assume completion");
	});
	it("runs and parses a read-only native probe while another notebook cell is active", async () => {
		const { manager } = create();
		await manager.execute("import asyncio");
		let started!: () => void;
		const ready = new Promise<void>((resolve) => {
			started = resolve;
		});
		const abort = new AbortController();
		const busy = manager.execute(
			`print("cell ready", flush=True)
await asyncio.Event().wait()`,
			{ signal: abort.signal, onStream: () => started() },
		);
		await ready;
		const json = JSON.stringify({
			observed_at: "2026-01-01T00:00:00Z",
			job_id: "remote",
			state: "running",
			progress: { updates: 4 },
			attention: [],
			evidence: ["metrics.json"],
		});
		const start = performance.now();
		const result = await manager.jobWatchProbe({
			watchId: "watch",
			generation: "generation",
			resourceId: "remote",
			jobId: "remote",
			command: `printf '%s' '${json}'`,
			timeoutMs: 1000,
		});
		expect(result).toMatchObject({ source: "probe", observation: { job_id: "remote", progress: { updates: 4 } } });
		console.info(
			"job-watch-measurement",
			JSON.stringify({
				fixture: "local-summary-probe",
				probeAndTransportMs: performance.now() - start,
				probeOutputBytes: Buffer.byteLength(String(result.output)),
			}),
		);
		abort.abort();
		expect((await busy).status).toBe("aborted");
	});
	it("distinguishes partial JSON, failed transport, and observed job failure", async () => {
		const { manager } = create();
		await manager.start();
		const probe = (command: string) =>
			manager.jobWatchProbe({
				watchId: "watch",
				generation: "g",
				resourceId: "r",
				jobId: "j",
				command,
				timeoutMs: 1000,
			});
		expect(await probe("printf '{'")).toMatchObject({ error: "probe JSON unavailable or incomplete" });
		expect(await probe("exit 7")).toMatchObject({ error: "probe exited 7" });
		expect(
			await probe(
				`printf '%s' '{"observed_at":"2026-01-01T00:00:00Z","job_id":"j","state":"failed","progress":{},"attention":[],"evidence":[]}'`,
			),
		).toMatchObject({ observation: { state: "failed" } });
	});
	it("accepts faithful numeric scalars and refuses precision-losing tokens without corrupting evidence", async () => {
		const { manager } = create();
		await manager.start();
		const probe = (token: string) =>
			manager.jobWatchProbe({
				watchId: "w",
				generation: "g",
				resourceId: "r",
				jobId: "j",
				completionSource: "probe",
				command: `printf '%s' '{"job_id":"j","state":"running","progress":{"value":${token}}}'`,
				timeoutMs: 1000,
			});
		expect(await probe("0.125")).toMatchObject({ observation: { progress: { value: 0.125 } } });
		for (const token of ["1e-400", "9007199254740993", "1.23456789012345678", "NaN", "1e400", "-0.0"]) {
			const result = await probe(token);
			expect(result.error).toContain("encode exact identifiers and precision-sensitive values as strings");
			expect(result.observation).toBeUndefined();
			expect(result.output).toContain(token);
		}
		expect(await probe('"9007199254740993"')).toMatchObject({
			observation: { progress: { value: "9007199254740993" } },
		});
	});
	it("cancels only its own timed-out probe through existing Bash containment", async () => {
		const { manager, cwd } = create();
		await manager.start();
		const result = await manager.jobWatchProbe({
			watchId: "watch",
			generation: "g",
			resourceId: "r",
			jobId: "j",
			command: `${python} -c "import time,pathlib; time.sleep(1); pathlib.Path('late-side-effect').touch()"`,
			timeoutMs: 20,
		});
		expect(result.error).toContain("TimeoutError");
		expect(existsSync(join(cwd, "late-side-effect"))).toBe(false);
		expect((await manager.execute("1 + 1")).result).toBe("2");
	});
	it("refuses unsupported runtimes locally and old hosts can ignore optional ready metadata", async () => {
		const { manager } = create();
		expect((await manager.execute("1 + 1")).result).toBe("2");
		Reflect.set(manager, "jobWatchCapability", false);
		await expect(
			manager.jobWatchProbe({
				watchId: "w",
				generation: "g",
				resourceId: "r",
				jobId: "j",
				command: "touch forbidden",
				timeoutMs: 20,
			}),
		).rejects.toThrow("unavailable");
		expect((await manager.execute("2 + 2")).result).toBe("4");
	});
	it("cancels an explicit probe without cancelling its separately monitored handle", async () => {
		const { manager } = create();
		await manager.execute(`from rlm import bash
job = bash(${JSON.stringify(`${python} -c "import time; time.sleep(10)"`)})
_ = job.pid`);
		const pending = manager.jobWatchProbe({
			watchId: "w",
			generation: "g",
			resourceId: "r",
			jobId: "j",
			completionSource: "probe",
			command: `${python} -c "import time; time.sleep(10)"`,
			timeoutMs: 20000,
		});
		const cancelled = expect(pending).rejects.toThrow("cancelled");
		manager.cancelJobWatchProbe("w");
		await cancelled;
		expect((await manager.execute("job.poll() is None")).result).toBe("True");
		await manager.execute(`job.kill(grace=0)
await job`);
	});
	it("never reattaches a handle by PID after a fresh kernel start", async () => {
		const { manager } = create();
		const resource = await manager.execute(`from rlm import bash
from rlm.job_watch import identity
h = bash("printf done")
identity(h)`);
		const id = resource.result!.slice(1, -1);
		await manager.kill();
		const fresh = create().manager;
		await fresh.start();
		expect(
			await fresh.jobWatchProbe({
				watchId: "w",
				generation: "g",
				resourceId: id,
				jobId: "j",
				completionSource: "handle",
				command: "touch forbidden",
				timeoutMs: 1000,
			}),
		).toMatchObject({ source: "handle", error: "handle unavailable after kernel restart" });
	});
});
