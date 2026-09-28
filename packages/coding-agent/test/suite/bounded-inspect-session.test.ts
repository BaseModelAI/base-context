import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@ponythewhite/base-context-ai";
import { afterEach, describe, expect, it } from "vitest";
import { loadSkillsFromDir } from "../../src/core/skills.js";
import { createIpythonTool, IpythonKernelProvisioner } from "../../src/core/tools/ipython.js";
import { createHarness, getMessageText, type Harness } from "./harness.js";

const python = process.env.BASE_CONTEXT_KERNEL_PYTHON ?? resolve("../../prime-agent-runtime/.venv/bin/python");
const skillDir = resolve("skills/bounded-inspect");
const sourceDir = join(skillDir, "src");
const harnesses: Harness[] = [];
const provisioners: IpythonKernelProvisioner[] = [];
const directories: string[] = [];
afterEach(async () => {
	for (const harness of harnesses.splice(0)) await harness.cleanup();
	for (const provisioner of provisioners.splice(0)) await provisioner.dispose({ snapshot: false });
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("bounded-inspect actual native tool with mocked provider", () => {
	it("discovers the Python skill through existing package conventions", () => {
		const { skills, diagnostics } = loadSkillsFromDir({ dir: skillDir, source: "builtin" });
		expect(diagnostics).toEqual([]);
		expect(skills).toHaveLength(1);
		expect(skills[0]).toMatchObject({
			name: "bounded-inspect",
			kind: "python",
			python: { importName: "bounded_inspect" },
		});
		expect(skills[0].description.split(/\s+/).length).toBeLessThan(35);
	});

	it.each([false, true])("renders once without trailing result under autonomous=%s turn limits", async (enabled) => {
		const cwd = mkdtempSync(join(tmpdir(), "bi-session-"));
		directories.push(cwd);
		writeFileSync(
			join(cwd, "metrics.json"),
			JSON.stringify({ run: "control", seed: 7, eligible: false, validation: null, failures: ["failed control"] }),
		);
		const provisioner = new IpythonKernelProvisioner(cwd, { python, env: { PYTHONPATH: sourceDir } });
		provisioners.push(provisioner);
		const harness = await createHarness({
			cwd,
			tools: [createIpythonTool(cwd, { provisioner })],
			autonomous: { enabled, maxContinuations: 1, maxTurns: 2 },
		});
		harnesses.push(harness);
		const code = `import bounded_inspect
bounded_inspect.emit(bounded_inspect.json_fields("metrics.json", pointers=["/run", "/seed", "/eligible", "/validation", "/failures"]), max_bytes=1024)`;
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("ipython", { code }), { stopReason: "toolUse" }),
			fauxAssistantMessage("The selected evidence contains a failed, ineligible control."),
		]);
		await harness.session.prompt("Inspect the existing metrics once. Do not rerun the job.");
		await harness.session.waitForIdle();
		const results = harness.session.messages.filter((message) => message.role === "toolResult");
		expect(results).toHaveLength(1);
		const visible = getMessageText(results[0]);
		const bundle = JSON.parse(visible);
		expect(bundle.output_bytes).toBe(Buffer.byteLength(visible));
		expect(bundle.output_bytes).toBeLessThanOrEqual(1024);
		expect(bundle.items[0].fields).toContainEqual({ pointer: "/validation", status: "ok", value: null });
		const details = Reflect.get(results[0], "details");
		expect(details.status).toBe("ok");
		expect(details.stdout).toBe(visible);
		expect(details.result ?? "").toBe("");
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.session.getAutonomousStatus().continuationsUsed).toBe(0);
		if (enabled) expect(harness.session.getAutonomousStatus().turnsUsed).toBe(2);
		console.info(
			"bounded-inspect-measurement",
			JSON.stringify({
				fixture: "native-AgentSession",
				autonomous: enabled,
				mockedProviderMessages: 2,
				toolResults: results.length,
				skillOutputBytes: bundle.output_bytes,
				completeToolResultBytes: Buffer.byteLength(JSON.stringify(results[0])),
			}),
		);
	});
});
