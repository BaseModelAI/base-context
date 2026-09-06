import { types } from "node:util";
import {
	closeSandboxHomeActivation,
	confirmSandboxHomeActivation,
	createSandboxHomeActivation,
	encryptSandboxHomeActivation,
} from "./prime-sandbox-activation.js";
import { performSandboxHomeHandshake } from "./prime-sandbox-handshake.js";
import { copySandboxRuntimeReadiness, type PrimeSandboxProviderPort } from "./prime-sandbox-provider.js";
import { closeSandboxReadinessBundle, decodeSandboxReadinessBundle } from "./prime-sandbox-readiness-bundle.js";
import type { SandboxTcpIo } from "./prime-sandbox-tcp.js";
import {
	closeSandboxTransportChannel,
	SANDBOX_TRANSPORT_HEADER_BYTES,
	SANDBOX_TRANSPORT_MAX_PLAINTEXT_BYTES,
	SANDBOX_TRANSPORT_TAG_BYTES,
	type SandboxTransportChannel,
} from "./prime-sandbox-transport.js";

const ISSUE = Object.freeze({});
const PHASE_TIMEOUT_MS = 3_000;
const CLOSE_TIMEOUT_MS = 1_000;

interface ConnectionState {
	readonly io: SandboxTcpIo;
	readonly channel: SandboxTransportChannel;
}

export class SandboxHomeRuntimeConnection {
	constructor(token: object) {
		if (token !== ISSUE) throw new Error();
		Object.freeze(this);
	}
}

Object.freeze(SandboxHomeRuntimeConnection.prototype);
Object.freeze(SandboxHomeRuntimeConnection);

const connections = new WeakMap<object, ConnectionState>();

export type SandboxHomeConnectionResult =
	| Readonly<{ ok: true; value: SandboxHomeRuntimeConnection }>
	| Readonly<{
			ok: false;
			code:
				| "INPUT_INVALID"
				| "READINESS_INVALID"
				| "CONNECT_FAILED"
				| "ABORTED"
				| "AUTHENTICATION_FAILED"
				| "ACTIVATION_FAILED"
				| "CLEANUP_UNCERTAIN";
	  }>;

export type SandboxHomeConnectionCloseResult =
	| Readonly<{ ok: true; value: true }>
	| Readonly<{ ok: false; code: "INPUT_INVALID" | "CLEANUP_UNCERTAIN" }>;

function success(value: SandboxHomeRuntimeConnection): Readonly<{ ok: true; value: SandboxHomeRuntimeConnection }> {
	return Object.freeze({ ok: true, value });
}

function failure(
	code:
		| "INPUT_INVALID"
		| "READINESS_INVALID"
		| "CONNECT_FAILED"
		| "ABORTED"
		| "AUTHENTICATION_FAILED"
		| "ACTIVATION_FAILED"
		| "CLEANUP_UNCERTAIN",
): Readonly<{
	ok: false;
	code:
		| "INPUT_INVALID"
		| "READINESS_INVALID"
		| "CONNECT_FAILED"
		| "ABORTED"
		| "AUTHENTICATION_FAILED"
		| "ACTIVATION_FAILED"
		| "CLEANUP_UNCERTAIN";
}> {
	return Object.freeze({ ok: false, code });
}

function exactAbortSignal(value: unknown): value is AbortSignal {
	try {
		return (
			typeof value === "object" &&
			value !== null &&
			!types.isProxy(value) &&
			Object.getPrototypeOf(value) === AbortSignal.prototype &&
			!Object.hasOwn(value, "aborted") &&
			!Object.hasOwn(value, "addEventListener") &&
			!Object.hasOwn(value, "removeEventListener")
		);
	} catch {
		return false;
	}
}

function abortState(value: unknown): boolean | undefined {
	if (value === undefined) return false;
	try {
		return exactAbortSignal(value) ? value.aborted : undefined;
	} catch {
		return undefined;
	}
}

function exactBytes(value: unknown): value is Uint8Array {
	try {
		return (
			typeof value === "object" &&
			value !== null &&
			!types.isProxy(value) &&
			Object.getPrototypeOf(value) === Uint8Array.prototype &&
			!Object.hasOwn(value, "buffer") &&
			!Object.hasOwn(value, "byteOffset") &&
			!Object.hasOwn(value, "byteLength")
		);
	} catch {
		return false;
	}
}

async function readFrame(io: SandboxTcpIo): Promise<Uint8Array<ArrayBuffer> | undefined> {
	try {
		const header = await io.readExact(SANDBOX_TRANSPORT_HEADER_BYTES, PHASE_TIMEOUT_MS);
		if (!exactBytes(header) || header.byteLength !== SANDBOX_TRANSPORT_HEADER_BYTES) return undefined;
		const plaintextBytes = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(16, false);
		if (plaintextBytes > SANDBOX_TRANSPORT_MAX_PLAINTEXT_BYTES) {
			header.fill(0);
			return undefined;
		}
		const payload = await io.readExact(plaintextBytes + SANDBOX_TRANSPORT_TAG_BYTES, PHASE_TIMEOUT_MS);
		if (!exactBytes(payload) || payload.byteLength !== plaintextBytes + SANDBOX_TRANSPORT_TAG_BYTES) {
			header.fill(0);
			return undefined;
		}
		const wire = new Uint8Array(new ArrayBuffer(SANDBOX_TRANSPORT_HEADER_BYTES + payload.byteLength));
		wire.set(header);
		wire.set(payload, SANDBOX_TRANSPORT_HEADER_BYTES);
		header.fill(0);
		payload.fill(0);
		return wire;
	} catch {
		return undefined;
	}
}

async function settleClosed(io: SandboxTcpIo): Promise<boolean> {
	try {
		io.close();
	} catch {
		return false;
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<boolean>((resolve) => {
		timer = setTimeout(() => resolve(false), CLOSE_TIMEOUT_MS);
	});
	try {
		return await Promise.race([
			io
				.waitClosed()
				.then(() => true)
				.catch(() => false),
			timeout,
		]);
	} catch {
		return false;
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

export async function connectAndActivateSandboxRuntime(
	provider: PrimeSandboxProviderPort,
	homeIdentity: unknown,
	providerReadiness: unknown,
	signal?: AbortSignal,
): Promise<SandboxHomeConnectionResult> {
	let io: SandboxTcpIo | undefined;
	let channel: SandboxTransportChannel | undefined;
	let activation: unknown;
	let readinessLine: Uint8Array<ArrayBuffer> | undefined;
	let outboundFrame: Uint8Array<ArrayBuffer> | undefined;
	let inboundFrame: Uint8Array<ArrayBuffer> | undefined;
	let readinessCapability: unknown;
	let registeredSignal: AbortSignal | undefined;
	let abortHandler: (() => void) | undefined;
	let aborted = false;
	let result: SandboxHomeConnectionResult;
	try {
		result = await (async (): Promise<SandboxHomeConnectionResult> => {
			const initialAbort = abortState(signal);
			if (initialAbort === undefined) return failure("INPUT_INVALID");
			if (initialAbort) return failure("ABORTED");
			const copied = copySandboxRuntimeReadiness(providerReadiness);
			if (copied === undefined || copied.byteLength < 1 || copied.byteLength >= 512) {
				copied?.fill(0);
				return failure("READINESS_INVALID");
			}
			readinessLine = new Uint8Array(new ArrayBuffer(copied.byteLength + 1));
			readinessLine.set(copied);
			readinessLine[copied.byteLength] = 0x0a;
			copied.fill(0);
			const readiness = decodeSandboxReadinessBundle(readinessLine);
			if (!readiness.ok) return failure("READINESS_INVALID");
			readinessCapability = readiness.readiness;
			const connected = await provider.connectRuntime(signal);
			if (!connected.ok) return failure(abortState(signal) ? "ABORTED" : "CONNECT_FAILED");
			io = connected.value;
			if (signal !== undefined) {
				registeredSignal = signal;
				abortHandler = () => {
					aborted = true;
					try {
						io?.close();
					} catch {
						// The bounded cleanup below reports uncertainty without exposing the exception.
					}
				};
				signal.addEventListener("abort", abortHandler, { once: true });
				if (signal.aborted) abortHandler();
				if (aborted) return failure("ABORTED");
			}
			const handshake = await performSandboxHomeHandshake(io, homeIdentity, readiness.readiness);
			if (!handshake.ok) return failure(aborted ? "ABORTED" : "AUTHENTICATION_FAILED");
			channel = handshake.channel;
			const created = createSandboxHomeActivation();
			if (!created.ok) return failure("ACTIVATION_FAILED");
			activation = created.value;
			const encrypted = await encryptSandboxHomeActivation(channel, activation);
			if (!encrypted.ok) return failure("ACTIVATION_FAILED");
			outboundFrame = encrypted.value;
			const written = await io.writeExact(outboundFrame, PHASE_TIMEOUT_MS);
			outboundFrame.fill(0);
			outboundFrame = undefined;
			if (!written) return failure("ACTIVATION_FAILED");
			inboundFrame = await readFrame(io);
			if (inboundFrame === undefined) return failure("ACTIVATION_FAILED");
			const confirmed = await confirmSandboxHomeActivation(channel, activation, inboundFrame);
			inboundFrame.fill(0);
			inboundFrame = undefined;
			activation = undefined;
			if (!confirmed.ok) return failure(aborted ? "ABORTED" : "ACTIVATION_FAILED");
			if (registeredSignal !== undefined && abortHandler !== undefined) {
				registeredSignal.removeEventListener("abort", abortHandler);
				registeredSignal = undefined;
				abortHandler = undefined;
			}
			if (aborted) return failure("ABORTED");
			const connection = new SandboxHomeRuntimeConnection(ISSUE);
			connections.set(connection, Object.freeze({ io, channel }));
			io = undefined;
			channel = undefined;
			return success(connection);
		})();
	} catch {
		result = failure("INPUT_INVALID");
	}
	if (registeredSignal !== undefined && abortHandler !== undefined) {
		registeredSignal.removeEventListener("abort", abortHandler);
	}
	if (aborted && !result.ok) result = failure("ABORTED");
	if (readinessCapability !== undefined) closeSandboxReadinessBundle(readinessCapability);
	readinessLine?.fill(0);
	outboundFrame?.fill(0);
	inboundFrame?.fill(0);
	if (activation !== undefined) closeSandboxHomeActivation(activation);
	if (channel !== undefined) closeSandboxTransportChannel(channel);
	if (io !== undefined && !(await settleClosed(io))) return failure("CLEANUP_UNCERTAIN");
	return result;
}

export async function closeSandboxHomeRuntimeConnection(value: unknown): Promise<SandboxHomeConnectionCloseResult> {
	if (typeof value !== "object" || value === null) return Object.freeze({ ok: false, code: "INPUT_INVALID" });
	const state = connections.get(value);
	if (state === undefined) return Object.freeze({ ok: false, code: "INPUT_INVALID" });
	closeSandboxTransportChannel(state.channel);
	if (!(await settleClosed(state.io))) return Object.freeze({ ok: false, code: "CLEANUP_UNCERTAIN" });
	connections.delete(value);
	return Object.freeze({ ok: true, value: true });
}
