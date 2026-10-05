# Changelog

Published Base Context releases, starting with 1.0.0. Dates follow the GitHub release pages.

## [1.1.1](https://github.com/BaseModelAI/base-context/releases/tag/v1.1.1) — 2026-10-05

- Keep native task completion working when an owned child is explicitly deleted: wait for its cleanup, then check the remaining family work.
- Correct the GitHub release installer asset and explicit-version package lookup.

## [1.1.0](https://github.com/BaseModelAI/base-context/releases/tag/v1.1.0) — 2026-10-04

- Add nonblocking Python cell control for long-running work.
- Improve native task completion and child-lifecycle handling.

## [1.0.21](https://github.com/BaseModelAI/base-context/releases/tag/v1.0.21) — 2026-10-03

- Improve journal stability, compaction cleanup, and handling of large tool-output streams.

## [1.0.20](https://github.com/BaseModelAI/base-context/releases/tag/v1.0.20) — 2026-09-30

- Update the client version used for Codex model discovery.

## [1.0.19](https://github.com/BaseModelAI/base-context/releases/tag/v1.0.19) — 2026-09-29

- Keep live session catalogs consistent during concurrent updates.

## [1.0.18](https://github.com/BaseModelAI/base-context/releases/tag/v1.0.18) — 2026-09-29

- Add GPT-6.1 Sol and refresh Codex model discovery.

## [1.0.17](https://github.com/BaseModelAI/base-context/releases/tag/v1.0.17) — 2026-09-29

- Reduce retained-context overhead and repeated queued-watch notifications.

## [1.0.16](https://github.com/BaseModelAI/base-context/releases/tag/v1.0.16) — 2026-09-29

- Add native job watches and bounded inspection for background work.
- Preserve goal continuation across delayed state snapshots.

## [1.0.15](https://github.com/BaseModelAI/base-context/releases/tag/v1.0.15) — 2026-09-28

- Improve recovery of long-running sessions.
- Keep goal status current across delayed snapshots.

## [1.0.14](https://github.com/BaseModelAI/base-context/releases/tag/v1.0.14) — 2026-09-23

- Preserve filtered replay history and add GPT-6 models.
- Improve autonomous and headless workflows.

## [1.0.13](https://github.com/BaseModelAI/base-context/releases/tag/v1.0.13) — 2026-09-21

- Set the default automatic compaction trigger to 90% of the context window.

## [1.0.12](https://github.com/BaseModelAI/base-context/releases/tag/v1.0.12) — 2026-09-21

- Reduce token overhead and improve root-family usage accounting.

## [1.0.11](https://github.com/BaseModelAI/base-context/releases/tag/v1.0.11) — 2026-09-20

- Improve long-session recovery and history views.

## [1.0.10](https://github.com/BaseModelAI/base-context/releases/tag/v1.0.10) — 2026-09-19

- Recover interrupted tools and improve daemon liveness.

## [1.0.9](https://github.com/BaseModelAI/base-context/releases/tag/v1.0.9) — 2026-09-19

- Allow bookkeeping updates during compaction without disrupting context recovery.

## [1.0.8](https://github.com/BaseModelAI/base-context/releases/tag/v1.0.8) — 2026-09-19

- Improve bounded context recovery and working-set assembly.

## [1.0.7](https://github.com/BaseModelAI/base-context/releases/tag/v1.0.7) — 2026-09-18

- Resume native tool sessions when no token budget is configured.

## [1.0.6](https://github.com/BaseModelAI/base-context/releases/tag/v1.0.6) — 2026-09-18

- Preserve native tool context through compaction.
- Document removal of the CLI, runtime, and local state.

## [1.0.5](https://github.com/BaseModelAI/base-context/releases/tag/v1.0.5) — 2026-09-18

- Introduce Synerise startup branding for the independent Base Context CLI.

## [1.0.4](https://github.com/BaseModelAI/base-context/releases/tag/v1.0.4) — 2026-09-17

- Install `uv` in the expected directory for managed Python setup.
- Improve authentication and shutdown handling.

## [1.0.2](https://github.com/BaseModelAI/base-context/releases/tag/v1.0.2) — 2026-09-17

- Correct RPC exit handling for native sessions.

## [1.0.1](https://github.com/BaseModelAI/base-context/releases/tag/v1.0.1) — 2026-09-17

- Add persistent, configurable root-family subagent limits.
- Improve installer profile consent and RPC admission errors.
- Restore supported subscription OAuth routes and improve provider turn handling.
- Remove remote sharing and clarify fork ancestry and packaged documentation.

## [1.0.0](https://github.com/BaseModelAI/base-context/releases/tag/v1.0.0) — 2026-09-15

- Publish the first stable Base Context release with its own CLI, packages, managed Python runtime, and local state.
- Combine a persistent Python workspace and recursive delegation with source-backed working sets, context recovery, and long-running goals.
- Preserve the MIT license and attribution to Prime Agent and Pi.
