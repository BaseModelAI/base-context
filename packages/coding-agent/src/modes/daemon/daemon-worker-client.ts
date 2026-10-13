import { createConnection, type Socket } from "node:net";
import { validateCompletionTimeout, withCompletionDeadline } from "../../core/completion.js";
import { serializeJsonLine } from "../rpc/jsonl.js";
import { type PrivateFrame, PrivateFramedChannel } from "../session-worker/private-framing.js";
import {
	DaemonCapabilityUnavailableError,
	type DaemonClientMessageListener,
	type DaemonClientRequestOptions,
	DaemonSocketClosedError,
} from "./daemon-client.js";
import {
	DAEMON_COMMAND_COMPATIBILITY,
	DAEMON_LEGACY_INSPECTION_PROTOCOL_VERSIONS,
	DAEMON_PROTOCOL_NAME,
	DAEMON_PROTOCOL_VERSION,
	type DaemonClosingReason,
	type DaemonCommand,
	type DaemonCommandCompatibility,
	type DaemonOutbound,
	type DaemonPeerTransportTicket,
	type DaemonResponse,
	type DaemonServerCapability,
	getDaemonCommandCompatibilities,
	meetsDaemonCommandCompatibility,
	NATIVE_WORK_COMPATIBILITIES,
} from "./daemon-protocol.js";
import {
	DAEMON_WORKER_COMMAND_COMPATIBILITY,
	type DaemonPeerCommand,
	type DaemonPeerCommandBody,
	type DaemonWorkerCommand,
	type DaemonWorkerCommandBody,
	type DaemonWorkerFrameHeader,
	isDaemonWorkerFrameHeader,
} from "./daemon-worker-protocol.js";

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
type DaemonCommandBody = DistributiveOmit<DaemonCommand, "id">;
type DaemonWorkerWireCommandBody = DaemonCommandBody | DaemonWorkerCommandBody | DaemonPeerCommandBody;
type DaemonWorkerWireCommand = DaemonCommand | DaemonWorkerCommand | DaemonPeerCommand;
type DaemonWorkerAuthentication = Omit<Extract<DaemonWorkerCommand, { type: "worker_auth" }>, "id" | "type" | "token">;

export type DaemonWorkerFrameListener = (frame: PrivateFrame<DaemonWorkerFrameHeader>) => void;
export type DaemonWorkerCloseListener = (error: Error) => void;
type DaemonHello = Extract<DaemonOutbound, { type: "daemon_hello" }>;
const MAX_REQUEST_TIMEOUT_MS = 2_147_483_647;

export class DaemonWorkerAuthenticationError extends Error {}

/** A live incompatible owner is not a dead worker or a retryable probe timeout. */
export class DaemonWorkerCompatibilityError extends Error {
	constructor(hello: DaemonHello) {
		super(
			`Daemon worker ${hello.protocol.name} protocol ${hello.protocol.version} cannot provide canonical session ownership, native inference ownership, and bounded invocation output. Keep its live owner intact; update or stop it with its own runtime before recovery.`,
		);
		this.name = "DaemonWorkerCompatibilityError";
	}
}

/** A probe (hello/response/connect) timed out; recovery treats the worker as live-but-slow, never dead. */
export class DaemonWorkerProbeTimeoutError extends Error {}

export class DaemonWorkerClient {
	private socket?: Socket;
	private channel?: PrivateFramedChannel<DaemonWorkerFrameHeader>;
	private readonly frameListeners = new Set<DaemonWorkerFrameListener>();
	private readonly messageListeners = new Set<DaemonClientMessageListener>();
	private readonly closeListeners = new Set<DaemonWorkerCloseListener>();
	private readonly pending = new Map<
		string,
		{
			resolve: (response: DaemonResponse) => void;
			reject: (error: Error) => void;
			timeout: ReturnType<typeof setTimeout>;
		}
	>();
	private requestId = 0;
	private helloMessage?: DaemonHello;
	private compatibilityError?: DaemonWorkerCompatibilityError;
	private closeCause?: Error;
	private directPeer = false;
	private directClosingReason?: DaemonClosingReason;
	private readonly helloWaiters = new Set<{
		resolve: (hello: DaemonHello) => void;
		reject: (error: Error) => void;
		timeout: ReturnType<typeof setTimeout>;
	}>();

	constructor(private readonly socketPath: string) {}

	get hello(): DaemonHello | undefined {
		return this.helloMessage;
	}

	get isConnected(): boolean {
		return this.socket !== undefined && !this.socket.destroyed;
	}

	supportsServerCapability(capability: DaemonServerCapability): boolean {
		return this.helloMessage?.serverCapabilities?.includes(capability) === true;
	}

	async connect(timeoutMs = 3000): Promise<void> {
		if (this.socket) {
			throw new Error("Daemon worker client is already connected");
		}
		this.closeCause = undefined;
		const socket = createConnection(this.socketPath);
		this.socket = socket;
		this.channel = new PrivateFramedChannel(socket, isDaemonWorkerFrameHeader);
		this.channel.onFrame((frame) => this.handleFrame(frame));

		await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => {
				cleanup();
				this.clearSocketReference(socket);
				socket.destroy();
				reject(new Error(`Timed out connecting to daemon worker socket: ${this.socketPath}`));
			}, timeoutMs);
			const cleanup = () => {
				clearTimeout(timeout);
				socket.off("connect", onConnect);
				socket.off("error", onError);
			};
			const onConnect = () => {
				cleanup();
				resolve();
			};
			const onError = (error: Error) => {
				cleanup();
				this.clearSocketReference(socket);
				reject(error);
			};
			socket.once("connect", onConnect);
			socket.once("error", onError);
		});

		socket.on("error", (error) => this.notifyClosed(socket, this.directCloseError(error)));
		socket.on("close", () =>
			this.notifyClosed(socket, this.directCloseError(new Error("Daemon worker socket closed"))),
		);
	}

	async waitForHello(timeoutMs = 3000, signal?: AbortSignal): Promise<DaemonHello> {
		signal?.throwIfAborted();
		if (this.closeCause) throw this.closeCause;
		if (this.compatibilityError) throw this.compatibilityError;
		if (this.helloMessage) return this.helloMessage;
		if (!this.socket || this.socket.destroyed) {
			throw new Error("Daemon worker client is not connected");
		}
		let abort: (() => void) | undefined;
		const hello = new Promise<DaemonHello>((resolve, reject) => {
			const waiter = {
				resolve,
				reject,
				timeout: setTimeout(() => {
					this.helloWaiters.delete(waiter);
					reject(new DaemonWorkerProbeTimeoutError("Timed out waiting for daemon worker hello"));
				}, timeoutMs),
			};
			this.helloWaiters.add(waiter);
			abort = () => {
				clearTimeout(waiter.timeout);
				this.helloWaiters.delete(waiter);
				reject(signal?.reason);
			};
			signal?.addEventListener("abort", abort, { once: true });
		});
		return hello.finally(() => {
			if (abort) signal?.removeEventListener("abort", abort);
		});
	}

	onFrame(listener: DaemonWorkerFrameListener): () => void {
		this.frameListeners.add(listener);
		return () => this.frameListeners.delete(listener);
	}

	onMessage(listener: DaemonClientMessageListener): () => void {
		this.messageListeners.add(listener);
		return () => this.messageListeners.delete(listener);
	}

	onClose(listener: DaemonWorkerCloseListener): () => void {
		this.closeListeners.add(listener);
		return () => this.closeListeners.delete(listener);
	}

	async request(
		command: DaemonCommandBody,
		timeoutMs = 30_000,
		// Progress/recovery options are supervisor-transport features; a direct request fails fast instead of replaying (no double execution).
		options: DaemonClientRequestOptions & { signal?: AbortSignal } = {},
	): Promise<DaemonResponse> {
		if (command.type === "wait_for_headless_completion") {
			validateCompletionTimeout(command.timeoutMs);
			return withCompletionDeadline((signal) => this.requestUntilResponse(command, timeoutMs, signal), {
				timeoutMs: command.timeoutMs === undefined ? undefined : command.timeoutMs + 1000,
				signal: options.signal,
				getBlockers: () => [{ kind: "worker_response", id: command.activeSessionId }],
			});
		}
		return this.requestUntilResponse(command, timeoutMs, options.signal);
	}

	private async requestUntilResponse(
		command: DaemonCommandBody,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<DaemonResponse> {
		const startedAt = performance.now();
		const hello = await this.waitForHello(3000, signal);
		const missing = getDaemonCommandCompatibilities(command).find(
			(requirement) => !meetsDaemonCommandCompatibility(hello, requirement),
		);
		if (missing) throw new DaemonCapabilityUnavailableError(command.type, missing.capability);
		const admissionElapsedMs = performance.now() - startedAt;
		if (command.type === "wait_for_headless_completion" && command.timeoutMs !== undefined) {
			command = { ...command, timeoutMs: Math.max(0, command.timeoutMs - admissionElapsedMs) };
		}
		const response = await this.requestWire(command, timeoutMs, signal);
		if (!response.success && response.errorInfo?.code === "completion_wait_timeout") {
			return {
				...response,
				errorInfo: { ...response.errorInfo, elapsedMs: performance.now() - startedAt },
			};
		}
		return response;
	}

	async requestWorker(command: DaemonWorkerCommandBody, timeoutMs = 30_000): Promise<DaemonResponse> {
		await this.requireNativeOwner();
		const compatibilities: Partial<Record<DaemonWorkerCommand["type"], DaemonCommandCompatibility>> =
			DAEMON_WORKER_COMMAND_COMPATIBILITY;
		const requirement =
			compatibilities[command.type] ??
			(command.type === "worker_deliver_result" ? DAEMON_COMMAND_COMPATIBILITY.send_result : undefined);
		if (requirement && !meetsDaemonCommandCompatibility(await this.waitForHello(), requirement)) {
			throw new DaemonCapabilityUnavailableError(command.type, requirement.capability);
		}
		return this.requestWire(command, timeoutMs);
	}

	private async requireNativeOwner(): Promise<void> {
		const hello = await this.waitForHello();
		if (!NATIVE_WORK_COMPATIBILITIES.every((requirement) => meetsDaemonCommandCompatibility(hello, requirement))) {
			throw new DaemonWorkerCompatibilityError(hello);
		}
	}

	async authenticateWorker(
		token: string,
		owner: DaemonWorkerAuthentication,
		timeoutMs = 3000,
	): Promise<Extract<DaemonResponse, { success: true }>> {
		const response = await this.requestWorker({ type: "worker_auth", token, ...owner }, timeoutMs);
		if (!response.success) {
			throw new DaemonWorkerAuthenticationError(response.error);
		}
		return response;
	}

	async authenticatePeer(ticket: DaemonPeerTransportTicket, timeoutMs = 3000): Promise<void> {
		await this.requireNativeOwner();
		const response = await this.requestWire(
			{
				type: "peer_auth",
				grantId: ticket.grantId,
				token: ticket.token,
				workerInstanceId: ticket.workerInstanceId,
				purpose: ticket.purpose,
			},
			timeoutMs,
		);
		if (!response.success) {
			throw new Error(response.error);
		}
		this.directPeer = true;
	}

	close(cause?: Error): void {
		this.closeCause ??= cause;
		this.rejectAll(this.closeCause ?? new Error("Daemon worker client closed"));
		this.channel?.close();
		this.channel = undefined;
		this.socket?.destroy();
		this.socket = undefined;
		this.directPeer = false;
		this.directClosingReason = undefined;
	}

	private async requestWire(
		command: DaemonWorkerWireCommandBody,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<DaemonResponse> {
		signal?.throwIfAborted();
		if (!this.channel || !this.socket || this.socket.destroyed) {
			throw this.closeCause ?? new Error("Daemon worker client is not connected");
		}
		const id = `worker_${++this.requestId}`;
		const startedAt = Date.now();
		const fullCommand = { ...command, id } as DaemonWorkerWireCommand;
		const response = new Promise<DaemonResponse>((resolve, reject) => {
			const onTimeout = () => {
				const elapsedMs = Math.max(0, Date.now() - startedAt);
				const remainingMs = timeoutMs - elapsedMs;
				if (remainingMs > 0) {
					const pending = this.pending.get(id);
					if (pending) pending.timeout = setTimeout(onTimeout, Math.min(remainingMs, MAX_REQUEST_TIMEOUT_MS));
					return;
				}
				this.pending.delete(id);
				const startupDetails = command.type === "create" ? " lastStartupPhase: unknown." : "";
				reject(
					new DaemonWorkerProbeTimeoutError(
						`Timed out waiting for daemon worker response to ${command.type}. Request ID: ${id}; elapsedMs: ${elapsedMs}.${startupDetails} Socket: ${this.socketPath}.`,
					),
				);
			};
			const timeout = setTimeout(onTimeout, Math.min(timeoutMs, MAX_REQUEST_TIMEOUT_MS));
			this.pending.set(id, { resolve, reject, timeout });
		});
		const abort = () => {
			const pending = this.pending.get(id);
			if (!pending) return;
			clearTimeout(pending.timeout);
			this.pending.delete(id);
			pending.reject(signal?.reason);
		};
		signal?.addEventListener("abort", abort, { once: true });
		// A blocked socket write must not postpone the response timeout or connection-close rejection.
		void this.channel
			.send(
				{ kind: "command", requestId: id, commandType: command.type },
				Buffer.from(serializeJsonLine(fullCommand)),
			)
			.catch((error: unknown) => {
				const pending = this.pending.get(id);
				if (pending) {
					clearTimeout(pending.timeout);
					this.pending.delete(id);
					pending.reject(error instanceof Error ? error : new Error(String(error)));
				}
			});
		return response.finally(() => signal?.removeEventListener("abort", abort));
	}

	private handleFrame(frame: PrivateFrame<DaemonWorkerFrameHeader>): void {
		if (frame.header.kind !== "outbound") {
			return;
		}
		if (frame.header.outboundType === "response" && frame.header.requestId) {
			const pending = this.pending.get(frame.header.requestId);
			if (pending) {
				let response: unknown;
				try {
					response = JSON.parse(frame.payload.toString("utf8"));
				} catch (error) {
					clearTimeout(pending.timeout);
					this.pending.delete(frame.header.requestId);
					pending.reject(new Error(`Invalid daemon worker response: ${String(error)}`));
					return;
				}
				if (isDaemonResponse(response)) {
					clearTimeout(pending.timeout);
					this.pending.delete(frame.header.requestId);
					pending.resolve(response);
					return;
				}
			}
		}
		if (frame.header.outboundType === "daemon_hello") {
			try {
				const parsed = JSON.parse(frame.payload.toString("utf8")) as DaemonOutbound;
				if (parsed.type === "daemon_hello") {
					if (
						parsed.protocol.name !== DAEMON_PROTOCOL_NAME ||
						(parsed.protocol.version !== DAEMON_PROTOCOL_VERSION &&
							!DAEMON_LEGACY_INSPECTION_PROTOCOL_VERSIONS.includes(parsed.protocol.version))
					) {
						this.compatibilityError = new DaemonWorkerCompatibilityError(parsed);
						this.close(this.compatibilityError);
						return;
					}
					this.helloMessage = parsed;
					for (const waiter of [...this.helloWaiters]) {
						clearTimeout(waiter.timeout);
						this.helloWaiters.delete(waiter);
						waiter.resolve(parsed);
					}
				}
			} catch {
				// Invalid hello payloads are rejected by the timeout.
			}
		}
		for (const listener of this.frameListeners) {
			listener(frame);
		}
		if (this.directPeer && frame.header.outboundType !== "daemon_hello" && frame.header.outboundType !== "response") {
			this.emitDirectOutbound(frame);
		}
	}

	/** A malformed outbound frame closes the direct link (the routed client falls back) instead of throwing into consumers. */
	private emitDirectOutbound(frame: PrivateFrame<DaemonWorkerFrameHeader>): void {
		if (frame.header.kind !== "outbound") return;
		let message: DaemonOutbound;
		try {
			if (frame.header.payloadEncoding !== undefined && frame.header.payloadEncoding !== "jsonl") {
				throw new Error(`Direct worker sent an unsupported payload encoding: ${frame.header.payloadEncoding}`);
			}
			const parsed = JSON.parse(frame.payload.toString("utf8")) as unknown;
			if (!parsed || typeof parsed !== "object" || typeof (parsed as { type?: unknown }).type !== "string") {
				throw new Error("Direct worker sent an invalid outbound payload");
			}
			message = parsed as DaemonOutbound;
		} catch (error) {
			const socket = this.socket;
			const directError = this.directCloseError(error instanceof Error ? error : new Error(String(error)));
			if (socket) {
				this.notifyClosed(socket, directError);
				socket.destroy(directError);
			}
			return;
		}
		if (message.type === "daemon_closing") {
			this.directClosingReason = message.reason;
		}
		for (const listener of [...this.messageListeners]) {
			listener(message);
		}
	}

	private directCloseError(cause: Error): Error {
		return this.directPeer
			? new DaemonSocketClosedError(this.socketPath, this.directClosingReason, cause.message)
			: cause;
	}

	private rejectAll(error: Error): void {
		for (const [id, pending] of this.pending) {
			clearTimeout(pending.timeout);
			pending.reject(error);
			this.pending.delete(id);
		}
		for (const waiter of [...this.helloWaiters]) {
			clearTimeout(waiter.timeout);
			this.helloWaiters.delete(waiter);
			waiter.reject(error);
		}
	}

	private clearSocketReference(socket: Socket): void {
		if (this.socket !== socket) return;
		this.socket = undefined;
		this.channel = undefined;
	}

	private notifyClosed(socket: Socket, error: Error): void {
		if (this.socket !== socket) {
			return;
		}
		this.socket = undefined;
		this.channel = undefined;
		this.directPeer = false;
		this.directClosingReason = undefined;
		this.closeCause ??= error;
		this.rejectAll(this.closeCause);
		for (const listener of [...this.closeListeners]) {
			listener(this.closeCause);
		}
	}
}

function isDaemonResponse(value: unknown): value is DaemonResponse {
	if (!value || typeof value !== "object") {
		return false;
	}
	const candidate = value as { type?: unknown; command?: unknown; success?: unknown };
	return (
		candidate.type === "response" && typeof candidate.command === "string" && typeof candidate.success === "boolean"
	);
}
