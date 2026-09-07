import { type ChildProcess, execFileSync } from "node:child_process";
import { once } from "node:events";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { decodeJournalFrame, encodeJournalFrameJson, INITIAL_JOURNAL_CURSOR } from "../src/core/journal-frame.js";
import {
	SESSION_JOURNAL_MAX_FRAME_BYTES,
	SESSION_JOURNAL_MAX_RECORD_BYTES,
	SessionJournalOwner,
} from "../src/core/session-journal-owner.js";

function actor(owner: SessionJournalOwner): ChildProcess {
	return (owner as unknown as { child: ChildProcess }).child;
}

function framedJson(path: string): string[] {
	const lines = readFileSync(path, "utf8").split("\n");
	expect(lines.pop()).toBe("");
	let cursor = INITIAL_JOURNAL_CURSOR;
	return lines.map((line) => {
		const frame = decodeJournalFrame(Buffer.from(`${line}\n`), cursor, SESSION_JOURNAL_MAX_FRAME_BYTES);
		cursor = frame.next;
		return frame.json;
	});
}

const header = '{"type":"session","version":3,"id":"owner-test","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/test"}';
const lexical =
	'{ "type":"message", "id":"entry", "parentId":null, "value":1e+03, "negativeZero":-0, "escaped":"\\u0061" }';

describe("session journal owner process", () => {
	let nodeExecutable: string;
	let root: string;
	let journalPath: string;
	const owners: SessionJournalOwner[] = [];

	async function open(path = journalPath, create = false): Promise<SessionJournalOwner> {
		const owner = await SessionJournalOwner.open({
			journalPath: path,
			nodeExecutable,
			...(create ? { create: true as const } : {}),
		});
		owners.push(owner);
		return owner;
	}

	beforeAll(() => {
		const exactFloor = process.env.BCTX_TEST_NODE22;
		nodeExecutable = exactFloor ?? process.execPath;
		const version = execFileSync(nodeExecutable, ["--version"], { encoding: "utf8" }).trim();
		expect(version).toBe(exactFloor === undefined ? process.version : "v22.8.0");
		console.info(
			`Session journal-owner tests: ${version} (${exactFloor === undefined ? "host Node" : "exact floor"})`,
		);
	});

	beforeEach(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "bctx-session-journal-owner-")));
		journalPath = join(root, "session.jsonl");
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

	it("creates without clobbering, excludes aliases, transports multi-MB JSON, drains close, and hands off ownership", async () => {
		expect(SESSION_JOURNAL_MAX_RECORD_BYTES).toBe(64 * 1024 * 1024);
		expect(SESSION_JOURNAL_MAX_FRAME_BYTES).toBe(SESSION_JOURNAL_MAX_RECORD_BYTES + 256);
		await expect(open()).rejects.toThrow();
		expect(existsSync(journalPath)).toBe(false);
		await expect(SessionJournalOwner.remove({ journalPath, nodeExecutable })).resolves.toMatchObject({ ok: true });
		expect(existsSync(journalPath)).toBe(false);

		const owner = await open(journalPath, true);
		expect(actor(owner).spawnfile).toBe(nodeExecutable);
		expect(actor(owner).pid).not.toBe(process.pid);
		expect(owner.journalPath).toBe(journalPath);
		expect(owner.format).toBe("framed");
		expect(owner.nextSequence).toBe(0);
		expect(existsSync(`${journalPath}.owner.sqlite`)).toBe(true);
		await expect(owner.appendJson(header)).resolves.toEqual({ sequence: 0 });
		const prefix = readFileSync(journalPath);

		const aliasDir = join(root, "journal-alias");
		symlinkSync(dirname(journalPath), aliasDir, process.platform === "win32" ? "junction" : "dir");
		await expect(open(join(aliasDir, basename(journalPath)))).rejects.toThrow(/database (?:is )?locked/i);
		await expect(
			SessionJournalOwner.remove({ journalPath: join(aliasDir, basename(journalPath)), nodeExecutable }),
		).rejects.toThrow(/database (?:is )?locked/i);
		expect(readFileSync(journalPath)).toEqual(prefix);

		// UTF-8 code points cross the 64 KiB transport chunk boundaries.
		const large = JSON.stringify({ type: "message", id: "large", text: "界🙂".repeat(460_000) });
		expect(Buffer.byteLength(large)).toBeGreaterThan(3 * 1024 * 1024);
		await expect(owner.appendJson(large)).resolves.toEqual({ sequence: 1 });
		await owner.flush();
		expect(readFileSync(journalPath).subarray(0, prefix.length)).toEqual(prefix);
		expect(framedJson(journalPath)).toEqual([header, large]);
		expect(owner.nextSequence).toBe(2);

		const admitted = owner.appendJson(lexical);
		const exited = once(actor(owner), "exit");
		const closing = owner.close();
		const refused = expect(owner.appendJson('{"id":"not-admitted"}')).rejects.toThrow(/clos|admission/i);
		const [ack] = await Promise.all([admitted, closing, refused]);
		expect(ack).toEqual({ sequence: 2 });
		expect(await exited).toEqual([0, null]);
		expect(framedJson(journalPath)).toEqual([header, large, lexical]);

		const retained = readFileSync(journalPath);
		await expect(open(journalPath, true)).rejects.toThrow(/exist|clobber/i);
		expect(readFileSync(journalPath).equals(retained)).toBe(true);
		const successor = await open(join(aliasDir, basename(journalPath)));
		expect(successor.journalPath).toBe(journalPath);
		expect(successor.nextSequence).toBe(3);
		const next = '{"type":"message","id":"successor"}';
		await expect(successor.appendJson(next)).resolves.toEqual({ sequence: 3 });
		await successor.close();
		expect(actor(successor).exitCode).toBe(0);
		expect(readFileSync(journalPath).subarray(0, retained.length).equals(retained)).toBe(true);
		expect(framedJson(journalPath)).toEqual([header, large, lexical, next]);
		await expect(
			SessionJournalOwner.remove({ journalPath: join(aliasDir, basename(journalPath)), nodeExecutable }),
		).resolves.toMatchObject({ ok: true });
		expect(existsSync(journalPath)).toBe(false);
		expect(existsSync(`${journalPath}.owner.sqlite`)).toBe(true);
	});

	it("retains legacy bytes, requires explicit torn-tail repair, rejects complete corruption, and survives POSIX owner death", async () => {
		const original = Buffer.from(`${header}\n${lexical}\n{"type":"message","id":"torn"`);
		writeFileSync(journalPath, original);
		const legacy = await open();
		expect(legacy.format).toBe("legacy");
		expect(readFileSync(journalPath)).toEqual(original);
		expect(existsSync(`${journalPath}.legacy-v3`)).toBe(false);
		await expect(legacy.appendJson('{"id":"not-migrated"}')).rejects.toThrow(/migrat|legacy/i);
		expect(readFileSync(journalPath)).toEqual(original);
		await legacy.migrateLegacy();
		expect(legacy.format).toBe("framed");
		expect(legacy.nextSequence).toBe(2);
		expect(readFileSync(`${journalPath}.legacy-v3`)).toEqual(original);
		expect(framedJson(journalPath)).toEqual([header, lexical]);
		const migrated = '{"type":"message","id":"after-migration"}';
		await expect(legacy.appendJson(migrated)).resolves.toEqual({ sequence: 2 });
		await legacy.close();
		expect(framedJson(journalPath)).toEqual([header, lexical, migrated]);
		expect(readFileSync(`${journalPath}.legacy-v3`)).toEqual(original);

		const first = encodeJournalFrameJson(header, INITIAL_JOURNAL_CURSOR, SESSION_JOURNAL_MAX_FRAME_BYTES);
		const second = encodeJournalFrameJson(lexical, first.next, SESSION_JOURNAL_MAX_FRAME_BYTES);
		const tornPath = join(root, "torn.jsonl");
		const tornBytes = Buffer.from(first.line + second.line.slice(0, -10));
		writeFileSync(tornPath, tornBytes);
		const torn = await open(tornPath);
		expect(torn.format).toBe("framed");
		expect(torn.nextSequence).toBe(1);
		expect(readFileSync(tornPath)).toEqual(tornBytes);
		await expect(torn.appendJson(lexical)).rejects.toThrow(/recover|repair|tail/i);
		expect(readFileSync(tornPath)).toEqual(tornBytes);
		await torn.recover();
		expect(readFileSync(tornPath)).toEqual(Buffer.from(first.line));
		await expect(torn.appendJson(lexical)).resolves.toEqual({ sequence: 1 });
		await torn.close();
		expect(framedJson(tornPath)).toEqual([header, lexical]);

		const corruptPath = join(root, "corrupt.jsonl");
		const corruptBytes = Buffer.from(first.line.replace('"version":3', '"version":4') + second.line);
		writeFileSync(corruptPath, corruptBytes);
		await expect(open(corruptPath)).rejects.toThrow(/checksum|corrupt|invalid/i);
		expect(readFileSync(corruptPath)).toEqual(corruptBytes);
		await expect(SessionJournalOwner.remove({ journalPath: corruptPath, nodeExecutable })).resolves.toMatchObject({
			ok: true,
		});
		expect(existsSync(corruptPath)).toBe(false);

		const replacedPath = join(root, "replaced.jsonl");
		const replacementPath = join(root, "replacement.jsonl");
		writeFileSync(replacedPath, first.line);
		const replaced = await open(replacedPath);
		// Identical bytes and size do not make a different inode the admitted source.
		writeFileSync(replacementPath, first.line);
		renameSync(replacementPath, replacedPath);
		await expect(replaced.appendJson(lexical)).rejects.toThrow(/file identity changed/i);
		await expect(replaced.recover()).rejects.toThrow(/file identity changed/i);
		expect(readFileSync(replacedPath)).toEqual(Buffer.from(first.line));
		await replaced.close();

		if (process.platform === "win32") {
			console.info("Skipped POSIX owner-death portion: SIGSTOP/SIGKILL are unavailable on Windows");
			return;
		}
		const owner = await open(tornPath);
		const child = actor(owner);
		// Stop before admission so there can be no acknowledgement for the pending append.
		expect(child.kill("SIGSTOP")).toBe(true);
		const uncertain = '{"type":"message","id":"uncertain"}';
		const pending = owner.appendJson(uncertain);
		const rejected = expect(pending).rejects.toThrow(/outcome.*unknown/i);
		const exited = once(child, "exit");
		expect(child.kill("SIGKILL")).toBe(true);
		await rejected;
		expect(await exited).toEqual([null, "SIGKILL"]);
		await expect(owner.close()).resolves.toBeUndefined();
		await expect(owner.appendJson('{"id":"after-death"}')).rejects.toThrow();

		const successor = await open(tornPath);
		await successor.recover();
		const recovered = framedJson(tornPath);
		expect(recovered.slice(0, 2)).toEqual([header, lexical]);
		expect([2, 3]).toContain(recovered.length);
		if (recovered.length === 3) expect(recovered[2]).toBe(uncertain);
		// An unknown outcome does not authorize retrying the same logical append.
		const next = '{"type":"message","id":"after-death-successor"}';
		await expect(successor.appendJson(next)).resolves.toEqual({ sequence: recovered.length });
		await successor.close();
		expect(actor(successor).exitCode).toBe(0);
		expect(framedJson(tornPath)).toEqual([...recovered, next]);
	});
});
