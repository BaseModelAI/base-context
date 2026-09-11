# Base Context

Base Context is a pre-release fork of [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent).
Implementation and validation are in progress. See the [canonical spec](base-context-harness-spec.md),
[implementation status](docs/implementation/STATUS.md), and [spec deviations](SPEC_DEVIATIONS.md).
A public release has not been approved or published. Upstream Prime Agent installers do not install Base Context.

Base Context is an open-source coding and research agent for general and long-running work. It is designed around two core abstractions:

- The **[Recursive Language Model (RLM)](https://www.primeintellect.ai/blog/rlm)** treats context as variables (*prompt-as-a-variable*) and tools like recursive subagents as function calls (*programmatic tool /sub-agent calling*) inside a persistent REPL.
- The **[Continual Harness](https://arxiv.org/abs/2605.09998)** stores supplemental prompts, memories, skill descriptions, and reusable subagent specifications as durable state that Base Context can refine through small, evidence-backed updates, local to the session by default.

Base Context combines a persistent Python control environment with durable harness state, so useful working context and reusable operating patterns can outlive a single chat window.

- **Everything is programmatic:** a persistent Python REPL is the built-in model tool; file operations, shell commands, tool use, subagents, and context management happen through code.
- **Subagents are built in:** `rlm(...)` spawns real child agents for parallel or background work and returns their results programmatically.
- **The harness can improve:** `/refine` reviews the current trajectory and can apply small, evidence-backed updates to supplemental harness state. It never rewrites the immutable base system prompt, and recorded snapshots support rollback.
- **Skills are executable:** skills are importable Python packages, and the built-in skill creator can turn recurring workflows into project or personal skills.
- **Sessions run in the background:** daemon-backed agents keep running when the terminal disconnects and can be reattached later.
- **Agents communicate directly:** running agents can exchange messages and orchestrate one another without routing everything through the user.
- **Long tasks keep moving:** automatic compaction, persistent goals, heartbeats, schedules, autonomous mode, and retained subagents preserve progress across turns and terminal sessions.

## Getting Started

**Runtime upgrade:** The Node engine range is now `^22.12.0 || >=23.3.0`, replacing `>=22.8.0`. Upgrade Node before installing or building this revision. The native session catalog requires SQLite's read-only open option; Node 22.8–22.11 and 23.0–23.2 are no longer supported. This runtime change does not change session journal formats. The normal session owner rebuilds older derived indexes; read-only catalog discovery does not migrate them.

Build from this repository with Node.js 22.12+ on the 22.x line, or Node.js 23.3+, and a compatible npm version:

```bash
git clone --branch implement/base-context-v0.1 https://github.com/BaseModelAI/base-context.git
cd base-context
npm ci
npm run build:source
node packages/coding-agent/dist/bundle/cli.js
```

The source-built CLI works in the current directory. To use another project, change to
that directory and invoke the built CLI by its absolute path. The installed binary is
named `base-context`; until a release is approved, do not use an upstream installer or
expect an unpublished npm package to resolve.

### Owned installer and rollback

The POSIX installer is branded **Base-Context**. Its release endpoints remain
unpublished. The owned installation defaults to
`${XDG_DATA_HOME:-$HOME/.local/share}/base-context`; set `BASE_CONTEXT_INSTALL_ROOT`
to choose another root. Each version has its own CLI, shipped runtime payload,
and prepared default Python environment. Preparation must finish before that
version becomes selected. Follow the installer's PATH instructions before launch,
including the separate `base-context-node` directory if it installed standalone Node.

Release preparation uses `npm run release:pack -- --base-url https://github.com/BaseModelAI/base-context`.
The same repository-root base configures the published shell installer. Versioned
assets use `/releases/download/v<V>/`, including `base-context-<V>.tgz`, the three
core tarballs, and the existing `SHA256SUMS`. The default shell installer resolves
`@ponythewhite/base-context@latest` on npm; its `beta` channel uses the npm `beta` tag.
A positional version, such as `sh install.sh v0.1.0`, or `BASE_CONTEXT_VERSION`
bypasses channel discovery. An unpublished local shell script still needs its
`BASE_CONTEXT_DOWNLOAD_BASE_URL` set to that repository base; these settings do not
publish assets or make unpublished npm tags available.

Leave `BASE_CONTEXT_DOWNLOAD_BASE_URL` unset when running the installed application
to keep native updates on the owned npm package. A GitHub repository URL is not
the application's custom static-manifest endpoint. That separate
[update manifest contract](packages/coding-agent/docs/settings.md#update-checks)
and its redirect rules are unchanged.

Once installed through this route:

```bash
base-context update --self
base-context-install rollback
```

Rollback selects the retained previous CLI/Python pair for future launches. It does
not stop running owners, roll back session data or Node, or undo changes made by
running processes. Normal Python Skill synchronization is unchanged; these
Python environments are not immutable snapshots. Old and failed version directories
are retained; there is no automatic cleanup.

Existing npm/pnpm/yarn/bun global installations stay externally owned. Their normal
updater remains supported, but they do not gain this paired rollback guarantee.
The owned installer does not convert or overwrite those global installations.

For an unpublished local package set, use the dedicated installer from the matching,
freshly built and extracted main package. Supply the other first-party tarballs
explicitly; the installer does not scan adjacent files or rewrite dependency origins:

```bash
PACKS=/absolute/path/to/pack
node /absolute/path/to/extracted-main/package/dist/installer.mjs install \
  /absolute/path/to/new-install-root null \
  "$PACKS/ponythewhite-base-context-0.1.0.tgz" 0.1.0 \
  --local-dependency "$PACKS/ponythewhite-base-context-ai-0.1.0.tgz" \
  --local-dependency "$PACKS/ponythewhite-base-context-tui-0.1.0.tgz" \
  --local-dependency "$PACKS/ponythewhite-base-context-agent-0.1.0.tgz"
```

Use `null` only for a new, unselected owned root. Each repeated option names a local
regular file; relative paths use the invocation's original working directory.
Use a private HOME and install root for an isolated check. The dedicated entry skips
agent/model/auth startup, but npm scripts and Python bootstrap still run and can
download dependencies. This is not an offline install. Preparation must still finish
before the CLI/Python pair becomes selected. Extraction alone is not installation
or activation, and old package sets do not acquire this new installer option.

Base Context uses its own `~/.base-context` state. Copied OAuth clients are not globally
authorized. Supported explicit credential routes and the narrow read-only existing OpenAI
subscription API are documented in the [SDK guide](packages/coding-agent/docs/sdk.md).
Do not copy upstream credential stores into Base Context.

> [!WARNING]
> Base Context executes model-generated Python and project commands with your user permissions. Its worker and kernel processes improve lifecycle isolation and recovery; they are **not** a security sandbox. Review changes and use trusted repositories, instructions, skills, and extensions only. Run untrusted code or instructions in an external sandbox or restricted environment.

Useful commands (for a source build, replace `base-context` with the Node invocation above):

```bash
base-context agents                   # Browse running, idle, and saved sessions
base-context attach <agent>           # Reattach to a running session
base-context --resume [path|id]       # Browse sessions or resume one directly
base-context status                   # Inspect background service state
base-context doctor [--fix]           # Inspect or repair background services
base-context update [--force]         # Update Base Context
base-context shutdown [--force]       # Stop every agent, worker, and background service
```

## Import an offline Prime export

Use a separately produced, coherent offline/filesystem export. This command does
not snapshot or copy a live Prime root, stop writers, or make a read-only view stable.
It accepts supported flat `sessions/*.jsonl` legacy journals, not native-framed
Base Context histories. The destination must be new; imports do not merge or overwrite.

```sh
base-context migrate --from-prime-agent /path/to/offline-export --dry-run --destination /path/to/new-root
base-context migrate --from-prime-agent /path/to/offline-export --destination /path/to/new-root
BASE_CONTEXT_HOME=/path/to/new-root base-context
```

The command retains session history and known working directories, selected model/UI
preferences, and supported package declarations in `inactivePackages`. It does not
resolve or install those packages. `base-context package list` labels them inactive;
only an explicit successful `base-context package install <source>` activates one.
Review and trust a declaration before installing it. An explicit
`BASE_CONTEXT_SESSION_DIR` still controls session storage separately.

Auth files, model credentials, executable/instruction paths, autonomous jobs, daemon
state and kernel snapshots are excluded. Session history itself is retained data,
not scrubbed for secrets and not execution authority. Attachment/artifact and external
reference remapping, paused-job import, opaque replay and trusted runtime resume are
not provided by this command. Its report lists supported and excluded coverage;
this is not a complete migration of every legacy feature. Binary selection is unchanged.

## Built for Long-Running Work
Base Context is built for long-running work, especially for evaluations in research. These features are available in the TUI, and when run autonomously.

- **Continual Harness:** `/refine` can persist focused, reviewable lessons as supplemental prompts, memories, reusable skill descriptions, or subagent specifications, with recorded refinement history. It does not replace packaging and reviewing new executable skills.
- **Direct agent-to-agent communication:** running agents and retained subagents can discover one another, exchange messages, and steer active work.
- **Daemon-backed continuity:** active sessions, Python REPL state, schedules, and subagents keep running when the terminal detaches and can be reattached later.
- **Heartbeats and schedules:** `/heartbeat`, `rlm_heartbeat`, and `base-context schedule` can re-enter a session periodically or at a specific time.
- **Persistent goals:** `/goal` keeps an objective and its progress active across turns until it is completed, paused, or cleared.
- **Bounded autonomous mode:** `/autonomous` continues within configured turn, token, and time budgets and can run user-defined quality gates. A passed gate checks only what that gate verifies; reaching a limit does not imply task success.

## Documentation

- [Quickstart](packages/coding-agent/docs/quickstart.md) — install, authenticate, and run a first session
- [Usage and CLI reference](packages/coding-agent/docs/usage.md) — commands, sessions, autonomous limits, and output modes
- [Long-running and background agents](packages/coding-agent/docs/long-running-agents.md) — detach and reattach, goals, heartbeats, and schedules
- [RLM programming model](packages/coding-agent/docs/rlm.md) — the persistent Python REPL, subagents, skills, and the trust model
- [JSON mode](packages/coding-agent/docs/json.md) and [RPC mode](packages/coding-agent/docs/rpc.md) — headless automation and integrations
- [Skills](packages/coding-agent/docs/skills.md) — install and create reusable capabilities
- [Provider setup](packages/coding-agent/docs/providers.md) — subscription and API-key providers
- [Architecture overview](packages/coding-agent/docs/architecture.md) — daemon, worker, kernel, and persistence boundaries
- [Development](packages/coding-agent/docs/development.md) — build and run from source

## Contributing

Start with a GitHub Discussion for [general questions](https://github.com/BaseModelAI/base-context/discussions/categories/general), [bug reports](https://github.com/BaseModelAI/base-context/discussions/categories/bug-reports), and [feature requests](https://github.com/BaseModelAI/base-context/discussions/categories/feature-requests). Maintainers promote accepted work into Issues, and pull requests are reviewed from maintainers and vouched contributors.

Read the [contribution guidelines](CONTRIBUTING.md) for the full process. Report security vulnerabilities privately by following the [security policy](SECURITY.md).

## Acknowledgements

Our agent and TUI is built on top of [`pi`](https://github.com/earendil-works/pi). We thank the authors of `pi` for their valuable work.

## License

Prime Agent is fully open source and released under the [MIT License](LICENSE).

## Citation

If you use this codebase in your research, please cite Prime Agent:

```bibtex
@article{karten2026prime,
  title={Prime Agent: A Self-Improving RLM Harness},
  author={Karten, Seth and Zhang, Alex L. and Thomas, Kevin and Müller, Sebastian and Bakouch, Elie and Auras, Daniel and Senghaas, Mika and Obeid, Fares and Dunas, Konstantin and Hagemann, Johannes and Jaghouar, Sami},
  journal={arXiv preprint arXiv:2608.23552},
  year={2026}
}
```

Available at [https://arxiv.org/abs/2608.23552](https://arxiv.org/abs/2608.23552).
