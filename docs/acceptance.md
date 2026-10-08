# Live acceptance

## DEV-080 — Web-only acceptance

Status: **PARTIAL — Web-only loopback and private-LAN host smoke passed; operator
login/browser and live agent-flow evidence remain.** The deployment examples and Web-only environment contract are in
`README.md`, `.env.example` and `docs/environment.md`. Use a disposable
Web-only process with `TELEGRAM_ENABLED=false`, `WEB_ENABLED=true`, a generated
password verifier and either loopback/private-LAN development HTTP or a real HTTPS direct /
trusted reverse-proxy setup. Do not record passwords, cookies, CSRF values,
private keys, tokens, full repository paths or raw agent output.

Automated preflight:

```sh
chmod 600 .env
npm run build
npm test
npm run test:security
```

Browser evidence to record as PASS/PARTIAL/N/A: login/logout, wrong-password
backoff, refresh session behavior and restart revocation; project selection and
Codex-home basename; task/status/result/stop; CSRF and wrong-Origin rejection;
security headers/cookie attributes; and, for production, valid HTTPS plus
rejection of plain public HTTP and spoofed forwarded headers. Full Telegram-only
and simultaneous Web+Telegram regression remains a separate acceptance cell.

Host-level smoke evidence, 2026-10-08:

| Check | Result |
| --- | --- |
| Web-only process with `TELEGRAM_ENABLED=false` | PASS — listener started without Telegram transport |
| Development bind on `0.0.0.0` for private LAN testing | PASS — listener accepted the configured private-LAN Host and rejected a mismatched Host |
| `GET /health` | PASS — bounded `{"status":"ok"}` response |
| `GET /` | PASS — local dashboard HTML served |
| Security headers | PASS — CSP, no-store, nosniff, frame denial, referrer and permissions policies observed |
| Wrong Host / Origin | PASS — `400` / `403` |
| Unauthenticated API/SSE | PASS — `401` |
| Wrong password | PASS — `401` with no session accepted |
| Real operator login/session | Pending — requires the operator’s configured password |
| Real Codex task/progress/question/answer flow | Pending — requires browser and live model session |

The private-LAN run used a temporary port and was stopped cleanly. The actual
LAN address is intentionally omitted from this record. For LAN development
testing, set `WEB_HOST=0.0.0.0`, set `WEB_PUBLIC_URL` to the gateway host's
private address, and restrict the port with the host firewall; do not expose it
to the public Internet.

The focused security command currently has one sandbox-only regression: the
child-Node stdout fixture in `SecurityRegression.test.ts` returns empty output
when spawned with an empty environment in this managed runtime. It does not
indicate shell execution; the marker remains absent. This needs a separate
environment/task investigation before DEV-080 can be marked complete.

## DEV-071 — partial live acceptance (2026-10-05)

Status: **PARTIAL — remote `llama.cpp` provider/SDK path passed; full Telegram
matrix remains open.** The operator supplied only the LAN `llama.cpp` endpoint.
No Ollama or LM Studio service, authorized Telegram acceptance session, or
cloud-provider acceptance credential was supplied, so those cells are `N/A`
rather than inferred passes.

The run used a fresh disposable Git repository and isolated `CODEX_HOME`.
Evidence contains only sanitized identifiers, event classifications, counts and
durations; prompts, file contents, response bodies, thread IDs, tokens and raw
reasoning were not retained. Runtime was `llama.cpp` build
`b11370-bed0a8566`; `/version` returned `404`, while `/props` exposed that build
identifier. Model was `Qwen3.8-Flash-Next-UD-IQ1_S-00001-of-00003.gguf`, IQ1_S,
with a 32,768-token runtime context.

| Capability | Ollama | LM Studio | `llama.cpp` | Sanitized evidence |
|---|---|---|---|---|
| Provider/model detection | N/A | N/A | PASS | `/health` ok; exact model discovered; bounded diagnostic passed discovery, Responses SSE, tool call and continuation |
| Repository read | N/A | N/A | PASS | Post-restart turn read the disposable fixture; one command completed with exit 0 |
| Harmless command | N/A | N/A | PASS | First turn produced three completed command events, no failed command |
| Small file patch | N/A | N/A | PASS | Exact eight-byte, newline-terminated fixture was verified by the harness; Git reported only that disposable file |
| Completion | N/A | N/A | PASS | First turn emitted terminal `completed`; required marker observed; no fatal error |
| Second-turn resume | N/A | N/A | PASS | Same thread resumed and completed after client reconstruction; required context marker observed |
| `/stop` | N/A | N/A | N/A | Live adapter/SDK cancellation reached `stopped` with no command or fatal error, but Telegram `/stop` was not exercised |
| Gateway restart | N/A | N/A | N/A | Fresh adapter and persisted `CODEX_HOME` resumed successfully, but a real gateway process restart was not exercised |
| Project switching | N/A | N/A | N/A | No cloud credential or second live provider was supplied |
| First-token / turn duration | N/A | N/A | PASS | Direct SSE first output: 4.306 s; bounded direct turn: 4.734 s; full tool turn: 125.050 s; resumed turn: 22.598 s |

The live runner is `npm run accept:dev071`. It uses the real Codex SDK/bundled
CLI, reconstructs the adapter before resume, validates the exact disposable
fixture, checks terminal markers and command outcomes, and exercises immediate
cancellation. Each completed Codex turn also emitted one recoverable item error
before `run_started`; it did not prevent commands, markers or completion and is
tracked separately as DEV-081. This run does not satisfy DEV-071's required
Telegram → gateway → Codex → model → tools → result flow, so DEV-071 remains
open.

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
