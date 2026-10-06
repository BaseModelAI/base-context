import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

let home: string;
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "base-context-auth-utilities-"));
	vi.stubEnv("HOME", home);
	vi.stubEnv("USERPROFILE", home);
	vi.resetModules();
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(home, { recursive: true, force: true });
});

function writeFixture(directory: string) {
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		join(directory, "auth.json"),
		JSON.stringify({ "fixture-provider": { type: "api_key", key: "local-fixture-key" } }),
	);
}

it("uses BASE_CONTEXT_HOME for all credential test helpers", async () => {
	const state = join(home, "configured-state");
	vi.stubEnv("BASE_CONTEXT_HOME", state);
	writeFixture(state);
	const helpers = await import("./utilities.js");

	expect(helpers.BASE_CONTEXT_AGENT_DIR).toBe(state);
	expect(helpers.hasAuthForProvider("fixture-provider")).toBe(true);
	expect(await helpers.resolveApiKey("fixture-provider")).toBe("local-fixture-key");
	expect(helpers.getRealAuthStorage().get("fixture-provider")).toEqual({
		type: "api_key",
		key: "local-fixture-key",
	});
});

it("defaults to Base Context state without borrowing upstream credentials", async () => {
	vi.stubEnv("BASE_CONTEXT_HOME", undefined);
	writeFixture(join(home, ".pi", "agent"));
	const helpers = await import("./utilities.js");

	expect(helpers.BASE_CONTEXT_AGENT_DIR).toBe(join(home, ".base-context"));
	expect(helpers.hasAuthForProvider("fixture-provider")).toBe(false);
	expect(await helpers.resolveApiKey("fixture-provider")).toBeUndefined();
});
