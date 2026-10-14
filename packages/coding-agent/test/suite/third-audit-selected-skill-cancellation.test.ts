import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@ponythewhite/base-context-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SELECTED_SKILL_CUSTOM_TYPE } from "../../src/core/selected-skills.js";
import { bindNativeEntryWriter } from "../../src/core/session-entry-origin.js";
import { APPEND_NATIVE_RECOVERY, SessionJournalOwner } from "../../src/core/session-journal-owner.js";
import type { Skill } from "../../src/core/skills.js";
import { createSyntheticSourceInfo } from "../../src/core/source-info.js";
import { createTestResourceLoader } from "../utilities.js";
import { createHarness, type Harness } from "./harness.js";
import { createDeferred } from "./scheduling.js";

describe("selected skill cancellation at the native writer queue", () => {
	let harness: Harness | undefined;

	afterEach(async () => {
		vi.restoreAllMocks();
		await harness?.cleanup();
		harness = undefined;
	});

	it.each(["before submission", "after ACK"] as const)(
		"retains only accepted captures when cancelled %s",
		async (boundary) => {
			const skills: Skill[] = [];
			harness = await createHarness({
				persistSession: true,
				rlmDepth: 0,
				resourceLoader: createTestResourceLoader({ skills }),
				settings: { compaction: { enabled: false }, autoRefine: { enabled: false } },
			});
			const { session, sessionManager } = harness;
			const skillPath = join(harness.tempDir, "SKILL.md");
			writeFileSync(
				skillPath,
				"---\nname: cancellation-fixture\ndescription: Capture cancellation\n---\nPreserve required report.",
			);
			skills.push({
				name: "cancellation-fixture",
				description: "Capture cancellation",
				kind: "markdown",
				filePath: skillPath,
				baseDir: harness.tempDir,
				disableModelInvocation: false,
				sourceInfo: createSyntheticSourceInfo(skillPath, { source: "test" }),
			});
			await session.reload();
			harness.setResponses([fauxAssistantMessage("Ready.")]);
			await session.prompt("Prepare selected-skill cancellation.");
			await session.setContextMode("off");
			const callsBefore = harness.faux.state.callCount;
			const reached = createDeferred();
			const release = createDeferred();
			let blocker: Promise<string> | undefined;
			const appendJson = SessionJournalOwner.prototype.appendJson;
			vi.spyOn(SessionJournalOwner.prototype, "appendJson").mockImplementation(async function (
				this: SessionJournalOwner,
				...args
			) {
				if (JSON.parse(args[0]).customType === "skill-queue-blocker") {
					reached.resolve();
					await release.promise;
				}
				return appendJson.apply(this, args);
			});
			const recovery = SessionJournalOwner.prototype[APPEND_NATIVE_RECOVERY];
			vi.spyOn(SessionJournalOwner.prototype, APPEND_NATIVE_RECOVERY).mockImplementation(async function (
				this: SessionJournalOwner,
				...args
			) {
				const ack = await recovery.apply(this, args);
				if (boundary === "after ACK" && JSON.parse(args[0]).customType === SELECTED_SKILL_CUSTOM_TYPE) {
					reached.resolve();
					await release.promise;
				}
				return ack;
			});
			const bind = sessionManager[bindNativeEntryWriter].bind(sessionManager);
			vi.spyOn(sessionManager, bindNativeEntryWriter).mockImplementation(() => {
				const writer = bind();
				const capture = writer.captureSkillSelection;
				writer.captureSkillSelection = () => {
					const selection = capture();
					const append = selection.append;
					selection.append = (...args) => {
						if (boundary === "before submission")
							blocker = sessionManager.appendCustomEntry("skill-queue-blocker", {});
						return append(...args);
					};
					return selection;
				};
				return writer;
			});
			const outcome = session.prompt("/skill:cancellation-fixture").catch((error: unknown) => error);
			try {
				await reached.promise;
				session.requestAbort();
				release.resolve();
				await outcome;
				await blocker;
				await session.waitForIdle();
				const captures = (await sessionManager.readEntries()).filter(
					(entry) =>
						(entry.type === "custom" || entry.type === "custom_message") &&
						entry.customType === SELECTED_SKILL_CUSTOM_TYPE,
				);
				expect(captures).toHaveLength(boundary === "after ACK" ? 1 : 0);
				expect(harness.faux.state.callCount).toBe(callsBefore);
			} finally {
				release.resolve();
				session.requestAbort();
				await outcome;
				await blocker;
			}
		},
		15_000,
	);
});
