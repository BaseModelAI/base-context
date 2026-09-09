> Prime Agent can help you use the SDK. Ask it to build an integration for your use case.

# SDK

The SDK provides programmatic access to Prime Agent's capabilities. Use it to embed Prime Agent in other applications, build custom interfaces, or integrate with automated workflows.

**Example use cases:**
- Build a custom UI (web, desktop, mobile)
- Integrate agent capabilities into existing applications
- Create automated pipelines with agent reasoning
- Build custom tools that spawn sub-agents
- Test agent behavior programmatically

See [examples/sdk/](../examples/sdk/) for working examples from minimal to full control.

## Quick Start

```typescript
import { AuthStorage, createAgentSession, ModelRegistry, SessionManager } from "@earendil-works/pi-coding-agent";

// Set up credential storage and model registry
const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);

const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  authStorage,
  modelRegistry,
});

session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

await session.prompt("What files are in the current directory?");
```

## Installation

```bash
npm install @earendil-works/pi-coding-agent
```

The SDK is included in the main package. No separate installation needed.

## Core Concepts

### createAgentSession()

The main factory function for a single `AgentSession`.

`createAgentSession()` uses a `ResourceLoader` to supply extensions, skills, prompt templates, themes, and context files. If you do not provide one, it uses `DefaultResourceLoader` with standard discovery.

```typescript
import { createAgentSession } from "@earendil-works/pi-coding-agent";

// Minimal: defaults with DefaultResourceLoader
const { session } = await createAgentSession();

// Custom: override specific options
const { session } = await createAgentSession({
  model: myModel,
  tools: ["ipython"],
  sessionManager: SessionManager.inMemory(),
});
```

### AgentSession

The session manages agent lifecycle, message history, model state, compaction, and event streaming.

```typescript
interface AgentSession {
  // Send a prompt and wait for completion
  prompt(text: string, options?: PromptOptions): Promise<void>;

  // Queue messages during streaming
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;

  // Subscribe to events (returns unsubscribe function)
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;

  // Session info
  sessionFile: string | undefined;
  sessionId: string;

  // Model control
  setModel(model: Model): Promise<void>;
  setThinkingLevel(level: ThinkingLevel): void;
  cycleModel(): Promise<ModelCycleResult | undefined>;
  cycleThinkingLevel(): ThinkingLevel | undefined;

  // State access
  agent: Agent;
  model: Model | undefined;
  thinkingLevel: ThinkingLevel;
  messages: AgentMessage[];
  isStreaming: boolean;

  // In-place tree navigation within the current session file
  navigateTree(targetId: string, options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string }): Promise<{ editorText?: string; cancelled: boolean }>;

  // Compaction
  compact(customInstructions?: string): Promise<CompactionResult>;
  abortCompaction(): void;

  // Abort current operation
  abort(): Promise<void>;

  // Cleanup
  dispose(): void;
}
```

Session replacement APIs such as new-session, resume, fork, and import live on `AgentSessionRuntime`, not on `AgentSession`.

### createAgentSessionRuntime() and AgentSessionRuntime

Use the runtime API when you need to replace the active session and rebuild cwd-bound runtime state.
This is the same layer used by the built-in interactive, print, and RPC modes.

`createAgentSessionRuntime()` takes a runtime factory plus the initial cwd/session target. The factory closes over process-global fixed inputs, recreates cwd-bound services for the effective cwd, resolves session options against those services, and returns a full runtime result.

```typescript
import {
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
  const services = await createAgentSessionServices({ cwd });
  return {
    ...(await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
    })),
    services,
    diagnostics: services.diagnostics,
  };
};

const runtime = await createAgentSessionRuntime(createRuntime, {
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  sessionManager: SessionManager.create(process.cwd()),
});
```

`AgentSessionRuntime` owns replacement of the active runtime across:

- `newSession()`
- `switchSession()`
- `fork()`
- clone flows via `fork(entryId, { position: "at" })`
- `importFromJsonl()`

Important behavior:

- `runtime.session` changes after those operations
- event subscriptions are attached to a specific `AgentSession`, so re-subscribe after replacement
- if you use extensions, call `runtime.session.bindExtensions(...)` again for the new session
- creation returns diagnostics on `runtime.diagnostics`
- if runtime creation or replacement fails, the method throws and the caller decides how to handle it

Native child creation and passive hydration share one resident-child slot per live
parent. Reserve admission before asynchronous setup. A completed but resident child
still occupies that slot; confirmed asynchronous disposal or passivation frees it.
Uncertain startup or cleanup does not establish release. This is not a tree-wide
scheduler. Child-runtime `newSession()`, `switchSession()`, `fork()` and `importFromJsonl()`
currently refuse before setup because replacement cannot retain their owned admission.
Main/root replacement is unchanged.

```typescript
let session = runtime.session;
let unsubscribe = session.subscribe(() => {});

await runtime.newSession();

unsubscribe();
session = runtime.session;
unsubscribe = session.subscribe(() => {});
```

### Prompting and Message Queueing

`PromptOptions` controls prompt expansion, queueing behavior while streaming, and prompt preflight notifications:

```typescript
interface PromptOptions {
  expandPromptTemplates?: boolean;
  images?: ImageContent[];
  streamingBehavior?: "steer" | "followUp";
  source?: InputSource;
  preflightResult?: (success: boolean) => void;
}
```

`preflightResult` is called once per `prompt()` invocation:

- `true` when the prompt was accepted, queued, or handled immediately
- `false` when prompt preflight rejected before acceptance

It fires before `prompt()` resolves. `prompt()` still resolves only after the full accepted run finishes, including retries. Failures after acceptance are reported through the normal event and message stream, not through `preflightResult(false)`.

The `prompt()` method handles prompt templates, extension commands, and message sending:

```typescript
// Basic prompt (when not streaming)
await session.prompt("What files are here?");

// With images
await session.prompt("What's in this image?", {
  images: [{ type: "image", source: { type: "base64", mediaType: "image/png", data: "..." } }]
});

// During streaming: must specify how to queue the message
await session.prompt("Stop and do this instead", { streamingBehavior: "steer" });
await session.prompt("After you're done, also check X", { streamingBehavior: "followUp" });
```

**Behavior:**
- **Extension commands** (e.g., `/mycommand`): Execute immediately, even during streaming. They manage their own LLM interaction via `pi.sendMessage()`.
- **File-based prompt templates** (from `.md` files): Expanded to their content before sending or queueing.
- **During streaming without `streamingBehavior`**: Throws an error. Use `steer()` or `followUp()` directly, or specify the option.
- **`preflightResult(true)`**: Means the prompt was accepted, queued, or handled immediately.
- **`preflightResult(false)`**: Means preflight rejected before acceptance.

For explicit queueing during streaming:

```typescript
// Queue a steering message for delivery after the current assistant turn finishes its tool calls
await session.steer("New instruction");

// Wait for agent to finish (delivered only when agent stops)
await session.followUp("After you're done, also do this");
```

Both `steer()` and `followUp()` expand file-based prompt templates but error on extension commands (extension commands cannot be queued).

### Agent and AgentState

The `Agent` class (from `@earendil-works/pi-agent-core`) handles the core LLM interaction. Access it via `session.agent`.

```typescript
// Access current state
const state = session.agent.state;

// state.messages: AgentMessage[] - conversation history
// state.model: Model - current model
// state.thinkingLevel: ThinkingLevel - current thinking level
// state.systemPrompt: string - system prompt
// state.tools: AgentTool[] - available tools
// state.streamingMessage?: AgentMessage - current partial assistant message
// state.errorMessage?: string - latest assistant error

// Replace messages (useful for branching or restoration)
session.agent.state.messages = messages; // copies the top-level array

// Replace tools
session.agent.state.tools = tools; // copies the top-level array

// Wait for agent to finish processing
await session.agent.waitForIdle();
```

### Events

Subscribe to events to receive streaming output and lifecycle notifications.

```typescript
session.subscribe((event) => {
  switch (event.type) {
    // Streaming text from assistant
    case "message_update":
      if (event.assistantMessageEvent.type === "text_delta") {
        process.stdout.write(event.assistantMessageEvent.delta);
      }
      if (event.assistantMessageEvent.type === "thinking_delta") {
        // Thinking output (if thinking enabled)
      }
      break;
    
    // Tool execution
    case "tool_execution_start":
      console.log(`Tool: ${event.toolName}`);
      break;
    case "tool_execution_update":
      // Streaming tool output
      break;
    case "tool_execution_end":
      console.log(`Result: ${event.isError ? "error" : "success"}`);
      break;
    
    // Message lifecycle
    case "message_start":
      // New message starting
      break;
    case "message_end":
      // Message complete
      break;
    
    // Agent lifecycle
    case "agent_start":
      // Agent started processing prompt
      break;
    case "agent_end":
      if (event.refusal) {
        // Completion failed. No successful/partial message bundle is supplied.
        console.error("Invocation output refused", event.refusal);
        break;
      }
      // Successful completion: event.messages contains all new messages
      break;
    
    // Turn lifecycle (one LLM response + tool calls)
    case "turn_start":
      break;
    case "turn_end":
      // event.message: assistant response
      // event.toolResults: tool results from this turn
      break;
    
    // Session events (queue, compaction, retry)
    case "session_action_update":
      console.log(event.actions.steering, event.actions.followUps);
      break;
    case "compaction_start":
    case "compaction_end":
    case "auto_retry_start":
    case "auto_retry_end":
      break;
  }
});
```

## Options Reference

### Directories

```typescript
const { session } = await createAgentSession({
  // Working directory for DefaultResourceLoader discovery
  cwd: process.cwd(), // default
  
  // Global config directory
  agentDir: "~/.prime/agent", // default (expands ~)
});
```

`cwd` is used by `DefaultResourceLoader` for:
- Project extensions (`.prime/agent/extensions/`)
- Project skills:
  - `.prime/agent/skills/`
  - `.agents/skills/` in `cwd` and ancestor directories (up to git repo root, or filesystem root when not in a repo)
- Project prompts (`.prime/agent/prompts/`)
- Context files (`AGENTS.md` walking up from cwd)
- Session storage resolution

`agentDir` is used by `DefaultResourceLoader` for:
- Global extensions (`extensions/`)
- Global skills:
  - `skills/` under `agentDir` (for example `~/.prime/agent/skills/`)
  - `~/.agents/skills/`
- Global prompts (`prompts/`)
- Global context file (`AGENTS.md`)
- Settings (`settings.json`)
- Custom models (`models.json`)
- Credentials (`auth.json`)
- Sessions (`sessions/`)

When you pass a custom `ResourceLoader`, `cwd` and `agentDir` no longer control resource discovery. They still influence session naming and tool path resolution.

### Model

```typescript
import { getModel } from "@earendil-works/pi-ai";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);

// Find specific built-in model (doesn't check if API key exists)
const opus = getModel("anthropic", "claude-opus-4-5");
if (!opus) throw new Error("Model not found");

// Find any model by provider/id, including custom models from models.json
// (doesn't check if API key exists)
const customModel = modelRegistry.find("my-provider", "my-model");

// Get only models that have valid API keys configured
const available = await modelRegistry.getAvailable();

const { session } = await createAgentSession({
  model: opus,
  thinkingLevel: "medium", // off, minimal, low, medium, high, xhigh, max
  
  // Models for cycling (Ctrl+P in interactive mode)
  scopedModels: [
    { model: opus, thinkingLevel: "high" },
    { model: haiku, thinkingLevel: "off" },
  ],
  
  authStorage,
  modelRegistry,
});
```

If no model is provided:
1. Tries to restore from session (if continuing)
2. Uses default from settings
3. Falls back to first available model

> See [examples/sdk/02-custom-model.ts](../examples/sdk/02-custom-model.ts)

### API Keys and OAuth


For an existing OpenAI Codex subscription, explicitly inject a read-only backend:

```typescript
import { AuthStorage } from "@ponythewhite/base-context";

const authStorage = AuthStorage.fromStorage(readOnlyBackend, {
  existingOpenAICodexSubscription: true,
  usePrimeCliConfig: false,
});
```

The backend implements `AuthStorageBackend` and supplies only the existing OAuth access
credential and expiry. File-backed writable storage is rejected in this mode. Missing,
stale or expired credentials refuse use; login, refresh, storage writes and API-key
fallback are disabled. This authorizes only this instance's official
`openai-codex` / `openai-codex-responses` route. It does not globally validate OAuth clients
or protect against trusted in-process code. Keep the credential backend outside tools.

API key resolution priority (handled by AuthStorage):
1. Runtime overrides (via `setRuntimeApiKey`, not persisted)
2. Stored credentials in `auth.json` (API keys or OAuth tokens)
3. Environment variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.)
4. Fallback resolver (for custom provider keys from `models.json`)

```typescript
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";

// Default: uses ~/.prime/agent/auth.json and ~/.prime/agent/models.json
const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);

const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  authStorage,
  modelRegistry,
});

// Runtime API key override (not persisted to disk)
authStorage.setRuntimeApiKey("anthropic", "sk-my-temp-key");

// Custom auth storage location
const customAuth = AuthStorage.create("/my/app/auth.json");
const customRegistry = ModelRegistry.create(customAuth, "/my/app/models.json");

const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  authStorage: customAuth,
  modelRegistry: customRegistry,
});

// No custom models.json (built-in models only)
const simpleRegistry = ModelRegistry.inMemory(authStorage);
```

> See [examples/sdk/09-api-keys-and-oauth.ts](../examples/sdk/09-api-keys-and-oauth.ts)

### System Prompt

Use a `ResourceLoader` to override the system prompt:

```typescript
import { createAgentSession, DefaultResourceLoader } from "@earendil-works/pi-coding-agent";

const loader = new DefaultResourceLoader({
  systemPromptOverride: () => "You are a helpful assistant.",
});
await loader.reload();

const { session } = await createAgentSession({ resourceLoader: loader });
```

> See [examples/sdk/03-custom-prompt.ts](../examples/sdk/03-custom-prompt.ts)

### Tools

```typescript
// Use both default built-in tools
const { session } = await createAgentSession({
  tools: ["ipython", "prime_context"],
});

// Pick specific tools
const { session } = await createAgentSession({
  tools: ["ipython"],
});
```

#### Native history recovery

The built-in `prime_context` tool reads selected public text from one captured
branch. It supports exact entry IDs, revisions, line windows, literal search,
and bounded batches. Results include source references, coverage, and unknown
freshness. They are tool data, not instructions or proof of current runtime state.

When both built-ins are active, Python can use the same reader:

```python
selected = await rlm.prime_context({
    "action": "recover", "ref": "ENTRY_ID", "need": "exact literal"
})
```

Selected data is attached to that cell's finalized tool result. A Python variable
alone does not update model context. Requests outside an active cell are refused.
The default response cap is 64 KiB, with 1 MiB of source reads, 16 items and eight
operations per batch. Python cells share a 64 KiB/eight-request recovery cap.
A recovery-bearing tool result that exceeds 256 KiB returns an explicit output
refusal. That refusal does not undo code execution.

Keep the normal built-ins when adding custom tools. For a Bash-only workflow with
recovery, register custom Bash and select `tools: ["bash", "prime_context"]`.
A full `baseToolsOverride` or a same-name custom replacement does not grant access
to the owned recovery service. Recovery qualification follows the actual selected
executor entering the authorized reader, including the active Python cell. Public
markers do not qualify, and retained imports lose native recovery admission.
Ordinary summaries retain genuine recovery with its complete replay group when an accepted
native projection establishes that group. Unproved recovery compaction refuses before the
summarizer call. Summary plus retained recipes use one canonical ACK. The summary is not a
measured provider request; the next managed-epoch send still needs an accepted native projection.
Opaque groups may become unknown/refused when the summary breaks cached-prefix coverage.

#### Tools with Custom cwd

**Important:** Use tool factory functions only when registering custom tool definitions yourself. Built-in tool names passed through `tools` resolve against the session `cwd`.

```typescript
import {
  createIpythonToolDefinition,
  createBashToolDefinition,
  createEditToolDefinition,
} from "@earendil-works/pi-coding-agent";

const cwd = "/path/to/project";

const { session } = await createAgentSession({
  cwd,
  customTools: [
    createIpythonToolDefinition(cwd),
    createBashToolDefinition(cwd),
    createEditToolDefinition(cwd),
  ],
});
```

**When you don't need factories:**
- If you omit `tools`, Prime Agent automatically creates them with the correct `cwd`
- If you use `process.cwd()` as your `cwd`, the pre-built instances work fine

**When you must use factories:**
- When you specify both `cwd` (different from `process.cwd()`) AND `tools`

> See [examples/sdk/05-tools.ts](../examples/sdk/05-tools.ts)

### Custom Tools

```typescript
import { Type } from "typebox";
import { createAgentSession, defineTool } from "@earendil-works/pi-coding-agent";

// Inline custom tool
const myTool = defineTool({
  name: "my_tool",
  label: "My Tool",
  description: "Does something useful",
  parameters: Type.Object({
    input: Type.String({ description: "Input value" }),
  }),
  execute: async (_toolCallId, params) => ({
    content: [{ type: "text", text: `Result: ${params.input}` }],
    details: {},
  }),
});

// Pass custom tools directly
const { session } = await createAgentSession({
  customTools: [myTool],
});
```

Use `defineTool()` for standalone definitions and arrays like `customTools: [myTool]`. Inline `pi.registerTool({ ... })` already infers parameter types correctly.

Custom tools passed via `customTools` are combined with extension-registered tools. Extensions loaded by the ResourceLoader can also register tools via `pi.registerTool()`.

> See [examples/sdk/05-tools.ts](../examples/sdk/05-tools.ts)

### Native invocation output

Owned persistent sessions use the `invocationOutput` settings by default (16,384 messages,
64 MiB UTF-8 JSON array). An SDK override is copied when the session is constructed:

```typescript
const { session } = await createAgentSession({
  invocationOutputLimits: { maxMessages: 4096, maxSourceBytes: 16 * 1024 * 1024 },
});
```

Successful results contain all finalized invocation messages. A refused run rejects with
`AgentOutputLimitError` and emits an `agent_end` refusal descriptor instead of a message
bundle. This does not revoke delivery ACKs or completed tools. Limits are not model token
budgets or whole-process memory bounds. Explicit resident Managers keep their existing
behavior. See [settings](settings.md#native-invocation-output).

### Context-tree request limits

`getContextTree()` returns the complete live and saved-child overview or rejects. The
limits below are copied for one request and shared by every descendant:

```typescript
const tree = await session.getContextTree({
  maxNodes: 256,
  maxMetadataBytes: 4 * 1024 * 1024,
  maxDirectoryEntries: 16_384,
  maxEntries: 16_384,
  maxSourceBytes: 64 * 1024 * 1024,
});
```

These are the defaults. Node admission includes readable header-only histories even
when they produce no output node. Directory admission counts all visited names.
Metadata bytes cover admitted encoded node/source/usage fields, paths and skip IDs.
The entry and source-byte limits apply to each complete history.

Full history reductions run one at a time within this request. Native source frontiers
bind before that wait; disk file-image capture starts when its reduction runs. Accepted
reads finish before a failure is returned. Limits do not bound concurrent requests,
provider or kernel memory, transient decoding, or process RSS.

### Structured task-state view

For a native captured Manager, read the complete bounded structured branch view:

```typescript
const task = await session.sessionManager.readTaskState({
  maxItems: 16_384,
  maxSourceBytes: 64 * 1024 * 1024,
  maxViewBytes: 64 * 1024 * 1024,
});
```

The view keeps every admitted projection and its exact source, text, literal ID and
relations. Requirement amendments need qualified `source-backed` evidence and explicit
operations or relations. Similar wording, missing items in later snapshots, and unqualified
proposals cannot retire requirements. Missing or ambiguous targets remain unresolved.
Separately, qualified native goal completion/clear facts can close that exact goal, not
unrelated requirements. Those control facts retain their descriptive attribution.

`maxItems` counts projection records and explicit relation edges. Distinct canonical
frames count toward `maxSourceBytes`; projection and complete result encodings each
must fit `maxViewBytes`. Oversized inline evidence is recovered from the same captured
source, not clipped. The whole call refuses on a limit or incomplete index coverage.
Legacy import-loss markers retain `coverage: "partial"`. `structuredOnly` and `selective`
remain true: a complete structured view is not exhaustive natural-language extraction.
This read does not activate a goal or change canonical state. Explicit resident Managers
are outside this new captured-native API.

### Native TaskFrame and working-view metadata

The native SDK compiler now renders a selective source-backed task frame alongside the
complete retained context. Defaults are16KiB for all retained frame messages,32 displayed
references and2KiB of exact clause text. Oversized clauses remain exact references, not
truncated instructions. These limits are bytes/items, not model tokens.

The stable base stays at the front. Material updates add sparse revisions near current
input; earlier text and insertion positions stay fixed until the existing source/branch/
compaction boundary changes. Rendering does not append canonical messages or emit message
events. A frame is descriptive data, not a new instruction or proof that a resource is live.

The default native SDK uses the coding-agent `convertToLlm` renderer for custom context.
Direct/custom embeddings must preserve that native custom-message rendering contract;
the generic Agent converter intentionally drops custom roles and is not silently replaced.

Compiled ViewUnit metadata records source/update revisions and replay/delta dependencies.
The compiler materializes dependency-closed units or refuses. Conservative whole-context
replay remains the default. Explicit request budgets and supported native Responses/Codex
selection are available below. Permission for narrower groups comes from the actual converter,
not profile names or tool-shaped JSON. Unsupported layouts remain intact or refuse.


### Explicit request-token budget profiles

The native SDK and direct `AgentSessionConfig` accept optional `requestTokenBudget`.
Supply application-owned `RequestTokenProfile[]` from the AI package, rather than treating
catalog defaults or a model label as confirmed deployment limits:

```typescript
await createAgentSession({
  requestTokenBudget: {
    mode: "enforce",
    profiles: explicitDeploymentProfiles,
  },
});
```

Each profile names the exact API/provider/endpoint/final request model, profile/template/
replay revisions, declared auth mode, total context limit, output ceiling and conservative
estimate parameters. `contextTokens` means the combined input/output allowance; do not
substitute an input-only limit without checking its semantics. Auth mode is descriptive
configuration, not authorization or proof of the live login. Normal auth rules still apply.

`observe` preserves control thresholds. In supported native main-session Responses/Codex
paths, `enforce` can remove historical assistant literals after complete dependency closure.
Users, the latest assistant, TaskFrames, summaries and recovery remain mandatory. Views stay
fixed inside an epoch; historical assistants can become optional at the next ACKed boundary. Selection
runs after one payload hook and waits for a canonical epoch ACK before sending. Unknown
layouts and over-budget mandatory sets refuse. Without this option, the budget gate is
absent; an existing committed epoch still requires its matching explicit profile. Direct Responses, Completions and Codex paths assess
the post-hook serialization, including instructions and tool schemas. Codex reserves its
explicit route output ceiling because it does not serialize the generic `maxTokens` option.
Reasoning is included in output for these adapters and is not reserved twice.

The counter is a configured conservative UTF8-based estimate, not bytes/4, an exact tokenizer
or a proven future bound. Ordinary complete physical usage can add observed error samples
only after its existing settlement ACK. Calibration remains unproven in cold/config-changed
state; observed errors are not calibrated confidence. Counter/profile data stays in
descriptors/receipts, outside the prompt and stable KV prefix. No warming request is made.

Media, opaque replay and external retained-state references remain unknown. Only the owned
exact-match Codex continuation path can use its previously ACKed input/output observation
plus the actual new suffix; a small wire suffix alone is not the complete input budget.
Actual cached endpoints are retained. A local quota refusal does not authorize clearing
healthy replay state or falling back to a different transport. Native Coordinator failures
propagate without inventing an assistant or physical-attempt receipt; the generic direct
AI stream still follows its existing error-result contract.

The native path persists source recipes and frozen TaskFrames, not a second wire-body
store. Same-journal reopen reconstructs selected views. Explicit fork/import activation rebuilds
recipes and TaskFrames from the destination before adoption. Retained imports keep lowered
authority and lose copied replay permission. Original copied summary usage is not charged again
by the rebuild control. Known Responses V1/legacy reply identities are supported; layouts with
unsigned generated IDs keep complete-context replay. A captured evaluator
covers selection and actual admission across the ACK wait. Final-body incompatibility and
local checkpoint failures propagate without synthetic assistant output.

Codex prepares the full logical body before its existing cached-delta path. Prefix-covered
units remain mandatory; omitted prefixes cannot retain their old token credit. Unknown opaque
content still refuses when no permitted transition or exact owned prefix is available.

An explicit ordinary-summary boundary can use an adapter-accepted fresh public window. The
v3 epoch recipe keeps canonical originals but renders old assistant/tool text and arguments
as descriptive public data, including the captured retained tail. Original user messages keep
their role. This is not replacement text for native signatures or encrypted fields, and it
does not preserve hidden reasoning. Open groups and unsupported media refuse before the summary
model call. The existing summary ACK commits the source-backed rendering plan; the next native
request must still pass its actual final-body budget, projection and epoch boundary.

The current v4 request controller can also select a `portable-checkpoint` without a summary
call when an unknown or over-budget native request cannot use ordinary selection. Only the
actual official adapter's closed-group encoder can admit this transition. It preserves original
user/system/developer items and configuration, measures the exact public body, and commits its
source recipes before adopting those same public messages and sending. Hooks and the normal
converter are not replayed. Unsupported groups/media/routes and a public candidate that still
does not fit remain explicit refusals.

The old prefix receives token credit only when its input and configuration are unchanged.
Candidate assessment and final physical admission both enforce this. An unknown original input
estimate remains `tokensBefore: null` on the existing compaction control and on copy/rebuild;
it is not replaced with the new public estimate or zero. Ordinary summary estimates and usage
accounting are unchanged. Prior-token displays label null as unknown.

Forks and imports rebuild public source recipes and the exact tail cutoff on the destination.
They do not inherit permission for a new native-to-public transition. No new body store or
extra summary call is used.

Managed native context also includes a bounded, synchronous observation of the owned kernel
lifecycle. Manager instance identity and generation distinguish a restart from a new owner whose
counter resets. This view does not probe the kernel or certify variables, restoration or health.
An unchanged snapshot renders identically. A changed snapshot needs an ACKed boundary; a held
snapshot that becomes stale refuses before dispatch. Saved/copied resource markers are only
acceptance metadata. Reopen and destination sessions capture their current owner again.
Managed summaries skip the old namespace probe and survival message. The ordinary no-budget,
no-epoch path stays unchanged.

Ownership/RPC schema35 fences v4 public-request and nullable-token readers; v1/v2/v3 epochs remain readable. This is not live deployment, tokenizer,
provider cache-hit, whole-process memory or hidden-state continuity certification.


## Extensions

Extensions are loaded by the `ResourceLoader`. `DefaultResourceLoader` discovers extensions from `~/.prime/agent/extensions/`, `.prime/agent/extensions/`, and `settings.json` extension sources.

```typescript
import { createAgentSession, DefaultResourceLoader } from "@earendil-works/pi-coding-agent";

const loader = new DefaultResourceLoader({
  additionalExtensionPaths: ["/path/to/my-extension.ts"],
  extensionFactories: [
    (pi) => {
      pi.on("agent_start", () => {
        console.log("[Inline Extension] Agent starting");
      });
    },
  ],
});
await loader.reload();

const { session } = await createAgentSession({ resourceLoader: loader });
```

Extensions can register tools, subscribe to events, add commands, and more. See [extensions.md](extensions.md) for the full API.

**Event Bus:** Extensions can communicate via `pi.events`. Pass a shared `eventBus` to `DefaultResourceLoader` if you need to emit or listen from outside:

```typescript
import { createEventBus, DefaultResourceLoader } from "@earendil-works/pi-coding-agent";

const eventBus = createEventBus();
const loader = new DefaultResourceLoader({
  eventBus,
});
await loader.reload();

eventBus.on("my-extension:status", (data) => console.log(data));
```

> See [examples/sdk/06-extensions.ts](../examples/sdk/06-extensions.ts) and [docs/extensions.md](extensions.md)

### Skills

```typescript
import {
  createAgentSession,
  DefaultResourceLoader,
  type Skill,
} from "@earendil-works/pi-coding-agent";

const customSkill: Skill = {
  name: "my-skill",
  description: "Custom instructions",
  filePath: "/path/to/SKILL.md",
  baseDir: "/path/to",
  source: "custom",
};

const loader = new DefaultResourceLoader({
  skillsOverride: (current) => ({
    skills: [...current.skills, customSkill],
    diagnostics: current.diagnostics,
  }),
});
await loader.reload();

const { session } = await createAgentSession({ resourceLoader: loader });
```

> See [examples/sdk/04-skills.ts](../examples/sdk/04-skills.ts)

### Context Files

```typescript
import { createAgentSession, DefaultResourceLoader } from "@earendil-works/pi-coding-agent";

const loader = new DefaultResourceLoader({
  agentsFilesOverride: (current) => ({
    agentsFiles: [
      ...current.agentsFiles,
      { path: "/virtual/AGENTS.md", content: "# Guidelines\n\n- Be concise" },
    ],
  }),
});
await loader.reload();

const { session } = await createAgentSession({ resourceLoader: loader });
```

> See [examples/sdk/07-context-files.ts](../examples/sdk/07-context-files.ts)

### Slash Commands

```typescript
import {
  createAgentSession,
  DefaultResourceLoader,
  type PromptTemplate,
} from "@earendil-works/pi-coding-agent";

const customCommand: PromptTemplate = {
  name: "deploy",
  description: "Deploy the application",
  source: "(custom)",
  content: "# Deploy\n\n1. Build\n2. Test\n3. Deploy",
};

const loader = new DefaultResourceLoader({
  promptsOverride: (current) => ({
    prompts: [...current.prompts, customCommand],
    diagnostics: current.diagnostics,
  }),
});
await loader.reload();

const { session } = await createAgentSession({ resourceLoader: loader });
```

> See [examples/sdk/08-prompt-templates.ts](../examples/sdk/08-prompt-templates.ts)

### Session Management

Sessions use a tree structure with `id`/`parentId` linking, enabling in-place branching.

```typescript
import {
  type CreateAgentSessionRuntimeFactory,
  createAgentSession,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

// In-memory (no persistence)
const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
});

// New persistent session
const { session: persisted } = await createAgentSession({
  sessionManager: SessionManager.create(process.cwd()),
});

// Continue most recent
const { session: continued, modelFallbackMessage } = await createAgentSession({
  sessionManager: SessionManager.continueRecent(process.cwd()),
});
if (modelFallbackMessage) {
  console.log("Note:", modelFallbackMessage);
}

// Open specific file
const { session: opened } = await createAgentSession({
  sessionManager: SessionManager.open("/path/to/session.jsonl"),
});

// List sessions
const currentProjectSessions = await SessionManager.list(process.cwd());
const allSessions = await SessionManager.listAll();

// Session replacement API for /new, /resume, /fork, /clone, and import flows.
const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
  const services = await createAgentSessionServices({ cwd });
  return {
    ...(await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
    })),
    services,
    diagnostics: services.diagnostics,
  };
};

const runtime = await createAgentSessionRuntime(createRuntime, {
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  sessionManager: SessionManager.create(process.cwd()),
});

// Replace the active session with a fresh one
await runtime.newSession();

// Replace the active session with another saved session
await runtime.switchSession("/path/to/session.jsonl");

// Replace the active session with a fork from a specific user entry
await runtime.fork("entry-id");

// Clone the active path through a specific entry
await runtime.fork("entry-id", { position: "at" });
```

**SessionManager tree API:**

```typescript
const sm = await SessionManager.open("/path/to/session.jsonl");

// Session listing
const currentProjectSessions = await SessionManager.list(process.cwd());
const allSessions = await SessionManager.listAll();

// Complete, bounded reads from captured source history
const entries = await sm.readEntries(); // All entries (excludes header)
const tree = await sm.readTree();       // Full tree structure
const path = await sm.readBranch();     // Root-to-leaf parent path
const leaf = await sm.readLeafEntry();  // Current leaf entry
const entry = await sm.readEntry(id);   // Entry by ID
const children = entries.filter((entry) => entry.parentId === id);

// Labels
const label = await sm.readLabel(id);
await sm.appendLabelChange(id, "checkpoint");

// Branching
await sm.branchTo(entryId);
await sm.branchWithSummary(id, "Summary...");
await sm.createBranchedSession(leafId);
```

Owned sessions keep indexed metadata rather than historical message arrays. Complete reads default to 16,384 source entries and 64 MiB of source data; they fail when the limit is exceeded instead of returning a truncated result. Pass explicit limits when needed. Use `readBranches()` for multiple parent paths from one capture. Synchronous body getters remain available only on explicit resident views such as `inMemory()` and `openReadOnly()`.

> See [examples/sdk/11-sessions.ts](../examples/sdk/11-sessions.ts) and [Session Format](session-format.md)

### Settings Management

```typescript
import { createAgentSession, SettingsManager, SessionManager } from "@earendil-works/pi-coding-agent";

// Default: loads from files (global + project merged)
const { session } = await createAgentSession({
  settingsManager: SettingsManager.create(),
});

// With overrides
const settingsManager = SettingsManager.create();
settingsManager.applyOverrides({
  compaction: { enabled: false },
  retry: { enabled: true, maxRetries: 5 },
});
const { session } = await createAgentSession({ settingsManager });

// In-memory (no file I/O, for testing)
const { session } = await createAgentSession({
  settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
  sessionManager: SessionManager.inMemory(),
});

// Custom directories
const { session } = await createAgentSession({
  settingsManager: SettingsManager.create("/custom/cwd", "/custom/agent"),
});
```

**Static factories:**
- `SettingsManager.create(cwd?, agentDir?)` - Load from files
- `SettingsManager.inMemory(settings?)` - No file I/O

**Project-specific settings:**

Settings load from two locations and merge:
1. Global: `~/.prime/agent/settings.json`
2. Project: `<cwd>/.prime/agent/settings.json`

Project overrides global. Nested objects merge keys. Setters modify global settings by default.

**Persistence and error handling semantics:**

- Settings getters/setters are synchronous for in-memory state.
- Setters enqueue persistence writes asynchronously.
- Call `await settingsManager.flush()` when you need a durability boundary (for example, before process exit or before asserting file contents in tests).
- `SettingsManager` does not print settings I/O errors. Use `settingsManager.drainErrors()` and report them in your app layer.

> See [examples/sdk/10-settings.ts](../examples/sdk/10-settings.ts)

## ResourceLoader

Use `DefaultResourceLoader` to discover extensions, skills, prompts, themes, and context files.

```typescript
import {
  DefaultResourceLoader,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";

const loader = new DefaultResourceLoader({
  cwd,
  agentDir: getAgentDir(),
});
await loader.reload();

const extensions = loader.getExtensions();
const skills = loader.getSkills();
const prompts = loader.getPrompts();
const themes = loader.getThemes();
const contextFiles = loader.getAgentsFiles().agentsFiles;
```

## Return Value

`createAgentSession()` returns:

```typescript
interface CreateAgentSessionResult {
  // The session
  session: AgentSession;
  
  // Extensions result (for runner setup)
  extensionsResult: LoadExtensionsResult;
  
  // Warning if session model couldn't be restored
  modelFallbackMessage?: string;
}

interface LoadExtensionsResult {
  extensions: Extension[];
  errors: Array<{ path: string; error: string }>;
  runtime: ExtensionRuntime;
}
```

## Complete Example

```typescript
import { getModel } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
 AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

// Set up auth storage (custom location)
const authStorage = AuthStorage.create("/custom/agent/auth.json");

// Runtime API key override (not persisted)
if (process.env.MY_KEY) {
  authStorage.setRuntimeApiKey("anthropic", process.env.MY_KEY);
}

// Model registry (no custom models.json)
const modelRegistry = ModelRegistry.create(authStorage);

// Inline tool
const statusTool = defineTool({
  name: "status",
  label: "Status",
  description: "Get system status",
  parameters: Type.Object({}),
  execute: async () => ({
    content: [{ type: "text", text: `Uptime: ${process.uptime()}s` }],
    details: {},
  }),
});

const model = getModel("anthropic", "claude-opus-4-5");
if (!model) throw new Error("Model not found");

// In-memory settings with overrides
const settingsManager = SettingsManager.inMemory({
  compaction: { enabled: false },
  retry: { enabled: true, maxRetries: 2 },
});

const loader = new DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir: "/custom/agent",
  settingsManager,
  systemPromptOverride: () => "You are a minimal assistant. Be concise.",
});
await loader.reload();

const { session } = await createAgentSession({
  cwd: process.cwd(),
  agentDir: "/custom/agent",

  model,
  thinkingLevel: "off",
  authStorage,
  modelRegistry,

  tools: ["ipython"],
  customTools: [statusTool],
  resourceLoader: loader,

  sessionManager: SessionManager.inMemory(),
  settingsManager,
});

session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

await session.prompt("Get status and list files.");
```

## Run Modes

The SDK exports run mode utilities for building custom interfaces on top of `createAgentSession()`:

### InteractiveMode

Full TUI interactive mode with editor, chat history, and all built-in commands:

```typescript
import {
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  InteractiveMode,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
  const services = await createAgentSessionServices({ cwd });
  return {
    ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
    services,
    diagnostics: services.diagnostics,
  };
};
const runtime = await createAgentSessionRuntime(createRuntime, {
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  sessionManager: SessionManager.create(process.cwd()),
});

const mode = new InteractiveMode(runtime, {
  migratedProviders: [],
  modelFallbackMessage: undefined,
  initialMessage: "Hello",
  initialImages: [],
  initialMessages: [],
});

await mode.run();
```

### runPrintMode

Single-shot mode: send prompts, output result, exit:

```typescript
import {
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  runPrintMode,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
  const services = await createAgentSessionServices({ cwd });
  return {
    ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
    services,
    diagnostics: services.diagnostics,
  };
};
const runtime = await createAgentSessionRuntime(createRuntime, {
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  sessionManager: SessionManager.create(process.cwd()),
});

await runPrintMode(runtime, {
  mode: "text",
  initialMessage: "Hello",
  initialImages: [],
  messages: ["Follow up"],
});
```

### runRpcMode

JSON-RPC mode for subprocess integration:

```typescript
import {
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  runRpcMode,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
  const services = await createAgentSessionServices({ cwd });
  return {
    ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
    services,
    diagnostics: services.diagnostics,
  };
};
const runtime = await createAgentSessionRuntime(createRuntime, {
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  sessionManager: SessionManager.create(process.cwd()),
});

await runRpcMode(runtime);
```

See [RPC documentation](rpc.md) for the JSON protocol.

## RPC Mode Alternative

For subprocess-based integration without building with the SDK, use the CLI directly:

```bash
prime-agent --mode rpc --no-session
```

See [RPC documentation](rpc.md) for the JSON protocol.

The SDK is preferred when:
- You want type safety
- You're in the same Node.js process
- You need direct access to agent state
- You want to customize tools/extensions programmatically

RPC mode is preferred when:
- You're integrating from another language
- You want process isolation
- You're building a language-agnostic client

## Exports

The main entry point exports:

```typescript
// Factory
createAgentSession
createAgentSessionRuntime
AgentSessionRuntime

// Auth and Models
AuthStorage
ModelRegistry

// Resource loading
DefaultResourceLoader
type ResourceLoader
createEventBus

// Helpers
defineTool

// Session management
SessionManager
SettingsManager

// Tool factories (for custom cwd)
createIpythonTool, createBashTool, createEditTool
createIpythonToolDefinition, createBashToolDefinition, createEditToolDefinition

// Types
type CreateAgentSessionOptions
type CreateAgentSessionResult
type ExtensionFactory
type ExtensionAPI
type ToolDefinition
type Skill
type PromptTemplate
type Tool
```

For extension types, see [extensions.md](extensions.md) for the full API.


### Refinement during shutdown

`session.closeAutoRefineAdmission()` synchronously and permanently stops new automatic
refinement for that session. It does not disable model-visible skills, cancel accepted
calls, or discard an explicitly queued `refine.run`. Native RPC closes this gate before
waiting for accepted commands; its runtime carries closure across an already accepted
session replacement. `disposeAsync()` also closes the gate and drains accepted work
without starting automatic reviews/plans or retrying failed background plans.

The gate does not impose a shutdown deadline. Already accepted work can still be slow.


### Provider-facing task coordinates

New TaskFrame source metadata includes `sessionId`, `entryId`, `field`, and available
`revision`; its captured horizon includes `sessionId`, `leafId`, and `sourceSequence`.
Use these exact identities for `prime_context`, not internal filesystem locators. Full
internal source objects remain available to the compiler. Previously frozen text is
not rewritten, and omitted metadata does not mean missing source or current liveness.


### Child request-budget configuration

Owned native RLM children inherit a detached copy of their live parent's explicit
`requestTokenBudget` configuration unless a trusted creation caller supplies a defined
override. Passive hydration uses that live parent, not retained session metadata.
`session.requests.getRequestTokenBudgetOptions()` returns the detached configuration.
Absence stays absent; no child model profile is inferred. Enforced unknown profiles
still refuse before transport. Calibration, observations and retained prefix credit
are not shared between parent and child budget instances.

### Skill text limits

Skill discovery admits up to 16 KiB of raw frontmatter, including delimiters, with
bounded chunk read-ahead. Explicit selection admits up to 1 MiB for the entire
SKILL.md. A known selected-file read or limit failure emits `skill_expansion` and
rejects the prompt. Unknown skill commands still pass through. The actual returned
capture drives the unchanged expansion and canonical input. These limits do not
bound the aggregate catalog or certify a snapshot against same-size in-place writes.

### Selected skill catalog limits

System-prompt construction admits up to 32 visible skills and 65536 UTF-8 bytes for
the rendered skill catalog, including its unchanged introductory text, XML escaping
and newlines. It includes all selected entries in order or throws
`Skill catalog item limit exceeded` / `Skill catalog byte limit exceeded`. Disabled
skills do not count. Empty and no-file-access cases keep their existing behavior.
The same captured catalog is appended without a second render. These are not
inventory, full-system-prompt, model-fit or module/version-lifecycle bounds.

### Extension imports

Import supported extension values and types from `@ponythewhite/base-context`.
The unimplemented `@ponythewhite/base-context/hooks` subpath is no longer advertised.
Actual ExtensionAPI event handlers and supported root imports are unchanged.
