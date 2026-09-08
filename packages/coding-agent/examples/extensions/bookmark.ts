/**
 * Entry bookmarking example.
 *
 * Shows setLabel to mark entries with labels for easy navigation in /tree.
 * Labels appear in the tree view and help you find important points.
 *
 * Usage: /bookmark [label] - bookmark the last assistant message
 */

import type { ExtensionAPI } from "@ponythewhite/base-context";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("bookmark", {
		description: "Bookmark last message (usage: /bookmark [label])",
		handler: async (args, ctx) => {
			const label = args.trim() || `bookmark-${Date.now()}`;

			const entries = await ctx.sessionManager.readEntries({ maxEntries: 16_384, maxSourceBytes: 64 * 1024 * 1024 });
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i];
				if (entry.type === "message" && entry.message.role === "assistant") {
					await pi.setLabel(entry.id, label);
					ctx.ui.notify(`Bookmarked as: ${label}`, "info");
					return;
				}
			}

			ctx.ui.notify("No assistant message to bookmark", "warning");
		},
	});

	pi.registerCommand("unbookmark", {
		description: "Remove bookmark from last labeled entry",
		handler: async (_args, ctx) => {
			const entries = await ctx.sessionManager.readEntries({ maxEntries: 16_384, maxSourceBytes: 64 * 1024 * 1024 });
			const labels = new Map<string, string>();
			for (const entry of entries) {
				if (entry.type !== "label") continue;
				if (entry.label) labels.set(entry.targetId, entry.label);
				else labels.delete(entry.targetId);
			}
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i];
				const label = labels.get(entry.id);
				if (label) {
					await pi.setLabel(entry.id, undefined);
					ctx.ui.notify(`Removed bookmark: ${label}`, "info");
					return;
				}
			}
			ctx.ui.notify("No bookmarked entry found", "warning");
		},
	});
}
