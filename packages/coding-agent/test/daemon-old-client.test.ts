import { Socket } from "node:net";
import { expect, it, vi } from "vitest";
import { DaemonClient } from "../src/modes/daemon/daemon-client.js";

const transport = vi.hoisted(() => ({ socket: undefined as Socket | undefined }));

vi.mock("node:net", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	createConnection: () => transport.socket,
}));

// Freeze the shipped protocol10 policy, including its actual legacy-inspection allowlist.
vi.mock("../src/modes/daemon/daemon-protocol.js", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	DAEMON_PROTOCOL_VERSION: 10,
	DAEMON_LEGACY_INSPECTION_PROTOCOL_VERSIONS: [8, 9],
}));

it("rejects a refusal-aware protocol11 hello under the old protocol10 client policy before sending any command", async () => {
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
			protocol: { name: "base-context.daemon", version: 11 },
			schemaRevision: 30,
			clientId: "new-server",
			serverCapabilities: ["native_inference_ownership", "canonical_session_ownership", "finalized_tool_exchanges"],
		})}\n`,
	);
	await expect(client.waitForHello()).rejects.toThrow("incompatible daemon");
	await expect(client.request({ type: "create" })).rejects.toThrow("expected base-context.daemon protocol 10");
	expect(write).not.toHaveBeenCalled();
	client.close();
	vi.restoreAllMocks();
});
