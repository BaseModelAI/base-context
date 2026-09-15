import { Markdown, type MarkdownTheme, Spacer, Text } from "@ponythewhite/base-context-tui";
import type { CompactionSummaryMessage } from "../../../core/messages.js";
import { getMarkdownTheme, theme } from "../theme/theme.js";
import { customMessageLabel, ExpandableCustomMessageBox } from "./expandable-custom-message.js";
import { expandCollapseHint } from "./keybinding-hints.js";

/** Compaction summary card: full markdown summary when expanded. */
export class CompactionSummaryMessageComponent extends ExpandableCustomMessageBox {
	constructor(
		private readonly message: CompactionSummaryMessage,
		private readonly markdownTheme: MarkdownTheme = getMarkdownTheme(),
	) {
		super();
		this.updateDisplay();
	}

	protected updateDisplay(): void {
		this.clear();

		const description =
			this.message.tokensBefore === null
				? "Compacted (prior token estimate unknown)"
				: `Compacted from ${this.message.tokensBefore.toLocaleString()} tokens`;
		const label = customMessageLabel("compaction");
		this.addChild(new Text(label, 0, 0));
		this.addChild(new Spacer(1));

		const instructions = this.message.customInstructions;
		if (this.expanded) {
			let header = `**${description}**\n\n`;
			if (instructions) {
				header += `**Focus:** ${instructions}\n\n`;
			}
			this.addChild(
				new Markdown(header + this.message.summary, 0, 0, this.markdownTheme, {
					color: (text: string) => theme.fg("customMessageText", text),
				}),
			);
		} else {
			const focus = instructions ? ` · focus: ${instructions}` : "";
			this.addChild(
				new Text(
					`${theme.fg("customMessageText", `${description}${focus}`)} ${expandCollapseHint("app.tools.expand", false)}`,
					0,
					0,
				),
			);
		}
	}
}
