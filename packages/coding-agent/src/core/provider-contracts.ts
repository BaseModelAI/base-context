/** Product auth capabilities, independent of protocol adapter registration. */
export interface ProviderAuthContract {
	providerId: string;
	oauth: "validated" | "unvalidated" | "unsupported";
	guidance: string;
	apiKeyProviderId?: string;
}

/** No copied model OAuth client has been validated for this distribution. */
export const BUILT_IN_PROVIDER_AUTH_CONTRACTS: readonly ProviderAuthContract[] = [
	{
		providerId: "anthropic",
		oauth: "unvalidated",
		guidance:
			"Anthropic subscription OAuth is unavailable in Base Context: its client identity has not been validated for this distribution. Use Anthropic API-key login or ANTHROPIC_API_KEY instead.",
		apiKeyProviderId: "anthropic",
	},
	{
		providerId: "github-copilot",
		oauth: "unvalidated",
		guidance:
			"GitHub Copilot authentication is unavailable in Base Context: the copied client identity has not been validated for this distribution. Use an API-key provider such as openai or anthropic instead.",
		apiKeyProviderId: "openai",
	},
	{
		providerId: "openai-codex",
		oauth: "unvalidated",
		guidance:
			"OpenAI Codex subscription OAuth is unavailable in Base Context: its client identity has not been validated for this distribution. For API-key inference, select the openai provider and configure OPENAI_API_KEY.",
		apiKeyProviderId: "openai",
	},
	{
		providerId: "prime-inference",
		oauth: "unsupported",
		guidance:
			"Prime browser login is unavailable in Base Context. Use Prime Inference API-key login or PRIME_API_KEY instead.",
		apiKeyProviderId: "prime-inference",
	},
];

export function getProviderAuthContract(providerId: string): ProviderAuthContract {
	return (
		BUILT_IN_PROVIDER_AUTH_CONTRACTS.find((entry) => entry.providerId === providerId) ?? {
			providerId,
			oauth: "unvalidated",
			guidance: `OAuth for ${providerId} is unavailable in Base Context until its provider contract is validated. Local registration is not validation. Use a supported API-key or bearer-token configuration instead.`,
		}
	);
}

/** Pasting a subscription token into an API-key field does not validate its OAuth route. */
export function isProviderApiKeyAllowed(providerId: string, apiKey: string, api?: string): boolean {
	if (providerId === "github-copilot" || providerId === "openai-codex" || api === "openai-codex-responses")
		return false;
	return (providerId !== "anthropic" && api !== "anthropic-messages") || !apiKey.includes("sk-ant-oat");
}
