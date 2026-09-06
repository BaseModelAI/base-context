import { lstatSync, readlinkSync, realpathSync } from "fs";
import { homedir } from "os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "path";
import { PRODUCT, PRODUCT_ENV } from "./product-identity.js";

export interface RuntimePaths {
	readonly home: string;
	readonly project: string;
	readonly sessions: string;
	readonly runtime: string;
	readonly auth: string;
	readonly daemonRegistry: string;
}

export function expandHomePath(path: string, home = homedir()): string {
	if (path === "~") return home;
	if (path.startsWith("~/")) return join(home, path.slice(2));
	return path;
}

export function readAbsolutePathEnv(
	name: string,
	env: NodeJS.ProcessEnv = process.env,
	home = homedir(),
): string | undefined {
	const value = env[name];
	if (value === undefined) return undefined;
	const expanded = expandHomePath(value, home);
	if (!value.trim() || !isAbsolute(expanded)) {
		throw new Error(`${name} must be a non-empty absolute path (~/ is supported).`);
	}
	return resolve(expanded);
}

function canonicalPath(path: string): string {
	try {
		return realpathSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	try {
		if (lstatSync(path).isSymbolicLink()) return canonicalPath(resolve(dirname(path), readlinkSync(path)));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const parent = dirname(path);
	return parent === path ? path : join(canonicalPath(parent), relative(parent, path));
}

export function assertProductStatePath(path: string, home = homedir()): string {
	const canonical = canonicalPath(resolve(path));
	for (const directory of [".prime", ".pi", ".prime-context"]) {
		const legacy = canonicalPath(join(home, directory));
		const rel = relative(legacy, canonical);
		if (
			resolve(path).split(sep).includes(directory) ||
			canonical.split(sep).includes(directory) ||
			rel === "" ||
			(rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
		) {
			throw new Error(
				`Base Context cannot write legacy state at ${path}. Choose a separate BASE_CONTEXT_HOME; use explicit import for legacy data.`,
			);
		}
	}
	return resolve(path);
}

export function resolveRuntimePaths(
	env: NodeJS.ProcessEnv = process.env,
	home = homedir(),
	cwd = process.cwd(),
): RuntimePaths {
	const root = assertProductStatePath(
		readAbsolutePathEnv(PRODUCT_ENV.home, env, home) ?? join(home, PRODUCT.configDirectory),
		home,
	);
	const sessions = assertProductStatePath(
		readAbsolutePathEnv(PRODUCT_ENV.sessions, env, home) ?? join(root, "sessions"),
		home,
	);
	return Object.freeze({
		home: root,
		project: assertProductStatePath(join(cwd, PRODUCT.configDirectory), home),
		sessions,
		runtime: assertProductStatePath(join(root, "runtime"), home),
		auth: assertProductStatePath(join(root, "auth.json"), home),
		daemonRegistry: assertProductStatePath(join(root, "daemon-supervisors"), home),
	});
}
