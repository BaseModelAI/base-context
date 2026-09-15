import { getApiProvider } from "./api-registry.js";
import { assertBuiltInAttemptSupport } from "./providers/register-builtins.js";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	ProviderStreamOptions,
	SimpleStreamOptions,
	StreamOptions,
} from "./types.js";

export { getEnvApiKey } from "./env-api-keys.js";

function resolveApiProvider(api: Api, options?: StreamOptions) {
	let localSimulation = false;
	if (options?.requireProviderAttempts) {
		localSimulation = assertBuiltInAttemptSupport(api) === "local-faux";
		if (!localSimulation && !options.attempts) {
			throw new Error("Native inference requires physical-attempt admission and settlement");
		}
	}
	const provider = getApiProvider(api);
	if (!provider) throw new Error(`No API provider registered for api: ${api}`);
	return { stream: provider.stream, streamSimple: provider.streamSimple, localSimulation };
}

export function stream<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: ProviderStreamOptions,
): AssistantMessageEventStream {
	const provider = resolveApiProvider(model.api, options as StreamOptions);
	const dispatchOptions = provider.localSimulation ? { ...options, attempts: undefined } : options;
	return provider.stream(model, context, dispatchOptions as StreamOptions);
}

export async function complete<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: ProviderStreamOptions,
): Promise<AssistantMessage> {
	const s = stream(model, context, options);
	return s.result();
}

export function streamSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const provider = resolveApiProvider(model.api, options);
	const dispatchOptions = provider.localSimulation ? { ...options, attempts: undefined } : options;
	return provider.streamSimple(model, context, dispatchOptions);
}

export async function completeSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): Promise<AssistantMessage> {
	const s = streamSimple(model, context, options);
	return s.result();
}
