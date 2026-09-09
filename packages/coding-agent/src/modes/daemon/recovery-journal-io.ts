import { closeSync, fsyncSync, openSync } from "node:fs";

// Recovery journals retain the write failure and any distinct descriptor cleanup failure.
export function withRecoveryDescriptor<T>(fd: number, action: (fd: number) => T): T {
	let result: T;
	try {
		result = action(fd);
	} catch (error) {
		try {
			closeSync(fd);
		} catch (closeError) {
			if (closeError !== error)
				throw new AggregateError([error, closeError], "Recovery journal I/O and close failed");
		}
		throw error;
	}
	closeSync(fd);
	return result;
}

export function syncRecoveryDirectory(path: string): void {
	// Same platform limit as the canonical journal owner.
	if (process.platform !== "win32") withRecoveryDescriptor(openSync(path, "r"), (fd) => fsyncSync(fd));
}
