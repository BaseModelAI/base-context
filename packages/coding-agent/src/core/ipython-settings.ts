export function resolveForegroundWaitMs(value: number | undefined): number {
	if (value === undefined) return 1000;
	if (!Number.isFinite(value) || value < 0) {
		throw new Error("foregroundWaitMs must be a finite nonnegative number");
	}
	return value;
}
