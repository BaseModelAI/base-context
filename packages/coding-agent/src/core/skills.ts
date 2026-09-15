import { getLogger } from "@ponythewhite/base-context-ai";
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from "fs";
import ignore from "ignore";
import { homedir } from "os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "path";
import { CONFIG_DIR_NAME, getAgentDir } from "../config.js";
import { parseFrontmatter } from "../utils/frontmatter.js";
import { canonicalizePath } from "../utils/paths.js";
import type { ResourceDiagnostic } from "./diagnostics.js";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.js";

const log = getLogger("coding-agent.skills");

/** Raw UTF-8 byte admission limits, not token or model-fit estimates. */
export const SKILL_METADATA_MAX_BYTES = 16 * 1024;
export const SKILL_FILE_MAX_BYTES = 1024 * 1024;

function captureSkillText(filePath: string, metadataOnly: boolean): string {
	const fd = openSync(filePath, "r");
	let captured: string;
	try {
		const size = fstatSync(fd, { bigint: true }).size;
		const maxBytes = metadataOnly ? SKILL_METADATA_MAX_BYTES : SKILL_FILE_MAX_BYTES;
		if (!metadataOnly && size > BigInt(maxBytes)) throw new Error("Skill file byte limit exceeded");
		const buffer = Buffer.alloc(Number(size < BigInt(maxBytes) ? size : BigInt(maxBytes)));
		let offset = 0;
		let metadataEnd: number | undefined;
		while (offset < buffer.length) {
			const count = readSync(
				fd,
				buffer,
				offset,
				Math.min(metadataOnly ? 1024 : 64 * 1024, buffer.length - offset),
				offset,
			);
			if (count === 0) throw new Error("Skill file changed during read");
			offset += count;
			if (metadataOnly) {
				const prefix = buffer.subarray(0, offset);
				if (offset >= 3 && (prefix[0] !== 45 || prefix[1] !== 45 || prefix[2] !== 45)) {
					metadataEnd = 0;
					break;
				}
				// Match parseFrontmatter's first normalized newline + --- prefix,
				// including CRLF/bare CR and a closing marker with trailing text.
				const lf = prefix.indexOf("\n---", 3);
				const cr = prefix.indexOf("\r---", 3);
				const end = lf < 0 ? cr : cr < 0 ? lf : Math.min(lf, cr);
				if (end >= 0) {
					metadataEnd = end + 4;
					break;
				}
			}
		}
		if (metadataOnly) {
			if (metadataEnd === undefined && size > BigInt(maxBytes))
				throw new Error("Skill frontmatter byte limit exceeded");
			// At most one 1 KiB chunk reads ahead. Discard body bytes, not metadata.
			captured = buffer.subarray(0, metadataEnd ?? offset).toString("utf8");
		} else {
			const after = fstatSync(fd, { bigint: true }).size;
			if (after > BigInt(maxBytes)) throw new Error("Skill file byte limit exceeded");
			if (after !== size) throw new Error("Skill file changed during read");
			captured = buffer.toString("utf8");
		}
	} catch (error) {
		try {
			closeSync(fd);
		} catch (closeError) {
			if (closeError === error) throw error;
			throw new AggregateError([error, closeError], "Skill file read and close failed", { cause: error });
		}
		throw error;
	}
	closeSync(fd);
	return captured;
}

/** Read one complete bounded capture for an explicitly selected skill. */
export function readSkillFile(filePath: string): string {
	return captureSkillText(filePath, false);
}

/** Max name length per spec */
const MAX_NAME_LENGTH = 64;

/** Max description length per spec */
const MAX_DESCRIPTION_LENGTH = 1024;

const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];

type IgnoreMatcher = ReturnType<typeof ignore>;

function toPosixPath(p: string): string {
	return p.split(sep).join("/");
}

function prefixIgnorePattern(line: string, prefix: string): string | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	if (trimmed.startsWith("#") && !trimmed.startsWith("\\#")) return null;

	let pattern = line;
	let negated = false;

	if (pattern.startsWith("!")) {
		negated = true;
		pattern = pattern.slice(1);
	} else if (pattern.startsWith("\\!")) {
		pattern = pattern.slice(1);
	}

	if (pattern.startsWith("/")) {
		pattern = pattern.slice(1);
	}

	const prefixed = prefix ? `${prefix}${pattern}` : pattern;
	return negated ? `!${prefixed}` : prefixed;
}

function addIgnoreRules(ig: IgnoreMatcher, dir: string, rootDir: string): void {
	const relativeDir = relative(rootDir, dir);
	const prefix = relativeDir ? `${toPosixPath(relativeDir)}/` : "";

	for (const filename of IGNORE_FILE_NAMES) {
		const ignorePath = join(dir, filename);
		if (!existsSync(ignorePath)) continue;
		try {
			const content = readFileSync(ignorePath, "utf-8");
			const patterns = content
				.split(/\r?\n/)
				.map((line) => prefixIgnorePattern(line, prefix))
				.filter((line): line is string => Boolean(line));
			if (patterns.length > 0) {
				ig.add(patterns);
			}
		} catch {
			// Unreadable ignore file: skip it rather than failing skill discovery.
		}
	}
}

export interface SkillFrontmatter {
	name?: string;
	description?: string;
	"disable-model-invocation"?: boolean;
	[key: string]: unknown;
}

export type SkillKind = "markdown" | "python";

export interface SkillPythonMetadata {
	importName: string;
	packagePath: string;
	pyprojectPath: string;
}

interface BaseSkill {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	sourceInfo: SourceInfo;
	disableModelInvocation: boolean;
}

export interface MarkdownSkill extends BaseSkill {
	kind: "markdown";
	python?: undefined;
}

export interface PythonSkill extends BaseSkill {
	kind: "python";
	python: SkillPythonMetadata;
}

export type Skill = MarkdownSkill | PythonSkill;

export interface PythonSkillRuntimeInfo extends SkillPythonMetadata {
	name: string;
}

export interface LoadSkillsResult {
	skills: Skill[];
	diagnostics: ResourceDiagnostic[];
}

/**
 * Validate skill name per Agent Skills spec.
 * Returns array of validation error messages (empty if valid).
 */
function validateName(name: string, parentDirName: string): string[] {
	const errors: string[] = [];

	if (name !== parentDirName) {
		errors.push(`name "${name}" does not match parent directory "${parentDirName}"`);
	}

	if (name.length > MAX_NAME_LENGTH) {
		errors.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`);
	}

	if (!/^[a-z0-9-]+$/.test(name)) {
		errors.push(`name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)`);
	}

	if (name.startsWith("-") || name.endsWith("-")) {
		errors.push(`name must not start or end with a hyphen`);
	}

	if (name.includes("--")) {
		errors.push(`name must not contain consecutive hyphens`);
	}

	return errors;
}

/**
 * Validate description per Agent Skills spec.
 */
function validateDescription(description: string | undefined): string[] {
	const errors: string[] = [];

	if (!description || description.trim() === "") {
		errors.push("description is required");
	} else if (description.length > MAX_DESCRIPTION_LENGTH) {
		errors.push(`description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`);
	}

	return errors;
}

export interface LoadSkillsFromDirOptions {
	/** Directory to scan for skills */
	dir: string;
	/** Source identifier for these skills */
	source: string;
}

function createSkillSourceInfo(filePath: string, baseDir: string, source: string): SourceInfo {
	switch (source) {
		case "user":
			return createSyntheticSourceInfo(filePath, {
				source: "local",
				scope: "user",
				baseDir,
			});
		case "project":
			return createSyntheticSourceInfo(filePath, {
				source: "local",
				scope: "project",
				baseDir,
			});
		case "path":
			return createSyntheticSourceInfo(filePath, {
				source: "local",
				baseDir,
			});
		default:
			return createSyntheticSourceInfo(filePath, { source, baseDir });
	}
}

function pythonImportNameForSkill(name: string): string {
	return name.replaceAll("-", "_");
}

function isValidPythonImportName(name: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

function detectPythonSkill(
	skillDir: string,
	name: string,
	diagnostics: ResourceDiagnostic[],
): SkillPythonMetadata | null {
	const pyprojectPath = join(skillDir, "pyproject.toml");
	if (!existsSync(pyprojectPath)) {
		return null;
	}

	try {
		if (!statSync(pyprojectPath).isFile()) {
			return null;
		}
	} catch {
		return null;
	}

	const importName = pythonImportNameForSkill(name);
	if (!isValidPythonImportName(importName)) {
		diagnostics.push({
			type: "warning",
			message: `python skill import name "${importName}" is invalid`,
			path: pyprojectPath,
		});
		return null;
	}

	const packageInitPath = join(skillDir, "src", importName, "__init__.py");
	try {
		if (!statSync(packageInitPath).isFile()) {
			diagnostics.push({
				type: "warning",
				message: `python skill package src/${importName}/__init__.py not found`,
				path: pyprojectPath,
			});
			return null;
		}
	} catch {
		diagnostics.push({
			type: "warning",
			message: `python skill package src/${importName}/__init__.py not found`,
			path: pyprojectPath,
		});
		return null;
	}

	return {
		importName,
		packagePath: skillDir,
		pyprojectPath,
	};
}

export function getPythonSkillRuntimeInfo(skills: readonly Skill[]): PythonSkillRuntimeInfo[] {
	return skills
		.filter((skill): skill is PythonSkill => skill.kind === "python")
		.map((skill) => ({
			name: skill.name,
			importName: skill.python.importName,
			packagePath: skill.python.packagePath,
			pyprojectPath: skill.python.pyprojectPath,
		}));
}

/**
 * Load skills from a directory.
 *
 * Discovery rules:
 * - if a directory contains SKILL.md, treat it as a skill root and do not recurse further
 * - otherwise, load direct .md children in the root
 * - recurse into subdirectories to find SKILL.md
 */
export function loadSkillsFromDir(options: LoadSkillsFromDirOptions): LoadSkillsResult {
	const { dir, source } = options;
	return loadSkillsFromDirInternal(dir, source, true);
}

function loadSkillsFromDirInternal(
	dir: string,
	source: string,
	includeRootFiles: boolean,
	ignoreMatcher?: IgnoreMatcher,
	rootDir?: string,
): LoadSkillsResult {
	const skills: Skill[] = [];
	const diagnostics: ResourceDiagnostic[] = [];

	if (!existsSync(dir)) {
		return { skills, diagnostics };
	}

	const root = rootDir ?? dir;
	const ig = ignoreMatcher ?? ignore();
	addIgnoreRules(ig, dir, root);

	try {
		const entries = readdirSync(dir, { withFileTypes: true });

		for (const entry of entries) {
			if (entry.name !== "SKILL.md") {
				continue;
			}

			const fullPath = join(dir, entry.name);

			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					isFile = statSync(fullPath).isFile();
				} catch {
					continue;
				}
			}

			const relPath = toPosixPath(relative(root, fullPath));
			if (!isFile || ig.ignores(relPath)) {
				continue;
			}

			const result = loadSkillFromFile(fullPath, source);
			if (result.skill) {
				skills.push(result.skill);
			}
			diagnostics.push(...result.diagnostics);
			return { skills, diagnostics };
		}

		for (const entry of entries) {
			if (entry.name.startsWith(".")) {
				continue;
			}

			if (entry.name === "node_modules") {
				continue;
			}

			const fullPath = join(dir, entry.name);

			let isDirectory = entry.isDirectory();
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					const stats = statSync(fullPath);
					isDirectory = stats.isDirectory();
					isFile = stats.isFile();
				} catch {
					continue;
				}
			}

			const relPath = toPosixPath(relative(root, fullPath));
			const ignorePath = isDirectory ? `${relPath}/` : relPath;
			if (ig.ignores(ignorePath)) {
				continue;
			}

			if (isDirectory) {
				const subResult = loadSkillsFromDirInternal(fullPath, source, false, ig, root);
				skills.push(...subResult.skills);
				diagnostics.push(...subResult.diagnostics);
				continue;
			}

			if (!isFile || !includeRootFiles || !entry.name.endsWith(".md")) {
				continue;
			}

			const result = loadSkillFromFile(fullPath, source);
			if (result.skill) {
				skills.push(result.skill);
			}
			diagnostics.push(...result.diagnostics);
		}
	} catch (error) {
		log.warn("skill directory scan failed", {
			dir,
			error: error instanceof Error ? error.message : String(error),
		});
	}

	return { skills, diagnostics };
}

function loadSkillFromFile(
	filePath: string,
	source: string,
): { skill: Skill | null; diagnostics: ResourceDiagnostic[] } {
	const diagnostics: ResourceDiagnostic[] = [];

	try {
		const rawContent = captureSkillText(filePath, true);
		const { frontmatter } = parseFrontmatter<SkillFrontmatter>(rawContent);
		const skillDir = dirname(filePath);
		const parentDirName = basename(skillDir);

		const descErrors = validateDescription(frontmatter.description);
		for (const error of descErrors) {
			diagnostics.push({ type: "warning", message: error, path: filePath });
		}

		const name = frontmatter.name || parentDirName;

		const nameErrors = validateName(name, parentDirName);
		for (const error of nameErrors) {
			diagnostics.push({ type: "warning", message: error, path: filePath });
		}

		if (!frontmatter.description || frontmatter.description.trim() === "") {
			return { skill: null, diagnostics };
		}

		const python = basename(filePath) === "SKILL.md" ? detectPythonSkill(skillDir, name, diagnostics) : null;
		const baseSkill: BaseSkill = {
			name,
			description: frontmatter.description,
			filePath,
			baseDir: skillDir,
			sourceInfo: createSkillSourceInfo(filePath, skillDir, source),
			disableModelInvocation: frontmatter["disable-model-invocation"] === true,
		};

		return {
			skill: python ? { ...baseSkill, kind: "python", python } : { ...baseSkill, kind: "markdown" },
			diagnostics,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : "failed to parse skill file";
		diagnostics.push({ type: "warning", message, path: filePath });
		return { skill: null, diagnostics };
	}
}

/** Admission limits for the rendered catalog only, not the whole system prompt. */
export const SKILL_CATALOG_MAX_ITEMS = 32;
export const SKILL_CATALOG_MAX_BYTES = 65536;

/**
 * Format skills for inclusion in a system prompt.
 * Uses XML format per Agent Skills standard.
 * See: https://agentskills.io/integrate-skills
 *
 * Skills with disableModelInvocation=true are excluded from the prompt
 * (they can only be invoked explicitly via /skill:name commands).
 */
export function formatSkillsForPrompt(skills: Skill[], nativeSelection = false): string {
	const visibleSkills: Skill[] = [];
	for (const skill of skills) {
		if (skill.disableModelInvocation) continue;
		if (visibleSkills.length === SKILL_CATALOG_MAX_ITEMS) throw new Error("Skill catalog item limit exceeded");
		visibleSkills.push(skill);
	}

	if (visibleSkills.length === 0) {
		return "";
	}

	const lines = [
		"\n\nThe following skills provide specialized instructions for specific tasks.",
		nativeSelection
			? 'Select a matching skill with the prime_context tool using {"action":"skill","name":"..."}. Re-read the returned canonical ref with action="read"; do not reopen its mutable location. A selected version is frozen for its committed epoch. A later accepted epoch permits a new selection.'
			: "Use ipython to inspect a skill's file when the task matches its description.",
		"Skills with a python_import are prepared in the persistent Python kernel when available and can be called directly by that import name.",
		"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
		"",
		"<available_skills>",
	];

	let renderedBytes = lines.reduce((bytes, line, index) => bytes + Buffer.byteLength(line) + (index ? 1 : 0), 0);
	const appendLine = (line: string): void => {
		const bytes = Buffer.byteLength(line) + 1;
		if (bytes > SKILL_CATALOG_MAX_BYTES - renderedBytes) throw new Error("Skill catalog byte limit exceeded");
		renderedBytes += bytes;
		lines.push(line);
	};
	const appendField = (tag: string, value: string, escapeValue = true): void => {
		const prefix = `    <${tag}>`;
		const suffix = `</${tag}>`;
		const available = SKILL_CATALOG_MAX_BYTES - renderedBytes - 1 - Buffer.byteLength(prefix + suffix);
		const captured = escapeValue ? escapeXml(value, available) : value;
		if (captured.length > available || Buffer.byteLength(captured) > available)
			throw new Error("Skill catalog byte limit exceeded");
		appendLine(prefix + captured + suffix);
	};

	for (const skill of visibleSkills) {
		appendLine("  <skill>");
		appendField("name", skill.name);
		appendField("type", skill.kind, false);
		if (skill.kind === "python") {
			appendField("python_import", skill.python.importName);
		}
		appendField("description", skill.description);
		appendField("location", skill.filePath);
		appendLine("  </skill>");
	}

	appendLine("</available_skills>");

	return lines.join("\n");
}

function escapeXml(str: string, maxBytes: number): string {
	// UTF-8 and XML escaping cannot use fewer bytes than the UTF-16 code-unit count.
	if (str.length > maxBytes) throw new Error("Skill catalog byte limit exceeded");
	let bytes = Buffer.byteLength(str);
	if (bytes > maxBytes) throw new Error("Skill catalog byte limit exceeded");
	const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
	return str.replace(/[&<>"']/g, (character) => {
		const escaped = entities[character]!;
		bytes += escaped.length - 1;
		// Reject before the replacement can assemble an over-budget escaped field.
		if (bytes > maxBytes) throw new Error("Skill catalog byte limit exceeded");
		return escaped;
	});
}

export interface LoadSkillsOptions {
	/** Working directory for project-local skills. */
	cwd: string;
	/** Agent config directory for global skills. */
	agentDir: string;
	/** Explicit skill paths (files or directories) */
	skillPaths: string[];
	/** Include default skills directories. */
	includeDefaults: boolean;
}

function normalizePath(input: string): string {
	const trimmed = input.trim();
	if (trimmed === "~") return homedir();
	if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
	if (trimmed.startsWith("~")) return join(homedir(), trimmed.slice(1));
	return trimmed;
}

function resolveSkillPath(p: string, cwd: string): string {
	const normalized = normalizePath(p);
	return isAbsolute(normalized) ? normalized : resolve(cwd, normalized);
}

/**
 * Load skills from all configured locations.
 * Returns skills and any validation diagnostics.
 */
export function loadSkills(options: LoadSkillsOptions): LoadSkillsResult {
	const { cwd, agentDir, skillPaths, includeDefaults } = options;

	const resolvedAgentDir = agentDir ?? getAgentDir();

	const skillMap = new Map<string, Skill>();
	const realPathSet = new Set<string>();
	const pythonImportMap = new Map<string, Skill>();
	const allDiagnostics: ResourceDiagnostic[] = [];
	const collisionDiagnostics: ResourceDiagnostic[] = [];
	const pythonImportDiagnostics: ResourceDiagnostic[] = [];

	function addSkills(result: LoadSkillsResult) {
		allDiagnostics.push(...result.diagnostics);
		for (const skill of result.skills) {
			const realPath = canonicalizePath(skill.filePath);

			if (realPathSet.has(realPath)) {
				continue;
			}

			const existing = skillMap.get(skill.name);
			if (existing) {
				collisionDiagnostics.push({
					type: "collision",
					message: `name "${skill.name}" collision`,
					path: skill.filePath,
					collision: {
						resourceType: "skill",
						name: skill.name,
						winnerPath: existing.filePath,
						loserPath: skill.filePath,
					},
				});
			} else {
				skillMap.set(skill.name, skill);
				realPathSet.add(realPath);
				if (skill.kind === "python") {
					const existingPythonSkill = pythonImportMap.get(skill.python.importName);
					if (existingPythonSkill) {
						pythonImportDiagnostics.push({
							type: "warning",
							message: `python import name "${skill.python.importName}" is shared by skills "${existingPythonSkill.name}" and "${skill.name}"`,
							path: skill.filePath,
						});
					} else {
						pythonImportMap.set(skill.python.importName, skill);
					}
				}
			}
		}
	}

	if (includeDefaults) {
		addSkills(loadSkillsFromDirInternal(join(resolvedAgentDir, "skills"), "user", true));
		addSkills(loadSkillsFromDirInternal(resolve(cwd, CONFIG_DIR_NAME, "skills"), "project", true));
	}

	const userSkillsDir = join(resolvedAgentDir, "skills");
	const projectSkillsDir = resolve(cwd, CONFIG_DIR_NAME, "skills");

	const isUnderPath = (target: string, root: string): boolean => {
		const normalizedRoot = resolve(root);
		if (target === normalizedRoot) {
			return true;
		}
		const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
		return target.startsWith(prefix);
	};

	const getSource = (resolvedPath: string): "user" | "project" | "path" => {
		if (!includeDefaults) {
			if (isUnderPath(resolvedPath, userSkillsDir)) return "user";
			if (isUnderPath(resolvedPath, projectSkillsDir)) return "project";
		}
		return "path";
	};

	for (const rawPath of skillPaths) {
		const resolvedPath = resolveSkillPath(rawPath, cwd);
		if (!existsSync(resolvedPath)) {
			allDiagnostics.push({ type: "warning", message: "skill path does not exist", path: resolvedPath });
			continue;
		}

		try {
			const stats = statSync(resolvedPath);
			const source = getSource(resolvedPath);
			if (stats.isDirectory()) {
				addSkills(loadSkillsFromDirInternal(resolvedPath, source, true));
			} else if (stats.isFile() && resolvedPath.endsWith(".md")) {
				const result = loadSkillFromFile(resolvedPath, source);
				if (result.skill) {
					addSkills({ skills: [result.skill], diagnostics: result.diagnostics });
				} else {
					allDiagnostics.push(...result.diagnostics);
				}
			} else {
				allDiagnostics.push({ type: "warning", message: "skill path is not a markdown file", path: resolvedPath });
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : "failed to read skill path";
			allDiagnostics.push({ type: "warning", message, path: resolvedPath });
		}
	}

	return {
		skills: Array.from(skillMap.values()),
		diagnostics: [...allDiagnostics, ...collisionDiagnostics, ...pythonImportDiagnostics],
	};
}
