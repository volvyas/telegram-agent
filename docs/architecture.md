# Remote Codex Agent Gateway — architecture

Статус: **Accepted for MVP**, 2026-08-26; SDK pin оновлено 2026-08-27.

Документ фіксує рішення Phase 0 на основі `design.md`, локального аудиту та
фактично доступного Codex API. Деталі Codex capability і обмеження описані в
[`codex-integration.md`](./codex-integration.md), середовище — в
[`environment.md`](./environment.md).

## Архітектурні принципи

1. Telegram — transport/UI, а не власник agent lifecycle.
2. `AgentManager` працює лише з application interface `CodingAgent`.
3. `CodexAdapter` — єдине місце, що знає про `@openai/codex-sdk`.
4. Project path і дозволені commands походять тільки з validated config.
5. Один project має один Codex thread і максимум одну active operation.
6. Різні projects ізольовані за path, session, state, locks та history.
7. User input ніколи не стає shell command або path.
8. Persisted state записується через storage interface.
9. Безпека визначається technical sandbox/policy, а не лише prompt rules.

## Context diagram

```text
Telegram user
     │ Bot API updates / callbacks
     ▼
TelegramBot ── AuthGuard ── Command/Callback handlers
                               │
                               ▼
                         Application services
             ┌─────────────────┼──────────────────┐
             ▼                 ▼                  ▼
       ProjectManager     AgentManager       Git/Command services
                               │                  │
                               ▼                  ▼
                         CodingAgent         ProcessRunner
                               │
                               ▼
                         CodexAdapter
                               │ official TypeScript SDK
                               ▼
                         local Codex CLI
                               │ sandboxed cwd
                               ▼
                      configured Git repository

Application services ── Storage interface ── JsonStorage ── data/state.json
```

IntelliJ не є компонентом runtime. Воно просто бачить зміни в тих самих
repository directories.

## Runtime composition

`Application` є composition root і створює компоненти в такому порядку:

1. `ConfigLoader` → `AppConfig` і validated `ProjectConfig[]`;
2. `JsonStorage`;
3. `ProjectManager`, `SessionManager`, `TaskManager`;
4. `CodexAdapter`;
5. `AgentManager`;
6. `GitService`, `ProjectCommandRunner`, `ConfirmationService` за фазами;
7. Telegram handlers/router;
8. `TelegramBot` long polling.

SIGINT/SIGTERM зупиняють приймання updates, abort-ять active turns, flush-ять
storage/logs і завершують process без створення нових operations.

## Головні контракти

Контракти нижче — architecture baseline, не готовий production code.

```ts
interface CodingAgent {
  startTurn(input: StartAgentTurn): AsyncIterable<AgentEvent>;
  resumeTurn(input: ResumeAgentTurn): AsyncIterable<AgentEvent>;
  stop(projectId: ProjectId): Promise<void>;
}

interface AgentManager {
  startTask(projectId: ProjectId, prompt: string): Promise<TaskId>;
  sendMessage(projectId: ProjectId, message: string): Promise<void>;
  stop(projectId: ProjectId): Promise<void>;
  getStatus(projectId: ProjectId): AgentStatus;
  getSession(projectId: ProjectId): AgentSession | undefined;
}

interface Storage {
  load(): Promise<PersistedState>;
  update(mutator: (state: PersistedState) => PersistedState): Promise<void>;
  close(): Promise<void>;
}
```

У реалізації mutator API може бути замінено granular repositories, якщо це
дасть кращу type safety. Domain layer не імпортує `grammy`, Codex SDK чи Node
filesystem types.

## Project configuration

Model providers are reusable, operator-owned top-level configuration. A project
may select one provider and a bounded model ID through `agent`; neither provider
IDs nor URLs are accepted from Telegram. The validated provider union is either
an allowlisted Codex built-in (`openai`, `ollama`, `lmstudio`) or a generic
Responses provider with normalized absolute `http`/`https` `baseUrl` and fixed
`wireApi: "responses"`.

```json
{
  "modelProviders": {
    "home-llama": {
      "type": "responses",
      "name": "Home llama.cpp",
      "baseUrl": "http://192.168.1.179:8080/v1",
      "wireApi": "responses",
      "apiKeyEnv": "HOME_LLAMA_API_KEY"
    }
  },
  "projects": {
    "motor": {
      "name": "Motor Backend",
      "path": "/home/user/projects/motor-backend",
      "agent": {
        "provider": "home-llama",
        "model": "configured-server-model"
      },
      "allowedOperations": ["task", "status", "git", "diff", "test", "stop"]
    }
  }
}
```

Provider IDs, names and model IDs are bounded. Custom URLs cannot contain
userinfo, query parameters or fragments; plain HTTP is limited to loopback or
private operator-owned network addresses. Credentials are referenced only by an
environment-variable name. Their values are resolved by `ConfigLoader` into a
separate redacted secrets container and never enter typed project config,
storage, logs or errors. Generic retry and stream/idle timeout behavior uses
bounded runtime defaults rather than arbitrary provider passthrough.

Provider diagnostics are operator-only and decoupled from application startup.
The diagnostic service performs a bounded Responses SSE/tool/continuation probe
without repository tools or workspace mutation; `/models` is only a discovery
signal. Safe typed failure codes are returned without raw provider bodies or
credentials.

## Local runtime deployment boundary

Ollama and LM Studio use the allowlisted built-in provider IDs (`ollama` and
`lmstudio`) for their standard local server modes. `llama.cpp` and other custom
hosts use the generic `responses` provider only when they implement the full
Responses contract: incremental SSE, `response.completed`, structured tool
calls and a continuation with bounded full input history. Model discovery is a
diagnostic hint, not a compatibility decision, and Chat Completions is never an
implicit fallback.

The runtime owns model context capacity. Gateway configuration must reserve
space for instructions, bounded history, tool schemas and output; a provider
context overflow is reported as a provider failure rather than silently
truncating safety-relevant input. Provider IDs, model IDs, endpoint URLs and
credential variable names are trusted configuration, never Telegram input.

For LAN deployments, bind the model server to a private interface only, permit
the port from the gateway host in the firewall, and do not expose the port via
public forwarding. Public endpoints require HTTPS; private plain HTTP is
allowed only for operator-owned loopback/private networks. The systemd unit's
`network-online.target` ordering covers network-dependent operation but does
not perform a provider health check during startup. The gateway remains usable
for status, stop and configuration diagnostics while inference is offline.

Rollback changes a project's provider/model to the built-in OpenAI provider and
starts a new provider-bound thread. Old sessions remain historical metadata;
cross-provider resume is rejected by identity validation. Secrets are removed
from `.env` only after confirming no remaining project references them.

Commands зберігаються як executable + args, а не shell string:

```json
{
  "projects": {
    "motor": {
      "name": "Motor Backend",
      "path": "/home/user/projects/motor-backend",
      "testCommand": {
        "executable": "./mvnw",
        "args": ["test"]
      },
      "allowedOperations": ["task", "diff", "test", "commit"]
    }
  }
}
```

Rules:

- project ID — bounded slug, не path;
- path мусить бути absolute, canonical, existing directory і Git repository;
- два IDs не можуть вказувати на той самий canonical path;
- symlink resolution відбувається під час startup validation;
- commands не приймають Telegram substitutions, pipes, redirections чи shell;
- optional branch — validation/policy, а не команда automatic checkout.

## Telegram layer

Обрано `grammy` (перевірена версія на дату ADR — 1.45.1): framework має
TypeScript-first context/middleware model, `InlineKeyboard`, callback-query
handlers і error boundaries. Працюємо через long polling, бо gateway запускається
на локальному ноутбуці й не потребує public webhook endpoint.

Pipeline update:

```text
update
  → AuthGuard
  → input normalization / size limits
  → CommandRouter або CallbackRouter
  → handler
  → application service
  → formatter / MessageSender
```

`AuthGuard` завжди перший. Він перевіряє `from.id` для commands, text, documents
і callbacks. Callback payload містить opaque action/confirmation ID; path,
prompt і command у payload не передаються.

Long polling використовує concurrent grammY runner, щоб control updates на
кшталт `/stop` оброблялися, поки `/task` або `/test` ще очікує завершення.
Application-level per-project locks у `AgentManager` лишаються authoritative
serialization boundary і не дозволяють concurrent runner запускати дві
несумісні operations для одного project.

Active project зберігається per Telegram user ID. Навіть якщо whitelist спочатку
містить одного користувача, model не робить singleton-user assumption.

## Agent lifecycle

Codex thread — довгоживучий logical conversation. Кожний Telegram task/answer —
окремий finite SDK turn; між turns agent process не очікує stdin.

```text
IDLE ── start task ──▶ RUNNING
                         │
                         ├── completed ──▶ COMPLETED
                         ├── question ───▶ WAITING_FOR_USER
                         ├── error ──────▶ FAILED
                         └── abort ──────▶ STOPPED

WAITING_FOR_USER ── valid answer ──▶ RUNNING
COMPLETED/FAILED/STOPPED ── next/resume turn ──▶ RUNNING
```

`AgentStateMachine` є єдиним місцем transition validation. Terminal state не
видаляє thread ID. Persisted `RUNNING` після process restart перетворюється на
interrupted/failed під час reconciliation, а не вважається живим.

## Task flow

1. Handler перевіряє authorized user та active project.
2. `AgentManager` атомарно захоплює per-project operation lock.
3. `GitService` знімає read-only initial snapshot (Phase 3).
4. `TaskManager` створює `TASK-nnnn` (in-memory до Phase 4).
5. `SessionManager` повертає thread ID або ознаку new thread.
6. `CodexAdapter` запускає streamed SDK turn у canonical project directory.
7. Adapter map-ить SDK events у bounded domain events.
8. `ProgressReporter` агрегує events в одне edited Telegram message.
9. Thread ID persist-иться одразу після `thread.started`.
10. Final structured outcome визначає `COMPLETED` або `WAITING_FOR_USER`.
11. Failure/abort завжди звільняє lock у `finally`.

## Question and answer flow

Питання — terminal outcome поточного turn, а не інтерактивний CLI prompt:

```text
Codex turn → { kind: "question", question, choices }
           → persist WAITING_FOR_USER + pending question
           → Telegram message/inline keyboard
           → validated user answer
           → resume same thread with answer + question context
           → next streamed turn
```

Pending question має project ID, thread ID, user ID, created timestamp і opaque
question ID. Stale callback або answer для іншого active project відхиляється.

## Concurrency and ownership

- `Map<ProjectId, ActiveOperation>` належить `AgentManager`.
- Lock береться до запуску SDK/test і звільняється у `finally`.
- Один project: один Codex/test/build operation одночасно.
- Різні projects можуть працювати паралельно.
- `AbortController` належить active operation, не Telegram handler.
- Після restart in-memory processes не відновлюються автоматично.
- Gateway не намагається attach до випадкового зовнішнього Codex process.

## Persistence

Для MVP обрано versioned JSON storage:

```text
projects.json       operator-owned configuration
data/state.json     gateway-owned runtime state
```

`projects.json` не дублюється як authoritative data у state. State зберігає:

- schema version;
- active project per Telegram user;
- project → Codex thread ID і session metadata;
- agent state/reconciliation metadata;
- task counter та bounded task history;
- pending questions/confirmations;
- timestamps.

`JsonStorage` серіалізує writes, пише temporary file, виконує fsync за потреби й
atomic rename. Corrupted/unsupported state не перезаписується мовчки. Storage
interface дозволяє заміну на SQLite/PostgreSQL без змін application services.

JSON обрано замість SQLite, бо gateway single-process, обсяг малий, а MVP не
потребує queries чи native dependency. Рішення переглядається при multi-process
deployment або значному task history.

### Storage schema v2

`Storage` оперує цілим immutable snapshot і надає `load`, serialized atomic
`update(mutator)` та `close`. Mutator отримує ізольований snapshot і повертає
повний новий state; якщо mutator, validation або disk write завершується
помилкою, попередній state лишається чинним. Це contract-level семантика й вона
не залежить від JSON backend.

```json
{
  "schemaVersion": 2,
  "activeProjects": {
    "123456": {
      "projectId": "motor",
      "updatedAt": "2026-09-15T10:00:00.000Z"
    }
  },
  "sessions": {
    "motor": {
      "projectId": "motor",
      "projectPath": "/canonical/path/to/motor",
      "state": "COMPLETED",
      "threadId": "thread-id",
      "startedAt": "2026-09-15T09:55:00.000Z",
      "updatedAt": "2026-09-15T10:00:00.000Z"
    }
  },
  "tasks": [{
    "id": "TASK-0001",
    "projectId": "motor",
    "promptSummary": "Bounded non-secret summary",
    "status": "completed",
    "createdAt": "2026-09-15T09:55:00.000Z",
    "updatedAt": "2026-09-15T10:00:00.000Z"
  }],
  "sequence": { "nextTaskNumber": 2 }
}
```

Ключ `activeProjects` — decimal Telegram user ID, ключ `sessions` — validated
project ID. Усі timestamps — canonical UTC ISO 8601 (`Date#toISOString`).
`projectPath` потрібен для перевірки repository identity при resume; config усе
одно лишається authoritative. `nextTaskNumber` — наступний ще не виданий suffix.

`JsonStorage` створює data directory, серіалізує operations у межах process,
пише в unique temporary file у тому самому directory, виконує file `fsync`,
atomic rename і directory `fsync`. Malformed v1 state має категорію
`STORAGE_DAMAGED`, інша numeric version — `STORAGE_UNSUPPORTED_VERSION`; такі
файли не перезаписуються автоматично.

### Persistent sessions

`SessionManager` є application-level власником persisted session records. Він
отримує project тільки з validated `ProjectManager`, тому порівнює збережений
`projectPath` з уже canonical configured repository path перед поверненням
thread ID. Невідповідність має safe error `SESSION_REPOSITORY_MISMATCH`: стара
сесія не відновлюється і не переприв'язується до нового repository автоматично.

Кожна session також зберігає non-secret `agentIdentity`: adapter kind, provider
ID, model ID та SHA-256 fingerprint нормалізованої provider configuration без
credential. Зміна provider, endpoint, model або repository робить старий thread
non-resumable: його ID лишається лише як historical metadata, а наступний task
створює новий thread і показує diagnostic warning. Schema-v1 sessions мігрують
як legacy OpenAI sessions; вони не приписуються локальному provider без явної
конфігурації.

Кожен project ID має рівно один незалежний record із власними `threadId`,
`state`, `startedAt` та `updatedAt`. Runtime-only `activeRunId` і `lastEvent` не
persist-яться. Під час першого читання після restart збережений `RUNNING`
атомарно reconcile-иться в `FAILED`, бо process уже не належить новому runtime;
`threadId` при цьому зберігається для контрольованого resume.

## Security boundaries

### Telegram

- whitelist user IDs parsed із environment;
- unauthorized update не доходить до жодного service;
- callbacks перевіряють user, project/context і one-time opaque ID;
- input має size limits і не стає executable/args/path.

### Codex

- `workspace-write`, `approvalPolicy: never`;
- network access і live web search off by default;
- no additional writable directories;
- `danger-full-access` і bypass flags forbidden;
- canonical repository path задає working directory;
- SDK/CLI environment — allowlist;
- global або project-specific `CODEX_HOME` з mode `0700`; project setting має
  precedence над global default;
- thread ID прив'язаний до project ID + canonical path fingerprint.

### Processes and Git

- `spawn` only, `shell: false`;
- executable та args typed/configured окремо;
- before/after Git operations read-only до explicit feature tasks;
- task result зберігає повні before/after snapshots; path, який був dirty до
  task, завжди позначається як pre-existing, навіть якщо під час task він знову
  змінився;
- path-level comparison має attribution `observation_only`: gateway може
  визначити, що path став dirty у проміжку між snapshots, але не приписує зміну
  виключно агенту, бо зовнішні процеси можуть змінювати той самий worktree;
- final numstat описує весь diff відносно HEAD після task, а не гарантований
  agent-only delta; untracked files входять у changed-files, але не в numstat;
- commit лише через gateway confirmation;
- push/reset/clean/discard не реалізуються автоматично;
- `.env`, auth storage, data і logs не комітяться.

## Logging

До Phase 5 використовується мінімальний logger interface; production structured
logging додається окремо. Заборонено логувати Telegram token, auth files, API
keys, повний environment, passwords або необмежений raw command output.

Обов'язковий context: timestamp, user ID, project ID, task ID, state, duration,
exit/failure category. Prompt за замовчуванням зберігається лише як bounded
summary, не повністю.

## Error model

Infrastructure errors перетворюються на typed application errors:

- configuration/validation;
- unauthorized/invalid callback;
- project not found/busy;
- Codex start/stream/turn failure;
- storage read/write failure;
- process spawn/timeout/abort;
- Telegram API/rate-limit failure.

Telegram отримує safe message і diagnostic ID. Повний sanitized stack/context
залишається локально. Порожні `catch` заборонені.

## Architecture Decision Records

### ADR-001 — Official TypeScript Codex SDK

**Decision:** `@openai/codex-sdk` exact-pinned; adapter hides SDK types.

**Why:** офіційно призначений для application integration, typed streaming,
start/continue/resume, working-directory controls і cancellation. Direct CLI
JSONL лишається fallback. Experimental app-server не використовується в MVP.

**Consequence:** tasks DEV-009/010 мають mapper + SDK adapter, а не власний
general-purpose human/JSONL parser.

### ADR-002 — grammY with long polling

**Decision:** `grammy`, long polling.

**Why:** TypeScript-first middleware, inline keyboards/callback handlers, простий
локальний deployment без public endpoint. Webhook можна додати без зміни
application layer.

### ADR-003 — JSON persistence behind interface

**Decision:** atomic versioned `JsonStorage`.

**Why:** single local process і малий обсяг state. SQLite/PostgreSQL не дають
MVP користі, пропорційної складності.

### ADR-004 — Turn-based questions

**Decision:** structured `question` outcome завершує turn; answer resume-ить той
самий thread.

**Why:** public SDK не дає stable question/approval event. Рішення не утримує
процес між Telegram updates та легко переживає restart.

### ADR-005 — Gateway-owned privileged operations

**Decision:** agent не отримує sandbox escalation. Test/build/commit та майбутні
privileged actions виконують typed gateway services згідно з policy і
confirmation.

**Why:** SDK non-interactive approval не можна надійно завершити через Telegram;
парсинг TUI prompts небезпечний і крихкий.

## Phase boundaries

- **Phase 1:** Telegram → project → SDK thread → result, in-memory runtime state.
- **Phase 2:** JSON persistence, resume, structured question/answer, progress edits.
- **Phase 3:** Git/status/diff/test/stop.
- **Phase 4:** task IDs/history, confirmations, commit, restart reconciliation.
- **Phase 5:** logging, robust errors, message boundaries, security review, docs,
  systemd і acceptance.
- **Phase 5B:** optional read-only Jira adapter behind an `IssueTracker` port;
  ticket lookup and fixed `assigned to me` search only, with no mutation API or
  automatic Jira-to-Codex data flow. Detailed plan: [`jira-integration.md`](./jira-integration.md).

## Phase 2 smoke checklist

Automated coverage in `tests/phase2/Phase2EndToEnd.test.ts` drives real grammY
updates through `TelegramBot` and `CommandRouter`. It verifies two isolated
projects, active-project switching, batched progress edits, restart recovery, a
persisted pending question, and a plain-text answer sent to the original Codex
thread.

Before a release with a real Codex CLI and Telegram bot, an operator must also:

- [ ] select each configured project and start one harmless task in each;
- [ ] verify that progress is edited in one status message rather than flooding chat;
- [ ] make Codex return a structured `{ "kind": "question" }` outcome, answer it
  through Telegram, and confirm the same thread continues;
- [ ] restart the gateway while waiting for that answer, then verify the dashboard,
  pending question, and thread are restored;
- [ ] confirm startup, task execution, and shutdown produce no Node deprecation warnings.

Перед Phase 1 потрібно вирішити два локальні prerequisites з
`environment.md`: створити Git repository та надати Telegram token/whitelist.
