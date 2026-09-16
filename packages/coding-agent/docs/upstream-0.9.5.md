# Prime Agent 0.9.5 selection for base-context 1.0.1

Base-context forked Prime Agent 0.9.3 at
`915c78f42c248b08238dd27fcd4bcab32c60beab`. The selection range below is separate
from that fork ancestor. We reviewed all **113 commits** between
upstream `v0.9.4` (`f771dfcedd684d1afff84ca2c6fa95c7a21efbc2`) and
`v0.9.5` (`a7d791bc1be09793ed5f3ec05bf4cccbc60679ea`). This is a selective
adaptation, not a merge of the release's 500-file net change.

The fork keeps explicit provider, authentication and model selection; its native
context, request-budget and source-ownership rules; family-wide `/agents` limits;
and the Node/npm installer with managed Python 3.13. See [fork philosophy](fork-philosophy.md).

## Selected fixes

Thirteen focused groups come from fourteen upstream commits. Some mixed commits
supply only a few generic lines:

- Kernel pipe errors do not crash the worker.
- LiteLLM context-overflow messages are recognized, without mistaking rate limits for overflow.
- The packaged Node CLI has the missing lazy Bedrock entry and keeps native request-attempt accounting.
- Responses streams track interleaved output slots, use final tool arguments, and retain incomplete-response usage.
- Blocked input-pump idle waits yield instead of starving I/O.
- Draft disposal handles teardown failures and respects pending attaches.
- Daemon discovery stays inside the current state root, including owned custom sockets.
- Python child deletion accepts the returned spawn handle; `await rlm(...)` remains the spawn API.
- Required CLI values and invalid mode/thinking selections produce errors.
- Provider projection drops orphan tool results without rewriting canonical history or granting an invalid native projection.
- Anthropic budget-based thinking respects its minimum while keeping the previously computed total token cap. Impossible totals fail before transport.
- Startup navigation observes initialization and connection lifetime without replacing provider-first onboarding.
- A terminal model error gets a factual `needs_input` recap without another model request or a new wire enum.

The separate candidate review also led to an effective-authentication-header
attribution fix: rejecting an overriding credential must not invalidate an unused
stored API key. Provider and RPC documentation follow the retained interfaces.

## What stays out

Prime Inference/account/team/credits integrations, telemetry and sharing do not
return. Neither do implicit default/backup models, the compiled Bun installer,
new `rlm.spawn`/`collect` APIs, broad retry-policy changes, or unrelated UI and
performance redesigns. The native protocol remains 13/schema49. Lawful upstream
copyright and MIT attribution remain intact.

Optional WebSocket retry policy is deferred rather than bypassing native attempt
admission and captured-context accounting. SSE remains the default. The other
explicit deferrals below are not claims that those upstream ideas are useless;
they are outside this release's selected adaptations.

## Complete decision table

“Select subset” does not mean cherry-pick the whole commit. “Already” identifies
local behavior that needed no transplant. “Defer” is outside 1.0.1; “Skip” is
irrelevant or incompatible with the retained product. Upstream commits can be
viewed at `https://github.com/PrimeIntellect-ai/prime-agent/commit/<commit>`.

| # | Full upstream commit | Decision | Reason |
|---:|---|---|---|
| 1 | `363eb61920621c53bd4313deb91360fa3d188e5c` | Defer | Agents-view visual redesign; no correctness dependency. |
| 2 | `e6b79144c23e2d73df41cbba5335a8db65ddffe3` | Skip | Upstream contribution-ticket CI only. |
| 3 | `71766abb2c1e427382871c77d2dc3896164a3456` | Defer | Harness/system-prompt architecture change; do not replace native TaskFrame/epoch/source authority. |
| 4 | `31ebd50c791d6e016b059c9bc35e9ba4d845672d` | Defer | OpenCode session/app headers are attribution/affinity, not a demonstrated failing request; upstream user-agent identity is wrong for fork. |
| 5 | `24519c30856965a832551206b3e9ed87e814d602` | Already | Single-pass substituteArgs is already local; retain current prompt-template tests. |
| 6 | `a6625e17a042716fca4527c9297b972da3eb2142` | Select subset | Reject incomplete/orphan tool exchanges without mutating canonical source or granting invalid native projection. |
| 7 | `55ade48b73f636d992855b7cab797d71dc1f6f1c` | Select | LiteLLM maximum-context recognition; keep native overflow policy and rate-limit exclusion. |
| 8 | `bcdcd6e65e10959c9904ec4467747528303493b0` | Defer | Manual-compaction goal resume is relevant but local captured-owner compaction is substantially rewritten; not a direct transplant. |
| 9 | `427ea4c72cc606ac061a14287c0c15c471eff002` | Skip | Test adjustment for upstream harness-digest architecture. |
| 10 | `f9c7e06b58b9760944abb33b81f758ce5df1a1b3` | Skip | Upstream performance CI/harness, not product fixes; historical benchmark stays immutable. |
| 11 | `d4bc773d85348220b9134a646bcaa03b3bba74d2` | Skip | Upstream PR benchmark comment UI. |
| 12 | `163dd5798cd40e86b540aa9ecb68201920a83a1b` | Defer | Inactive-session model display, optional roster UI. |
| 13 | `e8b7168cc9972694232a9ed9c0a6a51655e44abf` | Select subset | Packaged Node Bedrock entry is missing; drop unrelated Linear-ticket/CI changes. |
| 14 | `81cd5390dbc871afb87be0d2012d205dd633bae3` | Select subset | Keep preexisting computed output cap/default arithmetic. Reject impossible budget before transport; floor thinking within same computed cap. |
| 15 | `ea7dbd1f103ffc9457e3f4a06ed1845ca5aa0a21` | Skip | Breaks retained callable await rlm(...) contract by switching to rlm.spawn. |
| 16 | `5a843023781b461b8cd7c7b45718f133b61e16b0` | Defer | Synthetic-message grammar churn changes prompt semantics and source classification. |
| 17 | `4f4d51c5b5e1d29a95ac0391556898910e1e01c7` | Defer | Roster API consolidation is not required by current family-wide /agents admission. |
| 18 | `27daf22125a188067768244bee04aba3ef74bafb` | Defer | New /autonomous budget-command UX; not necessary for selected correctness fixes. |
| 19 | `55c611fbf6300366c4edf204a79e4f7e8b99f5cf` | Skip | Removed /traces feature. |
| 20 | `1eee2938b4eeb7a4d72e17035adda669a89b63de` | Skip | Upstream stacked-PR benchmark CI. |
| 21 | `656747485307acb5f24e9a75ebac321dfe27acf7` | Defer | Provider-path display polish; preserve exact selector semantics. |
| 22 | `fb2db8ee1b61c69d53a84404e617bc74d6f205c9` | Skip | Subtree UI counts are not family-wide pending/running/idle admission; keep fork /agents implementation. |
| 23 | `ecd60e3cd4313643dede3cb2fcf13b4e2e9a2a75` | Defer | Consumed Bash notice withdrawal changes Python/host event delivery and native action/source state; not needed for selected fixes. |
| 24 | `48d7fca76b1f7a6f6cf7326c9e0392b82a245634` | Defer | Side-question tool declarations change cache/replay behavior; blocked execution must not become native replay permission. |
| 25 | `5255a6b88002d60ff810e27b33d104eb424c5e07` | Defer | /btw cache-effort change depends on side-question redesign; no core runtime dependency. |
| 26 | `b53c2e9d0666d62ac72b94b754fd649f1f9ff366` | Skip | GitHub discussion investigation automation. |
| 27 | `2aab9d466739f4f9c280c8800c40a32977197ce5` | Skip | Benchmark infrastructure for compiled upstream installs. |
| 28 | `fc782b8a431838c4376578664cf9218d4a5710b1` | Defer | Compaction/refinement visual redesign. |
| 29 | `a38ad5d538a06a42d845d52024db0b631b788b9b` | Defer | Inline configuration picker redesign conflicts with qualified provider-first flow. |
| 30 | `126b43c0ce4f51c49cbb3036a3507ece06bfcc8e` | Defer | Prompt-bar UX redesign. |
| 31 | `5c14169759736add628d7fce28eb97b3baa85ce9` | Defer | Agents/chat UI redesign; preserve local /agents controls. |
| 32 | `370c56235dce1f52b89c4e20b25f714b6f4e8dc1` | Defer | Large verbosity/UI/theme redesign, not needed for selected correctness fixes. |
| 33 | `46c60b7500923be9e77022cb85c731241f35e2ac` | Skip | Upstream PR contribution gate. |
| 34 | `ca67580b524800a971f92420d4c665bd83df1dfa` | Select subset | Generic Responses interleaving/final arguments/incomplete parsing only; reject Grok subscription and auth/model expansion. |
| 35 | `a329e744b23fcf7efee2a43661e996a82b5ee5a3` | Skip | Upstream benchmark startup/cleanup harness. |
| 36 | `0badc0f52edf3e6b56981ad8b2ac6178d1fe392d` | Defer | Subagent expand-affordance UI polish. |
| 37 | `dd760d310886d9ae771c3f563b148fa1caf23125` | Skip | Compiled Bun distribution/installer migration; fork uses Node/npm + owned Python3.13 runtime. |
| 38 | `5a3b922a9d1cb8ae416d96de9e99e4b39817b882` | Skip | Migrates npm users to upstream compiled distribution and paths. |
| 39 | `df6c709a06d85805cebb1c2a1001e144754cab9e` | Skip | Prime CLI/profile/Inference config isolation; these integrations are removed locally. |
| 40 | `19f959ba2311abdafc297337fe5846494494daa5` | Skip | Discussion notification state automation. |
| 41 | `011574e4111baa466f30079136853f230a152d33` | Skip | Compiled-install update/rollback architecture; not fork installer. |
| 42 | `c872594b758882ed7f814815f1e002e85033a657` | Skip | Upstream benchmark readiness/reporting harness. |
| 43 | `66658d2cf73153340f23133fbc16eafac31423e8` | Defer | Maintenance identity for OpenCode; native request coordinator already owns identity/capture, inspect through native path if needed. |
| 44 | `a487fa4191357334f669691d06ea694efa1678df` | Defer | Spawn-ledger stat cache is performance-only and touches admission/recovery authority. |
| 45 | `878410b3981f20c6d685faa210ad0e43426cf483` | Defer | Roster rebuild optimization; optional UI performance change. |
| 46 | `9661a1151525d5c967ec43774736eb14a39dc12a` | Defer | Large snapshot/transport/recovery change; not a minimal patch and interacts with protocol13/schema49. |
| 47 | `748ed685911cfeca9d9049aec2c91e1a0114b507` | Defer | Independent startup/list deadline policy overlaps fork-specific global admission and owned recovery; selected changes do not require adopting new scheduling. |
| 48 | `dbd29e948af43fcf2a64992ed31025faa19e7598` | Defer | Optional extension-render fallback changes UI restoration policy and does not change retained canonical history. Not required by selected startup fix. |
| 49 | `64a3d5205d3aebe69538034ef9e96810feda4485` | Defer | New timed orphan-worker shutdown policy; lifecycle/capacity/recovery changes exceed minimal fixes. |
| 50 | `b043f6ef125ff4bcd6664c96aef5f0c3a642a0d1` | Select subset | Normal back-navigation during initialization must not crash or update a disposed UI. Keep provider-first onboarding. |
| 51 | `90ca4a457e0fef0bd925215d4c973abd6264f067` | Select | Missing kernel pipe error listeners can crash worker; tiny isolated fix. |
| 52 | `9150cc28a3e1989b44ce5070910d1c7cfb052340` | Skip | New rlm.collect feature and fan-in protocol; retained workflow is admission + messages/files. |
| 53 | `766ddce2ce03b61636e8c10223542e9b3a534802` | Defer | Broad shell environment override changes user commands; upstream GIT_TERMINAL_PROMPTS is also misspelled (Git uses singular PROMPT). |
| 54 | `292ae3028e1b0ad376059bee65d5cf8c5e8d29fd` | Defer | Slash usage UX changes include commands removed/repurposed locally. |
| 55 | `59a074f511f583e68d0cea5ca6e37fecd0ffa7df` | Skip | Global daemon formatting-only churn. |
| 56 | `bb772f361084c793174cfe1d9bb5d6526dc7e3a5` | Select subset | Best-effort draft disposal and pending-attach check only; retain fork roster and family-capacity authority, without optional roster merge. |
| 57 | `2e43ebca3753c82ed0ef2064cb14081588ebd4d3` | Skip | Blanket autonomous pause while children run conflicts with continue-independent-work directive and fork lifecycle semantics. |
| 58 | `1316d187b7d73484265edd5276d7a21f1342f6b8` | Already | Provider-first runStartupOnboarding marks shown only after successful configured-model completion. |
| 59 | `5362cf3005126f9413a610eb9b610eb34a07c258` | Skip | Wait/backup model retry overhaul duplicates/conflicts with native coordinator recovery and explicit selected model. |
| 60 | `4535c87e5112f1c976b6f6dabb831f0d2ef93edf` | Defer | Reject 250ms stdin truncation because slow producers could lose input. Non-TTY/cross-project confirmation changes are independent of selected strict parser and qualified installer. |
| 61 | `9fcda876f501a66d19e5d45e78981c2595386697` | Defer | New model-cycling keybinding UX; preserve explicit persistence and configurable keys if later added. |
| 62 | `1fc1adb6e8062bf871a9b59705c1d15468e589f0` | Defer | Slash typo heuristic is not a demonstrated runtime bug and may reject intentional prompt text. |
| 63 | `7a049d50c61ed5a93e65060255e54d752f56dbf2` | Skip | Upstream UI interaction benchmark CI. |
| 64 | `215e7a7409b2931b49d3aad62d29fa8e94345973` | Defer | Goal monotonicity idea relevant, but local native _reloadBranchRuntimeState replaces patched helper; adapt only with source-boundary evidence. |
| 65 | `6be5d4f297f112df8b57b6807de9405c5444fc0f` | Defer | Head-plus-tail summary serialization changes prompt content rather than repairing canonical source. Keep native selection/budget behavior stable for regression comparison. |
| 66 | `f31c440c788499a4ba49736acbf1504a25e3ad4c` | Defer | Kernel diff path extraction plus silent 200-file cap changes summary semantics; not required and must not promote tool data to authority. |
| 67 | `2f5cd0cc163149ad8345f2c7eefe9ce08278cb0a` | Skip | Refinement backup model plus Prime catalog default change; no implicit model or Prime dependency. |
| 68 | `292a3eb35a338e6a7b204eb094a7b722246b0a7b` | Select subset | Hard-error invalid --thinking in args.ts; stale --no-daemon text cleanup only if still present. Combine with strict flag parsing. |
| 69 | `ad4df9364daa7efbb98226dfe1ecb8565635d0e6` | Defer | Harness relevance ranking/search is a new architecture/API, not native public retrieval. |
| 70 | `5c42f8549f3b21f99140a01d5f287e20ee99e19b` | Defer | Session append/fork optimization touches durable native source lifecycle; not blindly compatible. |
| 71 | `13f52b01cdf0332c02005602268332c77353326a` | Defer | New autonomous/subagent model settings; optional feature, preserve explicit supported provider/auth selection. |
| 72 | `6af0e1a4efdfa4f20b1e680f57797397f38090db` | Skip | Upstream swarm capability eval harness, not requested benchmark/control protocol. |
| 73 | `9e7ac5d5e36a9bd3aae6ee10b7cd61ffa002a573` | Select subset | Accept RLMSpawnHandle for delete_subagent only; do not require rlm.spawn or collect. |
| 74 | `284eebc2d09b67264b52b757f43a579286afc380` | Defer | Helpful selector errors coupled to implicit short-form fallback and Prime example; retain exact explicit selectors. |
| 75 | `c0de2eb29e72e44036574ca226ac1452f85c6bea` | Already | Dead ./hooks subpath is already absent from local coding-agent exports. |
| 76 | `b6b9b0b4220db54dd067efd956208318550d804f` | Skip | Private Prime Inference template route and enable_thinking fix; route removed locally. |
| 77 | `7d1913969d33fa5a31366321e3f5db0070dcf2bf` | Defer | SSE remains default. Upstream automatic WebSocket replay/retry is not a direct fit for native physical-attempt admission and captured-prefix budgets; keep current explicit transport failure rather than bypass coordinator. |
| 78 | `8f52777f2d3778c28c97fb438ca9f6bf07310b75` | Select subset | Latest terminal assistant error produces factual needs_input recap without classifier/model request; preserve async owned persistence and protocol13/schema49; later successful turn uses normal classification. |
| 79 | `598eebe8cd6645983c43d50647af9e36e9b07bc0` | Skip | Compiled macOS signing/notarization distribution. |
| 80 | `fb90167a9a061c4585522a973f809a8c0b2c55ab` | Skip | Generic MCP/service catalog merge reverted by commit99; no net feature to transplant. |
| 81 | `5d66ab91326db0b93a8f0044e0fff51834b19929` | Defer | Host-owned extension timer API/lifecycle expansion; not prerequisite. |
| 82 | `8eaa00c37385c6b25fed9d46584b50ffc2e87f9c` | Select | Park waitForIdle on actual blocked-pump predicate; preserve native owner/current/settlement guards. |
| 83 | `807ff048eb53506be7add0116c17f3047292ac8f` | Skip | Readiness wait is for removed Prime private catalog and fallback-model route. |
| 84 | `9bd6a9bc0fbc1e4072cfd7162f855a305c39efb0` | Defer | Queued goal mutation at delivery must respect fork persisted action/source pins; do not mutate frozen records directly. |
| 85 | `2a461b0de77c47d780639c680ca898939a9afda2` | Skip | Remote trace upload test fix; feature removed. |
| 86 | `f87021bf2de379855e0bedc55ac67bad57d825a0` | Defer | Persistent cross-worker link is a transport redesign; preserve worker claim/family capacity behavior. |
| 87 | `ec56defc1c9d121c571988b1ad0f2027283825ff` | Skip | 431-line Git-command policy guard plus813-line suite is an unrequested guardrail; not minimal correctness transplant. |
| 88 | `849ab8599809d1f48fd11f32f58fc4b7de0434ae` | Skip | Upstream benchmark terminal wait CI. |
| 89 | `4a4a2305eb58ab1081f72b3a85da4c962acf70bd` | Skip | Upstream benchmark marker CI. |
| 90 | `5d25a44bd22e1c1fe8321e141cd6c3932563d14c` | Skip | Upstream benchmark UI navigation harness. |
| 91 | `cfb2d3fe35c7c23cf6678ec235412b0d3f286fae` | Defer | Catalog read/write queue performance; depends on ledger changes and fork capacity/source authority. |
| 92 | `327139f7a153388fbe9f90366d8ab944a73d867c` | Defer | Further transcript download optimization depends on46 snapshot redesign. |
| 93 | `6ceb046fe059502c7c617ba8f97ad530df639a41` | Skip | Upstream compiled-release CI download paths. |
| 94 | `27bd07994e3acb96dcde82a1cd8b91e9168a6bc0` | Defer | Catalog canonicalization memo/performance; depends on44/91 and native session file rules. |
| 95 | `c8a631e5de703ab9f50efcf3503359489a2e9be8` | Skip | Upstream cold-worker/catalog benchmark fixtures. |
| 96 | `1a891aa1b765cc351db03547857f4ba9370eb3d5` | Skip | Upstream resident-chat UI benchmark fixtures. |
| 97 | `0cf1314d196d5db4d0918b4fb3d991c9a5b7a2da` | Defer | Model picker effort arrows depend on inline-picker UI; not needed. |
| 98 | `683a2d431bd0600048c0bc83c7429c83ed0df2b5` | Defer | Markdown heading/error icon polish, low impact. |
| 99 | `350ddbaa467d1e1fb8e11a97a1545d251a70afb6` | Skip | Reverts80; keep existing MCP architecture. |
| 100 | `e334a8b460f0ff8791810fac0c9e66a1b4757298` | Select subset | Strict required-value/invalid-mode parsing; keep fork --rpc-protocol-version, prime_context, exports and unknown extension flags. |
| 101 | `a5cc2371ec597560990393b7801a559eda2af0fd` | Defer | Sticky chat name/top bar UI feature. |
| 102 | `dca77ecfe450adbd61c2555c3f1e8c5b70f6cf3f` | Defer | Human-priority scheduling is useful but rewrites action ordering/admission; needs native source ordering adaptation. |
| 103 | `4bf122bb6fd3455b09511791a16a00022098f8a7` | Skip | Upstream nightly channel/release infrastructure. |
| 104 | `f5859162cc5c983090a753222b554a880207dd68` | Defer | Inline provider login UI refactor; provider-first fork is already qualified and removes upstream Prime flows. |
| 105 | `ad426c672327696c42d641379840212ca5a8b85b` | Defer | Depends on deferred catalog scheduling change; do not silently add new timeout semantics. |
| 106 | `83b2d32545d6ad37d4be460031db6df3ae8058e6` | Skip | Prime-specific first-run onboarding rewrite reintroduces unwanted product integration. |
| 107 | `ebe530d28c9f24fb03353085c05a68dcd29e7fbc` | Defer | New child progress/snapshot API and prompt messages; unnecessary wire/runtime feature expansion. |
| 108 | `ebe299ee599d2e7444c034d1b38af38808036e74` | Skip | Compiled Linux musl/baseline artifact matrix, not fork Node runtime installer. |
| 109 | `9c59b394cac2bad490a38d7eee55efe8b0d03d86` | Select subset | State-root-scoped daemon discovery only; reject telemetry/platform fidelity, compiled installer and unrelated CLI refactor. |
| 110 | `ca82b869b5a20fd385bb9c8585b0bd07d47da186` | Skip | Trace-onboarding prompt; remote traces removed. |
| 111 | `8d64d3e1cd1b16dc77a736126f8757673138d0b7` | Skip | Embed native clipboard addon in compiled Bun binaries; not current Node distribution. |
| 112 | `e9d68d92c58492fe554c843ba90f894bcff3fe66` | Skip | Upstream compiled-release manifest forward compatibility; fork installer format differs. |
| 113 | `a7d791bc1be09793ed5f3ec05bf4cccbc60679ea` | Skip | Upstream release0.9.5 version/changelog assembly; keep fork1.0.1 and lawful attribution. |
