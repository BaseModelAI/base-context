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
// Use the default built-in tool set: ipython
const { session } = await createAgentSession({
  tools: ["ipython"],
});

// Pick specific tools
const { session } = await createAgentSession({
  tools: ["ipython"],
});
```

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
Closure helpers preserve complete units or refuse, including conservative whole-context
replay when the adapter has not authorized narrower groups. Model-aware token estimates,
provider-budget enforcement and the complete stable-epoch/recovery pipeline remain open.


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
