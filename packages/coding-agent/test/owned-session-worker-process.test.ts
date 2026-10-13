import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readActiveOrphanProcesses } from "../src/core/orphan-process-journal.js";

const fixturePath = resolve(__dirname, "fixtures/owned-session-worker-fixture.ts");
const tsxPath = resolve(__dirname, "../../../node_modules/tsx/dist/cli.mjs");
const tempDirs: string[] = [];
const children = new Set<ChildProcess>();
const workerPids = new Set<number>();
const frontendPids = new Set<number>();

afterEach(async () => {
	for (const child of children) {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGKILL");
		}
	}
	children.clear();
	for (const pid of frontendPids) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Already gone.
		}
	}
	frontendPids.clear();
	for (const pid of workerPids) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Already gone.
		}
	}
	workerPids.clear();
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function spawnFrontend(
	args: string[],
	pidPath: string,
	keepAlive = false,
	environment: NodeJS.ProcessEnv = {},
): ChildProcess {
	const child = spawn(process.execPath, [tsxPath, fixturePath, ...args], {
		env: {
			...process.env,
			...environment,
			BASE_CONTEXT_INTERNAL_LEGACY_OWNED_WORKER_FRONTEND: "1",
			BASE_CONTEXT_TEST_OWNED_PID_PATH: pidPath,
			...(keepAlive ? { BASE_CONTEXT_TEST_KEEP_ALIVE: "1" } : {}),
			TSX_TSCONFIG_PATH: resolve(__dirname, "../../../tsconfig.json"),
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	children.add(child);
	return child;
}

async function waitForWorkerPid(path: string): Promise<number> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		if (existsSync(path)) {
			const pid = Number(readFileSync(path, "utf8").trim());
			if (Number.isInteger(pid) && pid > 0) {
				workerPids.add(pid);
				return pid;
			}
		}
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
	}
	throw new Error("Owned worker did not publish its pid");
}

async function waitForReplacementWorkerPid(path: string, previousPid: number): Promise<number> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		if (existsSync(path)) {
			const pid = Number(readFileSync(path, "utf8").trim());
			if (Number.isInteger(pid) && pid > 0 && pid !== previousPid) {
				workerPids.add(pid);
				return pid;
			}
		}
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
	}
	throw new Error("Owned replacement worker did not publish its pid");
}

async function waitForExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return { code: child.exitCode, signal: child.signalCode as NodeJS.Signals | null };
	}
	return new Promise((resolveExit, reject) => {
		const timeout = setTimeout(() => reject(new Error("Timed out waiting for frontend exit")), 10_000);
		child.once("exit", (code, signal) => {
			clearTimeout(timeout);
			resolveExit({ code, signal });
		});
	});
}

async function waitForProcessGone(pid: number): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		try {
			process.kill(pid, 0);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") {
				workerPids.delete(pid);
				return;
			}
		}
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
	}
	throw new Error(`Owned worker ${pid} remained alive`);
}

describe("owned session worker processes", () => {
	it("routes every headless surface through its real worker profile", async () => {
		const cases: Array<[string[], string | undefined, string, boolean?]> = [
			[["-p", "hello"], undefined, "print"],
			[[], "hello", "print", false],
			[["--mode", "json"], "", "json"],
			[["--mode", "rpc"], `${JSON.stringify({ id: "state", type: "get_state" })}\n`, "rpc"],
			[["--no-session"], undefined, "interactive-ephemeral", true],
		];
		for (const [args, stdin, profile, tty] of cases) {
			const root = mkdtempSync(join(tmpdir(), "prime-owned-worker-routing-"));
			tempDirs.push(root);
			const pidPath = join(root, "worker.pid");
			const frontend = spawnFrontend(
				args,
				pidPath,
				tty === false,
				tty === undefined ? {} : { BASE_CONTEXT_TEST_STDIN_TTY: tty ? "1" : "0" },
			);
			if (stdin !== undefined) frontend.stdin?.write(stdin);
			const workerPid = await waitForWorkerPid(pidPath);
			expect(readFileSync(`${pidPath}.profile`, "utf8").trim()).toBe(profile);
			frontend.stdin?.end();
			if (tty === false) process.kill(workerPid, "SIGKILL");
			await waitForExit(frontend);
			children.delete(frontend);
			await waitForProcessGone(workerPid);
		}
	});

	it("keeps RPC framing in the frontend and exits its worker on stdin EOF", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-owned-worker-test-"));
		tempDirs.push(root);
		const pidPath = join(root, "worker.pid");
		const frontend = spawnFrontend(["--mode", "rpc"], pidPath, false, {
			TMPDIR: root,
			BASE_CONTEXT_TEST_ORPHAN_TRACKING: "valid",
		});
		let stdout = "";
		frontend.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		frontend.stdin?.end(`${JSON.stringify({ id: "request-1", type: "get_state" })}\n`);
		const workerPid = await waitForWorkerPid(pidPath);
		const exit = await waitForExit(frontend);
		children.delete(frontend);

		expect(exit).toEqual({ code: 0, signal: null });
		expect(stdout).toBe(
			`${JSON.stringify({ id: "request-1", type: "response", command: "get_state", success: true })}\n`,
		);
		await waitForProcessGone(workerPid);
		const paths = JSON.parse(readFileSync(`${pidPath}.tracking`, "utf8")) as {
			journalPath: string;
			recoveryDescriptorPath: string;
		};
		expect(existsSync(paths.journalPath)).toBe(false);
		expect(existsSync(paths.recoveryDescriptorPath)).toBe(false);
	});

	it("correlates overlapping anonymous RPC commands without exposing internal ids", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-owned-worker-test-"));
		tempDirs.push(root);
		const pidPath = join(root, "worker.pid");
		const frontend = spawnFrontend(["--mode", "rpc"], pidPath, false, {
			BASE_CONTEXT_TEST_REVERSE_RPC_RESPONSES: "1",
		});
		let stdout = "";
		frontend.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		frontend.stdin?.end(
			`${JSON.stringify({ type: "get_state", marker: "first" })}\n${JSON.stringify({ type: "get_state", marker: "second" })}\n`,
		);
		const workerPid = await waitForWorkerPid(pidPath);
		const exit = await waitForExit(frontend);
		children.delete(frontend);

		expect(exit).toEqual({ code: 0, signal: null });
		expect(stdout).toBe(
			`${JSON.stringify({ type: "response", command: "get_state", success: true, marker: "second" })}\n${JSON.stringify({ type: "response", command: "get_state", success: true, marker: "first" })}\n`,
		);
		await waitForProcessGone(workerPid);
	});

	it("drops malformed worker output instead of corrupting public RPC JSONL", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-owned-worker-test-"));
		tempDirs.push(root);
		const pidPath = join(root, "worker.pid");
		const frontend = spawnFrontend(["--mode", "rpc"], pidPath, false, {
			BASE_CONTEXT_TEST_INVALID_RPC_OUTPUT: "1",
		});
		let stdout = "";
		frontend.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		frontend.stdin?.end(`${JSON.stringify({ id: "request-1", type: "get_state" })}\n`);
		const workerPid = await waitForWorkerPid(pidPath);
		const exit = await waitForExit(frontend);
		children.delete(frontend);

		expect(exit).toEqual({ code: 0, signal: null });
		expect(stdout).toBe(
			`${JSON.stringify({ id: "request-1", type: "response", command: "get_state", success: true })}\n`,
		);
		await waitForProcessGone(workerPid);
	});

	it("does not fabricate a recovery response for response-less acknowledgements", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-owned-worker-test-"));
		tempDirs.push(root);
		const pidPath = join(root, "worker.pid");
		const frontend = spawnFrontend(["--mode", "rpc"], pidPath, false, {
			BASE_CONTEXT_TEST_CRASH_ON_ACK: "1",
		});
		let stdout = "";
		frontend.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		const workerPid = await waitForWorkerPid(pidPath);
		frontend.stdin?.write(`${JSON.stringify({ type: "ack_result", commandId: "command-1" })}\n`);
		const replacementPid = await waitForReplacementWorkerPid(pidPath, workerPid);
		frontend.stdin?.end(`${JSON.stringify({ id: "request-1", type: "get_state" })}\n`);
		const exit = await waitForExit(frontend);
		children.delete(frontend);

		expect(exit).toEqual({ code: 0, signal: null });
		expect(stdout).toBe(
			`${JSON.stringify({ id: "request-1", type: "response", command: "get_state", success: true })}\n`,
		);
		await waitForProcessGone(workerPid);
		await waitForProcessGone(replacementPid);
	});

	it.each([false, true])(
		"distinguishes buffered and attempted RPC commands after stdin failure (EOF: %s)",
		async (eof) => {
			const root = mkdtempSync(join(tmpdir(), "prime-owned-worker-input-"));
			tempDirs.push(root);
			const pidPath = join(root, "worker.pid");
			const frontend = spawnFrontend(["--mode", "rpc"], pidPath, false, {
				TMPDIR: root,
				BASE_CONTEXT_TEST_ORPHAN_TRACKING: "valid",
				BASE_CONTEXT_TEST_CLOSED_RPC_INPUT: "1",
			});
			let stdout = "";
			let stderr = "";
			frontend.stdout?.on("data", (chunk: Buffer) => {
				stdout += chunk.toString("utf8");
			});
			frontend.stderr?.on("data", (chunk: Buffer) => {
				stderr += chunk.toString("utf8");
			});
			const workerPid = await waitForWorkerPid(pidPath);
			const commands = `${JSON.stringify({ id: "attempted", type: "mutation" })}\n${JSON.stringify({ type: "get_state", marker: "buffered" })}\n`;
			if (eof) frontend.stdin?.end(commands);
			else frontend.stdin?.write(commands);
			if (eof) {
				expect(await waitForExit(frontend)).toEqual({ code: 1, signal: null });
				children.delete(frontend);
				expect(
					stdout
						.trim()
						.split("\n")
						.map((line) => JSON.parse(line)),
				).toEqual([
					{
						id: "attempted",
						type: "response",
						command: "mutation",
						success: false,
						error: "The isolated session worker stopped during this command; its result is uncertain and was not replayed",
					},
					{
						type: "response",
						command: "get_state",
						success: false,
						error: "The isolated session worker stopped before this command was sent",
					},
				]);
				expect(existsSync(`${pidPath}.received`)).toBe(false);
				await waitForProcessGone(workerPid);
				return;
			}
			const replacementPid = await waitForReplacementWorkerPid(pidPath, workerPid).catch((error: unknown) => {
				throw new Error(`Replacement failed; stdout=${stdout}; stderr=${stderr}`, { cause: error });
			});
			await vi.waitFor(() => expect(stdout).toContain('"marker":"buffered"'), { timeout: 5000 });
			frontend.stdin?.end();
			expect(await waitForExit(frontend)).toEqual({ code: 0, signal: null });
			children.delete(frontend);
			const responses = stdout
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			expect(responses).toEqual([
				{
					id: "attempted",
					type: "response",
					command: "mutation",
					success: false,
					error: "The isolated session worker stopped during this command; its result is uncertain and was not replayed",
				},
				{ type: "response", command: "get_state", success: true, marker: "buffered" },
			]);
			expect(readFileSync(`${pidPath}.received`, "utf8")).toBe("get_state\n");
			expect(stderr).not.toContain("Unhandled");
			await waitForProcessGone(workerPid);
			await waitForProcessGone(replacementPid);
		},
		20_000,
	);

	it("settles child process errors through cleanup and reports attempted versus unsent commands", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-owned-worker-error-"));
		tempDirs.push(root);
		const pidPath = join(root, "worker.pid");
		const frontend = spawnFrontend(["--mode", "rpc"], pidPath, false, {
			TMPDIR: root,
			BASE_CONTEXT_TEST_ORPHAN_TRACKING: "valid",
			BASE_CONTEXT_TEST_CHILD_ERROR: "1",
		});
		let stdout = "";
		let stderr = "";
		frontend.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		frontend.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		const workerPid = await waitForWorkerPid(pidPath);
		frontend.stdin?.end(
			`${JSON.stringify({ id: "attempted", type: "mutation" })}\n${JSON.stringify({ id: "unsent", type: "get_state" })}\n`,
		);
		expect(await waitForExit(frontend)).toEqual({ code: 1, signal: null });
		children.delete(frontend);
		expect(
			stdout
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line)),
		).toEqual([
			{
				id: "attempted",
				type: "response",
				command: "mutation",
				success: false,
				error: "The isolated session worker stopped during this command; its result is uncertain and was not replayed",
			},
			{
				id: "unsent",
				type: "response",
				command: "get_state",
				success: false,
				error: "The isolated session worker stopped before this command was sent",
			},
		]);
		expect(stderr).toContain("fixture child process error");
		expect(existsSync(`${pidPath}.terminated`)).toBe(true);
		expect(Number(readFileSync(pidPath, "utf8").trim())).toBe(workerPid);
		await waitForProcessGone(workerPid);
		const paths = JSON.parse(readFileSync(`${pidPath}.tracking`, "utf8")) as {
			journalPath: string;
			recoveryDescriptorPath: string;
		};
		expect(existsSync(paths.journalPath)).toBe(false);
		expect(existsSync(paths.recoveryDescriptorPath)).toBe(false);
	});

	it("fails pending RPC commands when stdin closes before the worker crashes", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-owned-worker-test-"));
		tempDirs.push(root);
		const pidPath = join(root, "worker.pid");
		const frontend = spawnFrontend(["--mode", "rpc"], pidPath, false, {
			BASE_CONTEXT_TEST_CRASH_ON_COMMAND: "get_state",
			TMPDIR: root,
			BASE_CONTEXT_TEST_ORPHAN_TRACKING: "corrupt",
		});
		let stdout = "";
		let stderr = "";
		frontend.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		frontend.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		frontend.stdin?.end(`${JSON.stringify({ id: "request-1", type: "get_state" })}\n`);
		const workerPid = await waitForWorkerPid(pidPath);
		const exit = await waitForExit(frontend);
		children.delete(frontend);

		expect(exit).toEqual({ code: 1, signal: null });
		expect(stdout).toBe(
			`${JSON.stringify({
				id: "request-1",
				type: "response",
				command: "get_state",
				success: false,
				error: "The isolated session worker stopped during this command; its result is uncertain and was not replayed",
			})}\n`,
		);
		await waitForProcessGone(workerPid);
		expect(stderr).toContain("tracking is unknown");
		const paths = JSON.parse(readFileSync(`${pidPath}.tracking`, "utf8")) as {
			journalPath: string;
			recoveryDescriptorPath: string;
		};
		expect(existsSync(paths.recoveryDescriptorPath)).toBe(true);
		const corrupt = readFileSync(paths.journalPath, "utf8");
		expect(corrupt.endsWith("{\n")).toBe(true);
		expect(() => readActiveOrphanProcesses(paths.journalPath, workerPid)).toThrow(
			"Malformed orphan process journal record",
		);
		expect(readFileSync(paths.journalPath, "utf8")).toBe(corrupt);
		// An incomplete tail is also unknown, not a complete empty result; reading never repairs it.
		const incompletePath = join(root, "incomplete.jsonl");
		writeFileSync(incompletePath, "{");
		expect(() => readActiveOrphanProcesses(incompletePath, workerPid)).toThrow(
			"Incomplete orphan process journal tail",
		);
		expect(readFileSync(incompletePath, "utf8")).toBe("{");
	});

	it("fails pending RPC commands when the worker exits successfully without responding", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-owned-worker-test-"));
		tempDirs.push(root);
		const pidPath = join(root, "worker.pid");
		const frontend = spawnFrontend(["--mode", "rpc"], pidPath, false, {
			BASE_CONTEXT_TEST_EXIT_ZERO_ON_COMMAND: "get_state",
		});
		let stdout = "";
		frontend.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		frontend.stdin?.end(`${JSON.stringify({ id: "request-1", type: "get_state" })}\n`);
		const workerPid = await waitForWorkerPid(pidPath);
		const exit = await waitForExit(frontend);
		children.delete(frontend);

		expect(exit).toEqual({ code: 1, signal: null });
		expect(stdout).toBe(
			`${JSON.stringify({
				id: "request-1",
				type: "response",
				command: "get_state",
				success: false,
				error: "The isolated session worker stopped during this command; its result is uncertain and was not replayed",
			})}\n`,
		);
		await waitForProcessGone(workerPid);
	});

	it("reports an unanswered write as uncertain when the frontend is terminated", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-owned-worker-signal-"));
		tempDirs.push(root);
		const pidPath = join(root, "worker.pid");
		const frontend = spawnFrontend(["--mode", "rpc"], pidPath, false, {
			TMPDIR: root,
			BASE_CONTEXT_TEST_ORPHAN_TRACKING: "valid",
			BASE_CONTEXT_TEST_CLOSED_RPC_INPUT: "1",
			BASE_CONTEXT_TEST_REVERSE_RPC_RESPONSES: "1",
		});
		let stdout = "";
		frontend.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		const workerPid = await waitForWorkerPid(pidPath);
		const frontendPid = Number(readFileSync(`${pidPath}.frontend`, "utf8").trim());
		frontendPids.add(frontendPid);
		frontend.stdin?.write(`${JSON.stringify({ id: "pending", type: "get_state" })}\n`);
		await vi.waitFor(() => expect(existsSync(`${pidPath}.received`)).toBe(true));
		process.kill(frontendPid, "SIGTERM");
		await vi.waitFor(() => expect(existsSync(`${pidPath}.terminated`)).toBe(true));
		frontend.stdin?.end();
		expect(await waitForExit(frontend)).toEqual({ code: 143, signal: null });
		children.delete(frontend);
		frontendPids.delete(frontendPid);
		expect(stdout).toBe(
			`${JSON.stringify({
				id: "pending",
				type: "response",
				command: "get_state",
				success: false,
				error: "The isolated session worker stopped during this command; its result is uncertain and was not replayed",
			})}\n`,
		);
		expect(readFileSync(`${pidPath}.received`, "utf8")).toBe("get_state\n");
		expect(Number(readFileSync(pidPath, "utf8").trim())).toBe(workerPid);
		await waitForProcessGone(workerPid);
	});

	it("terminates the owned worker when its frontend is killed", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-owned-worker-test-"));
		tempDirs.push(root);
		const pidPath = join(root, "worker.pid");
		const frontend = spawnFrontend(["-p", "hello"], pidPath, true);
		const workerPid = await waitForWorkerPid(pidPath);
		const frontendPid = Number(readFileSync(`${pidPath}.frontend`, "utf8").trim());
		frontendPids.add(frontendPid);
		expect(Number(readFileSync(`${pidPath}.ppid`, "utf8").trim())).toBe(frontendPid);

		process.kill(frontendPid, "SIGKILL");
		await waitForExit(frontend);
		children.delete(frontend);
		frontendPids.delete(frontendPid);
		const terminationDeadline = Date.now() + 5000;
		while (!existsSync(`${pidPath}.terminated`) && Date.now() < terminationDeadline) {
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
		}
		expect(existsSync(`${pidPath}.terminated`)).toBe(true);
		await waitForProcessGone(workerPid);
	});
});
