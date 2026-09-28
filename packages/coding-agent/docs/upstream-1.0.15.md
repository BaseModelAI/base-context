# Prime Agent selection for Base Context 1.0.15

This is a selective adaptation, not an upstream merge.

Base Context forked Prime Agent 0.9.3 at
`915c78f42c248b08238dd27fcd4bcab32c60beab`. This review screened all 222
subsequent commits through `2d24ad4e6b2d1ee8e6919af6f108e980a14d550e`
(2026-09-27): 10 through 0.9.4, the 113 commits covered by the prior
[0.9.5 selection](upstream-0.9.5.md), and 99 after 0.9.5. Relevant runtime,
compaction, goal, and workflow changes received focused source comparison;
this is not a full audit of every changed function.

The latest stable release in this review was Prime Agent 0.9.6,
`e260085dd8f742e0def3d871860c9a888b114851`, published 2026-09-24. Six later
main commits were also screened. A commit can be absent from fork ancestry
while its selected behavior is already implemented locally.

## Selected small fixes

| Exact upstream commit | Adaptation |
|---|---|
| `a0660bb5f823bcd9490a83ca3e822d7d53f36e24` | Clear a failed direct daemon-worker connection's socket and channel references, so the same client can retry after a connection error or timeout. Keep Base Context's native-owner, compatibility, and probe-timeout handling. Do not refactor the already-correct daemon-client connection path merely to share a helper. |
| `b6b94c78a7747997e0ec6c690c0e8f2a563dbe14` | Add the missing kernel stderr stream error listener, matching the existing stdin/stdout listeners. Record the diagnostic without taking cleanup ownership from pending writes and child exit. |

These changes add no provider, model, daemon command, wire shape, or protocol
version. Focused coverage belongs in the existing `daemon-client.test.ts` and
`repl-kernel-pipe-errors.test.ts` files. Test outcomes belong to the change's
validation record, not to this upstream-selection rationale.

## Relevant decisions

Upstream commits can be viewed at
`https://github.com/PrimeIntellect-ai/prime-agent/commit/<commit>`.

| Exact upstream commit | Decision | Reason |
|---|---|---|
| `90ca4a457e0fef0bd925215d4c973abd6264f067` | Already adapted | Kernel stdin/stdout pipe errors are already handled. Keep that behavior; only stderr was missing. |
| `55ade48b73f636d992855b7cab797d71dc1f6f1c` | Already adapted | LiteLLM overflow recognition and rate-limit exclusions already match upstream. A local history-source limit is not a provider context overflow. |
| `8eaa00c37385c6b25fed9d46584b50ffc2e87f9c` | Already adapted | Blocked input-pump idle waits already yield, with additional native settlement/admission guards. |
| `b3e04b58b358ae9adc02387e6d01937ef9f8064f` | Defer native adaptation | Restoring non-durable next-turn prefixes from every cancelled turn is relevant, but must preserve the native action/source owner. Not part of the two isolated runtime patches. |
| `c4afa57352e71a8532f04ef04a09ce14720ddeca` | Defer | Deriving displayed activity from actual session activity rather than summary freshness is useful, but is a separate UI/state change. |
| `bcdcd6e65e10959c9904ec4467747528303493b0` | Defer native adaptation | Manual-compaction goal resume must use Base Context's captured-owner continuation lifecycle, not upstream queue scheduling. |
| `215e7a7409b2931b49d3aad62d29fa8e94345973` | Defer native adaptation | Same-goal accounting should remain monotonic across summary moves, without applying maxima across unrelated goals or deliberate branch navigation. The upstream reload helper has been replaced locally. |
| `9bd6a9bc0fbc1e4072cfd7162f855a305c39efb0` | Defer native adaptation | Refresh queued goal accounting at a native admission/capture boundary; do not copy upstream in-place mutation of accepted message content. |
| `2e43ebca3753c82ed0ef2064cb14081588ebd4d3`, `b08f08efad6830856318e994447162ba3fd4c6ee` | Reject as-is | Blanket continuation pauses while children or background shells run prevent independent work. A running resource does not establish a dependency. |
| `5fb3d9acbafa06ae9228c49a4b8a4eca9abc0997` | Defer summary adaptation | Tool name, error status, and matching call indices improve summary input, but change prompt representation and need to fit native context budgets. |
| `27f32ddb7e99803555c4654c9ce38edad3e90e22` | Defer summary adaptation | Strip repeated mechanical file lists if adopted. Kept-tail recency must not promote assistant statements over user constraints or TaskFrame authority. Silent list caps are not acceptable substitutes for visible limits. |
| `6be5d4f297f112df8b57b6807de9405c5444fc0f`, `f31c440c788499a4ba49736acbf1504a25e3ad4c` | Retain prior deferral | Head/tail excerpts and kernel-reported file paths change summary selection. Retain recoverable original evidence; do not silently cap file lists or promote tool observations to task authority. |
| `4f6df9d14385368a148c22e65dfc6050fbb984f1` | Reject routing policy | Automatic auxiliary-model fallback and suppressed reasoning would override explicit compaction model/effort selection. Native request budgeting remains authoritative. |
| `c91e6e991fc006098ea21c3640eed3bdd268c222`, `0e3c900225f8beea4ecd57180902d437cd394117`, `2d24ad4e6b2d1ee8e6919af6f108e980a14d550e` | Defer larger runtime change | Bounded frames/payloads and linear protocol reading are a coherent later adaptation, not part of the stderr listener fix. They do not fix full-parent history hydration. |
| `8ee46be35b6fcc4ab28aa6d524aeed1fff69ffe4` | Defer larger runtime change | Restored functions need live namespace globals, but the revival change must preserve native staged restore and interrupt behavior. No dill/restore rewrite is included here. |
| `561401b273b5affa3877aae51e3b44ce201cc2d5` | Defer | Bound attached cell-source metadata separately from complete execution/canonical source. The upstream cap is characters plus a marker, not a byte limit. |
| `d73349d508075cb4d6c3d9d6eec677f029e294c8` | Defer legacy-only adaptation | The retained opt-in owned-worker frontend differs from normal daemon startup. Its cleanup may throw on corrupt tracking; copying upstream's error callback would bypass native cleanup reporting. |
| `ecd60e3cd4313643dede3cb2fcf13b4e2e9a2a75`, `66df06fc12d721c919d61c5ce4d6fb3ef0da479f` | Defer together | Consumed shell-notice withdrawal and its ordering fix form one optional workflow change. Preserve native action/source semantics. |
| `e2fb7bfa1372552d81c33e9b3261d6a9cf82d30f` | Defer product decision | Interrupt-and-send-queued changes user controls and adds a capability-gated command. It requires explicit selection and compatibility coverage, not a protocol-version transplant. |

## Native context and command boundaries

Upstream does not implement Base Context's framed source/indexed working-view
architecture. Full-transcript branch caches and JSONL parse optimizations are
not repairs for a native source-byte refusal. Compaction must select required
source-backed views before hydrating unrelated old payloads. Captured owners,
replay groups, accepted epochs, recovery authorization, and acknowledged writes
must remain intact. A `baseContextEpoch` record is not necessarily a model-written
summary.

The `/goal` text parser is unchanged from upstream at the reviewed revisions.
Single-line objectives are supported; session slash commands reject multiline
input, and the command name must start at column zero. Changing that grammar is
a local product decision, not an upstream bug-fix transplant. Historical goal
regressions added by the commits above were removed in upstream
`cf07c5a3f5eca98e7744f2df83050044c920252a`; they are useful test vectors, not
claims about current upstream test coverage.

## What stays out

All PrimeRL/Prime product provider, subscription, model, account, team, and
catalog integrations remain excluded. No implicit backup models, credential
migration, compiled installer migration, `rlm.spawn`/`collect` API replacement,
new ledger/audit system, or benchmark pipeline is introduced. Base Context keeps
explicit provider/auth/model/effort selection, its package and state roots,
callable `await rlm(...)`, native context authority, and independent-work policy.
Lawful upstream copyright and MIT attribution remain intact.
