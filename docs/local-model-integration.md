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
