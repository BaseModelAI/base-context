import { spawn } from "node:child_process";

const MAX_CHARS = 60_000;
const KEEP_CHARS = 29_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const TERMINATION_GRACE_MS = 1_000;

function appendBounded(current, chunk) {
  const merged = current + chunk;
  if (merged.length <= MAX_CHARS) return { text: merged, truncated: false };
  return {
    text: merged.slice(0, KEEP_CHARS) + "\n\n[output truncated]\n\n" + merged.slice(-KEEP_CHARS),
    truncated: true,
  };
}

function boundLines(text) {
  const lines = text.split("\n");
  if (lines.length <= 2_000) return { text, truncated: false };
  return {
    text: [...lines.slice(0, 1_000), "[output truncated]", ...lines.slice(-1_000)].join("\n"),
    truncated: true,
  };
}

export default function benchmarkBashExtension(pi) {
  pi.registerTool({
    name: "bash",
    label: "Bash",
    description: "Run Bash in /workspace, the tool-visible working directory. Python 3.12 is available as python or python3; use its standard library for transformations. Extra shell utilities are not guaranteed. Keep persistent scratch files under /workspace; /tmp and background processes do not survive tool calls. Commands default to a 60000 ms deadline; timeout overrides it, while the outer scenario deadline still applies.",
    promptSnippet: "Run Bash in /workspace; use Python 3.12 standard library and workspace scratch files. Default command deadline: 60000 ms.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Bash command to execute" },
        timeout: { type: "integer", minimum: 1, description: "Command deadline in milliseconds; defaults to 60000 when omitted. Overrides the per-command default, not the outer scenario deadline." },
      },
      required: ["command"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const launcher = process.env.PRIME_CONTEXT_BENCHMARK_SHELL;
      if (!launcher) throw new Error("PRIME_CONTEXT_BENCHMARK_SHELL is not configured");
      return await new Promise((resolve, reject) => {
        const child = spawn(launcher, ["-c", params.command], {
          cwd: ctx.cwd,
          env: process.env,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let truncated = false;
        let timedOut = false;
        let killTimer;
        const timeout = params.timeout ?? DEFAULT_TIMEOUT_MS;
        const append = (which, chunk) => {
          const result = appendBounded(which === "stdout" ? stdout : stderr, chunk.toString("utf8"));
          if (which === "stdout") stdout = result.text;
          else stderr = result.text;
          truncated ||= result.truncated;
        };
        const outputText = () => {
          const combined = stdout + (stderr ? `${stdout ? "\n" : ""}[stderr]\n${stderr}` : "");
          const bounded = boundLines(combined);
          truncated ||= bounded.truncated;
          return bounded.text;
        };
        const withStatus = (status) => {
          const text = outputText();
          return `${text}${text ? "\n\n" : ""}${status}`;
        };
        child.stdout.on("data", (chunk) => append("stdout", chunk));
        child.stderr.on("data", (chunk) => append("stderr", chunk));
        const stop = () => {
          if (killTimer !== undefined) return;
          try { process.kill(-child.pid, "SIGTERM"); } catch {}
          killTimer = setTimeout(() => {
            try { process.kill(-child.pid, "SIGKILL"); } catch {}
            cleanup();
            // Do not wait indefinitely for inherited pipes or a delayed close event.
            child.stdout.destroy();
            child.stderr.destroy();
            child.unref();
            reject(new Error(withStatus(timedOut
              ? `Command timed out after ${timeout} ms`
              : "Command aborted")));
          }, TERMINATION_GRACE_MS);
          killTimer.unref();
        };
        const timeoutTimer = setTimeout(() => {
          timedOut = true;
          stop();
        }, timeout);
        timeoutTimer.unref();
        const cleanup = () => {
          signal.removeEventListener("abort", stop);
          clearTimeout(timeoutTimer);
          if (killTimer !== undefined) clearTimeout(killTimer);
        };
        signal.addEventListener("abort", stop, { once: true });
        child.on("error", (error) => {
          cleanup();
          reject(error);
        });
        child.on("close", (code, childSignal) => {
          cleanup();
          if (timedOut) {
            reject(new Error(withStatus(`Command timed out after ${timeout} ms`)));
            return;
          }
          if (childSignal) {
            reject(new Error(withStatus(`Process terminated by ${childSignal}`)));
            return;
          }
          if (code !== 0 && code !== null) {
            reject(new Error(withStatus(`Command exited with code ${code}`)));
            return;
          }
          resolve({
            content: [{ type: "text", text: outputText() }],
            details: { exitCode: code, signal: childSignal, truncated },
          });
        });
        if (signal.aborted) stop();
      });
    },
  });
}
