# Opt-in request token budgets

Normal sessions keep Python state, retain output, and carry selected earlier instructions. They do **not** enable request-budget selection by default. This page enables that separate feature from the CLI; no SDK program is needed.

This is a limit on each model request, not a total spending cap for the session. It accounts for the serialized input, reserved output, and configured margin. It is separate from [goal token budgets](long-running-agents.md#persistent-goals) and the threshold that triggers compaction.

## Configure a new session

Merge the following into `~/.base-context/settings.json` (global) or `.base-context/settings.json` in your project. If you use `BASE_CONTEXT_HOME`, the global file is `settings.json` inside that directory. Create the directory/file if needed, but do not overwrite unrelated settings. The same JSON is available as [examples/request-token-budget.json](../examples/request-token-budget.json).

```json
{
  "defaultProvider": "openai",
  "defaultModel": "gpt-4.1",
  "requestTokenBudget": {
    "mode": "enforce",
    "profiles": [
      {
        "id": "openai-gpt-4.1",
        "revision": "1",
        "api": "openai-responses",
        "provider": "openai",
        "url": "https://api.openai.com/v1/responses",
        "model": "gpt-4.1",
        "authMode": "api-key",
        "templateRevision": "responses-v1",
        "replayFamily": "openai-responses",
        "contextTokens": 1047576,
        "outputCeilingTokens": 32768,
        "estimate": {
          "tokensPerUtf8Byte": 1,
          "tokenizer": "o200k_base",
          "templateTokens": 1024,
          "marginTokens": 4096
        }
      }
    ]
  }
}
```

Authenticate to OpenAI with `/login` or your normal `OPENAI_API_KEY` environment setting. This example uses OpenAI API-key access, not a ChatGPT subscription or the Codex route. Do not put a key in the profile or its URL. From the configured project directory, start a **new** session (not `--continue`, `--resume`, or `attach`):

```bash
base-context --provider openai --model gpt-4.1
```

You can then ask for a short response, such as “Reply with one sentence.” This sends a real provider request and can incur charges. A short request that already fits does not demonstrate context omission.

The example uses the catalogued GPT-4.1 context and output limits. Confirm the limits for your deployment before changing the model, endpoint, or provider. Profiles are explicit configuration, not automatically inferred from a model name.

Project settings override global settings; a project `profiles` array replaces the global array. Settings are captured when a session is created. Existing sessions do not acquire a new budget through `/reload`. SDK `requestTokenBudget` options take precedence over settings, and child sessions inherit the effective configuration.

## Check configuration and diagnose refusals

There is no dedicated CLI budget-status view. `/context` and `/usage` describe the session; they do not by themselves prove that a request used budget-aware selection. SDK callers can inspect `session.requests.getRequestTokenBudgetOptions()`; see the [complete SDK example](sdk.md#explicit-request-token-budget-profiles).

The offline settings test loads the checked-in JSON through the CLI's session services. It checks the selected model and effective budget, admits the matching route to a mocked transport, and refuses an uncovered model before that transport is called. This tests configuration and admission, not live authentication, response identities, or savings.

| Symptom | What to check |
| --- | --- |
| `Invalid requestTokenBudget: ...` | Fix the named settings field. Use JSON numbers for limits and an array for `profiles`. |
| `Request token budget unknown: exact explicit route/model profile unavailable or ambiguous` | Check the selected provider/model, actual API, and full request URL. Exactly one profile must match. Remove duplicate matches; add a confirmed supported profile when changing routes or models. |
| Refusal after a model switch or during a summary/learning request | Cover that operation's actual model and route too. Main-model coverage does not cover a different auxiliary model. |
| Unknown media/replay or required context over the limit | The request cannot be admitted under the current profile/layout. Do not invent larger limits or expect required user text to be dropped. Use a supported layout and confirmed deployment limits. |
| Edited settings have no effect on the current session | Start a new session. `/reload` does not replace the session's captured budget. |

## What the fields mean

| Fields | Values and meaning |
| --- | --- |
| `mode` | `"observe"` records assessments without enforcing a new token cutoff; `"enforce"` enables supported selection and rejects an unknown or over-budget request. Both opt into context-epoch handling. |
| `api`, `provider`, `url`, `model` | Must match the actual serialized request. The URL is the complete endpoint, with no credentials, query, or fragment. Duplicate matching profiles are ambiguous. |
| `id`, `revision` | Nonempty labels for your profile and its configuration version. Increment the revision when you change the deployment assumptions. |
| `authMode` | A nonempty description such as `"api-key"` or `"oauth"`. It documents the deployment; it does not select or verify authentication. |
| `templateRevision`, `replayFamily` | Nonempty labels for the template and replay configuration you tested, such as `"responses-v1"` and `"openai-responses"`. They are not enums, model aliases, or switches that enable replay. |
| `contextTokens`, `outputCeilingTokens` | Positive integer deployment limits. Output and the margin are reserved before input admission. Reasoning output is already part of output accounting. |
| `estimate.tokenizer` | Optional `"o200k_base"` estimate for a deployment that uses that encoding. It is not an exact provider request count. |
| `estimate.tokensPerUtf8Byte` | Finite number at least `1`, used by the conservative byte fallback. This is not bytes divided by four. |
| `estimate.templateTokens`, `estimate.marginTokens` | Non-negative integer allowances for template overhead and estimation uncertainty. |

`outputCeilingTokens` checks the requested output limit; it does not lower that limit for you. Set the model/provider output limit separately if needed. The actual output reservation, margin, and required input must fit inside `contextTokens`.

`responseModels` is optional. It lists exact model identities accepted from provider responses. Without it, only the configured request model is accepted. If your provider returns a versioned name, inspect the actual response identity in provider/SDK diagnostics before adding it; do not guess a snapshot suffix. When you supply the array, it replaces the implicit request-model list, so include the request model too if responses can use that name.

An unlisted response identity prevents ordinary calibration and can prevent Codex retained-prefix credit. It does **not** by itself reject ordinary OpenAI Responses admission. It also does not fix a missing request profile: the profile's `model` must still match the model in the outgoing request.

## Supported scope and limits

- Profiles support `openai-responses`, `openai-codex-responses`, and `openai-completions` measurement. Request selection is narrower: supported Responses/Codex text-and-tool layouts and the built-in DeepSeek Flash completions route. A compatible-looking endpoint is not enough to establish selection support.
- `enforce` can refuse media, opaque replay, unknown models/routes, or a required context set that cannot fit. It does not silently remove user instructions, required tool groups, or output reservations.
- The same budget applies to captured auxiliary requests, including summaries. Supply profiles for other models you explicitly configure for those operations. A model switch does not create a profile.
- Estimates and margins are not a guarantee of provider acceptance or lower cost. On the supported OpenAI Responses route, a request near its limit can use the provider's input-count endpoint before admission; that is an additional provider request.
- Ordinary compaction remains a separate mechanism. A smaller compaction target is not a substitute for an enforced serialized-request budget.

Remove `requestTokenBudget` and start a new session to return to the default. Do not use an empty profile list as a disable switch in `enforce` mode: it rejects unknown requests. Saved budgeted epochs still need their matching configuration when restored.

See [context management](context-management.md#model-aware-budgets) and [SDK options](sdk.md#explicit-request-token-budget-profiles) for programmatic use. The published Base 1.1.1 benchmark did not enable this feature and is not evidence of its savings.
