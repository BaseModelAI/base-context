import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, test } from "vitest";
import { PRODUCT } from "../src/product-identity.js";
import { resolveRuntimePaths } from "../src/runtime-paths.js";

let home: string | undefined;
afterEach(() => {
	if (home) rmSync(home, { recursive: true, force: true });
	home = undefined;
});

describe("Base Context identity and paths", () => {
	test("uses product-owned roots and ignores inherited legacy environment", () => {
		home = mkdtempSync(join(tmpdir(), "base-context-identity-"));
		const cwd = join(home, "project");
		const paths = resolveRuntimePaths(
			{
				PRIME_AGENT_CODING_AGENT_DIR: join(home, ".prime", "agent"),
				PRIME_AGENT_SESSION_DIR: join(home, "legacy-sessions"),
				PRIME_CONTEXT_HOME: join(home, ".prime-context"),
			},
			home,
			cwd,
		);
		expect(PRODUCT.command).toBe("base-context");
		expect(PRODUCT.daemonService).toBe("base-context.daemon");
		expect(paths.home).toBe(join(home, ".base-context"));
		expect(paths.project).toBe(join(cwd, ".base-context"));
		expect(paths.sessions).toBe(join(paths.home, "sessions"));
		expect(paths.auth).toBe(join(paths.home, "auth.json"));
		expect(resolveRuntimePaths({ BASE_CONTEXT_HOME: "~/custom" }, home, cwd).home).toBe(join(home, "custom"));
	});

	test("rejects ambiguous paths and legacy state aliases before writing", () => {
		home = mkdtempSync(join(tmpdir(), "base-context-identity-"));
		for (const value of ["", " ", "relative", "~/.prime/agent", "~/.prime-context/new", "~/.pi/agent"]) {
			expect(() => resolveRuntimePaths({ BASE_CONTEXT_HOME: value }, home)).toThrow();
		}
		expect(() => resolveRuntimePaths({ BASE_CONTEXT_SESSION_DIR: "~/.prime/agent/sessions" }, home)).toThrow(
			/legacy state/,
		);
		if (process.platform !== "win32") {
			mkdirSync(join(home, ".prime", "agent"), { recursive: true });
			symlinkSync(join(home, ".prime", "agent"), join(home, "alias"));
			expect(() => resolveRuntimePaths({ BASE_CONTEXT_HOME: join(home as string, "alias", "new") }, home)).toThrow(
				/legacy state/,
			);
		}
	});
});
