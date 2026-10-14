import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DaemonCatalogClient } from "../src/modes/daemon/daemon-catalog-process.js";

function childOf(client: DaemonCatalogClient): ChildProcess {
	return (client as unknown as { child: ChildProcess }).child;
}

async function joinExit(child: ChildProcess): Promise<void> {
	if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
}

describe("daemon catalog physical stop", () => {
	it("joins the catalog process exit before stop returns", async () => {
		const client = new DaemonCatalogClient(() => {});
		await client.start();
		const child = childOf(client);
		try {
			await client.stop();
			expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
		} finally {
			await joinExit(child);
		}
	});

	it("drains a request admitted during startup and joins exit", async () => {
		const directory = await mkdtemp(join(tmpdir(), "bc-catalog-stop-fourth-"));
		const client = new DaemonCatalogClient(() => {});
		const listing = client.list(directory, directory);
		const child = childOf(client);
		const stopping = client.stop();
		try {
			await expect(client.list(directory, directory)).rejects.toThrow("shutting down");
			await expect(listing).resolves.toEqual([]);
			await stopping;
			expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
		} finally {
			await stopping;
			await joinExit(child);
			await rm(directory, { recursive: true, force: true });
		}
	});
});
