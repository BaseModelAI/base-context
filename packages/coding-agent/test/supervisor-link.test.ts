import { describe, expect, it, vi } from "vitest";
import { type SupervisorClient, SupervisorLink } from "../src/modes/daemon/supervisor-link.js";

function client() {
	let onClose = () => {};
	const transport = {
		isConnected: true,
		connect: vi.fn<SupervisorClient["connect"]>().mockResolvedValue(undefined),
		waitForHello: vi.fn<SupervisorClient["waitForHello"]>(),
		onClose: vi.fn((listener: () => void) => {
			onClose = listener;
			return () => {};
		}),
		request: vi.fn<SupervisorClient["request"]>(),
		close: vi.fn(() => {
			transport.isConnected = false;
			onClose();
		}),
	};
	return transport;
}

describe("ordinary supervisor link", () => {
	it("shares one connection and handshake across concurrent callers", async () => {
		const transport = client();
		const create = vi.fn(() => transport);
		const link = new SupervisorLink(create);
		const [first, second] = await Promise.all([link.getClient(), link.getClient()]);
		expect(first).toBe(second);
		expect(create).toHaveBeenCalledTimes(1);
		expect(transport.connect).toHaveBeenCalledTimes(1);
		expect(transport.waitForHello).toHaveBeenCalledTimes(1);
		link.close();
	});

	it("reconnects only future calls and does not replay a failed mutation", async () => {
		const first = client();
		const second = client();
		const create = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
		const link = new SupervisorLink(create);
		first.request.mockRejectedValueOnce(new Error("transport closed"));
		const connected = await link.getClient();
		await expect(connected.request({ type: "shutdown" }, 100, { recoverable: false })).rejects.toThrow(
			"transport closed",
		);
		first.close();
		expect(first.request).toHaveBeenCalledTimes(1);
		expect(second.request).not.toHaveBeenCalled();
		expect(await link.getClient()).toBe(second);
		link.close();
		await expect(link.getClient()).rejects.toThrow("closed");
	});
});
