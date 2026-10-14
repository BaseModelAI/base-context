import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.js";

describe("runtime settings overrides across persistence", () => {
	let directory: string;
	let agentDir: string;
	let projectDir: string;
	let settingsPath: string;
	let manager: SettingsManager;

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "base-context-settings-overrides-"));
		agentDir = join(directory, "agent");
		projectDir = join(directory, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(projectDir, ".base-context"), { recursive: true });
		settingsPath = join(agentDir, "settings.json");
		writeFileSync(
			settingsPath,
			JSON.stringify({
				compaction: { enabled: true, keepRecentTokens: 1234 },
				retry: { enabled: false },
			}),
		);
		writeFileSync(
			join(projectDir, ".base-context", "settings.json"),
			JSON.stringify({
				compaction: { reserveTokens: 4000 },
			}),
		);
		manager = SettingsManager.create(projectDir, agentDir);
		manager.applyOverrides({ compaction: { enabled: false }, retry: { enabled: true, maxRetries: 2 } });
	});

	afterEach(async () => {
		await manager.flush();
		rmSync(directory, { recursive: true, force: true });
	});

	it("applies temporary overrides without changing the stored layers", () => {
		expect(manager.getCompactionSettings()).toEqual({ enabled: false, keepRecentTokens: 1234, reserveTokens: 4000 });
		expect(manager.getRetrySettings()).toMatchObject({ enabled: true, maxRetries: 2 });
		expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
			compaction: { enabled: true, keepRecentTokens: 1234 },
			retry: { enabled: false },
		});
	});

	it("retains overrides across unrelated global and project saves and reload", async () => {
		manager.setDefaultThinkingLevel("high");
		expect(manager.getCompactionEnabled()).toBe(false);
		manager.setProjectExtensionPaths(["./extension.ts"]);
		expect(manager.getRetrySettings()).toMatchObject({ enabled: true, maxRetries: 2 });
		await manager.flush();
		const saved = JSON.parse(readFileSync(settingsPath, "utf8"));
		expect(saved).toEqual({
			compaction: { enabled: true, keepRecentTokens: 1234 },
			retry: { enabled: false },
			defaultThinkingLevel: "high",
		});
		expect(JSON.parse(readFileSync(join(projectDir, ".base-context", "settings.json"), "utf8"))).toEqual({
			compaction: { reserveTokens: 4000 },
			extensions: ["./extension.ts"],
		});
		writeFileSync(settingsPath, JSON.stringify({ ...saved, compaction: { enabled: true, keepRecentTokens: 5678 } }));
		await manager.reload();
		expect(manager.getCompactionSettings()).toEqual({ enabled: false, keepRecentTokens: 5678, reserveTokens: 4000 });
		expect(manager.getRetrySettings()).toMatchObject({ enabled: true, maxRetries: 2 });
		expect(manager.getDefaultThinkingLevel()).toBe("high");
		expect(manager.drainErrors()).toEqual([]);
	});
});
