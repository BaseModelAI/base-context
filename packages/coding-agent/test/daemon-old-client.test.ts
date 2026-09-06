import { Socket } from "node:net";
import { expect, it, vi } from "vitest";
import { DaemonClient } from "../src/modes/daemon/daemon-client.js";

const transport = vi.hoisted(() => ({ socket: undefined as Socket | undefined }));

vi.mock("node:net", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	createConnection: () => transport.socket,
}));

// Freeze the shipped Base8 handshake policy: only the exact product/version pair was accepted.
// Equal current/inspection versions retain that old equality rule in the shared parser.
vi.mock("../src/modes/daemon/daemon-protocol.js", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	DAEMON_PROTOCOL_VERSION: 8,
	DAEMON_LEGACY_INSPECTION_PROTOCOL_VERSION: 8,
}));

it("rejects a native9 server hello under the old Base8 client policy before sending any command", async () => {
	const socket = new Socket(); // Unconnected; createConnection is fully mocked.
	transport.socket = socket;
	const write = vi.spyOn(socket, "write").mockReturnValue(true);
	const client = new DaemonClient("/tmp/base-old-client.sock");
	const connected = client.connect();
	socket.emit("connect");
	await connected;
	socket.emit(
		"data",
		`${JSON.stringify({
			type: "daemon_hello",
			protocol: { name: "base-context.daemon", version: 9 },
			schemaRevision: 28,
			clientId: "new-server",
			serverCapabilities: ["native_inference_ownership", "finalized_tool_exchanges"],
		})}\n`,
	);
	await expect(client.waitForHello()).rejects.toThrow("incompatible daemon");
	await expect(client.request({ type: "create" })).rejects.toThrow("expected base-context.daemon protocol 8");
	expect(write).not.toHaveBeenCalled();
	client.close();
	vi.restoreAllMocks();
});
