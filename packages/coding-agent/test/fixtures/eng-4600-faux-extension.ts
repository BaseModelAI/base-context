import { type FauxResponseFactory, fauxAssistantMessage, registerFauxProvider } from "@ponythewhite/base-context-ai";
import type { ExtensionAPI } from "../../src/index.js";

export default function registerEng4600FauxProvider(pi: ExtensionAPI): void {
	const faux = registerFauxProvider({
		provider: "faux",
		models: [{ id: "faux", reasoning: false }],
	});
	let turnCount = 0;
	const respond: FauxResponseFactory = (_context, options) => {
		faux.appendResponses([respond]);
		// Background status requests share this provider but are not conversation turns.
		if (options?.sessionId?.startsWith("daemon-status:")) {
			return fauxAssistantMessage("<recap>Completed upgrade fixture turn</recap><status>COMPLETED</status>");
		}
		return fauxAssistantMessage(`upgrade response ${++turnCount}`);
	};
	faux.setResponses([respond]);
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
