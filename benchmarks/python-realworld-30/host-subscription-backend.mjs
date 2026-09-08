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
