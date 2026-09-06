import * as util from "node:util";

const reflectApply = Reflect.apply;
const getPrototypeOf = Object.getPrototypeOf;
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const getOwnPropertyNames = Object.getOwnPropertyNames;
const getOwnPropertySymbols = Object.getOwnPropertySymbols;
const freeze = Object.freeze;
const typedArrayPrototype = getPrototypeOf(Uint8Array.prototype);
const arrayBufferPrototype = ArrayBuffer.prototype;
const inspectionFailed = freeze({});
const maximumStrictByteLength = 1_048_576;

type CapturedGetter = (target: unknown) => unknown;

function captureGetter(prototype: object, name: string): CapturedGetter | undefined {
	const descriptor = getOwnPropertyDescriptor(prototype, name);
	if (descriptor === undefined) return undefined;
	const getter: unknown = descriptor.get;
	if (typeof getter !== "function") return undefined;
	return (target: unknown): unknown => reflectApply(getter, target, []);
}

const getTypedArrayBuffer = captureGetter(typedArrayPrototype, "buffer");
const getTypedArrayByteOffset = captureGetter(typedArrayPrototype, "byteOffset");
const getTypedArrayByteLength = captureGetter(typedArrayPrototype, "byteLength");
const getTypedArrayLength = captureGetter(typedArrayPrototype, "length");
const getArrayBufferByteLength = captureGetter(arrayBufferPrototype, "byteLength");
const getArrayBufferDetached = captureGetter(arrayBufferPrototype, "detached");
const getArrayBufferResizable = captureGetter(arrayBufferPrototype, "resizable");

export type SandboxStrictByteCopyCode = "INPUT_INVALID" | "INPUT_TOO_LARGE";

export interface SandboxStrictByteCopySuccess {
	readonly ok: true;
	readonly value: Uint8Array;
}

export interface SandboxStrictByteCopyFailure {
	readonly ok: false;
	readonly code: SandboxStrictByteCopyCode;
}

export type SandboxStrictByteCopyResult = SandboxStrictByteCopySuccess | SandboxStrictByteCopyFailure;

const invalidResult: SandboxStrictByteCopyFailure = freeze({ ok: false, code: "INPUT_INVALID" });
const tooLargeResult: SandboxStrictByteCopyFailure = freeze({ ok: false, code: "INPUT_TOO_LARGE" });

function proxyOrInspectionFailure(value: object): boolean {
	try {
		return util.types.isProxy(value);
	} catch {
		return true;
	}
}

function inspectPrototype(value: object): object | null {
	try {
		return getPrototypeOf(value);
	} catch {
		return inspectionFailed;
	}
}

function inspectNames(value: object): readonly string[] | undefined {
	try {
		return getOwnPropertyNames(value);
	} catch {
		return undefined;
	}
}

function inspectSymbols(value: object): readonly symbol[] | undefined {
	try {
		return getOwnPropertySymbols(value);
	} catch {
		return undefined;
	}
}

function callCaptured(getter: CapturedGetter | undefined, target: object): unknown {
	if (getter === undefined) return inspectionFailed;
	try {
		return getter(target);
	} catch {
		return inspectionFailed;
	}
}

function isSafeLength(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function makeSuccess(value: Uint8Array): SandboxStrictByteCopySuccess {
	const result: SandboxStrictByteCopySuccess = { ok: true, value };
	return freeze(result);
}

export function copySandboxStrictBytes(input: unknown, maxBytes: number): SandboxStrictByteCopyResult {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > maximumStrictByteLength) return invalidResult;
	if (typeof input !== "object" || input === null) return invalidResult;
	if (proxyOrInspectionFailure(input)) return invalidResult;
	if (inspectPrototype(input) !== Uint8Array.prototype) return invalidResult;

	const lengthValue = callCaptured(getTypedArrayLength, input);
	const byteLengthValue = callCaptured(getTypedArrayByteLength, input);
	const byteOffsetValue = callCaptured(getTypedArrayByteOffset, input);
	const bufferValue = callCaptured(getTypedArrayBuffer, input);
	if (!isSafeLength(lengthValue) || !isSafeLength(byteLengthValue) || !isSafeLength(byteOffsetValue)) {
		return invalidResult;
	}
	if (lengthValue !== byteLengthValue || byteOffsetValue !== 0) return invalidResult;
	if (byteLengthValue > maxBytes) return tooLargeResult;
	if (typeof bufferValue !== "object" || bufferValue === null) return invalidResult;
	if (proxyOrInspectionFailure(bufferValue)) return invalidResult;
	if (inspectPrototype(bufferValue) !== arrayBufferPrototype) return invalidResult;

	const bufferNames = inspectNames(bufferValue);
	const bufferSymbols = inspectSymbols(bufferValue);
	if (bufferNames === undefined || bufferSymbols === undefined) return invalidResult;
	if (bufferNames.length !== 0 || bufferSymbols.length !== 0) return invalidResult;

	const bufferLengthValue = callCaptured(getArrayBufferByteLength, bufferValue);
	const detachedValue = callCaptured(getArrayBufferDetached, bufferValue);
	const resizableValue = callCaptured(getArrayBufferResizable, bufferValue);
	if (!isSafeLength(bufferLengthValue)) return invalidResult;
	if (detachedValue !== false || resizableValue !== false) return invalidResult;
	if (bufferLengthValue !== byteLengthValue) return invalidResult;

	const ownNames = inspectNames(input);
	const ownSymbols = inspectSymbols(input);
	if (ownNames === undefined || ownSymbols === undefined) return invalidResult;
	if (ownSymbols.length !== 0 || ownNames.length !== lengthValue) return invalidResult;

	const values: number[] = new Array<number>(lengthValue);
	for (let index = 0; index < lengthValue; index += 1) {
		const name = String(index);
		if (ownNames.indexOf(name) === -1) return invalidResult;
		let descriptor: PropertyDescriptor | undefined;
		try {
			descriptor = getOwnPropertyDescriptor(input, name);
		} catch {
			return invalidResult;
		}
		if (descriptor === undefined) return invalidResult;
		if (descriptor.get !== undefined || descriptor.set !== undefined) return invalidResult;
		if (descriptor.writable !== true || descriptor.enumerable !== true || descriptor.configurable !== true) {
			return invalidResult;
		}
		const byte: unknown = descriptor.value;
		if (typeof byte !== "number" || !Number.isInteger(byte) || byte < 0 || byte > 255) return invalidResult;
		values[index] = byte;
	}

	const copy = new Uint8Array(lengthValue);
	for (let index = 0; index < lengthValue; index += 1) copy[index] = values[index];
	return makeSuccess(copy);
}
