# Session File Format

Session entries form a tree through `id`/`parentId` links. Their logical JSON shape
is separate from the file's physical storage format.

## Native Storage

Base Context uses **native-framed journals and derived indexes**. The `.jsonl`
extension is retained, but a native journal is not a plain JSONL transcript. Do not
split it into text lines, use `jq` on it, or append/edit records by hand. Use the
native session owner and bounded asynchronous history reads described in the
[SDK guide](sdk.md#session-management) and the SessionManager API below.

The default product paths are:

```text
~/.base-context/sessions/<session-id>.jsonl
~/.base-context/session-artifacts/<session-id>/
```

`BASE_CONTEXT_HOME` selects the product root. `BASE_CONTEXT_SESSION_DIR` can select
an absolute sessions directory. Use `SessionManager.getSessionArtifactDir()` for
the owned artifact path; do not infer that it always uses the default location.
See [Session Storage](sessions.md#session-storage).

## Deleting Sessions

Use the supported session deletion controls in
[Resuming and Deleting Sessions](sessions.md#resuming-and-deleting-sessions), rather
than removing only a journal while its owner or related state remains active.
The old Prime Agent path `~/.prime/agent/sessions/` is not Base Context's product root.

## Legacy JSONL and Payload Versions

Ordinary flat JSONL is a **legacy import format**, not the native storage format.
Use [explicit offline import](sessions.md#importing-an-external-session). Importing
retains source data; it does not turn old execution claims into live native authority.
Do not place a legacy JSONL file in the native directory and assume opening it will
perform an implicit migration.

The logical session header versions are distinct from native framing, ownership
and RPC versions:

- **Version 1**: legacy linear entry sequence.
- **Version 2**: tree structure with `id`/`parentId` links.
- **Version 3**: `hookMessage` renamed to `custom`.

The explicit import path documents which older headers it accepts and converts.
A version-3 header alone does not establish whether the containing file is plain
JSONL or native-framed. The entry examples below describe logical payloads, not
bytes that can be appended directly to a native journal.

## Source Files

- [`session-manager.ts`](../src/core/session-manager.ts) - Session entry types and `SessionManager`
- [`messages.ts`](../src/core/messages.ts) - Extended message types (`BashExecutionMessage`, `CustomMessage`, and others)
- [`packages/ai/src/types.ts`](../../ai/src/types.ts) - Base message types (`UserMessage`, `AssistantMessage`, `ToolResultMessage`)
- [`packages/agent/src/types.ts`](../../agent/src/types.ts) - `AgentMessage` union type

For TypeScript definitions in an installed Base Context project, inspect `node_modules/@ponythewhite/base-context/dist/` and `node_modules/@ponythewhite/base-context-ai/dist/`.

## Message Types

Session entries contain `AgentMessage` objects. Understanding these types is essential for parsing sessions and writing extensions.

### Content Blocks

Messages contain arrays of typed content blocks:

```typescript
interface TextContent {
  type: "text";
  text: string;
}

interface ImageContent {
  type: "image";
  data: string;      // base64 encoded
  mimeType: string;  // e.g., "image/jpeg", "image/png"
}

interface ThinkingContent {
  type: "thinking";
  thinking: string;
}

interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, any>;
}
```

### Base Message Types (Base Context AI)

```typescript
interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp: number;  // Unix ms
}

interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
  api: string;
  provider: string;
  model: string;
  usage: Usage;
  stopReason: "stop" | "length" | "toolUse" | "error" | "aborted";
  errorMessage?: string;
  timestamp: number;
}

interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  details?: any;      // Tool-specific metadata
  isError: boolean;
  timestamp: number;
}

interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}
```

### Extended Message Types (Base Context Coding Agent)

```typescript
interface BashExecutionMessage {
  role: "bashExecution";
  command: string;
  output: string;
  exitCode: number | undefined;
  cancelled: boolean;
  truncated: boolean;
  fullOutputPath?: string;
  excludeFromContext?: boolean;  // true for !! prefix commands
  timestamp: number;
}

interface CustomMessage {
  role: "custom";
  customType: string;            // Extension identifier
  content: string | (TextContent | ImageContent)[];
  display: boolean;              // Show in TUI
  details?: any;                 // Extension-specific metadata
  timestamp: number;
}

interface BranchSummaryMessage {
  role: "branchSummary";
  summary: string;
  fromId: string;                // Entry we branched from
  timestamp: number;
}

interface CompactionSummaryMessage {
  role: "compactionSummary";
  summary: string;
  tokensBefore: number;
  timestamp: number;
}
```

### AgentMessage Union

```typescript
type AgentMessage =
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
  | BashExecutionMessage
  | CustomMessage
  | BranchSummaryMessage
  | CompactionSummaryMessage;
```

## Entry Base

All entries (except `SessionHeader`) extend `SessionEntryBase`:

```typescript
interface SessionEntryBase {
  type: string;
  id: string;           // 8-char hex ID
  parentId: string | null;  // Parent entry ID (null for first entry)
  timestamp: string;    // ISO timestamp
}
```

## Entry Types

### SessionHeader

First line of the file. Metadata only, not part of the tree (no `id`/`parentId`).

```json
{"type":"session","version":3,"id":"uuid","timestamp":"2024-12-03T14:00:00.000Z","cwd":"/path/to/project"}
```

For sessions with a parent (created via `/fork`, `/clone`, or `newSession({ parentSession })`):

```json
{"type":"session","version":3,"id":"uuid","timestamp":"2024-12-03T14:00:00.000Z","cwd":"/path/to/project","parentSession":"/path/to/original/session.jsonl"}
```

### SessionMessageEntry

A message in the conversation. The `message` field contains an `AgentMessage`.

```json
{"type":"message","id":"a1b2c3d4","parentId":"prev1234","timestamp":"2024-12-03T14:00:01.000Z","message":{"role":"user","content":"Hello"}}
{"type":"message","id":"b2c3d4e5","parentId":"a1b2c3d4","timestamp":"2024-12-03T14:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Hi!"}],"provider":"anthropic","model":"claude-sonnet-4-5","usage":{...},"stopReason":"stop"}}
{"type":"message","id":"c3d4e5f6","parentId":"b2c3d4e5","timestamp":"2024-12-03T14:00:03.000Z","message":{"role":"toolResult","toolCallId":"call_123","toolName":"bash","content":[{"type":"text","text":"output"}],"isError":false}}
```

### ModelChangeEntry

Emitted when the user switches models mid-session.

```json
{"type":"model_change","id":"d4e5f6g7","parentId":"c3d4e5f6","timestamp":"2024-12-03T14:05:00.000Z","provider":"openai","modelId":"gpt-4o"}
```

### ThinkingLevelChangeEntry

Emitted when the user changes the thinking/reasoning level.

```json
{"type":"thinking_level_change","id":"e5f6g7h8","parentId":"d4e5f6g7","timestamp":"2024-12-03T14:06:00.000Z","thinkingLevel":"high"}
```

### ServiceTierChangeEntry

Emitted when the user changes provider service tier.

```json
{"type":"service_tier_change","id":"e6f7g8h9","parentId":"e5f6g7h8","timestamp":"2024-12-03T14:07:00.000Z","serviceTier":"priority"}
```

### CompactionEntry

Created when context is compacted. Stores a summary of earlier messages.

```json
{"type":"compaction","id":"f6g7h8i9","parentId":"e5f6g7h8","timestamp":"2024-12-03T14:10:00.000Z","summary":"User discussed X, Y, Z...","firstKeptEntryId":"c3d4e5f6","tokensBefore":50000}
```

Optional fields:
- `details`: Implementation-specific data (e.g., `{ readFiles: string[], modifiedFiles: string[] }` for default, or custom data for extensions)
- `fromHook`: `true` if generated by an extension, `false`/`undefined` if generated by Base Context (legacy field name)

### BranchSummaryEntry

Created when switching branches via `/tree` with an LLM generated summary of the left branch up to the common ancestor. Captures context from the abandoned path.

```json
{"type":"branch_summary","id":"g7h8i9j0","parentId":"a1b2c3d4","timestamp":"2024-12-03T14:15:00.000Z","fromId":"f6g7h8i9","summary":"Branch explored approach A..."}
```

Optional fields:
- `details`: File tracking data (`{ readFiles: string[], modifiedFiles: string[] }`) for default, or custom data for extensions
- `fromHook`: `true` if generated by an extension, `false`/`undefined` if generated by Base Context (legacy field name)

### CustomEntry

Extension state persistence. Does NOT participate in LLM context.

```json
{"type":"custom","id":"h8i9j0k1","parentId":"g7h8i9j0","timestamp":"2024-12-03T14:20:00.000Z","customType":"my-extension","data":{"count":42}}
```

Use `customType` to identify your extension's entries on reload.

### ChildUsageAttributionEntry

Records RLM child usage folded into a parent assistant message. This entry is daemon bookkeeping and does not enter model context.

```typescript
interface ChildUsageAttributionEntry extends SessionEntryBase {
  type: "child_usage_attributed";
  targetId: string;       // Parent assistant message entry
  childUsage: Usage;      // Usage added by one child
  aggregateUsage: Usage;  // Updated parent aggregate
}
```

Reload applies `aggregateUsage` to the target assistant message. Context-tree accounting can then subtract `childUsage` when reporting the parent node's own usage.

### CustomMessageEntry

Extension-injected messages that DO participate in LLM context.

```json
{"type":"custom_message","id":"i9j0k1l2","parentId":"h8i9j0k1","timestamp":"2024-12-03T14:25:00.000Z","customType":"my-extension","content":"Injected context...","display":true}
```

Fields:
- `content`: String or `(TextContent | ImageContent)[]` (same as UserMessage)
- `display`: `true` = show in TUI with distinct styling, `false` = hidden
- `details`: Optional extension-specific metadata (not sent to LLM)

### LabelEntry

User-defined bookmark/marker on an entry.

```json
{"type":"label","id":"j0k1l2m3","parentId":"i9j0k1l2","timestamp":"2024-12-03T14:30:00.000Z","targetId":"a1b2c3d4","label":"checkpoint-1"}
```

Set `label` to `undefined` to clear a label.

### SessionInfoEntry

Session metadata (e.g., user-defined display name). Set via `/name` command or `pi.setSessionName()` in extensions.

```json
{"type":"session_info","id":"k1l2m3n4","parentId":"j0k1l2m3","timestamp":"2024-12-03T14:35:00.000Z","name":"Refactor auth module"}
```

The session name is displayed in the session selector (`/resume`) instead of the first message when set.

### SessionStateEntry

Stores daemon-managed lifecycle state. Current persisted states are `active`, `archived`, and legacy `crash`; older `sleep` values normalize to `archived` when read.

### AgentStatusEntry

Stores the latest short agent status shown in the agents view, including its summary, optional task state, and source message count. It does not enter model context.

### GitStateEntry

Stores an append-only repository-state snapshot for agent status and recovery views. It does not enter model context.

## Tree Structure

Entries form a tree:
- First entry has `parentId: null`
- Each subsequent entry points to its parent via `parentId`
- Branching creates new children from an earlier entry
- The "leaf" is the current position in the tree

```
[user msg] ─── [assistant] ─── [user msg] ─── [assistant] ─┬─ [user msg] ← current leaf
                                                            │
                                                            └─ [branch_summary] ─── [user msg] ← alternate branch
```

## Context Building

For explicit resident views, `buildSessionContext()` walks from the current leaf
to the root. The following describes logical message reconstruction, not a native
journal parser or the full native working-set selection contract. On indexed owned
sessions, use `await AgentSession.buildSessionContext()` for the native working
context, or the bounded asynchronous SessionManager reads below for detached history:


1. Collects all entries on the path
2. Extracts current model and thinking level settings
3. If a `CompactionEntry` is on the path:
   - Emits the summary first
   - Then messages from `firstKeptEntryId` to compaction
   - Then messages after compaction
4. Converts `BranchSummaryEntry` and `CustomMessageEntry` to appropriate message formats

Bookkeeping entries such as child usage attribution, session lifecycle, agent status, and git state are ignored when building model context.

## Legacy JSONL Parsing Example

This whole-file example is only for a small, coherent **offline legacy JSONL file**.
It is not a native journal reader or an import implementation. Use the explicit
import command for migration and native bounded reads for owned session history.

```typescript
import { readFileSync } from "fs";

const lines = readFileSync("legacy-session.jsonl", "utf8").trim().split("\n");

for (const line of lines) {
  const entry = JSON.parse(line);

  switch (entry.type) {
    case "session":
      console.log(`Session v${entry.version ?? 1}: ${entry.id}`);
      break;
    case "message":
      console.log(`[${entry.id}] ${entry.message.role}: ${JSON.stringify(entry.message.content)}`);
      break;
    case "compaction":
      console.log(`[${entry.id}] Compaction: ${entry.tokensBefore} tokens summarized`);
      break;
    case "branch_summary":
      console.log(`[${entry.id}] Branch from ${entry.fromId}`);
      break;
    case "custom":
      console.log(`[${entry.id}] Custom (${entry.customType}): ${JSON.stringify(entry.data)}`);
      break;
    case "custom_message":
      console.log(`[${entry.id}] Extension message (${entry.customType}): ${entry.content}`);
      break;
    case "label":
      console.log(`[${entry.id}] Label "${entry.label}" on ${entry.targetId}`);
      break;
    case "model_change":
      console.log(`[${entry.id}] Model: ${entry.provider}/${entry.modelId}`);
      break;
    case "thinking_level_change":
      console.log(`[${entry.id}] Thinking: ${entry.thinkingLevel}`);
      break;
  }
}
```

## SessionManager API

Key methods for working with sessions programmatically. Await asynchronous
creation, listing, historical reads and writes as shown in the [SDK](sdk.md#session-management).
The synchronous metadata and explicit resident-view exceptions are noted below.

### Static Creation Methods
- `SessionManager.create(cwd, sessionDir?)` - New session
- `SessionManager.open(path, sessionDir?)` - Open existing session file
- `SessionManager.continueRecent(cwd, sessionDir?)` - Continue most recent or create new
- `SessionManager.inMemory(cwd?)` - No file persistence
- `SessionManager.forkFrom(sourcePath, targetCwd, sessionDir?)` - Fork session from another project

### Static Listing Methods
- `SessionManager.list(cwd, sessionDir?, callbacks?)` - List sessions for a directory
- `SessionManager.listAll(callbacks?, sessionDir?)` - List all sessions across all projects

`callbacks` can provide `onProgress(loaded, total)` and `onSession(session)` handlers.

### Instance Methods - Session Management
- `newSession(options?)` - Start a new session (options: `{ parentSession?: string }`)
- `setSessionFile(path)` - Switch to a different session file
- `createBranchedSession(leafId)` - Extract branch to new session file

### Instance Methods - Appending (all return entry ID)
- `appendMessage(message)` - Add message
- `appendThinkingLevelChange(level)` - Record thinking change
- `appendServiceTierChange(tier)` - Record provider service-tier change
- `appendModelChange(provider, modelId)` - Record model change
- `appendCompaction(summary, firstKeptEntryId, tokensBefore, details?, fromHook?, customInstructions?)` - Add compaction
- `appendCustomEntry(customType, data?)` - Extension state (not in context)
- `appendChildUsageAttribution(targetId, childUsage, aggregateUsage)` - Persist RLM child usage folded into a parent assistant message
- `appendSessionInfo(name)` - Set session display name
- `appendSessionState(state)` - Record daemon-managed lifecycle state
- `appendAgentStatus(status)` - Record an agents-view status summary
- `appendGitState(git)` - Record repository state
- `appendCustomMessageEntry(customType, content, display, details?)` - Extension message (in context)
- `appendLabelChange(targetId, label)` - Set/clear label

### Instance Methods - Tree Navigation

Use `await` for historical reads and mutations on owned sessions. Complete reads default to 16,384 source entries and 64 MiB of source data. They return the complete requested result or raise a limit error. Each read captures its source; `readBranches()` shares one capture across multiple paths.

- `getLeafId()` - Current position (synchronous metadata)
- `readLeafEntry(maxSourceBytes?)` - Current leaf entry
- `readEntry(id, maxSourceBytes?)` - Detached entry by ID
- `readBranch(fromId?, limits?)` - Complete root-to-leaf parent path
- `readBranches(leafIds, limits?)` - Multiple paths with shared source-entry accounting
- `readTree(limits?)` - Complete tree structure
- `readLabel(id, maxSourceBytes?)` - Label for an entry
- `branchTo(entryId)` - Move the leaf; pass null for the position before any entries
- `branchWithSummary(entryId, summary, details?, fromHook?)` - Branch with context summary

Synchronous body getters such as `getEntry()`, `getBranch()`, `getEntries()`, and `buildSessionContext()` are resident-view APIs only. They reject indexed owned sessions. Explicit `inMemory()` and `openReadOnly()` views retain their resident behavior. Use `AgentSession.buildSessionContext()` for the native asynchronous working-context rebuild.

### Instance Methods - Context & Info
- `readEntries(limits?)` - Complete detached entries (excluding header)
- `readEntryRetention(id)` - Source qualification; absence does not establish authorship
- `supportsCapturedHistoryReads()` - Whether this Manager supports owned captured reads
- `getHeader()` - Session header metadata
- `getSessionName()` - Get display name from latest session_info entry
- `getCwd()` - Working directory
- `getSessionDir()` - Session storage directory
- `getSessionId()` - Session UUID
- `getSessionFile()` - Session file path (undefined for in-memory)
- `isPersisted()` - Whether session is saved to disk
