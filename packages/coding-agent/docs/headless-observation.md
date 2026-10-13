# Completion waits and generated status

## Completion deadlines

RPC `wait_for_completion` accepts an optional `timeoutMs`. The value must be finite and nonnegative. Omit it to keep the existing unbounded completion wait.

```json
{"id":"completion-1","type":"wait_for_completion","timeoutMs":30000}
```

Check `get_state.data.capabilities` for `completion_wait_diagnostics` before sending `timeoutMs`. A successful response keeps the existing shape. A deadline returns an error with bounded blocker details:

```json
{"id":"completion-1","type":"response","command":"wait_for_completion","success":false,"error":"Completion wait timed out","errorInfo":{"code":"completion_wait_timeout","complete":false,"elapsedMs":30001,"blockers":[{"kind":"parked_watches","count":1}]}}
```

Blocker kinds describe current owned work, not a completion verdict. `elapsedMs` is the observed wait duration, including RPC prompt admission, supervisor readiness and ownership checks, worker routing, and worker admission. Admission waits report `supervisor_admission`, `worker_routing`, or `worker_admission` rather than guessing at session work. A timeout stops only this wait. It does not abort the model, children, kernels, or watched jobs. Required reports and ordinary events still arrive. Another completion request can wait again. Closing RPC stdin still uses the normal completion barrier before exit.

A timed daemon wait allows up to one extra second for the response to arrive after its observation deadline. One caller-side deadline includes the transport handshake and response wait; routing does not add a new full budget. If no response arrives, diagnostics report `supervisor_response` or `worker_response` and the actual elapsed time, not guessed child or session state. Local response listeners and timers are removed without closing the shared transport or cancelling session work. The supervisor also cancels its worker observation when the negotiated peer supports cancellation. Local timeout alone does not prove remote settlement.

A transport disconnect ends timed and untimed completion observations. They are not replayed automatically after reconnect; another explicit completion request can wait again.

The daemon connection API also accepts `waitForHeadlessCompletion({waitForRlmQuiescence: true, timeoutMs: 30000})`. Daemon clients negotiate the optional `completion_wait_diagnostics` capability. Older daemons still support their previous untimed waits; a deadline request fails locally when this capability is absent. No startup or attachment depends on deadline support.

## Generated status summaries

Set `statusSummaries` in `~/.base-context/settings.json` or the project's `.base-context/settings.json`:

```json
{"statusSummaries":"observed"}
```

- `always` is the default. It keeps the existing background generation policy.
- `observed` generates recaps while an agents roster consumer is subscribed. A headless session attachment alone is not an observer.
- `off` disables generated recaps.

The setting controls only recap inference. Local activity, errors, child results, and required reports remain available. In `observed` mode, the last observer leaving cancels pending recap timers and in-flight recap inference. A later observer can request a fresh recap. In `observed` and `off` modes, a missing optional recap does not hold activity at `working`.

Observer interest uses the optional daemon `status_summary_interest` capability. Missing support does not block startup or attachment. Model requests that were already admitted retain their normal native-control usage accounting.

## Worker startup failures

Server-side worker startup failures include the last observed admission, spawn, handshake, or session-open phase and its timestamp. The original error type, cause, and structured classification stay unchanged. Process-close logs also retain the observed exit code and signal.

A client-only create timeout reports `lastStartupPhase: unknown` when no server evidence arrived. These diagnostics do not identify the cause of historical load failures and do not retry uncertain create commands.

For opt-in compact JSON streaming, see [JSON mode](json.md). Default JSON events are unchanged.
