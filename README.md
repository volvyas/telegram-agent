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

Другий active task для того самого project відхиляється; різні projects можуть
працювати паралельно. Команди наступних фаз (`/status`, `/git`, `/diff`, `/test`,
`/stop`, `/continue`, `/commit`) можуть бути присутні в project policy, але ще
не зареєстровані у поточному Telegram router.

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

Після зміни checkout path або repository path service/session не стартує:

- повторно render/install systemd unit для нового checkout;
- оновіть `projects.json`; persisted session навмисно не відновлюється для
  іншого canonical repository path.
