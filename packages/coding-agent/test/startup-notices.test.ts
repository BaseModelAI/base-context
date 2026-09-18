import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { checkTmuxKeyboardSetup, formatTmuxWarningNotice } from "../src/modes/shared/startup-notices.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function stripAnsi(text: string): string {
	return text.replace(ANSI_PATTERN, "");
}

describe("startup notice formatters", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	describe("tmux keyboard setup", () => {
		afterEach(() => {
			vi.unstubAllEnvs();
			vi.mocked(spawn).mockReset();
		});

		test.each(["xterm", "csi-u"])("uses base-context branding for the %s format", async (format) => {
			vi.stubEnv("TMUX", "test-tmux");
			vi.mocked(spawn).mockImplementation((_command, args) => {
				const proc = Object.assign(new EventEmitter(), { stdout: new PassThrough() });
				queueMicrotask(() => {
					proc.stdout.end(args?.[2] === "extended-keys" ? "on" : format);
					proc.emit("close", 0);
				});
				return proc as unknown as ChildProcess;
			});

			const warning = await checkTmuxKeyboardSetup();
			expect(vi.mocked(spawn)).toHaveBeenCalledTimes(2);
			expect(warning).toBe(
				format === "xterm"
					? "tmux extended-keys-format is xterm. base-context works best with csi-u. Add `set -g extended-keys-format csi-u` to ~/.tmux.conf and restart tmux."
					: undefined,
			);
		});
	});

	test("tmux warning notice is prefixed with the warning glyph", () => {
		const output = stripAnsi(formatTmuxWarningNotice("tmux extended-keys is off."));
		expect(output).toBe("⚠ tmux extended-keys is off.");
	});
});
