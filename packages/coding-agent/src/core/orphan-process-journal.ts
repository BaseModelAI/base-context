import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { getPackageDir } from "../config.js";
import { getProcessStartId } from "./session-lease.js";

export const ORPHAN_PROCESS_JOURNAL_ENV = "BASE_CONTEXT_INTERNAL_ORPHAN_PROCESS_JOURNAL";

interface OrphanProcessRecord {
	version: 1;
	pid: number;
	ownerPid: number;
	/** Set on records written by a kernel (e.g. bash() children) so the host can reap per kernel. */
	kernelPid?: number;
	processStartId?: string;
	active: boolean;
	recordedAt: string;
}

export interface ActiveOrphanProcess {
	pid: number;
	kernelPid?: number;
	/** Missing on identity-free records: old journals or host writes whose start-id query failed (kernels no longer write pid-only records). */
	processStartId?: string;
}

export interface OrphanProcessJournalOwner {
	readonly path: string | undefined;
	readonly ownerPid: number;
	record(pid: number, active: boolean): Error | undefined;
}

/** Capture before spawning or waiting. Retirement must use this same owner, not later environment state. */
export function captureOrphanProcessJournalOwner(): OrphanProcessJournalOwner {
	const path = process.env[ORPHAN_PROCESS_JOURNAL_ENV];
	const ownerPid = process.pid;
	const nodeExecutable = "bun" in process.versions ? "node" : process.execPath;
	const env = {
		PATH: process.env.PATH,
		HOME: homedir(),
		TMPDIR: tmpdir(),
		SYSTEMROOT: process.env.SYSTEMROOT,
		WINDIR: process.env.WINDIR,
	};
	return {
		path,
		ownerPid,
		record: (pid, active) => {
			if (!path) return undefined;
			try {
				if (!Number.isInteger(pid) || pid <= 0) throw new Error("Invalid orphan process pid");
				const processStartId = active ? getProcessStartId(pid) : undefined;
				const record: OrphanProcessRecord = {
					version: 1,
					pid,
					ownerPid,
					...(processStartId ? { processStartId } : {}),
					active,
					recordedAt: new Date().toISOString(),
				};
				const candidates = [
					fileURLToPath(new URL("./orphan-process-journal-worker.js", import.meta.url)),
					fileURLToPath(new URL("./orphan-process-journal-worker.ts", import.meta.url)),
					join(getPackageDir(), "dist", "core", "orphan-process-journal-worker.js"),
					join(dirname(process.execPath), "core", "orphan-process-journal-worker.js"),
					join(dirname(process.execPath), "orphan-process-journal-worker.js"),
				];
				const entrypoint = candidates.find((candidate) => existsSync(candidate));
				if (!entrypoint) throw new Error("Base Context orphan journal worker payload is missing");
				const result = spawnSync(
					nodeExecutable,
					[
						"--experimental-sqlite",
						"--disable-warning=ExperimentalWarning",
						...(entrypoint.endsWith(".ts") ? ["--import", import.meta.resolve("tsx")] : []),
						entrypoint,
						JSON.stringify({ path, parentPid: ownerPid, record: `${JSON.stringify(record)}\n` }),
					],
					{ env, encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 },
				);
				if (result.error) throw result.error;
				if (result.signal)
					throw new Error(`Orphan journal writer exited on ${result.signal}; append outcome is unknown`);
				if (!result.stdout)
					throw new Error(
						`Orphan journal writer exited (${result.status}): ${result.stderr}; append outcome is unknown`,
					);
				const failures = (JSON.parse(result.stdout) as { name: string; message: string; code?: string }[]).map(
					(failure) =>
						Object.assign(new Error(failure.message), {
							name: failure.name,
							...(failure.code ? { code: failure.code } : {}),
						}),
				);
				if (failures.length)
					throw failures.length === 1
						? failures[0]
						: new AggregateError(
								failures,
								`Orphan append and cleanup failed: ${failures.map((failure) => failure.message).join("; ")}`,
							);
				if (result.status !== 0)
					throw new Error(`Orphan journal writer exited (${result.status}); append outcome is unknown`);
				return undefined;
			} catch (cause) {
				return new Error(
					`Orphan ${active ? "registration" : "retirement"} failed for already-spawned pid ${pid}; tracking is unknown, and the process may have run: ${cause instanceof Error ? cause.message : String(cause)}`,
					{ cause },
				);
			}
		},
	};
}

export function recordOrphanProcessState(pid: number, active: boolean): Error | undefined {
	return captureOrphanProcessJournalOwner().record(pid, active);
}

export function readActiveOrphanProcesses(path: string, ownerPid: number): ActiveOrphanProcess[] {
	let contents: string;
	try {
		contents = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return [];
		}
		throw error;
	}
	if (contents && !contents.endsWith("\n")) {
		throw new Error("Incomplete orphan process journal tail; tracking is unknown");
	}
	const latest = new Map<number, OrphanProcessRecord>();
	const lines = contents.split("\n");
	lines.pop();
	for (const [index, line] of lines.entries()) {
		let record: Partial<OrphanProcessRecord> | null;
		try {
			record = JSON.parse(line) as Partial<OrphanProcessRecord> | null;
		} catch (error) {
			throw new Error(`Malformed orphan process journal record at line ${index + 1}; tracking is unknown`, {
				cause: error,
			});
		}
		if (
			!record ||
			typeof record !== "object" ||
			Array.isArray(record) ||
			record.version !== 1 ||
			!Number.isInteger(record.pid) ||
			(record.pid ?? 0) <= 0 ||
			!Number.isInteger(record.ownerPid) ||
			(record.ownerPid ?? 0) <= 0 ||
			typeof record.active !== "boolean" ||
			typeof record.recordedAt !== "string" ||
			(record.processStartId !== undefined && typeof record.processStartId !== "string") ||
			(record.kernelPid !== undefined && (!Number.isInteger(record.kernelPid) || record.kernelPid <= 0))
		) {
			throw new Error(`Invalid orphan process journal record at line ${index + 1}; tracking is unknown`);
		}
		if (record.ownerPid === ownerPid) latest.set(record.pid!, record as OrphanProcessRecord);
	}
	// Pid-only actives (no processStartId) still surface from old journals or
	// host writes whose start-id query failed; reapers decide per-platform.
	return [...latest.values()]
		.filter(
			(record) =>
				record.active && (record.processStartId === undefined || typeof record.processStartId === "string"),
		)
		.map((record) => ({
			pid: record.pid,
			...(Number.isInteger(record.kernelPid) ? { kernelPid: record.kernelPid } : {}),
			...(typeof record.processStartId === "string" ? { processStartId: record.processStartId } : {}),
		}));
}

export function isOrphanProcessIdentityCurrent(orphan: ActiveOrphanProcess): boolean {
	// Pid-only records can never claim identity (undefined === undefined must not match).
	return orphan.processStartId !== undefined && getProcessStartId(orphan.pid) === orphan.processStartId;
}

/**
 * Identity-free records cannot prove the pid still names the journaled process.
 * On win32 the kernel's kill-on-close job already reaped its tree when it died,
 * so a bare-pid taskkill only risks killing a reused pid. POSIX keeps the
 * best-effort kill (group-scoped, and the spawn gate makes pid-only actives
 * host-written rarities there).
 */
export function shouldReapOrphanProcess(orphan: ActiveOrphanProcess): boolean {
	if (orphan.processStartId === undefined) {
		return process.platform !== "win32";
	}
	return isOrphanProcessIdentityCurrent(orphan);
}

export function clearOrphanProcessJournal(path: string): void {
	rmSync(path, { force: true });
}

// Kills still-active bash() children journaled by the given kernel pid; sibling kernels' records are untouched.
export function reapKernelOrphanProcesses(
	kernelPid: number,
	owner = captureOrphanProcessJournalOwner(),
): Error | undefined {
	const path = owner.path;
	if (!path || !Number.isInteger(kernelPid) || kernelPid <= 0) {
		return;
	}
	let orphans: ActiveOrphanProcess[];
	try {
		orphans = readActiveOrphanProcesses(path, owner.ownerPid);
	} catch (cause) {
		return new Error("Kernel orphan tracking is unknown; journal retained", { cause });
	}
	const failures: Error[] = [];
	for (const orphan of orphans) {
		if (orphan.kernelPid !== kernelPid || orphan.pid === kernelPid) {
			continue;
		}
		if (!shouldReapOrphanProcess(orphan)) {
			continue;
		}
		// Inactive only after a delivered signal; a stale record is neutralized by the startId check.
		if (killOrphanProcess(orphan.pid)) {
			const failure = owner.record(orphan.pid, false);
			if (failure) failures.push(failure);
		}
	}
	return failures.length === 0
		? undefined
		: failures.length === 1
			? failures[0]
			: new AggregateError(failures, "Kernel orphan retirement failed");
}

// Hardened cross-platform tree kill for journaled orphans: absolute System32
// taskkill /T on win32 (a bare name could resolve a planted CWD taskkill.exe),
// process-group then pid SIGKILL elsewhere.
export function killOrphanProcess(pid: number): boolean {
	if (process.platform === "win32") {
		// In-kernel bash() kill paths use taskkill /T; the reaper must kill the same tree, not just the shell pid.
		const result = spawnSync(
			win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
			["/F", "/T", "/PID", String(pid)],
			{
				stdio: "ignore",
				timeout: 10_000,
				env: { ...process.env, NoDefaultCurrentDirectoryInExePath: "1" },
			},
		);
		return result.status === 0;
	}
	try {
		process.kill(-pid, "SIGKILL");
		return true;
	} catch {
		try {
			process.kill(pid, "SIGKILL");
			return true;
		} catch {
			// The orphan may already have exited.
		}
	}
	return false;
}
