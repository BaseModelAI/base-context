import { type ChildProcess, execFileSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RlmJournalOwner } from "../src/core/rlm-journal-owner.js";
import { RlmSpawnLedger, rlmLedgerPath } from "../src/modes/daemon/rlm-ledger.js";
import type { RlmLedgerMutation } from "../src/modes/daemon/rlm-ledger-mutations.js";

function actor(owner: RlmJournalOwner): ChildProcess {
	return (owner as unknown as { child: ChildProcess }).child;
}

describe("RLM journal owner process", () => {
	let nodeExecutable: string;
	let root: string;
	let options: { agentDir: string; sessionsDir: string; journalPath: string };
	let spawn: Extract<RlmLedgerMutation, { op: "spawn" }>;
	let reader: RlmSpawnLedger;
	const owners: RlmJournalOwner[] = [];

	async function open(journalPath = options.journalPath): Promise<RlmJournalOwner> {
		const owner = await RlmJournalOwner.open({ ...options, journalPath, nodeExecutable });
		owners.push(owner);
		return owner;
	}

	beforeAll(() => {
		const exactFloor = process.env.BCTX_TEST_NODE22;
		nodeExecutable = exactFloor ?? process.execPath;
		const version = execFileSync(nodeExecutable, ["--version"], { encoding: "utf8" }).trim();
		expect(version).toBe(exactFloor === undefined ? process.version : "v22.8.0");
		console.info(`RLM journal-owner tests: ${version} (${exactFloor === undefined ? "host Node" : "exact floor"})`);
	});

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "bctx-rlm-journal-owner-"));
		const sessionsDir = join(root, "sessions");
		mkdirSync(sessionsDir);
		options = { agentDir: root, sessionsDir, journalPath: rlmLedgerPath(root, sessionsDir) };
		spawn = {
			op: "spawn",
			childId: "sub-11111111",
			parent: join(sessionsDir, "parent.jsonl"),
			child: join(root, "child.jsonl"),
			depth: 1,
			name: "worker",
		};
		reader = new RlmSpawnLedger(root, sessionsDir);
	});

	afterEach(async () => {
		for (const owner of owners.splice(0)) {
			const child = actor(owner);
			if (child.exitCode === null && child.signalCode === null) {
				const exited = once(child, "exit");
				child.kill("SIGKILL");
				await exited;
			}
			await owner.close().catch(() => {});
		}
		rmSync(root, { recursive: true, force: true });
	});

	it("writes durably, excludes aliases, drains close, hands off ownership, and explicitly migrates legacy", async () => {
		const owner = await open();
		expect(actor(owner).spawnfile).toBe(nodeExecutable);
		expect(actor(owner).pid).not.toBe(process.pid);
		expect(owner.ledgerPath).toBe(options.journalPath);
		await owner.mutate(spawn);
		await expect(reader.edges()).resolves.toEqual([
			{
				childId: spawn.childId,
				parent: spawn.parent,
				child: spawn.child,
				depth: spawn.depth,
				name: spawn.name,
			},
		]);

		const aliasDir = join(root, "journal-alias");
		symlinkSync(dirname(owner.ledgerPath), aliasDir, process.platform === "win32" ? "junction" : "dir");
		await expect(open(join(aliasDir, basename(owner.ledgerPath)))).rejects.toThrow(/database (?:is )?locked/i);

		const admitted = owner.mutate({ op: "rename_by_path", child: spawn.child, name: "drained" });
		const exited = once(actor(owner), "exit");
		const closing = owner.close();
		const refused = expect(
			owner.mutate({ op: "rename_by_path", child: spawn.child, name: "not-admitted" }),
		).rejects.toThrow(/clos|admission/i);
		await Promise.all([admitted, closing, refused]);
		expect(await exited).toEqual([0, null]);
		await expect(reader.edges()).resolves.toEqual([expect.objectContaining({ name: "drained" })]);

		const successor = await open();
		await successor.recover();
		await successor.mutate({ op: "delete_by_path", child: spawn.child, reason: "user" });
		await expect(reader.edges()).resolves.toEqual([]);
		await expect(reader.edges(true)).resolves.toEqual([
			expect.objectContaining({ childId: spawn.childId, name: "drained", deleted: "user" }),
		]);
		await successor.close();
		expect(actor(successor).exitCode).toBe(0);

		const at = "2026-01-01T00:00:00.000Z";
		const legacyBytes = Buffer.from(
			`${JSON.stringify({ v: 1, op: "meta", at, sessionsDir: options.sessionsDir })}\n${JSON.stringify({ v: 1, at, ...spawn })}\n`,
		);
		writeFileSync(options.journalPath, legacyBytes);
		const legacyOwner = await open();
		expect(readFileSync(options.journalPath)).toEqual(legacyBytes);
		expect(existsSync(`${options.journalPath}.legacy-v1`)).toBe(false);
		await expect(
			legacyOwner.mutate({ op: "rename_by_path", child: spawn.child, name: "not-migrated" }),
		).rejects.toThrow(/migrat/i);
		expect(readFileSync(options.journalPath)).toEqual(legacyBytes);
		await legacyOwner.migrateLegacy();
		const migratedReader = new RlmSpawnLedger(options.agentDir, options.sessionsDir);
		await expect(migratedReader.edges()).resolves.toEqual([
			expect.objectContaining({ childId: spawn.childId, name: "worker" }),
		]);
		await legacyOwner.mutate({ op: "rename_by_path", child: spawn.child, name: "after-migration" });
		await expect(migratedReader.edges()).resolves.toEqual([expect.objectContaining({ name: "after-migration" })]);
		expect(readFileSync(`${options.journalPath}.legacy-v1`)).toEqual(legacyBytes);
		await legacyOwner.close();
		expect(actor(legacyOwner).exitCode).toBe(0);
	});

	it.skipIf(process.platform === "win32")(
		"POSIX: rejects an unacknowledged mutation after SIGKILL and releases ownership on IPC disconnect",
		async () => {
			const owner = await open();
			await owner.mutate(spawn);
			const child = actor(owner);
			// Stop before sending so the actor cannot acknowledge the pending mutation.
			expect(child.kill("SIGSTOP")).toBe(true);
			const pending = owner.mutate({ op: "rename_by_path", child: spawn.child, name: "uncertain" });
			const rejected = expect(pending).rejects.toThrow(/outcome.*unknown/i);
			const exited = once(child, "exit");
			expect(child.kill("SIGKILL")).toBe(true);
			await rejected;
			expect(await exited).toEqual([null, "SIGKILL"]);
			await expect(owner.close()).resolves.toBeUndefined();
			await expect(
				owner.mutate({ op: "rename_by_path", child: spawn.child, name: "after-death" }),
			).rejects.toThrow();

			// A lost acknowledgement is not permission to retry the same mutation.
			const successor = await open();
			const nextSpawn = { ...spawn, childId: "sub-22222222", child: join(root, "next.jsonl"), name: "next" };
			await successor.mutate(nextSpawn);
			const edges = await reader.edges();
			expect(edges).toHaveLength(2);
			expect(edges[0]).toMatchObject({ childId: spawn.childId, child: spawn.child });
			expect(["worker", "uncertain"]).toContain(edges[0].name);
			expect(edges[1]).toMatchObject({ childId: nextSpawn.childId, name: "next" });

			const disconnected = once(actor(successor), "exit");
			actor(successor).disconnect();
			expect(await disconnected).toEqual([0, null]);
			await expect(successor.close()).resolves.toBeUndefined();
			const afterDisconnect = await open();
			await afterDisconnect.mutate({ op: "delete_by_path", child: nextSpawn.child, reason: "user" });
			await expect(reader.edges()).resolves.toEqual([expect.objectContaining({ childId: spawn.childId })]);
			await afterDisconnect.close();
			expect(actor(afterDisconnect).exitCode).toBe(0);
		},
	);
});
