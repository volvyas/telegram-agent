# Remote Codex Agent Gateway

Локальний Telegram gateway для запуску Codex у заздалегідь дозволених Git
repositories. Застосунок працює через long polling, тому public URL або webhook
не потрібні.

## Передумови

- Linux (для systemd deployment) або інша ОС для ручного запуску;
- Node.js 24.13+ та npm;
- Git;
- Telegram account і bot token від офіційного [@BotFather](https://t.me/BotFather);
- Codex authentication для того самого звичайного Linux user, від якого
  працюватиме gateway;
- доступ цього user до всіх configured repositories.

Не запускайте gateway або Codex від `root`.

## Встановлення

```bash
git clone <repository-url> telegram-agent
cd telegram-agent
npm ci
npm run build
```

Для перевірки checkout:

```bash
npm run lint
npm run typecheck
npm test
```

## Створення Telegram bot

1. Відкрийте [@BotFather](https://t.me/BotFather) і виконайте `/newbot`.
2. Збережіть виданий token лише у локальному `.env`; не додавайте його до Git,
   shell history, unit-файла чи скриншотів.
3. Дізнайтеся власний numeric Telegram user ID і додайте його до whitelist.
4. Надішліть новому bot повідомлення `/start` після запуску gateway.

## Environment configuration

Створіть локальний файл із прикладу та обмежте доступ до нього:

```bash
cp .env.example .env
chmod 600 .env
```

Заповніть значення:

```dotenv
TELEGRAM_BOT_TOKEN=123456789:replace_with_real_token
TELEGRAM_ALLOWED_USER_IDS=123456789
PROJECTS_CONFIG=./projects.json
LOG_LEVEL=info
CODEX_HOME=/home/service-user/.local/share/codex-remote/codex-home
```

`TELEGRAM_ALLOWED_USER_IDS` приймає один або кілька positive numeric IDs через
кому. `PROJECTS_CONFIG` може бути relative до кореня checkout або absolute.
`CODEX_HOME` має бути absolute і бажано окремим від interactive Codex profile.
Окремий project може перевизначити profile у `projects.json` через absolute
`codexHome`; якщо поле відсутнє, використовується цей global default.

Підготуйте та автентифікуйте окремий Codex profile від імені service user:

```bash
mkdir -p /home/service-user/.local/share/codex-remote/codex-home
chmod 700 /home/service-user/.local/share/codex-remote/codex-home
CODEX_HOME=/home/service-user/.local/share/codex-remote/codex-home \
  ./node_modules/.bin/codex login
CODEX_HOME=/home/service-user/.local/share/codex-remote/codex-home \
  ./node_modules/.bin/codex login status
```

Замініть example home path на реальний home звичайного user. Якщо gateway
запускає інший user, виконайте login саме від його імені.

## Project configuration

```bash
cp projects.example.json projects.json
```

Для кожного project задайте унікальний bounded ID, display name, absolute path
до кореня Git repository та дозволені operations. Commands задаються тільки як
окремі `executable` й `args`; shell strings, pipes і substitutions не потрібні.

Опційно вкажіть project-specific Codex profile:

```json
{
  "name": "Motor Backend",
  "path": "/home/user/projects/motor-backend",
  "codexHome": "/home/service-user/.local/share/codex-remote/motor-codex-home",
  "allowedOperations": ["task", "status"]
}
```

`codexHome` має бути absolute, належати service user і мати mode `0700`.
Project без цього поля використовує global `CODEX_HOME`. Gateway створює окремий
Codex client для кожного project profile; кожен profile потрібно окремо
автентифікувати через `CODEX_HOME=... codex login`.

```json
{
  "projects": {
    "demo": {
      "name": "Demo project",
      "path": "/home/service-user/projects/demo",
      "testCommand": {
        "executable": "npm",
        "args": ["test"]
      },
      "allowedOperations": ["task", "status", "test", "stop"]
    }
  }
}
```

Кожен path повинен існувати, бути canonical Git repository root і бути
доступним service user. `projects.json`, `.env`, `data/` та logs ігноруються Git.

## Local model providers

Provider selection belongs to operator-owned `projects.json`; Telegram prompts
cannot choose a provider, endpoint or credential. Choose one of the built-in
local providers when using their standard server modes:

```json
{
  "modelProviders": {
    "ollama-local": { "type": "codex-builtin", "provider": "ollama" },
    "lmstudio-local": { "type": "codex-builtin", "provider": "lmstudio" },
    "home-llama": {
      "type": "responses",
      "name": "Home llama.cpp",
      "baseUrl": "http://192.168.1.179:8080/v1",
      "wireApi": "responses",
      "apiKeyEnv": "HOME_LLAMA_API_KEY"
    }
  }
}
```

Ollama normally listens on `127.0.0.1:11434`, and LM Studio's local server
normally listens on `127.0.0.1:1234`; those defaults are deployment examples,
not live acceptance results. A remote or custom `llama.cpp` server uses the
generic `responses` provider and must expose `POST /v1/responses` with
incremental SSE, `response.completed`, structured function calls and a
full-history continuation. `/v1/models` alone is not compatibility proof, and
the gateway never silently falls back to Chat Completions.

The configured model ID must be the exact ID accepted by the runtime. Context
capacity is a model/server limit: leave room for the system instructions,
bounded conversation history, tool schemas and output tokens. If the runtime
reports context overflow, reduce prompt/history size or select a model/server
configuration with a larger context; changing only the gateway provider name
does not increase it.

For optional provider auth, set `apiKeyEnv` to an environment-variable name and
put only its value in `.env` with mode `0600`. Credentials are not allowed in
URLs, JSON, Telegram messages, logs or command arguments. Public endpoints must
use HTTPS; plain HTTP is limited to loopback/private operator-owned networks.

### LAN bind, firewall and TLS

Keep Ollama, LM Studio and `llama.cpp` bound to loopback unless a separate
gateway host must reach them. For LAN access, bind only to the private
interface, allow the provider port from the gateway host's address in the host
firewall, and do not port-forward it to the public Internet. Prefer HTTPS with
a certificate trusted by the gateway host whenever traffic leaves the private
operator-controlled network. Do not put credentials in a URL to work around a
TLS or firewall error.

The systemd unit waits for `network-online.target` because Telegram and remote
providers may need networking, but provider health is not a startup dependency.
An offline local/LAN model must not prevent gateway startup or `/status`, `/stop`
and configuration diagnostics. Run the explicit bounded diagnostic when the
provider is available:

```bash
PROBE_PROVIDER_ID=home-llama \
PROBE_BASE_URL=http://192.168.1.179:8080/v1 \
PROBE_MODEL='<exact model id>' \
npm run probe:provider
```

The probe does not access a repository or mutate a workspace. It reports safe
typed results for discovery, network/TLS/authentication, Responses SSE, tool
call and continuation; it never prints raw provider bodies or secrets.

To trace actual Codex requests to a generic local Responses provider, use the
opt-in `npm run log:provider` loopback proxy. Metadata is logged by default;
raw request/response bodies require `PROVIDER_LOG_BODIES=1` and can contain
sensitive code, prompts and reasoning. See [HTTP diagnostics setup and limits](docs/local-model-integration.md#opt-in-http-diagnostics)
before temporarily routing a provider through the proxy.

For models with a known server context limit, set the optional per-project
`agent.context` budget (see `projects.example.json`): `windowTokens`,
`outputReserveTokens`, and `safetyMarginTokens`, all positive integers with
reserves totaling less than the window. For 32768 / 4096 / 2048, native Codex
auto-compaction is requested at 26624 tokens. The threshold is capped at 90%
of the window. This is early-compaction budgeting, **not** a hard output-token
cap or a guarantee that an oversized single request fits. It does not enlarge
the server's context. Omitted configuration retains existing Codex defaults.
See [DEV-085 behavior, limitations and live checklist](docs/local-model-integration.md#dev-085-context-budget-and-native-compaction).

For an explicitly approved live DEV-071 run, first create a disposable Git
repository and a separate empty `CODEX_HOME`, then run:

```bash
DEV071_REPO='<absolute disposable repository path>' \
DEV071_CODEX_HOME='<absolute isolated Codex home>' \
DEV071_PROVIDER_ID=home-llama \
DEV071_BASE_URL=http://192.168.1.179:8080/v1 \
DEV071_MODEL='<exact model id>' \
DEV071_CONFIRM_DISPOSABLE=1 \
npm run accept:dev071
```

This runner mutates only the supplied repository fixture. It records bounded
timing/event evidence, verifies command, patch, completion and resume behavior,
reconstructs the adapter to simulate restart, and checks cancellation. It does
not replace the Telegram `/stop`, real process restart, or provider-switching
parts of the manual matrix.

### Local provider troubleshooting

- `NETWORK_UNREACHABLE` or timeout: verify the bind address, port, route and
  firewall from the gateway host; do not infer model incompatibility from this.
- `TLS_FAILED`: install/use the correct CA chain or use a private HTTP endpoint
  only when it is genuinely loopback/private and operator-owned.
- `AUTHENTICATION_FAILED`: verify the exact `apiKeyEnv` name and provider auth
  mode; never paste the key into `projects.json` or a shell command.
- `UNKNOWN_MODEL`: copy the exact model ID from the provider's model listing and
  keep the configured context within the model's advertised capacity.
- `MALFORMED_SSE`, `MISSING_TERMINAL_EVENT`, `INVALID_TOOL_CALL` or
  `PROTOCOL_MISMATCH`: the runtime is not Codex-compatible in this mode; do not
  switch to Chat Completions implicitly. Upgrade/configure the runtime or use a
  separately reviewed compatibility provider.

### Safe rollback to default OpenAI

Stop new work, preserve a backup of `projects.json` and `data/`, then change the
affected project's `agent` to the operator-owned built-in provider:

```json
"agent": {
  "provider": "openai-default",
  "model": "<approved OpenAI model>"
}
```

Keep or remove the unused local provider definition according to the backup
plan, remove only credentials no longer needed from `.env`, run `npm run build`,
and restart the service. Provider/model identity validation intentionally will
not resume a thread across providers; start a new task and retain the old state
as historical metadata. Roll back by configuration, never by copying provider
tokens into storage or deleting `data/state.json` blindly.

### GitHub Issues token

Для project з `issueTracker.type: "github"` створіть окремий
[fine-grained personal access token](https://github.com/settings/personal-access-tokens/new)
з мінімальним read-only доступом:

1. У GitHub відкрийте **Settings → Developer settings → Personal access
   tokens → Fine-grained tokens** і натисніть **Generate new token**.
2. Вкажіть зрозумілу назву, короткий expiration і потрібного **Resource owner**.
3. У **Repository access** виберіть **Only select repositories** та додайте лише
   repository, вказаний у project configuration.
4. У **Repository permissions** встановіть **Issues: Read-only**. Не надавайте
   write permissions; `Metadata: Read-only` GitHub додає автоматично.
5. Натисніть **Generate token** і одразу скопіюйте значення: повторно GitHub
   його не покаже. Якщо organization вимагає approval, дочекайтеся схвалення
   owner/admin — до цього token матиме статус `pending` і не дасть доступу до
   private resources.
6. Запишіть token лише в локальний `.env` під ім'ям із `tokenEnv` відповідного
   project та залиште файл доступним тільки service user:

```dotenv
GITHUB_MOTOR_ISSUES_TOKEN=github_pat_replace_with_real_token
```

```json
{
      "issueTracker": {
        "type": "github",
        "owner": "example-org",
        "repository": "motor-backend",
        "tokenEnv": "GITHUB_MOTOR_ISSUES_TOKEN",
        "apiBaseUrl": "https://api.github.com",
        "apiVersion": "2026-03-10",
        "pageSize": 10
  }
}
```

Не додавайте token до `projects.json`, Git remote URL, command arguments або
systemd unit. Для різних owners/repositories можна використовувати окремі
tokens і різні `tokenEnv`. Детальні правила створення та керування token:
[GitHub documentation](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens).

Для GitHub Enterprise Server вкажіть API base у project configuration у формі
`https://HOSTNAME/api/v3`. Origin, owner і repository належать operator-owned
configuration; Telegram user не може їх змінити. `jira` можна вказати як
зарезервований provider, але до появи Jira adapter він безпечно повертає
повідомлення про непідтримуваний provider.

Створення issue — окремий opt-in. Для нього додайте `allowCreation: true` і
окремий `writeTokenEnv` із fine-grained token, що має `Issues: Read and write`
лише для configured repository. Read token із `tokenEnv` ніколи не підвищується
автоматично. Agent спочатку показує точний bounded preview, а `POST` виконується
лише після одноразового Telegram `Allow once`; `Deny`, expiry або повторний
callback не виконують network mutation. Timeout після POST не повторюється
автоматично.

## Ручний запуск

Development mode з автоматичним restart після змін:

```bash
npm run dev
```

Production-like запуск:

```bash
npm run build
npm start
```

Процес працює у foreground. `Ctrl+C`, `SIGINT` і `SIGTERM` запускають graceful
shutdown Telegram polling та активних agent runs.

## Linux systemd service

Deployment використовує поточний checkout, `.env` у його корені та absolute
Node.js executable. Спочатку виконайте `npm ci`, build, configuration і Codex
login. Checkout і Node path не повинні містити whitespace, backslash, quotes або
`%`. Потім встановіть unit, явно передавши звичайного Linux user:

```bash
sudo --preserve-env=PATH \
  ./deploy/codex-remote-service.sh install "$USER"
```

Якщо `node` встановлено через nvm/asdf і `sudo` його не знаходить, передайте
absolute executable path третім аргументом:

```bash
sudo ./deploy/codex-remote-service.sh install "$USER" "$(command -v node)"
```

Installer перевіряє user, build, `.env` і доступ до Node.js, рендерить
[`deploy/codex-remote.service`](deploy/codex-remote.service), встановлює його як
`/etc/systemd/system/codex-remote.service`, виконує `daemon-reload` та
`enable --now`. Локальні username і paths у repository не записуються.

Керування сервісом:

```bash
./deploy/codex-remote-service.sh status
./deploy/codex-remote-service.sh logs
sudo ./deploy/codex-remote-service.sh restart
sudo ./deploy/codex-remote-service.sh stop
sudo ./deploy/codex-remote-service.sh start
sudo ./deploy/codex-remote-service.sh uninstall
```

Переглянути rendered unit без встановлення:

```bash
./deploy/codex-remote-service.sh render "$USER" "$(command -v node)"
```

Після переміщення checkout або зміни Node executable повторно виконайте
`install`. Unit запускається після `network-online.target`, має restart policy,
надсилає `SIGTERM` і завершує весь process control group при stop.

## Оновлення

Зупиніть приймання нових задач, потім у checkout виконайте:

```bash
sudo ./deploy/codex-remote-service.sh stop
git pull --ff-only
npm ci
npm run build
npm test
sudo --preserve-env=PATH \
  ./deploy/codex-remote-service.sh install "$USER"
```

Перед оновленням зробіть backup `data/`, якщо runtime persistence вже підключено
у вашій версії. Не замінюйте пошкоджений або unsupported `data/state.json`
порожнім автоматично.

## Використання

Поточний наскрізний runtime підтримує:

- `/start` — вибір project або dashboard;
- `/projects` — список configured projects;
- `/project <id>` — вибір active project;
- `/task <text>` — запуск задачі;
- `/task`, а потім наступне text message — двокроковий запуск задачі.
- `/issue <number>` або `/issue #<number>` — read-only issue lookup активного
  project;
- `/issue mine` — bounded open issues, assigned authenticated GitHub account,
  із opaque short-lived pagination buttons.

Issue commands використовують тільки tracker активного project. Lookup не
завантажує comments, events, attachments або HTML і не передає issue в agent
session. Результати та response bodies не persist-яться. GitHub token живе
лише в environment; у `projects.json` зберігається тільки ім'я environment
змінної. Для tracker без credentials, private repository без дозволу,
відсутнього issue або rate limit gateway показує безпечне узагальнене
повідомлення.

Другий active task для того самого project відхиляється; різні projects можуть
працювати паралельно. Команди наступних фаз (`/status`, `/git`, `/diff`, `/test`,
`/stop`, `/continue`, `/commit`) працюють лише в межах active project і
відповідно до project policy.

## IntelliJ IDEA та локальні зміни

Gateway і IntelliJ працюють із тими самими файлами. Не запускайте task, якщо
одночасно виконуєте несумісний refactoring, rebase або checkout. Gateway не
створює окремий worktree і не вважає наявні user changes власними.

## Безпека і дані

Повна модель загроз, межі довіри та regression coverage описані в
[`docs/security.md`](docs/security.md).

- Telegram whitelist middleware виконується до command/text/callback handlers.
- Codex працює лише у validated configured repository з `workspace-write`, без
  approval escalation, додаткових writable directories і network/search.
- User text передається як SDK input, а не shell command.
- `.env`, Codex credentials, `projects.json`, `data/` та logs не комітяться.
- systemd unit працює від explicit non-root user, з `UMask=0077` і
  `NoNewPrivileges=true`.

Agent sessions і Codex thread IDs зберігаються у `data/state.json`; після
restart наступна task для project resume-ить його попередній thread. Active
Telegram project selection поки лишається in-memory і буде persist-итися в
наступній Phase 2 task.

## Troubleshooting

`Application failed.` одразу після запуску:

- перевірте синтаксис `.env`, token і positive numeric whitelist IDs;
- перевірте, що `PROJECTS_CONFIG` читається й містить valid JSON;
- переконайтеся, що кожен project path існує та є Git repository root.

Сервіс постійно перезапускається:

```bash
systemctl status codex-remote.service
journalctl -u codex-remote.service -n 100 --no-pager
```

Codex не автентифікований:

- перевірте `CODEX_HOME` у `.env`;
- виконайте `codex login status` із тим самим `CODEX_HOME` і від того самого
  service user;
- перевірте ownership і permissions каталогу (`0700`).

Configured command не знайдено під systemd:

- використовуйте absolute executable у `projects.json`, або переконайтеся, що
  executable доступний через PATH Node directory, `/usr/local/bin`, `/usr/bin`
  чи `/bin`;
- після зміни Node path повторно виконайте service `install`.

Issue tracker не відповідає або повертає access error:

- перевірте, що `tokenEnv` існує в `.env` саме під назвою з project config;
- переконайтеся, що fine-grained token має тільки `Issues: Read-only` для
  потрібного repository та, якщо потрібно, organization approval;
- для GHES перевірте `https://HOSTNAME/api/v3`, TLS certificate і доступність
  instance з gateway host;
- `jira` є зарезервованим provider і навмисно не працює в цій ітерації;
- повторіть `/issue mine` після rate-limit reset; довільний search query або
  чужий login не підтримуються.

Після зміни checkout path або repository path service/session не стартує:

- повторно render/install systemd unit для нового checkout;
- оновіть `projects.json`; persisted session навмисно не відновлюється для
  іншого canonical repository path.
