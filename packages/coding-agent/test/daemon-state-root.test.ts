import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import { createDaemonStateRootMatcher, currentDaemonStateRoot } from "../src/modes/daemon/daemon-state-root.js";
import {
	acquireDaemonSupervisorOwnership,
	listDaemonSupervisorSocketPathsForAgentDir,
} from "../src/modes/daemon/daemon-supervisor-ownership.js";

type Ownership = Awaited<ReturnType<typeof acquireDaemonSupervisorOwnership>>;
const directories: string[] = [];
const ownerships: Ownership[] = [];

afterEach(async () => {
	for (const owner of ownerships.splice(0)) await owner.release();
	vi.unstubAllEnvs();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createRoot() {
	const base = mkdtempSync(join(tmpdir(), "bc-state-root-"));
	directories.push(base);
	const agentDir = join(base, "agent");
	const registryDir = join(base, "registry");
	mkdirSync(agentDir, { recursive: true });
	vi.stubEnv(ENV_AGENT_DIR, agentDir);
	vi.stubEnv("BASE_CONTEXT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR", registryDir);
	return { base, registryDir, root: currentDaemonStateRoot() };
}

async function registerDaemon(agentDir: string, socketPath: string, generation: string) {
	const owner = await acquireDaemonSupervisorOwnership({
		agentDir,
		socketPath,
		generation,
		appVersion: "test",
		descriptorDir: join(agentDir, "workers", generation),
	});
	ownerships.push(owner);
	return owner;
}

describe("daemon state-root discovery", () => {
	it("includes the current default and owned custom sockets without changing ownership", async () => {
		const { root, base, registryDir } = createRoot();
		const customSocket = join(base, "custom.sock");
		const owner = await registerDaemon(root.agentDir, customSocket, "owned");
		const before = readdirSync(registryDir);
		const matches = createDaemonStateRootMatcher(root);

		expect(matches(root.defaultSocketPath)).toBe(true);
		expect(matches(owner.record.socketPath)).toBe(true);
		if (process.platform !== "win32") {
			expect(matches(join(root.socketDir, "worker-one.sock"))).toBe(true);
			expect(matches(join(root.agentDir, "hidden", "daemon.sock"))).toBe(true);
		}
		expect(listDaemonSupervisorSocketPathsForAgentDir(root.agentDir)).toEqual([owner.record.socketPath]);
		expect(readdirSync(registryDir)).toEqual(before);
		await owner.assertCurrent();
	});

	it("excludes other roots and leaves missing or abandoned registry state untouched", async () => {
		const { root, base, registryDir } = createRoot();
		const matchesEmpty = createDaemonStateRootMatcher(root);
		expect(matchesEmpty(join(base, "stranger.sock"))).toBe(false);
		expect(existsSync(registryDir)).toBe(false);

		const otherAgentDir = join(base, "agent-other");
		mkdirSync(otherAgentDir);
		const other = await registerDaemon(otherAgentDir, join(base, "other.sock"), "other");
		const abandoned = join(registryDir, "abandoned.owner");
		mkdirSync(abandoned);
		const before = readdirSync(registryDir);
		const matches = createDaemonStateRootMatcher(root);
		expect(matches(other.record.socketPath)).toBe(false);
		expect(matches(join(otherAgentDir, "daemon.sock"))).toBe(false);
		vi.stubEnv(ENV_AGENT_DIR, otherAgentDir);
		expect(matches(currentDaemonStateRoot().defaultSocketPath)).toBe(false);
		expect(listDaemonSupervisorSocketPathsForAgentDir(root.agentDir)).toEqual([]);
		expect(readdirSync(registryDir)).toEqual(before);
		expect(existsSync(abandoned)).toBe(true);
		await other.assertCurrent();
	});
});
