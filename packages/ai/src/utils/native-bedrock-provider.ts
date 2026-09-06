// Private implementation identity. Not exported by the package registration API.
let native: { stream: object; streamSimple: object } | undefined;

export function rememberNativeBedrockProvider(stream: object, streamSimple: object): void {
	native = { stream, streamSimple };
}

export function isNativeBedrockProvider(stream: object, streamSimple: object): boolean {
	return native?.stream === stream && native.streamSimple === streamSimple;
}
