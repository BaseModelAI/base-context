# Settings

Base Context uses JSON settings files with project settings overriding global settings.

| Location | Scope |
|----------|-------|
| `~/.base-context/settings.json` | Global (all projects) |
| `.base-context/settings.json` | Project (current directory) |

Edit directly or use `/settings` for common options. `BASE_CONTEXT_HOME` overrides the global state directory; it must be an absolute path.

## All Settings

### Model & Thinking

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `defaultProvider` | string | - | Default provider (e.g., `"anthropic"`, `"openai"`) |
| `defaultModel` | string | - | Default model ID |
| `defaultThinkingLevel` | string | `"xhigh"` | `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"` |
| `hideThinkingBlock` | boolean | `false` | Hide thinking blocks in output |
| `thinkingBudgets` | object | - | Custom token budgets per thinking level |

#### thinkingBudgets

```json
{
  "thinkingBudgets": {
    "minimal": 1024,
    "low": 4096,
    "medium": 10240,
    "high": 32768
  }
}
```

### UI & Display

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `theme` | string | `"dark"` | Theme name (`"dark"`, `"light"`, or custom) |
| `quietStartup` | boolean | `false` | Hide startup header |
| `collapseChangelog` | boolean | `false` | Show condensed changelog after updates |
| `treeFilterMode` | string | `"user-only"` | Default filter for `/tree`: `"default"`, `"no-tools"`, `"user-only"`, `"labeled-only"`, `"all"` |
| `editorPaddingX` | number | `0` | Horizontal padding for input editor (0-3) |
| `autocompleteMaxVisible` | number | `5` | Max visible items in autocomplete dropdown (3-20) |
| `showHardwareCursor` | boolean | `false` | Show terminal cursor |

### Update Checks

Updates use the owned npm package `@ponythewhite/base-context` by default. To use a private download destination, explicitly set `BASE_CONTEXT_DOWNLOAD_BASE_URL`. Stable builds then fetch `latest.json`; beta builds fetch `beta.json`. No inherited upstream download destination is used.

Set `BASE_CONTEXT_SKIP_VERSION_CHECK=1` to disable the Base Context version update check. Use `--offline` or `BASE_CONTEXT_OFFLINE=1` to disable startup network operations, including update checks and package update checks.

The stable `latest.json` and beta `beta.json` manifests use the same JSON shape:

```json
{
  "version": "0.1.0",
  "package": "@ponythewhite/base-context",
  "tarball": "releases/v0.1.0/base-context-0.1.0.tgz"
}
```

Private download manifests require `version` and `package` (or `packageName`) set to the active package name. Version-only manifests and manifests naming another product are refused. `tarball` is optional; when present, Base Context installs that tarball instead of the package name. Relative tarball paths resolve against `BASE_CONTEXT_DOWNLOAD_BASE_URL`. The default owned npm registry lookup is unchanged.

### Pseudonymous usage analytics

Analytics are off by default. Remote analytics require explicit opt-in, `BASE_CONTEXT_TELEMETRY_ENDPOINT`, and a dedicated `BASE_CONTEXT_TELEMETRY_API_KEY`. There is no inherited endpoint or inference-key fallback. When enabled, events include aggregate usage and performance data such as execution mode, token usage, tool counts, retries, and compactions.

Base Context does not send prompts, responses, thinking, tool arguments or results, command text, filenames, paths, repository information, environment variables, credentials, raw error messages, hostnames, usernames, emails, or hardware identifiers. A random installation ID is stored as `telemetry.json` in the configured agent directory (normally `~/.base-context/`).

Telemetry can be disabled globally or for an individual project. Project settings can only further restrict telemetry: they cannot re-enable a global opt-out or suppress the global one-time disclosure.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `telemetry.enabled` | boolean | `false` | Opt in to aggregate events at an explicitly configured destination |

Disable analytics with any of:

```json
{
  "telemetry": {
    "enabled": false
  }
}
```

```bash
BASE_CONTEXT_TELEMETRY=0 base-context
DO_NOT_TRACK=1 base-context
base-context --offline
```

Opt-in alone does not send events without both the explicit endpoint and dedicated key.

### Warnings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `warnings.anthropicExtraUsage` | boolean | `true` | Show a warning when Anthropic subscription auth may use paid extra usage |

```json
{
  "warnings": {
    "anthropicExtraUsage": false
  }
}
```

### Compaction

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `compaction.enabled` | boolean | `true` | Enable auto-compaction |
| `compaction.reserveTokens` | number | `16384` | Tokens reserved for LLM response |
| `compaction.keepRecentTokens` | number | `20000` | Recent tokens to keep (not summarized) |
| `compaction.model` | object | Current main model and effort | Explicit summary model: `provider`, `modelId`, and `thinkingLevel` are all required |

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  }
}
```


Set `compaction.model` to choose the model and effort for manual, automatic and
model-requested compaction summaries. For example, when this exact model/route is
configured and budgeted:

```json
{
  "compaction": {
    "model": {
      "provider": "openai-codex",
      "modelId": "gpt-6-astra",
      "thinkingLevel": "medium"
    }
  }
}
```

The main session model and effort do not change. The summary operation captures
its choice before authentication and history reads. An invalid or unsupported
explicit choice fails instead of silently using the main model. If the setting is
absent, the existing main-model/current-effort behavior remains. `autoRefine.model`
is a separate setting for learning; it does not select the compaction model.

Under enforced request budgets, explicit profiles must cover the actual auxiliary
route/model within the existing supported API set. This setting does not create a
profile, widen support or bypass limits. Extension-provided summaries and generic
standalone calls retain their own behavior. Selecting a model does not schedule
extra calls or enable context optimization when it is off.

### Canonical Context Resources

Persistent sessions reconstruct inference context from the captured canonical source.
These settings bound that reconstruction; they do not select a last-N transcript.
Edit the JSON settings directly to change them.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `canonicalContext.maxMessages` | integer | `16384` | Maximum active canonical message count, including a compaction summary; transient outcomes must also fit the final count |
| `canonicalContext.maxSourceBytes` | integer | `67108864` | Maximum canonical frame bytes used for reconstruction; related updates count on each application |

Both values must be positive safe integers. Invalid values, incomplete indexed
coverage, or exhausted limits fail locally instead of silently dropping context or
falling back to live message arrays. Source bytes are not model tokens or an estimate
of total process memory. Model context limits and compaction settings remain separate.
Explicit in-memory SDK sessions retain their nonpersistent context path.

```json
{
  "canonicalContext": {
    "maxMessages": 16384,
    "maxSourceBytes": 67108864
  }
}
```

### Native invocation output

Owned persistent sessions return complete finalized invocation values or refuse the run.
These limits are separate from `canonicalContext`, model tokens and process memory.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `invocationOutput.maxMessages` | integer | `16384` | Maximum messages in one complete invocation result |
| `invocationOutput.maxSourceBytes` | integer | `67108864` | UTF-8 JSON bytes of that result array, including brackets and separators |

Values must be positive safe integers. Settings are captured when the session is created;
the SDK `invocationOutputLimits` option can override them. A limit refuses completion,
not a silent tail or empty result. Already accepted effects still settle. Explicit resident
sessions and generic Agents keep their existing behavior. Observer queues, provider
partials and caller-retained allocations are not bounded by these settings.

### Branch Summary

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `branchSummary.reserveTokens` | number | `16384` | Tokens reserved for branch summarization |
| `branchSummary.skipPrompt` | boolean | `false` | Skip "Summarize branch?" prompt on `/tree` navigation (defaults to no summary) |
| `branchSummary.model` | object | Main model; effort omitted | Explicit branch-summary model: `provider`, `modelId`, and `thinkingLevel` are all required |

`branchSummary.model` selects the model and effort for a built-in summary when
navigating the session tree. It uses the same required fields as `compaction.model`,
but the two settings are independent. The main session model and effort do not
change. Invalid or unsupported explicit choices fail rather than falling back.

Without this setting, branch summaries keep the main model and omit request effort,
as before. They do not inherit the main session's thinking level. Omission does not
prove that the provider performs no reasoning. Extension-provided summaries and
navigation without a summary retain their existing behavior. This setting does not
schedule extra summaries or change the branch-summary prompt/skip policy.

Enforced request budgets still need explicit coverage for the actual auxiliary
route/model in the existing supported API set. The setting does not create a budget
profile, enable a new provider capability or establish deployment availability.


### Retry

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `retry.enabled` | boolean | `true` | Enable automatic agent-level retry on transient errors |
| `retry.maxRetries` | number | `3` | Maximum agent-level retry attempts |
| `retry.baseDelayMs` | number | `2000` | Base delay for agent-level exponential backoff (2s, 4s, 8s) |
| `retry.provider.timeoutMs` | number | SDK default | Provider/SDK request timeout in milliseconds |
| `retry.provider.maxRetries` | number | SDK default | Provider/SDK retry attempts |
| `retry.provider.maxRetryDelayMs` | number | `60000` | Max server-requested delay before failing (60s) |

When a provider requests a retry delay longer than `retry.provider.maxRetryDelayMs` (e.g., Google's "quota will reset after 5h"), the request fails immediately with an informative error instead of waiting silently. Set to `0` to disable the cap.

```json
{
  "retry": {
    "enabled": true,
    "maxRetries": 3,
    "baseDelayMs": 2000,
    "provider": {
      "timeoutMs": 3600000,
      "maxRetries": 0,
      "maxRetryDelayMs": 60000
    }
  }
}
```

### Message Delivery

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `steeringMode` | string | `"one-at-a-time"` | How steering messages are sent: `"all"` or `"one-at-a-time"` |
| `followUpMode` | string | `"one-at-a-time"` | How follow-up messages are sent: `"all"` or `"one-at-a-time"` |
| `transport` | string | `"auto"` | Preferred transport for providers that support multiple transports: `"sse"`, `"websocket"`, or `"auto"` |

### Terminal & Images

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `terminal.showImages` | boolean | `true` | Show image type and dimensions in terminal |
| `terminal.clearOnShrink` | boolean | `false` | Clear empty rows when content shrinks (can cause flicker) |
| `images.autoResize` | boolean | `true` | Resize images to 2000x2000 max |
| `images.blockImages` | boolean | `false` | Block all images from being sent to LLM |

### Shell

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `shellPath` | string | - | Custom shell path (e.g., for Cygwin on Windows) |
| `shellCommandPrefix` | string | - | Prefix for every bash command (e.g., `"shopt -s expand_aliases"`) |
| `npmCommand` | string[] | - | Command argv used for npm package lookup/install operations (e.g., `["mise", "exec", "node@20", "--", "npm"]`) |

```json
{
  "npmCommand": ["mise", "exec", "node@20", "--", "npm"]
}
```

`npmCommand` is used for all npm package-manager operations, including installs, uninstalls, and dependency installs inside git packages. Use argv-style entries exactly as the process should be launched. When `npmCommand` is configured, git package dependency installs use plain `install` to avoid npm-specific flags in wrappers or alternate package managers.

Normally the package manager's global modules location is queried using `root -g`. As a special case, if the first element of `npmCommand` is `"bun"`, the modules location will instead be queried with `pm bin -g`.

### Daemon

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `idleEvictionMinutes` | number or `"off"` | `90` | Idle threshold in minutes for whole-tree worker eviction and individual idle-child passivation; `"off"` disables both. |

`idleEvictionMinutes` is a global daemon policy and is read only from `~/.base-context/settings.json`. Set it to a positive number to configure the idle threshold.

### Sessions

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sessionDir` | string | - | Directory where session files are stored. Accepts absolute or relative paths, plus `~`. |

```json
{ "sessionDir": ".base-context/sessions" }
```

When multiple sources specify a session directory, precedence is `--session-dir`, `BASE_CONTEXT_SESSION_DIR`, then `sessionDir` in `settings.json`. Environment path overrides must be absolute (`~/` is supported). Writable upstream `.prime`, `.pi`, and `.prime-context` state paths are refused.

### Model Cycling

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `enabledModels` | string[] | - | Model patterns for Ctrl+P cycling (same format as `--models` CLI flag) |

```json
{
  "enabledModels": ["claude-*", "gpt-4o", "gemini-2*"]
}
```

### Markdown

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `markdown.codeBlockIndent` | string | `"  "` | Indentation for code blocks |

### Resources

These settings define where to load extensions, skills, prompts, and themes from.

Paths in `~/.base-context/settings.json` resolve relative to `~/.base-context`. Paths in `.base-context/settings.json` resolve relative to `.base-context`. Absolute paths and `~` are supported.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `packages` | array | `[]` | npm/git packages to load resources from |
| `extensions` | string[] | `[]` | Local extension file paths or directories |
| `skills` | string[] | `[]` | Local skill file paths or directories |
| `prompts` | string[] | `[]` | Local prompt template paths or directories |
| `themes` | string[] | `[]` | Local theme file paths or directories |
| `enableSkillCommands` | boolean | `true` | Register skills as `/skill:name` commands |
| `enableBuiltinSkills` | boolean | `true` | Load built-in skills shipped with base-context |
| `bundledSkills.websearch` | boolean | `true` | Load the built-in `websearch` skill |

Arrays support glob patterns and exclusions. Use `!pattern` to exclude. Use `+path` to force-include an exact path and `-path` to force-exclude an exact path.

Disable the built-in `websearch` skill while keeping normal skill discovery enabled:

```json
{
  "bundledSkills": {
    "websearch": false
  }
}
```

#### packages

String form loads all resources from a package:

```json
{
  "packages": ["pi-skills", "@org/my-extension"]
}
```

Object form filters which resources to load:

```json
{
  "packages": [
    {
      "source": "pi-skills",
      "skills": ["brave-search", "transcribe"],
      "extensions": []
    }
  ]
}
```

See [packages.md](packages.md) for package management details.

## Example

```json
{
  "defaultProvider": "anthropic",
  "defaultModel": "claude-sonnet-4-20250514",
  "defaultThinkingLevel": "xhigh",
  "theme": "dark",
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  },
  "retry": {
    "enabled": true,
    "maxRetries": 3
  },
  "enabledModels": ["claude-*", "gpt-4o"],
  "warnings": {
    "anthropicExtraUsage": true
  },
  "packages": ["pi-skills"]
}
```

## Project Overrides

Project settings (`.base-context/settings.json`) override global settings. Nested objects are merged:

```json
// ~/.base-context/settings.json (global)
{
  "theme": "dark",
  "compaction": { "enabled": true, "reserveTokens": 16384 }
}

// .base-context/settings.json (project)
{
  "compaction": { "reserveTokens": 8192 }
}

// Result
{
  "theme": "dark",
  "compaction": { "enabled": true, "reserveTokens": 8192 }
}
```

Release metadata lookup does not follow redirects. With `BASE_CONTEXT_DOWNLOAD_BASE_URL`,
a resolved advertised tarball must have the same URL origin as that configured base.
A different origin makes the release unavailable; it does not trigger a fallback
package install. Same-origin relative and absolute tarballs remain supported. This
metadata rule does not control redirects performed by npm or artifact downloads.

### Context optimization mode

`context.mode` accepts `"on"` (default) or `"off"` as the creation policy. A saved
session's qualified epoch takes precedence over that default. External SDK control
can call `await session.setContextMode("off")` or `await session.setContextMode("on")`.
The call waits for accepted work and completes after the existing owner commits
and adopts the new policy. It does not change global settings.

Off keeps the retained native/public context, explicit `prime_context` recovery,
logging, receipts, cancellation and request/resource limits. It does not replay
demoted archives. New automatic or manual refinement and compaction require
explicitly re-enabling optimization first. Sol/custom/user/project/harness prompt
text remains unchanged; only generated context overlays are omitted.

The control is session-local. New native children capture the accepted parent mode;
existing independently owned children keep their own policy. A fresh off session
records its first actual native compatibility contract once before sending. This
does not select a new view or authorize missing contracts in legacy history. Off
is not the independent upstream H benchmark control.

### Learning model and effort

An optional `autoRefine.model` object sets `provider`, `modelId` and `thinkingLevel`
together for built-in refinement review and planning. Provider and model ID must
match the configured local registry. Effort must pass that model's existing
configured thinking-level rules; this is not deployment availability certification.
An invalid explicit contract refuses before authentication or a request, rather
than falling back to the main model. Selection is captured before history/auth waits.

Without this object, learning keeps the main model and omits effort from the
request, as in the legacy helpers. Main-session thinking level is not implicitly
forwarded. An explicit contract forwards its configured level, including `off`
where supported, through the existing provider options. Omission does not prove
that the provider performs no reasoning.

The main model/effort state is unchanged. The existing session request budget also
applies to the chosen learning model; this setting does not create an independent
learning spend budget or configure bridge/semantic calls. `context.mode=off` still
blocks new learning. Sol/custom/behavioral prompt text remains unchanged.
