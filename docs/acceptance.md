# Live acceptance

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
