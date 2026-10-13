import { DaemonClient, type DaemonTransportClient } from "./daemon-client.js";

export type SupervisorClient = Pick<
	DaemonTransportClient,
	"connect" | "waitForHello" | "onClose" | "isConnected" | "request" | "close"
>;

/** Ordinary supervisor RPCs share transport, never capacity-lease ownership or mutation replay. */
export class SupervisorLink {
	private client?: SupervisorClient;
	private opening?: Promise<SupervisorClient>;
	private detachClose?: () => void;
	private closed = false;

	constructor(private readonly createClient: () => SupervisorClient) {}

	static forSocket(socketPath: string): SupervisorLink {
		return new SupervisorLink(() => new DaemonClient(socketPath));
	}

	getClient(): Promise<SupervisorClient> {
		if (this.closed) return Promise.reject(new Error("Supervisor link is closed"));
		if (this.opening) return this.opening;
		if (this.client?.isConnected) return Promise.resolve(this.client);
		this.detachClose?.();
		this.client?.close();
		const client = this.createClient();
		this.client = client;
		this.detachClose = client.onClose(() => {
			if (this.client !== client) return;
			this.client = undefined;
			this.detachClose?.();
			this.detachClose = undefined;
		});
		const opening = (async () => {
			try {
				await client.connect(1000);
				await client.waitForHello(1000);
				if (this.closed || this.client !== client || !client.isConnected)
					throw new Error("Supervisor link closed during handshake");
				return client;
			} catch (error) {
				if (this.client === client) {
					this.client = undefined;
					this.detachClose?.();
					this.detachClose = undefined;
				}
				client.close();
				throw error;
			}
		})();
		this.opening = opening;
		void opening
			.finally(() => {
				if (this.opening === opening) this.opening = undefined;
			})
			.catch(() => {});
		return opening;
	}

	close(): void {
		this.closed = true;
		this.detachClose?.();
		this.detachClose = undefined;
		this.client?.close();
		this.client = undefined;
	}
}
