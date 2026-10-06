# Opt-in request token budgets

Normal sessions keep Python state, retain output, and carry selected earlier instructions. They do **not** enable request-budget selection by default. This page enables that separate feature from the CLI; no SDK program is needed.

## Configure a new session

Merge the following into `~/.base-context/settings.json` (global) or `.base-context/settings.json` in your project. Do not overwrite unrelated settings. The same JSON is available as [examples/request-token-budget.json](../examples/request-token-budget.json) and is exercised by the offline tests.

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

Authenticate to OpenAI with `/login` or your normal `OPENAI_API_KEY` environment setting. Do not put a key in the profile or its URL. Start a **new** session:

```bash
base-context --provider openai --model gpt-4.1
```

The example uses the catalogued GPT-4.1 context and output limits. Confirm the limits for your deployment before changing the model, endpoint, or provider. Profiles are explicit configuration, not automatically inferred from a model name.

Project settings override global settings; a project `profiles` array replaces the global array. Settings are captured when a session is created. Existing sessions do not acquire a new budget through `/reload`. SDK `requestTokenBudget` options take precedence over settings, and child sessions inherit the effective configuration.

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

`responseModels` is optional. It lists accepted exact response-model identities when the provider returns a different versioned name. Without it, only the configured request model is accepted for calibration and retained-state credit.

## Supported scope and limits

- Profiles support `openai-responses`, `openai-codex-responses`, and `openai-completions` measurement. Request selection is narrower: supported Responses/Codex text-and-tool layouts and the built-in DeepSeek Flash completions route. A compatible-looking endpoint is not enough to establish selection support.
- `enforce` can refuse media, opaque replay, unknown models/routes, or a required context set that cannot fit. It does not silently remove user instructions, required tool groups, or output reservations.
- The same budget applies to captured auxiliary requests, including summaries. Supply profiles for other models you explicitly configure for those operations. A model switch does not create a profile.
- Estimates and margins are not a guarantee of provider acceptance or lower cost. On the supported OpenAI Responses route, a request near its limit can use the provider's input-count endpoint before admission; that is an additional provider request.
- Ordinary compaction remains a separate mechanism. A smaller compaction target is not a substitute for an enforced serialized-request budget.

Remove `requestTokenBudget` and start a new session to return to the default. Do not use an empty profile list as a disable switch in `enforce` mode: it rejects unknown requests. Saved budgeted epochs still need their matching configuration when restored.

See [context management](context-management.md#model-aware-budgets) and [SDK options](sdk.md#explicit-request-token-budget-profiles) for programmatic use. The published Base 1.1.1 benchmark did not enable this feature and is not evidence of its savings.
