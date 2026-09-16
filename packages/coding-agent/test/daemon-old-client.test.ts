import { Socket } from "node:net";
import { expect, it, vi } from "vitest";
import { DaemonClient } from "../src/modes/daemon/daemon-client.js";
import { DAEMON_PROTOCOL_INFO, DAEMON_SCHEMA_REVISION } from "../src/modes/daemon/daemon-protocol.js";

const transport = vi.hoisted(() => ({ socket: undefined as Socket | undefined }));

vi.mock("node:net", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	createConnection: () => transport.socket,
}));

// Freeze the previous protocol11 policy, including its actual legacy-inspection allowlist.
vi.mock("../src/modes/daemon/daemon-protocol.js", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	DAEMON_PROTOCOL_VERSION: 11,
	DAEMON_LEGACY_INSPECTION_PROTOCOL_VERSIONS: [8, 9, 10],
}));

it("rejects the current daemon hello under the old protocol11 client policy before sending any command", async () => {
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
			protocol: DAEMON_PROTOCOL_INFO,
			schemaRevision: DAEMON_SCHEMA_REVISION,
			clientId: "new-server",
			serverCapabilities: [
				"native_inference_ownership",
				"canonical_session_ownership",
				"finalized_tool_exchanges",
				"cron_resume",
				"agent_results",
			],
		})}\n`,
	);
	await expect(client.waitForHello()).rejects.toThrow("incompatible daemon");
	await expect(client.request({ type: "create" })).rejects.toThrow("expected base-context.daemon protocol 11");
	await expect(client.request({ type: "cron_resume", jobId: "imported-job" })).rejects.toThrow(
		"expected base-context.daemon protocol 11",
	);
	expect(write).not.toHaveBeenCalled();
	client.close();
	vi.restoreAllMocks();
});
