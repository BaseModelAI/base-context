import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { EventStreamCodec } from "@smithy/core/event-streams";
import { afterEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const packageDir = fileURLToPath(new URL("../../../", import.meta.url));
const providerEntry = process.env.BASE_CONTEXT_TEST_BEDROCK_ENTRY
	? resolve(process.env.BASE_CONTEXT_TEST_BEDROCK_ENTRY)
	: join(packageDir, "dist/bundle/amazon-bedrock.js");
const codec = new EventStreamCodec(
	(bytes) => new TextDecoder().decode(bytes),
	(text) => new TextEncoder().encode(text),
);

function encodeEvent(type: string, body: unknown): Uint8Array {
	return codec.encode({
		headers: {
			":message-type": { type: "string", value: "event" },
			":event-type": { type: "string", value: type },
			":content-type": { type: "string", value: "application/json" },
		},
		body: new TextEncoder().encode(JSON.stringify(body)),
	});
}

// Uses the existing built entry, not an automatic build or a source-provider import.
describe("ENG-6006 bundled Bedrock provider", () => {
	let root: string | undefined;
	let server: Server | undefined;

	afterEach(async () => {
		if (server) {
			const current = server;
			server = undefined;
			current.closeAllConnections();
			await new Promise<void>((resolve, reject) => current.close((error) => (error ? reject(error) : resolve())));
		}
		if (root) await rm(root, { recursive: true, force: true });
		root = undefined;
	});

	it.each([false, true])("retains physical-attempt admission (refused: %s)", async (refused) => {
		root = await mkdtemp(join(tmpdir(), "bc-bedrock-bundle-"));
		const requests: Array<{ method: string | undefined; path: string | undefined; body: string }> = [];
		server = createServer(async (request, response) => {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			requests.push({ method: request.method, path: request.url, body: Buffer.concat(chunks).toString("utf8") });
			response.writeHead(200, { "content-type": "application/vnd.amazon.eventstream" });
			response.write(encodeEvent("messageStart", { role: "assistant" }));
			response.write(encodeEvent("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "OK" } }));
			response.write(encodeEvent("contentBlockStop", { contentBlockIndex: 0 }));
			response.write(encodeEvent("messageStop", { stopReason: "end_turn" }));
			response.end(encodeEvent("metadata", { usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 } }));
		});
		await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Missing fixture address");
		const script = `
import { streamBedrock, streamSimpleBedrock } from ${JSON.stringify(pathToFileURL(providerEntry).href)};
const admissions = [];
const receipts = [];
const result = await streamBedrock({
	id: "amazon.nova-2-lite-v1:0", name: "Fixture", api: "bedrock-converse-stream", provider: "amazon-bedrock",
	baseUrl: ${JSON.stringify(`http://127.0.0.1:${address.port}`)}, reasoning: false, input: ["text"],
	contextWindow: 4096, maxTokens: 32, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}, { messages: [{ role: "user", content: "Reply OK", timestamp: 1 }] }, {
	region: "us-east-1", maxTokens: 32,
	attempts: {
		admit: async (info) => {
			admissions.push(info);
			if (${refused}) throw new Error("fixture admission refused");
			return "attempt-1";
		},
		settle: async (receipt) => { receipts.push(receipt); }
	}
}).result();
console.log(JSON.stringify({ result, admissions, receipts, simpleExport: typeof streamSimpleBedrock }));
`;
		const { stdout, stderr } = await run(process.execPath, ["--input-type=module", "--eval", script], {
			cwd: packageDir,
			timeout: 10_000,
			env: {
				PATH: process.env.PATH,
				HOME: root,
				BASE_CONTEXT_HOME: join(root, "state"),
				AWS_EC2_METADATA_DISABLED: "true",
				AWS_BEDROCK_SKIP_AUTH: "1",
				AWS_BEDROCK_FORCE_HTTP1: "1",
				AWS_SHARED_CREDENTIALS_FILE: join(root, "no-credentials"),
				AWS_CONFIG_FILE: join(root, "no-config"),
			},
		});
		const observed = JSON.parse(stdout);
		expect(stderr).toBe("");
		expect(observed.simpleExport).toBe("function");
		expect(observed.admissions).toEqual([
			expect.objectContaining({
				api: "bedrock-converse-stream",
				provider: "amazon-bedrock",
				transport: "http",
				ordinal: 1,
			}),
		]);
		if (refused) {
			expect(requests).toHaveLength(0);
			expect(observed.result).toMatchObject({ stopReason: "error", errorMessage: "fixture admission refused" });
			expect(observed.receipts).toEqual([]);
		} else {
			expect(requests).toHaveLength(1);
			expect(requests[0]).toMatchObject({
				method: "POST",
				path: "/model/amazon.nova-2-lite-v1%3A0/converse-stream",
			});
			expect(JSON.parse(requests[0]!.body).messages).toEqual([{ role: "user", content: [{ text: "Reply OK" }] }]);
			expect(observed.result).toMatchObject({ stopReason: "stop", content: [{ type: "text", text: "OK" }] });
			expect(observed.receipts).toEqual([
				expect.objectContaining({
					attemptId: "attempt-1",
					outcome: "completed",
					usageCompleteness: "complete",
					usage: expect.objectContaining({ input: 3, output: 1, totalTokens: 4 }),
				}),
			]);
		}
	});
});
