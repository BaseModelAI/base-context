import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const sourceRoot = fileURLToPath(new URL("../../../", import.meta.url));
const roots: string[] = [];
const names = {
	ai: "@ponythewhite/base-context-ai",
	agent: "@ponythewhite/base-context-agent",
	tui: "@ponythewhite/base-context-tui",
	"coding-agent": "@ponythewhite/base-context",
};
const releasedSection = "## [1.1.1] - 2026-10-05\n\nPreviously released text.\n";

function run(root: string, command: string, args: string[]): string {
	return execFileSync(command, args, { cwd: root, encoding: "utf8", stdio: "pipe" });
}

function writeJson(root: string, path: string, value: object): void {
	mkdirSync(dirname(join(root, path)), { recursive: true });
	writeFileSync(join(root, path), `${JSON.stringify(value, null, "\t")}\n`);
}

function fixture(): string {
	const root = mkdtempSync(join(tmpdir(), "base-context-release-"));
	roots.push(root);
	const manifest = {
		name: "release-test-monorepo",
		private: true,
		type: "module",
		version: "1.1.1",
		workspaces: ["packages/*", "examples/private"],
		dependencies: { [names["coding-agent"]]: "1.1.1" },
	};
	writeJson(root, "package.json", manifest);
	const privateExample = { name: "private-release-fixture", version: "0.9.3", private: true };
	writeJson(root, "examples/private/package.json", privateExample);
	const packages: Record<string, object> = {
		"": manifest,
		"examples/private": privateExample,
		"node_modules/private-release-fixture": { resolved: "examples/private", link: true },
	};
	for (const [dir, name] of Object.entries(names)) {
		const data = {
			name,
			version: "1.1.1",
			dependencies:
				dir === "coding-agent" ? { [names.ai]: "^1.1.1" } : dir === "agent" ? { [names.ai]: "1.1.1" } : {},
			...(dir === "tui" ? { devDependencies: { [names.ai]: "~1.1.1" } } : {}),
		};
		writeJson(root, `packages/${dir}/package.json`, data);
		writeFileSync(join(root, `packages/${dir}/CHANGELOG.md`), `# Changelog\n\n${releasedSection}`);
		packages[`packages/${dir}`] = data;
		packages[`node_modules/${name}`] = { resolved: `packages/${dir}`, link: true };
	}
	writeJson(root, "package-lock.json", {
		name: manifest.name,
		version: manifest.version,
		lockfileVersion: 3,
		requires: true,
		packages,
	});
	for (const file of ["release.mjs", "sync-versions.js", "lib/changelog-fragments.mjs"]) {
		mkdirSync(dirname(join(root, "scripts", file)), { recursive: true });
		copyFileSync(join(sourceRoot, "scripts", file), join(root, "scripts", file));
	}
	mkdirSync(join(root, "packages/ai/.changes"));
	writeFileSync(join(root, "packages/ai/.changes/fix.md"), "Fixed release preparation.\n");
	writeFileSync(join(root, "packages/ai/.changes/README.md"), "Fragment instructions.\n");
	mkdirSync(join(root, "node_modules"));
	writeFileSync(join(root, "node_modules/installed-marker"), "keep installed dependencies");
	writeFileSync(join(root, ".gitignore"), "node_modules/\n");
	run(root, "git", ["init", "-q"]);
	run(root, "git", [
		"add",
		"--",
		".gitignore",
		"package.json",
		"package-lock.json",
		"packages",
		"examples",
		"scripts",
	]);
	run(root, "git", [
		"-c",
		"user.name=Release test",
		"-c",
		"user.email=release-test@example.invalid",
		"commit",
		"-qm",
		"Fixture",
	]);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("prepares lockstep versions and changelogs locally without deleting dependencies or committing", () => {
	const root = fixture();
	const output = run(root, process.execPath, ["scripts/release.mjs", "1.1.2", "--prepare"]);
	expect(output).toContain("Prepared v1.1.2 locally");
	const rootPackage = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	expect(rootPackage.version).toBe("1.1.2");
	expect(rootPackage.dependencies[names["coding-agent"]]).toBe("1.1.2");
	const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
	expect(lock.version).toBe("1.1.2");
	expect(lock.packages["examples/private"].version).toBe("0.9.3");
	expect(JSON.parse(readFileSync(join(root, "examples/private/package.json"), "utf8")).version).toBe("0.9.3");
	expect(lock.packages[""].dependencies[names["coding-agent"]]).toBe("1.1.2");
	for (const dir of Object.keys(names)) {
		expect(JSON.parse(readFileSync(join(root, `packages/${dir}/package.json`), "utf8")).version).toBe("1.1.2");
		expect(lock.packages[`packages/${dir}`].version).toBe("1.1.2");
	}
	expect(lock.packages["packages/coding-agent"].dependencies[names.ai]).toBe("^1.1.2");
	expect(lock.packages["packages/agent"].dependencies[names.ai]).toBe("1.1.2");
	expect(lock.packages["packages/tui"].devDependencies[names.ai]).toBe("~1.1.2");
	const changelog = readFileSync(join(root, "packages/ai/CHANGELOG.md"), "utf8");
	expect(changelog).toContain("## [1.1.2] - ");
	expect(changelog).toContain("Fixed release preparation.");
	expect(changelog).toContain(releasedSection);
	expect(existsSync(join(root, "packages/ai/.changes/fix.md"))).toBe(false);
	expect(existsSync(join(root, "packages/ai/.changes/README.md"))).toBe(true);
	expect(readFileSync(join(root, "node_modules/installed-marker"), "utf8")).toBe("keep installed dependencies");
	expect(run(root, "git", ["rev-list", "--count", "HEAD"]).trim()).toBe("1");
	expect(run(root, "git", ["tag", "--list"]).trim()).toBe("");
	expect(run(root, "git", ["diff", "--cached", "--name-only"]).trim()).toBe("");
}, 30_000);

it("refuses local preparation in a dirty worktree before changing versions or fragments", () => {
	const root = fixture();
	writeFileSync(join(root, "unfinished.txt"), "Uncommitted work");
	expect(() => run(root, process.execPath, ["scripts/release.mjs", "patch", "--prepare"])).toThrow(
		"Uncommitted changes detected",
	);
	expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version).toBe("1.1.1");
	expect(existsSync(join(root, "packages/ai/.changes/fix.md"))).toBe(true);
	expect(readFileSync(join(root, "packages/ai/CHANGELOG.md"), "utf8")).toBe(`# Changelog\n\n${releasedSection}`);
});
