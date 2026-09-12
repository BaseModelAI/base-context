import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { APP_NAME, getAgentDir } from "../config.js";
import {
	type AgentCronJob,
	AgentCronJobStore,
	formatAgentCronJob,
	isAgentCronJob,
	SESSION_SCHEDULED_JOBS_FILENAME,
} from "../core/cron-jobs.js";
import { readSessionInfo, SessionManager } from "../core/session-manager.js";
import { type PackageSource, type Settings, SettingsManager } from "../core/settings-manager.js";
import { assertProductStatePath } from "../runtime-paths.js";

const COVERAGE = [
	"Input must be an externally produced coherent offline/filesystem export; this command does not create a live snapshot or detect every custom live root.",
	"Only supported flat sessions/*.jsonl legacy journals are imported. Native-framed inputs, nested/external session directories and artifact/reference remapping are unsupported.",
	"Matched active/paused top-level cron, user-heartbeat and recurring RLM-heartbeat declarations are imported PAUSED into per-session schedule files, without pending dispatches. Duplicate/ambiguous, completed/cancelled, subagent, unmatched and one-shot RLM schedules are skipped.",
	"Daemon/runtime files, credentials, models.json and executable/instruction paths are excluded; originals are retained. Schedule prompts remain unexecuted data, not secret-scrubbed text.",
	"Use BASE_CONTEXT_HOME=<destination> base-context schedule list --offline to list metadata without a daemon. Generic cron resume is not added; one-shot jobs require explicit rescheduling, and heartbeat resume remains an explicit existing runtime action from the newly bound session using the new job ID; old job handles and kernel state are not restored.",
	"Session history is not scrubbed and may influence future model context. Imported package declarations remain inactive until explicit install.",
	"Historical goals remain as retained history, but goal restore excludes retained-import goals. Explicit new goals and autonomy remain available.",
	"This is not full migration, trusted runtime resume, provider-lineage restoration or binary/schema rollback.",
];
const STRING_PREFS = ["defaultProvider", "defaultModel", "theme"] as const;
const TERMINAL_PREFS = ["showImages", "showTerminalProgress"] as const;
const EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const RESOURCE_FILTERS = ["extensions", "skills", "prompts", "themes"] as const;

function record(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function within(path: string, parent: string): boolean {
	const rel = relative(parent, path);
	return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

function canonicalTarget(path: string): string {
	return existsSync(path) ? realpathSync(path) : join(canonicalTarget(dirname(path)), basename(path));
}

function safePackageSource(source: string): boolean {
	if (/^npm:(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[a-zA-Z0-9.*~^+_-]+)?$/.test(source)) return true;
	if (!source.startsWith("git:https://") && !source.startsWith("https://")) return false;
	try {
		const url = new URL(source.replace(/^git:/, ""));
		return Boolean(
			url.hostname &&
				url.pathname !== "/" &&
				!url.username &&
				!url.password &&
				!url.search &&
				!url.hash &&
				source.trim() === source,
		);
	} catch {
		return false;
	}
}

function projectSettings(sourceRoot: string) {
	let source: Record<string, unknown> = {};
	const path = join(sourceRoot, "settings.json");
	if (existsSync(path)) {
		try {
			const stat = lstatSync(path);
			if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Not a plain file");
			const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
			if (!record(parsed)) throw new Error("Not an object");
			source = parsed;
		} catch (cause) {
			throw new Error("Cannot read plain offline settings JSON; no destination was created", { cause });
		}
	}
	const preferences: Partial<Settings> = {};
	for (const key of STRING_PREFS) {
		const value = source[key];
		const allowed = key === "theme" ? /^[a-zA-Z0-9_-]+$/ : /^[a-zA-Z0-9_./:+-]+$/;
		if (typeof value === "string" && allowed.test(value)) preferences[key] = value;
	}
	if (typeof source.quietStartup === "boolean") preferences.quietStartup = source.quietStartup;
	if (record(source.terminal)) {
		const terminal: NonNullable<Settings["terminal"]> = {};
		for (const key of TERMINAL_PREFS) {
			const value = source.terminal[key];
			if (typeof value === "boolean") terminal[key] = value;
		}
		if (Object.keys(terminal).length > 0) preferences.terminal = terminal;
	}
	const effort = source.defaultThinkingLevel;
	if (typeof effort === "string" && EFFORTS.some((level) => level === effort))
		preferences.defaultThinkingLevel = effort as (typeof EFFORTS)[number];
	const inactivePackages: PackageSource[] = [];
	let skippedPackages = source.packages !== undefined && !Array.isArray(source.packages) ? 1 : 0;
	for (const pkg of Array.isArray(source.packages) ? source.packages : []) {
		const sourceValue = typeof pkg === "string" ? pkg : record(pkg) ? pkg.source : undefined;
		const filtersValid =
			typeof pkg === "string" ||
			(record(pkg) &&
				Object.keys(pkg).every((key) => key === "source" || RESOURCE_FILTERS.some((kind) => kind === key)) &&
				RESOURCE_FILTERS.every(
					(key) =>
						pkg[key] === undefined ||
						(Array.isArray(pkg[key]) && pkg[key].every((value) => typeof value === "string")),
				));
		if (typeof sourceValue !== "string" || !safePackageSource(sourceValue) || !filtersValid) {
			skippedPackages++;
			continue;
		}
		if (typeof pkg === "string") inactivePackages.push(pkg);
		else {
			const filtered: Exclude<PackageSource, string> = { source: sourceValue };
			for (const key of RESOURCE_FILTERS) if (Array.isArray(pkg[key])) filtered[key] = [...pkg[key]];
			inactivePackages.push(filtered);
		}
	}
	return {
		preferences,
		inactivePackages,
		skippedPackages,
		skippedSettings: Object.keys(source).filter((key) => key !== "packages" && !(key in preferences)).length,
	};
}

interface OfflineJournal {
	path: string;
	id: string;
	rlmDepth: number;
	cwd: string;
	preparedEntries: number;
}

function plainDirectory(path: string): void {
	const stat = lstatSync(path);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Schedule data requires plain directories");
}

function plainScheduleFile(path: string): void {
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Schedule data requires plain files");
}

function safeSessionId(id: string): boolean {
	return id.length > 0 && id !== "." && id !== ".." && !/[\\/]/.test(id);
}

function preparePausedSchedules(sourceRoot: string, journals: readonly OfflineJournal[]) {
	const candidates: Array<{ value: unknown; ownerId?: string }> = [];
	const read = (path: string, ownerId?: string) => {
		if (!existsSync(path)) return;
		try {
			plainScheduleFile(path);
			const value: unknown = JSON.parse(readFileSync(path, "utf8"));
			if (!record(value) || !Array.isArray(value.jobs)) throw new Error("Expected jobs array");
			for (const job of value.jobs) candidates.push({ value: job, ownerId });
		} catch (cause) {
			throw new Error("Cannot prepare offline schedule data; no destination was created", { cause });
		}
	};
	read(join(sourceRoot, "cron-jobs.json"));
	const artifacts = join(sourceRoot, "session-artifacts");
	if (existsSync(artifacts)) {
		plainDirectory(artifacts);
		for (const id of new Set(journals.map((journal) => journal.id).filter(safeSessionId))) {
			const directory = join(artifacts, id);
			if (!existsSync(directory)) continue;
			plainDirectory(directory);
			read(join(directory, SESSION_SCHEDULED_JOBS_FILENAME), id);
		}
	}
	const idCounts = new Map<string, number>();
	for (const { value } of candidates) {
		if (record(value) && typeof value.id === "string") idCounts.set(value.id, (idCounts.get(value.id) ?? 0) + 1);
	}
	const byPath = new Map<string, AgentCronJob[]>();
	let skippedSchedules = 0;
	for (const { value, ownerId } of candidates) {
		if (
			!isAgentCronJob(value) ||
			!value.id ||
			idCounts.get(value.id) !== 1 ||
			(value.status !== "active" && value.status !== "paused") ||
			(value.source === "rlm_heartbeat" && value.schedule.kind === "once") ||
			value.runtimeKind === "subagent"
		) {
			skippedSchedules++;
			continue;
		}
		const matches = journals.filter((journal) => journal.id === value.sessionId);
		const target = matches.length === 1 ? matches[0] : undefined;
		if (
			!target ||
			target.rlmDepth !== 0 ||
			!safeSessionId(target.id) ||
			(ownerId !== undefined && ownerId !== target.id) ||
			basename(value.sessionFile) !== basename(target.path)
		) {
			skippedSchedules++;
			continue;
		}
		const jobs = byPath.get(target.path) ?? [];
		jobs.push(value);
		byPath.set(target.path, jobs);
	}
	for (const [path, jobs] of byPath) {
		if (jobs.filter((job) => job.source === "heartbeat").length > 1) {
			skippedSchedules += jobs.filter((job) => job.source === "heartbeat").length;
			byPath.set(
				path,
				jobs.filter((job) => job.source !== "heartbeat"),
			);
		}
	}
	return {
		byPath,
		skippedSchedules,
		pausedSchedules: [...byPath.values()].reduce((total, jobs) => total + jobs.length, 0),
	};
}

/** Metadata-only offline listing uses the selected product root, without a daemon connection. */
export function runOfflineScheduleList(args: string[]): void {
	if (
		args[0] !== "list" ||
		!args.includes("--offline") ||
		args.slice(1).some((arg) => !["--offline", "--all", "-a", "--json"].includes(arg))
	)
		throw new Error(`Usage: ${APP_NAME} schedule list --offline [--all] [--json] (root: BASE_CONTEXT_HOME)`);
	const root = assertProductStatePath(getAgentDir());
	const artifacts = join(root, "session-artifacts");
	const store = AgentCronJobStore.forSessionArtifacts();
	if (existsSync(artifacts)) {
		plainDirectory(artifacts);
		for (const entry of readdirSync(artifacts, { withFileTypes: true })) {
			if (entry.isSymbolicLink()) throw new Error("Offline schedule listing does not follow symlinks");
			if (!entry.isDirectory()) continue;
			const path = join(artifacts, entry.name, SESSION_SCHEDULED_JOBS_FILENAME);
			if (!existsSync(path)) continue;
			plainScheduleFile(path);
			store.registerSessionArtifact(entry.name, join(artifacts, entry.name));
		}
	}
	const jobs = store
		.list()
		.filter(
			(job) => args.includes("--all") || args.includes("-a") || job.status === "active" || job.status === "paused",
		);
	// Keep retained free text in the file, not migration/listing reports. No claim of secret-scrubbed history.
	const listed = jobs.map(
		(job): AgentCronJob => ({
			id: job.id,
			status: job.status,
			source: job.source,
			runtimeKind: job.runtimeKind,
			deliveryMode: job.deliveryMode,
			activeSessionId: job.activeSessionId,
			sessionId: job.sessionId,
			sessionFile: job.sessionFile,
			cwd: job.cwd,
			createdAt: job.createdAt,
			updatedAt: job.updatedAt,
			nextRunAt: job.nextRunAt,
			lastRunAt: job.lastRunAt,
			lastSkippedAt: job.lastSkippedAt,
			runCount: job.runCount,
			prompt: "[retained instruction not displayed]",
			schedule: {
				kind: job.schedule.kind,
				expression: `[${job.schedule.kind}; retained expression not displayed]`,
				intervalMs:
					job.schedule.kind === "interval" &&
					typeof job.schedule.intervalMs === "number" &&
					Number.isFinite(job.schedule.intervalMs) &&
					job.schedule.intervalMs > 0
						? job.schedule.intervalMs
						: undefined,
			},
		}),
	);
	if (args.includes("--json")) console.log(JSON.stringify({ jobs: listed }, null, 2));
	else if (listed.length === 0) console.log("No scheduled prompts.");
	else for (const job of listed) console.log(formatAgentCronJob(job));
}

/** Import supplied data only. Never attach to the legacy daemon or start a runtime. */
export async function runProductMigration(args: string[]): Promise<void> {
	const usage = `Usage: ${APP_NAME} migrate --from-prime-agent <offline-export-root> [--dry-run] [--destination <new-root>]`;
	let sourceArg: string | undefined;
	let destinationArg: string | undefined;
	let dryRun = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--dry-run" && !dryRun) dryRun = true;
		else if (
			(arg === "--from-prime-agent" && sourceArg === undefined) ||
			(arg === "--destination" && destinationArg === undefined)
		) {
			const value = args[++i];
			if (!value || value.startsWith("--")) throw new Error(usage);
			if (arg === "--from-prime-agent") sourceArg = value;
			else destinationArg = value;
		} else throw new Error(usage);
	}
	if (!sourceArg || (!dryRun && !destinationArg)) throw new Error(usage);
	const input = resolve(sourceArg);
	const inputStat = lstatSync(input);
	if (!inputStat.isDirectory() || inputStat.isSymbolicLink())
		throw new Error("Offline export root must be a plain directory");
	const sourceRoot = realpathSync(input);
	for (const legacy of [
		join(homedir(), ".prime", "agent"),
		join(homedir(), ".pi", "agent"),
		join(homedir(), ".prime-context"),
	]) {
		const knownRoot = canonicalTarget(legacy);
		if (within(sourceRoot, knownRoot) || within(knownRoot, sourceRoot))
			throw new Error("Refusing a standard/live Prime root; supply a separate coherent offline export");
	}
	const destination = destinationArg ? assertProductStatePath(canonicalTarget(resolve(destinationArg))) : undefined;
	if (destination && (existsSync(destination) || within(destination, sourceRoot) || within(sourceRoot, destination)))
		throw new Error(
			"Destination must be new and separate from the offline export; no merge or overwrite is supported",
		);
	const projected = projectSettings(sourceRoot);
	const sessionsDir = join(sourceRoot, "sessions");
	const journals: OfflineJournal[] = [];
	let skippedSessionEntries = 0;
	if (existsSync(sessionsDir)) {
		const stat = lstatSync(sessionsDir);
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Offline sessions must be a plain directory");
		for (const file of readdirSync(sessionsDir, { withFileTypes: true }).sort((a, b) =>
			a.name.localeCompare(b.name),
		)) {
			if (file.isSymbolicLink()) throw new Error("Symlink session data is unsupported; no destination was created");
			if (!file.isFile() || !file.name.endsWith(".jsonl")) {
				skippedSessionEntries++;
				continue;
			}
			const path = join(sessionsDir, file.name);
			let info: Awaited<ReturnType<typeof readSessionInfo>>;
			let preview: Awaited<ReturnType<typeof SessionManager.previewRetainedImport>>;
			try {
				info = await readSessionInfo(path);
				if (!info || typeof info.cwd !== "string" || info.cwd.length === 0) throw new Error("Missing session cwd");
				preview = await SessionManager.previewRetainedImport(
					path,
					info.cwd,
					destination ? join(destination, "sessions") : undefined,
				);
			} catch (cause) {
				throw new Error("Offline journal preparation failed; no destination was created", { cause });
			}
			if (preview.sourceFormat !== "legacy-jsonl")
				throw new Error(
					"Whole-root migration supports legacy-jsonl only; native-framed input is unsupported and no destination was created",
				);
			journals.push({
				path,
				id: info.id,
				rlmDepth: info.rlmDepth,
				cwd: info.cwd,
				preparedEntries: preview.preparedEntryCount,
			});
		}
	}
	const schedules = preparePausedSchedules(sourceRoot, journals);
	const report = {
		pausedSchedules: schedules.pausedSchedules,
		skippedSchedules: schedules.skippedSchedules,
		mode: dryRun ? "dry-run" : "import",
		destination: destination ?? null,
		preparedSessions: journals.length,
		preparedEntries: journals.reduce((sum, item) => sum + item.preparedEntries, 0),
		settings: Object.keys(projected.preferences),
		inactivePackages: projected.inactivePackages.length,
		skippedPackages: projected.skippedPackages,
		skippedSettings: projected.skippedSettings,
		skippedSessionEntries,
		coverage: COVERAGE,
	};
	if (dryRun) {
		console.log(JSON.stringify(report, null, 2));
		return;
	}
	mkdirSync(dirname(destination!), { recursive: true });
	const staging = mkdtempSync(join(dirname(destination!), `.${basename(destination!)}.import-`));
	let activationAttempted = false;
	try {
		const settings = SettingsManager.create(staging, staging);
		const p = projected.preferences;
		if (p.defaultProvider !== undefined) settings.setDefaultProvider(p.defaultProvider);
		if (p.defaultModel !== undefined) settings.setDefaultModel(p.defaultModel);
		if (p.defaultThinkingLevel !== undefined) settings.setDefaultThinkingLevel(p.defaultThinkingLevel);
		if (p.theme !== undefined) settings.setTheme(p.theme);
		if (p.quietStartup !== undefined) settings.setQuietStartup(p.quietStartup);
		if (p.terminal?.showImages !== undefined) settings.setShowImages(p.terminal.showImages);
		if (p.terminal?.showTerminalProgress !== undefined)
			settings.setShowTerminalProgress(p.terminal.showTerminalProgress);
		settings.setPackages([], projected.inactivePackages);
		await settings.flush();
		if (settings.drainErrors().length > 0) throw new Error("Destination settings write failed");
		const scheduleStore = AgentCronJobStore.forSessionArtifacts();
		for (const journal of journals) {
			// Import reopens its held source and enforces the input format there, not just in preview.
			const manager = await SessionManager.importRetainedFrom(
				journal.path,
				journal.cwd,
				join(staging, "sessions"),
				undefined,
				"legacy-jsonl",
			);
			try {
				const jobs = schedules.byPath.get(journal.path) ?? [];
				if (jobs.length > 0) {
					scheduleStore.registerSessionArtifact(manager.getSessionId(), manager.getSessionArtifactDir()!);
					scheduleStore.importPaused(jobs, {
						sessionId: manager.getSessionId(),
						cwd: journal.cwd,
						sessionFile: join(destination!, "sessions", basename(manager.getSessionFile()!)),
					});
				}
			} catch (error) {
				try {
					await manager.close();
				} catch (cleanup) {
					throw new AggregateError([error, cleanup], "Schedule import and session close failed");
				}
				throw error;
			}
			await manager.close();
		}
		// Reserve a NEW empty target atomically; rename may replace only this owned reservation.
		mkdirSync(destination!, { mode: 0o700 });
		activationAttempted = true;
		renameSync(staging, destination!);
	} catch (cause) {
		const state = activationAttempted
			? "Activation outcome may be uncertain; do not replay"
			: "No destination was activated";
		throw new Error(`${state}. Retained staging: ${staging}. Destination: ${destination}. Source is unchanged.`, {
			cause,
		});
	}
	try {
		console.log(JSON.stringify({ ...report, activated: true, importedSessions: journals.length }, null, 2));
	} catch (cause) {
		throw new Error(`Import activated at ${destination}; reporting failed. Do not repeat the import.`, { cause });
	}
}
