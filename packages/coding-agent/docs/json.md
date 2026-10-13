# JSON Event Stream Mode

```bash
base-context --mode json "Your prompt"
```

Outputs all session events as JSON lines to stdout. Useful for integrating Base Context into other tools or custom UIs.

## Event Types

Events are defined in [`AgentSessionEvent`](../src/core/agent-session.ts):

```typescript
type AgentSessionEvent =
  | AgentEvent
  | { type: "session_action_update"; actions: SessionActionSnapshot }
  | { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
  | { type: "compaction_end"; reason: "manual" | "threshold" | "overflow"; result: CompactionResult | undefined; aborted: boolean; willRetry: boolean; errorMessage?: string }
  | { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string };
```

`session_action_update` emits literal queued actions separately from active scheduler work whenever either projection changes. `compaction_start` and `compaction_end` cover both manual and automatic compaction.

Base events from [`AgentEvent`](../../agent/src/types.ts):

```typescript
type AgentEvent =
  // Agent lifecycle
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
  // Turn lifecycle
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
  // Message lifecycle
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message: AgentMessage }
  // Tool execution
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean };
```

## Message Types

Base messages from [`packages/ai/src/types.ts`](../../ai/src/types.ts):
- `UserMessage` (line 134)
- `AssistantMessage` (line 140)
- `ToolResultMessage` (line 152)

Extended messages from [`packages/coding-agent/src/core/messages.ts`](../src/core/messages.ts):
- `BashExecutionMessage` (line 29)
- `CustomMessage` (line 46)
- `BranchSummaryMessage` (line 55)
- `CompactionSummaryMessage` (line 62)

## Output Format

Each line is a JSON object. The first line is the session header:

```json
{"type":"session","version":3,"id":"uuid","timestamp":"...","cwd":"/path"}
```

Followed by events as they occur:

```json
{"type":"agent_start"}
{"type":"turn_start"}
{"type":"message_start","message":{"role":"assistant","content":[],...}}
{"type":"message_update","message":{...},"assistantMessageEvent":{"type":"text_delta","delta":"Hello",...}}
{"type":"message_end","message":{...}}
{"type":"turn_end","message":{...},"toolResults":[]}
{"type":"agent_end","messages":[...]}
```

## Opt-in Delta Updates

```bash
base-context --mode json --json-deltas "Your prompt"
```

`--json-deltas` requires `--mode json`. Without this flag, the JSON format above is unchanged.

With the flag:

- Assistant `message_start`, `message_update`, and `message_end` events carry a numeric `messageId`. It starts at 1 and increases for each assistant message in this CLI stream. It is not a provider or saved-session message ID.
- `message_update` omits its outer `message` and its nested `assistantMessageEvent.partial`. The nested event keeps its `type`, `contentIndex`, and `delta` or end-event content.
- A nested `toolcall_start` adds `toolCall: {id, name}` from the starting content block. `toolcall_end` keeps the full `toolCall`, including final `arguments`.
- `message_start` and `message_end` still include their full `message`. Final messages, usage, errors, and all other events remain intact. A response with no deltas still has its final message.

For example, two update lines can be:

```json
{"type":"message_update","messageId":1,"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"Hello"}}
{"type":"message_update","messageId":2,"assistantMessageEvent":{"type":"toolcall_start","contentIndex":0,"toolCall":{"id":"call_1","name":"ipython"}}}
```

Group updates by `messageId` and `contentIndex`. Concatenate text, thinking, or tool-call argument deltas within each block. Use the end event or final message as the complete result; some providers do not emit deltas. This option only changes CLI serialization, not daemon/RPC events or provider behavior.

## Completion and Errors

JSON mode has the same exit-status rules as text print mode. Terminal assistant errors or aborts, failed session commands, failed compaction, and unfinished autonomous runs stopped by a limit return a nonzero exit status. A configured gate that has not run is not a passed gate. Error diagnostics go to stderr; stdout remains a JSON event stream. Recovered intermediate errors do not by themselves make the final result fail.

An unknown explicit `--model` fails startup instead of falling back to the saved model. Startup failures can occur before the session header is emitted.

Keep stderr and check the process exit status. An `agent_end` event means the agent loop ended, not that the task succeeded: inspect the terminal assistant's `stopReason` and `errorMessage`, and any gate or compaction failure. Codex error diagnostics retain supplied flat or nested error messages and codes; an empty provider error cannot reveal a cause the provider did not send.

Record the first session header's `id` when launching a run. Use that session ID with lifecycle commands; neither cwd nor an operating-system process title uniquely identifies a session. See [Long-Running Agents](long-running-agents.md#daemon-backed-sessions) for client-owned versus resident lifetimes.

## Example

Use `pipefail` so the filter does not hide a failing CLI exit status:

```bash
set -o pipefail
base-context --mode json "List files" 2>run.err | jq -c 'select(.type == "message_end")'
```
