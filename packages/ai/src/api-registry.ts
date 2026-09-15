import type {
	Api,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
} from "./types.js";

export type ApiStreamFunction = (
	model: Model<Api>,
	context: Context,
	options?: StreamOptions,
) => AssistantMessageEventStream;

export type ApiStreamSimpleFunction = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export interface ApiProvider<TApi extends Api = Api, TOptions extends StreamOptions = StreamOptions> {
	api: TApi;
	stream: StreamFunction<TApi, TOptions>;
	streamSimple: StreamFunction<TApi, SimpleStreamOptions>;
}

interface ApiProviderInternal {
	api: Api;
	stream: ApiStreamFunction;
	streamSimple: ApiStreamSimpleFunction;
}

type RegisteredApiProvider = {
	provider: ApiProviderInternal;
	sourceId?: string;
	originalStream: object;
	originalStreamSimple: object;
	registeredStream: ApiStreamFunction;
	registeredStreamSimple: ApiStreamSimpleFunction;
};

const apiProviderRegistry = new Map<string, RegisteredApiProvider>();

function wrapStream<TApi extends Api, TOptions extends StreamOptions>(
	api: TApi,
	stream: StreamFunction<TApi, TOptions>,
): ApiStreamFunction {
	return (model, context, options) => {
		if (model.api !== api) {
			throw new Error(`Mismatched api: ${model.api} expected ${api}`);
		}
		return stream(model as Model<TApi>, context, options as TOptions);
	};
}

function wrapStreamSimple<TApi extends Api>(
	api: TApi,
	streamSimple: StreamFunction<TApi, SimpleStreamOptions>,
): ApiStreamSimpleFunction {
	return (model, context, options) => {
		if (model.api !== api) {
			throw new Error(`Mismatched api: ${model.api} expected ${api}`);
		}
		return streamSimple(model as Model<TApi>, context, options);
	};
}

export function registerApiProvider<TApi extends Api, TOptions extends StreamOptions>(
	provider: ApiProvider<TApi, TOptions>,
	sourceId?: string,
): void {
	const stream = wrapStream(provider.api, provider.stream);
	const streamSimple = wrapStreamSimple(provider.api, provider.streamSimple);
	apiProviderRegistry.set(provider.api, {
		provider: { api: provider.api, stream, streamSimple },
		sourceId,
		originalStream: provider.stream,
		originalStreamSimple: provider.streamSimple,
		registeredStream: stream,
		registeredStreamSimple: streamSimple,
	});
}

export function getApiProvider(api: Api): ApiProviderInternal | undefined {
	return apiProviderRegistry.get(api)?.provider;
}

/** Compares implementation identity, not caller-supplied registration metadata. */
export function matchesApiProvider(api: Api, stream: object, streamSimple: object): boolean {
	const entry = apiProviderRegistry.get(api);
	return (
		!!entry &&
		entry.originalStream === stream &&
		entry.originalStreamSimple === streamSimple &&
		entry.provider.stream === entry.registeredStream &&
		entry.provider.streamSimple === entry.registeredStreamSimple
	);
}

export function getApiProviders(): ApiProviderInternal[] {
	return Array.from(apiProviderRegistry.values(), (entry) => entry.provider);
}

export function unregisterApiProviders(sourceId: string): void {
	for (const [api, entry] of apiProviderRegistry.entries()) {
		if (entry.sourceId === sourceId) {
			apiProviderRegistry.delete(api);
		}
	}
}

export function clearApiProviders(): void {
	apiProviderRegistry.clear();
}
