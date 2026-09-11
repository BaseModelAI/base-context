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
import { APP_NAME } from "../config.js";
import { readSessionInfo, SessionManager } from "../core/session-manager.js";
import { type PackageSource, type Settings, SettingsManager } from "../core/settings-manager.js";
import { assertProductStatePath } from "../runtime-paths.js";

const COVERAGE = [
	"Input must be an externally produced coherent offline/filesystem export; this command does not create a live snapshot or detect every custom live root.",
	"Only supported flat sessions/*.jsonl legacy journals are imported. Native-framed inputs, nested/external session directories and artifact/reference remapping are unsupported.",
	"Scheduling/daemon/runtime files, credentials, models.json and executable/instruction paths are excluded; originals are retained.",
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
	const journals: Array<{ path: string; cwd: string; preparedEntries: number }> = [];
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
			journals.push({ path, cwd: info.cwd, preparedEntries: preview.preparedEntryCount });
		}
	}
	const report = {
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
		for (const journal of journals) {
			// Import reopens its held source and enforces the input format there, not just in preview.
			const manager = await SessionManager.importRetainedFrom(
				journal.path,
				journal.cwd,
				join(staging, "sessions"),
				undefined,
				"legacy-jsonl",
			);
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
