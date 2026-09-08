import type { AgentMessage, AgentOutputPolicy, AgentOutputRefusal } from "./types.js";

/** A resource refusal, never a provider response or an unknown canonical append outcome. */
export class AgentOutputLimitError extends Error {
	constructor(
		readonly refusal: AgentOutputRefusal,
		options?: ErrorOptions,
	) {
		super(
			refusal.limit === "value_encoding"
				? "Invocation output value cannot be represented as bounded JSON"
				: `Invocation output ${refusal.limit === "messages" ? "message" : "source byte"} limit exceeded`,
			options,
		);
		this.name = "AgentOutputLimitError";
	}
}

/** The existing invocation result array owns these detached values. No source/receipt store. */
export class InvocationOutput {
	readonly policy: AgentOutputPolicy;
	private sourceBytes = 2; // JSON array brackets; each later value also pays its separator.
	refusal?: AgentOutputRefusal;
	private refusalCause?: unknown;
	private slots = new WeakMap<AgentMessage, { index: number; sourceBytes: number }[]>();
	private closed = false;

	constructor(
		policy: AgentOutputPolicy,
		private messages: AgentMessage[],
	) {
		const limits = { ...policy.limits };
		if (
			!Number.isSafeInteger(limits.maxMessages) ||
			limits.maxMessages < 1 ||
			!Number.isSafeInteger(limits.maxSourceBytes) ||
			limits.maxSourceBytes < 1
		) {
			throw new Error("Invalid invocation output limits");
		}
		this.policy = {
			limits,
			snapshot: policy.snapshot.bind(policy),
			bindUpdates: policy.bindUpdates?.bind(policy),
			settleUpdates: policy.settleUpdates?.bind(policy),
		};
		if (limits.maxSourceBytes < this.sourceBytes) this.refuse("source_bytes");
	}

	private refuse(limit: AgentOutputRefusal["limit"], cause?: unknown): void {
		if (this.refusal) return;
		this.refusal = { kind: "output_limit", limit, ...this.policy.limits };
		this.refusalCause = cause;
	}

	private snapshot(message: AgentMessage, maxBytes: number) {
		try {
			const value = this.policy.snapshot(message, maxBytes);
			if (!value) this.refuse("source_bytes");
			return value;
		} catch (error) {
			this.refuse("value_encoding", error);
			return undefined;
		}
	}

	checkRoom(count: number): void {
		if (count > this.policy.limits.maxMessages - this.messages.length) this.refuse("messages");
		this.throwIfRefused();
	}

	/** Never throw a quota error through an accepted message/parallel publication. */
	capture(message: AgentMessage): void {
		if (this.refusal) return;
		if (this.messages.length === this.policy.limits.maxMessages) {
			this.refuse("messages");
			return;
		}
		const separator = this.messages.length === 0 ? 0 : 1;
		const remaining = this.policy.limits.maxSourceBytes - this.sourceBytes - separator;
		if (remaining < 0) {
			this.refuse("source_bytes");
			return;
		}
		const value = this.snapshot(message, remaining);
		if (!value) {
			this.refuse("source_bytes");
			return;
		}
		this.sourceBytes += value.sourceBytes + separator;
		const slots = this.slots.get(message) ?? [];
		slots.push({ index: this.messages.length, sourceBytes: value.sourceBytes });
		this.slots.set(message, slots);
		this.messages.push(value.message);
	}

	/** Refresh only values whose original subject this invocation actually captured. */
	refresh(message: AgentMessage): boolean {
		if (this.closed) return true;
		if (this.refusal) return false;
		const slots = this.slots.get(message);
		if (!slots) return true;
		const previous = slots.reduce((sum, slot) => sum + slot.sourceBytes, 0);
		const remaining = this.policy.limits.maxSourceBytes - this.sourceBytes + previous;
		const value = this.snapshot(message, Math.floor(remaining / slots.length));
		if (!value) return false;
		this.sourceBytes += value.sourceBytes * slots.length - previous;
		for (const slot of slots) {
			this.messages[slot.index] = value.message;
			slot.sourceBytes = value.sourceBytes;
		}
		return true;
	}

	throwIfRefused(): void {
		if (this.refusal)
			throw new AgentOutputLimitError(
				{ ...this.refusal },
				this.refusalCause === undefined ? undefined : { cause: this.refusalCause },
			);
	}

	/** A retained updater or still-live subject cannot keep this invocation's values through the slot owner. */
	dispose(): void {
		this.closed = true;
		this.slots = new WeakMap();
		this.messages = [];
		this.refusalCause = undefined;
	}

	/** Callback/terminal consumers own their copy, not the counted collector's aliases. */
	copy(): AgentMessage[] {
		this.throwIfRefused();
		return structuredClone(this.messages);
	}
}
