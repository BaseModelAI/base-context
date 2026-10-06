/**
 * Minimal SDK Usage
 *
 * Discovers skills, extensions, tools, and context files from cwd and
 * ~/.base-context (or BASE_CONTEXT_HOME). Requires a saved explicit model
 * selection and that provider's authentication; there is no model fallback.
 */

import { createAgentSession } from "@ponythewhite/base-context";

const { session } = await createAgentSession();

session.subscribe((event) => {
	if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
		process.stdout.write(event.assistantMessageEvent.delta);
	}
});

await session.prompt("What files are in the current directory?");
session.state.messages.forEach((msg) => {
	console.log(msg);
});
console.log();
