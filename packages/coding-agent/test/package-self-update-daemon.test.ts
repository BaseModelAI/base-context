import type * as ChildProcessModule from "node:child_process";
import type { SpawnSyncOptions } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as DaemonUpdateRestartModule from "../src/cli/daemon-update-restart.js";
import {
	acquireDaemonUpdateRestartCoordinator,
	type DaemonUpdateRestartStatus,
	DaemonUpdateRestartStatusWriter,
	selectedUpdateInstallation,
	waitForActiveDaemonUpdateRestartCoordinator,
} from "../src/cli/daemon-update-restart.js";
import * as configModule from "../src/config.js";
import {
	ENV_AGENT_DIR,
	getDaemonUpdateRestartManifestPath,
	getLegacyDaemonUpdateRestartManifestPath,
	PACKAGE_NAME,
	SELF_UPDATE_INTERACTIVE_CHILD_ENV,
	SELF_UPDATE_NOT_ATTEMPTED_EXIT_CODE,
	VERSION,
} from "../src/config.js";
import type { AgentSessionRuntimeMetadata } from "../src/core/agent-session-runtime.js";
import { DefaultPackageManager } from "../src/core/package-manager.js";
import { DAEMON_PROTOCOL_VERSION, DAEMON_SCHEMA_ID } from "../src/modes/daemon/daemon-protocol.js";
import type * as DaemonSocketModule from "../src/modes/daemon/daemon-socket.js";
import { installOwnedRelease, type OwnedActivation, rollbackOwnedRelease } from "../src/owned-install.js";
import {
	type InstallSelection,
	installedCli,
	type OwnedInstallation,
	ownedVersion,
	readInstallSelection,
} from "../src/owned-install-layout.js";
import {
	handlePackageCommand,
	prepareDaemonUpdateRestart,
	runDaemonUpdateRestartCoordinator,
} from "../src/package-manager-cli.js";

interface MockSessionSummary {
	id: string;
	activeSessionId?: string;
	isStreaming: boolean;
	isCompacting: boolean;
	isBashRunning?: boolean;
	hasRunningRlmChildren?: boolean;
	sessionActions: { queuedCount: number; steering: string[]; followUps: string[] };
}

type MockRunningDaemonProbe = { reachable: false } | { reachable: true; activeSessions?: MockSessionSummary[] };

interface MockCustomMessage {
	role: "custom";
	customType: string;
	content: string;
	display: boolean;
	timestamp: number;
	details?: unknown;
}

interface MockRecoveryAction {
	id: string;
	source: "internal";
	delivery: "next_turn_boundary" | "when_run_idle";
	wake: "immediate" | "on_lower_boundary" | "external_resume";
	queueKey?: string;
	snapshot?: unknown;
	agentMessageId?: string;
	payload: { kind: "turn" | "session_command"; text: string; [key: string]: unknown };
}

interface MockUpdateRestartSession {
	activeSessionId: string;
	sessionId: string;
	sessionFile: string;
	cwd: string;
	config: Record<string, unknown>;
	runtimeMetadata?: AgentSessionRuntimeMetadata;
	queue: {
		actions: { formatVersion: 1 | 2; actions: MockRecoveryAction[] };
		nextTurn: MockCustomMessage[];
	};
	shouldResume: boolean;
	wasStreaming: boolean;
	wasCompacting: boolean;
	wasBashRunning: boolean;
	hadRunningRlmChildren: boolean;
	wasRetrying: boolean;
	hadAcceptedPromptInFlight: boolean;
}

interface MockUpdateRestartManifest {
	formatVersion: 1;
	createdAt: string;
	sessions: MockUpdateRestartSession[];
}

function createMockTurnExecutionPolicy(): Record<string, unknown> {
	return {
		preparation: {
			initialRefineBarrier: "skip",
			flushPendingBashBeforeValidation: false,
			validateModelAndAuth: true,
			awaitPendingModelSelection: true,
			preTurnCompaction: "beforeModelSelection",
			finalRefineBarrier: "always",
		},
		runBeforeAgentStart: true,
		nextTurnContextTiming: "commit",
		preserveEmptyExtensionPrompt: true,
		completionIncludesRetryChain: true,
	};
}

interface MockDaemonRequest {
	type: string;
	activeSessionId?: string;
	message?: string;
	agentMessageId?: string;
	customMessage?: MockCustomMessage;
	prefixMessages?: MockCustomMessage[];
	content?: unknown;
	messages?: MockCustomMessage[];
	queueKey?: string;
	snapshot?: unknown;
	sessionPath?: string;
	runtimeMetadata?: AgentSessionRuntimeMetadata;
}

type MockDaemonResponse = { success: true; data?: unknown } | { success: false; error: string };

const mockState = vi.hoisted(() => ({
	calls: [] as string[],
	createActiveSessionIds: [] as string[],
	createThrowSessionPaths: [] as string[],
	daemonProbe: { reachable: true, activeSessions: [] } as MockRunningDaemonProbe,
	daemonProbeAfterShutdown: undefined as MockRunningDaemonProbe | undefined,
	globalPackageRoot: "",
	hello: { protocol: { version: 0 } } as {
		protocol: { version: number };
		schemaId?: string;
		supervisorGeneration?: string;
		supervisorOwnerToken?: string;
		supervisorPid?: number;
		supervisorProcessStartId?: string;
		supervisorSocketPath?: string;
	},
	helloCount: 0,
	lastCoordinatorStatus: undefined as DaemonUpdateRestartStatus | undefined,
	listResponse: undefined as MockDaemonResponse | undefined,
	noticeError: undefined as string | undefined,
	prepareError: undefined as string | undefined,
	prepareManifest: {
		formatVersion: 1,
		createdAt: "2026-07-07T00:00:00.000Z",
		sessions: [],
	} as MockUpdateRestartManifest,
	preparedManifestPath: "",
	prepareResponse: undefined as MockDaemonResponse | undefined,
	promptFailures: 0,
	probeSocketPaths: [] as string[],
	requestThrowTypes: [] as string[],
	disconnectRequestTypes: [] as string[],
	disconnectAfterPersistRequestTypes: [] as string[],
	requestPayloads: [] as MockDaemonRequest[],
	helloWaitFailures: 0,
	restoreActionFailures: 0,
	restoreNextTurnFailures: 0,
	socketPath: "",
	successorProcessStartId: "replacement-start" as string | undefined,
	successorSocketPath: undefined as string | undefined,
	spawnExitCodes: [] as number[],
	ownedBoundary: undefined as
		| ((command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string | undefined) => void)
		| undefined,
	coordinatorInstallation: undefined as OwnedInstallation | undefined,
	shutdownResult: true,
}));

function useFixedOwnerHello(): void {
	mockState.hello = {
		protocol: { version: DAEMON_PROTOCOL_VERSION },
		schemaId: DAEMON_SCHEMA_ID,
		supervisorGeneration: "fixed-owner",
		supervisorOwnerToken: "owner-token",
		supervisorPid: process.pid,
		supervisorProcessStartId: "process-start",
		supervisorSocketPath: mockState.socketPath,
	};
}

vi.mock("child_process", async (importOriginal) => {
	const original = await importOriginal<typeof ChildProcessModule>();
	return {
		spawn: vi.fn((command: string, args: string[], options?: { env?: NodeJS.ProcessEnv; cwd?: string }) => {
			mockState.calls.push(`spawn:${command} ${args.join(" ")}`);
			mockState.ownedBoundary?.(command, args, options?.env ?? {}, options?.cwd);
			const exitCode = mockState.spawnExitCodes.shift() ?? 0;
			const child = {
				on(event: string, listener: unknown) {
					if (event === "close") {
						queueMicrotask(() => {
							(listener as (code: number | null, signal: string | null) => void)(exitCode, null);
						});
					}
					return child;
				},
			};
			return child;
		}),
		spawnSync: vi.fn((command: string, args: readonly string[] = [], options?: SpawnSyncOptions) => {
			if (command === "tar") {
				expect(args[0]).toBe("-xOf");
				expect(args[2]).toBe("package/package.json");
				expect(options?.cwd).toBe(process.cwd());
				// Local metadata boundary only; these fixture files are not real archives.
				return { status: 0, stdout: readFileSync(args[1], "utf8"), stderr: "" };
			}
			if (
				args.includes("--experimental-sqlite") &&
				args.some((arg) => /owned-install-worker\.(?:js|ts)$/.test(arg))
			) {
				return original.spawnSync(command, args, options);
			}
			return { status: 0, stdout: `${mockState.globalPackageRoot}\n`, stderr: "" };
		}),
	};
});

vi.mock("../src/cli/daemon-update-restart.js", async (importOriginal) => {
	const original = await importOriginal<typeof DaemonUpdateRestartModule>();
	return {
		...original,
		launchDaemonUpdateRestartCoordinator: vi.fn(
			async (options: { socketPath: string; installation?: OwnedInstallation }) => {
				mockState.coordinatorInstallation = options.installation;
				mockState.calls.push(`launch-coordinator:${options.socketPath}`);
				return {
					version: 1,
					requestId: "test-request",
					socketPath: options.socketPath,
					phase: "complete",
					coordinator: { pid: process.pid },
					counts: { total: 0, restored: 0, resumed: 0, failed: 0 },
					startedAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
				};
			},
		),
	};
});

vi.mock("../src/modes/daemon/daemon-socket.js", async (importOriginal) => ({
	...(await importOriginal<typeof DaemonSocketModule>()),
	defaultDaemonSocketPath: () => mockState.socketPath,
}));

vi.mock("../src/modes/daemon/daemon-supervisor-ownership.js", () => ({
	acquireDaemonShutdownAdmission: vi.fn(async () => {
		mockState.calls.push("acquire-daemon-shutdown-admission");
		return {
			assertOrRenew: vi.fn(async () => {
				mockState.calls.push("renew-daemon-shutdown-admission");
			}),
			release: vi.fn(async () => {
				mockState.calls.push("release-daemon-shutdown-admission");
			}),
		};
	}),
	persistDaemonStartupFenceFromOwner: vi.fn(async () => {
		mockState.calls.push("persist-daemon-startup-fence");
	}),
	waitForDaemonStartupFence: vi.fn(async () => {
		mockState.calls.push("wait-daemon-startup-fence");
	}),
}));

vi.mock("../src/cli/daemon-launch.js", () => ({
	ensureInteractiveDaemonRunning: vi.fn(async () => {
		mockState.calls.push("ensure-daemon");
	}),
	isDaemonSessionSummary: (value: unknown) => {
		if (!value || typeof value !== "object") {
			return false;
		}
		const summary = value as { activeSessionId?: unknown; id?: unknown };
		return typeof summary.activeSessionId === "string" || typeof summary.id === "string";
	},
	isSessionBusy: (summary: MockSessionSummary) =>
		summary.isStreaming ||
		summary.isCompacting ||
		summary.isBashRunning === true ||
		summary.hasRunningRlmChildren === true ||
		summary.sessionActions.queuedCount > 0,
	probeRunningDaemonSessions: vi.fn(async (socketPath: string) => {
		mockState.calls.push("probe-daemon");
		mockState.probeSocketPaths.push(socketPath);
		return mockState.daemonProbe;
	}),
	shutdownConnectedDaemonAndWait: vi.fn(async () => {
		mockState.calls.push("shutdown-daemon");
		if (mockState.daemonProbeAfterShutdown) {
			mockState.daemonProbe = mockState.daemonProbeAfterShutdown;
		}
		return mockState.shutdownResult;
	}),
}));

vi.mock("../src/modes/daemon/daemon-client.js", () => ({
	DaemonClient: class {
		private connected = false;
		private observedHello: typeof mockState.hello | undefined;

		constructor(readonly socketPath: string) {}

		get hello(): typeof mockState.hello | undefined {
			return this.observedHello;
		}

		async connect(): Promise<void> {
			mockState.calls.push(`daemon-connect:${this.socketPath}`);
			this.connected = true;
		}

		get isConnected(): boolean {
			return this.connected;
		}

		async waitForHello(): Promise<{
			protocol: { version: number };
			schemaId?: string;
			appVersion: string;
			supervisorGeneration?: string;
			supervisorOwnerToken?: string;
			supervisorPid?: number;
			supervisorProcessStartId?: string;
			supervisorSocketPath?: string;
		}> {
			if (mockState.helloWaitFailures > 0) {
				mockState.helloWaitFailures--;
				throw new Error("hello timed out");
			}
			const helloCount = mockState.helloCount++;
			const hello =
				helloCount === 0
					? {
							appVersion: VERSION,
							...mockState.hello,
						}
					: {
							protocol: { version: DAEMON_PROTOCOL_VERSION },
							schemaId: DAEMON_SCHEMA_ID,
							appVersion: VERSION,
							supervisorPid: 1002,
							supervisorGeneration: "replacement-generation",
							supervisorOwnerToken: "replacement-owner-token",
							...(mockState.successorProcessStartId
								? { supervisorProcessStartId: mockState.successorProcessStartId }
								: {}),
							supervisorSocketPath: mockState.successorSocketPath ?? mockState.socketPath,
						};
			this.observedHello = hello;
			return hello;
		}

		async request(request: MockDaemonRequest): Promise<MockDaemonResponse> {
			this.observedHello ??= mockState.hello;
			mockState.calls.push(`daemon-request:${request.type}`);
			mockState.requestPayloads.push(request);
			if (mockState.disconnectRequestTypes.includes(request.type)) {
				this.connected = false;
				throw new Error(`${request.type} disconnected`);
			}
			if (mockState.requestThrowTypes.includes(request.type)) {
				throw new Error(`${request.type} failed`);
			}
			if (request.type === "append_custom_message" && mockState.noticeError) {
				throw new Error(mockState.noticeError);
			}
			if (request.type === "list" && mockState.listResponse) {
				return mockState.listResponse;
			}
			if (request.type === "prepare_update_restart") {
				if (mockState.prepareError) {
					return { success: false, error: mockState.prepareError };
				}
				const response = mockState.prepareResponse ?? { success: true, data: mockState.prepareManifest };
				if (response.success) {
					writeFileSync(mockState.preparedManifestPath, `${JSON.stringify(response.data)}\n`);
					if (mockState.disconnectAfterPersistRequestTypes.includes(request.type)) {
						this.connected = false;
						throw new Error(`${request.type} disconnected after persist`);
					}
				}
				return response;
			}
			if (request.type === "create") {
				if (request.sessionPath && mockState.createThrowSessionPaths.includes(request.sessionPath)) {
					throw new Error("create failed");
				}
				const activeSessionId = mockState.createActiveSessionIds.shift() ?? "restored-active";
				return { success: true, data: { id: activeSessionId, activeSessionId } };
			}
			if (request.type === "restore_actions" && mockState.restoreActionFailures > 0) {
				mockState.restoreActionFailures--;
				return { success: false, error: "restore failed" };
			}
			if (request.type === "restore_next_turn" && mockState.restoreNextTurnFailures > 0) {
				mockState.restoreNextTurnFailures--;
				return { success: false, error: "restore failed" };
			}
			if (request.type === "prompt" && mockState.promptFailures > 0) {
				mockState.promptFailures--;
				return { success: false, error: "prompt failed" };
			}
			return { success: true };
		}

		close(): void {
			this.connected = false;
		}
	},
}));

describe("self-update daemon restart", () => {
	let tempDir: string;
	let agentDir: string;
	let projectDir: string;
	let packageDir: string;
	let originalAgentDir: string | undefined;
	let originalPiPackageDir: string | undefined;
	let originalCwd: string;
	let originalExecPath: string;
	let originalExitCode: typeof process.exitCode;

	async function performUpdateAndRunCoordinator(originActiveSessionId?: string): Promise<void> {
		await handlePackageCommand(["update", "--self", "--daemon-socket", mockState.socketPath]);
		const restartDirectory = join(agentDir, "update-restarts");
		mkdirSync(restartDirectory, { recursive: true });
		mockState.lastCoordinatorStatus = await runDaemonUpdateRestartCoordinator({
			socketPath: mockState.socketPath,
			agentDir,
			statusPath: join(restartDirectory, "test-status.json"),
			originActiveSessionId,
		});
	}

	function useOwnedProcessBoundary(
		root: string,
		version: string,
		localInstall?: { dependencies: readonly string[]; main: string },
	): void {
		mockState.ownedBoundary = (command, args, environment, cwd) => {
			expect(environment.BASE_CONTEXT_KERNEL_PYTHON).toBeUndefined();
			expect(environment.BASE_CONTEXT_KERNEL_VENV).toBeUndefined();
			if (command === "npm") {
				expect(args[0]).toBe("install");
				if (localInstall) {
					expect(args.slice(args.indexOf("--"))).toEqual(["--", ...localInstall.dependencies, localInstall.main]);
				} else {
					expect(args.slice(args.indexOf("--"))).toEqual(["--", args.at(-1)]);
				}
				expect(args).not.toContain("-g");
				expect(args).not.toContain(`--allow-scripts=${args.at(-1)}`);
				expect(environment.BASE_CONTEXT_BOOTSTRAP_KERNEL_ON_INSTALL).toBe("0");
				expect(environment.BASE_CONTEXT_BOOTSTRAP_TOOLS_ON_INSTALL).toBe("0");
				const directory = args[args.indexOf("--prefix") + 1];
				const localDependencies = (localInstall?.dependencies ?? []).map((tarball) => [
					JSON.parse(readFileSync(tarball, "utf8")).name as string,
					`file:${tarball}`,
				]);
				expect(JSON.parse(readFileSync(join(directory, "package.json"), "utf8"))).toEqual({
					private: true,
					...(localDependencies.length > 0
						? {
								dependencies: Object.fromEntries(localDependencies),
								overrides: Object.fromEntries(localDependencies.map(([name]) => [name, `$${name}`])),
							}
						: {}),
					allowScripts: Object.fromEntries(args.slice(args.indexOf("--") + 1).map((spec) => [spec, true])),
				});
				expect(statSync(join(directory, "package.json")).mode & 0o777).toBe(0o600);
				expect(cwd).toBe(directory);
				expect(dirname(directory)).toBe(join(root, "versions"));
				const candidatePackage = join(directory, "node_modules", PACKAGE_NAME);
				mkdirSync(join(candidatePackage, "dist", "bundle"), { recursive: true });
				mkdirSync(join(candidatePackage, "dist", "base-context-runtime"), { recursive: true });
				writeFileSync(join(candidatePackage, "package.json"), JSON.stringify({ name: PACKAGE_NAME, version }));
				writeFileSync(join(candidatePackage, "dist", "bundle", "cli.js"), `CLI ${version}`);
				writeFileSync(join(candidatePackage, "dist", "installer.mjs"), "offline preparation boundary");
				writeFileSync(
					join(candidatePackage, "dist", "base-context-runtime", "pyproject.toml"),
					`payload ${version}`,
				);
			} else {
				expect(command).toBe(process.execPath);
				expect(args[1]).toBe("prepare");
				const directory = dirname(dirname(dirname(dirname(dirname(args[0])))));
				expect(cwd).toBe(directory);
				expect(dirname(directory)).toBe(join(root, "versions"));
				if ((mockState.spawnExitCodes[0] ?? 0) === 0) {
					mkdirSync(join(directory, "runtime", "bin"), { recursive: true });
					writeFileSync(join(directory, "runtime", "bin", "python"), `runtime ${version}`);
				}
			}
		};
	}

	async function createOwnedFixture(localDependencyTarballs?: string[]): Promise<OwnedActivation> {
		// Keep activation on this test's actual Node22.12; npm and Python remain the existing offline boundaries.
		Object.defineProperty(process, "execPath", { value: originalExecPath, configurable: true });
		const root = join(tempDir, "owned");
		const cwd = process.cwd();
		useOwnedProcessBoundary(
			root,
			"1.0.0",
			localDependencyTarballs
				? {
						dependencies: localDependencyTarballs.map((path) => resolve(cwd, path)),
						main: "base-context-old.tgz",
					}
				: undefined,
		);
		const operation = {
			root,
			expected: null as InstallSelection | null,
			installSpec: "base-context-old.tgz",
			version: "1.0.0",
			...(localDependencyTarballs ? { localDependencyTarballs } : {}),
		};
		const callsStart = mockState.calls.length;
		const pending = installOwnedRelease(operation);
		// The operation owns its original inputs while its npm boundary is pending.
		operation.root = join(tempDir, "not-the-original-root");
		operation.expected = { generation: "not-the-original-generation", active: "other", previous: null };
		operation.installSpec = "not-the-original-package.tgz";
		operation.version = "2.0.0";
		if (localDependencyTarballs) {
			localDependencyTarballs.splice(0, localDependencyTarballs.length, "not-the-original-dependency.tgz");
			operation.localDependencyTarballs = ["late-dependency.tgz"];
			process.chdir(tempDir);
		}
		try {
			const activated = await pending;
			expect(mockState.calls.slice(callsStart).filter((call) => call.startsWith("spawn:npm "))).toHaveLength(1);
			return activated;
		} finally {
			process.chdir(cwd);
		}
	}

	function createAcceptedRecoveryManifest(nextTurn: MockCustomMessage[] = []): MockUpdateRestartManifest {
		return {
			formatVersion: 1,
			createdAt: "2026-07-07T00:00:00.000Z",
			sessions: [
				{
					activeSessionId: "old-active",
					sessionId: "session-1",
					sessionFile: join(projectDir, "session.jsonl"),
					cwd: projectDir,
					config: { cwd: projectDir, agentDir },
					queue: {
						actions: {
							formatVersion: 1,
							actions: [
								{
									id: "accepted-action",
									source: "internal",
									delivery: "when_run_idle",
									wake: "external_resume",
									agentMessageId: "agentmsg_accepted",
									payload: {
										kind: "turn",
										text: "accepted work",
										records: [
											{
												id: "accepted-action-primary",
												role: "primary",
												message: { role: "user", content: "accepted work", timestamp: 1 },
												ownerActionId: "accepted-action",
											},
										],
										executionPolicy: createMockTurnExecutionPolicy(),
										queueVisible: false,
										acceptedAgentMessage: false,
										acceptedBeforeCompletion: true,
									},
								},
							],
						},
						nextTurn,
					},
					shouldResume: true,
					wasStreaming: false,
					wasCompacting: false,
					wasBashRunning: false,
					hadRunningRlmChildren: false,
					wasRetrying: false,
					hadAcceptedPromptInFlight: true,
				},
			],
		};
	}

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-self-update-daemon-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		projectDir = join(tempDir, "project");
		packageDir = join(tempDir, "global-prefix", "lib", "node_modules", PACKAGE_NAME);
		mockState.globalPackageRoot = join(tempDir, "global-prefix", "lib", "node_modules");
		mockState.hello = { protocol: { version: DAEMON_PROTOCOL_VERSION }, schemaId: DAEMON_SCHEMA_ID };
		mockState.helloCount = 0;
		mockState.lastCoordinatorStatus = undefined;
		mockState.listResponse = undefined;
		mockState.noticeError = undefined;
		mockState.prepareError = undefined;
		mockState.socketPath = join(tempDir, "daemon.sock");
		mockState.successorProcessStartId = "replacement-start";
		mockState.successorSocketPath = undefined;
		mockState.calls = [];
		mockState.createActiveSessionIds = [];
		mockState.createThrowSessionPaths = [];
		mockState.daemonProbe = { reachable: true, activeSessions: [] };
		mockState.daemonProbeAfterShutdown = undefined;
		mockState.disconnectAfterPersistRequestTypes = [];
		mockState.disconnectRequestTypes = [];
		mockState.prepareManifest = { formatVersion: 1, createdAt: "2026-07-07T00:00:00.000Z", sessions: [] };
		mockState.preparedManifestPath = getDaemonUpdateRestartManifestPath(mockState.socketPath, agentDir);
		mockState.prepareResponse = undefined;
		mockState.helloWaitFailures = 0;
		mockState.promptFailures = 0;
		mockState.probeSocketPaths = [];
		mockState.requestThrowTypes = [];
		mockState.requestPayloads = [];
		mockState.restoreActionFailures = 0;
		mockState.restoreNextTurnFailures = 0;
		mockState.spawnExitCodes = [];
		mockState.ownedBoundary = undefined;
		mockState.coordinatorInstallation = undefined;
		mockState.shutdownResult = true;
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(agentDir, "daemon-update-restarts"), { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		mkdirSync(packageDir, { recursive: true });

		originalAgentDir = process.env[ENV_AGENT_DIR];
		originalPiPackageDir = process.env.BASE_CONTEXT_PACKAGE_DIR;
		originalCwd = process.cwd();
		originalExecPath = process.execPath;
		originalExitCode = process.exitCode;
		process.exitCode = undefined;
		process.env[ENV_AGENT_DIR] = agentDir;
		process.env.BASE_CONTEXT_PACKAGE_DIR = packageDir;
		process.chdir(projectDir);
		Object.defineProperty(process, "execPath", {
			value: join(packageDir, "dist", "cli.js"),
			configurable: true,
		});
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ npmCommand: ["npm"] }, null, 2));
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ version: "999.0.0" })),
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		process.chdir(originalCwd);
		process.exitCode = originalExitCode;
		if (originalAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = originalAgentDir;
		}
		if (originalPiPackageDir === undefined) {
			delete process.env.BASE_CONTEXT_PACKAGE_DIR;
		} else {
			process.env.BASE_CONTEXT_PACKAGE_DIR = originalPiPackageDir;
		}
		delete process.env[SELF_UPDATE_INTERACTIVE_CHILD_ENV];
		Object.defineProperty(process, "execPath", { value: originalExecPath, configurable: true });
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("scopes prepared restart manifests to the exact daemon socket", () => {
		const otherSocketPath = join(tempDir, "other-daemon.sock");

		expect(getDaemonUpdateRestartManifestPath(mockState.socketPath, agentDir)).not.toBe(
			getDaemonUpdateRestartManifestPath(otherSocketPath, agentDir),
		);
	});

	it.each([
		["unreadable", "{"],
		["unknown-format", JSON.stringify({ formatVersion: 0, createdAt: "stale", sessions: [] })],
	])("ignores a %s pending restart manifest when probing", async (_name, contents) => {
		writeFileSync(mockState.preparedManifestPath, contents);

		await expect(prepareDaemonUpdateRestart(mockState.socketPath, agentDir)).resolves.toEqual(
			mockState.prepareManifest,
		);
		expect(mockState.calls).toContain("daemon-request:prepare_update_restart");
	});

	it("uses the interactive no-change sentinel only when self-update is unchanged", async () => {
		process.env[SELF_UPDATE_INTERACTIVE_CHILD_ENV] = "1";
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ version: VERSION })),
		);

		await expect(handlePackageCommand(["update", "--self"])).resolves.toBe(true);

		expect(process.exitCode).toBe(SELF_UPDATE_NOT_ATTEMPTED_EXIT_CODE);
		expect(mockState.calls.some((call) => call.startsWith("spawn:npm "))).toBe(false);
	});

	it("does not use the no-change sentinel when interactive self-update is cancelled", async () => {
		process.env[SELF_UPDATE_INTERACTIVE_CHILD_ENV] = "1";
		mockState.daemonProbe = {
			reachable: true,
			activeSessions: [
				{
					id: "busy",
					activeSessionId: "busy",
					isStreaming: true,
					isCompacting: false,
					sessionActions: { queuedCount: 0, steering: [], followUps: [] },
				},
			],
		};
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(handlePackageCommand(["update", "--self"])).resolves.toBe(true);

			expect(process.exitCode).toBe(1);
			expect(mockState.calls.some((call) => call.startsWith("spawn:npm "))).toBe(false);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("does not prepare or stop the daemon when the package update fails", async () => {
		mockState.spawnExitCodes = [23];
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const updateSpy = vi.spyOn(DefaultPackageManager.prototype, "update");

		try {
			await expect(handlePackageCommand(["update", "--self"])).resolves.toBe(true);

			expect(process.exitCode).toBe(1);
			expect(mockState.calls).toContain("probe-daemon");
			expect(mockState.calls.some((call) => call === "daemon-request:prepare_update_restart")).toBe(false);
			expect(mockState.calls.some((call) => call === "shutdown-daemon")).toBe(false);

			// Failed lookup must reach the CLI reporter unchanged, even with --force.
			const callsBeforeLookup = [...mockState.calls];
			const logsBeforeLookup = logSpy.mock.calls.length;
			const lookupError = new Error("release lookup transport failed");
			vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(lookupError));
			await expect(handlePackageCommand(["update", "--self", "--force"])).resolves.toBe(true);
			expect(process.exitCode).toBe(1);
			expect(errorSpy.mock.calls.at(-1)?.[0]).toContain(lookupError.message);
			expect(mockState.calls).toEqual(callsBeforeLookup);
			expect(logSpy.mock.calls).toHaveLength(logsBeforeLookup);

			// Preserve an earlier accepted extension update; an unavailable release is NOT self-update success.
			const extensionEffect = join(projectDir, "accepted-extension-update");
			updateSpy.mockImplementationOnce(async () => {
				writeFileSync(extensionEffect, "completed");
			});
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => new Response(null, { status: 503 })),
			);
			process.env[SELF_UPDATE_INTERACTIVE_CHILD_ENV] = "1";
			await expect(handlePackageCommand(["update", "--force"])).resolves.toBe(true);
			expect(process.exitCode).toBe(1);
			expect(errorSpy.mock.calls.at(-1)?.[0]).toContain(
				"release lookup is unavailable; self-update was not attempted",
			);
			expect(mockState.calls).toEqual(callsBeforeLookup);
			expect(readFileSync(extensionEffect, "utf8")).toBe("completed");
			expect(logSpy.mock.calls.slice(logsBeforeLookup)).toHaveLength(1);
			expect(logSpy.mock.calls.at(-1)?.[0]).toContain("Updated packages");

			// A failed candidate runtime cannot replace the actual previously selected pair.
			delete process.env[SELF_UPDATE_INTERACTIVE_CHILD_ENV];
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => Response.json({ version: "999.0.0" })),
			);
			const previous = await createOwnedFixture();
			const originalSelection = readFileSync(join(previous.installation.root, "current.json"), "utf8");
			const physical = vi
				.spyOn(configModule, "getPhysicalPackageDir")
				.mockReturnValue(previous.installation.packageDir);
			process.env.BASE_CONTEXT_PACKAGE_DIR = previous.installation.packageDir;
			const oldPythonOverride = process.env.BASE_CONTEXT_KERNEL_PYTHON;
			const oldVenvOverride = process.env.BASE_CONTEXT_KERNEL_VENV;
			process.env.BASE_CONTEXT_KERNEL_PYTHON = join(previous.installation.runtimeDir, "bin", "python");
			process.env.BASE_CONTEXT_KERNEL_VENV = previous.installation.runtimeDir;
			useOwnedProcessBoundary(previous.installation.root, "999.0.0");
			mockState.spawnExitCodes = [0, 23];
			const ownedCallsStart = mockState.calls.length;
			try {
				await expect(handlePackageCommand(["update", "--self"])).resolves.toBe(true);
				expect(process.exitCode).toBe(1);
				expect(readFileSync(join(previous.installation.root, "current.json"), "utf8")).toBe(originalSelection);
				expect(readFileSync(installedCli(previous.installation), "utf8")).toBe("CLI 1.0.0");
				expect(readFileSync(join(previous.installation.runtimeDir, "bin", "python"), "utf8")).toBe("runtime 1.0.0");
				expect(readFileSync(extensionEffect, "utf8")).toBe("completed");
				const calls = mockState.calls.slice(ownedCallsStart);
				expect(calls.some((call) => call.includes("installer.mjs prepare"))).toBe(true);
				expect(calls.some((call) => call.startsWith("launch-coordinator:") || call === "shutdown-daemon")).toBe(
					false,
				);
				expect(errorSpy.mock.calls.at(-1)?.[0]).toContain("Base-Context preparation failed");

				// The same preparation failure with local dependencies cannot select a different pair.
				const dependency = join(projectDir, "local-sdk-failed.tgz");
				writeFileSync(dependency, JSON.stringify({ name: "@ponythewhite/base-context-ai", version: "999.0.0" }));
				useOwnedProcessBoundary(previous.installation.root, "999.0.0", {
					dependencies: [dependency],
					main: "base-context-local.tgz",
				});
				mockState.spawnExitCodes = [0, 23];
				const localCallsStart = mockState.calls.length;
				await expect(
					installOwnedRelease({
						root: previous.installation.root,
						expected: previous.selection,
						installSpec: "base-context-local.tgz",
						version: "999.0.0",
						localDependencyTarballs: [dependency],
					}),
				).rejects.toThrow("Base-Context preparation failed");
				expect(mockState.calls.slice(localCallsStart).filter((call) => call.startsWith("spawn:npm "))).toHaveLength(
					1,
				);
				expect(readFileSync(join(previous.installation.root, "current.json"), "utf8")).toBe(originalSelection);
				expect(readFileSync(installedCli(previous.installation), "utf8")).toBe("CLI 1.0.0");
				expect(readFileSync(join(previous.installation.runtimeDir, "bin", "python"), "utf8")).toBe("runtime 1.0.0");
			} finally {
				physical.mockRestore();
				if (oldPythonOverride === undefined) delete process.env.BASE_CONTEXT_KERNEL_PYTHON;
				else process.env.BASE_CONTEXT_KERNEL_PYTHON = oldPythonOverride;
				if (oldVenvOverride === undefined) delete process.env.BASE_CONTEXT_KERNEL_VENV;
				else process.env.BASE_CONTEXT_KERNEL_VENV = oldVenvOverride;
			}
		} finally {
			updateSpy.mockRestore();
			errorSpy.mockRestore();
			logSpy.mockRestore();
		}
	});

	it("defers the exact custom-socket restart to the interactive parent", async () => {
		process.env[SELF_UPDATE_INTERACTIVE_CHILD_ENV] = "1";
		// Force can reinstall a KNOWN same-version release, not bypass the lookup.
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ version: VERSION })),
		);
		const customSocketPath = join(tempDir, "custom", "daemon.sock");

		await expect(
			handlePackageCommand(["update", "--self", "--force", "--daemon-socket", customSocketPath]),
		).resolves.toBe(true);

		expect(process.exitCode).toBeUndefined();
		expect(mockState.probeSocketPaths).toEqual([customSocketPath]);
		expect(mockState.calls.some((call) => call.startsWith("spawn:npm "))).toBe(true);
		expect(mockState.calls.some((call) => call.startsWith("launch-coordinator:"))).toBe(false);
	});

	it("serializes coordinators per exact socket", async () => {
		const registryDir = join(tempDir, "restart-registry");
		const first = await acquireDaemonUpdateRestartCoordinator({
			requestId: "first",
			socketPath: mockState.socketPath,
			statusPath: join(agentDir, "first.json"),
			registryDir,
		});
		try {
			await expect(
				acquireDaemonUpdateRestartCoordinator({
					requestId: "second",
					socketPath: mockState.socketPath,
					statusPath: join(agentDir, "second.json"),
					registryDir,
				}),
			).rejects.toThrow("already running");
		} finally {
			await first.release();
		}
	});

	it("waits for the active coordinator before a concurrent loser completes", async () => {
		const activeStatusPath = join(agentDir, "active-status.json");
		const activeStatus = new DaemonUpdateRestartStatusWriter(
			activeStatusPath,
			"active-request",
			mockState.socketPath,
		);
		activeStatus.update({ phase: "preparing" });
		const activeLease = await acquireDaemonUpdateRestartCoordinator({
			requestId: "active-request",
			socketPath: mockState.socketPath,
			statusPath: activeStatusPath,
		});
		let settled = false;
		try {
			const loser = runDaemonUpdateRestartCoordinator({
				socketPath: mockState.socketPath,
				agentDir,
				statusPath: join(agentDir, "loser-status.json"),
			}).finally(() => {
				settled = true;
			});

			await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
			expect(settled).toBe(false);
			activeStatus.update({
				phase: "complete",
				counts: { total: 1, restored: 1, resumed: 0, failed: 0 },
				message: "active coordinator completed",
			});

			await expect(loser).resolves.toMatchObject({
				phase: "complete",
				counts: { total: 1, restored: 1, resumed: 0, failed: 0 },
				message: "active coordinator completed",
			});
			expect(mockState.calls).not.toContain("probe-daemon");
		} finally {
			await activeLease.release();
		}
	});

	it("returns a terminal status written immediately before coordinator exit", async () => {
		const statusPath = join(agentDir, "exit-race-status.json");
		const statusWriter = new DaemonUpdateRestartStatusWriter(statusPath, "exit-race", mockState.socketPath);
		statusWriter.update({ phase: "preparing" });
		const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
			statusWriter.update({ phase: "complete" });
			const error = new Error("process exited") as NodeJS.ErrnoException;
			error.code = "ESRCH";
			throw error;
		});

		try {
			await expect(
				waitForActiveDaemonUpdateRestartCoordinator({
					version: 1,
					token: "exit-race-token",
					requestId: "exit-race",
					pid: 999_999,
					socketPath: mockState.socketPath,
					statusPath,
					createdAt: new Date().toISOString(),
				}),
			).resolves.toMatchObject({ phase: "complete" });
		} finally {
			killSpy.mockRestore();
		}
	});

	it("rejects a successor that answers for another socket", async () => {
		mockState.successorSocketPath = join(tempDir, "wrong-daemon.sock");

		await performUpdateAndRunCoordinator();

		expect(mockState.lastCoordinatorStatus).toMatchObject({
			phase: "failed",
			message: expect.stringContaining("does not match"),
		});
		expect(mockState.requestPayloads.some((request) => request.type === "create")).toBe(false);
	});

	it("accepts a fixed replacement owner when process start ids are unavailable", async () => {
		mockState.hello = {
			protocol: { version: 2 },
			supervisorGeneration: "predecessor-generation",
			supervisorOwnerToken: "predecessor-owner-token",
			supervisorPid: 1001,
			supervisorSocketPath: mockState.socketPath,
		};
		mockState.successorProcessStartId = undefined;

		await performUpdateAndRunCoordinator();

		expect(mockState.lastCoordinatorStatus).toMatchObject({
			phase: "complete",
			successor: {
				pid: 1002,
				supervisorGeneration: "replacement-generation",
				supervisorOwnerToken: "replacement-owner-token",
			},
		});
	});

	it("clears the prepared manifest after fallback restoration when shutdown fails", async () => {
		mockState.shutdownResult = false;
		mockState.prepareManifest = {
			formatVersion: 1,
			createdAt: "2026-07-07T00:00:00.000Z",
			sessions: [
				{
					activeSessionId: "old-active",
					sessionId: "session-id",
					sessionFile: join(tempDir, "session.jsonl"),
					cwd: tempDir,
					config: {},
					queue: { actions: { formatVersion: 1, actions: [] }, nextTurn: [] },
					shouldResume: false,
					wasStreaming: false,
					wasCompacting: false,
					wasBashRunning: false,
					hadRunningRlmChildren: false,
					wasRetrying: false,
					hadAcceptedPromptInFlight: false,
				},
			],
		};

		await performUpdateAndRunCoordinator();

		expect(mockState.lastCoordinatorStatus).toMatchObject({
			phase: "failed",
			counts: { total: 1, restored: 1, resumed: 0, failed: 0 },
		});
		expect(existsSync(mockState.preparedManifestPath)).toBe(false);
	});

	it("starts a successor when shutdown identity confirmation times out after the socket is gone", async () => {
		mockState.shutdownResult = false;
		mockState.daemonProbeAfterShutdown = { reachable: false };
		mockState.prepareManifest = {
			formatVersion: 1,
			createdAt: "2026-07-07T00:00:00.000Z",
			sessions: [
				{
					activeSessionId: "old-active",
					sessionId: "session-id",
					sessionFile: join(tempDir, "session.jsonl"),
					cwd: tempDir,
					config: {},
					queue: { actions: { formatVersion: 1, actions: [] }, nextTurn: [] },
					shouldResume: false,
					wasStreaming: false,
					wasCompacting: false,
					wasBashRunning: false,
					hadRunningRlmChildren: false,
					wasRetrying: false,
					hadAcceptedPromptInFlight: false,
				},
			],
		};

		await performUpdateAndRunCoordinator();

		expect(mockState.lastCoordinatorStatus).toMatchObject({
			phase: "complete",
			counts: { total: 1, restored: 1, resumed: 0, failed: 0 },
		});
		expect(mockState.calls).toContain("ensure-daemon");
		expect(existsSync(mockState.preparedManifestPath)).toBe(false);
	});

	it("continues queued-work restoration when the update notice request rejects", async () => {
		mockState.noticeError = "socket closed";
		mockState.prepareManifest = {
			formatVersion: 1,
			createdAt: "2026-07-07T00:00:00.000Z",
			sessions: [
				{
					activeSessionId: "old-active",
					sessionId: "session-id",
					sessionFile: join(tempDir, "session.jsonl"),
					cwd: tempDir,
					config: {},
					queue: {
						actions: { formatVersion: 1, actions: [] },
						nextTurn: [
							{
								role: "custom",
								customType: "queued-context",
								content: "preserve me",
								display: false,
								timestamp: 1,
							},
						],
					},
					shouldResume: false,
					wasStreaming: false,
					wasCompacting: false,
					wasBashRunning: false,
					hadRunningRlmChildren: false,
					wasRetrying: false,
					hadAcceptedPromptInFlight: false,
				},
			],
		};
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await performUpdateAndRunCoordinator("old-active");

			expect(mockState.lastCoordinatorStatus).toMatchObject({
				phase: "complete",
				counts: { total: 1, restored: 1, resumed: 0, failed: 0 },
			});
			expect(mockState.requestPayloads.map((request) => request.type)).toContain("restore_next_turn");
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("restarts the daemon only after the package update succeeds", async () => {
		useFixedOwnerHello();
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(performUpdateAndRunCoordinator()).resolves.toBeUndefined();

			expect(process.exitCode).toBeUndefined();
			const spawnIndex = mockState.calls.findIndex((call) => call.startsWith("spawn:npm "));
			const launchIndex = mockState.calls.indexOf(`launch-coordinator:${mockState.socketPath}`);
			const fenceIndex = mockState.calls.indexOf("persist-daemon-startup-fence");
			const prepareIndex = mockState.calls.indexOf("daemon-request:prepare_update_restart");
			const admissionIndex = mockState.calls.indexOf("acquire-daemon-shutdown-admission");
			const shutdownIndex = mockState.calls.indexOf("shutdown-daemon");
			const startupFenceIndex = mockState.calls.indexOf("wait-daemon-startup-fence");
			const releaseAdmissionIndex = mockState.calls.indexOf("release-daemon-shutdown-admission");
			const ensureIndex = mockState.calls.indexOf("ensure-daemon");
			expect(spawnIndex).toBeGreaterThanOrEqual(0);
			expect(launchIndex).toBeGreaterThan(spawnIndex);
			expect(admissionIndex).toBeGreaterThan(launchIndex);
			expect(prepareIndex).toBeGreaterThan(admissionIndex);
			expect(fenceIndex).toBeGreaterThan(prepareIndex);
			expect(shutdownIndex).toBeGreaterThan(fenceIndex);
			expect(startupFenceIndex).toBeGreaterThan(shutdownIndex);
			expect(releaseAdmissionIndex).toBeGreaterThan(startupFenceIndex);
			expect(ensureIndex).toBeGreaterThan(releaseAdmissionIndex);
			expect(ensureIndex).toBeGreaterThan(shutdownIndex);
			expect(statSync(join(agentDir, "update-restarts", "test-status.json")).mode & 0o777).toBe(0o600);

			// The real installation owner commits both selections; npm/Python alone are offline boundaries.
			const dependencies = ["local-sdk-core.tgz", "local-sdk agent.tgz"];
			for (const [index, dependency] of dependencies.entries()) {
				// Names come from fake tar metadata, not these unrelated filenames.
				writeFileSync(
					join(projectDir, dependency),
					JSON.stringify({
						name: ["@ponythewhite/base-context-ai", "@ponythewhite/base-context-agent"][index],
						version: "1.0.0",
					}),
				);
			}
			const previous = await createOwnedFixture(dependencies);
			expect(readFileSync(installedCli(previous.installation), "utf8")).toBe("CLI 1.0.0");
			expect(readFileSync(join(previous.installation.runtimeDir, "bin", "python"), "utf8")).toBe("runtime 1.0.0");
			const physical = vi
				.spyOn(configModule, "getPhysicalPackageDir")
				.mockReturnValue(previous.installation.packageDir);
			process.env.BASE_CONTEXT_PACKAGE_DIR = previous.installation.packageDir;
			useOwnedProcessBoundary(previous.installation.root, "999.0.0");
			const ownedCallsStart = mockState.calls.length;
			try {
				await expect(handlePackageCommand(["update", "--self"])).resolves.toBe(true);
				expect(process.exitCode).toBeUndefined();
				const selected = readInstallSelection(previous.installation.root)!;
				expect(selected.active).not.toBe(previous.selection.active);
				expect(selected.previous).toBe(previous.selection.active);
				const current = ownedVersion(previous.installation.root, selected.active);
				expect(readFileSync(installedCli(current), "utf8")).toBe("CLI 999.0.0");
				expect(readFileSync(join(current.runtimeDir, "bin", "python"), "utf8")).toBe("runtime 999.0.0");
				expect(readFileSync(join(previous.installation.runtimeDir, "bin", "python"), "utf8")).toBe("runtime 1.0.0");
				expect(selectedUpdateInstallation()?.packageDir).toBe(current.packageDir);
				expect(mockState.coordinatorInstallation?.packageDir).toBe(current.packageDir);
				const calls = mockState.calls.slice(ownedCallsStart);
				const prepared = calls.findIndex((call) => call.includes("installer.mjs prepare"));
				expect(prepared).toBeGreaterThanOrEqual(0);
				expect(calls.findIndex((call) => call.startsWith("launch-coordinator:"))).toBeGreaterThan(prepared);
				const rolledBack = rollbackOwnedRelease(previous.installation.root, selected);
				expect(rolledBack.selection.active).toBe(previous.selection.active);
				expect(rolledBack.selection.previous).toBe(selected.active);
				expect(rolledBack.selection.generation).not.toBe(previous.selection.generation);
				expect(readFileSync(installedCli(current), "utf8")).toBe("CLI 999.0.0");
				expect(readFileSync(join(current.runtimeDir, "bin", "python"), "utf8")).toBe("runtime 999.0.0");
			} finally {
				physical.mockRestore();
			}
		} finally {
			errorSpy.mockRestore();
			logSpy.mockRestore();
		}
	});

	it("does not persist a predecessor fence when restart preparation fails", async () => {
		useFixedOwnerHello();

		for (const prepareResponse of [
			{ success: false, error: "prepare failed" } as const,
			{
				success: true,
				data: { formatVersion: 1, createdAt: "2026-07-07T00:00:00.000Z", sessions: "invalid" },
			} as const,
		]) {
			mockState.calls = [];
			mockState.prepareResponse = prepareResponse;
			await expect(prepareDaemonUpdateRestart(mockState.socketPath, agentDir)).rejects.toThrow();
			expect(mockState.calls).toContain("daemon-request:prepare_update_restart");
			expect(mockState.calls).not.toContain("persist-daemon-startup-fence");
		}
	});

	it("persists a fixed predecessor fence when the hello arrives after the initial probe", async () => {
		useFixedOwnerHello();
		mockState.helloWaitFailures = 1;

		await expect(prepareDaemonUpdateRestart(mockState.socketPath, agentDir)).resolves.toEqual(
			mockState.prepareManifest,
		);

		const prepareIndex = mockState.calls.indexOf("daemon-request:prepare_update_restart");
		const fenceIndex = mockState.calls.indexOf("persist-daemon-startup-fence");
		expect(prepareIndex).toBeGreaterThanOrEqual(0);
		expect(fenceIndex).toBeGreaterThan(prepareIndex);
	});

	it("recovers and clears a legacy manifest when the predecessor disconnects after persisting it", async () => {
		useFixedOwnerHello();
		const legacyManifestPath = getLegacyDaemonUpdateRestartManifestPath(agentDir);
		mockState.preparedManifestPath = legacyManifestPath;
		mockState.disconnectAfterPersistRequestTypes = ["prepare_update_restart"];
		mockState.prepareManifest = {
			formatVersion: 1,
			createdAt: "2026-07-07T00:00:00.000Z",
			sessions: [
				{
					activeSessionId: "old-active",
					sessionId: "session-id",
					sessionFile: join(tempDir, "session.jsonl"),
					cwd: tempDir,
					config: { apiKey: "legacy-secret" },
					queue: { actions: { formatVersion: 1, actions: [] }, nextTurn: [] },
					shouldResume: false,
					wasStreaming: false,
					wasCompacting: false,
					wasBashRunning: false,
					hadRunningRlmChildren: false,
					wasRetrying: false,
					hadAcceptedPromptInFlight: false,
				},
			],
		};

		await performUpdateAndRunCoordinator();

		expect(mockState.lastCoordinatorStatus).toMatchObject({
			phase: "complete",
			counts: { total: 1, restored: 1, resumed: 0, failed: 0 },
		});
		expect(mockState.calls).toContain("persist-daemon-startup-fence");
		expect(existsSync(legacyManifestPath)).toBe(false);
		expect(existsSync(getDaemonUpdateRestartManifestPath(mockState.socketPath, agentDir))).toBe(false);
	});

	it("fences a pending prepared restart only after verifying the live daemon is empty", async () => {
		useFixedOwnerHello();
		const pendingManifest: MockUpdateRestartManifest = {
			formatVersion: 1,
			createdAt: "2026-07-07T00:00:00.000Z",
			sessions: [
				{
					activeSessionId: "pending-active",
					sessionId: "pending-session",
					sessionFile: join(projectDir, "pending.jsonl"),
					cwd: projectDir,
					config: { cwd: projectDir, agentDir },
					queue: { actions: { formatVersion: 1, actions: [] }, nextTurn: [] },
					shouldResume: false,
					wasStreaming: false,
					wasCompacting: false,
					wasBashRunning: false,
					hadRunningRlmChildren: false,
					wasRetrying: false,
					hadAcceptedPromptInFlight: false,
				},
			],
		};
		writeFileSync(
			getDaemonUpdateRestartManifestPath(mockState.socketPath, agentDir),
			JSON.stringify(pendingManifest),
		);
		mockState.requestThrowTypes = ["list"];

		await expect(prepareDaemonUpdateRestart(mockState.socketPath, agentDir)).rejects.toThrow("list failed");
		expect(mockState.calls).not.toContain("persist-daemon-startup-fence");

		mockState.calls = [];
		mockState.requestThrowTypes = [];
		mockState.listResponse = { success: true, data: { sessions: [] } };
		await expect(prepareDaemonUpdateRestart(mockState.socketPath, agentDir)).resolves.toEqual(pendingManifest);
		const listIndex = mockState.calls.indexOf("daemon-request:list");
		const fenceIndex = mockState.calls.indexOf("persist-daemon-startup-fence");
		expect(listIndex).toBeGreaterThanOrEqual(0);
		expect(fenceIndex).toBeGreaterThan(listIndex);
		expect(mockState.calls).not.toContain("daemon-request:prepare_update_restart");

		mockState.calls = [];
		mockState.listResponse = {
			success: true,
			data: {
				sessions: [
					{
						id: "live-active",
						isStreaming: false,
						isCompacting: false,
						sessionActions: { queuedCount: 0, steering: [], followUps: [] },
					},
				],
			},
		};
		mockState.disconnectRequestTypes = ["prepare_update_restart"];
		writeFileSync(
			getDaemonUpdateRestartManifestPath(mockState.socketPath, agentDir),
			JSON.stringify(pendingManifest),
		);

		await expect(prepareDaemonUpdateRestart(mockState.socketPath, agentDir)).rejects.toThrow(
			"prepare_update_restart disconnected",
		);
		expect(existsSync(getDaemonUpdateRestartManifestPath(mockState.socketPath, agentDir))).toBe(false);
	});

	it("skips predecessor fencing when the daemon hello has no fixed-owner identity", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(performUpdateAndRunCoordinator()).resolves.toBeUndefined();

			expect(mockState.calls).not.toContain("persist-daemon-startup-fence");
			expect(mockState.calls).toContain("daemon-request:prepare_update_restart");
		} finally {
			errorSpy.mockRestore();
			logSpy.mockRestore();
		}
	});

	it("still resumes accepted prompts when accepted context restore fails", async () => {
		mockState.restoreActionFailures = 1;
		mockState.prepareManifest = createAcceptedRecoveryManifest();
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(performUpdateAndRunCoordinator("old-active")).resolves.toBeUndefined();

			expect(mockState.requestPayloads.some((request) => request.type === "restore_actions")).toBe(true);
			expect(mockState.requestPayloads.some((request) => request.type === "prompt")).toBe(true);
		} finally {
			errorSpy.mockRestore();
			logSpy.mockRestore();
		}
	});

	it("does not replay a continuation after restoring an accepted turn", async () => {
		mockState.prepareManifest = createAcceptedRecoveryManifest();
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(performUpdateAndRunCoordinator("old-active")).resolves.toBeUndefined();

			expect(mockState.requestPayloads.filter((request) => request.type === "restore_actions")).toHaveLength(1);
			expect(mockState.requestPayloads.some((request) => request.type === "prompt")).toBe(false);
			expect(mockState.requestPayloads.filter((request) => request.type === "resume_queue")).toHaveLength(1);
		} finally {
			errorSpy.mockRestore();
			logSpy.mockRestore();
		}
	});

	it("continues restoring later sessions when one session restore throws", async () => {
		const failedSessionFile = join(projectDir, "failed.jsonl");
		const restoredSessionFile = join(projectDir, "restored.jsonl");
		mockState.createThrowSessionPaths = [failedSessionFile];
		mockState.prepareManifest = {
			formatVersion: 1,
			createdAt: "2026-07-07T00:00:00.000Z",
			sessions: [
				{
					activeSessionId: "failed-active",
					sessionId: "failed-session",
					sessionFile: failedSessionFile,
					cwd: projectDir,
					config: { cwd: projectDir, agentDir },
					queue: { actions: { formatVersion: 1, actions: [] }, nextTurn: [] },
					shouldResume: true,
					wasStreaming: true,
					wasCompacting: false,
					wasBashRunning: false,
					hadRunningRlmChildren: false,
					wasRetrying: false,
					hadAcceptedPromptInFlight: false,
				},
				{
					activeSessionId: "restored-active",
					sessionId: "restored-session",
					sessionFile: restoredSessionFile,
					cwd: projectDir,
					config: { cwd: projectDir, agentDir },
					queue: { actions: { formatVersion: 1, actions: [] }, nextTurn: [] },
					shouldResume: true,
					wasStreaming: true,
					wasCompacting: false,
					wasBashRunning: false,
					hadRunningRlmChildren: false,
					wasRetrying: false,
					hadAcceptedPromptInFlight: false,
				},
			],
		};
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(performUpdateAndRunCoordinator()).resolves.toBeUndefined();

			expect(
				mockState.requestPayloads
					.filter((request) => request.type === "create")
					.map((request) => request.sessionPath),
			).toEqual([failedSessionFile, restoredSessionFile]);
			expect(
				mockState.requestPayloads.some(
					(request) => request.type === "prompt" && request.activeSessionId === "restored-active",
				),
			).toBe(true);
			expect(mockState.lastCoordinatorStatus?.counts).toEqual({
				total: 2,
				restored: 1,
				resumed: 1,
				failed: 1,
			});
			expect(mockState.lastCoordinatorStatus?.failures).toEqual([
				{ sessionFile: failedSessionFile, message: "create failed" },
			]);
		} finally {
			errorSpy.mockRestore();
			logSpy.mockRestore();
		}
	});

	it("restores subagent runtime metadata under the recreated parent session", async () => {
		const parentSessionFile = join(projectDir, "parent.jsonl");
		const childSessionFile = join(projectDir, "child.jsonl");
		mockState.createActiveSessionIds = ["new-parent", "new-child"];
		mockState.prepareManifest = {
			formatVersion: 1,
			createdAt: "2026-07-07T00:00:00.000Z",
			sessions: [
				{
					activeSessionId: "old-parent",
					sessionId: "parent-session",
					sessionFile: parentSessionFile,
					cwd: projectDir,
					config: { cwd: projectDir, agentDir },
					runtimeMetadata: { kind: "top-level", createdAt: 1 },
					queue: { actions: { formatVersion: 1, actions: [] }, nextTurn: [] },
					shouldResume: false,
					wasStreaming: false,
					wasCompacting: false,
					wasBashRunning: false,
					hadRunningRlmChildren: false,
					wasRetrying: false,
					hadAcceptedPromptInFlight: false,
				},
				{
					activeSessionId: "old-child",
					sessionId: "child-session",
					sessionFile: childSessionFile,
					cwd: projectDir,
					config: { cwd: projectDir, agentDir },
					runtimeMetadata: {
						kind: "subagent",
						createdAt: 2,
						parentActiveSessionId: "old-parent",
						parentSessionId: "parent-session",
						parentSessionFile,
						rlmChildId: "child-1",
						prompt: "child task",
					},
					queue: { actions: { formatVersion: 1, actions: [] }, nextTurn: [] },
					shouldResume: false,
					wasStreaming: false,
					wasCompacting: false,
					wasBashRunning: false,
					hadRunningRlmChildren: false,
					wasRetrying: false,
					hadAcceptedPromptInFlight: false,
				},
			],
		};
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(performUpdateAndRunCoordinator()).resolves.toBeUndefined();

			const createRequests = mockState.requestPayloads.filter((request) => request.type === "create");
			expect(createRequests).toHaveLength(2);
			expect(createRequests[0]).toMatchObject({
				sessionPath: parentSessionFile,
				runtimeMetadata: { kind: "top-level", createdAt: 1 },
			});
			expect(createRequests[1]).toMatchObject({
				sessionPath: childSessionFile,
				runtimeMetadata: {
					kind: "subagent",
					createdAt: 2,
					parentActiveSessionId: "new-parent",
					parentSessionId: "parent-session",
					parentSessionFile,
					rlmChildId: "child-1",
					prompt: "child task",
				},
			});
		} finally {
			errorSpy.mockRestore();
			logSpy.mockRestore();
		}
	});

	it("rejects malformed recovery actions while parsing the manifest", async () => {
		const manifest = createAcceptedRecoveryManifest();
		const session = manifest.sessions[0]!;
		const action = session.queue.actions.actions[0]!;
		const incompleteExecutionPolicy = createMockTurnExecutionPolicy();
		delete incompleteExecutionPolicy.nextTurnContextTiming;
		const cases: { name: string; action: MockRecoveryAction }[] = [
			{
				name: "turn without primary record",
				action: { ...action, payload: { ...action.payload, records: [] } },
			},
			{
				name: "non-array images",
				action: { ...action, payload: { ...action.payload, images: {} } },
			},
			{
				name: "turn execution policy missing next-turn context timing",
				action: {
					...action,
					payload: { ...action.payload, executionPolicy: incompleteExecutionPolicy },
				},
			},
			{
				name: "unknown session command",
				action: {
					...action,
					payload: {
						kind: "session_command",
						text: "/bogus",
						command: { name: "bogus", args: "", text: "/bogus" },
					},
				},
			},
		];

		for (const testCase of cases) {
			mockState.prepareResponse = {
				success: true,
				data: {
					...manifest,
					sessions: [
						{
							...session,
							queue: { ...session.queue, actions: { formatVersion: 1, actions: [testCase.action] } },
						},
					],
				},
			};
			await expect(prepareDaemonUpdateRestart(mockState.socketPath, agentDir), testCase.name).rejects.toThrow(
				"Daemon update restart response is missing session actions",
			);
		}
	});

	it("preserves complete queued actions and rejects unknown recovery formats", async () => {
		const customMessage: MockCustomMessage = {
			role: "custom",
			customType: "heartbeat_prompt",
			content: "heartbeat body",
			display: true,
			timestamp: Date.now(),
		};
		const selectedSkillRef = {
			sessionId: "session-1",
			sessionFile: join(projectDir, "session.jsonl"),
			entryId: "selected-skill-1",
		};
		const recoveredAction: MockRecoveryAction = {
			id: "action-1",
			source: "internal",
			delivery: "when_run_idle",
			wake: "external_resume",
			queueKey: "heartbeat:job-1",
			agentMessageId: "agentmsg_followup",
			payload: {
				kind: "turn",
				text: "heartbeat body",
				selectedSkillRef,
				customMessage,
				records: [
					{
						id: "action-1-primary",
						role: "primary",
						message: customMessage,
						ownerActionId: "action-1",
					},
				],
				executionPolicy: createMockTurnExecutionPolicy(),
				queueVisible: true,
				acceptedAgentMessage: false,
				acceptedBeforeCompletion: false,
			},
		};
		mockState.prepareManifest = {
			formatVersion: 1,
			createdAt: "2026-07-07T00:00:00.000Z",
			sessions: [
				{
					activeSessionId: "old-active",
					sessionId: "session-1",
					sessionFile: join(projectDir, "session.jsonl"),
					cwd: projectDir,
					config: { cwd: projectDir, agentDir },
					queue: { actions: { formatVersion: 2, actions: [recoveredAction] }, nextTurn: [] },
					shouldResume: true,
					wasStreaming: false,
					wasCompacting: false,
					wasBashRunning: false,
					hadRunningRlmChildren: false,
					wasRetrying: false,
					hadAcceptedPromptInFlight: false,
				},
			],
		};
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(performUpdateAndRunCoordinator()).resolves.toBeUndefined();
			expect(mockState.requestPayloads).toContainEqual({
				type: "restore_actions",
				activeSessionId: "restored-active",
				snapshot: { formatVersion: 2, actions: [recoveredAction] },
			});
			// The actual restart parser must reject an invalid ref and must not downgrade a binding to format 1.
			const session = mockState.prepareManifest.sessions[0]!;
			mockState.prepareResponse = {
				success: true,
				data: {
					...mockState.prepareManifest,
					sessions: [
						{
							...session,
							queue: {
								...session.queue,
								actions: {
									formatVersion: 2,
									actions: [
										{
											...recoveredAction,
											payload: {
												...recoveredAction.payload,
												selectedSkillRef: { ...selectedSkillRef, entryId: 7 },
											},
										},
									],
								},
							},
						},
					],
				},
			};
			await expect(prepareDaemonUpdateRestart(mockState.socketPath, agentDir)).rejects.toThrow(
				"Daemon update restart response is missing session actions",
			);
			mockState.prepareResponse = {
				success: true,
				data: {
					...mockState.prepareManifest,
					sessions: [
						{
							...session,
							queue: {
								...session.queue,
								actions: {
									formatVersion: 1,
									actions: [recoveredAction],
								},
							},
						},
					],
				},
			};
			await expect(prepareDaemonUpdateRestart(mockState.socketPath, agentDir)).rejects.toThrow(
				"Daemon update restart response is missing session actions",
			);
			mockState.prepareResponse = {
				success: true,
				data: { ...mockState.prepareManifest, formatVersion: 2 },
			};
			await expect(prepareDaemonUpdateRestart(mockState.socketPath, agentDir)).rejects.toThrow(
				"Unsupported daemon update restart format version: 2",
			);
		} finally {
			errorSpy.mockRestore();
			logSpy.mockRestore();
		}
	});

	it("resumes restored queued work when continuation replay fails", async () => {
		mockState.promptFailures = 1;
		const recoveredAction: MockRecoveryAction = {
			id: "action-queued",
			source: "internal",
			delivery: "when_run_idle",
			wake: "external_resume",
			agentMessageId: "agentmsg_followup",
			payload: {
				kind: "turn",
				text: "queued follow-up",
				records: [
					{
						id: "action-queued-primary",
						role: "primary",
						message: { role: "user", content: "queued follow-up", timestamp: 1 },
						ownerActionId: "action-queued",
					},
				],
				executionPolicy: createMockTurnExecutionPolicy(),
				queueVisible: true,
				acceptedAgentMessage: false,
				acceptedBeforeCompletion: false,
			},
		};
		mockState.prepareManifest = {
			formatVersion: 1,
			createdAt: "2026-07-07T00:00:00.000Z",
			sessions: [
				{
					activeSessionId: "old-active",
					sessionId: "session-1",
					sessionFile: join(projectDir, "session.jsonl"),
					cwd: projectDir,
					config: { cwd: projectDir, agentDir },
					queue: { actions: { formatVersion: 1, actions: [recoveredAction] }, nextTurn: [] },
					shouldResume: true,
					wasStreaming: false,
					wasCompacting: false,
					wasBashRunning: false,
					hadRunningRlmChildren: false,
					wasRetrying: false,
					hadAcceptedPromptInFlight: true,
				},
			],
		};
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(performUpdateAndRunCoordinator()).resolves.toBeUndefined();
			expect(mockState.requestPayloads.some((request) => request.type === "restore_actions")).toBe(true);
			expect(mockState.requestPayloads.some((request) => request.type === "resume_queue")).toBe(true);
		} finally {
			errorSpy.mockRestore();
			logSpy.mockRestore();
		}
	});
});
