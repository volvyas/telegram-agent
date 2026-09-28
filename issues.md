# Issues

Product defects are tracked here separately from the implementation plan in
`tasks.md`. Status, investigation notes, acceptance criteria, and verification
history are preserved under their original IDs.

## Live acceptance defects

### [x] DEV-057 — Виправити UTF-8 encoding у `/diff`

**Виявлено під час DEV-048, 2026-09-24.** У live Telegram flow `/diff` створив
file з некоректним encoding; український текст відображався пошкоджено.

Спочатку відтворити окремо inline diff і великий diff, що надсилається як
`changes.diff`. Простежити bytes/decoding через Git process output,
`ProcessRunner`, `GitService`, `MessageSender` і Telegram upload. Не маскувати
помилку заміною non-ASCII символів або lossy conversion.

**Очікувана поведінка:** українські тексти, Unicode filenames і змішаний
ASCII/Unicode content доходять до Telegram та downloaded diff file як valid
UTF-8 без mojibake, replacement characters або втрати bytes.

**Готово, коли:** regression tests покривають inline/document delivery,
chunk boundaries, Cyrillic content і filenames; downloaded bytes decode як
UTF-8 та збігаються з Git diff; live `/diff` на телефоні відображається коректно.

**Виконано 2026-09-25:** inline diff зберігає Unicode boundaries, generated
documents мають UTF-8 BOM та explicit UTF-8 caption, а bounded process capture
не розрізає multibyte code points. Додано byte-level Cyrillic regressions;
повторна перевірка на телефоні залишається частиною DEV-048 acceptance.

### [x] DEV-058 — Зробити `/stop` фактичною зупинкою active Codex task

**Виявлено під час DEV-048, 2026-09-24.** Під час task із проханням порахувати
від 1 до 1000 команда `/stop` не припинила виконання: agent продовжив рахувати
до завершення.

Відтворити race для stop до отримання run ID, під час streamed events і близько
terminal event. Перевірити повний cancellation path Telegram handler →
`AgentManager` → `CodingAgent`/SDK `AbortSignal`, припинення progress updates,
state transition, persistence і звільнення per-project lock/process resources.

**Очікувана поведінка:** `/stop` швидко підтверджує cancellation, active turn
перестає генерувати output/tool work, terminal state стає `STOPPED`, а пізній
`completed` event не може перезаписати stop. Наступну task можна запустити без
restart gateway.

**Готово, коли:** deterministic blocking-agent tests покривають усі race windows
і відсутність events після stop; opt-in real Codex/Telegram test з довгою task
зупиняється в bounded time та не доходить до normal completion.

**Виконано 2026-09-25:** long polling переведено на official concurrent grammY
runner, тому `/stop` обробляється паралельно з long task; adapter завершує event
stream одразу після abort, а manager синтезує authoritative STOPPED і відкидає
late completion. Покрито stop до run ID, active stream і abort-ignoring iterator;
повторна перевірка з real Codex залишається у DEV-048.

### [x] DEV-059 — Спростити й очистити результат `/test`

**Виявлено під час DEV-048, 2026-09-24.** Live `/test` надсилає майже raw output
test runner. ANSI escape/control sequences відображаються як `[1m`, `[30m`,
`[46m`, `[39m` тощо; службовий banner, absolute working directory і terminal
formatting роблять повідомлення нечитабельним.

Додати окреме форматування test result перед Telegram delivery. Видаляти ANSI
CSI/OSC та інші небезпечні terminal control sequences, не показувати absolute
local paths і boilerplate runner. Із підтримуваного output виділяти bounded
список test suite/file names, status і за наявності кількість tests. Raw cleaned
output залишити лише як fallback/document для діагностики failed або
нерозпізнаного runner, без дублювання у звичайному success message.

**Очікуваний формат:** короткий human-readable результат, наприклад:

```text
Tests: passed
✓ ConfirmationService.test.ts — passed (3 tests)
✓ MessageSender.test.ts — passed (6 tests)
✓ SecurityRegression.test.ts — passed (6 tests)
```

Для failures показувати `✗ <test name> — failed` і коротку sanitized причину;
повний bounded log можна надіслати окремим UTF-8 document.

**Готово, коли:** fixtures/tests покривають Vitest output з colors, no-color
output, mixed stdout/stderr, Unicode names, passed/failed/skipped suites,
malformed output і maximum list size; Telegram messages не містять ANSI/control
codes чи local absolute paths; live `/test` показує лише назву тесту та результат.

**Виконано 2026-09-25:** configured commands примусово запускаються без color,
новий formatter видаляє ANSI/OSC/control codes і repository path, розпізнає
Vitest/Maven suites та надсилає `name — status`; bounded sanitized diagnostics
для failures ідуть окремим UTF-8 document. Реальний npm suite сформував 40
читабельних рядків без raw output; phone recheck залишається у DEV-048.

### [x] DEV-060 — Виправити live question/answer delivery

**Виявлено під час повторної DEV-048 acceptance, 2026-09-25.** Реальний Codex
повернув валідний structured outcome `{ "kind": "question", ... }`. Telegram
спочатку показав raw JSON, потім окреме `Task failed.` і не показав inline
buttons. Водночас persisted session коректно перейшла у `WAITING_FOR_USER` та
зберегла question і обидва choices, але task history отримала status `failed`.

Відтворити реальний порядок Codex SDK events і простежити terminal question
через `CodexEventMapper` → `AgentManager.startTask`/task history → `TaskHandler`.
Не показувати structured control JSON як progress/output. Question turn не має
потрапляти у generic failure path після успішного переходу до
`WAITING_FOR_USER`; keyboard будується лише після узгодженого persisted state.

**Очікувана поведінка:** Telegram показує `Task needs input.` з текстом питання
та buttons `Option A`/`Option B`, task має status `waiting_for_user`; вибір
продовжує той самий Codex thread і завершується одним зрозумілим результатом.

**Додаткове спостереження:** manual fallback `/answer Option A` успішно
продовжив той самий persisted thread і session стала `COMPLETED`, але
`TASK-0002` залишилася `failed` та не отримала завершення після відповіді.

**Готово, коли:** regression test з реалістичною послідовністю Codex SDK events
відтворює defect, handler/integration tests перевіряють відсутність raw JSON і
generic failure, наявність inline keyboard, persisted `waiting_for_user` та
успішне question → answer → completed; live Telegram/Codex recheck зелений.

**Live перевірено 2026-09-28:** question показано без raw JSON, обидві inline
choices доступні, `Option A` продовжила той самий thread без false failure;
session і `TASK-0002` завершились як `COMPLETED`/`completed`.

### [x] DEV-061 — Не надсилати хибний failure після успішного `/continue`

**Виявлено під час повторної DEV-048 acceptance, 2026-09-25.** Після switch на
другий project, повернення до `telegram-agent` і `/continue` користувач отримав
коректний continuation result, а наступним Telegram message — `Task failed.`.
Persisted session при цьому стала `COMPLETED`, той самий thread збережено, а
відповідна `TASK-0005` має status `completed`; backend failure не зафіксовано.

Відтворити update/message ordering із concurrent grammY runner, включно з late
reply від попередньої stopped/failed operation, routing command як text і
parallel project updates. Додати correlation між Telegram update, operation та
terminal reply, щоб stale handler не міг надіслати generic failure після
успішного terminal result іншої operation.

**Очікувана поведінка:** `/continue` після project switching надсилає рівно один
terminal outcome, узгоджений із persisted session/task status; після успішного
result немає `Task failed.`, `Unable to continue...` чи інших stale replies.

**Готово, коли:** deterministic concurrency/integration test відтворює порядок
live updates, перевіряє єдиний terminal reply та його відповідність storage;
live switch → `/continue` recheck не створює додаткового failure message.

**Live перевірено 2026-09-28:** switching і `/continue` повернули один коректний
terminal result без наступного `Task failed.`; post-restart `/continue` також
завершився cleanly.

### [x] DEV-062 — Відновити відповідь `/start` після gateway restart

**Виявлено під час повторної DEV-048 acceptance, 2026-09-25.** Після clean
gateway stop/start команда `/start` на телефоні не дала жодної відповіді. Інші
команди (`/status`, `/continue`) після того самого restart працювали. Storage
містив valid active project `telegram-agent`, обидві sessions/thread IDs і task
history; gateway process та polling залишались active.
Gateway зафіксував redacted handling error `ERR-730c92a9cecf4ac0`
(`diagnosticId: ERR-8b529d1cae8542f2`) для цього live window.

Простежити конкретний Telegram update через concurrent runner, auth middleware,
`CommandRouter` і `ProjectHandler.handleStart` до dashboard reply. Перевірити
відновлений active project, побудову dashboard keyboard, Telegram API error і
redacted diagnostic correlation. Silent catch/log без зрозумілої відповіді
користувачу не вважати коректною поведінкою.

**Очікувана поведінка:** кожен authorized `/start`, зокрема перший після restart,
повертає project selector або dashboard активного project; callback buttons
валідні й команда не впливає на persisted session/task state.

**Готово, коли:** restart integration test із persisted active project перевіряє
dashboard reply і keyboard, failure-path test дає safe user-visible error та
diagnostic ID, а live restart → `/start` стабільно відповідає на телефоні.

**Live перевірено 2026-09-28:** `/start` відповів на fresh state і після clean
gateway restart, показавши restored `telegram-agent` dashboard; `/status` та
`/continue` підтвердили збереження session/task state.
