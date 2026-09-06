import { resolve } from "node:path";
import { VERSION } from "../../config.js";
import type { DaemonRuntimeIdentity } from "./daemon-protocol.js";

declare const __PI_BUILD_ID__: string | undefined;

export const BASE_CONTEXT_BUILD_ID_ENV = "BASE_CONTEXT_BUILD_ID";
export const BASE_CONTEXT_LAUNCHER_PATH_ENV = "BASE_CONTEXT_LAUNCHER_PATH";

function bundledBuildId(): string | undefined {
	return typeof __PI_BUILD_ID__ === "undefined" ? undefined : __PI_BUILD_ID__;
}

export function getDaemonRuntimeIdentity(environment: NodeJS.ProcessEnv = process.env): DaemonRuntimeIdentity {
	const entrypoint = process.argv[1];
	const launcher = environment[BASE_CONTEXT_LAUNCHER_PATH_ENV];
	return {
		buildId: environment[BASE_CONTEXT_BUILD_ID_ENV] ?? bundledBuildId() ?? `release-${VERSION}`,
		executablePath: resolve(process.execPath),
		...(entrypoint ? { entrypointPath: resolve(entrypoint) } : {}),
		...(launcher ? { launcherPath: resolve(launcher) } : {}),
	};
}
