import { describe, expect, it } from "vitest";
import { execCommand } from "../src/core/exec.js";

describe("execCommand output decoding", () => {
	it("preserves UTF-8 characters split across stdout and stderr chunks", async () => {
		const result = await execCommand(
			process.execPath,
			[
				"-e",
				`process.stdout.write(Buffer.from([0xe2]));
process.stderr.write(Buffer.from([0xf0, 0x9f]));
setTimeout(() => {
  process.stdout.write(Buffer.from([0x82, 0xac, 0x0a]));
  process.stderr.write(Buffer.from([0x98, 0x80, 0x0a]));
}, 100);`,
			],
			process.cwd(),
		);

		expect(result).toEqual({ stdout: "€\n", stderr: "😀\n", code: 0, killed: false });
	});

	it("flushes one replacement for an incomplete UTF-8 character at process exit", async () => {
		const result = await execCommand(
			process.execPath,
			[
				"-e",
				`process.stdout.write(Buffer.from([0xe2]));
process.stderr.write(Buffer.from([0xe2]));
setTimeout(() => {
  process.stdout.write(Buffer.from([0x82]));
  process.stderr.write(Buffer.from([0x82]));
  process.exitCode = 7;
}, 100);`,
			],
			process.cwd(),
		);

		expect(result).toEqual({ stdout: "�", stderr: "�", code: 7, killed: false });
	});
});
