import { readFileSync, rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { executeBashWithOperations } from "../src/core/bash-executor.js";
import { DEFAULT_MAX_BYTES } from "../src/core/tools/truncate.js";

describe("user Bash output settlement", () => {
	it("keeps small split UTF-8 output and exit status", async () => {
		const data = Buffer.from("hello €\n");
		const result = await executeBashWithOperations("command", process.cwd(), {
			exec: async (_command, _cwd, { onData }) => {
				onData(data.subarray(0, 7));
				onData(data.subarray(7));
				return { exitCode: 3 };
			},
		});
		expect(result).toEqual({
			output: "hello €\n",
			exitCode: 3,
			cancelled: false,
			truncated: false,
			fullOutputPath: undefined,
		});
	});

	it.each([false, true])(
		"preserves truncation and a readable full file after dropped chunks; cancelled=%s",
		async (cancelled) => {
			const controller = new AbortController();
			const first = "x".repeat(DEFAULT_MAX_BYTES * 3);
			const last = "\nfinal output\n";
			const result = await executeBashWithOperations(
				"command",
				process.cwd(),
				{
					exec: async (_command, _cwd, { onData }) => {
						onData(Buffer.from(first));
						onData(Buffer.from(last));
						if (cancelled) {
							controller.abort();
							throw new Error("aborted");
						}
						return { exitCode: 0 };
					},
				},
				{ signal: controller.signal },
			);
			try {
				expect(result.fullOutputPath).toBeTypeOf("string");
				expect(readFileSync(result.fullOutputPath!, "utf8")).toBe(first + last);
				expect(result.truncated).toBe(true);
				expect(result.output).toBe(last.slice(1));
				expect(result.cancelled).toBe(cancelled);
			} finally {
				if (result.fullOutputPath) rmSync(result.fullOutputPath, { force: true });
			}
		},
	);
});
