import { getOAuthProvider } from "@ponythewhite/base-context-ai/oauth";

/** Supported adapters, not a claim of provider endorsement or live account validation. */
export interface ProviderAuthContract {
	providerId: string;
	oauth: "supported" | "unsupported";
	guidance: string;
	apiKeyProviderId?: string;
}

export function getProviderAuthContract(providerId: string): ProviderAuthContract {
	if (providerId === "prime" || providerId === "prime-intellect") {
		return { providerId, oauth: "unsupported", guidance: "Prime integrations are disabled in Base Context." };
	}
	const provider = getOAuthProvider(providerId);
	return {
		providerId,
		oauth: provider ? "supported" : "unsupported",
		guidance: provider
			? providerId.startsWith("mcp:")
				? `Use /mcp login ${providerId.slice(4)} to connect ${provider.name}.`
				: `Use /login to authenticate with ${provider.name}, then select a model with /model.`
			: `No OAuth adapter is registered for ${providerId}. Configure a supported provider or register its OAuth adapter.`,
	};
}

export const BUILT_IN_PROVIDER_AUTH_CONTRACTS: readonly ProviderAuthContract[] = [
	"anthropic",
	"github-copilot",
	"openai-codex",
	"prime-intellect",
].map(getProviderAuthContract);

/** Codex uses OAuth credentials, not OpenAI API keys. */
export function isProviderApiKeyAllowed(providerId: string, _apiKey: string, api?: string): boolean {
	return (
		providerId !== "prime" &&
		providerId !== "prime-intellect" &&
		providerId !== "openai-codex" &&
		api !== "openai-codex-responses"
	);
}
