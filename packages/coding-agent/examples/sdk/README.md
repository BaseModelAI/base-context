# SDK Examples

Programmatic usage of the Base Context SDK via `createAgentSession()` and `createAgentSessionRuntime()`.

Use `@ponythewhite/base-context` for the SDK and `@ponythewhite/base-context-ai` for model helpers. These are the fork's published packages. Base Context inherits its SDK foundation from Prime Agent and Pi.

The runtime example shows how to build a recreate function that closes over process-global fixed inputs and recreates cwd-bound services and sessions as the active session cwd changes.

## Examples

| File | Description |
|------|-------------|
| `01-minimal.ts` | Standard resource discovery; requires a saved provider/model selection |
| `02-custom-model.ts` | Select model and thinking level |
| `03-custom-prompt.ts` | Replace or modify system prompt |
| `04-skills.ts` | Discover, filter, or replace skills |
| `05-tools.ts` | Built-in tools, custom tools |
| `06-extensions.ts` | Logging, blocking, result modification |
| `07-context-files.ts` | AGENTS.md context files |
| `08-prompt-templates.ts` | File-based prompt templates |
| `09-api-keys-and-oauth.ts` | API key resolution, OAuth config |
| `10-settings.ts` | Override compaction, retry, terminal settings |
| `11-sessions.ts` | In-memory, persistent, continue, list sessions |
| `12-full-control.ts` | Replace everything, no discovery |
| `13-session-runtime.ts` | Manage runtime-backed session replacement |

## Running

Build the workspace with `npm ci` and `npm run build:source` from the repository root. Set up your provider credentials and save an explicit model choice in the CLI first (`/login`, then `/model`), or use `02-custom-model.ts` with your chosen provider/model.

```bash
cd packages/coding-agent
npx tsx examples/sdk/01-minimal.ts
```

These examples can call the selected provider and incur charges. They are not offline tests. Saved credentials/settings use `~/.base-context` unless `BASE_CONTEXT_HOME` selects another root. See [SDK setup and authentication](../../docs/sdk.md#installation-and-source-setup).

## Quick Reference

The following snippets show separate configurations; do not combine the repeated `session` declarations into one script. Authenticate to the selected provider before sending a prompt.

```typescript
import { getModel } from "@ponythewhite/base-context-ai";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@ponythewhite/base-context";

// Auth and models setup
const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);

// Explicit model; there is no first-available-provider fallback
const model = getModel("anthropic", "claude-opus-4-5");
const { session } = await createAgentSession({ model, authStorage, modelRegistry });

// Custom thinking level
const { session } = await createAgentSession({ model, thinkingLevel: "high", authStorage, modelRegistry });

// Modify prompt
const loader = new DefaultResourceLoader({
  systemPromptOverride: (base) => `${base}\n\nBe concise.`,
});
await loader.reload();
const { session } = await createAgentSession({ model, resourceLoader: loader, authStorage, modelRegistry });

// Tool selection
const { session } = await createAgentSession({ model, tools: ["ipython", "prime_context"], authStorage, modelRegistry });

// In-memory
const { session } = await createAgentSession({
  model,
  sessionManager: SessionManager.inMemory(),
  authStorage,
  modelRegistry,
});

// Full control (myExtension and myTool are application-defined)
const customAuth = AuthStorage.create("/my/app/auth.json");
customAuth.setRuntimeApiKey("anthropic", process.env.MY_KEY!);
const customRegistry = ModelRegistry.create(customAuth);

const resourceLoader = new DefaultResourceLoader({
  systemPromptOverride: () => "You are helpful.",
  extensionFactories: [myExtension],
  skillsOverride: () => ({ skills: [], diagnostics: [] }),
  agentsFilesOverride: () => ({ agentsFiles: [] }),
  promptsOverride: () => ({ prompts: [], diagnostics: [] }),
});
await resourceLoader.reload();

const { session } = await createAgentSession({
  model,
  authStorage: customAuth,
  modelRegistry: customRegistry,
  resourceLoader,
  tools: ["ipython", myTool.name],
  customTools: [myTool],
  sessionManager: SessionManager.inMemory(),
  settingsManager: SettingsManager.inMemory(),
});

// Run prompts
session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});
await session.prompt("Hello");
```

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `authStorage` | `AuthStorage.create()` | Credential storage |
| `modelRegistry` | `ModelRegistry.create(authStorage)` | Model registry |
| `cwd` | `process.cwd()` | Working directory |
| `agentDir` | `BASE_CONTEXT_HOME` or `~/.base-context` | Global state and config directory |
| `model` | Saved session/settings selection, or unselected | Pass a supported model explicitly; authentication does not select one |
| `thinkingLevel` | Saved selection or `medium`, clamped to the model | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`; support depends on the model |
| `tools` | Omitted: built-ins and registered extension/custom tools enabled | An explicit list is an allowlist; include each custom tool name you want to enable |
| `customTools` | `[]` | Additional tool definitions |
| `resourceLoader` | DefaultResourceLoader | Resource loader for extensions, skills, prompts, themes |
| `sessionManager` | `SessionManager.create(cwd)` | Persistence |
| `settingsManager` | `SettingsManager.create(cwd, agentDir)` | Settings overrides |
| `requestTokenBudget` | Unset | Opt-in budget; see the [complete profile](../../docs/request-token-budgets.md) and [SDK options](../../docs/sdk.md#explicit-request-token-budget-profiles) |

## Events

```typescript
session.subscribe((event) => {
  switch (event.type) {
    case "message_update":
      if (event.assistantMessageEvent.type === "text_delta") {
        process.stdout.write(event.assistantMessageEvent.delta);
      }
      break;
    case "tool_execution_start":
      console.log(`Tool: ${event.toolName}`);
      break;
    case "tool_execution_end":
      console.log(`Result: ${event.result}`);
      break;
    case "agent_end":
      console.log("Done");
      break;
  }
});
```
