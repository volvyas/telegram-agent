# Live acceptance

## DEV-056 — GitHub read-only acceptance, 2026-09-30

Статус: **PASS — DEV-063 виправлено й перевірено live**.

Прогін виконано з configured fine-grained GitHub token і authorized Telegram
session. Automated gates зелені. Контрольні прямі read-only GitHub probes
підтвердили credential та API: `GET /user` і fixed assigned search повернули
`200`, selected API version `2026-03-10`, search знайшов один assigned issue без
next page. `GET` issue `#1` повернув GitHub pull request, тому цей reference не є
придатним positive issue fixture. Жоден live probe не використовував write
method або mutation endpoint.

Після DEV-063 реальний `GitHubIssueTracker` успішно виконав authenticated user,
assigned search і два direct lookups через GitHub.com root API base. Recorded
transport evidence: чотири allowlisted `GET`, усі `200`; `3` і `#3` дали
ідентичний normalized issue з коректно відсутніми optional fields. Telegram
показав `/issue mine`, обидві форми positive lookup і safe disabled-state після
switch на project без tracker. Для `1` і `#1` Telegram повернув `That reference
is a pull request`, що є очікуваним defense-in-depth результатом для GitHub PR.

### Підготовка без mutation

1. Створити fine-grained token із мінімальним expiration, одним resource owner
   і одним repository; надати лише `Issues: Read-only`.
2. Додати token до локального `.env` під exact `tokenEnv` із `projects.json`;
   не записувати його в acceptance log, command line, Git remote або fixtures.
3. Налаштувати два projects із різними tracker configurations, включно з
   project без tracker; для private repository перевірити тільки дозволений
   read access.
4. Запустити gateway з clean runtime state і authorized Telegram user.

### Manual acceptance checklist

| # | Check | Expected result | Status |
|---:|---|---|---|
| 1 | `/issue <number>` and `/issue #<number>` | Same normalized read-only issue from active configured repository | PASS — `3`/`#3` identical; `1`/`#1` consistently and correctly identified as pull request |
| 2 | `/issue mine` | Fixed open assigned-to-authenticated-account query | PASS — one assigned issue shown in Telegram |
| 3 | Empty assigned result | Safe empty-state message | N/A live — current account has one assigned issue; automated empty-result coverage passes |
| 4 | Multiple assigned results | Stable bounded page with next/previous opaque buttons | N/A live — current dataset has one item; automated multi-item coverage passes |
| 5 | Pagination | Only configured project/provider/user can use callback; stale/forged callback rejected | N/A live — GitHub returned no next link; pagination and callback-isolation tests pass |
| 6 | Switch to second project | Repository, token/provider and results remain isolated | PASS — switch to `base-proto` returned tracker-not-configured instead of GitHub data |
| 7 | Missing optional fields | Plain normalized output without `undefined`, HTML or raw JSON | PASS — live `#3` omitted three absent optional fields cleanly |
| 8 | Private repository | Read succeeds only with scoped token; forbidden/not-found is generic | N/A — configured acceptance repository did not exercise a separate private-access scenario; permission/error mapping tests pass |
| 9 | Unsupported Jira project | Safe unsupported-provider message; no request is made | N/A live — no Jira project configured; resolver/handler no-request tests pass |
| 10 | GitHub state after run | No issue mutation, comment, label, assignment or other write observed | PASS — recorded live probes used only `GET` against `/user`, `/search/issues` and one issue endpoint |

Automated DEV-056 gates on this checkout: `npm run typecheck`, `npm run lint`,
`npm run build`, all 231 tests and all 6 focused security tests pass under the
configured Node 24 runtime.

## DEV-048 — повторний прогін 2026-09-28

Середовище: реальний Telegram на телефоні, реальний Codex, gateway на локальному
ноутбуці та clean runtime state. Попередній state збережено в
`data.acceptance-backup-20260928`. Загальний результат: **PASS — 16/16**.

| # | Definition of Done | Результат | Live evidence |
|---:|---|---|---|
| 1 | Запустити gateway | PASS | Gateway запущено з clean state, cleanly перезапущено наприкінці. |
| 2 | Відкрити Telegram на телефоні | PASS | Усі manual checks виконано на телефоні. |
| 3 | Виконати `/start` | PASS | Project selector з'явився на fresh start; dashboard відповів і після restart. |
| 4 | Вибрати repository | PASS | `telegram-agent` вибрано, dashboard показано. |
| 5 | Написати coding task | PASS | Real Codex task створено й persisted як `TASK-0001`. |
| 6 | Побачити progress | PASS | Progress показано до terminal result. |
| 7 | Отримати результат | PASS | Architecture task повернув один clean final result. |
| 8 | Попросити агента щось уточнити | PASS | Structured question показано human-readable, без raw JSON, з двома buttons. |
| 9 | Відповісти агенту з Telegram | PASS | `Option A` продовжила той самий thread; `TASK-0002` стала `completed`. |
| 10 | Побачити зміни через `/diff` | PASS | Український/Unicode content читабельний inline і в document. |
| 11 | Запустити `/test` | PASS | Concise suite names/results без ANSI fragments і зайвих local paths. |
| 12 | Зупинити agent через `/stop` | PASS | Counting task зупинено promptly; history має `stopped`, late completion не було. |
| 13 | Перемкнутися на інший project | PASS | Перемикання project перевірено на телефоні в спільному Phase 4/5 сценарії. |
| 14 | Повернутися й продовжити session | PASS | `/continue` повернув correct result без trailing `Task failed.`; повторено після restart. |
| 15 | Підтвердити або відхилити небезпечну операцію | PASS | `/commit` очікував confirmation; Deny скасував operation, HEAD не змінився. |
| 16 | Restart без втрати project/session/task state | PASS | Active project, thread і task history відновлено; `/start`, `/status`, `/continue` працюють. |

Cross-project storage inspection було пропущено за прямою вказівкою користувача,
оскільки switching/continuation уже перевірено на телефоні в межах Phase 4;
post-restart persistence основного project додатково підтверджено storage state.

Regression defects DEV-057—062 пройшли live recheck. Нових відхилень не
виявлено; окремі defect tasks не потрібні.

Automated gates:

- `npm run build` — PASS.
- `npm test` — PASS: 40 test files, 196 tests.

## DEV-048 — повторний прогін 2026-09-25

Середовище: реальний Telegram на телефоні, реальний Codex, gateway на локальному
ноутбуці, repositories `telegram-agent` і `base-proto`. Прогін почато з чистого
runtime state; попередній каталог збережено як локальний acceptance backup.

Загальний результат: **не пройдено**. Базові task, repository commands,
cancel, switching, confirmation denial і persistence працюють, але DoD не може
бути зеленим через DEV-060, DEV-061 і DEV-062. DEV-048 залишається відкритою.

| # | Definition of Done | Результат | Live evidence |
|---:|---|---|---|
| 1 | Запустити gateway | PASS | Gateway запущено, потім cleanly зупинено й запущено новим process. |
| 2 | Відкрити Telegram на телефоні | PASS | Усі manual кроки виконано з телефона. |
| 3 | Виконати `/start` | FAIL | На початку flow працювало; перший `/start` після restart не дав відповіді. DEV-062. |
| 4 | Вибрати repository | PASS | Вибір і persisted active project перевірено для двох repositories. |
| 5 | Написати coding task | PASS | Реальний Codex task створено й записано в history. |
| 6 | Побачити progress | PASS | Start/progress delivery підтверджено на телефоні. |
| 7 | Отримати результат | PASS | Звичайний task повернув коректний final result. |
| 8 | Попросити агента щось уточнити | FAIL | Structured question збережено, але Telegram показав raw JSON, потім `Task failed.`, без buttons. DEV-060. |
| 9 | Відповісти агенту з Telegram | PARTIAL | `/answer Option A` продовжив той самий thread і дав `Option A selected`, але task history залишилась `failed`. DEV-060. |
| 10 | Побачити зміни через `/diff` | PASS | Inline/document output та український текст читабельні; DEV-057 live regression пройдено. |
| 11 | Запустити `/test` | PASS | Показано спрощені назви/results без ANSI fragments; DEV-059 live regression пройдено. |
| 12 | Зупинити agent через `/stop` | PASS | Long counting task швидко зупинено, history має `stopped`, normal completion не прийшов; DEV-058 live regression пройдено. |
| 13 | Перемкнутися на інший project | PASS | Перемикання `telegram-agent` → `base-proto` → `telegram-agent` працює. |
| 14 | Повернутися й продовжити session | FAIL | Correct continuation result і persisted `completed` отримано, але після нього прийшло хибне `Task failed.`. DEV-061. |
| 15 | Підтвердити або відхилити небезпечну операцію | PASS | `/commit` не виконався до confirmation; Deny прибрав pending confirmation, HEAD не змінився. |
| 16 | Restart без втрати project/session/task state | PARTIAL | Active project, два thread IDs і task history відновлено; `/status` та `/continue` працюють. Після restart `/start` мовчить (DEV-062), а continuation UX має DEV-061. |

## Виявлені дефекти

- **DEV-060:** question lifecycle/inline keyboard — raw control JSON, false
  failure, відсутні buttons та inconsistent task history.
- **DEV-061:** false `Task failed.` після успішного `/continue` при коректному
  persisted `COMPLETED`/`completed` state.
- **DEV-062:** `/start` не відповідає після gateway restart, хоча інші commands
  і restored state працюють.

## Перевірені виправлення попереднього прогону

- **DEV-057:** `/diff` доставляє український/Unicode content читабельно.
- **DEV-058:** `/stop` реально перериває active task.
- **DEV-059:** `/test` показує human-readable suite names/results без terminal
  escape sequences.

Після виправлення DEV-060—062 потрібен повний повторний DEV-048 live прогін, а
не лише focused checks, бо дефекти пов'язані з ordering, restart і terminal
Telegram replies.

## Automated gates

- `npm run build` — PASS.
- `npm test` — PASS: 40 test files, 191 tests.
