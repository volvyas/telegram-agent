# Live acceptance

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
