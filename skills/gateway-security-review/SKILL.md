---
name: gateway-security-review
description: Review the Telegram/Web Codex gateway for transport, authentication, authorization, data-isolation, process, and secret-leakage risks with focused regression evidence.
---

# Gateway Security Review

Use this skill when reviewing or hardening security-sensitive gateway changes,
especially Web routes, transport composition, confirmations, actor ownership,
process execution, storage, credentials, or deployment configuration.

## Review boundaries

- Start read-only. Inspect source, configuration schemas, tests, deployment
  assets, and route inventory before editing anything.
- Do not access or print secret values. Redact `.env`, tokens, cookies, password
  hashes, private keys, provider credentials, raw prompts, and repository paths.
- Do not probe external hosts, mutate Git/GitHub/issue state, run production
  operations, or create real confirmations without explicit user authorization.
- Treat model output, Git output, issue content, browser input, callbacks, and
  proxy headers as untrusted.

## Review workflow

1. Map trust boundaries and assets: browser/Telegram, WebServer, auth/session,
   actor context, application use cases, AgentEventHub/SSE, project config,
   ProcessRunner/Codex, Git/issue providers, and JsonStorage.
2. Inventory every Web route and transport lifecycle path. For each state
   change, verify authentication, actor/project authorization, CSRF and Origin
   checks, policy/lock enforcement, confirmation/fresh-auth requirements, and
   safe error behavior.
3. Check Web deployment invariants: production HTTPS, direct certificate/key
   validation and permissions, reverse-proxy loopback/Unix boundary, exact
   Host/public URL, no arbitrary forwarded headers, HSTS, CSP, no-store,
   clickjacking/referrer/permissions headers, and bounded methods/types/body/
   headers/timeouts/connections.
4. Check session/credential handling: opaque process-local IDs, rotation,
   idle/absolute expiry, bounded cleanup, logout/restart revocation, CSRF token
   binding, password-verifier algorithm/parameters, rate limits, and absence
   from browser assets, logs, storage, diagnostics, and errors.
5. Check isolation: canonical actor IDs, security-context binding, project
   selection, event-hub filtering, SSE subscriber cleanup, confirmation payload
   hashes, cross-project/cross-actor reads, and no client-supplied actor,
   path, command, provider, or unrestricted URL.
6. Check process/storage boundaries: structured argv with `shell:false`, output
   limits, timeouts/abort cleanup, private storage permissions, migrations,
   symlink/path validation, and graceful shutdown without leaked listeners,
   locks, subscribers, or child processes.
7. Run focused tests and relevant gates. Distinguish real failures from
   sandbox/network limitations and preserve reproducible evidence.

## Findings format

For each finding include severity, affected route/component, exploit or failure
condition, concrete evidence, recommended fix, and regression test. Also state
what was checked and passed. Never include secret material or unrestricted raw
output in the report.
