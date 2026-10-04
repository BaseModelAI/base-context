#!/usr/bin/env node
/** Offline measurements only. Never starts an agent or modifies a session. */
import { readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const usageKeys = ["input", "inputTotal", "output", "cacheRead", "cacheWrite", "totalTokens"];
const timeKeys = ["queuedAt", "admittedAt", "sentAt", "firstEventAt", "firstContentAt", "lastEventAt", "settledAt"];
const number = (value) => typeof value === "number" && Number.isFinite(value) ? value : null;
const text = (value) => typeof value === "string" ? value : null;
const numbers = (value, keys) => Object.fromEntries(keys.map((key) => [key, number(value?.[key])]));
const sessionName = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;
const providerErrorKinds = new Set([
  "transport", "overloaded", "rate_limit", "server_error", "auth", "invalid_request", "malformed_response",
]);

export async function collect(sessionDir, SessionManager, version) {
  const sources = [], issues = [], attempts = new Map();
  const providerDiagnostics = [], seenDiagnostics = new Set();
  const scannedSessions = new Set(), scannedChildren = new Set();
  const pending = [{ kind: "sessions", path: sessionDir, required: true }];
  let requestEntries = 0, missingAttemptIds = 0;
  while (pending.length) {
    const job = pending.shift();
    const scanned = job.kind === "sessions" ? scannedSessions : scannedChildren;
    if (scanned.has(job.path)) continue;
    scanned.add(job.path);
    let entries;
    try { entries = await readdir(job.path, { withFileTypes: true }); }
    catch (error) {
      if (error.code !== "ENOENT" || job.required)
        issues.push({ path: job.path, kind: "directory_unavailable", code: text(error.code) });
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    if (job.kind === "children") {
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.startsWith("sub-"))
          pending.push({ kind: "sessions", path: join(job.path, entry.name), required: true, child: true });
      }
      continue;
    }
    const files = entries.filter((entry) => entry.isFile() && sessionName.test(entry.name));
    if (job.child && files.length === 0)
      issues.push({ path: job.path, kind: "child_session_missing" });
    // Children can place grandchildren directly in their own RLM session directory.
    pending.push({ kind: "children", path: job.path });
    for (const file of files) {
      const path = join(job.path, file.name);
      let manager;
      try {
        manager = await SessionManager.openReadOnly(path);
        const header = manager.getHeader();
        const artifactDir = manager.getSessionArtifactDir();
        const source = {
          session_file: path, session_id: text(header?.id),
          parent_session_file: text(header?.parentSession), rlm_depth: number(header?.rlmDepth),
          role: header?.parentSession || (header?.rlmDepth ?? 0) > 0 ? "child" : "root",
          artifact_dir: artifactDir ?? null, request_entries: 0,
          last_assistant_stop_reason: null, provider_error_observed: false,
        };
        sources.push(source);
        if (artifactDir) pending.push({ kind: "children", path: artifactDir });
        for (const entry of manager.getEntries()) {
          // Do not inspect or emit message content, reasoning, prompts or tool output.
          if (entry.type === "message" && entry.message?.role === "assistant") {
            const message = entry.message;
            source.last_assistant_stop_reason = text(message.stopReason);
            const diagnostics = Array.isArray(message.diagnostics) ? message.diagnostics : [];
            const lifecycleFailure = diagnostics.some((item) => item.type === "agent_lifecycle_failure");
            for (const [index, diagnostic] of diagnostics.entries()) {
              if (diagnostic.type !== "provider_stream_failure") continue;
              const kind = text(diagnostic.details?.kind);
              // Published OpenAI SDK timeouts can retain a typed provider diagnostic
              // while its generic Error has no status/code and native kind is unknown.
              const sdkTimeout = kind === "unknown" && diagnostic.error?.name === "Error" &&
                diagnostic.error?.message === "Request timed out.";
              const positive = message.stopReason === "error" && !lifecycleFailure &&
                (providerErrorKinds.has(kind) || sdkTimeout);
              source.provider_error_observed ||= positive;
              const key = `${source.session_id}:${entry.id}:${index}`;
              if (seenDiagnostics.has(key)) continue;
              seenDiagnostics.add(key);
              providerDiagnostics.push({
                session_id: source.session_id, entry_id: text(entry.id),
                timestamp: number(diagnostic.timestamp), kind,
                http_status: number(diagnostic.details?.status),
                provider_error_type: text(diagnostic.details?.providerErrorType),
                error_code: text(diagnostic.error?.code) ?? number(diagnostic.error?.code),
                stop_reason: text(message.stopReason), lifecycle_failure: lifecycleFailure,
                positive_provider_error: positive,
                classification_basis: positive ? (sdkTimeout ? "native_provider_timeout_diagnostic" : "native_provider_kind") : null,
              });
            }
          }
          if (entry.type !== "request") continue;
          const request = entry.request;
          if (request?.type === "attempt_settled" && (request.receipt?.capacityConfirmed === true ||
              (number(request.receipt?.status) !== null && request.receipt.status >= 400)))
            source.provider_error_observed = true;
          source.request_entries++;
          requestEntries++;
          if (!request || !["attempt_admitted", "attempt_settled"].includes(request.type)) {
            issues.push({ path, kind: "unknown_request_record" });
            continue;
          }
          const id = text(request.attemptId);
          if (!id) {
            missingAttemptIds++;
            continue;
          }
          let record = attempts.get(id);
          if (!record) {
            record = { id, admitted: null, settled: null, source, files: new Set(), copies: 0 };
            attempts.set(id, record);
          }
          record.files.add(path);
          const slot = request.type === "attempt_admitted" ? "admitted" : "settled";
          if (record[slot]) record.copies++;
          else record[slot] = request;
        }
      } catch (error) {
        // Native decoder diagnostics can contain source text; never echo error.message/stack.
        issues.push({ path, kind: "session_unavailable", code: text(error.code), error_type: text(error.name) });
      } finally {
        if (manager) {
          try { await manager.close(); }
          catch (error) { issues.push({ path, kind: "reader_close_failed", code: text(error.code) }); }
        }
      }
    }
  }
  const rows = [...attempts.values()].map(({ id, admitted, settled, source, files, copies }) => {
    const request = settled ?? admitted;
    const receipt = settled?.receipt;
    const descriptor = admitted?.descriptor;
    const contract = request.modelContract;
    const usage = numbers(receipt?.usage, usageKeys);
    const missing = [];
    if (!admitted) missing.push("admission");
    if (!settled) missing.push("settlement");
    for (const key of usageKeys) if (usage[key] === null) missing.push(`usage.${key}`);
    const requestedEffort = text(descriptor?.effort ?? receipt?.effort);
    const effectiveEffort = text(receipt?.effectiveEffort);
    if (requestedEffort === null) missing.push("requested_effort");
    if (effectiveEffort === null) missing.push("effective_effort");
    return {
      attempt_id: id, operation_id: text(request.operationId),
      source_session_id: text(request.source?.sessionId) ?? source.session_id,
      owner_session_id: text(request.owner?.sessionId),
      parent_session_id: text(request.owner?.parentSessionId), root_session_id: text(request.owner?.rootSessionId),
      source_files: [...files].sort(), role: source.role,
      purpose: text(request.purpose), purpose_detail: text(request.purposeDetail),
      provider: text(receipt?.provider ?? descriptor?.provider ?? contract?.provider),
      api: text(receipt?.api ?? descriptor?.api ?? contract?.api),
      model: text(receipt?.model ?? descriptor?.model ?? contract?.model),
      response_model: text(receipt?.responseModel),
      requested_effort: requestedEffort, effective_effort: effectiveEffort,
      transport: text(receipt?.transport ?? descriptor?.transport),
      attempt_kind: text(receipt?.kind ?? descriptor?.kind),
      ordinal: number(receipt?.ordinal ?? descriptor?.ordinal),
      outcome: text(receipt?.outcome), http_status: number(receipt?.status),
      provider_error_observed: receipt?.capacityConfirmed === true ||
        (number(receipt?.status) !== null && receipt.status >= 400),
      capacity_confirmed: receipt?.capacityConfirmed === true ? true : null,
      admission_timestamp: number(admitted?.timestamp), settlement_timestamp: number(settled?.timestamp),
      timing: numbers(receipt?.timing, timeKeys), usage,
      usage_completeness: text(receipt?.usageCompleteness),
      admission_observed: !!admitted, settlement_observed: !!settled,
      duplicate_records: copies, missing,
    };
  });
  const readsComplete = issues.length === 0 && missingAttemptIds === 0;
  const totals = Object.fromEntries(usageKeys.map((key) => {
    const observed = rows.filter((row) => row.usage[key] !== null);
    const known = observed.length ? observed.reduce((sum, row) => sum + row.usage[key], 0) : null;
    const complete = rows.length > 0 && observed.length === rows.length && readsComplete;
    return [key, { value: complete ? known : null, known_subtotal: known,
      observed_attempts: observed.length, missing_attempts: rows.length - observed.length, complete }];
  }));
  return {
    schema: "published-base-context-usage/v1", product: "@ponythewhite/base-context", version,
    session_dir: sessionDir, sources, attempts: rows, totals,
    provider_diagnostics: providerDiagnostics,
    provider_error_observed: rows.some((row) => row.provider_error_observed) ||
      providerDiagnostics.some((item) => item.positive_provider_error),
    coverage: {
      provider_diagnostic_scope: "typed assistant diagnostics and native attempt receipt statuses only",
      unclassified_provider_diagnostics: providerDiagnostics.filter((item) => !item.positive_provider_error).length,
      source_scope: "discovered native sessions and their saved child directories",
      family_scope_complete: null, task_completion: null,
      read_complete: readsComplete, empty: sources.length === 0,
      source_count: sources.length, request_entries: requestEntries,
      captured_attempt_count: rows.length, missing_attempt_ids: missingAttemptIds,
      unsettled_attempts: rows.filter((row) => !row.settlement_observed).length,
      settlements_without_admission: rows.filter((row) => !row.admission_observed).length,
      duplicate_records: rows.reduce((sum, row) => sum + row.duplicate_records, 0),
      usage_complete: rows.length > 0 && readsComplete && rows.every((row) =>
        row.settlement_observed && row.usage_completeness === "complete" &&
        usageKeys.every((key) => row.usage[key] !== null)),
    },
    issues,
  };
}

export async function main(SessionManager, version, args = process.argv.slice(2)) {
  try {
    if (args.length !== 4 || args[0] !== "--session-dir" || args[2] !== "--out")
      throw new Error("Usage: node collect_base_usage.mjs --session-dir PATH --out PATH");
    const result = await collect(resolve(args[1]), SessionManager, version);
    await writeFile(resolve(args[3]), JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ out: resolve(args[3]), sources: result.sources.length,
      attempts: result.attempts.length, read_complete: result.coverage.read_complete }));
  } catch (error) {
    console.error(JSON.stringify({ error: "collection_failed", type: text(error.name), code: text(error.code) }));
    process.exitCode = 1;
  }
}
