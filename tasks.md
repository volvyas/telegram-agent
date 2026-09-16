# План реалізації Remote Codex Agent Gateway

Цей файл розбиває `design.md` на невеликі послідовні задачі. Рекомендований
темп — 1–2 задачі на день. Перед початком нової задачі достатньо прочитати її
опис, залежності та пов'язані рішення в `docs/architecture.md`.

## Як працювати з планом

- Виконувати задачі в порядку номерів, якщо в задачі явно не сказано інше.
- Після завершення замінювати `[ ]` на `[x]` і коротко дописувати результат.
- Одна задача повинна завершуватися робочим build/test або окремим документом.
- Не змішувати рефакторинг наступних фаз із поточною задачею.
- Фактичні можливості встановленого Codex CLI мають пріоритет над припущеннями
  з `design.md`.
- Ідентифікатори `DEV-xxx` належать цьому плану; runtime-задачі користувача
  матимуть формат `TASK-0001`.

## Запропоновані модулі та класи

```text
src/
├── index.ts
├── app/
│   └── Application.ts
├── config/
│   ├── AppConfig.ts
│   ├── ConfigLoader.ts
│   └── ProjectConfig.ts
├── domain/
│   ├── AgentSession.ts
│   ├── TaskRecord.ts
│   └── Confirmation.ts
├── projects/
│   └── ProjectManager.ts
├── agent/
│   ├── AgentEvent.ts
│   ├── AgentRun.ts
│   ├── CodingAgent.ts
│   ├── AgentState.ts
│   ├── AgentStateMachine.ts
│   ├── AgentManager.ts
│   └── codex/
│       ├── CodexAdapter.ts
│       └── CodexEventMapper.ts
├── process/
│   └── ProcessRunner.ts
├── sessions/
│   └── SessionManager.ts
├── tasks/
│   ├── TaskManager.ts
│   └── TaskIdGenerator.ts
├── git/
│   ├── GitService.ts
│   └── GitOutputParser.ts
├── commands/
│   └── ProjectCommandRunner.ts
├── confirmations/
│   └── ConfirmationService.ts
├── storage/
│   ├── Storage.ts
│   └── JsonStorage.ts
├── telegram/
│   ├── TelegramBot.ts
│   ├── AuthGuard.ts
│   ├── CommandRouter.ts
│   ├── CallbackRouter.ts
│   ├── ProgressReporter.ts
│   ├── MessageSender.ts
│   ├── handlers/
│   └── keyboards/
├── logging/
│   └── LoggerFactory.ts
└── utils/
    └── SecretRedactor.ts
```

Назви можуть трохи змінитися під час реалізації, але межі відповідальності
слід зберігати: Telegram не знає деталей Codex, а Codex adapter не знає деталей
Telegram.

---

## Phase 0 — перевірка середовища й архітектурні рішення

### [x] DEV-001 — Зібрати звіт про локальне середовище

**Результат:** `docs/environment.md`.

Перевірити й зафіксувати версії Node.js, npm/pnpm, Git, Codex CLI, наявність
Telegram token без виведення його значення, а також стан поточного repository.
Секрети в документ і логи не записувати.

**Готово, коли:** усі команди та їх безпечні результати задокументовані;
зрозуміло, який package manager використовуватиметься.

### [x] DEV-002 — Дослідити фактичний Codex CLI

**Залежить від:** DEV-001. **Результат:** `docs/codex-integration.md`.

Через `codex --help`, help відповідних subcommands і офіційну документацію
перевірити non-interactive запуск, JSON/JSONL output, stdin, working directory,
resume/session ID, sandbox, approval mode, streaming, stop та exit codes. Не
вигадувати параметри й не запускати Codex на зміну файлів.

**Готово, коли:** обрано один підтримуваний integration flow та описано
fallback для можливостей, яких поточна версія не має.

### [x] DEV-003 — Зафіксувати архітектуру та контракти MVP

**Залежить від:** DEV-002. **Результат:** `docs/architecture.md`.

Описати потік Telegram → `AgentManager` → `CodingAgent`, життєвий цикл процесу,
межі довіри, формат Codex events, спосіб resume та початковий persistence choice
(JSON або SQLite). Додати короткі ADR для bot framework і storage.

**Готово, коли:** визначені typed interfaces, ownership процесів і даних та
поведінка при рестарті; документ не суперечить реальному CLI.

---

## Phase 1 — мінімальний наскрізний сценарій

### [x] DEV-004 — Створити TypeScript-каркас проєкту

**Залежить від:** DEV-003. **Файли:** `package.json`, `tsconfig.json`,
`src/index.ts`, базова структура
`src/`, конфігурація test runner/linter.

Додати тільки погоджені залежності та scripts `dev`, `build`, `start`, `test`.
Увімкнути strict TypeScript. Не створювати бізнес-класи-заглушки наперед.

**Готово, коли:** чистий проєкт компілюється, запускається і має один smoke test.

**Виконано 2026-08-27:** npm/TypeScript ESM каркас, strict config, ESLint,
Vitest, build/start/dev scripts і bootstrap smoke tests.

### [x] DEV-005 — Реалізувати завантаження environment config

**Класи:** `AppConfig`, `ConfigLoader`. **Файли:** `.env.example`, `.gitignore`.

Валідувати обов'язкові значення, парсити whitelist як множину numeric user ID,
підтримати окремий gateway `CODEX_HOME`, не виводити token/paths до auth у
помилках. Додати unit tests для missing/invalid variables.

**Готово, коли:** application отримує immutable typed config або завершується з
чіткою безпечною помилкою; `.env` і runtime data ігноруються Git.

**Виконано 2026-08-27:** `AppConfig`/`ConfigLoader`, built-in `.env` loading,
typed validation, safe errors, whitelist parsing і `CODEX_HOME` support.

### [x] DEV-006 — Реалізувати project configuration

**Класи:** `ProjectConfig`, `ProjectManager`, доповнення `ConfigLoader`.
**Файли:** `projects.example.json`.

Підтримати name, path, test/build/run command як `{ executable, args }`, branch
та allowed operations.
Перевіряти унікальність ID, абсолютний canonical path, існування директорії та
те, що вона є Git repository. Не хардкодити локальні paths.

**Готово, коли:** валідний config завантажується, невалідний має точну помилку,
а `ProjectManager` повертає/перелічує проєкти; є unit tests.

**Виконано 2026-08-27:** typed command/operation config, canonical Git-root
validation, duplicate-path protection, examples і `ProjectManager` tests.

### [x] DEV-007 — Додати безпечний `ProcessRunner`

**Клас:** `ProcessRunner`.

Створити typed API поверх `spawn`: executable та args окремо, explicit cwd і
env allowlist, stdin, stdout/stderr events, timeout/abort і коректне завершення
process tree. Заборонити shell mode за замовчуванням.

**Готово, коли:** unit/integration tests перевіряють args без interpolation,
streaming output, ненульовий exit code, timeout та stop.

**Виконано 2026-08-27:** `spawn` із `shell: false`, explicit env/cwd, stdin,
bounded capture, streaming, timeout/abort і POSIX process-group termination.

### [x] DEV-008 — Визначити доменний контракт coding agent

**Класи/types:** `CodingAgent`, `AgentEvent`, `AgentRun`, `AgentStartOptions`.

Описати start/resume/send/stop відповідно до висновків DEV-002. Події мають
представляти progress, final result, question, warning та error без залежності
від формату Codex CLI.

**Готово, коли:** контракт компілюється, не містить Telegram types і його можна
реалізувати як реальним adapter, так і mock у тестах.

**Виконано 2026-08-27:** domain-only `CodingAgent`, `AgentRun` і discriminated
`AgentEvent` contracts; mock implementation перевіряє start/resume/send/stop.

### [x] DEV-009 — Реалізувати mapper typed Codex SDK events

**Клас:** `CodexEventMapper`.

Перетворювати `ThreadEvent`/`ThreadItem` з pinned `@openai/codex-sdk` на наші
`AgentEvent`; невідомі майбутні події зберігати як bounded diagnostic. Не
експортувати SDK types за межі adapter module і не пересилати raw reasoning.

**Готово, коли:** fixture-based tests покривають start/progress/result/error,
session ID, command/file items і невідому подію.

**Виконано 2026-08-27:** SDK 0.150.1 exact-pinned; stateful mapper покриває
thread/turn/items/errors, не пересилає reasoning і обмежує unknown diagnostics.

### [x] DEV-010 — Реалізувати базовий `CodexAdapter`

**Залежить від:** DEV-008–009. **Клас:** `CodexAdapter implements CodingAgent`.

Використати exact-pinned `@openai/codex-sdk`, передавати prompt як SDK input,
встановлювати `workingDirectory` рівно в project path, stream-ити mapped events,
зберігати thread ID та підтримати `AbortSignal`. Явно встановити
`workspace-write`, approval `never`, network/search off і порожні additional dirs.

**Готово, коли:** adapter проходить tests із fake SDK client; окремий opt-in
smoke test може звернутися до реального Codex у read-only temporary repository.

**Виконано 2026-08-27:** SDK adapter із start/resume/send, thread ID tracking,
AbortSignal stop, env allowlist, locked-down thread options і safe failures.

### [x] DEV-011 — Реалізувати state machine агента

**Класи:** `AgentState`, `AgentStateMachine`.

Стани: `IDLE`, `RUNNING`, `WAITING_FOR_USER`, `COMPLETED`, `FAILED`, `STOPPED`.
Явно описати дозволені transitions і причини; не дозволяти silent invalid
transition.

**Готово, коли:** unit tests покривають усі дозволені переходи й основні
заборонені переходи.

**Виконано 2026-08-27:** transition-by-reason state machine; tests покривають
усю allowed matrix, повний lifecycle і кожну заборонену пару state/reason.

### [x] DEV-012 — Реалізувати MVP `AgentManager`

**Залежить від:** DEV-006, DEV-008, DEV-011. **Клас:** `AgentManager`.

Додати `startTask`, `getStatus`, `getSession` та одну активну operation на
project. На цьому кроці достатньо in-memory session state. Дозволити паралельні
процеси різних projects і відхиляти другий процес того самого project.

**Готово, коли:** tests з mock `CodingAgent` перевіряють lifecycle, events,
помилку запуску та per-project concurrency lock.

**Виконано 2026-08-28:** in-memory session/status, streamed event lifecycle,
immutable snapshots, per-project operation lock і паралельність різних projects.

### [x] DEV-013 — Створити Telegram bot bootstrap та whitelist guard

**Класи:** `TelegramBot`, `AuthGuard`.

Підняти bot framework, зареєструвати middleware першим у chain. Перевіряти user
ID для command, text і callback; неавторизованому користувачу відповідати
`Unauthorized.` і не викликати жодних сервісів.

**Готово, коли:** unit tests доводять, що unauthorized update не проходить далі,
а token не потрапляє в логи.

**Виконано 2026-09-14:** додано exact-pinned `grammy`, long-polling bootstrap,
перший у chain whitelist middleware для messages/callbacks і sanitized error
logging; unit/integration tests блокують unauthorized updates до handlers.

### [x] DEV-014 — Реалізувати вибір активного проєкту

**Класи:** `CommandRouter`, `ProjectHandler`, `ProjectKeyboard`.

Додати `/start`, `/projects`, `/project [id]` та inline callbacks. Активний
project спочатку можна тримати in-memory per Telegram user. Callback містить
opaque/validated project ID, а не path.

**Готово, коли:** користувач бачить список, обирає project і отримує dashboard;
невідомий project обробляється без падіння; handler tests проходять.

**Виконано 2026-09-14:** `/start`, `/projects`, `/project <id>`, inline project
keyboard з opaque callback tokens, validated selection і in-memory active project
per Telegram user; dashboard та unknown-project paths покриті tests.

### [x] DEV-015 — Реалізувати `/task` і доставку фінального результату

**Класи:** `TaskHandler`, доповнення `CommandRouter`, `AgentManager`.

Підтримати `/task <text>` і двокроковий `/task` → наступне text message. Без
active project задачу не запускати. Зв'язати agent events із Telegram response
та показати мінімальні started/completed/failed messages.

**Готово, коли:** mocked end-to-end test проходить шлях update → selected project
→ Codex prompt → final Telegram message; prompt не потрапляє в shell string.

**Виконано 2026-09-14:** `/task <text>` і двокроковий `/task` → text,
перевірка active project, bounded prompt та started/completed/failed delivery;
mocked Telegram → project → agent → final-message flow зберігає prompt дослівно.

### [x] DEV-016 — Зібрати application composition root

**Класи:** `Application`, `src/index.ts`.

Створювати config, managers, adapter і bot в одному місці; додати graceful
shutdown для SIGINT/SIGTERM, закриття bot та активних процесів. У бізнес-класах
не читати globals/env напряму.

**Готово, коли:** Phase 1 запускається локально з example config, build і всі
tests зелені; вручну перевірений сценарій select project → task → result.

**Виконано 2026-09-14:** `Application.create()` збирає config, projects, Codex
adapter, agent manager, handlers і Telegram bot; SIGINT/SIGTERM ідемпотентно
abort-ять та очікують active runs перед зупинкою polling. Composition і mocked
Phase 1 flow перевірені автоматично; live smoke потребує локальних bot credentials.

---

## Phase 2 — persistent sessions і двосторонній діалог

### [x] DEV-017 — Визначити storage interface і схему даних

**Класи:** `Storage`, records для active projects, sessions, tasks і sequence.

Передбачити versioned schema, atomic update та серіалізацію timestamps. Не
прив'язувати domain services до JSON/SQLite деталей.

**Готово, коли:** contract tests можна запускати проти будь-якої реалізації
storage; схема задокументована в `docs/architecture.md`.

**Виконано 2026-09-15:** додано backend-neutral `Storage`, versioned immutable
state для active projects, sessions, tasks і sequence, reusable contract tests
та документацію schema v1 й atomic update semantics.

### [x] DEV-018 — Реалізувати `JsonStorage`

**Клас:** `JsonStorage implements Storage`.

Записувати через temporary file + atomic rename, серіалізувати concurrent writes,
створювати data directory, коректно повідомляти про damaged/unsupported data.

**Готово, коли:** contract tests покривають restart persistence, concurrent
updates та corrupted file; runtime data не потрапляє в Git.

**Виконано 2026-09-15:** `JsonStorage` із serialized updates, temp file + fsync +
atomic rename, автоматичним створенням data directory, restart persistence та
окремими safe errors для damaged/unsupported state; `data/` ігнорується Git.

### [x] DEV-019 — Реалізувати persistent `SessionManager`

**Класи:** `AgentSession`, `SessionManager`.

Зберігати окремий Codex session ID і state для кожного project. Валідувати, що
session відновлюється лише в тому самому canonical repository path.

**Готово, коли:** tests доводять ізоляцію двох projects і відновлення session
після створення нового instance manager.

**Виконано 2026-09-15:** додано storage-backed `SessionManager`, окремі thread
ID/state per project, захист від restore у repository з іншим canonical path і
reconciliation orphaned `RUNNING` → `FAILED`; tests покривають ізоляцію та restart.

### [x] DEV-020 — Додати resume до `CodexAdapter`

**Залежить від:** DEV-002, DEV-019. **Клас:** доповнення `CodexAdapter`.

Реалізувати resume фактично підтримуваним CLI способом; session ID брати тільки
зі структурованої події. Якщо resume неможливий, реалізувати задокументований
еквівалент, обраний у DEV-002/003.

**Готово, коли:** tests перевіряють точні args/protocol для new і resumed run,
а ручний smoke test підтверджує продовження контексту.

**Виконано 2026-09-15:** persisted project thread автоматично обирає SDK
`resumeThread(threadId, lockedDownOptions)` замість `startThread`; thread ID
приймається лише зі structured `thread.started` і перевіряється при resume.
Storage підключено в composition root, а restart integration test підтверджує
new manager → той самий project/thread. Live SDK smoke у temporary Git repository
підтвердив збереження контексту між `startThread` і `resumeThread`.

### [x] DEV-021 — Persist active project selection

**Класи:** доповнення `ProjectManager`/`ProjectHandler` через `Storage`.

Зберігати active project per authorized user та відновлювати його після restart;
видалений із config project не повинен ставати активним автоматично.

**Готово, коли:** test перезапуску повертає dashboard попереднього project.

**Виконано 2026-09-15:** active project зберігається per user у `Storage`, відновлюється
для dashboard/task flow, а project, видалений з config, ігнорується.

### [x] DEV-022 — Підтримати agent questions і `WAITING_FOR_USER`

**Класи:** decoder structured turn outcome, доповнення `CodexEventMapper`,
`AgentManager`, `AgentStateMachine`.

Перетворювати question/request-for-input на domain event, переводити тільки
відповідну project session у `WAITING_FOR_USER`, зберігати question ID/context.

**Готово, коли:** tests покривають RUNNING → WAITING → RUNNING, stale question
та питання одночасно у двох різних projects.

**Виконано 2026-09-15:** structured final outcome `{ kind: "question" }` map-иться
у domain question; pending question з owner/context зберігається в session і
відновлюється після restart.

### [x] DEV-023 — Реалізувати відповіді користувача агенту

**Класи:** `AnswerHandler`, доповнення `AgentManager`/`CodexAdapter`.

Підтримати `/answer <text>`, звичайний text у стані waiting та inline choices.
Відповідь має потрапляти тільки в session активного project і відповідати
pending question. Callback user ID перевіряється guard.

**Готово, коли:** integration test проходить question → Telegram answer → та сама
agent session → continued result; повторна/stale відповідь відхиляється.

**Виконано 2026-09-15:** додано `AnswerHandler`: `/answer`, text у waiting state
та opaque inline choices продовжують той самий thread через `CodingAgent.send`;
stale question і user/project mismatch відхиляються.

### [x] DEV-024 — Реалізувати розумний `ProgressReporter`

**Клас:** `ProgressReporter`.

Агрегувати значущі events, rate-limit updates, редагувати одне Telegram message
для довгої роботи. Не пересилати кожен stdout line. Завжди окремо доставляти
question, completion і failure.

**Готово, коли:** fake-clock tests перевіряють batching/rate limit і terminal
events; Telegram flood не створюється.

**Виконано 2026-09-15:** `ProgressReporter` агрегує transient agent events у
одне rate-limited Telegram edit; questions і terminal results надсилаються
окремо. Додано fake-clock tests batching, rate limit та terminal isolation.

### [x] DEV-025 — видалити deprecated punycode модуль.

Знайти залежні від модуля puny модулі. Замінити версії модулів на ті, що не використовують punycode.

**Готово коли:** в проекті не використовується punycode. Тести проходять, проект стартує 
без повідомлень про deprecated модулі.

**Виконано 2026-09-16:** ESLint замінено на Biome, бо актуальний ESLint усе ще
тягне `ajv 6 → uri-js → punycode`; `npm ls punycode puny --all` тепер порожній.

### [ ] DEV-026 — Завершити Phase 2 наскрізним тестом

Перевірити два projects, окремі sessions, перемикання, питання/відповідь і
restart gateway. Оновити `docs/architecture.md`, якщо реальна поведінка Codex
відрізняється від початкового рішення.

**Готово, коли:** automated scenario з mock agent зелений, а manual smoke test з
реальним Codex підтверджено чеклістом у документі.

**Автоматизовано 2026-09-16:** додано scenario з двома isolated projects,
switching, progress edits, persisted question/answer і restart через реальні
`TelegramBot`/`CommandRouter` boundaries. Виправлено routing text/callback updates.
Реальний Codex/Telegram smoke залишено в `docs/architecture.md` як operator
checklist і ще потребує виконання.

---

## Phase 3 — Git, тести, status і stop

### [ ] DEV-026 — Реалізувати typed `GitService`

**Класи:** `GitService`, `GitOutputParser`.

Викликати `git` через `ProcessRunner` із фіксованими args та cwd. Повернути branch,
porcelain status, changed files і numstat summary. Не додавати destructive
operations.

**Готово, коли:** tests на temporary repositories покривають clean/dirty,
staged/untracked, branch і filenames зі спецсимволами.

### [ ] DEV-027 — Знімати Git snapshot до та після task

**Класи:** `GitSnapshot`, доповнення `AgentManager`/`TaskRecord`.

Перед task зберігати initial status; після terminal event — final status/diff
summary. Чітко відрізняти попередні user changes від змін під час task, наскільки
це дозволяє Git без модифікації worktree.

**Готово, коли:** task result містить before/after summary, а існуючі зміни не
позначаються як безпечно створені лише агентом.

### [ ] DEV-028 — Реалізувати `/git` та `/status`

**Класи:** `GitHandler`, `StatusHandler`, dashboard formatter.

`/git` показує branch/status/files; `/status` — active project, agent state,
session та короткий Git summary. Дані беруться із сервісів, не з shell text у
handler.

**Готово, коли:** handler tests покривають no project, clean/dirty та running task.

### [ ] DEV-029 — Реалізувати безпечний `/diff`

**Класи:** `DiffHandler`, `MessageSender`.

Отримувати diff через fixed Git args. Малий diff розбивати по Telegram limits,
великий надсилати як temporary `.diff` document; cleanup виконувати гарантовано.

**Готово, коли:** tests покривають Unicode, code fences, великий diff і cleanup;
жоден path/argument не формується з Telegram input.

### [ ] DEV-030 — Реалізувати `ProjectCommandRunner`

**Клас:** `ProjectCommandRunner`.

Запускати лише явно configured test/build/run command. Під час завантаження
config безпечно токенізувати або, бажано, зберігати executable й args окремими
полями. Не приймати command text від Telegram.

**Готово, коли:** tests доводять correct cwd, streaming, timeout/stop та
відсутність shell injection.

### [ ] DEV-031 — Реалізувати `/test`

**Класи:** `TestHandler`, доповнення `AgentManager` або operation coordinator.

Запускати configured test command, показувати progress і стислий результат;
великий output надсилати файлом. Узгодити concurrency: test не повинен паралельно
змінювати/конфліктувати з active task того самого project.

**Готово, коли:** tests покривають no command, pass, fail, timeout і busy project.

### [ ] DEV-032 — Реалізувати `/stop`

**Класи:** `StopHandler`, доповнення `AgentManager`, `ProcessRunner`.

Ідемпотентно зупиняти active Codex/test operation: спочатку graceful signal,
після timeout — примусове завершення process tree. Переводити state у `STOPPED`,
не видаляти session ID чи history.

**Готово, коли:** integration test не залишає child process, а session можна
продовжити після stop згідно з можливостями CLI.

### [ ] DEV-033 — Додати `/help`, `/log` і `/continue`

**Класи:** відповідні handlers і command registration.

`/help` відображає фактично доступні команди; `/log` — останні task records, не
raw secret-bearing logs; `/continue` продовжує останню resumable session або
пояснює, чому це неможливо.

**Готово, коли:** command parser/handler tests покривають усі гілки.

### [ ] DEV-034 — Завершити Phase 3 dashboard UX

**Класи:** keyboards і callback handlers для Status/New task/Diff/Tests/Stop.

Усі callbacks повинні мати bounded payload, перевірку user/project/context та
відповідати актуальному стану. Не дублювати command logic у callback handlers.

**Готово, коли:** dashboard actions делегують тим самим services, що й slash
commands; mocked Telegram flow повністю зелений.

---

## Phase 4 — confirmations, commit та історія задач

### [ ] DEV-035 — Реалізувати task ID та persistent history

**Класи:** `TaskIdGenerator`, `TaskManager`, `TaskRecord`.

Атомарно генерувати `TASK-0001`, зберігати project, prompt summary, timestamps,
status, duration, exit code, test і Git summaries. Повний prompt зберігати лише
за явним архітектурним рішенням і з урахуванням приватності.

**Готово, коли:** IDs не повторюються після restart/concurrent starts, а `/log`
читає bounded останню історію зі storage.

### [ ] DEV-036 — Реалізувати `ConfirmationService`

**Класи:** `Confirmation`, `ConfirmationService`.

Створювати одноразовий random opaque ID, зберігати user/project/operation/expiry,
атомарно consume allow/deny. Telegram text не може підтверджувати operation без
valid pending ID.

**Готово, коли:** tests покривають wrong user/project, expired, replay, deny та
simultaneous callbacks.

### [ ] DEV-037 — Додати Telegram confirmation flow

**Класи:** `ConfirmationHandler`, `ConfirmationKeyboard`, `CallbackRouter`.

Показувати зрозумілий operation summary та кнопки Allow once/Deny. Callback
спершу проходить authentication, потім atomic confirmation consume.

**Готово, коли:** end-to-end tests доводять, що forged/replayed callback не
запускає operation.

### [ ] DEV-038 — Реалізувати `/commit` preview і cancel

**Класи:** `CommitHandler`, `GitService` extension.

Показувати branch, кількість файлів і numstat, після чого створювати pending
confirmation. Не commit-ити clean tree. На цьому кроці не виконувати commit.

**Готово, коли:** preview точний, clean/busy/no-project cases оброблені, кнопка
Cancel закриває confirmation без side effects.

### [ ] DEV-039 — Реалізувати підтверджений commit

**Класи:** `CommitService` або контрольоване розширення `GitService`.

Після valid confirmation виконувати `git commit` із message через окремий arg
або безпечний file/stdin mechanism. Визначити політику staging явно: не додавати
untracked/усі files мовчки. Не робити push.

**Готово, коли:** temporary-repo tests перевіряють commit, message зі
спецсимволами, staging policy, hook failure і callback replay.

### [ ] DEV-040 — Ввести policy для дозволених operations

**Класи:** `OperationPolicy`, інтеграція з project config та confirmation flow.

Централізовано класифікувати allowed, confirmation-required і forbidden
operations. Заборонити push/reset-hard/clean/checkout-discard за замовчуванням.

**Готово, коли:** table-driven tests покривають default і per-project policy;
handler/agent path не може обійти policy service.

### [ ] DEV-041 — Перевірити restart recovery

Визначити поведінку persisted `RUNNING` після падіння: reconcile як interrupted/
failed, не вважати process живим без доказу. Зберегти resumable session, pending
history; прострочити небезпечні confirmations.

**Готово, коли:** crash/restart integration test не дублює task, не запускає
operation повторно й дозволяє безпечне resume.

---

## Phase 5 — production hardening і документація

### [ ] DEV-042 — Додати structured logging і redaction

**Класи:** `LoggerFactory`, `SecretRedactor`.

Окремі app/agent log streams або чіткі categories; поля timestamp, user ID,
project, task ID, state, duration, exit code. Redact token, keys, passwords,
authorization headers і configured secret values; не логувати повний env.

**Готово, коли:** capture tests не знаходять test secrets у logs; rotation/size
policy визначена; помилки зберігають корисний context.

### [ ] DEV-043 — Посилити error handling

Ввести typed/domain errors, єдине Telegram-safe formatting і diagnostic IDs.
Обробити Telegram API failure/retry, malformed Codex event, missing repository,
storage failure та process spawn failure. Не використовувати порожні `catch`.

**Готово, коли:** fault-injection tests не залишають lock/process/pending state і
користувач отримує дієве, але безпечне повідомлення.

### [ ] DEV-044 — Завершити `MessageSender` для довгих повідомлень

**Клас:** `MessageSender.sendLongMessage`.

Розбивати plain text без перевищення актуального Telegram limit, по можливості
зберігати code blocks; дуже великі logs/diffs надсилати файлами. Додати retry для
rate limit і гарантований cleanup temp files.

**Готово, коли:** boundary/property tests покривають Unicode, Markdown escaping,
code fences, exact limit, documents і Telegram retry response.

### [ ] DEV-045 — Security review і regression tests

Перевірити всі process calls, path validation/canonicalization, symlink cases,
callback authorization, session isolation, log redaction, temp permissions та
repository sandbox. Зафіксувати threat model у `docs/security.md`.

**Готово, коли:** немає shell interpolation із user input, paths не виходять за
configured repository без explicit policy, security test suite зелений.

### [x] DEV-046 — Підготувати README

Описати prerequisites, BotFather setup, installation, `.env`, project config,
scripts, usage/commands, IntelliJ coexistence, security, data/log locations,
update procedure і troubleshooting. Не вставляти реальні token/paths/user IDs.

**Готово, коли:** новий користувач може встановити й запустити gateway лише за
README та example files.

**Виконано 2026-09-15:** додано README з prerequisites, BotFather/config setup,
Codex login, project schema, dev/production запуском, deployment/update flow,
актуальними командами, security/data notes і troubleshooting.

### [x] DEV-047 — Додати systemd unit example

**Файли:** `deploy/codex-remote.service`, розділ README.

Unit працює від звичайного explicit user, після network, має restart policy,
working directory, environment file і коректний SIGTERM. Не вбудовувати локальні
username/path; пояснити підстановку та доступ до Codex/repositories.

**Готово, коли:** `systemd-analyze verify` проходить для підставленого локального
example, start/stop/restart не залишає процесів.

**Виконано 2026-09-15:** додано portable unit template і керуючий shell script
для render/install/start/stop/restart/status/logs/uninstall; rendered local unit
проходить `systemd-analyze verify`. Live install навмисно лишається operator action.

### [ ] DEV-048 — Фінальна перевірка Definition of Done

Пройти всі 16 пунктів DoD з `design.md`: реальний Telegram на телефоні, реальний
Codex, два repositories, question/answer, diff/test/stop, switching/resume,
confirmation та gateway restart. Записати результати й відомі обмеження в
`docs/acceptance.md`.

**Готово, коли:** `npm run build`, `npm test` і acceptance checklist зелені;
кожне відхилення має окрему нову задачу, а не приховану примітку.

---

## Контрольні точки

- **Після DEV-016:** Phase 1 MVP — Telegram → project → real Codex → result.
- **Після DEV-025:** sessions переживають restart, працює двосторонній діалог.
- **Після DEV-034:** доступні Git/status/diff/test/stop і повний dashboard.
- **Після DEV-041:** task history, confirmations і commit є persistent та safe.
- **Після DEV-048:** виконано повний Definition of Done.

## Поза поточним scope

- Web UI, Docker і керування IntelliJ GUI.
- Власний LLM agent замість реального Codex.
- PostgreSQL до появи реальної потреби в ньому.
- Автоматичні `git push`, `reset --hard`, `clean` або discard changes.
- Доступ Telegram-користувача до довільної файлової системи чи shell command.
