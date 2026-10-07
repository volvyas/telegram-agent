# Issues

Product defects are tracked here separately from the implementation plan in
`tasks.md`. Status, investigation notes, acceptance criteria, and verification
history are preserved under their original IDs.

## Live acceptance defects

### [ ] DEV-085 — Скорочувати історію до вичерпання контексту local provider

**У роботі, offline milestone 2026-10-07:** додано validated `agent.context`
(window/output reserve/safety margin), mapping у native Codex context/compaction
settings та real CLI/SDK tests із loopback provider: threshold, cached usage,
mid-turn tool history, restart/resume, failed compaction і stop. Для custom
provider перевірений tool-free summarization через `/v1/responses`, не окремий
`/responses/compact`. Production config не змінено. Залишаються hard preflight
для oversized single input/result, context-specific recovery diagnostic та
live acceptance на llama.cpp; задача не закрита. Деталі й checklist —
`docs/local-model-integration.md`, розділ DEV-085.

**Підстава, 2026-10-07:** у trace
`95dd95da-2604-4b7d-a861-cfc3cf7ab53c` відповідь HTTP 200 містить
`input_tokens=31613`, `output_tokens=1155`, `total_tokens=32768` та незавершені
аргументи tool call. Capture не обрізаний, SHA-256 response збігається.
Точне заповнення configured 32k context є сильним свідченням вичерпання
контексту, але generation stop reason і server-side причина обриву ще
потребують підтвердження. Просте збільшення context window не є повним рішенням.

**Scope:** визначити й реалізувати підтримуваний шлях завчасної compaction
історії через чинний Codex runtime, без власного LLM tool loop. Перевірити
фактичні можливості встановлених CLI/SDK та local provider, включно з тим,
чи працює compaction endpoint; не припускати підтримку за назвою config key.
Додати validated provider/model-specific effective context limit, output reserve
і safety margin; враховувати instructions, tool schemas, history та reasoning
у бюджеті. Не ототожнювати bytes/characters із tokens або cached tokens із
вільним контекстом. Не hardcode 32k для всіх моделей.

Зберігати під час скорочення user constraints, незавершену задачу, істотні
результати та цілісність tool-call/result pairs. Перевірити compaction усередині
довгого turn, follow-up, resume після restart і project/provider isolation.
Якщо безпечна compaction недоступна або не вдалася, явно зупиняти продовження
з actionable diagnostic і пропозицією нового thread; не скидати історію тихо,
не переключати provider та не вважати task завершеною.

**Готово, коли:** deterministic tests покривають поріг compaction, output reserve,
великий одиничний input/tool result, failure/unsupported compaction, cancellation
і resume. Bounded live test на disposable repository з малим configured context
перетинає поріг і продовжує task зі збереженими constraints та tool history,
або дає контрольовану зупинку без пошкодженого виклику. У документації є supported
config, sanitized token-budget evidence і fallback behavior; raw prompts,
reasoning та production trace bodies не додаються до repository.

### [ ] DEV-086 — Обробляти незавершені tool calls без повторних HTTP 500

**Підстава, 2026-10-07:** trace `95dd95da-2604-4b7d-a861-cfc3cf7ab53c`
повернув `response.output_item.done` для `exec_command` з arguments
`{"cmd":"cd` і потім `response.completed`, попри невалідний вкладений JSON.
У наступному trace `e698a2ec-845e-4e76-87d3-b841d8dc5874` зовнішній request
JSON валідний; `input[90]` містить цей виклик, а `input[91]` — matching
`function_call_output` із parse-error diagnostic. llama.cpp відхиляє таку
історію HTTP 500: `Failed to parse tool call arguments as JSON`, column 11.
Request/response hashes другого trace збігаються, capture не обрізаний.
Trace `f898eebe-91eb-4131-973b-3250961a6c99` із розбіжністю request hash не
використовувати як доказ структури оригінального wire request.

**Scope:** відтворити й розмежувати обрив generation, server tool parser та
неправильний completion status; отримати sanitized stop reason. Перевірити
обробку invalid arguments у Responses output і в повторно переданій історії.
Визначити правильний рівень fix (server/runtime/explicit compatibility layer)
та реалізувати перевірене рішення без перетворення діагностичного logging proxy
на прихований payload-rewriter. Remote production server не змінювати без
окремого погодження; якщо потрібен upstream fix, зафіксувати reproduction,
dependency і безпечний локальний fallback.

**Очікувана поведінка:** неповні/невалідні аргументи не виконуються й не
«ремонтуються» дописуванням лапок або вгадуванням команди. Partial SSE deltas
не вважаються помилкою до завершення item/stream. Завершений невалідний call
дає actionable diagnostic та bounded recovery або контрольовану зупинку;
не повторювати без змін відому неприйнятну історію до вичерпання retries.
Зберігати call IDs, matching results, коректні calls і відомості про вже
виконані операції; recovery не повинен повторно виконувати side effects або
тихо видаляти історію. `response.completed` сам по собі не доводить валідність
аргументів tools.

**Готово, коли:** fixtures/tests покривають escaping, malformed final arguments,
обірваний SSE, valid fragmented arguments, кілька calls з одним пошкодженим,
malformed call + error result у follow-up, stop/resume і bounded recovery.
Перевірено відсутність виконання пошкодженої команди та повторних side effects;
live reproduction на disposable repository більше не застрягає в HTTP 500
loop і не показує false success. Evidence містить лише sanitized protocol facts.
DEV-085 запобігає context exhaustion, але не замінює цю обробку; DEV-084
стосується retry status у gateway, DEV-082/083 — окремої namespace compatibility.

### [ ] DEV-084 — Не завершувати task помилкою під час Codex reconnect/retry

**Виявлено 2026-10-06:** operator отримав `Task failed.` із повідомленням
`Reconnecting... 1/5 (We're currently experiencing high demand, which may cause temporary errors.)`.
Остання перевірена failed task — `TASK-0029` у `base-proto-ui`; збережена
session identity вказує на local provider `home-llama`.

**Підтверджено в коді:** `CodexEventMapper` перетворює будь-яку top-level
подію `error` на `fatal: true`. `AgentManager` фіксує перший terminal outcome
та ігнорує подальші events, а `TaskHandler` додає `Task failed.` до повідомлення.
Якщо reconnect/retry приходить як top-level `error`, задача передчасно стає
failed, а наступний успішний `turn.completed` не може відновити її результат.
Фактичну форму retry event і подальший результат саме цього live turn ще
потрібно підтвердити; успішне відновлення не вважається встановленим фактом.

**Scope:** відтворити event sequence для встановлених Codex CLI/SDK і виправити
класифікацію transient retry та terminal failure. Не покладатися лише на
текст `high demand` і не робити всі `error` нефатальними. Причина початкового
transport/provider збою не встановлена й не є предметом цього дефекту;
зв'язок із namespace warning DEV-082 або item error DEV-081 не підтверджений.

**Очікувана поведінка:** reconnect відображається як bounded sanitized
progress/warning; task залишається active до фактичного terminal outcome.
Успішне відновлення завершує task як completed, а вичерпання retries або
справжня terminal error — як failed. Незавершений stream не видається за успіх.
Зберегти cancellation semantics, persistence і per-project lock до завершення.

**Готово, коли:** deterministic adapter/manager/handler regressions покривають
retry → completed без false `Task failed`, кілька retries → terminal failure,
справжню unrecoverable error, stream EOF без terminal outcome та stop під час
reconnect без перезапису STOPPED пізніми events. Перевірені persisted state,
один terminal result і можливість запуску наступної task. Bounded live recheck
через local provider підтверджує правильний статус після retry; evidence
містить sanitized event types/order без credentials, prompts або raw reasoning.

### [ ] DEV-082 — Дослідити втрату namespace tools у Codex → llama.cpp

**Підстава, 2026-10-06:** operator підтвердив, що сервер приймає запити,
але ігнорує `namespace` із повідомленням
`Unsupported response tool type 'namespace'`. DEV-071 закрита; цей аналіз
ведеться окремо. Зв'язок із recoverable item error DEV-081 не встановлений.

Зафіксувати versions Codex CLI/SDK, server build і model ID. На disposable
repository відтворити запит реального Codex та записати sanitized inventory
типів tools, namespace names і вкладених tool names. Визначити джерело кожного
namespace (MCP, built-in або інша інтеграція) і які tools фактично доходять до
моделі. Не зберігати credentials, prompts, repository contents чи raw reasoning.

Порівняти звичайний function tool і той самий harmless tool у namespace;
перевірити tool call → execution → matching result → final answer. Для
repository read, shell, patch і tests окремо визначити фактичний вплив,
підтверджений events, exit codes та filesystem assertions. Не робити висновок
про втрату всіх tools лише з warning або про успіх лише з текстової відповіді.
Перевірити прогалину чинного provider probe, який тестує flat function tools.

**Результат:** розділ у `docs/local-model-integration.md` із reproduction,
inventory, evidence matrix та розмежуванням підтверджених фактів і припущень.
Production config/runtime у цій задачі не змінювати.

**Готово, коли:** визначені конкретні пропущені tools та affected scenarios,
мінімальний reproduction відрізняє unsupported namespace від model tool-use
failure; evidence достатньо для вибору рішення в DEV-083. DEV-081 не вважати
дублікатом без окремого доказу.

### [ ] DEV-083 — Знайти й перевірити рішення для namespace compatibility

**Залежить від:** DEV-082. **Scope:** дослідження варіантів і isolated proof of
concept; production rollout оформлюється окремою implementation task.

На основі inventory порівняти перевірені варіанти: версію/patch `llama.cpp` із
потрібною підтримкою, фактично доступний сумісний режим Codex, explicit
compatibility proxy. Відключення namespace допустиме як documented workaround
лише для справді непотрібних tools; приховування warning не є рішенням.
Не припускати існування config flag або підтримки в новому release без перевірки.

Для перетворення namespace у flat tools перевірити збереження schemas,
description, strict/custom tool semantics, унікальність імен та їх зворотне
зіставлення. Перевірити однакові tool names у різних namespaces, call IDs,
tool results, SSE completion, full-history continuation/resume, errors і
cancellation. Непідтримувані типи мають давати явний diagnostic, а не тихо губитися.

Виконати bounded proof of concept у disposable repository без зміни робочого
`projects.json` або remote production server. Підтвердити виконання tool із
раніше пропущеного namespace та відсутність регресій flat tools. Оцінити
складність, підтримку версій, latency, credential routing і rollback; зберегти
чинні sandbox/policy boundaries.

**Результат:** decision record у `docs/local-model-integration.md`, порівняння
варіантів, sanitized PoC evidence та окрема scoped task для реалізації обраного
рішення й розширення provider probe namespace regression tests.

**Готово, коли:** обраний варіант підтверджений tool-call/result loop і follow-up
на цільовій конфігурації; або явно зафіксовано, чому жоден перевірений варіант
не підходить і яка capability потрібна. Production rollout не видається за
виконаний у межах дослідження.

### [ ] DEV-081 — Дослідити recoverable Codex item error з live `llama.cpp`

**Виявлено під час DEV-071, 2026-10-05.** Кожен із повторених real SDK/CLI
turns через configured generic Responses provider emitted один non-fatal
`item.error` перед `run_started`. Обидва turns після цього виконали всі bounded
commands з exit code 0, повернули очікувані markers і завершились terminal
`completed`; raw provider body, error message і reasoning не записувалися.

**Очікувана поведінка:** сумісний provider не створює user-visible false error
під час успішного turn. Якщо подія є нешкідливим SDK/runtime advisory, adapter
має класифікувати її як bounded diagnostic/warning; справжня recoverable model
помилка повинна мати sanitized actionable code без raw body, path або content.

**Готово, коли:** мінімальний live reproduction визначає source event без
збереження sensitive output; deterministic regression фіксує правильний
mapping; успішний Telegram turn не показує false failure, а реальна provider
помилка лишається видимою й безпечною.

### [x] DEV-063 — Виправити GitHub.com endpoint allowlist для root API base

**Виявлено під час DEV-056, 2026-09-30.** Configured GitHub.com base URL
`https://api.github.com` має normalized pathname `/`. `GitHubIssueTracker`
будує правильні request URLs `/user`, `/search/issues` і `/repos/...`, але
allowlist додає до base pathname ще один slash та очікує `//user`,
`//search/issues` і `//repos/...`. Через це adapter повертає
`MALFORMED_RESPONSE` до виклику `fetch`; Telegram показує safe message
`Issue tracker returned invalid response` для `/issue mine` і issue lookup.

Контрольні прямі запити з тим самим read-only credential підтвердили `200` для
`GET /user` і fixed assigned search, selected API version `2026-03-10` та один
assigned issue. Issue `#1` у configured repository є pull request, тому live
positive lookup після fix має використати номер реального issue. Усі виконані
probes були `GET`; GitHub mutation не виконувалася.

**Очікувана поведінка:** endpoint і pagination allowlists однаково коректно
нормалізують GitHub.com root base та GHES `/api/v3`; дозволяють тільки три
задані read-only endpoint shapes, не послаблюючи same-origin/path/query checks.

**Готово, коли:** regression tests відтворюють root-path defect для `/user`,
search, direct lookup і pagination; GHES coverage лишається green; повний
DEV-056 Telegram recheck проходить lookup реального issue, assigned listing,
empty/unavailable fields, switching/isolation і pagination за наявності.

**Виконано і live перевірено 2026-09-30:** API base pathname нормалізується
однаково для GitHub.com root і GHES prefix. Regression suite має 5 окремих
GitHub.com root-path requests та зберігає GHES/security coverage. Adapter live
виконав `/user`, assigned search і два lookup як allowlisted `GET` із `200`;
Telegram успішно показав `/issue mine`, `3`/`#3`, коректний PR response для
`1`/`#1` та ізольований disabled result після switch на project без tracker.

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
