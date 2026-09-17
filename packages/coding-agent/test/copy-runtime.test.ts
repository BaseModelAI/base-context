import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function copyRuntime(extraFiles: Record<string, string> = {}): string {
	const root = mkdtempSync(join(tmpdir(), "bc-runtime-copy-"));
	roots.push(root);
	const script = join(root, "packages/coding-agent/scripts/copy-runtime.mjs");
	mkdirSync(dirname(script), { recursive: true });
	copyFileSync(new URL("../scripts/copy-runtime.mjs", import.meta.url), script);
	for (const [name, content] of Object.entries({
		"pyproject.toml": '[project]\nname = "fixture-runtime"\n',
		"src/rlm/__init__.py": "VALUE = 42\n",
		...extraFiles,
	})) {
		const path = join(root, "prime-agent-runtime", name);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content);
	}
	execFileSync(process.execPath, [script], { cwd: root });
	return join(root, "packages/coding-agent/dist/base-context-runtime");
}

it("copies runtime source and package metadata", () => {
	const output = copyRuntime();
	expect(readFileSync(join(output, "src/rlm/__init__.py"), "utf8")).toBe("VALUE = 42\n");
	expect(readFileSync(join(output, "pyproject.toml"), "utf8")).toContain("fixture-runtime");
});

it("does not package the development venv or Python bytecode", () => {
	const output = copyRuntime({
		".venv/bin/python": "machine-specific interpreter",
		".venv/lib/site-packages/fixture.py": "installed dependency",
		"src/rlm/__pycache__/fixture.pyc": "bytecode",
		"src/rlm/fixture.pyo": "bytecode",
	});
	expect(existsSync(join(output, ".venv"))).toBe(false);
	expect(existsSync(join(output, "src/rlm/__pycache__"))).toBe(false);
	expect(existsSync(join(output, "src/rlm/fixture.pyo"))).toBe(false);
	expect(existsSync(join(output, "src/rlm/__init__.py"))).toBe(true);
});
