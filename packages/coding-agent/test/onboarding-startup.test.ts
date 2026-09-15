import type { Api, Model } from "@ponythewhite/base-context-ai";
import { describe, expect, test } from "vitest";
import { type OnboardingStartupState, shouldRunOnboarding } from "../src/modes/interactive/onboarding.js";

function makeState(model: Model<Api> | undefined, hasAuth: boolean, shown = false): OnboardingStartupState {
	return {
		settingsManager: { getOnboardingShown: () => shown },
		modelRegistry: { refresh: () => {}, hasConfiguredAuth: () => hasAuth },
		model,
	};
}

const model = { id: "selected-model", provider: "openai" } as Model<Api>;

describe("startup onboarding decision", () => {
	test("skips setup only when a selected model has configured auth", () => {
		expect(shouldRunOnboarding(makeState(model, true))).toBe(false);
		expect(shouldRunOnboarding(makeState(model, true, true))).toBe(false);
	});

	test("reopens incomplete setup after cancellation", () => {
		expect(shouldRunOnboarding(makeState(undefined, false))).toBe(true);
		expect(shouldRunOnboarding(makeState(undefined, true))).toBe(true);
		expect(shouldRunOnboarding(makeState(undefined, false, true))).toBe(true);
		expect(shouldRunOnboarding(makeState(model, false, true))).toBe(true);
	});
});
