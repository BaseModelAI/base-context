import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { getProductDiagnostics } from "../src/cli/product-doctor.js";

let home: string | undefined;
afterEach(() => {
	vi.unstubAllEnvs();
	if (home) rmSync(home, { recursive: true, force: true });
	home = undefined;
});

test("reports owned product paths and unavailable auth contracts without credential values", () => {
	home = mkdtempSync(join(tmpdir(), "bc-doctor-"));
	vi.stubEnv("BASE_CONTEXT_HOME", home);
	vi.stubEnv("BASE_CONTEXT_TELEMETRY_API_KEY", "private-export-credential");
	const report = getProductDiagnostics();
	expect(report.product.package).toBe("@ponythewhite/base-context");
	expect(report.paths.auth).toBe(join(home, "auth.json"));
	expect(report.paths.settings).toBe(join(home, "settings.json"));
	expect(report.schemas.daemon.name).toBe("base-context.daemon");
	expect(report.providerContracts.every((contract) => contract.oauth !== "validated")).toBe(true);
	expect(JSON.stringify(report)).not.toContain("private-export-credential");
});

test("reports an invalid legacy state override instead of accepting it", () => {
	home = mkdtempSync(join(tmpdir(), "bc-doctor-"));
	vi.stubEnv("BASE_CONTEXT_HOME", join(home, ".prime", "agent"));
	expect(() => getProductDiagnostics()).toThrow("cannot write legacy state");
});
