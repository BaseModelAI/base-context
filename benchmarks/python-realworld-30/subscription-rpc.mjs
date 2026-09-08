import { join } from "node:path";
import benchmarkBashExtension from "./bash-tool.mjs";
import { createHostSubscriptionBackend } from "./host-subscription-backend.mjs";

export async function runSubscriptionRpc(host, options) {
  const { variant, cwd, agentDir, sessionDir, modelId, thinkingLevel } = options;
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
      !modelRegistry.hasConfiguredAuth(model)) {
    throw new Error("Packaged host does not authorize the exact OpenAI Codex subscription route");
  }
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
          id: "benchmark-native-codex", revision: "1",
          api: model.api, provider: model.provider,
          url: "https://chatgpt.com/backend-api/codex/responses", model: model.id,
          authMode: "existing-openai-codex-subscription",
          templateRevision: "base-context-codex-responses/1", replayFamily: "responses-replay-v1",
          contextTokens: model.contextWindow, outputCeilingTokens: model.maxTokens,
          estimate: { tokensPerUtf8Byte: 1, templateTokens: 0, marginTokens: 1024 },
        }],
      } } : {}),
      prewarmIpythonKernel: false, telemetryDisabled: true,
    });
    return { ...result, services, diagnostics: services.diagnostics };
  };
  const sessionManager = await host.SessionManager.create(cwd, sessionDir);
  const runtime = await host.createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager });
  // Existing native/H dispatcher and public JSONL RPC. No broker, proxy or StreamFn.
  await host.runRpcMode(runtime, host.DAEMON_PROTOCOL_VERSION);
}
