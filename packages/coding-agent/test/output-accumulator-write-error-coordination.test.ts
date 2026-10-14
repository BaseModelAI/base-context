import type { WriteStream } from "node:fs";
import * as fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { OutputAccumulator } from "../src/core/tools/output-accumulator.js";

const streams = vi.hoisted(() => [] as WriteStream[]);

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof fs>();
	return {
		...actual,
		createWriteStream: () => {
			const stream = actual.createWriteStream("/dev/full");
			streams.push(stream);
			return stream;
		},
	};
});

describe("output accumulator write-error ownership", () => {
	it.skipIf(!fs.existsSync("/dev/full"))("handles a write error before final output settlement", async () => {
		const output = new OutputAccumulator({ maxBytes: 4 });
		output.append(Buffer.from("large output"));
		const stream = streams[0]!;
		const ownedErrorListeners = stream.listenerCount("error");
		// Observe the native failure without letting the pre-fix unhandled event kill the test worker.
		const error = await new Promise<Error>((resolve) => stream.once("error", resolve));
		expect(error).toMatchObject({ code: "ENOSPC" });
		expect(ownedErrorListeners).toBeGreaterThan(0);
		output.finish();
		await expect(output.closeTempFile()).rejects.toBe(error);
	});
});
