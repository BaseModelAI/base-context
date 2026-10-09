# Base Context 1.1.2 — keep the work, move faster

base-context — made in ![Poland](https://raw.githubusercontent.com/BaseModelAI/base-context/v1.1.2/packages/coding-agent/docs/images/poland-flag.svg) by [Synerise AI](https://synerise.com).

**Built for work that outlives one context window.** Base Context brings a persistent Python workspace, recoverable tool outputs, and instruction recovery to a coding agent built on Prime Agent and Pi. Keep useful state close. Find the exact result you need. Spend the next step solving the problem instead of rebuilding the last one.

![Base Context: 27–39% shorter mean attempt times across three profiles in the curated benchmark](https://raw.githubusercontent.com/BaseModelAI/base-context/main/packages/coding-agent/docs/images/benchmarks/curated50-overview.svg)

## Where Base Context shines

In our **50-task, three-profile context-stress benchmark**, Base delivered:

- **27–39% shorter mean attempt times** than Codex across all three matched model/effort profiles.
- **150/150 native completions** across the three benchmark profiles.
- **128 of 141 timing wins** where both agents completed and produced fully passing artifacts.

[Explore the full benchmark](https://github.com/BaseModelAI/base-context/blob/main/benchmarks/context-curated-50/README.md).

## What's new in 1.1.2

- **Useful context, less repetition.** TaskFrame avoids repeating instructions already visible in the request and prioritizes older instructions after compaction.
- **Recovery that reaches the source.** Search retained outputs and earlier evidence directly. Keep Python state and use independent workers for parallel tasks.
- **Smoother long-running work.** This release fixes kernel-startup coordination, prompt-result delivery, and WebSocket frame ordering, so received frames finish decoding before transport shutdown.
- **Controls within reach.** Turn on request budgets through settings or the SDK, with a working profile example. Set explicit retry limits when you want them.
- **A stronger foundation.** Smaller compiler and ownership modules, repaired lifecycle fixtures, and offline CI across package suites, coding-agent shards, kernel tests, and process-stress tests.

## Detailed benchmark results

| Model / effort | Base full passes | Codex full passes | Base mean seconds | Codex mean seconds | Shorter Base mean time |
| --- | ---: | ---: | ---: | ---: | ---: |
| Astra / medium | 49/50 | 50/50 | 508.4 | 697.2 | 27.1% |
| Sol / high | 50/50 | 49/50 | 606.4 | 967.4 | 37.3% |
| Sol / xhigh | 49/50 | 47/50 | 908.1 | 1,481.3 | 38.7% |

The benchmark covers 300 first provider-clean attempts on a curated task set. Time means include clean failures and timeouts; full passes require all five main checks plus the edge check. Codex completed 144/150 runs and produced 146/150 passing artifacts. The [benchmark report](https://github.com/BaseModelAI/base-context/blob/main/benchmarks/context-curated-50/README.md) has detailed scores, graphs, build identities, and methods.

## Estimated cost per task

**About 11.3% lower estimated cost overall: $1.675 versus $1.888 per task**, saving **$0.213 per task** across 150 selected attempts per product.

| Model / effort | **Base estimate / task** | **Codex estimate / task** | **Base saving / task** | **Base saving** |
| --- | ---: | ---: | ---: | ---: |
| Astra / medium | **$3.325** | **$3.668** | **$0.343** | **9.3%** |
| Sol 6.1 / high | **$0.753** | **$0.836** | **$0.082** | **9.8%** |
| Sol 6.1 / xhigh | **$0.948** | **$1.161** | **$0.213** | **18.3%** |
| All profiles | **$1.675** | **$1.888** | **$0.213** | **11.3%** |

Both sides include their missing captured costs. Base's eight missing-usage receipts are imputed from comparable priced requests. Codex's 441 missing-model receipts use their recorded token counts at requested-profile rates. These are API-list-rate estimates, not subscription bills or complete agent-family spend. [Methods and sensitivity](https://github.com/BaseModelAI/base-context/blob/main/benchmarks/context-curated-50/README.md#estimated-cost-per-task) explain the assumptions, including when the comparison changes direction.

<details>
<summary>Supporting known subtotals and estimated additions</summary>

| Model / effort | Base known / task | Base added estimate / task | Codex known / task | Codex added estimate / task |
| --- | ---: | ---: | ---: | ---: |
| Astra / medium | $3.3242 | +$0.001016 | $3.1527 | +$0.515185 |
| Sol 6.1 / high | $0.7533 | +$0.000042 | $0.7226 | +$0.112916 |
| Sol 6.1 / xhigh | $0.9467 | +$0.001031 | $1.0273 | +$0.133380 |

Additions use six decimals so small nonzero estimates remain visible.

</details>

## Get started

```sh
curl -fsSL https://github.com/BaseModelAI/base-context/releases/latest/download/install.sh | bash
```

Or, with supported Node.js and npm:

```sh
npm install -g @ponythewhite/base-context
BASE_CONTEXT_INSTALL_UV=1 base-context
```

Choose **`/login` → `/model` → `/effort`**, then give Base Context a real task. The OpenAI Codex login works with an eligible existing ChatGPT account; other providers offer their own supported subscription or API-key routes.

These commands install the latest public release. The installer handles the runtime setup so you can get straight to work.

[Installation](https://github.com/BaseModelAI/base-context/blob/v1.1.2/packages/coding-agent/docs/installation.md) · [Ten-minute guide](https://github.com/BaseModelAI/base-context/blob/v1.1.2/packages/coding-agent/docs/quickstart.md) · [Budget example](https://github.com/BaseModelAI/base-context/blob/v1.1.2/packages/coding-agent/docs/request-token-budgets.md) · [Review follow-up and qualification](https://github.com/BaseModelAI/base-context/blob/v1.1.2/packages/coding-agent/docs/release-1.1.2.md)

Made by **Synerise**. Hosted by **BaseModelAI**. Published under **`@ponythewhite`**. Built on the excellent work of **Prime Intellect and Pi**, with MIT licenses and attribution preserved.
