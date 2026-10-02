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

### [x] DEV-025A — Завершити Phase 2 наскрізним тестом

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

### [x] DEV-026 — Реалізувати typed `GitService`

**Класи:** `GitService`, `GitOutputParser`.

Викликати `git` через `ProcessRunner` із фіксованими args та cwd. Повернути branch,
porcelain status, changed files і numstat summary. Не додавати destructive
operations.

**Готово, коли:** tests на temporary repositories покривають clean/dirty,
staged/untracked, branch і filenames зі спецсимволами.

**Виконано 2026-09-18:** додано read-only `GitService` поверх `ProcessRunner`,
NUL-safe parsers для porcelain/numstat, typed branch/status/files summaries та
temporary-repository tests для clean/dirty, staged/untracked і special filenames.

### [x] DEV-027 — Знімати Git snapshot до та після task

**Класи:** `GitSnapshot`, доповнення `AgentManager`/`TaskRecord`.

Перед task зберігати initial status; після terminal event — final status/diff
summary. Чітко відрізняти попередні user changes від змін під час task, наскільки
це дозволяє Git без модифікації worktree.

**Готово, коли:** task result містить before/after summary, а існуючі зміни не
позначаються як безпечно створені лише агентом.

**Виконано 2026-09-21:** `AgentManager` повертає runtime `TaskRecord` з immutable
before/after `GitSnapshot` і final numstat; path-level comparison відокремлює
pre-existing changes від observed-during-task без хибної agent attribution.

### [x] DEV-028 — Реалізувати `/git` та `/status`

**Класи:** `GitHandler`, `StatusHandler`, dashboard formatter.

`/git` показує branch/status/files; `/status` — active project, agent state,
session та короткий Git summary. Дані беруться із сервісів, не з shell text у
handler.

**Готово, коли:** handler tests покривають no project, clean/dirty та running task.

**Виконано 2026-09-21:** додано typed `GitHandler`, `StatusHandler` і bounded
dashboard formatter; `/git` показує branch/porcelain/files, `/status` — active
project, agent/session state та Git summary. Команди підключено в application.

### [x] DEV-029 — Реалізувати безпечний `/diff`

**Класи:** `DiffHandler`, `MessageSender`.

Отримувати diff через fixed Git args. Малий diff розбивати по Telegram limits,
великий надсилати як temporary `.diff` document; cleanup виконувати гарантовано.

**Готово, коли:** tests покривають Unicode, code fences, великий diff і cleanup;
жоден path/argument не формується з Telegram input.

**Виконано 2026-09-22:** додано fixed-args `GitService.getDiff`, `DiffHandler` і
`MessageSender`; малі diff надсилаються bounded plain-text chunks, великі — як
temporary `changes.diff` з cleanup у `finally`. Покрито Unicode/code fences,
unborn repository, upload failure cleanup та ігнорування command arguments.

### [X] DEV-030 — Реалізувати `ProjectCommandRunner`

**Клас:** `ProjectCommandRunner`.

Запускати лише явно configured test/build/run command. Під час завантаження
config безпечно токенізувати або, бажано, зберігати executable й args окремими
полями. Не приймати command text від Telegram.

**Готово, коли:** tests доводять correct cwd, streaming, timeout/stop та
відсутність shell injection.

### [X] DEV-031 — Реалізувати `/test`

**Класи:** `TestHandler`, доповнення `AgentManager` або operation coordinator.

Запускати configured test command, показувати progress і стислий результат;
великий output надсилати файлом. Узгодити concurrency: test не повинен паралельно
змінювати/конфліктувати з active task того самого project.

**Готово, коли:** tests покривають no command, pass, fail, timeout і busy project.

**Виконано 2026-09-22:** додано `TestHandler`, безпечний запуск configured
test command, progress/result повідомлення й надсилання великого output як
temporary document. `AgentManager` тепер координує project-wide exclusive
operations, тому `/test` не конфліктує з active coding task.

### [X] DEV-032 — Реалізувати `/stop`

**Класи:** `StopHandler`, доповнення `AgentManager`, `ProcessRunner`.

Ідемпотентно зупиняти active Codex/test operation: спочатку graceful signal,
після timeout — примусове завершення process tree. Переводити state у `STOPPED`,
не видаляти session ID чи history.

**Готово, коли:** integration test не залишає child process, а session можна
продовжити після stop згідно з можливостями CLI.

**Виконано 2026-09-22:** додано idempotent `StopHandler` і coordinator-backed
cancel для agent/test operations. Test process отримує abort signal до
`ProcessRunner`, який graceful завершує process group і після grace period
примусово вбиває tree; agent session переходить у `STOPPED` без втрати thread.

### [X] DEV-033 — Додати `/help`, `/log` і `/continue`

**Класи:** відповідні handlers і command registration.

`/help` відображає фактично доступні команди; `/log` — останні task records, не
raw secret-bearing logs; `/continue` продовжує останню resumable session або
пояснює, чому це неможливо.

**Готово, коли:** command parser/handler tests покривають усі гілки.

**Виконано 2026-09-22:** додано handlers для фактичного command surface,
bounded project task log та безпечного продовження resumable session із
поясненням для missing/waiting/active станів.

### [X] DEV-034 — Завершити Phase 3 dashboard UX

**Класи:** keyboards і callback handlers для Status/New task/Diff/Tests/Stop.

Усі callbacks повинні мати bounded payload, перевірку user/project/context та
відповідати актуальному стану. Не дублювати command logic у callback handlers.

**Готово, коли:** dashboard actions делегують тим самим services, що й slash
commands; mocked Telegram flow повністю зелений.

**Виконано 2026-09-22:** dashboard отримує bounded opaque callbacks для New
task/Status/Git/Diff/Tests/Stop; callbacks перевіряють authenticated user,
active project і дозволену operation та делегують існуючим handlers.

---

## Phase 4 — confirmations, commit та історія задач

### [x] DEV-035 — Реалізувати task ID та persistent history

**Класи:** `TaskIdGenerator`, `TaskManager`, `TaskRecord`.

Атомарно генерувати `TASK-0001`, зберігати project, prompt summary, timestamps,
status, duration, exit code, test і Git summaries. Повний prompt зберігати лише
за явним архітектурним рішенням і з урахуванням приватності.

**Готово, коли:** IDs не повторюються після restart/concurrent starts, а `/log`
читає bounded останню історію зі storage.

**Виконано 2026-09-23:** atomic persistent `TASK-nnnn` sequence, bounded
privacy-safe prompt/history records із lifecycle, duration, exit/test/Git
summaries; `AgentManager` записує terminal/failure states, а `/log` читає
останні project records через `TaskManager`.

### [X] DEV-036 — Реалізувати `ConfirmationService`

**Класи:** `Confirmation`, `ConfirmationService`.

Створювати одноразовий random opaque ID, зберігати user/project/operation/expiry,
атомарно consume allow/deny. Telegram text не може підтверджувати operation без
valid pending ID.

**Готово, коли:** tests покривають wrong user/project, expired, replay, deny та
simultaneous callbacks.

**Виконано 2026-09-23:** додано persistent opaque confirmations із TTL та
serialized atomic allow/deny consume; ownership mismatch не споживає pending
confirmation, а expired/replayed IDs відхиляються. Додано persistence і
concurrency tests.

### [X] DEV-037 — Додати Telegram confirmation flow

**Класи:** `ConfirmationHandler`, `ConfirmationKeyboard`, `CallbackRouter`.

Показувати зрозумілий operation summary та кнопки Allow once/Deny. Callback
спершу проходить authentication, потім atomic confirmation consume.

**Готово, коли:** end-to-end tests доводять, що forged/replayed callback не
запускає operation.

**Виконано 2026-09-23:** додано bounded Allow once/Deny callbacks із
authentication-first routing, active-project validation та atomic confirmation
consume; forged, expired і replayed callbacks не запускають operation.

### [X] DEV-038 — Реалізувати `/commit` preview і cancel

**Класи:** `CommitHandler`, `GitService` extension.

Показувати branch, кількість файлів і numstat, після чого створювати pending
confirmation. Не commit-ити clean tree. На цьому кроці не виконувати commit.

**Готово, коли:** preview точний, clean/busy/no-project cases оброблені, кнопка
Cancel закриває confirmation без side effects.

**Виконано 2026-09-23:** додано `/commit` preview із branch/files/numstat,
перевірками project policy, clean tree та active operation; dirty tree створює
pending confirmation без виконання Git commit, а Deny/Cancel не має side effects.

### [X] DEV-039 — Реалізувати підтверджений commit

**Класи:** `CommitService` або контрольоване розширення `GitService`.

Після valid confirmation виконувати `git commit` із message через окремий arg
або безпечний file/stdin mechanism. Визначити політику staging явно: не додавати
untracked/усі files мовчки. Не робити push.

**Готово, коли:** temporary-repo tests перевіряють commit, message зі
спецсимволами, staging policy, hook failure і callback replay.

**Виконано 2026-09-23:** Allow once виконує безпечний `git commit --message`
лише для вже staged changes; gateway не stage-ить files і не робить push.
Додано temporary-repository tests для literal message, staging policy та hook
failure; Deny/replay callbacks не виконують commit.

### [X] DEV-040 — Ввести policy для дозволених operations

**Класи:** `OperationPolicy`, інтеграція з project config та confirmation flow.

Централізовано класифікувати allowed, confirmation-required і forbidden
operations. Заборонити push/reset-hard/clean/checkout-discard за замовчуванням.

**Готово, коли:** table-driven tests покривають default і per-project policy;
handler/agent path не може обійти policy service.

**Виконано 2026-09-23:** додано централізований `OperationPolicy` для
allowed/confirmation-required/forbidden decisions; handler, agent, configured
command і dashboard paths використовують policy, а push/reset-hard/clean/
checkout-discard заборонені default policy.

### [X] DEV-041 — Перевірити restart recovery

Визначити поведінку persisted `RUNNING` після падіння: reconcile як interrupted/
failed, не вважати process живим без доказу. Зберегти resumable session, pending
history; прострочити небезпечні confirmations.

**Готово, коли:** crash/restart integration test не дублює task, не запускає
operation повторно й дозволяє безпечне resume.

**Виконано 2026-09-23:** startup recovery атомарно reconciles persisted
RUNNING/pending tasks і sessions у FAILED, зберігає WAITING_FOR_USER для
безпечного resume та видаляє expired confirmations; recovery idempotent і не
перезапускає зовнішні processes.

---

## Phase 5 — production hardening і документація

### [X] DEV-042 — Додати structured logging і redaction

**Виконано 2026-09-23:** додано JSON-lines logger із level filtering,
redaction configured secrets, token-like fields та auth/path fields; application
і Telegram error paths використовують structured logger без raw exception output.

**Класи:** `LoggerFactory`, `SecretRedactor`.

Окремі app/agent log streams або чіткі categories; поля timestamp, user ID,
project, task ID, state, duration, exit code. Redact token, keys, passwords,
authorization headers і configured secret values; не логувати повний env.

**Готово, коли:** capture tests не знаходять test secrets у logs; rotation/size
policy визначена; помилки зберігають корисний context.

### [X] DEV-043 — Посилити error handling

Ввести typed/domain errors, єдине Telegram-safe formatting і diagnostic IDs.
Обробити Telegram API failure/retry, malformed Codex event, missing repository,
storage failure та process spawn failure. Не використовувати порожні `catch`.

**Готово, коли:** fault-injection tests не залишають lock/process/pending state і
користувач отримує дієве, але безпечне повідомлення.

**Виконано 2026-09-23:** додано diagnostic IDs і Telegram-safe error formatter,
selective retry для rate-limit/transient Telegram API failures та typed retry
boundary; existing storage/process/repository/Codex paths retain typed errors
without exposing raw causes.

### [X] DEV-044 — Завершити `MessageSender` для довгих повідомлень

**Клас:** `MessageSender.sendLongMessage`.

Розбивати plain text без перевищення актуального Telegram limit, по можливості
зберігати code blocks; дуже великі logs/diffs надсилати файлами. Додати retry для
rate limit і гарантований cleanup temp files.

**Готово, коли:** boundary/property tests покривають Unicode, Markdown escaping,
code fences, exact limit, documents і Telegram retry response.

**Виконано 2026-09-23:** додано `sendLongMessage` із Unicode-safe bounded
chunking, code-fence-aware splitting, Telegram retry integration та existing
temporary-document cleanup for large diffs/logs.

### [x] DEV-045 — Security review і regression tests

Перевірити всі process calls, path validation/canonicalization, symlink cases,
callback authorization, session isolation, log redaction, temp permissions та
repository sandbox. Зафіксувати threat model у `docs/security.md`.

**Готово, коли:** немає shell interpolation із user input, paths не виходять за
configured repository без explicit policy, security test suite зелений.

**Виконано 2026-09-24:** додано threat model у `docs/security.md`, окремий
security regression suite, private storage/temp permissions і symlink/path
guards; approved commit тепер завжди використовує canonical configured path.

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

### [x] DEV-048 — Фінальна перевірка Definition of Done

Пройти всі 16 пунктів DoD з `design.md`: реальний Telegram на телефоні, реальний
Codex, два repositories, question/answer, diff/test/stop, switching/resume,
confirmation та gateway restart. Записати результати й відомі обмеження в
`docs/acceptance.md`.

**Готово, коли:** `npm run build`, `npm test` і acceptance checklist зелені;
кожне відхилення має окрему нову задачу, а не приховану примітку.

**Виявлені live acceptance defects 2026-09-24—25:** DEV-057—DEV-062. Їхній
status, investigation history і verification evidence перенесено в `issues.md`.
DEV-048 не закривати, доки всі regression tasks не виконані й відповідні сценарії
не повторені на реальному Telegram/Codex flow.

**Виконано 2026-09-28:** повний повторний live прогін на реальному Telegram і
Codex пройшов усі 16 DoD пунктів. Перевірено clean start, question/buttons,
Unicode diff, concise tests, stop, switching/continue, confirmation denial і
restart persistence. `npm run build` та 196 tests зелені; результат записано в
`docs/acceptance.md`.

---

## Phase 6 — Generic Bug Tracker read-only integration (GitHub first)

Bug tracker є optional capability окремого project, а не глобальною Jira-
інтеграцією. `projects.json` визначає provider через discriminated
`issueTracker.type` (`github` або, у наступній ітерації, `jira`), а application
працює лише з provider-neutral domain contract. У першій ітерації реалізується
тільки GitHub Issues; `type: "jira"` є валідним зарезервованим вибором, але
звернення до нього повертає чітку помилку `unsupported provider`, доки не
з'явиться `JiraAdapter`.

Інтеграція залишається виключно read-only, не передає issue data Codex
автоматично і не додає generic HTTP/request escape hatch. Planned Jira scope і
security boundaries збережені в `docs/jira-integration.md` для наступної
ітерації.

### [x] DEV-049 — Дослідити GitHub Issues API та зафіксувати generic architecture

Перевірити за офіційною GitHub документацією authentication, current-user
lookup, issue retrieval, assigned-to-me listing, pagination, rate limits,
response formats і відмінність issue від pull request. Використовувати лише
read-only probes на test repository; не створювати й не змінювати issues.

**Результат:** `docs/issue-tracker-integration.md` з provider-neutral flow,
GitHub endpoints/auth scheme, project-to-repository mapping, sanitized fixtures,
limits і extension point для майбутнього `JiraAdapter`.

**Готово, коли:** facts відповідають реальному GitHub API; визначено, як list
відкидає pull requests; token має мінімальний read-only access; жоден probe не
викликає mutation endpoint.

**Виконано 2026-09-29:** за офіційною GitHub REST documentation і public
read-only probes зафіксовано versioned GET-only flow, fine-grained `Issues: read`
permissions, current-user lookup, direct issue lookup, fixed assigned search,
PR exclusion через `is:issue`, pagination/rate limits, GHES base URL, generic
extension point та sanitized fixtures у `docs/issue-tracker-integration.md`.
Authenticated live probe перенесено в DEV-056, бо окремого least-privilege test
token у environment немає.

### [x] DEV-050 — Додати project-scoped Bug Tracker configuration і secrets

**Залежить від:** DEV-049. **Types:** `IssueTrackerConfig`,
`GitHubIssueTrackerConfig`, доповнення `ProjectConfig`/`ConfigLoader`.

Додати optional `issueTracker` як discriminated config з `type`, provider-owned
settings і bounded limits. Для `github` валідувати owner/repository, optional
GitHub API base URL для GitHub Enterprise, page size і hard limits. Credential
брати лише з environment, додати до logger redaction і не серіалізувати в
project config/storage/errors. Значення `jira` розпізнавати як зарезервований
provider без вимоги Jira credentials; його використання resolver відхиляє safe
typed `unsupported provider` до появи adapter.

**Готово, коли:** один gateway може мати projects без tracker і з різними
tracker types; GitHub config immutable/typed; partial, unknown або unsupported
GitHub config дає точну безпечну помилку; tests покривають validation, disabled
mode, GitHub Enterprise URL і token redaction; `projects.example.json` та
`.env.example` не містять credentials.

**Виконано 2026-09-30:** додано immutable discriminated GitHub/Jira config,
bounded provider limits, HTTPS/GHES та exact-key validation, окреме runtime-only
environment credential store і автоматичну реєстрацію tracker tokens у logger
redaction без потрапляння secrets у `ProjectConfig` або persistence.

### [x] DEV-051 — Визначити provider-neutral domain contract і resolver

**Залежить від:** DEV-049–050. **Types:** `IssueTracker`, `IssueDetails`,
`IssuePage`, `IssueReference`, `PageToken`, typed errors. **Клас:**
`IssueTrackerResolver`.

Контракт підтримує тільки `getIssue(reference)` і
`listAssignedToMe(page?)`, нормалізує спільні поля та optional provider-specific
metadata. Resolver обирає adapter за tracker config активного project; handler
не робить `switch` за provider. Не експортувати GitHub/Jira transport або
Telegram types, generic request, search language чи write methods.

**Готово, коли:** contract має fake implementation і contract tests; resolver
повертає GitHub adapter, коректно обробляє відсутній/unsupported provider, а
type/API не дозволяє create/update/comment/transition operations.

**Виконано 2026-09-30:** додано read-only provider-neutral `IssueTracker` з
normalized issue/page types, opaque page token, bounded reference factory,
cancellation і safe typed errors; `IssueTrackerResolver` обирає GitHub adapter
через factory та окремий credential store, а disabled/Jira/missing-secret paths
повертають точні domain errors. Fake implementation проходить reusable contract
tests, а compile-time surface містить лише lookup і assigned listing.

### [x] DEV-052 — Реалізувати read-only `GitHubIssueTracker`

**Залежить від:** DEV-050–051. **Клас:**
`GitHubIssueTracker implements IssueTracker`.

Реалізувати current-user resolution, issue lookup у configured repository та
fixed assigned-to-me listing. Нормалізувати title/state/author/assignees/labels/
milestone/body/timestamps/URL, виключати pull requests і підтримати bounded
pagination. Додати timeout, AbortSignal, response-size limits, same-origin
redirect policy, safe rate-limit retry та runtime validation response shape.

**Готово, коли:** fixture/transport tests покривають lookup/list, empty result,
pagination, pull-request filtering, absent fields, public/private repository,
GitHub Enterprise, auth/permission/not-found/rate-limit, timeout,
malformed/oversized response та abort; adapter ніколи не використовує mutation
endpoint або write HTTP method.

### [x] DEV-053 — Додати generic issue lookup у Telegram

**Залежить від:** DEV-052. **Класи:** `IssueTrackerHandler`, `IssueFormatter`.

Додати provider-neutral `/issue <REFERENCE>`, який використовує tracker
активного project. Для GitHub перша ітерація приймає bounded numeric issue
number (із optional `#`), а repository завжди бере з operator-owned project
config. Виводити normalized plain text через `MessageSender`; не завантажувати
comments/events/attachments і не передавати issue agent session.

**Готово, коли:** authorized handler tests покривають project без tracker,
unsupported provider, valid/invalid reference, повні/відсутні поля, Unicode,
oversized body, not-found/forbidden і Telegram-safe errors; user input не може
змінити provider, origin, owner, repository або requested field set.

### [x] DEV-054 — Додати generic список issues `assigned to me`

**Залежить від:** DEV-052–053.

Додати `/issue mine`: handler викликає provider-neutral method, а GitHub adapter
формує fixed query для authenticated account та configured repository,
детерміновано сортує й повертає bounded page. Next/previous callbacks є opaque,
мають short TTL і прив'язані до Telegram user, project, provider та query kind;
довільний GitHub search query або чужий login не приймати.

**Готово, коли:** tests покривають empty/single/multiple pages, pull requests,
stale/forged/wrong-user/wrong-project callback, max-page cap і stable formatting;
Telegram data не може розширити assigned-to-me query.

### [x] DEV-055 — Security, resilience і provider-isolation review

**Залежить від:** DEV-053–054.

Перевірити least-privilege token, allowlisted origins/endpoints/repositories,
secret/PII redaction, SSRF/redirect handling, reference/query injection,
untrusted Markdown/HTML normalization, response/output limits, rate-limit retry,
shutdown abort і відсутність state leakage між projects/providers. Зафіксувати
generic trust boundary та GitHub-specific constraints у `docs/security.md`.

**Готово, коли:** focused security suite не знаходить mutation path,
cross-origin request, arbitrary repository/search query або credential leakage;
project A не може прочитати tracker project B; fault injection не залишає
pending pagination state чи uncaught errors.

### [x] DEV-056 — GitHub documentation і live read-only acceptance

**Залежить від:** DEV-055.

Оновити README: project-level provider selection, least-privilege GitHub token,
GitHub.com/Enterprise config, generic commands, limits, data handling,
unsupported Jira behavior і troubleshooting. Провести opt-in test з read-only
GitHub token та Telegram acceptance для lookup, assigned list, project
switching, empty result, unavailable field і pagination.

**Готово, коли:** build/test/security suites зелені; acceptance не змінює
GitHub data; два projects із різною tracker configuration ізольовані; результати
записані в `docs/acceptance.md`, а всі відхилення мають окремі tasks.

**Документацію оновлено 2026-09-30:** README та acceptance checklist описують
GitHub.com/Enterprise setup, least-privilege token, generic commands, limits,
data handling і troubleshooting. Live acceptance позначено `NOT RUN`, бо в
environment немає opt-in read-only test token та authorized Telegram session.

**Live прогін 2026-09-30:** credential і direct read-only GitHub probes пройшли,
усі automated gates зелені, але adapter-level і Telegram lookup/listing
заблоковані помилкою GitHub.com base-path allowlist. Відхилення оформлено як
DEV-063; DEV-056 залишається відкритою до fix і повного повторного прогону.

**Виконано 2026-09-30 після DEV-063:** adapter і Telegram live recheck пройшли
assigned listing, equivalent numeric/hash lookup, PR rejection, absent optional
fields та switch/isolation з project без tracker. Усі live HTTP requests були
allowlisted `GET`; mutation не виконувалася. Поточний dataset не мав empty,
multi-page, private або Jira сценаріїв, тому їх позначено N/A live та підтверджено
відповідними automated/security tests. Build, 231 tests і 6 security tests зелені.

---

## Phase 7 — Agent-authored Bug Tracker issue creation

Issue creation є optional project-scoped capability і за замовчуванням
вимкнена. Read-only `IssueTracker` не розширюється write methods: mutation
виконує окремий provider-neutral port лише через gateway-owned policy та
confirmation. Agent не отримує GitHub token, HTTP client, довільний endpoint
або можливість самостійно обрати repository.

### [x] DEV-064 — Дозволити агенту сформувати й після confirmation створити issue

**Залежить від:** DEV-041, DEV-052–056. **Types/classes:** `IssueDraft`,
`IssueCreationProposal`, `IssueWriter`, `IssueCreationService`,
`GitHubIssueWriter`, доповнення agent event/output contract, project config,
confirmation flow і Telegram handler.

Додати flow, у якому agent на основі поточного task/session context сам формує
bounded draft issue, подібний до запису в `issues.md`:

- `summary` — короткий конкретний заголовок без local paths, secrets або raw
  exception payload;
- `description` — Markdown із секціями context/observed behavior, evidence або
  reproduction, expected behavior та acceptance criteria;
- неперевірені припущення позначаються явно; agent не вигадує logs, request IDs,
  affected versions чи кроки відтворення, яких не спостерігав;
- draft може запропонувати agent після виявлення окремого дефекту або на явний
  запит користувача, але не виконує mutation сам.

Agent повертає тільки typed `IssueCreationProposal`; gateway runtime-validates,
normalizes і redacts його, прив'язує до active user/project/provider та показує
користувачу точний preview `summary + description`. Створення дозволене лише
після explicit одноразового Telegram confirmation. `Deny`, expiry, forged/
replayed callback, project switch, restart без відновлюваного draft або зміна
configured tracker скасовують proposal без network request. До confirmation не
може бути жодного write call.

Не додавати `createIssue` до read-only `IssueTracker`. Окремий `IssueWriter`
експортує лише `createIssue(draft)` і повертає normalized reference/URL. Для
GitHub дозволити тільки fixed
`POST /repos/{configuredOwner}/{configuredRepository}/issues` з body
`{ title, body }`; labels, assignees, milestone, project fields, comments,
close/reopen/edit та інші mutations лишаються поза API. Origin/repository/API
version походять тільки з validated project config, redirects заборонені,
response bounded і runtime-validated.

Write capability має окремий explicit config flag/operation і окремий
environment-only `writeTokenEnv`; чинний read token не можна мовчки підвищувати
до write access. GitHub credential — fine-grained token, обмежений configured
repository, з `Issues: Read and write`, мінімальним expiration та organization
approval за потреби. Write token додається до redaction і ніколи не потрапляє в
agent input, project config value, storage, Telegram, error або URL.

Встановити hard limits щонайменше для summary, description і proposal lifetime;
відкидати control characters та застосовувати configured secret redaction до
preview/request. Draft body за замовчуванням не persist-ити: після restart
pending create confirmation стає invalid. Confirmation consume має бути
atomic/one-shot. `POST` не retry-ити автоматично: timeout/network failure після
відправлення є ambiguous outcome, тому gateway повідомляє перевірити tracker і
не створює можливий duplicate повторно.

**Готово, коли:**

- fake agent/contract tests доводять, що agent сам формує структуровані
  `summary`/`description`, а malformed/oversized або secret-bearing proposal не
  доходить до writer;
- handler/integration tests покривають preview, allow/deny/expiry, replay,
  wrong-user/wrong-project, switch/restart, disabled capability, unsupported
  provider та відсутній write credential;
- GitHub transport tests перевіряють рівно один fixed `POST` після confirmation,
  exact allowlisted JSON fields, GitHub.com/GHES, auth/permission/rate-limit,
  malformed/oversized response, abort і ambiguous timeout без automatic retry;
- security tests доводять, що prompt/Telegram input не може змінити provider,
  origin, repository, HTTP method або додати labels/assignees/comments, а read-
  only flows і projects без write capability не отримують mutation path;
- README/security/architecture описують opt-in write token, preview/
  confirmation, data lifetime, audit/error behavior і незмінно заборонені
  mutations;
- opt-in live acceptance у dedicated test repository створює рівно одне
  clearly labelled issue з agent-authored summary/description лише після
  `Allow`; `Deny` і повторний callback не змінюють tracker. Результат і ручне
  cleanup задокументовані без token або private issue body.

---

## Phase 8 — Universal local model providers for Codex

Локальна модель залишається inference backend для реального Codex agent, а не
окремим самописним агентом. `AgentManager`, Telegram handlers і domain
`CodingAgent` не повинні знати, чи модель виконується OpenAI, Ollama, LM Studio,
`llama.cpp` або іншим сумісним server. Межа сумісності цієї фази — OpenAI
Responses protocol, який фактично потрібен встановленій версії Codex: endpoint
має підтримувати `POST /v1/responses`, incremental SSE, terminal
`response.completed`, function/tool calls та коректне продовження діалогу.
Наявність лише `/v1/models`, `/v1/chat/completions` або однієї текстової
відповіді не вважається доказом сумісності.

Provider configuration є operator-owned і reusable між projects. Секрети не
записуються в JSON; project посилається на provider ID та задає model ID.
Відсутня agent configuration зберігає чинну поведінку з OpenAI Codex. Ollama і
LM Studio підтримуються як built-in Codex providers для стандартних local
defaults і через generic Responses provider для remote/custom endpoint.
`llama.cpp` використовує generic Responses provider лише якщо capability probe
підтвердив потрібний protocol; інакше потрібен окремий compatibility proxy, а не
прихований fallback на Chat Completions.

Цільова форма config (точні назви остаточно фіксуються в DEV-066):

```json
{
  "modelProviders": {
    "openai-default": {
      "type": "codex-builtin",
      "provider": "openai"
    },
    "ollama-local": {
      "type": "codex-builtin",
      "provider": "ollama"
    },
    "home-llama": {
      "type": "responses",
      "name": "Home llama.cpp",
      "baseUrl": "http://192.168.1.10:8080/v1",
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

### [ ] DEV-065 — Перевірити Codex Responses compatibility та remote `llama.cpp`

**Результат:** `docs/local-model-integration.md` із зафіксованими versions,
capability matrix і sanitized probe evidence.

Перевірити фактичний config surface встановлених `codex-cli` та
`@openai/codex-sdk`: `model`, `model_provider`, `model_providers`, `base_url`,
`wire_api`, environment-key authentication, streaming/retry settings і
поведінку resume. Окремо виконати read-only probes до operator-supplied
`llama.cpp` endpoint: discovery/health лише як diagnostics, реальний
`POST /v1/responses`, incremental SSE, terminal event, один harmless function
call, передавання tool result і наступний turn. Зафіксувати точні server/model
versions і не виводити API keys, приватні prompts або raw reasoning.

Для Ollama та LM Studio підтвердити обидва потрібні deployment modes:

- built-in Codex provider зі стандартним endpoint;
- generic Responses provider із explicit `baseUrl`, придатний для іншого host.

Якщо поточний `llama.cpp` не реалізує повний Codex-compatible Responses flow,
задокументувати точний gap і створити окрему задачу на вузький compatibility
proxy. Не маскувати несумісність переходом на Chat Completions і не починати
реалізацію proxy в цій задачі.

**Готово, коли:** один bounded diagnostic turn без filesystem mutation доводить
або спростовує сумісність remote `llama.cpp`; matrix окремо показує endpoint,
streaming, tools, continuation і auth для Ollama/LM Studio/`llama.cpp`; обраний
integration flow не суперечить фактичним CLI/SDK options.

### [ ] DEV-066 — Визначити generic model-provider configuration

**Залежить від:** DEV-065. **Types:** `ModelProviderConfig`,
`CodexBuiltinProviderConfig`, `ResponsesProviderConfig`, `ProjectAgentConfig`,
доповнення `ProjectConfig`/`ConfigLoader`.

Додати top-level reusable `modelProviders` і optional project-level `agent` з
provider reference та model ID. Підтримати discriminated providers:

- `codex-builtin`: тільки allowlisted `openai`, `ollama`, `lmstudio`;
- `responses`: bounded provider ID/name, absolute normalized `http`/`https`
  `baseUrl`, fixed `wireApi: responses` у runtime та optional `apiKeyEnv`.

Inline token, userinfo у URL, fragment, довільні headers/query parameters і
project-owned Codex TOML заборонити. `apiKeyEnv` є лише назвою environment
variable; її значення завантажується окремо, додається до redaction і ніколи не
потрапляє в typed project config, storage або errors. Дозволити plain HTTP лише
для loopback/private operator-owned network endpoint; public/non-local endpoint
має використовувати HTTPS. URL і provider ID не можуть надходити з Telegram.

Зафіксувати safe bounded defaults для request retries, stream retries та idle
timeout замість відкритого generic config passthrough. Missing `agent` має
мігрувати до нинішнього OpenAI Codex behavior без зміни існуючих config files.
Оновити `projects.example.json`, architecture і configuration documentation.

**Готово, коли:** validation tests покривають built-in і custom providers,
unknown/duplicate reference, malformed URL, URL credentials, unsafe public
HTTP, missing secret, unsupported wire API, bounded model/provider fields та
backward-compatible config без `modelProviders`/`agent`.

### [ ] DEV-067 — Параметризувати `CodexAdapter` і додати provider resolver

**Залежить від:** DEV-066. **Класи:** `ModelProviderResolver`,
`CodexClientFactory`, доповнення `CodexAdapter` та `Application` composition.

Прибрати hardcoded provider selection із composition root. Resolver має
перетворювати validated domain config у SDK-owned settings, не експортуючи
Codex types назовні:

- явно передавати model для new/resumed thread;
- для built-in provider явно задавати його Codex provider ID;
- для generic endpoint генерувати isolated custom `model_providers.<id>` із
  `base_url`, `wire_api = "responses"` і optional `env_key`;
- передавати child process лише чинний environment allowlist та рівно один
  referenced provider credential;
- зберегти locked-down sandbox, approval, network/search і protected-path
  settings незалежно від provider.

Не записувати generated provider config у shared `CODEX_HOME/config.toml`:
кожен adapter отримує explicit SDK config, щоб два projects могли одночасно
працювати з різними providers/models без state leakage. Помилки config/start/
stream мають містити safe provider ID, але не endpoint credentials або raw
response body.

**Готово, коли:** unit tests з fake SDK client перевіряють точний mapping для
OpenAI/Ollama/LM Studio/custom Responses, model propagation, credential
allowlisting/redaction, per-project isolation та незмінність security options;
існуючий OpenAI flow і всі його tests залишаються зеленими.

### [ ] DEV-068 — Прив'язати persisted session до provider/model identity

**Залежить від:** DEV-066–067. **Класи:** `AgentSession`, `SessionManager`,
storage schema migration.

Додати до persisted session stable non-secret agent identity: adapter kind,
provider ID, model ID і fingerprint нормалізованої non-secret provider config.
Thread ID не можна resume-ити через інший provider, endpoint, model або
repository. При config change старий thread зберігається лише як historical
metadata, позначається non-resumable, а наступний task створює новий thread із
явним user-visible diagnostic; не надсилати старий thread ID новому provider.

Зробити versioned storage migration для чинних schema-v1 sessions. Existing
sessions без identity можуть resume-итися тільки як legacy OpenAI sessions;
не приписувати їх локальному provider за припущенням. Restart recovery та
`WAITING_FOR_USER` мають застосовувати ту саму identity validation.

**Готово, коли:** migration/restart tests покривають legacy OpenAI session,
незмінний local provider, зміну model/base URL/provider, два projects на одному
endpoint, однаковий model на різних endpoints і заборону cross-provider resume.

### [ ] DEV-069 — Додати provider diagnostics без startup dependency

**Залежить від:** DEV-067. **Класи/файли:** typed diagnostic service і
operator-only probe command/script.

Gateway повинен стартувати й дозволяти status/stop/config diagnostics, навіть
коли remote inference host вимкнений. Не робити network health check blocking
startup dependency. Додати explicit operator probe, який для обраного provider
перевіряє DNS/connect/TLS/auth, Responses SSE lifecycle і harmless tool call із
bounded input/output/time. `/v1/models` можна показувати як додатковий signal,
але не як proof of Codex compatibility.

Нормалізувати unreachable, timeout, TLS, authentication, unknown model,
malformed SSE, missing terminal event, invalid tool call та protocol mismatch у
typed safe diagnostics. Raw provider body, URL credentials і secrets не
відправляти в Telegram/logs. Probe не отримує repository tools і нічого не
змінює у workspace.

**Готово, коли:** fake-server tests відтворюють кожен failure mode; application
успішно стартує з offline provider; probe чітко відрізняє network health від
повної Codex compatibility та завершується по timeout/abort.

### [ ] DEV-070 — Додати provider contract, integration і security tests

**Залежить від:** DEV-067–069.

Побудувати local fake Responses server із deterministic SSE fixtures і
запустити через нього реальний `@openai/codex-sdk`/bundled Codex CLI у temporary
Git repository. Перевірити new turn, tool request/result, command/file events,
completion, resume, stop та malformed/interrupted stream. Окремі table-driven
tests мають довести однакове config mapping для standard Ollama, LM Studio і
custom `llama.cpp` endpoints без runtime-specific branches у `AgentManager`.

Security regression suite має перевіряти, що Telegram/prompt/model output не
може змінити provider/base URL/model credential; provider A не бачить secret,
thread або response provider B; logs/storage/events не містять token чи raw
reasoning; endpoint не розширює чинні filesystem/command permissions Codex.

**Готово, коли:** tests проходять offline і детерміновано, використовують real
SDK/CLI boundary хоча б для одного full flow, покривають cancellation/recovery
та не потребують installed Ollama/LM Studio/`llama.cpp`.

### [ ] DEV-071 — Документація та live acceptance трьох local runtimes

**Залежить від:** DEV-070.

Оновити README, `.env.example`, `projects.example.json`, architecture, security
і acceptance docs. Описати local та LAN setup для Ollama, LM Studio і
`llama.cpp`, вимогу Responses/tool/SSE compatibility, model/context limits,
optional auth/TLS, firewall/bind правила, systemd network dependency,
troubleshooting і безпечний rollback на default OpenAI provider.

Провести opt-in live matrix на disposable Git repositories для кожного runtime:
provider/model detection, repository read, harmless command, small file patch,
completion, second-turn resume, `/stop`, gateway restart і project switching
між cloud/local providers. Для remote `llama.cpp` зафіксувати server/model
version та measured first-token/turn duration без prompt/file contents. Ollama
і LM Studio можуть працювати локально або на test host, але не позначати runtime
accepted лише через fake server або documentation claim.

**Готово, коли:** build/test/security suites зелені; live matrix явно має
PASS/FAIL/N/A для кожного runtime і capability; щонайменше configured remote
`llama.cpp` проходить повний Telegram → Codex → model → tools → result flow;
кожне runtime deviation оформлене окремою задачею, а default OpenAI flow не має
регресій.

---

## Phase 9 — Secure optional Web UI

Web UI стає повноцінним transport поряд із Telegram і використовує ті самі
application/domain services, operation policy, confirmations, project/session
isolation та agent events. Telegram більше не є обов'язковою runtime
залежністю: gateway може працювати як web-only, Telegram-only або з обома
transports одночасно. Принаймні один transport має бути enabled.

Перша версія Web UI розрахована на одного operator і не потребує нової БД.
Password verifier зберігається в `.env` як Argon2id hash або, якщо обрана
реалізація не має Argon2id, як параметризований scrypt hash; plaintext password,
reversible encryption і fast SHA hash не дозволяються. Authenticated web
sessions є opaque, random і process-local: restart gateway відкликає всі web
sessions. Чинний `JsonStorage` продовжує зберігати лише gateway domain state,
але не password, session cookie або CSRF secret.

У production browser-facing traffic дозволений тільки через HTTPS:

- `direct` mode — application сама слухає TLS із operator-owned certificate/key;
- `reverse-proxy` mode — application слухає лише loopback або Unix socket, а
  єдиний зовнішній listener належить explicitly trusted HTTPS reverse proxy.

Production не може bind-итися plain HTTP на LAN/public interface, довіряти
довільному `X-Forwarded-Proto` або запускатися без HTTPS public URL. Development
HTTP дозволений лише explicit opt-in на loopback і ніколи не є production
default.

Цільова форма environment config (точні назви фіксуються в DEV-074—076):

```dotenv
TELEGRAM_ENABLED=false

WEB_ENABLED=true
WEB_ENVIRONMENT=production
WEB_HOST=127.0.0.1
WEB_PORT=8443
WEB_PUBLIC_URL=https://agent.example.test
WEB_TLS_MODE=direct
WEB_TLS_CERT_PATH=/etc/codex-remote/tls/cert.pem
WEB_TLS_KEY_PATH=/etc/codex-remote/tls/key.pem
WEB_PASSWORD_HASH='$argon2id$v=19$...'
```

`reverse-proxy` mode не використовує application certificate/key, але вимагає
loopback/Unix bind, exact `WEB_PUBLIC_URL=https://...` і documented trusted
proxy boundary. `.env`, private key та інші secrets мають належати service user
і бути недоступними group/others.

### [ ] DEV-072 — Зафіксувати Web UI architecture і threat model

**Результат:** ADR у `docs/architecture.md` і Web-specific доповнення
`docs/security.md`.

Порівняти мінімальний Node HTTPS server та maintained web framework і вибрати
один bounded dependency set із schema validation, lifecycle/shutdown hooks,
request/body limits і predictable security behavior. Зафіксувати delivery
model UI (server-rendered або local static bundle), same-origin JSON API та SSE
для progress/events. Не використовувати CDN, remote fonts/scripts, third-party
analytics або client-side secrets. У першій ітерації не вводити окремий frontend
deployment/service.

Описати trust boundaries і threats: exposed agent control plane, password
guessing, session theft/fixation, CSRF, XSS через agent/Git/issue output,
clickjacking, Host-header poisoning, proxy-header spoofing, request smuggling/
oversized bodies, slow clients/SSE exhaustion, sensitive response caching,
cross-project leakage і bypass confirmation/policy через web routes.

Визначити route/use-case matrix для project selection, dashboard/status,
task/progress, question/answer, continue/stop, Git/diff/log, test, commit
preview/confirmation та Bug Tracker read/write capabilities. Web route не може
викликати нижчий privileged service, ніж еквівалентний Telegram flow.

**Готово, коли:** ADR обирає framework/rendering/SSE approach і пояснює
dependency/security trade-offs; threat model має mitigation для кожної межі;
route matrix вказує auth, CSRF, fresh-auth і confirmation requirements без
дублювання business logic у transport layer.

### [ ] DEV-073 — Ввести channel-neutral actor і application use cases

**Залежить від:** DEV-072. **Types/classes:** `ActorId`, `ActorContext`,
application-level project/task/git/test/confirmation use cases, event hub.

Прибрати Telegram numeric user ID та Telegram transport types із reusable
project selection, pending question ownership, task ownership і confirmation
boundaries. Ввести bounded canonical actor identity на кшталт
`telegram:<numeric-id>` та `web:operator`, а для browser authorization додатково
bind-ити sensitive pending action до opaque web session/security-context ID.
Не використовувати client-supplied actor ID.

Винести orchestration з Telegram handlers у transport-neutral use cases, щоб
Telegram handlers і Web routes були тонкими adapters над однаковими validation,
policy, concurrency, confirmation та error semantics. Додати process-local
bounded `AgentEventHub`: task events мають owner/origin metadata, SSE subscriber
не бачить events іншого actor/project, а Telegram progress reporting продовжує
працювати без Web UI.

Зробити versioned migration persisted active-project/confirmation records.
Legacy numeric Telegram owners мають однозначно мігрувати в `telegram:<id>`.
Pending web confirmation не переживає restart або auth-session rotation навіть
якщо domain confirmations загалом persistent.

**Готово, коли:** Telegram regression tests проходять через нові use cases;
actor A не може читати/answer/confirm action actor B; migration зберігає чинні
Telegram selections; fake Web adapter може пройти select → task → events →
result без імпорту з `src/telegram`.

### [ ] DEV-074 — Зробити Telegram і Web незалежно optional transports

**Залежить від:** DEV-073. **Класи:** доповнення `AppConfig`/`ConfigLoader`,
`ApplicationTransport`, refactor `Application` composition root.

Додати explicit `TELEGRAM_ENABLED` і `WEB_ENABLED`. Для backward compatibility
відсутній `TELEGRAM_ENABLED` з чинними Telegram variables зберігає сьогоднішню
поведінку; web-only deployment явно задає `TELEGRAM_ENABLED=false` і не потребує
`TELEGRAM_BOT_TOKEN` або `TELEGRAM_ALLOWED_USER_IDS`. Якщо Telegram enabled,
обидві змінні залишаються mandatory та проходять ту саму validation. Якщо Web
enabled, його auth/TLS config mandatory відповідно до environment/mode. Config
із двома disabled transports відхиляється.

`Application` має створювати список enabled transports, стартувати їх із
rollback уже запущених при partial failure, а на SIGINT/SIGTERM ідемпотентно
зупиняти HTTP/SSE acceptance, Telegram polling, active agents і storage у
визначеному порядку. Web-only composition не створює `TelegramBot`, Telegram
handlers/keyboards або Telegram `ProgressReporter`.

**Готово, коли:** config/composition tests покривають legacy Telegram-only,
explicit Telegram-only, Web-only без Telegram secrets, обидва transports,
partial invalid config, обидва disabled, failure другого transport і graceful
shutdown без leaked listener/process.

### [ ] DEV-075 — Реалізувати password authentication і in-memory web sessions

**Залежить від:** DEV-072, DEV-074. **Класи:** `PasswordVerifier`,
`WebSessionStore`, `WebAuthService`, login/logout routes і password-hash CLI.

Додати operator command, який читає password із hidden TTY/stdin, генерує
versioned Argon2id або scrypt hash і друкує тільки verifier для вставлення у
`WEB_PASSWORD_HASH`. Password не приймати CLI argument, не писати в shell
history/log/storage і не повертати browser після submit. Валідувати algorithm,
salt, parameters і bounded encoded length під час startup; verification має
мати однакову generic failure response і safe comparison behavior.

Login захистити per-source та global rate limits, bounded exponential delay,
maximum concurrent verification, audit events без password/IP disclosure і
однаковою відповіддю для malformed/wrong credential. Client IP брати з socket;
proxy headers враховувати лише в explicit trusted reverse-proxy mode. Не
блокувати назавжди єдиного operator: limits мають автоматично відновлюватися й
мати documented local recovery через service restart/config change.

Після login видати щонайменше 256-bit opaque session ID, rotate його при
authentication, зберігати server-side лише process-local session state і
надсилати cookie `__Host-...; Secure; HttpOnly; SameSite=Strict; Path=/` без
`Domain`. Встановити idle та absolute TTL, bounded sessions, logout/revoke-all,
constant-time lookup where practical і cleanup expired sessions. Session/token
не зберігати у `localStorage`, URL, logs або `JsonStorage`; logout надсилає
`Clear-Site-Data` і `Cache-Control: no-store`.

**Готово, коли:** tests покривають correct/wrong/malformed hash, timing-safe
verification boundary, rate limiting, session fixation/rotation, idle/absolute
expiry, logout, restart revocation, cookie attributes, bounded session cleanup
і redaction; жоден test capture не містить plaintext password/session ID.

### [ ] DEV-076 — Реалізувати HTTPS-only production WebServer

**Залежить від:** DEV-074–075. **Клас:** `WebServer`, TLS/proxy configuration,
security middleware.

У `direct` mode читати certificate/key лише з validated absolute paths,
відхиляти unreadable/invalid certificate, encrypted key без configured flow та
private key, доступний group/others. Не запускати окремий plaintext redirect
listener. У `reverse-proxy` mode дозволити тільки loopback address або Unix
socket; не дозволяти `0.0.0.0`, LAN bind чи forwarded headers від недовіреного
peer. Exact HTTPS `WEB_PUBLIC_URL` визначає allowed Host/Origin і URL generation.

Production startup має fail closed, якщо request path до browser може бути
plain HTTP. Development HTTP потребує explicit environment flag, bind-иться
лише на loopback, показує warning і не може reuse production cookie/config
profile. Додати HSTS у production (без автоматичного `includeSubDomains`),
Content-Security-Policy без inline/eval/remote sources, `frame-ancestors 'none'`,
`X-Content-Type-Options: nosniff`, restrictive Referrer/Permissions policies та
`Cache-Control: no-store` для auth/API/sensitive HTML.

Встановити allowlisted methods/content types, JSON/form/body/header/URL limits,
request/header/keep-alive timeouts, connection/SSE caps та graceful drain.
CORS не вмикати: API є same-origin. Unauthenticated health endpoint, якщо
потрібний systemd/proxy, повертає лише bounded liveness без version, paths,
projects, model/provider або readiness secrets.

**Готово, коли:** integration tests доводять direct TLS, trusted loopback proxy,
Host/Origin validation і security headers; production відмовляється стартувати
з HTTP/public bind, missing TLS, insecure key permissions або spoofed forwarded
headers; slow/oversized/malformed requests bounded і не блокують shutdown.

### [ ] DEV-077 — Реалізувати authenticated Web dashboard та read/task flow

**Залежить від:** DEV-073, DEV-075–076.

Додати responsive same-origin UI з local assets для login, project selection,
dashboard, status, task input, live progress, final result, question/answer,
continue/stop, Git status/diff, tests, task log і read-only Issue Tracker.
Server/API віддає тільки normalized view models: не exposing canonical local
paths, credentials, full env, raw exceptions, raw reasoning або unrestricted
command output. Встановити ті самі bounded text/diff/log limits, що й для
Telegram, із download лише через authenticated one-shot/bounded response.

Для live updates використати authenticated same-origin SSE з heartbeat,
disconnect cleanup, per-session/project authorization, connection cap і
bounded replay cursor. Browser reconnect не повинен повторно запускати task або
mutation. Task POST повертає opaque task/run reference, а events фільтруються
server-side за actor/project. UI не використовує `innerHTML` для untrusted
agent/Git/issue content; Markdown або не render-иться, або проходить strict
allowlist sanitizer без raw HTML/URLs.

Усі state-changing routes використовують non-GET methods, exact Origin check,
session-bound synchronizer CSRF token і expected content type. `SameSite` cookie
є лише defense in depth, не заміна CSRF validation. Unknown fields відхиляються
runtime schemas; project/provider/path/command executable не приймаються з
browser, а вирішуються з operator-owned config.

**Готово, коли:** route/UI tests проходять login → select → task → progress →
question/answer → result, continue/stop, diff/test/log та read-only issue flow;
refresh/SSE reconnect не дублює operation; unauthorized/cross-project/CSRF/
wrong-origin requests не викликають service side effects; XSS fixtures
відображаються як inert text.

### [ ] DEV-078 — Додати Web confirmations і step-up authentication

**Залежить від:** DEV-073, DEV-077.

Реалізувати exact preview та Allow once/Deny для confirmation-required
operations, включно з commit та agent-authored issue creation. Web confirmation
bind-иться до actor, project, operation payload hash, auth session/security
context, CSRF token і short expiry; project switch, logout, password verifier
change, session rotation, restart або replay роблять її invalid. Preview та
execute використовують один immutable server-side payload; browser не може
підмінити commit message, issue body, repository або provider після preview.

Для commit і зовнішньої write mutation вимагати fresh authentication: session
має бути не старша configured short interval або operator повторно вводить
password у step-up form. Password перевіряється тим самим verifier, не
persist-иться й не стає частиною confirmation record. Deny/expired/stale request
не має side effects. Automatic retry ambiguous external write заборонений так
само, як у Telegram flow.

**Готово, коли:** integration/security tests покривають allow/deny, wrong actor/
project/session, CSRF, stale preview, payload tampering, expiry, replay, logout,
restart, password rotation, fresh-auth expiry і concurrent tabs; Telegram і Web
викликають одну operation policy/confirmation implementation.

### [ ] DEV-079 — Провести Web security і resilience regression review

**Залежить від:** DEV-075–078.

Додати focused tests для password brute force/resource exhaustion, session
fixation/theft boundary, CSRF, reflected/stored/DOM XSS, CSP, clickjacking,
Host-header/proxy spoofing, method/content-type confusion, cache leakage,
oversized/slow requests, SSE fan-out/reconnect storms, cross-project/actor data
leakage та shutdown із active HTTP/SSE/agent operations. Перевірити dependency
audit і production error responses без stack/path/config disclosure.

Усі state-changing Web API paths мають пройти authorization-policy matrix:
authenticated session недостатня для forbidden operation, а UI-hidden control
не є authorization boundary. Перевірити, що Web не додає arbitrary shell, file,
URL/provider або generic HTTP escape hatch і не послаблює наявний Codex sandbox.
Password hash, session/CSRF tokens, TLS private key material, Telegram/GitHub/
model credentials не повинні потрапити в browser bundle, HTML, API, SSE, logs,
storage, diagnostics чи crash errors.

**Готово, коли:** focused Web security suite зелений; route inventory не має
unclassified endpoint; dependency/license findings задокументовані; fault
injection не залишає listener, session, confirmation, subscriber або agent lock;
`npm run build`, full tests і existing security suite проходять.

### [ ] DEV-080 — Deployment docs і live Web-only acceptance

**Залежить від:** DEV-079.

Оновити README, `.env.example`, architecture/security/acceptance docs і systemd
assets. Документувати password-hash generation/rotation/recovery, `.env` mode
`0600`, direct certificate/key deployment і renewal, loopback reverse-proxy
setup, firewall, HSTS, session expiry/restart behavior, Telegram optional mode,
backup/update/rollback і troubleshooting без виведення secrets. Додати
production-ready example для direct TLS та один minimal HTTPS reverse proxy;
example hostnames/password hashes/certificates не можуть бути придатними
production credentials.

Провести live acceptance у реальному browser/mobile viewport:

- `WEB_ENABLED=true`, `TELEGRAM_ENABLED=false`, Telegram token/user IDs повністю
  відсутні — application стартує й виконує повний agent flow;
- production direct TLS або trusted HTTPS reverse proxy приймає browser тільки
  через valid HTTPS, а HTTP/public backend/proxy spoofing відхиляються;
- wrong-password throttling, login/logout, cookie/session expiry, restart
  revocation, CSRF rejection і fresh-auth confirmation працюють;
- project select, task/progress/question/answer/result, stop, diff/test/log,
  commit deny/allow та issue read/write policy проходять без Telegram;
- Telegram-only legacy flow і simultaneous Web+Telegram flow не мають
  regressions або cross-channel event/confirmation leakage.

**Готово, коли:** Web-only production acceptance не використовує Telegram
credentials, client-facing traffic підтверджено тільки HTTPS, security headers
і cookies перевірені browser/network inspection, full build/test/security gates
зелені, а всі deviations оформлені окремими tasks.

---

Issue history and defect verification are tracked separately in `issues.md`.

## Контрольні точки

- **Після DEV-016:** Phase 1 MVP — Telegram → project → real Codex → result.
- **Після DEV-025:** sessions переживають restart, працює двосторонній діалог.
- **Після DEV-034:** доступні Git/status/diff/test/stop і повний dashboard.
- **Після DEV-041:** task history, confirmations і commit є persistent та safe.
- **Після DEV-048:** виконано повний Definition of Done.
- **Після DEV-056:** generic Bug Tracker flow з першим GitHub provider пройшов
  live read-only acceptance.
- **Після DEV-064:** agent може запропонувати й після explicit confirmation
  створити bounded issue у configured tracker без доступу до довільних writes.
- **Після DEV-071:** один typed provider config підтримує OpenAI, Ollama,
  LM Studio і compatible remote `llama.cpp`; session identity ізольована, а
  live local-runtime matrix задокументована.
- **Після DEV-080:** gateway проходить Web-only production acceptance без
  Telegram secrets, підтримує optional Telegram/Web transports і віддає Web UI
  лише через validated HTTPS deployment із password/session/CSRF protections.
- **Після DEV-057—062:** повторна DEV-048 acceptance не має
  encoding/stop/test-output/question-flow regressions; details у `issues.md`.

## Поза поточним scope

- Docker і керування IntelliJ GUI.
- Власний LLM tool loop замість реального Codex; local models у Phase 8
  використовуються тільки як Codex inference providers.
- Автоматичний model routing/fallback за prompt, latency або quality; provider
  обирається operator-owned project config.
- Multi-user accounts, roles, OAuth/OIDC, password reset email і persistent web
  sessions; Phase 9 має одного operator та process-local sessions.
- PostgreSQL до появи реальної потреби в ньому.
- Автоматичні `git push`, `reset --hard`, `clean` або discard changes.
- Доступ Telegram-користувача до довільної файлової системи чи shell command.
- Bug Tracker edit/transition/comment/assign/attach/worklog та будь-який create
  поза explicit DEV-064 confirmation flow.
- Реалізація `JiraAdapter` (provider type зарезервовано для наступної ітерації).
