# Sessions

Base Context saves conversations as sessions so you can continue work, branch from earlier turns, and revisit previous paths.

## Session Storage

Sessions use the owned `~/.base-context/sessions/` tree by default. `BASE_CONTEXT_HOME` and the existing session-directory settings can change that location. Native sessions use owned journals and derived indexes; a `.jsonl` filename does not imply an ordinary editable JSONL file.

```bash
base-context --continue          # Continue the most recent session
base-context --resume [path|id]  # Browse past sessions or resume one directly
base-context --no-session        # Ephemeral mode; do not save
base-context --fork <path|id>    # Fork a session file or partial session ID into a new session
```

Use `/session` in interactive mode to see the current session file, session ID, and message count. Use `/usage` for token, cost, and context usage.

For the JSONL file format and SessionManager API, see [Session Format](session-format.md).

## Session Commands

| Command | Description |
|---------|-------------|
| `/resume` | Browse and select previous sessions |
| `/new` | Start a new session |
| `/name <name>` | Set the current session display name |
| `/session` | Show session info |
| `/usage` | Show token, cost, and context usage |
| `/tree` | Navigate the current session tree |
| `/fork` | Create a new session from a previous user message |
| `/clone` | Duplicate the current active branch into a new session |
| `/compact [prompt]` | Summarize older context; see [Compaction](compaction.md) |
| `/export [file]` | Export session to HTML |
| `/share` | Upload as private GitHub gist with shareable HTML link |

## Importing an External Session

Use an explicit file path to create a new owned session in the current project:

```bash
base-context session import /path/to/session.jsonl
```

The command prints the new session path. It does not resume the session or start
an agent runtime. Use `base-context --resume <printed-path>` separately if desired.
The source is read-only. No credentials, settings, packages, Python environment or
running processes are migrated.

This route uses `SessionManager.importRetainedFrom`, including for native-framed
input. Copied entries are retained imports, not newly admitted native authority.
The existing `--fork` route is a different copy operation; it does not force this
lowering for every source. Source claims about tools, jobs or variables do not make
those resources live in the new session. Native version6 tool-continuation copies
still refuse because they need their original native execution source.

Explicit retained imports accept missing-version/v1, v2 and current v3 session
headers. Future or invalid versions and an incomplete final record refuse before
destination creation. Records must be LF-terminated. The reader holds one read-only
descriptor and imports within one captured size; this is not an atomic snapshot of
a file that is still changing.

The existing copy limits are 16,384 entries after the header and 64MiB of consumed
JSON payload, including header bytes. These are not raw-file-size or global-memory
limits. Supported older payloads use the existing conversion path. Some later copy
or activation failures can leave an owned destination; there is no automatic
delete/rollback or atomic whole-import guarantee. A successful import and a later
close/report error remain separate outcomes.

## Resuming and Deleting Sessions

In a running session, `/resume` opens the agents view. Its live roster is separate
from saved-session browsing. `base-context --resume` opens startup session selection,
and `base-context --resume <path|id>` resumes a specific session.

Saved-session results in the agents view are queried and paged by the existing
catalog. A page holds at most 64 saved rows, including required ancestor/context
rows, and 1MiB of encoded page data. Search and scope apply before page selection.
New pages replace old pages; browsing does not retain the whole archive. Page counts
and partial rollups are not totals for all saved sessions. The separate live roster
is outside this saved-page budget.

Paging preserves the agents view's existing hierarchy and ranking, including its
empty-session, anchor, heartbeat and busy-descendant rules. Continuations use that
order, not modification time alone. Relevant ordering-context changes reset the
saved page. This is a live listing, not a frozen snapshot; metadata changes can
require a refresh. Metadata traversal can still scale with the total session count.
The page limit is not a global heap/RSS, latency or directory-size guarantee.

Use PageUp/PageDown at the first/last selectable row to request the previous/next
saved page. Away from those edges, the keys keep their viewport-navigation role.
The view displays the configured bindings and marks repeated ancestor rows as
page context. Search keeps one active query plus its latest replacement.


An invalid ID exits with the closest unambiguous session ID when one is available. To open the picker and send an initial prompt after selecting a session, separate the prompt with `--`: `base-context --resume -- "continue this work"`.

The startup picker has separate controls:

- search by typing
- toggle path display with Ctrl+P
- toggle sort mode with Ctrl+S
- filter to named sessions with Ctrl+N
- rename with Ctrl+R
- delete with Ctrl+D, then confirm


## Naming Sessions

Use `/name <name>` to set a human-readable session name:

```text
/name Refactor auth module
```

Named sessions are easier to find in `/resume` and `base-context --resume`.

## Branching with `/tree`

Sessions are stored as trees. Every entry has an `id` and `parentId`, and the current position is the active leaf. `/tree` lets you jump to any previous point and continue from there without creating a new file.

<p align="center"><img src="images/tree-view.png" alt="Tree View" width="600"></p>

Example shape:

```text
├─ user: "Hello, can you help..."
│  └─ assistant: "Of course! I can..."
│     ├─ user: "Let's try approach A..."
│     │  └─ assistant: "For approach A..."
│     │     └─ user: "That worked..."  ← active
│     └─ user: "Actually, approach B..."
│        └─ assistant: "For approach B..."
```

### Tree Controls

| Key | Action |
|-----|--------|
| ↑/↓ | Navigate visible entries |
| ←/→ | Page up/down |
| Ctrl+←/Ctrl+→ or Alt+←/Alt+→ | Fold/unfold or jump between branch segments |
| Shift+L | Set or clear a label on the selected entry |
| Shift+T | Toggle label timestamps |
| Enter | Select entry |
| Escape/Ctrl+C | Cancel |
| Ctrl+O | Cycle filter mode |

Filter modes are: default, no-tools, user-only, labeled-only, and all. Configure the default with `treeFilterMode` in [Settings](settings.md).

### Selection Behavior

Selecting a user or custom message:

1. Moves the leaf to the selected message's parent.
2. Places the selected message text in the editor.
3. Lets you edit and resubmit, creating a new branch.

Selecting an assistant, tool, compaction, or other non-user entry:

1. Moves the leaf to that entry.
2. Leaves the editor empty.
3. Lets you continue from that point.

Selecting the root user message resets the leaf to an empty conversation and places the original prompt in the editor.

## `/tree`, `/fork`, and `/clone`

| Feature | `/tree` | `/fork` | `/clone` |
|---------|---------|---------|----------|
| Output | Same session file | New session file | New session file |
| View | Full tree | User-message selector | Current active branch |
| Typical use | Explore alternatives in place | Start a new session from an earlier prompt | Duplicate current work before continuing |
| Summary | Optional branch summary | None | None |

Use `/tree` when you want to keep alternatives together. Use `/fork` or `/clone` when you want a separate session file.

## Branch Summaries

When `/tree` switches away from one branch to another, Prime Agent can summarize the abandoned branch and attach that summary at the new position. This preserves important context from the path you left without replaying the whole branch.

When prompted, choose one of:

1. no summary
2. summarize with the default prompt
3. summarize with custom focus instructions

See [Compaction](compaction.md) for branch summarization internals and extension hooks.

## Session Format

Session files are JSONL and contain message entries, model changes, thinking-level changes, labels, compactions, branch summaries, and extension entries.

For parsers, extensions, SDK usage, and the full SessionManager API, see [Session Format](session-format.md).
