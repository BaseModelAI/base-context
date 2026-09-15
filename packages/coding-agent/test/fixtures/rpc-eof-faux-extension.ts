import { fauxAssistantMessage, registerFauxProvider } from "@ponythewhite/base-context-ai";
import type { ExtensionAPI } from "../../src/index.js";

export default function registerRpcEofFauxProvider(pi: ExtensionAPI): void {
	const faux = registerFauxProvider({
		provider: "faux",
		models: [{ id: "faux", reasoning: false }],
	});
	faux.setResponses([
		async () => {
			await new Promise((resolve) => setTimeout(resolve, 250));
			return fauxAssistantMessage("rpc eof response");
		},
	]);
	pi.registerProvider(faux.getModel().provider, {
		api: faux.api,
		apiKey: "faux-key",
		baseUrl: faux.getModel().baseUrl,
		models: faux.models,
	});
}
