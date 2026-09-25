# Security review and threat model

Статус: reviewed for MVP, 2026-09-24. Цей документ описує локальний Telegram
gateway у поточній реалізації. Він не є обіцянкою ізоляції від користувача ОС,
який уже має ті самі права доступу, що й service user.

## Assets and trust boundaries

Захищаються Telegram bot token, Codex credentials, thread/session identifiers,
configured repository contents, runtime state, diffs і command output. Довірені
inputs: локальні `.env`, `projects.json`, executable/args у project config та
service-user environment. Недовірені inputs: Telegram updates, prompts,
answers, callback payloads, Codex output і stdout/stderr дочірніх процесів.

Основні межі довіри:

```text
Telegram update -> AuthGuard -> bounded handlers -> application services
user text -> SDK input (never a command/path)
trusted project config -> canonical repository / executable + argv
application -> Codex workspace-write sandbox or ProcessRunner(shell=false)
runtime data -> private atomic JSON storage / private temporary upload
```

Аудит process inventory підтвердив один application-level `spawn`, інкапсульований
у `ProcessRunner`. `GitService` і `ProjectCommandRunner` проходять через нього;
Codex запускається pinned SDK adapter. Deployment shell script приймає лише
service user і Node path, валідує їх та передає зовнішнім командам quoted argv.

## Threats and controls

| Threat | Control | Regression evidence |
| --- | --- | --- |
| Shell injection through prompts, commit messages or command arguments | `spawn` receives executable and argv separately with `shell: false`; configured commands are structured and user text is never substituted | `ProcessRunner.test.ts`, `SecurityRegression.test.ts`, `GitService.test.ts` |
| Repository escape through relative paths, subdirectories or symlinks | startup requires an absolute path, resolves it with `realpath`, verifies it equals Git's top level and rejects duplicate canonical roots; runtime handlers use only the resulting `ProjectConfig.path` | `ProjectManager.test.ts`, `SessionManager.test.ts`, commit regression |
| Codex writes outside the selected repository | adapter uses the canonical project path, `workspace-write`, approval `never`, network/search disabled and no additional directories | `CodexAdapter.test.ts` |
| Forged or replayed callbacks | whitelist middleware is registered first; callback formats are bounded; confirmations are opaque, expiring, one-shot and bound to user plus project; dashboard/answer callbacks are resolved server-side | `AuthGuard.test.ts`, `ConfirmationHandler.test.ts`, `DashboardKeyboard.test.ts`, security suite |
| Cross-project session/thread confusion | session records are keyed by project and include the canonical path; mismatched project IDs, paths and resumed thread IDs are rejected; active-operation locks are per project | `SessionManager.test.ts`, `AgentManagerPersistence.test.ts`, `CodexAdapter.test.ts` |
| Secret/path disclosure in logs and Telegram errors | structured logs redact configured secrets, credential/session keys and path-shaped fields; Telegram receives generic messages with diagnostic IDs and no raw causes/stacks | `StructuredLogger.test.ts`, `SecurityRegression.test.ts`, Telegram handler tests |
| Runtime-state or temporary-output disclosure | data directory/state are forced to `0700`/`0600`; symlink storage endpoints and escaping filenames are rejected; upload directories/files use `0700`/`0600` and are removed in `finally` | `JsonStorage.test.ts`, `MessageSender.test.ts`, security suite |
| Environment credential leakage | child processes receive explicit allowlists; Codex receives a bounded allowlist plus the configured `CODEX_HOME` only | `ProcessRunner.test.ts`, `CodexAdapter.test.ts` |
| Unbounded output or abandoned child processes | captured output is bounded; timeouts/abort terminate the POSIX process group; Telegram output is chunked or sent as an ephemeral document | process and message-sender tests |

## Repository policy

Telegram users can select only configured project IDs. They cannot supply a
working directory, executable, command arguments or additional writable path.
Git status/diff/commit and configured test commands receive the canonical path
from the selected `ProjectConfig`. A configured executable such as `/bin/sh`, or
arguments that deliberately access another directory, are an explicit operator
policy decision in trusted `projects.json`; the gateway does not reinterpret
them as user input.

Project-root symlinks are accepted only by resolving and storing their canonical
target. A symlink to a repository subdirectory does not widen access to its Git
root and is rejected. Replacing files after startup remains protected primarily
by Unix ownership: the gateway must run as a dedicated non-root user, and
repository/config directories must not be writable by untrusted local users.

## Authorization and session model

Every Telegram update, including callback queries, crosses `AuthGuard` before a
router. Active project choice is isolated by Telegram user ID. Codex conversation
state is intentionally one thread per project (not one per Telegram user), with
at most one active operation per project. A pending question records the user
that initiated it, so another whitelisted user cannot answer it. Operators who
need user-to-user conversation isolation must configure separate repositories
as separate projects or deploy separate gateway instances.

## Deployment assumptions and residual risk

- Run as a dedicated, non-root OS user; keep `.env`, `projects.json`, data and
  `CODEX_HOME` owned by that user with restrictive permissions.
- Telegram and Codex API traffic still depends on their upstream services and
  TLS/network stack. Network is disabled only for the Codex workspace turn, not
  for the gateway's Telegram transport or Codex API communication.
- `workspace-write` is the strongest application-requested SDK sandbox in this
  design, but OS-level isolation remains defense in depth. The supplied systemd
  unit adds `NoNewPrivileges`, `PrivateTmp` and `UMask=0077`.
- A compromised service user can read its credentials and repositories; this
  application does not claim to defend against that actor.
- Git hooks run during an approved commit with service-user permissions. Hooks
  are repository/operator-controlled code, so repositories must be trusted.

## Verification

Run the focused suite with `npm run test:security`. Release verification remains
`npm run lint && npm run typecheck && npm test && npm run build`. Re-run this
review when adding a new process call, writable directory, callback kind,
external integration, operation policy or persistence backend.
