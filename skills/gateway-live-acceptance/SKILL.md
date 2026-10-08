---
name: gateway-live-acceptance
description: Run and document sanitized live acceptance for the Telegram/Web Codex gateway, including Web-only startup, browser/API security checks, agent flow, and regression gates.
---

# Gateway Live Acceptance

Use this skill when the user asks to perform, prepare, troubleshoot, or document
live acceptance of this repository's gateway. It is for real process/browser or
HTTP-client checks, not ordinary unit-test changes.

## Safety and evidence

- Treat `.env`, tokens, password hashes, cookies, CSRF values, private keys,
  provider URLs, repository paths, prompts, raw model output, and screenshots
  containing them as sensitive.
- Never print, commit, or place those values in acceptance notes. Record only
  sanitized statuses, endpoint classes, event types, counts, and durations.
- Use a disposable repository/runtime state for mutation tests when possible.
- Ask for explicit confirmation before using a real production endpoint,
  external issue write, real commit, or live model operation that can mutate
  user data. Read-only health and configuration checks may proceed in scope.
- If browser/mobile access is unavailable, distinguish host-level smoke from
  operator/browser acceptance; do not call the latter passed.

## Workflow

1. Read `docs/acceptance.md`, the relevant DEV task, `README.md`, and the
   deployment/security docs. Reconcile the requested matrix with existing
   automated coverage before starting a process.
2. Run preflight gates appropriate to the request: `npm run build`,
   `npm run typecheck`, `npm test`, and `npm run test:security`. If the runtime
   sandbox blocks child processes or sockets, report that as an environment
   deviation and use an approved host-level run where appropriate.
3. For Web-only acceptance, use explicit `TELEGRAM_ENABLED=false` and
   `WEB_ENABLED=true`. Verify that Telegram secrets are not required, the
   listener starts, `/health` is bounded, and `/` serves only local assets.
4. Verify security boundaries: exact Host/Origin behavior, security headers,
   body/method/content-type limits, login failure behavior, cookie attributes,
   CSRF rejection, logout, expiry/restart revocation, and SSE disconnect.
5. Verify the functional matrix through the authenticated adapter: project
   selection, displayed Codex-home basename, task/status/progress/result,
   question/answer, stop, Git read operations, test, and confirmation paths.
   Confirm that refresh/reconnect does not duplicate a mutation.
6. If Telegram is in scope, repeat the relevant legacy and simultaneous
   transport cells and check actor/project/event/confirmation isolation.
7. Stop all processes and clean disposable state. Update `docs/acceptance.md`
   with date, PASS/PARTIAL/FAIL/N/A, sanitized evidence, and deviations. Keep
   unresolved defects as separate tasks instead of silently weakening criteria.

## Reporting format

Report: environment/mode, automated gates, host smoke, browser/operator checks,
security checks, functional matrix, deviations/blockers, and exact next action.
Do not include secrets or raw response bodies beyond bounded public health data.
