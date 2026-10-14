import { fauxAssistantMessage } from "@ponythewhite/base-context-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getUserTexts, type Harness } from "../harness.js";
import { createDeferred } from "../scheduling.js";

const harnesses: Harness[] = [];

afterEach(async () => {
	await Promise.all(harnesses.splice(0).map((harness) => harness.cleanup()));
});

describe("prompt normalization ownership", () => {
	it("admits asynchronous transformed input when its owner stays current", async () => {
		const harness = await createHarness({
			rlmDepth: 0,
			tools: [],
			extensionFactories: [
				(pi) => {
					pi.on("input", async (event) => ({ action: "transform", text: `transformed: ${event.text}` }));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);
		await harness.session.prompt("current");
		expect(getUserTexts(harness)).toEqual(["transformed: current"]);
	});

	it("rejects input cancelled while its input handler is pending", async () => {
		const entered = createDeferred();
		const release = createDeferred();
		const harness = await createHarness({
			rlmDepth: 0,
			tools: [],
			extensionFactories: [
				(pi) => {
					pi.on("input", async () => {
						entered.resolve();
						await release.promise;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("must not run")]);
		const controller = new AbortController();
		const pending = harness.session.prompt("cancelled", { signal: controller.signal });
		const outcome = pending.then(
			() => undefined,
			(error: unknown) => error,
		);
		await entered.promise;
		controller.abort();
		release.resolve();
		expect(await outcome).toBeInstanceOf(Error);
		expect(getUserTexts(harness)).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("does not resume an aborted session from stale streaming input", async () => {
		const responseEntered = createDeferred();
		const responseRelease = createDeferred();
		const inputEntered = createDeferred();
		const inputRelease = createDeferred();
		const harness = await createHarness({
			rlmDepth: 0,
			tools: [],
			extensionFactories: [
				(pi) => {
					pi.on("input", async (event) => {
						if (event.text !== "stale") return;
						inputEntered.resolve();
						await inputRelease.promise;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			async () => {
				responseEntered.resolve();
				await responseRelease.promise;
				return fauxAssistantMessage("first");
			},
			fauxAssistantMessage("must not run"),
		]);
		const first = harness.session.prompt("first");
		const firstOutcome = first.catch(() => undefined);
		await responseEntered.promise;
		const pending = harness.session.prompt("stale", { streamingBehavior: "followUp" });
		const outcome = pending.then(
			() => undefined,
			(error: unknown) => error,
		);
		await inputEntered.promise;
		const abort = harness.session.abort();
		responseRelease.resolve();
		await Promise.all([abort, firstOutcome]);
		expect(harness.session.isQueuedWorkSuspended).toBe(true);
		inputRelease.resolve();
		expect(await outcome).toBeInstanceOf(Error);
		expect(harness.session.isQueuedWorkSuspended).toBe(true);
		expect(harness.session.unfinishedActionCount).toBe(0);
		expect(getUserTexts(harness)).toEqual(["first"]);
	});
});
