import { fauxAssistantMessage, registerFauxProvider } from "@ponythewhite/base-context-ai";
import type { ExtensionAPI } from "../../src/index.js";

export default function registerEng4600FauxProvider(pi: ExtensionAPI): void {
	const faux = registerFauxProvider({
		provider: "faux",
		models: [{ id: "faux", reasoning: false }],
	});
	faux.setResponses(Array.from({ length: 16 }, (_, index) => fauxAssistantMessage(`upgrade response ${index + 1}`)));
	pi.registerProvider(faux.getModel().provider, {
		api: faux.api,
		apiKey: "faux-key",
		baseUrl: faux.getModel().baseUrl,
		models: faux.models.map((model) => ({
			api: model.api,
			baseUrl: model.baseUrl,
			contextWindow: model.contextWindow,
			cost: model.cost,
			id: model.id,
			input: model.input,
			maxTokens: model.maxTokens,
			name: model.name,
			reasoning: model.reasoning,
		})),
	});
}
