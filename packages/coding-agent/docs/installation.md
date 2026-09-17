# Installation, updates, and rollback

Install **Synerise base-context** with the installer below. The application package is `@ponythewhite/base-context`; the command is `base-context`.

## Recommended: the installer

On **macOS or Linux**, run this in a terminal:

```bash
curl -fsSL https://github.com/BaseModelAI/base-context/releases/latest/download/install.sh | bash
```

**You do not install Node.js, npm, Python, or `uv` first.** The installer:

1. Checks Node.js/npm and asks to install a supported version when needed. Some system package-manager methods need administrator approval.
2. Installs `uv` if it is missing, downloads managed Python 3.13, and prepares the bundled runtime and Python packages.
3. Activates the CLI only after that preparation succeeds.
4. Offers to add the launcher and any standalone Node.js installation to your shell profile. It preserves existing settings.
5. Prints one exact `export PATH=... && base-context` command. Run it to activate and launch in your **current terminal**. A child installer cannot change its parent shell's PATH. If you accept the profile update, future shells get the PATH automatically.

Use this route **instead of** the npm alternative. No Python virtual-environment activation is needed. Initial setup needs network access and ordinary shell download/archive tools. Missing Node/npm setup needs terminal approval; rerun in a terminal rather than preinstalling everything manually.

To start work later:

```bash
cd /path/to/your/project
base-context
```

Select a supported provider with `/login`, authenticate with that provider, then select a model with `/model`. You must choose the provider and model. Use that provider's account and authentication. See [provider setup](providers.md).

### Updates and rollback

The installer manages a versioned CLI/Python pair beneath `${XDG_DATA_HOME:-$HOME/.local/share}/base-context`. `BASE_CONTEXT_INSTALL_ROOT` selects another root. The stable launcher is `<owned-root>/bin/base-context`. Existing global package-manager installations remain separate and are not overwritten.

```bash
base-context update --self
base-context-install rollback
```

Rollback selects the retained previous CLI/Python pair for future launches. It does not stop running processes, revert session data or Node.js, or undo changes made by Python skills. Old and failed version directories are retained.

To install a specific release, download that release's installer and pass its version:

```bash
VERSION=1.0.1
curl -fsSL "https://github.com/BaseModelAI/base-context/releases/download/v${VERSION}/install.sh" -o install-base-context.sh
sh install-base-context.sh "$VERSION"
```

The shell resolves the stable npm tag by default; `beta` selects the npm `beta` tag. A positional version or `BASE_CONTEXT_VERSION` bypasses channel discovery. Matching GitHub release assets must exist. `BASE_CONTEXT_DOWNLOAD_BASE_URL` is an installer repository-base override, not the running application's update-manifest setting; leave it unset for normal use.

## npm alternative

Use this only if you already manage Node.js and npm, or if you use Windows. Install supported **Node.js and npm before this route**: Node.js `^22.12.0 || >=23.3.0` (22.12+ on the 22.x line, or 23.3+).

Bash/Zsh:

```bash
npm install -g @ponythewhite/base-context
cd /path/to/project
BASE_CONTEXT_INSTALL_UV=1 base-context
```

PowerShell:

```powershell
npm install -g @ponythewhite/base-context
Set-Location C:\path\to\project
$env:BASE_CONTEXT_INSTALL_UV = "1"
base-context
```

Make sure the npm global binary directory is on PATH. Use a user-owned Node installation rather than adding administrator permissions just for this agent.

**What happens when:** normal `npm install` installs the CLI but skips Python setup. Starting a normal CLI session begins preparing Python in the background when the Python tool is enabled. `BASE_CONTEXT_INSTALL_UV=1` lets this setup install missing `uv`; it then downloads Python and installs the bundled runtime. You do not install Python manually. Later sessions reuse the environment. `base-context --version` does not start Python.

Without that flag, missing `uv` can make the Python tool fail; normal session startup does not offer an installation prompt. The installer route avoids this separate step by finishing Python setup before activation. Advanced npm postinstall bootstrap flags are optional, not required for this route.

Update an npm-managed installation with:

```bash
npm install -g @ponythewhite/base-context@latest
```

`base-context update` also supports package-manager updates. npm/pnpm/yarn/bun installations remain externally owned and do not gain the installer's paired CLI/Python rollback.

## Source installation

```bash
git clone https://github.com/BaseModelAI/base-context.git
cd base-context
npm ci
npm run build:source
BASE_CONTEXT_INSTALL_UV=1 node packages/coding-agent/dist/bundle/cli.js
```

The source-built CLI starts in the current working directory. To work in another project, change to that directory and run `node /absolute/path/to/base-context/packages/coding-agent/dist/bundle/cli.js`. Keep source updates under git, then rerun `npm ci` and `npm run build:source`. A global npm update does not update your checkout.

## Custom Python environments

Ordinary installer users can skip this section. npm and source installations normally use `~/.base-context/runtime`; the installer uses a release-local environment. SDK sessions and RLM children normally prepare Python lazily, unlike the normal CLI root session's background prewarm.

For an explicitly managed environment:

- `BASE_CONTEXT_KERNEL_PYTHON` selects an absolute Python executable with the current bundled **`base-context-runtime`** installed.
- `BASE_CONTEXT_KERNEL_VENV` selects an absolute environment directory.
- The package exposes the Python import `rlm`. This is not a command users need to run to install the CLI.

Saved Python namespaces are not portable across minor versions; native startup rejects an incompatible snapshot. Start a new session when selecting a different Python minor version. Python skills can install additional packages. See [Python-backed skills](skills.md#python-backed-skills).

## Local release packages

For unpublished packages, use the dedicated installer from the matching, freshly built and extracted main package. Supply all three other first-party archives explicitly:

```bash
VERSION=1.0.1
PACKS=/absolute/path/to/pack
node /absolute/path/to/extracted-main/package/dist/installer.mjs install \
  /absolute/path/to/new-install-root null \
  "$PACKS/ponythewhite-base-context-${VERSION}.tgz" "$VERSION" \
  --local-dependency "$PACKS/ponythewhite-base-context-ai-${VERSION}.tgz" \
  --local-dependency "$PACKS/ponythewhite-base-context-tui-${VERSION}.tgz" \
  --local-dependency "$PACKS/ponythewhite-base-context-agent-${VERSION}.tgz"
```

Use the actual archive names and a matching version. `null` means a new, unselected owned root. Relative paths use the invocation's original working directory. `tar` must be available. The installer reads package names and sets candidate-local dependencies; it does not scan adjacent files or alter archives.

This entry skips agent/model/auth startup, but npm and Python setup can download dependencies. Extraction alone does not install or activate the package.

## State and configuration

| Path or variable | Purpose |
| --- | --- |
| `~/.base-context` | Default global state and configuration |
| `.base-context/settings.json` | Project settings |
| `BASE_CONTEXT_HOME` | Absolute alternative global state root |
| `BASE_CONTEXT_SESSION_DIR` | Absolute independent session-storage override |
| `--session-dir` | Session-directory override with higher precedence |

Keep writable Base Context state separate from other applications. Use [offline history import](sessions.md#importing-an-offline-prime-root) when needed.

`--offline` or `BASE_CONTEXT_OFFLINE=1` disables startup network operations, including update and package checks. It is not a network sandbox and does not make a remote model available offline.

## Troubleshooting

- **Missing or unsupported Node:** rerun the installer in a terminal and approve prerequisite setup. npm/source users must install supported Node themselves.
- **Command not found:** run the installer's exact PATH command, or check your npm global binary directory if using npm.
- **Python cannot find uv with npm/source:** launch with `BASE_CONTEXT_INSTALL_UV=1` as shown above.
- **Manual Python is rejected:** install the current bundled runtime into that environment.
- **No model selected:** use `/login` for your provider and `/model` for an explicit model choice.
- **Background service issue:** use `base-context status`, then `base-context doctor`; add `--fix` when you want repairs.

See [settings](settings.md), [usage](usage.md), and [development](development.md) for the full references.
