import { join } from "node:path";
import benchmarkBashExtension from "./bash-tool.mjs";
import { createDeepSeekApiBackend, createHostSubscriptionBackend } from "./host-subscription-backend.mjs";

// Stock agent_end precedes its retry decision. Publish only the real SDK idle barrier.
export function observeStockSessionIdle(session, emit) {
  let waiting;
  return session.subscribe((event) => {
    if (!["agent_end", "auto_retry_end"].includes(event.type) || waiting) return;
    waiting = session.waitForHeadlessIdle();
    void waiting.then(
      () => {
        waiting = undefined;
        // A lower-only post-compaction retry can outlive the native idle barrier.
        if (!session.isRetrying) emit({ type: "benchmark_session_idle" });
      },
      (error) => {
        waiting = undefined;
        emit({ type: "benchmark_session_idle_error", error: String(error?.message ?? error) });
      },
    );
  });
}

export async function runSubscriptionRpc(host, options) {
  const { variant, agentDir, modelId } = options;
  if (!["vanilla", "current"].includes(variant) || !["gpt-5.6-sol", "gpt-6-astra"].includes(modelId)) {
    throw new Error("Unsupported benchmark arm or exact Sol/Astra model");
  }
  const authStorage = host.AuthStorage.fromStorage(createHostSubscriptionBackend(), {
    usePrimeCliConfig: false,
    ...(variant === "current" ? { existingOpenAICodexSubscription: true } : {}),
  });
  if (authStorage.drainErrors().length > 0) {
    throw new Error("Existing host OpenAI Codex subscription could not be loaded; no refresh or fallback is allowed");
  }
  const modelRegistry = host.ModelRegistry.create(authStorage, join(agentDir, "models.json"));
  // Local exact catalog lookup only. Do not discover models or choose a fallback.
  const model = modelRegistry.find("openai-codex", modelId);
  if (!model || model.id !== modelId || model.provider !== "openai-codex" || model.api !== "openai-codex-responses" ||
      model.baseUrl !== "https://chatgpt.com/backend-api" || !modelRegistry.hasConfiguredAuth(model)) {
    throw new Error("Packaged host does not authorize the exact OpenAI Codex subscription route");
  }
  return runConfiguredRpc(host, options, authStorage, modelRegistry, model, {
    id: "benchmark-native-codex",
    url: "https://chatgpt.com/backend-api/codex/responses",
    authMode: "existing-openai-codex-subscription",
    templateRevision: "base-context-codex-responses/1", replayFamily: "responses-replay-v1",
  });
}

export async function runDeepSeekRpc(host, options) {
  const { variant, agentDir, modelId } = options;
  if (!["vanilla", "current"].includes(variant) || modelId !== "deepseek-flash") {
    throw new Error("Unsupported benchmark arm or exact DeepSeek model");
  }
  const { apiKey, backend } = createDeepSeekApiBackend();
  const authStorage = host.AuthStorage.fromStorage(backend, { usePrimeCliConfig: false });
  authStorage.setRuntimeApiKey("deepseek", apiKey);
  if (authStorage.drainErrors().length > 0) {
    throw new Error("The explicit DeepSeek API credential could not be loaded");
  }
  const modelRegistry = host.ModelRegistry.create(authStorage, join(agentDir, "models.json"));
  const model = modelRegistry.find("deepseek", modelId);
  if (!model || model.id !== modelId || model.provider !== "deepseek" || model.api !== "openai-completions" ||
      model.baseUrl !== "https://api.deepseek.com" || !modelRegistry.hasConfiguredAuth(model)) {
    throw new Error("Packaged host does not authorize the exact DeepSeek API route");
  }
  return runConfiguredRpc(host, options, authStorage, modelRegistry, model, {
    id: "benchmark-native-deepseek",
    url: "https://api.deepseek.com/chat/completions",
    authMode: "deepseek-api-key",
    templateRevision: "base-context-deepseek-completions/1", replayFamily: "deepseek-completions-replay-v1",
  });
}

export async function runConfiguredRpc(host, options, authStorage, modelRegistry, model, profile) {
  const { variant, cwd, agentDir, sessionDir, thinkingLevel } = options;
  // runRpcMode redirects later stdout writes to stderr; retain its original RPC sink.
  const writeRpcOutput = process.stdout.write.bind(process.stdout);
  const services = await host.createAgentSessionServices({
    cwd, agentDir, authStorage, modelRegistry, telemetryDisabled: true,
    resourceLoaderOptions: {
      noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true, noExtensions: true,
      bundledSkillsDir: null, extensionFactories: [benchmarkBashExtension],
    },
  });
  const createRuntime = async ({ sessionManager, sessionStartEvent }) => {
    const result = await host.createAgentSessionFromServices({
      services, sessionManager, sessionStartEvent, model, thinkingLevel,
      tools: variant === "current" ? ["bash", "prime_context"] : ["bash"],
      // Declared benchmark policy, not deployment/tokenizer certification. Opaque accounting may still refuse.
      ...(variant === "current" ? { requestTokenBudget: {
        mode: "enforce",
        profiles: [{
          ...profile, revision: "1",
          api: model.api, provider: model.provider, model: model.id,
          contextTokens: model.contextWindow, outputCeilingTokens: model.maxTokens,
          estimate: { tokensPerUtf8Byte: 1, templateTokens: 0, marginTokens: 1024 },
        }],
      } } : {}),
      prewarmIpythonKernel: false, telemetryDisabled: true,
    });
    if (variant === "vanilla") {
      observeStockSessionIdle(result.session, (event) => writeRpcOutput(`${JSON.stringify(event)}\n`));
    }
    return { ...result, services, diagnostics: services.diagnostics };
  };
  const sessionManager = await host.SessionManager.create(cwd, sessionDir);
  const runtime = await host.createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager });
  // Existing native/H dispatcher and public JSONL RPC. No broker, proxy or StreamFn.
  await host.runRpcMode(runtime, host.DAEMON_PROTOCOL_VERSION);
}
