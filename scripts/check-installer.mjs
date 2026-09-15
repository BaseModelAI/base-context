import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const installerSource = readFileSync("install.sh", "utf-8");
const mainCall = '\nmain "$@"';
const mainCallIndex = installerSource.lastIndexOf(mainCall);
const ansiPattern = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const syncEnd = "\x1b[?2026l";
const failures = [];

if (mainCallIndex === -1) {
	console.error('Installer check failed: could not find final main "$@" call.');
	process.exit(1);
}

const harnessSource = `${installerSource.slice(0, mainCallIndex)}

base_context_test_cols=80
base_context_test_rows=24

base_context_read_terminal_size() {
	base_context_screen_cols="$base_context_test_cols"
	base_context_screen_rows="$base_context_test_rows"
}

print_render_meta() {
	label="$1"
	if base_context_show_logo; then
		visible=1
	else
		visible=0
	fi
	content_height=$(base_context_content_height)
	printf '__META__ %s cols=%s rows=%s layout_show_logo=%s lab_width=%s render_lab_width=%s compact=%s visible=%s content_height=%s\\n' \\
		"$label" "$base_context_screen_cols" "$base_context_screen_rows" "$base_context_screen_layout_show_logo" \\
		"$base_context_screen_layout_lab_width" "$base_context_screen_render_lab_width" "$base_context_screen_compact" "$visible" "$content_height"
}

render_case() {
	base_context_screen_title="Installing Base-Context"
	base_context_screen_detail="Fetching the verified package."
	base_context_screen_question=
	base_context_screen_frame=1
	base_context_screen_cols="$1"
	base_context_screen_rows="$2"
	base_context_screen_layout_ready=0
	base_context_screen_layout_show_logo=0
	base_context_screen_layout_lab_width=0
	base_context_screen_render_lab_width=0
	base_context_screen_compact=0
	base_context_init_screen_layout
	base_context_refresh_screen_layout_mode
	print_render_meta first
	printf '__RENDER_START__ first\\n'
	base_context_render_screen
	printf '__RENDER_END__ first\\n'

	base_context_screen_frame=2
	base_context_screen_cols="$3"
	base_context_screen_rows="$4"
	base_context_refresh_screen_layout_mode
	print_render_meta second
	printf '__RENDER_START__ second\\n'
	base_context_render_screen
	printf '__RENDER_END__ second\\n'
}

screen_case() {
	base_context_screen_enabled=1
	base_context_screen_drawn=0
	base_context_screen_last_cols=0
	base_context_screen_last_rows=0
	base_context_screen_layout_ready=0
	base_context_screen_layout_show_logo=0
	base_context_screen_layout_lab_width=0
	base_context_screen_render_lab_width=0
	base_context_screen_compact=0
	base_context_screen_frame=0

	base_context_test_cols="$1"
	base_context_test_rows="$2"
	printf '__SCREEN_START__ first\\n' >&2
	base_context_screen "Installing Base-Context" "Installing Base-Context" "Fetching the verified package." ""
	printf '__SCREEN_END__ first\\n' >&2

	base_context_test_cols="$3"
	base_context_test_rows="$4"
	printf '__SCREEN_START__ second\\n' >&2
	base_context_screen "Installing Base-Context" "Installing Base-Context" "Fetching the verified package." ""
	printf '__SCREEN_END__ second\\n' >&2
}

progress_case() {
	progress_details="Preparing global install.
Linking command binaries.
Finalizing npm install."
	for progress_frame in 1 24 25 48 49 200; do
		base_context_animation_frame="$progress_frame"
		printf '__PROGRESS__ %s\t%s\t%s\\n' "$progress_frame" "$(base_context_animation_status "Installing Base-Context" "$progress_details" static)" "$(base_context_animation_detail "$progress_details")"
	done
}

render_case "$@"
screen_case "$@"
progress_case
`;

const tempDir = mkdtempSync(join(tmpdir(), "base-context-installer-render-"));
const harnessPath = join(tempDir, "harness.sh");

try {
	writeFileSync(harnessPath, harnessSource, "utf-8");

	const stableVisible = runCase("stable visible logo", 100, 30, 90, 30);
	check(stableVisible.meta.first.visible === "1", "expected the initial large render to show the logo");
	check(stableVisible.meta.second.visible === "1", "expected a safe resize to keep showing the logo");
	check(
		stableVisible.renders.first.some((line) => line.includes("| Base-Context |")),
		"expected the visible installer wordmark to say Base-Context",
	);
	check(
		stableVisible.meta.first.lab_width === stableVisible.meta.second.lab_width,
		"expected logo lab width to stay stable across a safe resize",
	);
	assertInstallerProgress(stableVisible.progress);

	const stableExpand = runCase("stable expanded logo", 60, 24, 120, 32);
	check(stableExpand.meta.first.visible === "1", "expected the initial medium render to show the logo");
	check(stableExpand.meta.second.visible === "1", "expected terminal growth to keep showing the logo");
	check(
		stableExpand.meta.first.lab_width === stableExpand.meta.second.lab_width,
		"expected logo lab width not to grow after terminal expansion",
	);

	const noLogoStart = runCase("small initial terminal", 41, 24, 100, 30);
	check(noLogoStart.meta.first.layout_show_logo === "0", "expected a too-narrow initial terminal to freeze text-only layout");
	check(noLogoStart.meta.second.visible === "0", "expected terminal growth not to enable a logo after text-only layout was frozen");

	const narrowLogo = runCase("narrow logo on width shrink", 100, 30, 60, 24);
	check(narrowLogo.meta.first.visible === "1", "expected the initial wide render to show the logo");
	check(narrowLogo.meta.second.compact === "0", "expected shrink below frozen lab width to keep rendering the logo");
	check(narrowLogo.meta.second.visible === "1", "expected narrow width mode to keep showing the logo");
	check(
		Number(narrowLogo.meta.second.render_lab_width) <= 59,
		"expected narrow width mode to keep the rendered lab width inside the resized terminal",
	);

	const compactWidth = runCase("compact on severe width shrink", 100, 30, 32, 24);
	check(compactWidth.meta.first.visible === "1", "expected the initial wide render to show the logo");
	check(compactWidth.meta.second.compact === "1", "expected shrink below logo width to use compact mode");
	check(compactWidth.meta.second.visible === "0", "expected severe compact width mode to hide the logo");

	const compactRows = runCase("compact on row shrink", 100, 30, 100, 10);
	check(compactRows.meta.first.visible === "1", "expected the initial tall render to show the logo");
	check(compactRows.meta.second.compact === "1", "expected shrink below frozen splash height to use compact mode");
	check(compactRows.meta.second.visible === "0", "expected compact row mode to hide the logo");

	checkOwnedInstallerRoute();
} finally {
	rmSync(tempDir, { recursive: true, force: true });
}

if (failures.length > 0) {
	console.error(["Installer check failed:", ...failures.map((failure) => `- ${failure}`)].join("\n"));
	process.exit(1);
}

console.log("Installer check passed.");

function checkOwnedInstallerRoute() {
	const binDir = join(tempDir, "bin");
	const installHarnessPath = join(tempDir, "install-harness.sh");
	const downloadDir = join(tempDir, "download scope");
	const tarballPath = join(downloadDir, "base-context-1.2.3.tgz");
	const checksumsPath = join(downloadDir, "SHA256SUMS");
	const root = join(tempDir, "owned install");
	const original = JSON.stringify({ generation: "original", active: "old", previous: null });
	// Run the real main/resolver/URL owners; prerequisites and external effects stay offline boundaries.
	const installHarnessSource = `${installerSource.slice(0, mainCallIndex)}
base_context_install_traps() { :; }
base_context_init_screen() { base_context_screen_enabled=0; }
start_preflight_checks() { :; }
finish_preflight_checks() { return 0; }
confirm_install() { :; }
verify_base_context_package_checksum() { :; }
create_temp_dir() {
  mkdir -p "$FIXTURE_DOWNLOAD_DIR"
  printf '%s\n' "$FIXTURE_DOWNLOAD_DIR"
}
main "$@"
`;
	mkdirSync(binDir);
	mkdirSync(root);
	writeFileSync(join(root, "current.json"), original, "utf8");
	writeFileSync(installHarnessPath, installHarnessSource, "utf8");
	writeFileSync(join(binDir, "npm"), `#!/bin/sh
[ "$EXPECT_NPM_VIEW" = 1 ] || exit 1
[ "$1" = view ] && [ "$2" = --registry=https://registry.npmjs.org ] &&
[ "$3" = @ponythewhite/base-context@latest ] && [ "$4" = version ] || exit 1
: > "$NPM_VIEW_MARKER"
printf '1.2.3\n'
`, { mode: 0o755 });
	writeFileSync(join(binDir, "curl"), `#!/bin/sh
[ "$1" = -fsSL ] && [ "$3" = -o ] || exit 1
case "$2" in
  https://github.com/BaseModelAI/base-context/releases/download/v1.2.3/SHA256SUMS)
    [ "$4" = "$EXPECTED_CHECKSUMS" ] || exit 1 ;;
  https://github.com/BaseModelAI/base-context/releases/download/v1.2.3/base-context-1.2.3.tgz)
    [ "$4" = "$EXPECTED_TARBALL" ] || exit 1 ;;
  *) exit 1 ;;
esac
printf 'offline fixture' > "$4"
`, { mode: 0o755 });
	writeFileSync(join(binDir, "tar"), `#!/bin/sh
[ "$1" = -xzf ] && [ "$2" = "$EXPECTED_TARBALL" ] && [ "$3" = -C ] || exit 1
[ -f "$EXPECTED_CHECKSUMS" ] && [ -f "$EXPECTED_TARBALL" ] || exit 1
mkdir -p "$4/package/dist"
: > "$4/package/dist/installer.mjs"
`, { mode: 0o755 });
	writeFileSync(join(binDir, "node"), `#!/bin/sh
if [ "$EXPECT_NPM_VIEW" = 1 ]; then
  [ -f "$NPM_VIEW_MARKER" ] || exit 1
fi
[ "$1" = "$EXPECTED_ENTRY" ] && [ "$2" = install ] && [ "$3" = "$EXPECTED_ROOT" ] &&
[ "$4" = "$EXPECTED_SELECTION" ] && [ "$5" = "$EXPECTED_TARBALL" ] && [ "$6" = 1.2.3 ]
`, { mode: 0o755 });
	for (const [name, args, expectNpmView] of [
		["default stable", [], "1"],
		["explicit version", ["v1.2.3"], "0"],
	]) {
		const result = spawnSync("sh", [installHarnessPath, ...args], {
			encoding: "utf8",
			env: { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
				BASE_CONTEXT_DOWNLOAD_BASE_URL: "https://github.com/BaseModelAI/base-context",
				BASE_CONTEXT_INSTALL_ROOT: root, BASE_CONTEXT_PACKAGE: "@ponythewhite/base-context",
				BASE_CONTEXT_RELEASE_CHANNEL: "stable", BASE_CONTEXT_VERSION: "",
				FIXTURE_DOWNLOAD_DIR: downloadDir, EXPECT_NPM_VIEW: expectNpmView,
				NPM_VIEW_MARKER: join(tempDir, "npm-view"), EXPECTED_CHECKSUMS: checksumsPath,
				EXPECTED_ENTRY: join(downloadDir, "bootstrap", "package", "dist", "installer.mjs"),
				EXPECTED_ROOT: root, EXPECTED_SELECTION: original, EXPECTED_TARBALL: tarballPath },
		});
		check(result.status === 0, `${name} owned Base-Context installer route failed\n${result.stderr}${result.stdout}`);
	}
}

function runCase(name, initialCols, initialRows, resizedCols, resizedRows) {
	const result = spawnSync("sh", [harnessPath, String(initialCols), String(initialRows), String(resizedCols), String(resizedRows)], {
		detached: true,
		encoding: "utf-8",
	});
	if (result.status !== 0) {
		failures.push(`${name}: harness exited with ${result.status ?? "unknown"}\n${result.stderr}${result.stdout}`);
		return emptyParsedCase();
	}

	const parsed = parseRenderOutput(result.stdout);
	parsed.screens = parseScreenOutput(result.stderr);
	assertLineWidths(name, "first", parsed, initialCols, initialRows);
	assertLineWidths(name, "second", parsed, resizedCols, resizedRows);
	assertScreenFrame(name, "first", parsed, initialCols, initialRows);
	assertScreenFrame(name, "second", parsed, resizedCols, resizedRows);
	return parsed;
}

function parseRenderOutput(output) {
	const parsed = emptyParsedCase();
	let activeRender = null;

	for (const rawLine of output.split("\n")) {
		const line = rawLine.replace(/\r$/, "");
		if (line.startsWith("__META__ ")) {
			const [, label, ...fields] = line.split(" ");
			parsed.meta[label] = Object.fromEntries(fields.map((field) => field.split("=")));
			continue;
		}
		if (line.startsWith("__RENDER_START__ ")) {
			activeRender = line.slice("__RENDER_START__ ".length);
			parsed.renders[activeRender] = [];
			continue;
		}
		if (line.startsWith("__RENDER_END__ ")) {
			activeRender = null;
			continue;
		}
		if (line.startsWith("__PROGRESS__ ")) {
			const [frame, status, detail] = line.slice("__PROGRESS__ ".length).split("\t");
			parsed.progress.push({ frame: Number(frame), status, detail });
			continue;
		}
		if (activeRender) {
			parsed.renders[activeRender].push(line.replace(ansiPattern, ""));
		}
	}

	return parsed;
}

function parseScreenOutput(output) {
	const screens = {};
	for (const label of ["first", "second"]) {
		const startToken = `__SCREEN_START__ ${label}\n`;
		const endToken = `__SCREEN_END__ ${label}\n`;
		const startIndex = output.indexOf(startToken);
		if (startIndex === -1) {
			failures.push(`missing ${label} screen start marker`);
			continue;
		}
		const contentStart = startIndex + startToken.length;
		const endIndex = output.indexOf(endToken, contentStart);
		if (endIndex === -1) {
			failures.push(`missing ${label} screen end marker`);
			continue;
		}
		screens[label] = output.slice(contentStart, endIndex);
	}
	return screens;
}

function assertInstallerProgress(progress) {
	check(progress.length === 6, `expected six progress samples, got ${progress.length}`);
	if (progress.length !== 6) return;

	const expectedDetails = [
		"Preparing global install.",
		"Preparing global install.",
		"Linking command binaries.",
		"Linking command binaries.",
		"Finalizing npm install.",
		"Finalizing npm install.",
	];
	for (const [index, expectedDetail] of expectedDetails.entries()) {
		check(
			progress[index].detail === expectedDetail,
			`expected progress sample ${index + 1} to show "${expectedDetail}", got "${progress[index].detail}"`,
		);
		check(
			progress[index].status === "Installing Base-Context...",
			`expected progress sample ${index + 1} to use indeterminate status`,
		);
		check(!progress[index].status.includes("%"), `expected progress sample ${index + 1} not to include a percent`);
	}
}

function assertLineWidths(name, label, parsed, cols, rows) {
	const lines = parsed.renders[label] ?? [];
	check(lines.length === rows, `${name}: expected ${label} render to have ${rows} rows, got ${lines.length}`);

	const maxWidth = Math.max(cols - 1, 0);
	for (const [index, line] of lines.entries()) {
		check(line.length <= maxWidth, `${name}: ${label} render line ${index + 1} reached ${line.length} columns in a ${cols}-column terminal`);
	}
}

function assertScreenFrame(name, label, parsed, cols, rows) {
	const screen = parsed.screens[label] ?? "";
	check(screen.endsWith(syncEnd), `${name}: expected ${label} screen frame to end with synchronized update close`);
	check(!screen.endsWith(`\n${syncEnd}`), `${name}: expected ${label} screen frame not to emit a trailing row newline`);
	check(countNewlines(screen) === rows - 1, `${name}: expected ${label} screen frame to contain ${rows - 1} line breaks`);

	const lines = screen.replace(ansiPattern, "").split("\n");
	check(lines.length === rows, `${name}: expected ${label} screen frame to contain ${rows} rows, got ${lines.length}`);
	const maxWidth = Math.max(cols - 1, 0);
	for (const [index, line] of lines.entries()) {
		check(line.length <= maxWidth, `${name}: ${label} screen line ${index + 1} reached ${line.length} columns in a ${cols}-column terminal`);
	}
}

function countNewlines(text) {
	let count = 0;
	for (const char of text) {
		if (char === "\n") count++;
	}
	return count;
}

function check(condition, message) {
	if (!condition) {
		failures.push(message);
	}
}

function emptyParsedCase() {
	return {
		meta: {
			first: {},
			second: {},
		},
		renders: {
			first: [],
			second: [],
		},
		screens: {},
		progress: [],
	};
}
