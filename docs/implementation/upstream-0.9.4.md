# Upstream changes since Prime Agent 0.9.3

Status as of 2026-09-11. The fork starts at
`915c78f42c248b08238dd27fcd4bcab32c60beab`. The latest public release at inspection
is [v0.9.4](https://github.com/PrimeIntellect-ai/prime-agent/releases/tag/v0.9.4),
`f771dfcedd684d1afff84ca2c6fa95c7a21efbc2`. Public main is
`fb2db8ee1b61c69d53a84404e617bc74d6f205c9`. Of the 32 post-fork commits, 10 are
in v0.9.4 and 22 are later main. The new experiment baseline is the latest public
release selected at preparation, not a moving main branch.

## Decisions

- **Incorporated:** `24519c30856965a832551206b3e9ed87e814d602` fixes literal prompt
  argument substitution. Use its single-pass callback in the existing pure helper.
  Keep positional and slice semantics. Two existing tests cover normal substitution
  and literal dollar sequences. Sol's custom prompt is not changed.
- **Incorporated:** MCPv2 `input_schema` at `McpIntegration._ensure_tools`, retaining
  the existing `inputSchema` wire shape and session/tool ownership. Two existing
  fake-session cases cover schema preservation and unknown-tool handling.
- **Next small ports:** unsigned WebP/TIFF lengths; oversized-tail rescue with a final newline;
  BOM frontmatter; precise LiteLLM overflow recognition; well-formed terminal marker
  text. These are separate candidates, not claims of completed implementation.
- **Adapt, do not copy:** static system prefixes may reduce cache churn, but must
  use native canonical context, TaskFrame and epoch ownership. Roster and saved-row
  changes must use the bounded index/page owners. Kernel memo and output-spill fixes
  need their real lifecycle/error owners checked first.
- **Keep Base Context's implementation:** original source captures and ACK order,
  physical request receipts, whole replay dependencies, selected-Skill authority,
  typed checkpoint continuation, and paired owned installation.
- **Skip:** breaking `rlm.spawn` replacement, bracket-text authority, whole persistence
  or retry rewrites, unrelated upstream CI/ticket rules, and the catalog build change
  already present here. Do not silently drop unresolved tool results.
- **Out of scope now:** Anthropic pricing and Bedrock packaging. Cost work is OpenAI
  and DeepSeek only. No dedicated DeepSeek fix occurs in these upstream changes;
  the existing reasoning-content roundtrip and cache-hit usage handling are retained.

## How to adapt the remaining small fixes

| Fix | Existing Base Context owner | Narrow check |
|---|---|---|
| MCPv2 schema | `prime-agent-runtime/src/rlm/mcp_base.py::McpIntegration._ensure_tools`; keep downstream `inputSchema` | Existing fake-session auto-bound tool case |
| WebP/TIFF lengths | `packages/coding-agent/src/utils/exif-orientation.ts`; unsigned reads only | Existing image-processing case plus a small malformed chunk |
| Oversized final line | `packages/coding-agent/src/core/tools/truncate.ts::truncateTail`; keep full-output storage and limits | Existing Bash output/truncation case |
| BOM frontmatter | `packages/coding-agent/src/utils/frontmatter.ts`; no wider text normalization | Existing ordinary/BOM parser cases |
| LiteLLM overflow | `packages/ai/src/utils/overflow.ts`; no capacity or retry-policy change | Existing positive and non-overflow assertions |
| Lone-surrogate marker | `packages/tui/src/selection-metadata.ts`; marker payload only | Existing table-cell selection case |

## Commit dispositions

A candidate is not an implemented or tested port. The older leading tables in
`SPEC_DEVIATIONS.md` describe W26; later changes and current source owners take precedence.

| Commit | Release phase | Disposition | Benefit / actual adaptation boundary |
|---|---|---|---|
| `fb2db8ee1b6` | later main | DEFER | Whole-subtree running/idle counts. Adapt only to owned live topology; bounded saved pages cannot prove whole-tree totals. |
| `65674748530` | later main | DEFER | Short model labels are display-only. Keep full provider/model identities in request contracts and indexed saved metadata. |
| `1eee2938b4e` | later main | SKIP | Upstream stacked-PR benchmark CI. Do not import its experiment launcher or populations. |
| `55c611fbf63` | later main | DEFER | /traces completion is convenience UI. No new tracing store or mandatory review workflow. |
| `27daf22125a` | later main | DEFER | Autonomous budget flags touch policy/accounting. Do not widen W72 or native admission through a CLI port. |
| `4f4d51c5b5e` | later main | SKIP wholesale | Roster consolidation must not replace native family access and bounded indexed catalog/page owners. |
| `5a843023781` | later main | SKIP wholesale | Synthetic bracket grammar rewrites message/prompt contracts. It cannot replace native qualification, source identity or stable replay. |
| `ea7dbd1f103` | later main | SKIP breaking change | Explicit rlm.spawn replaces an inherited call interface. Keep existing rlm/pi contracts; an additive alias would need separate scope. |
| `81cd5390dbc` | later main | DEFER/partial redundant | Our W45 already captures explicit learning model/effort. Do not import inherited-low effort or approximate auxiliary output-reservation policy; side-question reasoning needs its own captured owner. |
| `e8b7168cc99` | later main | DEFER | Real packaged Bedrock lazy-loader fix, but outside current OpenAI/DeepSeek focus. Later adapt shim/entrypoint/interop to owned AI exports and existing bundle; omit Linear-ticket/CI validation churn. |
| `163dd5798cd` | later main | DEFER | Inactive recorded-model display is useful; feed it from existing indexed metadata/pages, not a full transcript scan or serving-model guess. |
| `d4bc773d853` | later main | SKIP | Upstream benchmark comment presentation, not runtime or current experiment scope. |
| `f9c7e06b58b` | later main | SKIP | PR-triggered benchmark workflow is not the authorized isolated balanced experiment. |
| `427ea4c72cc` | later main | SKIP | Count adjustment depends on the unported harness-digest architecture; do not transplant its assertion denominator. |
| `bcdcd6e65e1` | later main | SKIP direct port | Manual-compaction goal resume uses active-state/queued-message heuristics. W74/W75 native finalized outcomes, captured owners, action tickets and ACK continuation rules remain authoritative. |
| `55ade48b73f` | later main | INCORPORATE candidate | LiteLLM maximum-context error pattern at AI/utils/overflow.ts. Change classification only; keep native attempt/capacity/retry authority. |
| `a6625e17a04` | later main | DEFER native adaptation | Drop unmatched tool results in generic provider projection. Native unresolved-tool replay/whole ViewUnits must not be silently discarded; preserve raw source and unknown effects. |
| `24519c30856` | later main | INCORPORATED | Literal-safe single-pass `substituteArgs`; preserve argument text and existing selection syntax. |
| `31ebd50c791` | later main | DEFER | OpenCode conversation/application headers are provider-specific. Do not restore Prime identity or infer native ownership from headers. |
| `71766abb2c1` | later main | DEFER high-value adaptation | Static system prefix/dynamic harness state can reduce cache churn. Adapt through canonical-context/task-frame/epoch owners; do not inject unqualified digest messages or overwrite Sol/system prompts. |
| `e6b79144c23` | later main | SKIP | Upstream contribution-ticket policy, not a Base Context runtime fix. |
| `363eb619206` | later main | DEFER | Agents-view visual polish; lower priority than actual bugs and spend tracking. |
| `f771dfcedd6` | v0.9.4 | REFERENCE ONLY | Latest public v0.9.4 release baseline; do not copy Prime versions or treat it as later main. |
| `4ec05a09698` | v0.9.4 | DEFER | Prime Inference default GLM selection is not our requested model choice or availability evidence. |
| `0c6873255a3` | v0.9.4 | DEFER native adaptation | Inactive-row visibility must use bounded native pages and closure; do not restore the upstream full saved-session list. |
| `0894de1ded3` | v0.9.4 | SKIP already present | Base Context AI build already uses committed catalog: package.json:68 is tsgo only. No refetch during build. |
| `bf8894afa55` | v0.9.4 | INCORPORATE candidate | Resolve displayed Markdown file links against captured session/component cwd, not process cwd. Thread through existing renderer only; preserve owned paths and source identity. |
| `9c8230df67b` | v0.9.4 | DEFER scoped startup check | Headless theme initialization belongs to actual native worker startup and owned settings. daemon-mode lacks initTheme, but check caller startup before claiming the native path is missing it. |
| `b9cf467edf8` | v0.9.4 | DEFER decomposed | Navigation, model discovery, background-command changes span owners. Keep captured connections and bounded catalogs; no automatic Prime discovery/auth/state rewrite. Select a proven local bug, not the feature bundle. |
| `2ce443175b5` | v0.9.4 | DEFER platform-specific | Windows process/pipe/path/Python fixes need owned bootstrap/lifecycle adaptation. No Windows or installed-platform acceptance is claimed. |
| `8a1e9580088` | v0.9.4 | DEFER decomposed | Structured failures and visible retries are useful, but our coordinator already owns physical attempts/receipts. Do not replace it with uninstrumented session retries, recapture sources, or weaken read-only subscription auth. Port only a concrete remaining error/abort bug. |
| `844e85545af` | v0.9.4 | SELECT LEAF FIXES; SKIP bulk | Select the WebP unsigned-length, literal tail, BOM and MCPv2 schema fixes separately. Native framed/indexed journal, read-only import/export, ACK and bounded catalog owners supersede bulk persistence/scan rewrites. Do not import tail repair/truncation, an atomic-write framework or derived rollups as physical accounting. Anthropic pricing out of scope; Copilot service_tier omission is not OpenAI subscription pricing. |


## Experiment boundary

Sol and Astra use the existing ChatGPT subscription, with API-equivalent cost
estimates. DeepSeek uses its API and API pricing. Unknown quantities and charges
remain unknown. The new comparison uses the same 30 tasks, six total workers across
both harnesses, preferably two Sol, two Astra and two DeepSeek on the same two-task
window. Spend tracking, selected ports and DeepSeek integration precede execution.
This source review does not establish benchmark results, installation or publication.
