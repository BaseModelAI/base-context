import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, type Message } from "@ponythewhite/base-context-ai";
import { expect, it } from "vitest";
import {
	type AgentSessionMessageDeliveryStatus,
	type AgentSessionMessagePayload,
	createAgentSessionMessage,
	createAgentSessionMessageId,
	createAgentSessionMessageReceipt,
} from "../../../src/core/agent-messages.js";
import type { NativeRecoveryResponse } from "../../../src/core/selective-recovery.js";
import { SessionManager } from "../../../src/core/session-manager.js";
import { loadSkillsFromDir } from "../../../src/core/skills.js";
import { createTestResourceLoader } from "../../utilities.js";
import { createHarness, getMessageText, type Harness } from "../harness.js";
import { createDeferred } from "../scheduling.js";

it("recovers a large Python result and its old constraint after compaction and cold reopening", async () => {
	const settings = { compaction: { enabled: false, keepRecentTokens: 1 }, autoRefine: { enabled: false } };
	const harness = await createHarness({ persistSession: true, settings });
	let reopened: Awaited<ReturnType<typeof createHarness>> | undefined;
	const constraint = "Keep warehouse codes ASCII and preserve the public column names.";
	const sentinel = "sentinel-value-1387";
	let outputRequest: Message[] = [];
	try {
		harness.setResponses([
			fauxAssistantMessage(
				[
					{
						type: "toolCall",
						id: "large-python-output",
						name: "ipython",
						arguments: {
							code: 'workflow_rows = [f"row-{i:03d}: " + "x" * 72 for i in range(500)]\nworkflow_rows[250] = "sentinel-value-" + str(73 * 19)\nprint("\\n".join(workflow_rows))',
						},
					},
				],
				{ stopReason: "toolUse" },
			),
			(context) => {
				outputRequest = structuredClone(context.messages);
				return fauxAssistantMessage("Stored the output.");
			},
			fauxAssistantMessage("Ready to compact."),
		]);
		await harness.session.prompt(constraint);
		const output = (await harness.sessionManager.readEntries()).find(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				entry.message.toolCallId === "large-python-output",
		);
		expect(output?.type).toBe("message");
		if (!output || output.type !== "message") throw new Error("Missing native Python result");
		expect(output.message).toMatchObject({ role: "toolResult", isError: false });
		expect(outputRequest.map(getMessageText).join("\n")).not.toContain(sentinel);
		await harness.session.prompt("Summarize the completed work before the next step.");
		harness.setResponses([
			fauxAssistantMessage("Large output retained by reference."),
			fauxAssistantMessage("Work summarized."),
		]);
		await harness.session.compact();
		const file = harness.sessionManager.getSessionFile()!;
		await harness.session.disposeAsync();
		await harness.sessionManager.close();
		reopened = await createHarness({ sessionManager: await SessionManager.open(file), settings });
		let resumed: Message[] = [];
		let recovered: NativeRecoveryResponse | undefined;
		let resumedPython = "";
		reopened.setResponses([
			(context) => {
				resumed = structuredClone(context.messages);
				return fauxAssistantMessage(
					[
						{
							type: "toolCall",
							id: "recover-large-output",
							name: "prime_context",
							arguments: { action: "read", ref: output.id, startLine: 251, endLine: 251 },
						},
					],
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				const result = context.messages.find(
					(message) => message.role === "toolResult" && message.toolCallId === "recover-large-output",
				);
				recovered = JSON.parse(getMessageText(result)) as NativeRecoveryResponse;
				return fauxAssistantMessage(
					[
						{
							type: "toolCall",
							id: "resumed-python-state",
							name: "ipython",
							arguments: { code: "print(len(workflow_rows))" },
						},
					],
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				resumedPython = getMessageText(
					context.messages.find(
						(message) => message.role === "toolResult" && message.toolCallId === "resumed-python-state",
					),
				);
				return fauxAssistantMessage("Recovered the exact result and reused Python state.");
			},
		]);
		const currentPrompt = "Continue using the retained result.";
		await reopened.session.prompt(currentPrompt);
		expect(resumed.map(getMessageText).join("\n")).toContain(constraint);
		expect(resumed.map(getMessageText).join("\n")).not.toContain(sentinel);
		expect(resumed.filter((message) => getMessageText(message).includes(currentPrompt))).toHaveLength(1);
		expect(recovered?.status).toBe("found");
		expect(
			recovered?.results.flatMap((result) => result.records).some((record) => record.text.trim() === sentinel),
		).toBe(true);
		expect(resumedPython.trim()).toBe("500");
	} finally {
		await reopened?.cleanup();
		await harness.cleanup();
	}
}, 30_000);

it("keeps the parent working during a native child run and imports its report, not its transcript", async () => {
	const { skills, diagnostics } = loadSkillsFromDir({
		dir: fileURLToPath(new URL("../../../skills/agent-message", import.meta.url)),
		source: "builtin",
	});
	expect(diagnostics).toEqual([]);
	expect(skills.map((skill) => skill.name)).toEqual(["agent-message"]);
	const settings = { compaction: { enabled: false }, autoRefine: { enabled: false } };
	const resourceLoader = createTestResourceLoader({ skills });
	const childStarted = createDeferred();
	const releaseChild = createDeferred();
	const parentWorked = createDeferred();
	const childTask = "Check the warehouse rows and send the parent a concise report.";
	const report = "Checked 500 warehouse rows; codes stayed ASCII.";
	const privateNotes = "CHILD_ONLY_WORKING_NOTES_NOT_A_PARENT_REPORT";
	const parentRequests: string[] = [];
	let child: Harness | undefined;
	let childManager: SessionManager | undefined;
	let run: Promise<void> | undefined;
	const harness = await createHarness({
		settings,
		resourceLoader,
		subagentRuntimeHost: {
			async createRlmSubagentRuntime(options) {
				const admission = options.admission;
				if (!admission) throw new Error("Missing native child admission");
				admission.claimFactory();
				const parent = options.parentSession;
				const manager = await SessionManager.create(parent.sessionManager.getCwd(), options.sessionDir, {
					parentSession: parent.sessionFile,
					rlmDepth: options.rlmDepth,
				});
				childManager = manager;
				// The host supplies local routing, while Python and session admission remain native.
				const target = { activeSessionId: parent.sessionId, sessionId: parent.sessionId };
				child = await createHarness({
					settings,
					resourceLoader,
					cwd: parent.sessionManager.getCwd(),
					sessionManager: manager,
					rlmDepth: options.rlmDepth,
					rlmMaxDepth: options.rlmMaxDepth,
					rlmChildAdmission: admission,
					requestTokenBudget: options.requestTokenBudget,
					// Keep the parent's model capabilities, but register a separate Faux API and response queue.
					provider: "workflow-child",
					models: [options.model],
					agentMessageController: {
						listAgents: () => ({ agents: [] }),
						roster: () => ({
							current: { name: options.sessionName, id: manager.getSessionId(), depth: options.rlmDepth },
							entries: [
								{
									relationship: "parent",
									name: "parent",
									id: parent.sessionId,
									depth: options.rlmDepth - 1,
									status: parent.isSessionActive ? "running" : "idle",
								},
							],
						}),
						async sendAgentMessage(input) {
							expect(input.target).toBe(parent.sessionId);
							const payload: AgentSessionMessagePayload = {
								id: createAgentSessionMessageId(),
								source: "agent_message",
								message: input.message,
								from: { sessionId: manager.getSessionId(), sessionName: options.sessionName },
								fromRelationship: "child",
								target,
							};
							const message = createAgentSessionMessage(payload);
							let status: AgentSessionMessageDeliveryStatus = "delivered";
							await parent.acceptAgentMessagePrompt(message.content, {
								expandPromptTemplates: false,
								streamingBehavior: "steer",
								queueIfBusy: true,
								customMessage: message,
								preflightResult: (accepted, queued) => {
									expect(accepted).toBe(true);
									status = queued ? "queued" : "delivered";
								},
							});
							return createAgentSessionMessageReceipt(payload, status);
						},
					},
				});
				child.setResponses([
					async (context) => {
						expect(context.messages.map(getMessageText)).toContain(`[task from parent]\n\n${childTask}`);
						childStarted.resolve();
						await releaseChild.promise;
						return fauxAssistantMessage(
							[
								{ type: "text", text: privateNotes },
								{
									type: "toolCall",
									id: "child-report",
									name: "ipython",
									arguments: {
										code: `await agent_message.send(${JSON.stringify(report)}, receiver_role="parent")`,
									},
								},
							],
							{ stopReason: "toolUse" },
						);
					},
					(context) => {
						const result = context.messages.find(
							(message) => message.role === "toolResult" && message.toolCallId === "child-report",
						);
						expect(result).toMatchObject({ role: "toolResult", isError: false });
						return fauxAssistantMessage("Child completed.");
					},
				]);
				options.onSessionPublished?.(child.session);
				return { session: child.session };
			},
			async deleteRlmSubagentRuntime(_id, session) {
				await session?.disposeAsync();
			},
		},
	});
	try {
		harness.setResponses([
			(context) => {
				parentRequests.push(context.messages.map(getMessageText).join("\n"));
				return fauxAssistantMessage(
					[
						{
							type: "toolCall",
							id: "spawn-and-work",
							name: "ipython",
							arguments: {
								code: `child_handle = await rlm(${JSON.stringify(childTask)}, name="warehouse-checker")\nparent_value = 6 * 7\nprint("parent-work:", parent_value)`,
							},
						},
					],
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				const visible = context.messages.map(getMessageText).join("\n");
				parentRequests.push(visible);
				expect(visible).toContain("parent-work: 42");
				parentWorked.resolve();
				return fauxAssistantMessage("Completed independent parent work.");
			},
			(context) => {
				parentRequests.push(context.messages.map(getMessageText).join("\n"));
				return fauxAssistantMessage("Used the child's concise report.");
			},
		]);
		run = harness.session.prompt("Delegate a warehouse check and continue independent work while it runs.");
		void run.catch((error: Error) => {
			childStarted.reject(error);
			parentWorked.reject(error);
		});
		await Promise.all([childStarted.promise, parentWorked.promise]);
		expect(child?.session.hasRlmParentAdmission).toBe(true);
		expect(child?.session.model?.api).not.toBe(harness.session.model?.api);
		expect(parentRequests.join("\n")).toContain("parent-work: 42");
		expect(parentRequests.join("\n")).not.toContain(report);
		releaseChild.resolve();
		await run;
		await harness.session.waitForRlmQuiescence();
		expect(parentRequests.join("\n")).toContain(report);
		expect(parentRequests.join("\n")).not.toContain(privateNotes);
		expect(child?.session.messages.map(getMessageText).join("\n")).toContain(privateNotes);
		expect(child?.session.repliedToParentSinceTask).toBe(true);
		expect((await harness.session.listRlmSubagents()).subagents[0]?.status).toBe("completed");
	} finally {
		releaseChild.resolve();
		await run?.catch(() => {});
		try {
			await harness.cleanup();
		} finally {
			await child?.cleanup();
			await childManager?.close();
		}
	}
}, 30_000);
