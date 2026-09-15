# Installation, updates, and rollback

The application package is **`@ponythewhite/base-context`**. The executable is **`base-context`**. The repository is [BaseModelAI/base-context](https://github.com/BaseModelAI/base-context). Prime Agent's installers and packages install a different product.

## Requirements

- Node.js `^22.12.0 || >=23.3.0`: Node 22.12 or newer on the 22.x line, or Node 23.3 or newer. Node 22.8–22.11 and 23.0–23.2 are not supported.
- npm compatible with that Node version.
- [uv](https://docs.astral.sh/uv/getting-started/installation/) for the managed Python workspace. The default bootstrap installs Python 3.11, the bundled `base-context-runtime`, and its default Python packages.
- A configured, authorized model provider. Provider inference and first-time dependency setup need network access unless you supply local alternatives.

The Node floor comes from the native SQLite session catalog. It does not change the journal format. Normal session owners rebuild older derived indexes; read-only catalog discovery does not migrate them.

## npm installation

```bash
npm install -g @ponythewhite/base-context
base-context --version
cd /path/to/project
base-context
```

Make sure your npm global binary directory is on `PATH`. Use a user-owned Node installation rather than adding elevated permissions just for this agent.

In the UI, use `/login` and then `/model`. See [provider configuration](providers.md). The fork does not inherit permission to use upstream OAuth clients or subscriptions.

Update an npm-managed installation with:

```bash
npm install -g @ponythewhite/base-context@latest
```

The CLI also provides `base-context update`. npm/pnpm/yarn/bun global installations remain externally owned. They do not gain the owned installer's paired CLI/Python rollback.

## Source installation

```bash
git clone https://github.com/BaseModelAI/base-context.git
cd base-context
npm ci
npm run build:source
node packages/coding-agent/dist/bundle/cli.js
```

Do not substitute the upstream repository or an old fork-development branch. The source-built CLI starts in the current working directory. To use it in another project:

```bash
cd /path/to/project
node /absolute/path/to/base-context/packages/coding-agent/dist/bundle/cli.js
```

Replace `base-context` in other examples with that Node invocation when using a source build. Keep source updates under git and rebuild with `npm ci` and `npm run build:source`; a global npm update does not update your checkout.

## Python setup

For npm and source installations, the default kernel environment is `~/.base-context/runtime`. It is prepared lazily when the agent first uses Python. Install `uv` first, or explicitly allow bootstrap to install it with `BASE_CONTEXT_INSTALL_UV=1`. Initial preparation can download Python and dependencies.

For a manual environment:

- `BASE_CONTEXT_KERNEL_PYTHON` selects an absolute Python executable with a current **`base-context-runtime`** already installed.
- `BASE_CONTEXT_KERNEL_VENV` selects an absolute manual environment directory.
- The Python import remains `rlm`; an environment containing only `prime-agent-runtime` is not a substitute.

The owned installer below prepares its own release-local default environment before activation. Python skills can later change that environment; it is not immutable. See [Python-backed skills](skills.md#python-backed-skills).

## Owned installer and rollback

Use the versioned, rendered installer from the GitHub release:

```bash
curl -fL https://github.com/BaseModelAI/base-context/releases/download/v1.0.0/install.sh -o install-base-context.sh
sh install-base-context.sh 1.0.0
```

The separate POSIX installer manages versioned CLI/Python pairs. It defaults to `${XDG_DATA_HOME:-$HOME/.local/share}/base-context`; `BASE_CONTEXT_INSTALL_ROOT` chooses another root. Use the installer and assets from a matching Base Context release, not an upstream installer.

The release layout uses the repository base `https://github.com/BaseModelAI/base-context`, with versioned assets under `/releases/download/v<V>/`. Assets include `base-context-<V>.tgz`, the three core tarballs, and `SHA256SUMS`. The shell installer resolves `@ponythewhite/base-context@latest`; its `beta` channel resolves the npm `beta` tag. A positional version such as `sh install.sh v1.0.0`, or `BASE_CONTEXT_VERSION`, bypasses channel discovery. The matching release assets must already exist.

When invoking a local copy of the shell installer, set `BASE_CONTEXT_DOWNLOAD_BASE_URL` for that invocation to the repository base. This installer setting is **not** the running application's custom update-manifest setting. Leave it unset for normal application launches to use owned npm updates.

Preparation must finish before the new CLI/Python pair becomes selected. Follow the installer's PATH instructions, including the separate `base-context-node` directory if it installs standalone Node. The stable launcher is `<owned-root>/bin/base-context`.

After an owned installation:

```bash
base-context update --self
base-context-install rollback
```

Rollback selects the retained previous CLI/Python pair for future launches. It does not stop running owners, roll back session data or Node, or undo changes made by running processes. Old and failed version directories are retained; there is no automatic cleanup. The owned installer does not convert or overwrite existing global package-manager installations.

### Local release packages

For unpublished local packages, use the dedicated installer from the matching, freshly built and extracted main package. Supply the three other first-party tarballs explicitly:

```bash
PACKS=/absolute/path/to/pack
node /absolute/path/to/extracted-main/package/dist/installer.mjs install \
  /absolute/path/to/new-install-root null \
  "$PACKS/ponythewhite-base-context-1.0.0.tgz" 1.0.0 \
  --local-dependency "$PACKS/ponythewhite-base-context-ai-1.0.0.tgz" \
  --local-dependency "$PACKS/ponythewhite-base-context-tui-1.0.0.tgz" \
  --local-dependency "$PACKS/ponythewhite-base-context-agent-1.0.0.tgz"
```

Substitute the matching release version and actual tarball names. Use `null` only for a new, unselected owned root. Each `--local-dependency` names a local archive containing `package/package.json`. Relative paths use the invocation's original working directory. `tar` must be available. The installer reads package names and configures candidate-local dependencies; it does not scan adjacent files or modify archive contents.

The dedicated entry skips agent/model/auth startup, but npm scripts and Python bootstrap can still download dependencies. This is not an offline install. Extraction alone does not install or activate the package. Old package sets do not acquire this installer option.

## State and configuration

| Path or variable | Purpose |
| --- | --- |
| `~/.base-context` | Default global state and configuration |
| `.base-context/settings.json` | Project settings |
| `BASE_CONTEXT_HOME` | Absolute alternative global state root |
| `BASE_CONTEXT_SESSION_DIR` | Absolute independent session-storage override |
| `--session-dir` | Session-directory override with higher precedence |

Do not point writable Base Context state at `.prime`, `.pi`, or `.prime-context`. Do not copy upstream credential files. Use the explicit [offline history import](sessions.md#importing-an-offline-prime-root) if needed.

`--offline` or `BASE_CONTEXT_OFFLINE=1` disables startup network operations, including update and package checks. It is not a network sandbox and does not make a remote model available offline.

## Troubleshooting

- **Unsupported Node:** upgrade Node before installing or rebuilding.
- **Command not found:** check the npm global binary directory or the owned installer's PATH instructions.
- **Python bootstrap cannot find uv:** install uv, or opt in with `BASE_CONTEXT_INSTALL_UV=1`.
- **Manual Python is rejected:** install the current bundled `base-context-runtime` into the selected environment; do not reuse an upstream-only runtime.
- **No usable model:** configure the actual provider route. A catalog entry is not authentication or subscription permission.
- **Background service issue:** use `base-context status`, then `base-context doctor`; add `--fix` only when you want repairs.

See [settings](settings.md), [usage](usage.md), and [development](development.md) for the full references.
