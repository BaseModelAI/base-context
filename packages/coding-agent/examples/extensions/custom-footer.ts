/**
 * Custom Footer Extension - render only small display state.
 */

import type { ExtensionAPI, ExtensionContext } from "@ponythewhite/base-context";
import { truncateToWidth, visibleWidth } from "@ponythewhite/base-context-tui";

type UsageTotals = { input: number; output: number; cost: number };
const HISTORY_LIMITS = { maxEntries: 16_384, maxSourceBytes: 64 * 1024 * 1024 };

async function loadUsage(ctx: ExtensionContext): Promise<UsageTotals> {
	const entries = await ctx.sessionManager.readBranch(undefined, HISTORY_LIMITS);
	const totals: UsageTotals = { input: 0, output: 0, cost: 0 };
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		totals.input += entry.message.usage.input;
		totals.output += entry.message.usage.output;
		totals.cost += entry.message.usage.cost.total;
	}
	return totals;
}

export default function (pi: ExtensionAPI) {
	let enabled = false;
	let generation = 0;
	let usage: UsageTotals | undefined;
	let modelId = "no-model";
	let requestRender: (() => void) | undefined;

	function invalidateUsage(): void {
		generation++;
		usage = undefined;
		requestRender?.();
	}

	async function refresh(ctx: ExtensionContext): Promise<void> {
		if (!enabled || !requestRender) return;
		modelId = ctx.model?.id ?? "no-model";
		invalidateUsage();
		const capturedGeneration = generation;
		try {
			const next = await loadUsage(ctx);
			if (!enabled || capturedGeneration !== generation) return;
			usage = next;
		} catch {
			if (!enabled || capturedGeneration !== generation) return;
			usage = undefined;
		}
		requestRender?.();
	}

	pi.on("session_start", async (_event, ctx) => refresh(ctx));
	pi.on("session_tree", async (_event, ctx) => refresh(ctx));
	pi.on("session_compact", async (_event, ctx) => refresh(ctx));
	pi.on("message_start", () => invalidateUsage());
	// message_end extensions run before the message append ACK. Do not refresh here.
	pi.on("message_end", () => invalidateUsage());
	pi.on("turn_end", async (_event, ctx) => refresh(ctx));
	pi.on("agent_end", async (_event, ctx) => refresh(ctx));
	pi.on("model_select", (event) => {
		modelId = event.model.id;
		requestRender?.();
	});
	pi.on("session_shutdown", () => {
		enabled = false;
		invalidateUsage();
		requestRender = undefined;
	});

	pi.registerCommand("footer", {
		description: "Toggle custom footer",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			invalidateUsage();
			if (!enabled) {
				ctx.ui.setFooter(undefined);
				ctx.ui.notify("Default footer restored", "info");
				return;
			}

			modelId = ctx.model?.id ?? "no-model";
			ctx.ui.setFooter((tui, theme, footerData) => {
				requestRender = () => tui.requestRender();
				const unsub = footerData.onBranchChange(() => tui.requestRender());
				return {
					dispose() {
						requestRender = undefined;
						invalidateUsage();
						unsub();
					},
					invalidate() {},
					render(width: number): string[] {
						const fmt = (n: number) => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`);
						const stats = usage
							? `↑${fmt(usage.input)} ↓${fmt(usage.output)} $${usage.cost.toFixed(3)}`
							: "usage unknown";
						const left = theme.fg("dim", stats);
						const branch = footerData.getGitBranch();
						const right = theme.fg("dim", `${modelId}${branch ? ` (${branch})` : ""}`);
						const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));
						return [truncateToWidth(left + pad + right, width)];
					},
				};
			});
			ctx.ui.notify("Custom footer enabled", "info");
			await refresh(ctx);
		},
	});
}
