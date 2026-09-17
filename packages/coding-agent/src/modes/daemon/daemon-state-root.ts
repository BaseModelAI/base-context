import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { getAgentDir } from "../../config.js";
import { defaultDaemonSocketDir, defaultDaemonSocketPath, normalizeSocketPath } from "./daemon-socket.js";
import { listDaemonSupervisorSocketPathsForAgentDir } from "./daemon-supervisor-ownership.js";

export interface DaemonStateRoot {
	agentDir: string;
	socketDir: string;
	defaultSocketPath: string;
}

export function currentDaemonStateRoot(): DaemonStateRoot {
	return {
		agentDir: getAgentDir(),
		socketDir: defaultDaemonSocketDir(),
		defaultSocketPath: normalizeSocketPath(defaultDaemonSocketPath()),
	};
}

/**
 * Limit OS-wide discovery to this product state root. The existing default
 * socket namespace includes the agent directory and package scope. Custom
 * sockets inside the agent directory also cover unregistered predecessors;
 * custom sockets elsewhere must be named by this root's ownership registry.
 * Each sweep gets a fresh matcher and a lazy, read-only registry snapshot.
 */
export function createDaemonStateRootMatcher(
	root: DaemonStateRoot = currentDaemonStateRoot(),
): (socketPath: string) => boolean {
	const socketDir = resolve(root.socketDir);
	const agentDir = resolve(root.agentDir);
	const defaultSocketPath = normalizeSocketPath(root.defaultSocketPath);
	let registeredSocketPaths: Set<string> | undefined;
	return (socketPath: string): boolean => {
		const normalized = normalizeSocketPath(socketPath);
		if (normalized === defaultSocketPath) return true;
		// Named pipes have no filesystem parent that identifies a state root.
		if (process.platform !== "win32") {
			const directory = resolve(dirname(normalized));
			const offset = relative(agentDir, directory);
			if (directory === socketDir || (!isAbsolute(offset) && offset !== ".." && !offset.startsWith(`..${sep}`))) {
				return true;
			}
		}
		registeredSocketPaths ??= new Set(listDaemonSupervisorSocketPathsForAgentDir(root.agentDir));
		return registeredSocketPaths.has(normalized);
	};
}
