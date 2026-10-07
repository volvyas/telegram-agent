# Local model integration report

Перевірено повторно: **2026-10-05** (`Europe/Kyiv`), після upgrade
llama.cpp і model. Попередній report вважається invalid і замінений цим
результатом. Секрети, приватні prompts і raw reasoning у звіт не записувалися.
Усі remote probes були bounded/read-only і не містили filesystem tools.

## Installed Codex surface

| Component | Version / result |
|---|---|
| `codex` CLI | `codex-cli 0.154.0` |
| `@openai/codex-sdk` | `0.154.0` |
| SDK constructor | `baseUrl`, `apiKey`, `config`, `configOverrides`, `env` |
| Thread options | `model`, working directory, sandbox/approval/network/web-search controls, additional directories |
| Resume | SDK exposes `resumeThread(id)` and repeated turns on a thread |
| Built-in local providers | CLI exposes `--oss --local-provider ollama` and `lmstudio` |
| Provider config keys | Installed CLI accepts `model_provider`, `model_providers.<id>`, `base_url`, `wire_api`, `env_key`; SDK `baseUrl` maps to `openai_base_url` |

The SDK has no typed provider configuration object. Gateway-owned validation must
therefore precede `config`/`configOverrides`; retries, stream retries and idle
timeouts were not exposed as typed SDK options.

## Upgraded llama.cpp probe

Endpoint: `http://192.168.1.179:8080`.

| Probe | Sanitized result | Interpretation |
|---|---|---|
| `GET /health` | `200`, status `ok` | Server reachable and healthy |
| `GET /v1/models` | `200`; `Qwen3.8-Flash-Next-UD-IQ1_S-00001-of-00003.gguf`, `llamacpp`, context `32768`, IQ1_S | Upgraded model discovered |
| `GET /version` | `404` | Dedicated version route is unavailable |
| `GET /props` | `200`; build `b11370-bed0a8566`, model alias/quantization/context available | Sanitized runtime version evidence; filesystem path omitted |
| Basic `POST /v1/responses` | `200`, `text/event-stream`, incremental events and terminal `response.completed` | Responses SSE works |
| Harmless function tool | `200`; structured `function_call`, argument deltas, completed call with `value: 7` | Function calling works |
| `previous_response_id` continuation | `400`: server does not support `previous_response_id` | Server-side response references are unavailable |
| Full-history tool-result continuation | `200`; supplied `function_call_output` was accepted and next output was `CONTINUED` with incremental text deltas | Stateless conversation continuation works |

The function was never executed; the probe only validated the model-emitted
structured call. The continuation resent the bounded prior input, function call,
tool result and next user turn in one request. No response IDs are recorded.

The model emitted reasoning events during probes. Raw reasoning is intentionally
excluded from this report; the integration must not forward it to Telegram or
logs. `enable_thinking:false` did not prevent reasoning events in this
deployment, so the adapter should treat reasoning as non-user-visible data.

### Compatibility decision

After the upgrade, the endpoint passes the required bounded Responses flow:
endpoint discovery, streaming, terminal completion, structured function calls,
tool-result handling and a following turn using full input history. It is
compatible as a **stateless generic Responses provider**, subject to the
integration preserving conversation history.

It does not implement the optional/server-side `previous_response_id` mechanism.
The gateway must not assume response IDs can replace its own bounded session
history. It must also not silently fall back to `/v1/chat/completions`.

The dedicated `/version` route remains unavailable, but `/props` now exposes
build `b11370-bed0a8566`. The model identity and runtime properties above are
the complete sanitized version evidence exposed by this deployment.

## Offline SDK/CLI contract test

DEV-070 adds a deterministic local HTTP fake Responses server. The test runs the
installed `@openai/codex-sdk` 0.154.0 and its bundled CLI against that server in
a temporary Git repository, then verifies a streamed new turn, model and tools
propagation, terminal completion, and resume of the generated thread. The
temporary repository remains clean and the test does not require Ollama,
LM Studio, or `llama.cpp`. Adapter/mapper tests additionally cover command and
file events, stop/cancellation, interrupted streams, malformed events, and safe
redaction of credentials, thread/path identifiers, and reasoning text.

## Provider capability matrix

| Provider / mode | Standard endpoint | Explicit `baseUrl` / generic Responses | Streaming | Tools | Continuation | Auth |
|---|---|---|---|---|---|---|
| OpenAI Codex built-in | Supported by installed Codex provider | Not needed | Codex-managed | Codex-managed | Codex-managed | Codex-managed auth/environment |
| Ollama built-in | CLI `--oss --local-provider ollama` | Provider configuration supports explicit base URL; no live Ollama host was supplied | Deployment-dependent | Deployment-dependent | Deployment-dependent | Environment-key auth; no inline token |
| LM Studio built-in | CLI `--oss --local-provider lmstudio` | Provider configuration supports explicit base URL; no live LM Studio host was supplied | Deployment-dependent | Deployment-dependent | Deployment-dependent | Environment-key auth; no inline token |
| Upgraded remote llama.cpp | N/A as built-in | **Pass** as stateless generic Responses provider | Pass | Pass | Pass with full history; `previous_response_id` unsupported | No auth required by supplied private endpoint; generic provider still supports optional environment-key auth |

“Supported” for Ollama and LM Studio means the installed CLI exposes both
deployment modes; no unprovided local service was contacted. Their live protocol
capabilities remain deployment-specific.

## Follow-up

No compatibility proxy is required for the upgraded endpoint. DEV-065-PROXY
remains unnecessary unless a future operator endpoint lacks the same structured
tool and full-history continuation behavior. Any proxy must remain an explicit
provider and never become an implicit Chat Completions fallback.

## Opt-in HTTP diagnostics

See also the [context-budget investigation](#dev-085-context-budget-and-native-compaction)
for the context exhaustion identified by the captured tool-call traces.

Gateway logs cannot capture provider HTTP traffic sent by the Codex subprocess.
Use the separate loopback-only tracing proxy for a bounded diagnostic session:

```bash
PROVIDER_LOG_UPSTREAM=http://192.168.1.179:8080/v1 \
  npm run log:provider
```

Temporarily change only the target generic Responses provider's `baseUrl` in
`projects.json` to `http://127.0.0.1:8081/v1`, then restart the gateway to load
the configuration. Keep the model, provider ID and `apiKeyEnv` unchanged.
This does not intercept built-in providers or other providers. The proxy must
run in the same network namespace as Codex (container loopback is separate).

By default it writes **metadata only**: unique request ID, timestamp, duration,
route, HTTP status, transfer outcome, byte counts and SHA-256 digests. It never
records headers (including Authorization/Cookie), URL queries or raw transport
error messages. Credentials are forwarded to the fixed upstream, not logged.
Redirects are passed through, not followed by the proxy. Only `GET /v1/models`,
`POST /v1/responses` and `POST /v1/responses/compact` are accepted.

For the invalid tool-arguments JSON investigation, explicitly enable bodies:

```bash
PROVIDER_LOG_UPSTREAM=http://192.168.1.179:8080/v1 \
  PROVIDER_LOG_BODIES=1 npm run log:provider
```

**Sensitive diagnostic mode:** bodies can contain repository code, prompts,
tool output, reasoning and secrets embedded in content. There is deliberately
no body redaction/re-serialization: it would destroy the escaping evidence.
Do not upload raw traces or enable this for normal production operation.
Header credentials are excluded, but secrets inside bodies are not filtered.
Any local process can access the loopback listener; use only on a trusted host.

Each run creates `logs/provider/provider-trace-*` (directory mode `0700`),
containing per-request `<id>.json` and optional `<id>.request.body` /
`<id>.response.body` files (mode `0600`). Response files preserve HTTP body
bytes, including SSE; HTTP chunk framing is not recorded. Streams are forwarded
incrementally with backpressure, without parsing JSON or rewriting escaping.
Capture files are written after transfer completion or failure, not continuously;
a forced process kill can lose an in-flight trace.

Limits are configurable via environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `PROVIDER_LOG_PORT` | `8081` | Listener bound exclusively to `127.0.0.1` |
| `PROVIDER_LOG_DIR` | `logs/provider` | Parent directory for unique trace sessions |
| `PROVIDER_LOG_MAX_BODY_BYTES` | `2097152` | Capture cap per request/response body; forwarding is not capped |
| `PROVIDER_LOG_MAX_REQUESTS` | `100` | Accepted requests per session; further requests get HTTP 503 |

Each transfer has a five-minute deadline. Default body capture consumes at most
400 MiB per session plus metadata; concurrent captures also consume memory.
There is no automatic retention across sessions: remove sensitive traces when
the investigation is finished. `logs/` is gitignored, but is not a secret vault.
Check `captureBodies`, `truncated` and `outcome` before interpreting an apparent
cut-off as a provider problem; metadata-only captures store zero body bytes.
A logging-write failure emits a generic console warning without changing the
provider response. HTTP 500 with a fully transferred body has outcome `complete`;
this describes transfer completion, not model success.

Reproduce one task, then correlate the HTTP 500 response with its request using
the filename ID. Inspect whether the malformed arguments were already present
in request history or first appeared in the response. A server exception alone
may still require server-side pre-parser output and generation stop-reason logs.
Restore the original provider `baseUrl` and restart the gateway **before**
stopping the proxy. The command does not edit `projects.json` automatically.

## DEV-085 context budget and native compaction

Offline implementation started **2026-10-07**; real llama.cpp acceptance is
pending. OpenAI Docs was used to select the documented
[`model_context_window` and `model_auto_compact_token_limit` settings](https://developers.openai.com/codex/config-reference/),
then the installed SDK/CLI behavior was verified against a loopback fake server.
No model server or cloud inference was contacted for these tests.

Set this inside the target project's `agent` alongside `provider` and `model`:

```json
"context": {
  "windowTokens": 32768,
  "outputReserveTokens": 4096,
  "safetyMarginTokens": 2048
}
```

All three values are required positive safe integers; reserves must leave a
positive input budget. Unknown settings are rejected. The resolver passes
`model_context_window = windowTokens` and
`model_auto_compact_token_limit = min(windowTokens - outputReserveTokens - safetyMarginTokens, floor(windowTokens * 0.9))`
at the top level of the per-client Codex config (26624 for this example).
The budget is scoped to the project/provider/model, not a global 32k default.
Changing it requires a gateway restart. Existing sessions can resume with the
new settings; provider/model identity isolation is unchanged. Production
`projects.json` has not been modified by this implementation.

Observed with the installed CLI through the real SDK, not just a mocked SDK:

- At below-threshold reported usage, continuation sends the existing history.
- Above-threshold usage triggers a tool-free summarization request to the same
  custom provider's `/v1/responses`, then ordinary generation with that summary.
  `/v1/responses/compact` is not required for this tested custom-provider path.
- This works after recreating the adapter/resuming the thread and mid-turn
  after a tool result. Compaction receives matching tool-call/result pairs;
  the returned summary is present in subsequent requests and persists on resume.
- Nearly all input tokens were marked cached in the resume fixture: caching
  does not prevent the context threshold from triggering.
- Failed summarization has bounded native retries and fails the turn without
  proceeding to ordinary generation. Stop during pending compaction produces
  STOPPED, not completed. DEV-084's separate retry-event classification defect
  is unchanged; transient retries may still produce premature gateway failure.

Limits and remaining work:

- Reserves lower the compaction trigger; they do **not** set `max_output_tokens`.
  Native estimates/model metadata and provider `usage` drive compaction. There
  is no gateway tokenizer counting raw HTTP payloads, no subtraction of cached
  tokens, and no byte-to-token conversion presented as exact.
- The request includes instructions, schemas, history and runtime additions.
  A huge fresh prompt, a single large tool result or a very long generation can
  still outrun the reserve. Hard preflight protection for those cases and an
  actionable context-specific failure diagnostic remain open under DEV-085;
  the current change must not be advertised as a hard context safety boundary.
- The mock supplies a known summary; tests prove transport, threshold triggering
  and persistence, not that the real model preserves every user constraint.
- After an actual FAILED session, the existing manager starts the next task in
  a fresh thread. Submit a smaller task with an explicit summary of constraints
  and completed work; inspect changes before retrying side-effecting work. No
  automatic provider switch, history-file edits or command replay is added.

Live acceptance when the server is available:

1. Confirm the effective per-slot context in llama.cpp and the exact model ID;
   do not infer context capacity from GGUF name or an advertised maximum.
2. Use a disposable repository and isolated Codex home. Configure the budget
   for that effective context, leaving reserve for reasoning/output and the
   compaction request itself. Do not resume the already-corrupted trace thread.
3. Grow harmless conversation/tool output across the threshold. Record only
   sanitized request counts, token usage and terminal event types. Confirm a
   tool-free compaction request and reduced subsequent history without a 500.
4. Check retained constraints, matching tool results, follow-up and restart
   resume; test cancellation and controlled compaction failure. Separately
   cover a large single input/result and leave any unsupported case explicit.
5. Keep DEV-085 open until remaining safeguards and live criteria pass. The
   incomplete-tool-call problem in DEV-086 is not solved by early compaction.
