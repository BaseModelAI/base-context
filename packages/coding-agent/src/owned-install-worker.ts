// External Node owns the same short activation transaction; the host never opens SQLite.

import { OwnedInstallActivatedError, runOwnedActivation } from "./owned-install.js";
import type { InstallSelection } from "./owned-install-layout.js";

let selection: InstallSelection | null = null;
let errors: readonly unknown[] = [];
try {
	if ("bun" in process.versions) throw new Error("Base-Context activation ownership requires external Node.");
	const input = JSON.parse(process.argv[2] ?? "") as {
		root: string;
		expected: InstallSelection | null;
		version: string;
		parentPid: number;
	};
	if (process.ppid !== input.parentPid) throw new Error("Base-Context activation worker has no original parent.");
	selection = runOwnedActivation(input.root, input.expected, input.version, input.parentPid).selection;
} catch (error) {
	const failure = error instanceof OwnedInstallActivatedError ? error.cause : error;
	if (error instanceof OwnedInstallActivatedError) selection = error.activation.selection;
	errors = failure instanceof AggregateError ? failure.errors : [failure];
}
process.stdout.write(
	JSON.stringify({
		selection,
		failures: errors.map((error) => ({
			name: error instanceof Error ? error.name : "Error",
			message: error instanceof Error ? error.message : String(error),
			...(error instanceof Error && "code" in error && typeof error.code === "string" ? { code: error.code } : {}),
		})),
	}),
);
process.exitCode = errors.length > 0 ? 1 : 0;
