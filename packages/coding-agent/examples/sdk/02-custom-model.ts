/**
 * Custom Model Selection
 *
 * Shows how to select a specific model and thinking level.
 */

import { AuthStorage, createAgentSession, ModelRegistry } from "@ponythewhite/base-context";
import { getModel } from "@ponythewhite/base-context-ai";

// Set up auth storage and model registry
const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);

// Choose the model this example will actually use. Authenticate to this provider first.
const opus = getModel("anthropic", "claude-opus-4-5");
if (!opus) throw new Error("The explicitly selected model was not found");
console.log(`Selected model: ${opus.provider}/${opus.id}`);

// Discovery only: find a custom model without replacing the explicit choice above.
const customModel = modelRegistry.find("my-provider", "my-model");
if (customModel) {
	console.log(`Found custom model: ${customModel.provider}/${customModel.id}`);
}

// Discovery only: list models with configured authentication, not a fallback order.
const available = await modelRegistry.getAvailable();
console.log(
	"Available models:",
	available.map((m) => `${m.provider}/${m.id}`),
);

const { session } = await createAgentSession({
	model: opus,
	thinkingLevel: "medium", // Supported levels depend on the selected model
	authStorage,
	modelRegistry,
});

session.subscribe((event) => {
	if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
		process.stdout.write(event.assistantMessageEvent.delta);
	}
});

await session.prompt("Say hello in one sentence.");
console.log();
