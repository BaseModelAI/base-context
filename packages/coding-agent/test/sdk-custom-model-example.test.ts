import { getModel } from "@ponythewhite/base-context-ai";
import { expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => {
	const prompt = vi.fn().mockResolvedValue(undefined);
	return {
		prompt,
		createAgentSession: vi.fn().mockResolvedValue({ session: { subscribe: vi.fn(), prompt } }),
		getAvailable: vi.fn().mockResolvedValue([{ provider: "unrelated-provider", id: "first-available" }]),
	};
});

vi.mock("@ponythewhite/base-context", () => ({
	AuthStorage: { create: () => ({}) },
	ModelRegistry: { create: () => ({ find: () => undefined, getAvailable: sdk.getAvailable }) },
	createAgentSession: sdk.createAgentSession,
}));

it("uses the explicitly chosen SDK model even when another provider is available first", async () => {
	await import("../examples/sdk/02-custom-model.js");

	expect(sdk.getAvailable).toHaveBeenCalledOnce();
	expect(sdk.createAgentSession).toHaveBeenCalledExactlyOnceWith(
		expect.objectContaining({ model: getModel("anthropic", "claude-opus-4-5"), thinkingLevel: "medium" }),
	);
	expect(sdk.prompt).toHaveBeenCalledExactlyOnceWith("Say hello in one sentence.");
});
