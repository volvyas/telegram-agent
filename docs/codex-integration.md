# Codex integration analysis

Перевірено: **2026-08-26**.

## Висновок

Основний integration path для gateway — офіційний TypeScript package
`@openai/codex-sdk`, зафіксований точною версією в `package-lock.json`.

Під час Phase 0 (2026-08-26) npm `latest` був 0.149.1. Під час реалізації
DEV-009/010 (2026-08-27) stable package оновився до **0.150.1**; саме ця версія
exact-pinned у `package.json`/`package-lock.json` і має exact dependency на
`@openai/codex` 0.150.1. Public event types повторно перевірені за встановленими
`.d.ts`. SDK запускає Codex CLI та обмінюється з ним JSONL events, але надає
application typed API. Це стабільніше для нашого TypeScript коду, ніж власноруч
відтворювати аргументи CLI і підтримувати parser усіх JSONL variants.

Локальний `codex-cli 0.148.0` використано лише для capability/smoke перевірки.
Його executable лежить у JetBrains cache, тому production runtime на нього не
покладається.

Офіційні джерела:

- [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)
- [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
- [Codex CLI command reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli#cli-codex-exec)
- [Agent approvals and security](https://learn.chatgpt.com/docs/agent-approvals-security)

## Перевірені можливості

| Потреба | SDK/CLI capability | Рішення gateway |
|---|---|---|
| New conversation | `Codex.startThread()` / `codex exec` | один thread на project |
| Continue in memory | повторний `Thread.run*()` | наступне повідомлення в той самий thread |
| Resume after restart | `Codex.resumeThread(threadId)` | зберігати thread ID після `thread.started` |
| Streaming | `Thread.runStreamed()` | map typed `ThreadEvent` у domain events |
| Working directory | `workingDirectory` / `-C` | canonical configured project path |
| Prompt input | SDK string/structured input; CLI stdin | ніколи не shell interpolation |
| Stop | `AbortSignal` у `TurnOptions` | один `AbortController` на active turn |
| Sandbox | `sandboxMode` | `workspace-write` для coding task |
| Approval policy | `approvalPolicy` | `never` для unattended turn |
| Command network | `networkAccessEnabled` | `false` за замовчуванням |
| Web search | `webSearchMode` | `disabled` за замовчуванням |
| Exit/failure | `turn.failed`, `error`, rejected iteration | typed failed result + diagnostic log |
| Structured final output | `outputSchema` | completion/question envelope |
| Session location | `~/.codex/sessions`, global `CODEX_HOME` або project `codexHome` | persist лише thread ID у gateway storage; each project uses its resolved profile |

Починаючи з DEV-067, provider configuration передається до SDK явно для
кожного project через `Codex` constructor `config`, а не записується у shared
`CODEX_HOME/config.toml`. Built-in provider мапиться на `model_provider`, а
generic Responses provider — на isolated `model_providers.<id>` із `base_url`,
`wire_api = "responses"` і optional `env_key`. Project `agent.model` передається
явно у new/resumed thread. Missing `agent` зберігає legacy OpenAI behavior.

Child environment залишається allowlisted: для custom provider додається лише
одна referenced credential environment variable. Значення credential не входить
у provider config, typed project config, storage або error messages; воно
додається до logger redaction.

## Provider diagnostics

Remote provider availability is never a startup dependency. The gateway can
start with an offline inference host, and status/stop/configuration paths do not
perform a health check. An operator can run the explicit bounded probe:

```bash
PROBE_PROVIDER_ID=home-llama \
PROBE_BASE_URL=http://192.168.1.179:8080/v1 \
PROBE_MODEL=<configured-model> \
npm run probe:provider
```

The probe uses only the configured Responses endpoint. `/models` is recorded as
an optional discovery signal, not compatibility proof. A successful result also
requires incremental Responses SSE with `response.completed`, one harmless
function call, and a second turn using the complete function-call history. Input,
output, and time are bounded; no repository or workspace tools are supplied.
Typed failures distinguish network unreachable, timeout, TLS, authentication,
unknown model, malformed or incomplete SSE, invalid tool call, and protocol
mismatch. Output contains only provider/model identifiers and safe codes; raw
provider bodies, URL credentials, API keys, and prompts are not emitted.

Локальний smoke test додатково підтвердив JSONL streaming, thread ID, exit code
`0` і resume конкретного session ID.

Повторний SDK smoke test **2026-09-15** перевірив production adapter flow у
тимчасовому Git repository: `startThread` повернув ID тільки через structured
`thread.started`, після чого новий `resumeThread` із цим ID зберіг контекст між
turns (`KYIV-2048`). Обидва turns завершилися успішно, repository очищено.

## Adapter contract

`CodexAdapter` є єдиним application class, який імпортує Codex SDK types.
Решта системи працює з нашим контрактом:

```ts
type AgentEvent =
  | { type: "thread_started"; threadId: string }
  | { type: "progress"; message: string }
  | { type: "command"; command: string; status: string }
  | { type: "files_changed"; paths: readonly string[] }
  | { type: "question"; question: string; choices: readonly string[] }
  | { type: "completed"; summary: string }
  | { type: "failed"; message: string };

interface CodingAgent {
  startTurn(input: AgentTurnInput): AsyncIterable<AgentEvent>;
  resumeTurn(input: AgentResumeInput): AsyncIterable<AgentEvent>;
  stop(projectId: string): Promise<void>;
}
```

Точні types уточнюються при DEV-008, але контракт не повинен експортувати
`Thread`, Telegram context або SDK-specific event names.

## Запуск нового thread

Для кожного project adapter створює thread приблизно з такими options:

```ts
codex.startThread({
  workingDirectory: project.path,
  sandboxMode: "workspace-write",
  approvalPolicy: "never",
  networkAccessEnabled: false,
  webSearchMode: "disabled",
  skipGitRepoCheck: false,
  additionalDirectories: [],
});
```

`workspace-write` дозволяє редагувати вибраний repository і запускати локальні
tests. Network вимкнений. `danger-full-access`, bypass flags та additional
writable directories у MVP заборонені.

SDK отримує мінімально необхідний environment allowlist. Для production
рекомендовано окремий `CODEX_HOME`, щоб user-level MCP/config/rules не
розширювали можливості gateway. Цей каталог не можна розміщувати у configured
project або комітити; permissions мають бути `0700`.

Gateway resolves the Codex profile per project: `project.codexHome` takes
precedence over global `CODEX_HOME`; if neither is set, Codex's normal default
profile is used. The application constructs a separate SDK client for each
resolved project profile, so credentials, configuration and session storage do
not cross project boundaries. A persisted thread must be resumed through the
same project's client/profile; changing a project's profile requires a gateway
restart and a new login for that profile.

## Streaming і progress

Pinned SDK 0.150.1 надає typed events:

- `thread.started`;
- `turn.started`, `turn.completed`, `turn.failed`;
- `item.started`, `item.updated`, `item.completed`;
- terminal `error`.

Item types включають agent message, reasoning summary, command execution, file
change, MCP tool call, web search, todo list та error. Adapter не пересилає raw
reasoning або кожний output chunk у Telegram. `ProgressReporter` отримує лише
санітизовані domain events.

Thread ID треба записати atomic одразу після `thread.started`, а не чекати
завершення turn. Після gateway restart створюється новий SDK client і
викликається `resumeThread(threadId, sameThreadOptions)`.

## Двосторонні питання

Публічний SDK event union не має окремого `question`/`elicitation` event. Тому
MVP використовує надійний turn-based protocol:

1. кожному turn передається JSON Schema фінального envelope;
2. агент або завершує роботу як `completed`, або завершує turn як `question`;
3. gateway переводить project у `WAITING_FOR_USER` і показує question/choices;
4. Telegram answer запускає наступний turn того самого thread;
5. agent state повертається у `RUNNING`.

Мінімальна форма envelope:

```ts
type AgentTurnOutcome =
  | { kind: "completed"; summary: string; details?: string }
  | { kind: "question"; question: string; choices?: string[] };
```

Отже, process не залишається нескінченно чекати stdin між Telegram updates.
Контекст зберігається в Codex thread. Якщо SDK у майбутньому додасть stable
elicitation/approval events, adapter можна розширити без зміни Telegram layer.

## Approvals і небезпечні операції

Non-interactive SDK/`exec` не надає нашій версії typed approval-request event,
який можна безпечно прокинути в Telegram і потім продовжити той самий active
turn. `app-server` має ширший protocol, але локальний CLI позначає його
experimental; для MVP його не обрано.

Тому межа така:

- Codex turn працює з `approvalPolicy: "never"` у `workspace-write` sandbox;
- запит на вихід за sandbox не підтверджується автоматично, а завершується
  відмовою, яку агент може обробити;
- Git commit, tests/build і майбутні privileged operations запускає gateway
  власними typed services після власної Telegram confirmation policy;
- `push`, `reset --hard`, `clean`, discard changes і sandbox bypass заборонені;
- довільний shell command із Telegram не підтримується.

Це безпечніше, ніж намагатися парсити approval prompts із human-readable
terminal output. Обмеження слід переглянути перед Definition of Done №15, якщо
потрібне підтвердження довільної agent tool operation, а не gateway-owned action.

## Error і stop semantics

- `turn.failed` та stream `error` переводять task у `FAILED`.
- Unexpected SDK rejection/CLI exit також переводить task у `FAILED`; останні
  безпечні diagnostics зберігаються в agent log.
- `/stop` викликає `AbortController.abort()` для active turn.
- Abort не видаляє thread ID. Наступний turn використовує resume після
  reconciliation state.
- Одночасно допускається один active turn на project; різні projects мають
  окремі thread та abort controller.

Поводження resume після abort треба окремо підтвердити integration test у
DEV-032, оскільки офіційна документація гарантує cancellation signal і resume,
але не описує всі комбінації interrupted turn.

## Fallback

Якщо конкретна pinned SDK версія має blocker, fallback — прямий запуск тієї ж
pinned `@openai/codex` CLI через `spawn`:

```text
codex --sandbox workspace-write --ask-for-approval never
      exec -C <canonical-project-path> --json -
codex --sandbox workspace-write --ask-for-approval never
      exec resume <thread-id> --json -
```

Prompt подається stdin, executable/args передаються окремо, stdout парситься як
JSONL. Human-readable output не парситься. Перехід на experimental app-server
потребує нового ADR, а не прихованої заміни всередині adapter.
