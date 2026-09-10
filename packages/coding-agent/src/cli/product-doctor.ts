import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	getBinDir,
	getBundledSkillsDir,
	getCustomThemesDir,
	getLogsDir,
	getPackageDir,
	getPackageJsonPath,
	VERSION,
} from "../config.js";
import {
	CONTEXT_EPOCH_RENDERER,
	CONTEXT_POLICY_EPOCH_RENDERER,
	CONTEXT_SKILL_EPOCH_RENDERER,
	CONTEXT_TOOL_EPOCH_RENDERER,
} from "../core/context-epoch.js";
import { getKernelVenvDir, runtimeCandidateDirs } from "../core/kernel/bootstrap.js";
import { BUILT_IN_PROVIDER_AUTH_CONTRACTS, getProviderAuthContract } from "../core/provider-contracts.js";
import { CURRENT_SESSION_VERSION } from "../core/session-manager.js";
import { DAEMON_PROTOCOL_INFO, DAEMON_SCHEMA_ID } from "../modes/daemon/daemon-protocol.js";
import { defaultDaemonSocketDir, defaultDaemonSocketPath } from "../modes/daemon/daemon-socket.js";
import { PRODUCT, PRODUCT_ENV } from "../product-identity.js";
import { readAbsolutePathEnv, resolveRuntimePaths } from "../runtime-paths.js";

/** Local metadata only: never load credential contents or export diagnostics. */
export function getProductDiagnostics() {
	const paths = resolveRuntimePaths();
	const packageDir = getPackageDir();
	const metadata = JSON.parse(readFileSync(getPackageJsonPath(), "utf8")) as {
		baseContext?: { upstreamVersion?: string; upstreamCommit?: string };
	};
	const buildPath = [join(packageDir, "dist", "build-info.json"), join(packageDir, "build-info.json")].find(
		existsSync,
	);
	const build = buildPath
		? (JSON.parse(readFileSync(buildPath, "utf8")) as { sourceCommit?: string; sourceDirty?: boolean })
		: {};
	return {
		product: { name: PRODUCT.name, package: PRODUCT.packageName, version: VERSION },
		source: {
			repository: PRODUCT.repository,
			commit: build.sourceCommit ?? null,
			dirty: build.sourceDirty ?? null,
			upstreamVersion: metadata.baseContext?.upstreamVersion ?? null,
			upstreamCommit: metadata.baseContext?.upstreamCommit ?? null,
		},
		schemas: {
			daemon: DAEMON_PROTOCOL_INFO,
			daemonSchema: DAEMON_SCHEMA_ID,
			session: CURRENT_SESSION_VERSION,
			nativeContext: `${CONTEXT_EPOCH_RENDERER} (request), ${CONTEXT_POLICY_EPOCH_RENDERER} (policy), ${CONTEXT_TOOL_EPOCH_RENDERER} (tool continuation), ${CONTEXT_SKILL_EPOCH_RENDERER} (selected skills)`,
		},
		paths: {
			...paths,
			package: packageDir,
			runtime: getKernelVenvDir(),
			kernelPythonOverride: readAbsolutePathEnv(PRODUCT_ENV.kernelPython) ?? null,
			runtimeSource:
				runtimeCandidateDirs().find((candidate) => existsSync(join(candidate, "pyproject.toml"))) ?? null,
			logs: getLogsDir(),
			binaries: getBinDir(),
			bundledSkills: getBundledSkillsDir(),
			customThemes: getCustomThemesDir(),
			settings: join(paths.home, "settings.json"),
			projectSettings: join(paths.project, "settings.json"),
			providerConfiguration: join(paths.home, "prime-inference.json"),
			daemonSockets: defaultDaemonSocketDir(),
			defaultDaemonSocket: defaultDaemonSocketPath(),
		},
		providerContracts: [...BUILT_IN_PROVIDER_AUTH_CONTRACTS, getProviderAuthContract("mcp-oauth")],
	};
}

export type ProductDiagnostics = ReturnType<typeof getProductDiagnostics>;

export function formatProductDiagnostics(report: ProductDiagnostics): string {
	const lines = [
		`${report.product.name} ${report.product.version} (${report.product.package})`,
		`Source build: ${report.source.commit ?? "unknown (no build metadata)"}; dirty: ${report.source.dirty ?? "unknown"}`,
		`Upstream: ${report.source.upstreamVersion ?? "unknown"} (${report.source.upstreamCommit ?? "unknown"})`,
		`Schemas: daemon ${report.schemas.daemon.version}, session ${report.schemas.session}; native context: ${report.schemas.nativeContext}`,
		"Resolved paths:",
		...Object.entries(report.paths).map(([name, value]) => `  ${name}: ${value ?? "not set"}`),
		"Provider OAuth contracts:",
		...report.providerContracts.map(
			(contract) => `  ${contract.providerId}: ${contract.oauth}. ${contract.guidance}`,
		),
	];
	return lines.join("\n");
}
