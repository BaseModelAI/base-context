# Base Context 1.1.3 — clearer costs and a child-cleanup fix

base-context — made in ![Poland](https://raw.githubusercontent.com/BaseModelAI/base-context/v1.1.3/packages/coding-agent/docs/images/poland-flag.svg) by [Synerise AI](https://synerise.com).

This patch brings the updated benchmark report to npm and fixes a race when waiting for a deleted child agent to finish cleanup. No new benchmark runs were added.

## What's changed

- Fixed a race that could cancel a parent's completion wait while its deleted child finished cleanup.
- Plain benchmark language and corrected links to the curated 50-task report and data.
- Missing captured costs estimated for **both Base Context and Codex**.
- Bold estimated dollars per task and percentage savings, with known subtotals and estimated additions kept as supporting detail.

## Estimated cost per task

| Model / effort | **Base estimate / task** | **Codex estimate / task** | **Base saving / task** | **Base saving** |
| --- | ---: | ---: | ---: | ---: |
| Astra / medium | **$3.325** | **$3.668** | **$0.343** | **9.3%** |
| Sol 6.1 / high | **$0.753** | **$0.836** | **$0.082** | **9.8%** |
| Sol 6.1 / xhigh | **$0.948** | **$1.161** | **$0.213** | **18.3%** |
| All profiles | **$1.675** | **$1.888** | **$0.213** | **11.3%** |

**About 11.3% lower estimated cost overall: $1.675 versus $1.888 per task**, or **$0.213 saved per task**, across 150 selected attempts per product.

Base's missing usage is estimated from matched priced requests. Codex's recorded tokens with unknown models are priced at requested-profile model rates. These are API-list-rate estimates, not invoices or complete family spend. Model assumptions matter: using Sol rates for Codex's unknown-model Astra receipts reverses that profile's saving. [Components, assumptions and sensitivity](https://github.com/BaseModelAI/base-context/blob/v1.1.3/benchmarks/context-curated-50/README.md#estimated-cost-per-task).

The underlying timing, completion, quality, failures and timeouts are unchanged. [Full benchmark report](https://github.com/BaseModelAI/base-context/blob/v1.1.3/benchmarks/context-curated-50/README.md).

## Install or update

```sh
npm install -g @ponythewhite/base-context@1.1.3
```

Or use the installer:

```sh
curl -fsSL https://github.com/BaseModelAI/base-context/releases/latest/download/install.sh | bash
```

All four public packages use version **1.1.3**. Published **1.1.2** packages and release assets remain unchanged.
