// prime-agent 0.9.4 accounting-only observation, version 1.
// No inference options, messages, retries, response bodies, or output streams are replaced.
import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync } from "node:fs";
const context = new AsyncLocalStorage();
const path = process.env.PRIME_COST_ACCOUNTING_PATH;
let serial = 0, writeFailures = 0;
const openAttempts = new Set(), openOperations = new Set(), openConnections = new Set();
const nextId = (kind) => `${process.pid}:${kind}:${++serial}`;
const number = (x) => typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : undefined;
const label = (x) => typeof x === "string" && /^[a-zA-Z0-9_.:/-]{1,180}$/.test(x) ? x : undefined;
function write(record) {
  if (!path) return;
  try { appendFileSync(path, JSON.stringify({ schema: "prime-cost-accounting/1", pid: process.pid, ...record }) + "\n", { mode: 0o600 }); }
  catch { writeFailures++; if (writeFailures === 1) process.stderr.write("PRIME_COST_ACCOUNTING_WRITE_FAILED\n"); }
}
function route(value) {
  try { const u = new URL(String(value)); return `${u.protocol}//${u.host}${u.pathname}`; } catch { return undefined; }
}
// Usage-only numbers and numeric nested metadata. Never retain text-valued provider fields.
function rawNumbers(value) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(rawNumbers);
  if (!value || typeof value !== "object") return undefined;
  return Object.fromEntries(Object.entries(value).filter(([key]) => /^[a-zA-Z][a-zA-Z0-9_]*$/.test(key))
    .map(([key, item]) => [key, rawNumbers(item)]).filter(([, item]) => item !== undefined));
}
function identity(model) {
  return { provider: label(model.provider), api: label(model.api), model: label(model.id), pricing: {
    status: "unvalidated", currency: "USD", unit: "million-tokens", catalogRates: rawNumbers(model.cost ?? {})
  } };
}
function operation(model, options, fn) {
  if (!path) return fn();
  const parent = context.getStore();
  const op = { purpose: parent?.purpose ?? "unknown", purposeDetail: parent?.purposeDetail,
    operationId: nextId("operation"), modelContract: identity(model),
    sessionId: options?.sessionId, requestedEffort: label(options?.reasoningEffort ?? options?.reasoning),
    requestedServiceTier: label(options?.serviceTier), signal: options?.signal,
    startedAt: Date.now(), attempts: 0, effectiveEffort: undefined };
  openOperations.add(op.operationId);
  write({ type: "operation_started", ...publicOperation(op) });
  return context.run(op, async () => {
    try { return await fn(); }
    finally {
      if (op.active) settle(op.signal?.aborted ? "cancelled" : "interrupted");
      openOperations.delete(op.operationId);
      write({ type: "operation_settled", ...publicOperation(op), settledAt: Date.now(), physicalAttempts: op.attempts });
    }
  });
}
function publicOperation(op) {
  return { operationId: op.operationId, purpose: op.purpose, purposeDetail: op.purposeDetail,
    sessionId: op.sessionId, modelContract: op.modelContract, startedAt: op.startedAt,
    requestedEffort: op.requestedEffort, requestedServiceTier: op.requestedServiceTier };
}
function call(purpose, fn, ...args) {
  if (!path) return fn(...args);
  const [kind, detail] = purpose.split(":");
  return context.run({ ...context.getStore(), purpose: kind, purposeDetail: detail }, () => fn(...args));
}
function configure(body) {
  const op = context.getStore(); if (!op?.operationId) return;
  op.wireModel = label(body?.model);
  op.effectiveEffort = label(body?.reasoning?.effort ?? body?.reasoning_effort);
  op.thinkingEnabled = body?.thinking?.type === "enabled" ? true : body?.thinking?.type === "disabled" ? false : undefined;
  op.effectiveServiceTier = label(body?.service_tier);
}
function begin(transport, url) {
  const op = context.getStore(); if (!op?.operationId) return;
  if (op.active) settle("interrupted");
  const now = Date.now();
  const attempt = { attemptId: nextId("attempt"), transport, route: route(url),
    provider: op.modelContract.provider, api: op.modelContract.api, model: op.modelContract.model,
    wireModel: op.wireModel, effectiveEffort: op.effectiveEffort, thinkingEnabled: op.thinkingEnabled,
    effectiveServiceTier: op.effectiveServiceTier, rawUsage: [], usage: {}, usageCompleteness: "none",
    timing: { queuedAt: op.startedAt, admittedAt: now, sentAt: now }, outcome: undefined,
    physicalAttemptIndex: ++op.attempts };
  op.active = attempt; openAttempts.add(attempt.attemptId);
  write({ type: "attempt_admitted", ...publicOperation(op), ...attempt, timing: { ...attempt.timing } });
}
function errorMetadata(error) {
  const attempt = context.getStore()?.active; if (!attempt) return;
  const payload = error?.payload ?? error;
  const provider = payload?.response?.error ?? payload?.error ?? payload;
  const code = label(provider?.code ?? error?.code);
  if (code) attempt.providerErrorCode = code;
  if (["AbortError", "TimeoutError", "APIConnectionTimeoutError", "APIConnectionError", "CodexProtocolError", "WebSocketCloseError"].includes(error?.name)) attempt.failureClass = error.name;
  if (attempt.transport === "websocket" && number(error?.code) !== undefined) attempt.websocketCloseCode = error.code;
  const status = number(error?.status ?? payload?.status_code);
  if (status !== undefined) attempt.status = status;
  if (provider?.message === "Selected model is at capacity." || payload === "Selected model is at capacity.") attempt.capacityConfirmed = true;
  // Error messages/stacks/payloads are intentionally not persisted.
}
function settle(outcome, error) {
  const op = context.getStore(); const attempt = op?.active; if (!attempt) return;
  if (error) errorMetadata(error);
  attempt.runtimeOutcome ??= outcome;
  attempt.outcome = attempt.status >= 400 ? "failed" : attempt.outcome ?? outcome;
  attempt.timing.settledAt = Date.now();
  op.lastSettled = attempt;
  delete op.active; openAttempts.delete(attempt.attemptId);
  write({ type: "attempt_settled", ...publicOperation(op), attemptId: attempt.attemptId, receipt: attempt });
}
async function fetchObserved(fetch, url, init) {
  const op = context.getStore(); if (!op?.operationId || !path) return fetch.call(undefined, url, init);
  begin("http", url);
  try {
    const response = await fetch.call(undefined, url, init);
    op.active.status = response.status;
    op.active.providerRequestId = label(response.headers.get("x-request-id") ?? response.headers.get("request-id"));
    op.active.timing.headersAt = Date.now();
    if (!response.ok) {
      op.active.usageUnavailableReason = "http_error_body_not_observed";
      settle("failed");
    }
    return response;
  } catch (error) {
    if (op.active && init?.signal?.aborted) op.active.transportAbortCause = op.signal?.aborted ? "caller" : "sdk_abort_or_timeout";
    settle(op.signal?.aborted ? "cancelled" : "failed", error);
    throw error;
  }
}
async function connect(fn, url, headers, signal) {
  const op = context.getStore(); if (!op?.operationId || !path) return fn(url, headers, signal);
  const connectionId = nextId("connection"), startedAt = Date.now();
  openConnections.add(connectionId);
  const base = { ...publicOperation(op), connectionId, transport: "websocket", route: route(url), startedAt };
  write({ type: "transport_connection_started", ...base });
  try {
    const socket = await fn(url, headers, signal);
    openConnections.delete(connectionId);
    write({ type: "transport_connection_settled", ...base, settledAt: Date.now(), outcome: "connected" });
    return socket;
  } catch (error) {
    openConnections.delete(connectionId);
    write({ type: "transport_connection_settled", ...base, settledAt: Date.now(), outcome: signal?.aborted ? "cancelled" : "failed" });
    throw error;
  }
}
function usage(raw, api, terminal) {
  const attempt = context.getStore()?.active; if (!attempt || !raw || typeof raw !== "object") return;
  attempt.rawUsage.push(rawNumbers(raw));
  const responses = api === "responses";
  const totalInput = number(responses ? raw.input_tokens : raw.prompt_tokens);
  const output = number(responses ? raw.output_tokens : raw.completion_tokens);
  const details = responses ? raw.input_tokens_details : raw.prompt_tokens_details;
  const cached = number(details?.cached_tokens ?? (responses ? undefined : raw.prompt_cache_hit_tokens));
  const written = number(details?.cache_write_tokens);
  const combined = totalInput !== undefined && cached !== undefined ? totalInput - cached : undefined;
  const u = { inputTotal: totalInput, output, cacheRead: cached, cacheWrite: written,
    input: combined === undefined ? undefined : responses && written !== undefined ? combined - written : combined,
    totalTokens: number(raw.total_tokens) ?? (!responses && totalInput !== undefined && output !== undefined ? totalInput + output : undefined) };
  // This is CURRENT's public quantity convention, not a claimed ordinary/write split.
  // Responses `input` includes unreported writes. Their quantity remains unknown.
  if (responses && written === undefined && combined !== undefined) attempt.inputSemantics = "uncached_including_unknown_cache_write";
  else if (!responses && written !== undefined && cached !== undefined) u.cacheRead = cached - written;
  const reported = responses ? [raw.input_tokens, raw.output_tokens, raw.total_tokens, details?.cached_tokens, details?.cache_write_tokens]
    : [raw.prompt_tokens, raw.completion_tokens, raw.total_tokens, details?.cached_tokens, raw.prompt_cache_hit_tokens, details?.cache_write_tokens];
  let invalid = reported.some(x => x !== undefined && number(x) === undefined) || Object.values(u).some(x => x !== undefined && number(x) === undefined);
  const knownInput = [u.input, u.cacheRead, u.cacheWrite].filter(x => x !== undefined).reduce((a, b) => a + b, 0);
  if (u.inputTotal !== undefined && knownInput > u.inputTotal) invalid = true;
  if (u.totalTokens !== undefined && u.inputTotal !== undefined && u.output !== undefined && u.inputTotal + u.output > u.totalTokens) invalid = true;
  for (const [key, value] of Object.entries(u)) if (value !== undefined) attempt.usage[key] = number(value) ?? null;
  attempt.invalidUsage ||= invalid;
  attempt.usageCompleteness = !invalid && totalInput !== undefined && output !== undefined && terminal ? "complete" : "partial";
  attempt.aggregateUsageComplete = Object.values({ ...u, cacheWrite: written }).every(x => x !== undefined) && !invalid;
}
// Native parsers already read these errors. Enrich the same settled attempt, not a new request.
function parsedError(payload, source = "http_error") {
  const op = context.getStore(); const attempt = op?.active ?? op?.lastSettled;
  if (!attempt) return;
  context.run({ ...op, active: attempt }, () => {
    errorMetadata(payload);
    const raw = payload?.usage ?? payload?.error?.usage ?? payload?.response?.usage;
    if (raw) usage(raw, attempt.api === "openai-codex-responses" ? "responses" : "completions", true);
  });
  attempt.usageUnavailableReason = attempt.rawUsage.length ? undefined : `no_usage_in_native_parsed_${source}`;
  attempt.timing.metadataObservedAt = Date.now();
  if (source === "stream_error") { attempt.outcome = "failed"; attempt.timing.firstEventAt ??= Date.now(); }
  if (op.active !== attempt) write({ type: "attempt_settled", ...publicOperation(op), attemptId: attempt.attemptId, receipt: attempt });
}
function event(event) {
  const attempt = context.getStore()?.active; if (!attempt) return;
  const now = Date.now(); attempt.timing.firstEventAt ??= now; attempt.timing.lastEventAt = now;
  if ((typeof event?.delta === "string" && event.delta.length) || event?.type === "response.output_item.added" && event.item?.type === "function_call") attempt.timing.firstContentAt ??= now;
  const response = event?.response;
  if (response) {
    attempt.providerResponseId = label(response.id) ?? attempt.providerResponseId;
    attempt.responseModel = label(response.model) ?? attempt.responseModel;
    attempt.effectiveEffort = label(response.reasoning?.effort) ?? attempt.effectiveEffort;
    attempt.effectiveServiceTier = label(response.service_tier) ?? attempt.effectiveServiceTier;
    const terminal = ["response.done", "response.completed", "response.failed", "response.incomplete"].includes(event.type);
    if (response.usage) usage(response.usage, "responses", terminal);
    if (response.error) errorMetadata(response.error);
    if (terminal) attempt.outcome = response.status === "failed" ? "failed" : response.status === "cancelled" ? "cancelled" : "completed";
  } else if (event?.type === "error") { errorMetadata(event); attempt.outcome = "failed"; }
}
function chunk(chunk) {
  const attempt = context.getStore()?.active; if (!attempt || !chunk || typeof chunk !== "object") return;
  const now = Date.now(); attempt.timing.firstEventAt ??= now; attempt.timing.lastEventAt = now;
  attempt.providerResponseId = label(chunk.id) ?? attempt.providerResponseId;
  attempt.responseModel = label(chunk.model) ?? attempt.responseModel;
  attempt.effectiveServiceTier = label(chunk.service_tier) ?? attempt.effectiveServiceTier;
  const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
  const choice = choices[0];
  if (choice?.finish_reason) attempt.sawFinishReason = true;
  if (choice?.delta && (choice.delta.content || choice.delta.reasoning_content || choice.delta.reasoning || choice.delta.tool_calls?.length)) attempt.timing.firstContentAt ??= now;
  if (chunk.usage) usage(chunk.usage, "completions", choices.length === 0 || Boolean(choice?.finish_reason));
  else if (choice?.usage) usage(choice.usage, "completions", Boolean(choice.finish_reason));
}
function finish(output) {
  const op = context.getStore(); const attempt = op?.active; if (!attempt) return;
  if (attempt.invalidUsage) attempt.usageCompleteness = "partial";
  const runtimeOutcome = output.stopReason === "aborted" ? "cancelled" : output.stopReason === "error" ? "failed" : "completed";
  attempt.runtimeOutcome = runtimeOutcome;
  const terminalObserved = attempt.outcome !== undefined || attempt.sawFinishReason || attempt.usageCompleteness === "complete";
  settle(runtimeOutcome === "completed" && !terminalObserved ? "interrupted" : runtimeOutcome);
}
if (path) {
  write({ type: "accounting_opened", patchVersion: "prime-agent-0.9.4-cost-accounting-1", startedAt: Date.now(),
    coveredApis: ["openai-codex-responses", "openai-completions"], metadataOnly: true });
  process.on("exit", () => write({ type: "accounting_closed", settledAt: Date.now(), writeFailures,
    openAttemptIds: [...openAttempts], openOperationIds: [...openOperations], openConnectionIds: [...openConnections] }));
}
export const accounting = { operation, call, configure, begin, fetch: fetchObserved, connect, event, chunk, settle, finish, error: errorMetadata, parsedError };
