# Local environment report

Перевірено: **2026-08-26 19:15 EEST** (`Europe/Kyiv`).

Цей звіт фіксує середовище перед початком реалізації. Значення секретів не
читалися і не записувалися: для environment variables перевірено лише стан
`set/unset`.

## Операційна система

| Компонент | Результат |
|---|---|
| OS | Ubuntu 26.04 LTS (Resolute Raccoon) |
| Kernel | Linux 7.0.0-30-generic |
| Architecture | x86_64 |

Команди перевірки:

```bash
sed -n '1,12p' /etc/os-release
uname -srmo
date --iso-8601=seconds
```

## Node.js і package managers

| Tool | Version | Висновок |
|---|---:|---|
| Node.js | 24.13.0 | Підходить; Codex SDK потребує Node.js 18+ |
| npm | 11.6.2 | Обраний package manager для MVP |
| corepack | 0.34.5 | Доступний, але для MVP не потрібний |
| pnpm | не встановлений | Не використовуємо |
| Yarn | не встановлений | Не використовуємо |

`npm --version` додатково попереджає про невідому user-level опцію
`min-release-age`. Вона не блокує роботу, але її слід прибрати або оновити до
підтримуваного механізму до переходу на наступну major версію npm.

Команди перевірки:

```bash
node --version
npm --version
corepack --version
command -v pnpm
command -v yarn
```

## Codex

| Перевірка | Результат |
|---|---|
| CLI | `codex-cli 0.148.0` |
| Executable | JetBrains-managed cache, `.../codex-acp/1.6.2/node_modules/.bin/codex` |
| Authentication | `Logged in using ChatGPT` |
| Non-interactive mode | `codex exec` доступний |
| Machine output | JSONL через `--json` доступний |
| Resume | `codex exec resume <SESSION_ID>` доступний |
| App server | доступний, позначений experimental |

Повний абсолютний executable path:

```text
/home/volodymyr/.cache/JetBrains/IntelliJIdea2026.2/acp-agents/codex-acp/1.6.2/node_modules/.bin/codex
```

Цей path належить кешу IntelliJ, тому application не повинна хардкодити його або
покладатися на нього в systemd. Для gateway буде встановлено й точно
зафіксовано офіційний `@openai/codex-sdk`, який залежить від відповідної версії
`@openai/codex`.

Команди перевірки:

```bash
command -v codex
codex --version
codex login status
codex --help
codex exec --help
codex exec resume --help
codex app-server --help
```

## Codex smoke test

У тимчасовому порожньому Git repository виконано два read-only turns:

1. нова session через `codex exec --json`;
2. продовження через `codex exec resume <thread-id> --json`.

Обидві команди завершилися з exit code `0`. Обидва streams містили
`thread.started`, `turn.started`, `item.completed` з `agent_message` та
`turn.completed`; resume повернув очікувану другу відповідь.

Виявлена особливість CLI 0.148.0: global flags `--sandbox` та
`--ask-for-approval` треба ставити **до** `exec`, попри те що вони також
відображені в `codex exec --help`:

```bash
codex --sandbox read-only --ask-for-approval never \
  exec -C "$AUDIT_REPOSITORY" --json -
```

Prompt передавався через stdin. Файли поточного workspace не змінювалися.
Тимчасовий repository видалено; локальний Codex rollout/session record міг
залишитися у Codex session storage.

## Git і workspace

| Перевірка | Результат |
|---|---|
| Git | 2.53.0 |
| Поточна директорія | `/home/volodymyr/IdeaProjects/telegram-agent` |
| Git repository | **ні** |
| Файли продукту до Phase 0 | `design.md`, `tasks.md` |

Codex за замовчуванням вимагає Git repository. До першого real Codex task цей
проєкт треба ініціалізувати через `git init` або помістити під наявний Git root.
`--skip-git-repo-check` для робочого gateway не рекомендується.

## Environment variables

Стан на час перевірки:

| Variable | Стан |
|---|---|
| `TELEGRAM_BOT_TOKEN` | unset |
| `TELEGRAM_ALLOWED_USER_IDS` | unset |
| `PROJECTS_CONFIG` | unset |
| `LOG_LEVEL` | unset |
| `OPENAI_API_KEY` | unset |
| `CODEX_API_KEY` | unset |

Відсутність API keys не є проблемою: локальний CLI автентифікований через
ChatGPT. Відсутність Telegram token і whitelist блокує реальний Telegram smoke
test, але не Phase 0.

## Передумови для Phase 1

1. Ініціалізувати Git repository для `telegram-agent`.
2. Отримати Telegram bot token і allowed user ID та зберігати їх лише в `.env`.
3. Встановити dependencies із lockfile; не використовувати JetBrains cache path.
4. Визначити окремий `CODEX_HOME` для gateway або явно прийняти використання
   user-level Codex configuration. Рекомендовано окремий каталог поза project
   repository з permissions `0700` і окремим `codex login`.

