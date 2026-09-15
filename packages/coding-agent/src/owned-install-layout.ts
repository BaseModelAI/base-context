import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { PRODUCT } from "./product-identity.js";

export interface OwnedInstallation {
	root: string;
	version: string;
	packageDir: string;
	runtimeDir: string;
}

export interface InstallSelection {
	generation: string;
	active: string;
	previous: string | null;
}

export const OWNED_INSTALL_MARKER = "Base-Context owned installation\n";

export function defaultInstallRoot(): string {
	return resolve(
		process.env.BASE_CONTEXT_INSTALL_ROOT ||
			join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "base-context"),
	);
}

function isVersion(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(value);
}

export function parseInstallSelection(text: string): InstallSelection | null {
	const value: unknown = JSON.parse(text);
	if (value === null) return null;
	if (
		typeof value !== "object" ||
		Array.isArray(value) ||
		!("generation" in value) ||
		typeof value.generation !== "string" ||
		!value.generation ||
		!("active" in value) ||
		!isVersion(value.active) ||
		!("previous" in value) ||
		!(value.previous === null || isVersion(value.previous))
	) {
		throw new Error("Invalid Base-Context installation selection.");
	}
	return { generation: value.generation, active: value.active, previous: value.previous };
}

export function readInstallSelection(root: string): InstallSelection | null {
	try {
		return parseInstallSelection(readFileSync(join(root, "current.json"), "utf8"));
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
		throw error;
	}
}

export function ownedVersion(root: string, version: string): OwnedInstallation {
	if (!isVersion(version)) throw new Error("Invalid Base-Context version directory.");
	const directory = join(root, "versions", version);
	return {
		root,
		version,
		packageDir: join(directory, "node_modules", PRODUCT.packageName),
		runtimeDir: join(directory, "runtime"),
	};
}

export function getOwnedInstallation(packageDir: string): OwnedInstallation | undefined {
	if (!existsSync(packageDir)) return undefined;
	const physicalPackage = realpathSync(packageDir);
	const directory = resolve(physicalPackage, "..", "..", "..");
	if (basename(dirname(directory)) !== "versions") return undefined;
	const root = dirname(dirname(directory));
	if (!existsSync(join(root, "owned"))) return undefined;
	if (readFileSync(join(root, "owned"), "utf8") !== OWNED_INSTALL_MARKER) {
		throw new Error("Unrecognized Base-Context installation owner.");
	}
	const installation = ownedVersion(root, basename(directory));
	return installation.packageDir === physicalPackage ? installation : undefined;
}

export function installedCli(installation: OwnedInstallation): string {
	return join(installation.packageDir, "dist", "bundle", "cli.js");
}
