import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR, ENV_SESSION_DIR, SELF_UPDATE_INTERACTIVE_CHILD_ENV } from "../src/config.js";
import { DefaultPackageManager } from "../src/core/package-manager.js";
import { APPEND_NATIVE_ADMISSION, SessionJournalOwner } from "../src/core/session-journal-owner.js";
import { readSessionJournal } from "../src/core/session-journal-reader.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";

const mocks = vi.hoisted(() => ({
	realSettings: false,
	daemonCommands: [] as string[][],
	packageCommands: [] as string[][],
	psCalls: [] as boolean[],
	reapCalls: [] as Array<[boolean, boolean]>,
	shutdownCalls: [] as Array<[boolean, boolean]>,
	mcpCommands: [] as string[][],
}));

vi.mock("../src/cli/daemon-command.js", () => ({
	handleDaemonCommand: async (args: string[]) => {
		mocks.daemonCommands.push(args);
		return true;
	},
}));

vi.mock("../src/package-manager-cli.js", () => ({
	handlePackageCommand: async (args: string[]) => {
		mocks.packageCommands.push(args);
		return true;
	},
	isSelfUpdateSource: (source: string) => source === "self" || source === "pi" || source === "prime-agent",
}));

vi.mock("../src/core/mcp/mcp-command.js", () => ({
	runMcpManagementCommand: async (args: string[]) => {
		mocks.mcpCommands.push(args);
		return { action: args[0], message: "managed", changed: false };
	},
}));

vi.mock("../src/core/settings-manager.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/settings-manager.js")>();
	return {
		...actual,
		SettingsManager: {
			create: (...args: Parameters<typeof actual.SettingsManager.create>) =>
				mocks.realSettings
					? actual.SettingsManager.create(...args)
					: { flush: async () => {}, drainErrors: () => [], getGlobalMcpServers: () => undefined },
		},
	};
});

vi.mock("../src/cli/daemon-ps.js", () => ({
	runPs: async (json: boolean) => {
		mocks.psCalls.push(json);
	},
	runReap: async (json: boolean, force: boolean) => {
		mocks.reapCalls.push([json, force]);
	},
	runShutdownAll: async (json: boolean, force: boolean) => {
		mocks.shutdownCalls.push([json, force]);
	},
}));

import { INTERNAL_RUNTIME_COMMAND_MARKER } from "../src/cli/args.js";
import { formatTopLevelHelp } from "../src/cli/command-registry.js";
import { DAEMON_UPDATE_RESTART_COORDINATOR_FLAG } from "../src/cli/daemon-update-restart.js";
import { handlePublicCommand } from "../src/cli/public-command.js";

function offlineMigrationJournal(id: string, cwd: string): string {
	return `${[
		{ type: "session", version: 3, id, timestamp: "2025-01-01T00:00:00.000Z", cwd },
		{
			type: "message",
			id: `${id}-message`,
			parentId: null,
			timestamp: "2025-01-01T00:00:01.000Z",
			message: { role: "user", content: `History for ${id}`, timestamp: 1 },
		},
	]
		.map((entry) => JSON.stringify(entry))
		.join("\n")}\n`;
}

describe("public command routing", () => {
	beforeEach(() => {
		mocks.realSettings = false;
		mocks.daemonCommands.length = 0;
		mocks.packageCommands.length = 0;
		mocks.psCalls.length = 0;
		mocks.reapCalls.length = 0;
		mocks.shutdownCalls.length = 0;
		mocks.mcpCommands.length = 0;
		process.exitCode = undefined;
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		mocks.realSettings = false;
		process.exitCode = undefined;
		vi.restoreAllMocks();
	});

	it("migrates an offline legacy root through preview and real owners without activating imported packages", async () => {
		mocks.realSettings = true;
		const root = mkdtempSync(join(tmpdir(), "base-context-root-import-"));
		const source = join(root, "offline-export");
		const destination = join(root, "imported");
		const cwds = [join(root, "project-one"), join(root, "project-two")];
		const packageSource = "npm:offline-migration-fixture@1.0.0";
		const secret = "fixture-secret-must-not-appear";
		try {
			mkdirSync(join(source, "sessions"), { recursive: true });
			const first = offlineMigrationJournal("legacy-a", cwds[0]!);
			const second = offlineMigrationJournal("legacy-b", cwds[1]!);
			writeFileSync(join(source, "sessions", "a.jsonl"), first);
			writeFileSync(join(source, "sessions", "b.jsonl"), second);
			const sourceSettings = JSON.stringify({
				defaultProvider: "openai-codex",
				defaultModel: "gpt-5.6-sol",
				defaultThinkingLevel: "low",
				theme: "dark",
				quietStartup: true,
				terminal: { showImages: false, showTerminalProgress: true },
				packages: [
					{ source: packageSource, extensions: [] },
					`git:https://token:${secret}@example.invalid/repo`,
					"./untrusted-local",
				],
				apiKeys: { openai: secret },
				shellPath: secret,
				extensions: ["./untrusted.ts"],
				skills: ["./untrusted-skill"],
			});
			writeFileSync(join(source, "settings.json"), sourceSettings);
			writeFileSync(join(source, "auth.json"), secret);
			writeFileSync(join(source, "cron-jobs.json"), "[]");
			writeFileSync(join(source, "untrusted.ts"), 'throw new Error("must not load imported code");');
			mkdirSync(join(source, "session-artifacts", "legacy-a"), { recursive: true });
			writeFileSync(join(source, "session-artifacts", "legacy-a", "kernel-state.dill"), secret);
			const args = ["migrate", "--from-prime-agent", source, "--destination", destination];
			await expect(handlePublicCommand([...args, "--dry-run"])).resolves.toMatchObject({ handled: true });
			expect(process.exitCode).toBeUndefined();
			expect(existsSync(destination)).toBe(false);
			expect(readdirSync(root).filter((name) => name.includes(".import-"))).toEqual([]);
			const preview = JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0]));
			expect(preview).toMatchObject({
				mode: "dry-run",
				preparedSessions: 2,
				inactivePackages: 1,
				skippedPackages: 2,
			});
			const imports = vi.spyOn(SessionManager, "importRetainedFrom");
			await handlePublicCommand(args);
			expect(process.exitCode).toBeUndefined();
			expect(imports).toHaveBeenCalledTimes(2);
			expect(imports.mock.calls.every((call) => call[4] === "legacy-jsonl")).toBe(true);
			const reopenedCwds: string[] = [];
			for (const name of readdirSync(join(destination, "sessions"))) {
				if (!name.endsWith(".jsonl")) continue;
				const manager = await SessionManager.open(join(destination, "sessions", name));
				try {
					reopenedCwds.push(manager.getCwd());
					expect(manager.getLeafId()).toMatch(/^legacy-[ab]-message$/);
					const history = await manager.materializeBranchHistory({ maxEntries: 8, maxSourceBytes: 16384 });
					expect(JSON.stringify(history)).toContain(
						`History for ${manager.getLeafId()!.replace(/-message$/, "")}`,
					);
				} finally {
					await manager.close();
				}
			}
			expect(reopenedCwds.sort()).toEqual([...cwds].sort());
			const settings = SettingsManager.create(destination, destination);
			expect(settings.getGlobalSettings()).toMatchObject({
				defaultProvider: "openai-codex",
				defaultModel: "gpt-5.6-sol",
				defaultThinkingLevel: "low",
				theme: "dark",
				quietStartup: true,
				terminal: { showImages: false, showTerminalProgress: true },
				packages: [],
				inactivePackages: [{ source: packageSource, extensions: [] }],
			});
			const packages = new DefaultPackageManager({
				cwd: destination,
				agentDir: destination,
				settingsManager: settings,
				bundledSkillsDir: null,
			});
			const installGuard = vi
				.spyOn(packages as unknown as { installParsedSource(): Promise<void> }, "installParsedSource")
				.mockRejectedValue(new Error("Inactive package attempted installation"));
			const pathGuard = vi.spyOn(packages, "getInstalledPath").mockImplementation(() => {
				throw new Error("Inactive package path lookup");
			});
			const resolved = await packages.resolve();
			expect(resolved.extensions).toEqual([]);
			expect(resolved.skills).toEqual([]);
			expect(packages.listConfiguredPackages()).toEqual([
				{ source: packageSource, scope: "user", filtered: true, inactive: true },
			]);
			expect(installGuard).not.toHaveBeenCalled();
			expect(pathGuard).not.toHaveBeenCalled();
			expect(mocks.packageCommands).toEqual([]);
			expect(mocks.daemonCommands).toEqual([]);
			for (const name of ["auth.json", "models.json", "cron-jobs.json", "untrusted.ts", "extensions", "skills"])
				expect(existsSync(join(destination, name))).toBe(false);
			expect(existsSync(join(destination, "session-artifacts", "legacy-a", "kernel-state.dill"))).toBe(false);
			expect(readFileSync(join(destination, "settings.json"), "utf8")).not.toContain(secret);
			expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain(secret);
			expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(secret);
			expect(readFileSync(join(source, "settings.json"), "utf8")).toBe(sourceSettings);
			expect(readFileSync(join(source, "sessions", "a.jsonl"), "utf8")).toBe(first);
			expect(readFileSync(join(source, "sessions", "b.jsonl"), "utf8")).toBe(second);
			// Only an explicit successful install moves the declaration; the installer itself stays fake.
			const explicitInstall = vi.spyOn(packages, "install").mockResolvedValue(undefined);
			await packages.installAndPersist(packageSource);
			await settings.flush();
			expect(explicitInstall).toHaveBeenCalledWith(packageSource, undefined);
			expect(settings.getGlobalSettings()).toMatchObject({
				packages: [{ source: packageSource, extensions: [] }],
				inactivePackages: [],
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("refuses a later invalid offline journal without activating a destination or overwriting one", async () => {
		mocks.realSettings = true;
		const root = mkdtempSync(join(tmpdir(), "base-context-root-import-edge-"));
		const source = join(root, "offline-export");
		const destination = join(root, "imported");
		try {
			mkdirSync(join(source, "sessions"), { recursive: true });
			const first = offlineMigrationJournal("legacy-a", join(root, "project-a"));
			const incomplete = offlineMigrationJournal("legacy-b", join(root, "project-b")).trimEnd();
			writeFileSync(join(source, "sessions", "a.jsonl"), first);
			writeFileSync(join(source, "sessions", "b.jsonl"), incomplete);
			const args = ["migrate", "--from-prime-agent", source, "--destination", destination];
			await expect(handlePublicCommand(args)).resolves.toMatchObject({ handled: true });
			expect(process.exitCode).toBe(1);
			expect(existsSync(destination)).toBe(false);
			expect(readFileSync(join(source, "sessions", "a.jsonl"), "utf8")).toBe(first);
			expect(readFileSync(join(source, "sessions", "b.jsonl"), "utf8")).toBe(incomplete);
			expect(mocks.packageCommands).toEqual([]);
			expect(mocks.daemonCommands).toEqual([]);
			process.exitCode = undefined;
			mkdirSync(destination);
			writeFileSync(join(destination, "keep.txt"), "keep existing destination");
			await handlePublicCommand(args);
			expect(process.exitCode).toBe(1);
			expect(readFileSync(join(destination, "keep.txt"), "utf8")).toBe("keep existing destination");
			expect(readdirSync(destination)).toEqual(["keep.txt"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rewrites attach into the normal interactive resume path", async () => {
		await expect(handlePublicCommand(["attach", "worker"])).resolves.toEqual({
			handled: false,
			args: ["--resume", "worker"],
			explicitAgentsView: false,
			attachAgent: "worker",
		});
	});

	it("forwards global options when attaching", async () => {
		await expect(handlePublicCommand(["attach", "worker", "--verbose", "--provider", "anthropic"])).resolves.toEqual({
			handled: false,
			args: ["--resume", "worker", "--verbose", "--provider", "anthropic"],
			explicitAgentsView: false,
			attachAgent: "worker",
		});
	});

	it("rejects extra attach operands", async () => {
		await expect(handlePublicCommand(["attach", "worker", "extra"])).resolves.toMatchObject({ handled: true });
		expect(process.exitCode).toBe(1);
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining("base-context attach <agent>"));
	});

	it("rejects conflicting session selectors when attaching", async () => {
		for (const selector of [["--resume", "other"], ["-r", "other"], ["--continue"], ["--fork", "session.jsonl"]]) {
			await expect(handlePublicCommand(["attach", "worker", ...selector])).resolves.toMatchObject({ handled: true });
		}
		expect(process.exitCode).toBe(1);
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining("cannot be combined"));
	});

	it("forwards global options when opening the agents view", async () => {
		await expect(handlePublicCommand(["agents", "--verbose", "--provider", "anthropic"])).resolves.toEqual({
			handled: false,
			args: ["--verbose", "--provider", "anthropic"],
			explicitAgentsView: true,
		});
	});

	it("routes MCP management without entering agent startup", async () => {
		await expect(
			handlePublicCommand(["mcp", "add", "local", "--", "node", "server file.js", "--stdio"]),
		).resolves.toMatchObject({ handled: true });
		expect(mocks.mcpCommands).toEqual([["add", "local", "--", "node", "server file.js", "--stdio"]]);
	});

	it("routes agent operations through the internal protocol adapter", async () => {
		await expect(handlePublicCommand(["list", "--all", "--json"])).resolves.toMatchObject({ handled: true });
		expect(mocks.daemonCommands).toEqual([["daemon", "list", "--all", "--json"]]);
	});

	it("forwards a custom daemon socket when stopping an agent", async () => {
		await expect(
			handlePublicCommand(["stop", "worker", "--daemon-socket", "/tmp/custom-daemon.sock"]),
		).resolves.toMatchObject({ handled: true });
		expect(mocks.daemonCommands).toEqual([
			["daemon", "kill", "worker", "--daemon-socket", "/tmp/custom-daemon.sock"],
		]);
	});

	it("forwards a custom daemon socket when renaming an agent", async () => {
		await expect(
			handlePublicCommand(["rename", "worker", "reviewer", "--daemon-socket", "/tmp/custom-daemon.sock"]),
		).resolves.toMatchObject({ handled: true });
		expect(mocks.daemonCommands).toEqual([
			["daemon", "rename", "worker", "reviewer", "--daemon-socket", "/tmp/custom-daemon.sock"],
		]);
	});

	it("separates Base Context updates from package updates", async () => {
		await handlePublicCommand(["update", "--force"]);
		await handlePublicCommand(["package", "update"]);
		await handlePublicCommand(["package", "update", "npm:@example/tools"]);

		expect(mocks.packageCommands).toEqual([
			["update", "--self", "--force"],
			["update", "--extensions"],
			["update", "npm:@example/tools"],
		]);
	});

	it("forwards hidden update restart coordinator invocations", async () => {
		const args = ["update", DAEMON_UPDATE_RESTART_COORDINATOR_FLAG, "--daemon-socket", "custom-daemon.sock"];

		await handlePublicCommand(args);

		expect(mocks.packageCommands).toEqual([args]);
	});

	it("preserves the internal interactive self-update command", async () => {
		const previousValue = process.env[SELF_UPDATE_INTERACTIVE_CHILD_ENV];
		const args = ["update", "--self", "--force", "--daemon-socket", "custom-daemon.sock"];
		process.env[SELF_UPDATE_INTERACTIVE_CHILD_ENV] = "1";

		try {
			await handlePublicCommand(args);
		} finally {
			if (previousValue === undefined) {
				delete process.env[SELF_UPDATE_INTERACTIVE_CHILD_ENV];
			} else {
				process.env[SELF_UPDATE_INTERACTIVE_CHILD_ENV] = previousValue;
			}
		}

		expect(mocks.packageCommands).toEqual([args]);
	});

	it("gives legacy update targets explicit migration guidance", async () => {
		for (const target of ["self", "--self", "prime-agent"]) {
			await handlePublicCommand(["update", target]);
		}

		expect(mocks.packageCommands).toEqual([]);
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Use "base-context update [--force]"'));
	});

	it("directs legacy package-update forms to the package command", async () => {
		await handlePublicCommand(["update", "npm:@example/tools"]);
		await handlePublicCommand(["update", "--extensions"]);
		await handlePublicCommand(["update", "--extension", "npm:@example/tools"]);

		expect(mocks.packageCommands).toEqual([]);
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Use "base-context package update [source]"'));
	});

	it("explains that combined legacy updates are now separate", async () => {
		await handlePublicCommand(["update", "--self", "--extensions"]);

		expect(mocks.packageCommands).toEqual([]);
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining("separately"));
	});

	it("rejects self-update aliases on the package update path", async () => {
		for (const source of ["self", "pi", "prime-agent"]) {
			await handlePublicCommand(["package", "update", source]);
		}

		expect(mocks.packageCommands).toEqual([]);
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Use "base-context update"'));
	});

	it("directs package uninstall to package remove", async () => {
		await handlePublicCommand(["package", "uninstall", "npm:@example/tools"]);

		expect(mocks.packageCommands).toEqual([]);
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Use "base-context package remove"'));
		expect(console.error).not.toHaveBeenCalledWith(expect.stringContaining("package install"));
	});

	it("maps model listing and session export to the existing runtime flags", async () => {
		await expect(handlePublicCommand(["model", "list", "sonnet"])).resolves.toMatchObject({
			handled: false,
			args: [INTERNAL_RUNTIME_COMMAND_MARKER, "--list-models", "sonnet"],
		});
		await expect(handlePublicCommand(["session", "export", "session.jsonl", "session.html"])).resolves.toMatchObject({
			handled: false,
			args: [INTERNAL_RUNTIME_COMMAND_MARKER, "--export", "session.jsonl", "session.html"],
		});

		const root = mkdtempSync(join(tmpdir(), "base-context-session-import-"));
		const previousHome = process.env[ENV_AGENT_DIR];
		const previousSessions = process.env[ENV_SESSION_DIR];
		process.env[ENV_AGENT_DIR] = root;
		process.env[ENV_SESSION_DIR] = join(root, "owned-sessions");
		vi.spyOn(process, "cwd").mockReturnValue(root);
		try {
			const source = join(root, "external.jsonl");
			const writer = await SessionJournalOwner.open({ journalPath: source, create: true });
			try {
				await writer.appendJson(
					JSON.stringify({
						type: "session",
						version: 3,
						id: "external-session",
						timestamp: "2026-01-01T00:00:00.000Z",
						cwd: root,
						rlmDepth: 0,
					}),
				);
				await writer[APPEND_NATIVE_ADMISSION](
					JSON.stringify({
						type: "message",
						id: "imported-input",
						parentId: null,
						timestamp: "2026-01-01T00:00:01.000Z",
						message: { role: "user", content: "Keep this source text", timestamp: 1 },
						nativeOrigin: {
							version: 1,
							kind: "input",
							actionId: "source-action",
							recordId: "source-record",
							inputSource: "interactive",
							recordRole: "primary",
							submitted: { text: "Keep this source text" },
						},
					}),
				);
			} finally {
				await writer.close();
			}
			const before = readFileSync(source);
			const destinationDir = join(root, "owned-sessions");
			expect(existsSync(destinationDir)).toBe(false);
			await expect(handlePublicCommand(["session", "import", "--preview", basename(source)])).resolves.toEqual({
				handled: true,
				args: [],
				explicitAgentsView: false,
			});
			expect(process.exitCode).toBeUndefined();
			const previewJson = vi.mocked(console.log).mock.calls.at(-2)?.[0];
			if (typeof previewJson !== "string") throw new Error("Preview did not report its source preparation");
			const preview: unknown = JSON.parse(previewJson);
			expect(preview).toEqual({
				sourcePath: source,
				sourceFormat: "native-framed",
				inputVersion: 3,
				entriesRead: 1,
				sourceJsonBytes: expect.any(Number),
				preparedEntryCount: 1,
				targetCwd: root,
				targetDirectory: destinationDir,
				retention: "retained-import",
				sourceHeader: "replace",
				gitState: "omit-and-relink-parents",
				capture: "bounded-prefix-not-live-snapshot",
				destinationCreated: false,
				destinationCreationAndIndexing: "not-assessed",
				canonicalEpochActivation: "not-assessed",
				referenceReplayCoverage: "not-assessed",
				laterImport: "rereads-source-and-can-fail",
			});
			expect(vi.mocked(console.log).mock.calls.at(-1)?.[0]).toContain(
				"Captured-source preparation completed. No session destination was created. " +
					"Destination creation/indexing, canonical epoch activation and reference/replay coverage were not assessed. " +
					"A later import rereads the source and can still fail.",
			);
			expect(existsSync(destinationDir)).toBe(false);
			expect(readFileSync(source)).toEqual(before);
			await expect(handlePublicCommand(["session", "import", basename(source)])).resolves.toEqual({
				handled: true,
				args: [],
				explicitAgentsView: false,
			});
			expect(process.exitCode).toBeUndefined();
			const destinationPath = vi.mocked(console.log).mock.calls.at(-1)?.[0];
			if (typeof destinationPath !== "string") throw new Error("Import did not report its destination");
			expect(destinationPath.startsWith(join(root, "owned-sessions"))).toBe(true);
			expect(readFileSync(source)).toEqual(before);
			const records = [];
			for await (const record of readSessionJournal(destinationPath)) records.push(record);
			expect(records[1]).toMatchObject({
				retention: "retained-import",
				qualification: "native-admission",
				entry: { id: "imported-input", message: { content: "Keep this source text" } },
			});
			// The command returned only after releasing its destination owner.
			const imported = await SessionManager.open(destinationPath);
			try {
				expect(imported.getSessionId()).not.toBe("external-session");
				expect((await imported.readEntry("imported-input"))?.type).toBe("message");
			} finally {
				await imported.close();
			}
			expect(mocks.daemonCommands).toEqual([]);
			expect(mocks.mcpCommands).toEqual([]);
			expect(mocks.packageCommands).toEqual([]);
		} finally {
			if (previousHome === undefined) delete process.env[ENV_AGENT_DIR];
			else process.env[ENV_AGENT_DIR] = previousHome;
			if (previousSessions === undefined) delete process.env[ENV_SESSION_DIR];
			else process.env[ENV_SESSION_DIR] = previousSessions;
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("preserves trailing global options for model listing and session export", async () => {
		await expect(handlePublicCommand(["model", "list", "sonnet", "--offline"])).resolves.toMatchObject({
			handled: false,
			args: [INTERNAL_RUNTIME_COMMAND_MARKER, "--list-models", "sonnet", "--offline"],
		});
		await expect(
			handlePublicCommand(["session", "export", "session.jsonl", "session.html", "--verbose"]),
		).resolves.toMatchObject({
			handled: false,
			args: [INTERNAL_RUNTIME_COMMAND_MARKER, "--export", "session.jsonl", "session.html", "--verbose"],
		});
	});

	it("rejects operands for package list", async () => {
		await handlePublicCommand(["package", "list", "ignored-source"]);

		expect(mocks.packageCommands).toEqual([]);
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining("base-context package list"));
	});

	it("uses force only when explicitly requested for full shutdown", async () => {
		await handlePublicCommand(["shutdown", "--json"]);
		await handlePublicCommand(["shutdown", "--force"]);
		expect(mocks.shutdownCalls).toEqual([
			[true, false],
			[false, true],
		]);
	});

	it("routes doctor fixes through the safe cleanup path", async () => {
		await handlePublicCommand(["doctor", "--fix", "--json"]);
		expect(mocks.reapCalls).toEqual([[true, false]]);
	});

	it("rejects the old daemon hierarchy with migration guidance", async () => {
		await expect(handlePublicCommand(["daemon", "list"])).resolves.toMatchObject({ handled: true });
		expect(process.exitCode).toBe(1);
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Run "base-context help"'));
	});

	it("shows migration guidance when help targets removed commands", async () => {
		const cases: Array<[path: string[], hint: string]> = [
			[["daemon"], 'Run "base-context help"'],
			[["install"], 'Use "base-context package install"'],
			[["remove"], 'Use "base-context package remove"'],
			[["uninstall"], 'Use "base-context package remove"'],
			[["manage"], 'Use "base-context agents"'],
			[["app", "update"], 'Use "base-context update"'],
		];

		for (const [path, hint] of cases) {
			await expect(handlePublicCommand(["help", ...path])).resolves.toMatchObject({ handled: true });
			expect(console.error).toHaveBeenCalledWith(expect.stringContaining(hint));
		}
		expect(process.exitCode).toBe(1);
		expect(console.log).not.toHaveBeenCalled();
	});

	it("suggests close nested commands without executing them", async () => {
		await handlePublicCommand(["schedule", "cancell", "job-1"]);
		expect(mocks.daemonCommands).toEqual([]);
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining("schedule cancel"));
	});

	it("treats help-like message text after the separator literally", async () => {
		await handlePublicCommand(["send", "worker", "--", "--help"]);
		expect(mocks.daemonCommands).toEqual([["daemon", "send", "worker", "--", "--help"]]);
	});

	it("leaves natural-language prompts beginning with help on the prompt path", async () => {
		const args = ["help", "me", "fix", "this"];
		await expect(handlePublicCommand(args)).resolves.toEqual({
			handled: false,
			args,
			explicitAgentsView: false,
		});
	});

	it("rejects invalid paths below a known help command", async () => {
		await handlePublicCommand(["help", "schedule", "nonsense"]);

		expect(process.exitCode).toBe(1);
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Unknown command: schedule nonsense"));
	});

	it("shows command help when options precede the help flag", async () => {
		await handlePublicCommand(["list", "--all", "--help"]);
		await handlePublicCommand(["doctor", "--fix", "--help"]);
		await handlePublicCommand(["package", "install", "--local", "--help"]);

		expect(console.log).toHaveBeenNthCalledWith(1, expect.stringContaining("base-context list [--all] [--json]"));
		expect(console.log).toHaveBeenNthCalledWith(2, expect.stringContaining("base-context doctor [--fix] [--json]"));
		expect(console.log).toHaveBeenNthCalledWith(3, expect.stringContaining("base-context package install <source>"));
		expect(console.error).not.toHaveBeenCalled();
	});

	it("leaves top-level help flags on the full CLI help path", async () => {
		await expect(handlePublicCommand(["--help"])).resolves.toEqual({
			handled: false,
			args: ["--help"],
			explicitAgentsView: false,
		});
		await expect(handlePublicCommand(["-h"])).resolves.toEqual({
			handled: false,
			args: ["-h"],
			explicitAgentsView: false,
		});
	});

	it("formats complete top-level help, including autonomous options", () => {
		const help = formatTopLevelHelp();
		expect(help).toContain("Options:");
		expect(help).toContain("Run options:");
		expect(help).toContain("--mode <text|json|rpc|acp|daemon>");
		expect(help).toContain("Autonomous options:");
		for (const option of [
			"--autonomous",
			"--autonomous-gate <command>",
			"--autonomous-gate-retries <n>",
			"--autonomous-gate-timeout-ms <n>",
			"--autonomous-max-continuations <n>",
			"--autonomous-max-turns <n>",
			"--autonomous-max-tokens <n>",
			"--autonomous-timeout-ms <n>",
		]) {
			expect(help).toContain(option);
		}
		expect(help).toContain("default: 300000");
		expect(help).toContain("default: 1800000");
		expect(help).toContain("Commands:");
		expect(help).toContain("shutdown");
		expect(help).not.toContain("Environment Variables:");
		expect(help).not.toContain("Examples:");
		expect(help).not.toContain("Built-in Tool Names:");
	});
});
