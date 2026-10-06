# Prepare a release locally

Preparation and publication are separate actions. Run from the repository root with Node.js and npm installed.

## Prepare versioned source

1. Finish source changes and add one consolidated `.changes/*.md` fragment per affected package. Do not edit released changelog sections.
2. Run `npm run check` and the offline tests described in [README-tests.md](README-tests.md). Commit the source changes with a clean worktree.
3. Preview the changelog, then prepare the next version:

   ```sh
   node scripts/release.mjs 1.1.2 --dry-run
   node scripts/release.mjs 1.1.2 --prepare
   ```

   Replace `1.1.2` with the intended release version. `patch` and `minor` also work.

`--prepare` updates the root and four public package versions, internal dependencies, and lockfile. It folds changelog fragments using the normal release helper and removes consumed fragments. It does not reinstall or remove `node_modules`, stage files, commit, tag, publish, or push. The lockfile update runs offline. Existing dependency versions stay pinned; this is not a dependency update command.

Review the changes, run `npm run check`, and commit the version/changelog changes. Then run `npm run build:source` from that exact commit.

## Build local artifacts

For npm, pack each public package without publishing:

```sh
npm pack ./packages/ai --pack-destination /absolute/path/to/new/npm-artifacts
npm pack ./packages/tui --pack-destination /absolute/path/to/new/npm-artifacts
npm pack ./packages/agent --pack-destination /absolute/path/to/new/npm-artifacts
npm pack ./packages/coding-agent --pack-destination /absolute/path/to/new/npm-artifacts
```

Create the output directory first. These tarballs retain npm dependency ranges.

For GitHub Releases:

```sh
node scripts/pack-base-context-release.mjs \
  --base-url https://github.com/BaseModelAI/base-context \
  --out-dir packages/coding-agent/release/local-1.1.2
```

Use a new owned output directory. The packer replaces that directory. The base URL is the repository URL, **not** a `/releases/download/...` URL. The packer adds the versioned download path itself. Do not override `--version` to disguise an old build as a new release.

GitHub tarballs use versioned GitHub URLs for internal dependencies. They are different from the npm tarballs. Inspect both sets and smoke-install them in an isolated directory before publication. A local GitHub-artifact smoke test needs the prepared sibling packages available locally or a local mirror; the future public download URLs do not exist yet.

## Publication requires separate approval

The commands above do not create a GitHub release or publish to npm. A maintainer must separately authorize tagging, pushing, npm publication, and uploading the prepared GitHub assets. Keep release notes clear about what was tested and any benchmark limitations.

**Warning:** `node scripts/release.mjs <target>` without `--prepare` or `--dry-run` is the existing full release command. It changes dependencies, commits, tags, publishes, and pushes. Do not use it for local preparation or rerun it against an already prepared version.
