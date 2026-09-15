import { readFileSync } from "node:fs";

const AUTH_PATH = "/run/host-openai-codex-auth.json";

// This backend runs only in the provider process, never in a tool or the runner.
export function createHostSubscriptionBackend() {
  return {
    withLock(callback) {
      let credential;
      try {
        credential = JSON.parse(readFileSync(AUTH_PATH, "utf8"))["openai-codex"];
      } catch {
        throw new Error("Cannot read the existing host OpenAI Codex subscription");
      }
      if (credential?.type !== "oauth" || typeof credential.access !== "string" || !credential.access ||
          !Number.isFinite(credential.expires) || Date.now() >= credential.expires) {
        throw new Error("Existing host OpenAI Codex subscription is missing, invalid, or expired; refresh is not allowed");
      }
      // Do not hand unrelated providers or the refresh token to the session.
      const value = JSON.stringify({ "openai-codex": {
        type: "oauth", access: credential.access, expires: credential.expires,
      } });
      const { result, next } = callback(value);
      if (next !== undefined) throw new Error("Existing host subscription storage is read-only");
      return result;
    },
    async withLockAsync(_callback) {
      // OAuth refresh happens inside this callback: refuse before invoking it.
      throw new Error("Existing host subscription refresh is not allowed");
    },
  };
}

// This read-only mount exists only in the provider process, never a tool or service.
export function createDeepSeekApiBackend() {
  let key;
  try {
    key = readFileSync("/run/host-deepseek-api-key", "utf8").trim();
  } catch {
    throw new Error("Cannot read the explicit DeepSeek benchmark API key; no credential fallback is allowed");
  }
  if (!key) throw new Error("The explicit DeepSeek benchmark API key is empty");
  return {
    apiKey: key,
    // Stored key strings can be interpreted as commands/environment names by stock.
    // Keep storage empty; the caller supplies the literal via setRuntimeApiKey.
    backend: {
      withLock(callback) {
        const { result, next } = callback("{}");
        if (next !== undefined) throw new Error("DeepSeek benchmark credential storage is read-only");
        return result;
      },
      async withLockAsync(_callback) {
        throw new Error("DeepSeek benchmark credentials do not use OAuth refresh");
      },
    },
  };
}
