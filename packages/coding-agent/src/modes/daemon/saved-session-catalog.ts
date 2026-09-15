import { resolve } from "node:path";
import type { DeleteSessionFileResult } from "../../core/session-file-actions.js";
import type {
	AgentConnectionSavedSessionInfo,
	AgentConnectionSavedSessionScope,
	AgentConnectionSessionListCallbacks,
} from "../agent-connection/types.js";
import type { DaemonTransportClient } from "./daemon-client.js";
import { deserializeDaemonError } from "./daemon-errors.js";
import type {
	DaemonCommand,
	DaemonDeleteSavedSessionResult,
	DaemonSavedSessionListCommand,
} from "./daemon-protocol.js";
import { deserializeSavedSessionInfo } from "./saved-session-info.js";
import {
	captureSavedSessionPageQuery,
	type SavedSessionPage,
	type SavedSessionPageQuery,
} from "./saved-session-page.js";

export { deserializeSavedSessionInfo } from "./saved-session-info.js";

export type DaemonSavedSessionCatalogContext = { activeSessionId: string } | { cwd: string; sessionDir?: string };

export type SavedSessionClientPage =
	| (Omit<Extract<SavedSessionPage, { status: "page" }>, "sessions"> & { sessions: AgentConnectionSavedSessionInfo[] })
	| Extract<SavedSessionPage, { status: "refused" }>;

export function listDaemonSavedSessions(
	client: DaemonTransportClient,
	context: DaemonSavedSessionCatalogContext,
	scope: AgentConnectionSavedSessionScope,
	request: { page: SavedSessionPageQuery },
): Promise<SavedSessionClientPage>;
export function listDaemonSavedSessions(
	client: DaemonTransportClient,
	context: DaemonSavedSessionCatalogContext,
	scope: AgentConnectionSavedSessionScope,
	callbacks?: AgentConnectionSessionListCallbacks,
): Promise<AgentConnectionSavedSessionInfo[]>;
export async function listDaemonSavedSessions(
	client: DaemonTransportClient,
	context: DaemonSavedSessionCatalogContext,
	scope: AgentConnectionSavedSessionScope,
	options: { page: SavedSessionPageQuery } | AgentConnectionSessionListCallbacks = {},
): Promise<SavedSessionClientPage | AgentConnectionSavedSessionInfo[]> {
	if (!("page" in options)) {
		// Explicit generic array callers retain all results; the interactive view never enters this branch.
		const sessions = new Map<
			string,
			{ session: AgentConnectionSavedSessionInfo; source: "catalog" | "passive"; ordinal: number }
		>();
		let cursor: SavedSessionPageQuery["cursor"];
		while (true) {
			const page = await listDaemonSavedSessions(client, context, scope, { page: { cursor } });
			if (page.status === "refused") throw new Error(`Saved-session catalog ${page.reason}: ${page.message}`);
			for (const session of page.sessions) {
				if (!page.primary.includes(`file:${resolve(session.path)}`) || sessions.has(session.path)) continue;
				const order = page.sourceOrder.find((item) => item.path === session.path);
				if (!order) throw new Error("Saved-session page is missing its generic array order");
				sessions.set(session.path, { session, source: order.source, ordinal: order.ordinal });
				options.onSession?.(session);
			}
			if (!page.moreAfter) break;
			if (!page.after) throw new Error("Saved-session page has no continuation");
			cursor = { identity: page.after, direction: "next" };
		}
		return [...sessions.values()]
			.sort((a, b) => {
				if (a.source !== b.source) return a.source === "catalog" ? -1 : 1;
				return (
					(a.source === "catalog" ? b.session.modified.getTime() - a.session.modified.getTime() : 0) ||
					a.ordinal - b.ordinal
				);
			})
			.map((item) => item.session);
	}
	const page = captureSavedSessionPageQuery(options.page);
	const command: DaemonSavedSessionListCommand =
		"activeSessionId" in context
			? { type: "list_saved_sessions", activeSessionId: context.activeSessionId, scope, page }
			: { type: "list_saved_sessions", cwd: context.cwd, sessionDir: context.sessionDir, scope, page };
	const response = await client.request(command, 30000);
	if (!response.success) throw deserializeDaemonError(response);
	const data = response.data as SavedSessionPage;
	if (data.status === "refused") return data;
	if (data.status !== "page") throw new Error("Daemon did not return a bounded saved-session page");
	return { ...data, sessions: data.sessions.map(deserializeSavedSessionInfo) };
}

export async function renameDaemonSavedSession(
	client: DaemonTransportClient,
	context: DaemonSavedSessionCatalogContext,
	sessionPath: string,
	name: string,
): Promise<void> {
	const command: Extract<DaemonCommand, { type: "rename_saved_session" }> =
		"activeSessionId" in context
			? { type: "rename_saved_session", activeSessionId: context.activeSessionId, sessionPath, name }
			: { type: "rename_saved_session", sessionPath, name };
	const response = await client.request(command);
	if (!response.success) {
		throw deserializeDaemonError(response);
	}
}

export async function deleteDaemonSavedSession(
	client: DaemonTransportClient,
	context: DaemonSavedSessionCatalogContext,
	sessionPath: string,
): Promise<DeleteSessionFileResult> {
	const command: Extract<DaemonCommand, { type: "delete_saved_session" }> =
		"activeSessionId" in context
			? { type: "delete_saved_session", activeSessionId: context.activeSessionId, sessionPath }
			: { type: "delete_saved_session", sessionPath };
	const response = await client.request(command);
	if (!response.success) {
		throw deserializeDaemonError(response);
	}
	return response.data as DaemonDeleteSavedSessionResult;
}
