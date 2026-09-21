# Compaction & Branch Summarization

LLMs have limited context windows. When conversations grow too long, Base Context uses compaction to summarize older content while preserving recent work. This page covers both auto-compaction and branch summarization. See [context management](context-management.md) for the broader working-set, retrieval, epoch, and request-budget model.

**Source files:**
- [`compaction.ts`](../src/core/compaction/compaction.ts) - Auto-compaction logic
- [`branch-summarization.ts`](../src/core/compaction/branch-summarization.ts) - Branch summarization
- [`utils.ts`](../src/core/compaction/utils.ts) - Shared utilities (file tracking, serialization)
- [`session-manager.ts`](../src/core/session-manager.ts) - Entry types (`CompactionEntry`, `BranchSummaryEntry`)
- [`extensions/types.ts`](../src/core/extensions/types.ts) - Extension event types

The linked source files define the current Base Context API. Package availability and source installation are described in the [package README](../README.md).

## Overview

Base Context has two summarization mechanisms:

| Mechanism | Trigger | Purpose |
|-----------|---------|---------|
| Compaction | Context exceeds threshold, or `/compact` | Summarize old messages to free up context |
| Branch summarization | `/tree` navigation | Preserve context when switching branches |

Both use the same structured summary format and track file operations cumulatively.

The diagrams below describe summary-and-tail mechanics, not an exact native provider
request. Native context also uses captured source, accepted epochs, required replay
groups and bounded recovery. A missing source or boundary can refuse rather than
silently produce an incomplete context.

Compaction does not establish whether a Python kernel, its variables or background
jobs are still available. Use current runtime reports; do not infer either survival
or loss from a summary alone.

## Compaction

### When It Triggers

Auto-compaction uses 90% of the model context window as its default soft target:

```
softTarget = floor(0.9 * contextWindow)
threshold = min(contextWindow - reserveTokens, max(softTarget, fixedContextTokens + 4 * keepRecentTokens))
contextTokens > threshold
```

With default `keepRecentTokens` of 20000 and `reserveTokens` of 16384, before
fixed-context headroom raises the target, the thresholds are 244800 for a
272000-token model, 111616 for a 128000-token model, and 47616 for a 64000-token
model. The model-window reserve can therefore trigger compaction before 90%.
The model-window ceiling always applies.

`fixedContextTokens` estimates current system instructions, tool schemas, the
current TaskFrame and latest harness snapshot. It does not count all historical
messages or obsolete snapshots as fixed. Reserving room above this context avoids
repeated ineffective summaries when required instructions already exceed the
soft target. These are local estimates, not exact provider token counts.

Set `compaction.targetTokens` to a positive safe integer to replace the soft
target; required-context headroom can still raise a numeric target. Set
`"model-limit"` to use exactly `contextWindow - reserveTokens` instead.
Configure these settings in `~/.base-context/settings.json` or
`<project-dir>/.base-context/settings.json`.

This is a compaction heuristic, not a strict request cap, a validated backend
limit, or a promise of optimal token use. Earlier summaries trade shorter replay
for summary calls and possible rereads. Required instructions and replay
dependencies are not clipped to meet this target. Explicit SDK request-token
budgets remain separate; see [context management](context-management.md#model-aware-budgets).

You can also trigger manually with `/compact [instructions]`, where optional instructions focus the summary — for example `/compact focus on the auth refactor, remember the exact migration command`. The instructions are passed to the summarization prompt with high priority, persisted on the `CompactionEntry`, and shown on the `[compaction]` message in the TUI.

### Agent-Requested Compaction

The agent can request compaction before the automatic threshold, including when
using Astra. The bundled `compact` skill is enabled by default and runs from the
Python REPL:

```python
await compact.status()
await compact.run("keep the remaining plan and exact test names")
```

`status()` reports `tokens`, `context_window`, `percent`, and `scheduled`. Usage
can be unknown immediately after compaction. `run()` schedules compaction at the
next turn boundary, not in the middle of the Python cell. It returns
`{"scheduled": True}` when accepted, or `{"scheduled": False, "reason": ...}`
when no turn is active or there is nothing to compact yet. Optional instructions
focus the summary. Repeating the request before the boundary updates them.
Interrupted tool work can continue after the checkpoint; this does not start new
work after an otherwise completed turn.

This request does not depend on the automatic threshold or `compaction.enabled`.
It requires context optimization to be on. `compaction.agentCallable: false`
disables the skill, and disabling Python or bundled skills can remove its normal
entry point. Each recursive agent uses its own session's compaction path; children
inherit the parent's compact-skill availability. There is no Astra-specific gate.
A request compacts the requesting session, not the whole agent tree.

### How It Works

1. **Find cut point**: Walk backwards from newest message, accumulating token estimates until `keepRecentTokens` (default 20k, configurable in `~/.base-context/settings.json` or `<project-dir>/.base-context/settings.json`) is reached
2. **Extract messages**: Collect messages from the previous kept boundary (or session start) up to the cut point
3. **Generate summary**: Call LLM to summarize with structured format, passing the previous summary as iterative context when present
4. **Append entry**: Save `CompactionEntry` with summary and `firstKeptEntryId`
5. **Reload**: Session reloads, using summary + messages from `firstKeptEntryId` onwards

```
Before compaction:

  entry:  0     1     2     3      4     5     6      7      8     9
        ┌─────┬─────┬─────┬─────┬──────┬─────┬─────┬──────┬──────┬─────┐
        │ hdr │ usr │ ass │ tool │ usr │ ass │ tool │ tool │ ass │ tool│
        └─────┴─────┴─────┴──────┴─────┴─────┴──────┴──────┴─────┴─────┘
                └────────┬───────┘ └──────────────┬──────────────┘
               messagesToSummarize            kept messages
                                   ↑
                          firstKeptEntryId (entry 4)

After compaction (new entry appended):

  entry:  0     1     2     3      4     5     6      7      8     9     10
        ┌─────┬─────┬─────┬─────┬──────┬─────┬─────┬──────┬──────┬─────┬─────┐
        │ hdr │ usr │ ass │ tool │ usr │ ass │ tool │ tool │ ass │ tool│ cmp │
        └─────┴─────┴─────┴──────┴─────┴─────┴──────┴──────┴─────┴─────┴─────┘
               └──────────┬──────┘ └──────────────────────┬───────────────────┘
                 not sent to LLM                    sent to LLM
                                                         ↑
                                              starts from firstKeptEntryId

What the LLM sees:

  ┌────────┬─────────┬─────┬─────┬──────┬──────┬─────┬──────┐
  │ system │ summary │ usr │ ass │ tool │ tool │ ass │ tool │
  └────────┴─────────┴─────┴─────┴──────┴──────┴─────┴──────┘
       ↑         ↑      └─────────────────┬────────────────┘
    prompt   from cmp          messages from firstKeptEntryId
```

On repeated compactions, the resident `prepareCompaction` helper starts at the
previous `firstKeptEntryId` when that entry is present. Its legacy fallback starts
after the previous compaction entry. This helper fallback is not a promise that
native captured-history reads accept an unavailable retained boundary.

`tokensBefore` records a prior-context estimate, or `null` when the original
context is not measurable. It is not an exact serialized-provider token count or
a guarantee that the reconstructed context matches a previous request.

### Split Turns

A "turn" starts with a user message and includes all assistant responses and tool calls until the next user message. Normally, compaction cuts at turn boundaries.

When a single turn exceeds `keepRecentTokens`, the cut point lands mid-turn at an assistant message. This is a "split turn":

```
Split turn (one huge turn exceeds budget):

  entry:  0     1     2      3     4      5      6     7      8
        ┌─────┬─────┬─────┬──────┬─────┬──────┬──────┬─────┬──────┐
        │ hdr │ usr │ ass │ tool │ ass │ tool │ tool │ ass │ tool │
        └─────┴─────┴─────┴──────┴─────┴──────┴──────┴─────┴──────┘
                ↑                                     ↑
         turnStartIndex = 1                  firstKeptEntryId = 7
                │                                     │
                └──── turnPrefixMessages (1-6) ───────┘
                                                      └── kept (7-8)

  isSplitTurn = true
  messagesToSummarize = []  (no complete turns before)
  turnPrefixMessages = [usr, ass, tool, ass, tool, tool]
```

For split turns, Base Context generates two summaries and merges them:
1. **History summary**: Previous context (if any)
2. **Turn prefix summary**: The early part of the split turn

### Cut Point Rules

Valid cut points are:
- User messages
- Assistant messages
- BashExecution messages
- Custom messages (custom_message, branch_summary)

Never cut at tool results (they must stay with their tool call).

### CompactionEntry Structure

Defined in [`session-manager.ts`](../src/core/session-manager.ts):

```typescript
interface CompactionEntry<T = unknown> {
  type: "compaction";
  id: string;
  parentId: string | null;
  timestamp: string;
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number | null;
  fromHook?: boolean;  // true if provided by extension (legacy field name)
  details?: T;         // implementation-specific data
  customInstructions?: string;  // user instructions from /compact <instructions>
}

// Default compaction uses this for details (from compaction.ts):
interface CompactionDetails {
  readFiles: string[];
  modifiedFiles: string[];
}
```

Extensions can store any JSON-serializable data in `details`. The default compaction tracks file operations, but custom extension implementations can use their own structure.

See [`prepareCompaction()` and `compact()`](../src/core/compaction/compaction.ts) for the implementation.

### Stop and Resume Ownership

At a compatible turn boundary, native checkpoint control uses the loop's finalized
tool-batch decision and existing accepted session inputs. The last message's role
is not a resume instruction. If every finalized tool result requests termination,
that batch does not request an automatic follow-up. Separately accepted goal,
autonomous or user input can still own more work.

Automatic threshold admission respects the existing context-optimization gate.
An explicit request accepted while permitted retains its existing ownership; this
does not grant new compaction permission while optimization is off.

A `checkpoint_then_continue` intent does not mean that a checkpoint has committed.
The existing compaction owner records the accepted checkpoint and completes its
setup/release before normal success resumption. Queued inputs go first. An input
invocation that consumes the interrupted boundary must not leave an extra resume
behind. Ordinary completed-turn compaction with no further work finishes normally.

The existing policy can resume interrupted work after a skipped compaction or an
ordinary failure. No ACK is not proof that no write occurred. Abort does not resume.
A known checkpoint ACK followed by setup or release failure remains a committed
checkpoint plus a later failure, not a reason to repeat the summary or auto-resume.
The transient resume intent does not add crash recovery or change accepted queued
input and epoch formats.

## Branch Summarization

### When It Triggers

When you use `/tree` to navigate to a different branch, Base Context offers to summarize the work you're leaving. This injects context from the left branch into the new branch.

### How It Works

1. **Find common ancestor**: Deepest node shared by old and new positions
2. **Collect entries**: Walk from old leaf back to common ancestor
3. **Prepare with budget**: Include messages up to token budget (newest first)
4. **Generate summary**: Call LLM with structured format
5. **Append entry**: Save `BranchSummaryEntry` at navigation point

```
Tree before navigation:

         ┌─ B ─ C ─ D (old leaf, being abandoned)
    A ───┤
         └─ E ─ F (target)

Common ancestor: A
Entries to summarize: B, C, D

After navigation with summary:

         ┌─ B ─ C ─ D ─ [summary of B,C,D]
    A ───┤
         └─ E ─ F (new leaf)
```

### Cumulative File Tracking

Both compaction and branch summarization track files cumulatively. When generating a summary, Base Context extracts file operations from:
- Tool calls in the messages being summarized
- Previous compaction or branch summary `details` (if any)

This means file tracking accumulates across multiple compactions or nested branch summaries, preserving the full history of read and modified files.

### BranchSummaryEntry Structure

Defined in [`session-manager.ts`](../src/core/session-manager.ts):

```typescript
interface BranchSummaryEntry<T = unknown> {
  type: "branch_summary";
  id: string;
  parentId: string;
  timestamp: number;
  summary: string;
  fromId: string;      // Entry we navigated from
  fromHook?: boolean;  // true if provided by extension (legacy field name)
  details?: T;         // implementation-specific data
}

// Default branch summarization uses this for details (from branch-summarization.ts):
interface BranchSummaryDetails {
  readFiles: string[];
  modifiedFiles: string[];
}
```

Same as compaction, extensions can store custom data in `details`.

See [`collectEntriesForBranchSummary()`, `prepareBranchEntries()`, and `generateBranchSummary()`](../src/core/compaction/branch-summarization.ts) for the implementation.

## Summary Format

Both compaction and branch summarization use the same structured format:

```markdown
## Goal
[What the user is trying to accomplish]

## Constraints & Preferences
- [Requirements mentioned by user]

## Progress
### Done
- [x] [Completed tasks]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues, if any]

## Key Decisions
- **[Decision]**: [Rationale]

## Next Steps
1. [What should happen next]

## Critical Context
- [Data needed to continue]

<read-files>
path/to/file1.ts
path/to/file2.ts
</read-files>

<modified-files>
path/to/changed.ts
</modified-files>
```

### Message Serialization

Before summarization, messages are serialized to text via [`serializeConversation()`](../src/core/compaction/utils.ts):

```
[User]: What they said
[Assistant thinking]: Internal reasoning
[Assistant]: Response text
[Assistant tool calls]: ipython(code="open('foo.ts').read()"); edit(path="bar.ts", ...)
[Tool result]: Output from tool
```

This prevents the model from treating it as a conversation to continue.

Tool results are truncated to 2000 characters during serialization. Content beyond that limit is replaced with a marker indicating how many characters were truncated. This keeps summarization requests within reasonable token budgets, since tool results, especially from `ipython` and optional `bash`, are typically the largest contributors to context size.

## Custom Summarization via Extensions

Extensions can intercept and customize both compaction and branch summarization. See [`extensions/types.ts`](../src/core/extensions/types.ts) for event type definitions.

### session_before_compact

Fired before auto-compaction or `/compact`. Can cancel or provide custom summary. See `SessionBeforeCompactEvent` and `CompactionPreparation` in the types file.

```typescript
pi.on("session_before_compact", async (event, ctx) => {
  const { preparation, branchEntries, customInstructions, signal } = event;

  // preparation.messagesToSummarize - messages to summarize
  // preparation.turnPrefixMessages - split turn prefix (if isSplitTurn)
  // preparation.previousSummary - previous compaction summary
  // preparation.fileOps - extracted file operations
  // preparation.tokensBefore - context tokens before compaction
  // preparation.firstKeptEntryId - where kept messages start
  // preparation.settings - compaction settings

  // branchEntries - all entries on current branch (for custom state)
  // signal - AbortSignal (pass to LLM calls)

  // Cancel:
  return { cancel: true };

  // Custom summary:
  return {
    compaction: {
      summary: "Your summary...",
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
      details: { /* custom data */ },
    }
  };
});
```

#### Converting Messages to Text

To generate a summary with your own model, convert messages to text using `serializeConversation`:

```typescript
import { convertToLlm, serializeConversation } from "@ponythewhite/base-context";

pi.on("session_before_compact", async (event, ctx) => {
  const { preparation } = event;
  
  // Convert AgentMessage[] to Message[], then serialize to text
  const conversationText = serializeConversation(
    convertToLlm(preparation.messagesToSummarize)
  );
  // Returns:
  // [User]: message text
  // [Assistant thinking]: thinking content
  // [Assistant]: response text
  // [Assistant tool calls]: ipython(code="open('...').read()"); bash(command="...")
  // [Tool result]: output text

  // Now send to your model for summarization
  const summary = await myModel.summarize(conversationText);
  
  return {
    compaction: {
      summary,
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
    }
  };
});
```

See [custom-compaction.ts](../examples/extensions/custom-compaction.ts) for a complete example using a different model.

### session_before_tree

Fired before `/tree` navigation. Always fires regardless of whether user chose to summarize. Can cancel navigation or provide custom summary.

```typescript
pi.on("session_before_tree", async (event, ctx) => {
  const { preparation, signal } = event;

  // preparation.targetId - where we're navigating to
  // preparation.oldLeafId - current position (being abandoned)
  // preparation.commonAncestorId - shared ancestor
  // preparation.entriesToSummarize - entries that would be summarized
  // preparation.userWantsSummary - whether user chose to summarize

  // Cancel navigation entirely:
  return { cancel: true };

  // Provide custom summary (only used if userWantsSummary is true):
  if (preparation.userWantsSummary) {
    return {
      summary: {
        summary: "Your summary...",
        details: { /* custom data */ },
      }
    };
  }
});
```

See `SessionBeforeTreeEvent` and `TreePreparation` in the types file.

## Settings

Configure compaction in `~/.base-context/settings.json` or `<project-dir>/.base-context/settings.json`:

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  }
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `enabled` | `true` | Enable auto-compaction |
| `reserveTokens` | `16384` | Headroom used by the compaction threshold |
| `keepRecentTokens` | `20000` | Estimated recent-token target for the retained tail |
| `targetTokens` | 90% of the model context window | Positive safe integer to override the soft target, or `"model-limit"` for the model-window threshold; fixed-context headroom and the model reserve still apply as described above |
| `agentCallable` | `true` | Expose the `compact` skill so the agent can request earlier compaction |

Disable automatic compaction with `"compaction": { "enabled": false }`. Manual
`/compact` and agent-requested compaction remain available while `context.mode` is `"on"`. Setting `context.mode`
to `"off"` disables context optimization, including manual compaction; logging,
recovery, limits and other non-optimization ownership remain active.

These threshold and tail settings are not a complete provider-request token limit
or a spending quota.
