# Remote Codex Agent Gateway

## Мета

Створити локальний Node.js/TypeScript сервіс `codex-remote`, який дозволяє керувати Codex coding agent через Telegram з телефона.

Архітектура:

```text
                    📱 Telegram
                         │
                         │ messages / buttons
                         ▼
                ┌─────────────────┐
                │ Telegram Gateway │
                │                 │
                │ Node.js + TS    │
                └────────┬────────┘
                         │
                         ▼
                ┌─────────────────┐
                │ Agent Manager   │
                │                 │
                │ projects        │
                │ sessions        │
                │ permissions     │
                │ state           │
                └────────┬────────┘
                         │
                         ▼
                  Codex Agent / CLI
                         │
              ┌──────────┼──────────┐
              ▼          ▼          ▼
           files        git       tests
              │
              ▼
         Project repository
              │
              ▼
          IntelliJ IDEA
```

Телефон не повинен мати доступ до файлової системи або IntelliJ.

IntelliJ просто працює з тією ж директорією проєкту, яку змінює Codex.

---

# 1. Основна концепція

Користувач повинен мати можливість з телефона:

1. переглянути доступні проєкти;
2. вибрати активний проєкт;
3. відправити coding task;
4. отримати прогрес виконання;
5. отримати повідомлення від агента;
6. відповісти агенту;
7. попросити показати `git diff`;
8. переглянути `git status`;
9. запустити тести;
10. зупинити агента;
11. скасувати поточну операцію;
12. створити commit;
13. переглянути результат останньої задачі;
14. перемикатися між проєктами;
15. мати окремий conversation/session context для кожного проєкту.

Основний UX повинен бути таким:

```text
/project motor

/task
Додай endpoint для отримання статистики моторів за останні 24 години.
Використай існуючу reactive architecture.
Додай тести.
```

Gateway передає задачу відповідному Codex agent.

Після завершення користувач отримує:

```text
🤖 Task completed

Project: motor-backend

✓ Analyzed repository
✓ Modified 5 files
✓ Added 3 tests
✓ Tests: 27 passed

Git:
5 modified files
+143
-27

[View diff]
[Run tests]
[Commit]
```

---

# 2. Технологічний стек

Використати:

* Node.js
* TypeScript
* Telegram Bot API
* сучасний Telegram bot framework, який добре підтримує inline keyboards
* Codex CLI / офіційний Codex interface, доступний у локальному середовищі
* child_process або інший надійний механізм запуску процесів
* `.env` для секретів
* JSON або SQLite для локального persistence на першому етапі

Не використовувати Python.

Не використовувати Docker на першому етапі.

Не робити web frontend.

Telegram є основним UI.

---

# 3. Перед реалізацією

Перш ніж писати код:

1. Проаналізуй поточне середовище.
2. Перевір:

    * Node.js version
    * npm/pnpm
    * доступність Codex CLI
    * спосіб запуску Codex
    * доступні Codex CLI options
    * можливість продовження існуючої Codex session
    * можливість отримувати streaming output
    * можливість передавати tool permissions / sandbox permissions
3. Перевір Git.
4. Перевір, чи існує Telegram bot token у environment.
5. Якщо Codex CLI/API має кілька способів інтеграції, вибери найбільш стабільний та офіційно підтримуваний.

Не вигадуй CLI arguments.

Якщо конкретна можливість Codex залежить від встановленої версії, спочатку перевір її через `codex --help` або відповідну документацію.

Після аналізу коротко опиши знайдену архітектуру і лише потім реалізуй її.

---

# 4. Multi-project architecture

Проєкти повинні конфігуруватися окремо.

Наприклад:

```json
{
  "projects": {
    "motor": {
      "name": "Motor Backend",
      "path": "/home/user/projects/motor-backend"
    },
    "detective": {
      "name": "Detective Bot",
      "path": "/home/user/projects/detective-bot"
    },
    "crypto": {
      "name": "Crypto Bot",
      "path": "/home/user/projects/crypto-bot"
    }
  }
}
```

Не хардкодити project paths у TypeScript.

Підтримати:

```text
/project
```

який показує inline keyboard:

```text
🎮 Detective Bot
⚙️ Motor Backend
💰 Crypto Bot
```

Після вибору:

```text
Active project:
⚙️ Motor Backend

Path:
/home/user/projects/motor-backend
```

---

# 5. Security

Telegram bot повинен приймати команди тільки від whitelist Telegram user IDs.

Наприклад:

```env
TELEGRAM_BOT_TOKEN=...
TELEGRAM_ALLOWED_USER_IDS=123456789
```

Якщо повідомлення приходить від іншого користувача:

```text
Unauthorized.
```

і ніяких подальших дій не виконувати.

Ніколи не передавати Telegram user input безпосередньо в shell command.

Особливо важливо:

НЕ робити:

```ts
exec(`codex ${userMessage}`)
```

Потрібно безпечно працювати з process arguments / stdin / відповідним API.

---

# 6. Agent Manager

Створити окремий `AgentManager`.

Приблизний interface:

```ts
interface AgentManager {
    startTask(projectId: string, prompt: string): Promise<void>;

    sendMessage(projectId: string, message: string): Promise<void>;

    stop(projectId: string): Promise<void>;

    getStatus(projectId: string): AgentStatus;

    getSession(projectId: string): AgentSession | undefined;
}
```

Але структуру можна змінити, якщо знайдеш кращу архітектуру.

AgentManager повинен абстрагувати Telegram від Codex.

Telegram layer не повинен знати, як саме запускається Codex.

---

# 7. Persistent sessions

Кожен проєкт повинен мати окрему Codex conversation/session.

Наприклад:

```text
motor
  └── session A

detective
  └── session B

crypto
  └── session C
```

Якщо користувач переключився:

```text
/project motor
```

агент повинен продовжувати контекст Motor Backend.

Потім:

```text
/project detective
```

перемикаємося на Detective Bot.

Повернення:

```text
/project motor
```

повинно повернути попередню Motor session.

Не змішувати контексти різних repositories.

Якщо поточна версія Codex не підтримує persistent interactive session у потрібному режимі, реалізувати найбільш надійний еквівалент через підтримуваний механізм session/resume.

---

# 8. Двостороння комунікація

Це ключова вимога.

Telegram → Agent:

```text
Додай пагінацію.
```

Agent → Telegram:

```text
Я знайшов два способи реалізації.
Який використати?

[Reactive Pageable]
[Manual pagination]
```

Користувач натискає:

```text
[Reactive Pageable]
```

і відповідь повинна потрапити назад у ту саму agent session.

---

# 9. Agent messages

Агент повинен мати можливість повідомити користувача про:

* початок задачі;
* аналіз repository;
* довгу операцію;
* необхідність уточнення;
* завершення;
* помилку;
* результати тестів;
* git status;
* небезпечну операцію.

Не потрібно відправляти кожен рядок stdout у Telegram.

Зробити розумний progress reporting.

Наприклад:

```text
🤖 Working...

Project: motor
Task: Add 24h statistics

✓ Repository analyzed
✓ Controller inspected
⏳ Implementing service...
```

Для дуже довгих задач оновлювати одне Telegram message через `editMessageText`, замість створення сотень повідомлень.

---

# 10. Interactive questions

Якщо агенту потрібно поставити питання користувачу:

```text
🤖 I need your decision.

The project currently has two authentication mechanisms.

Which one should I use?

[Existing JWT]
[New OAuth layer]
```

Після натискання кнопки:

```text
Existing JWT
```

gateway повинен передати відповідь у поточну agent session.

Підтримати також текстові відповіді:

```text
/answer Використовуй existing JWT.
```

або просто звичайне повідомлення, якщо агент перебуває у `WAITING_FOR_USER` state.

---

# 11. Agent states

Передбачити state machine:

```text
IDLE
  │
  ▼
RUNNING
  │
  ├── WAITING_FOR_USER
  │        │
  │        ▼
  │      RUNNING
  │
  ├── COMPLETED
  │
  ├── FAILED
  │
  └── STOPPED
```

Telegram повинен показувати поточний стан.

---

# 12. Commands

Реалізувати:

```text
/start
/help
/projects
/project
/status
/task
/diff
/git
/test
/stop
/commit
/log
```

### `/start`

Показує:

```text
🤖 Codex Remote

Project:
none

[Select project]
```

### `/projects`

Показує список проєктів.

### `/project`

Показує або дозволяє вибрати активний проєкт.

### `/status`

Показує:

```text
Project: Motor Backend
Agent: RUNNING
Session: active
Git: 5 modified files
```

### `/task`

Запускає coding task.

### `/diff`

Показує git diff.

Не намагатися відправити величезний diff одним повідомленням.

Якщо diff великий:

* показати summary;
* розбити на повідомлення;
* або сформувати `.patch` file і відправити його Telegram document.

### `/git`

Показує:

```text
git status
current branch
modified files
```

### `/test`

Запускає тести відповідного проєкту.

Не припускати конкретну build system.

Визначити її:

* npm
* Maven
* Gradle
* etc.

Але команда запуску повинна бути явно визначена/configured для кожного project.

### `/stop`

Безпечно зупиняє поточного агента.

### `/commit`

Не робити commit мовчки.

Перед commit показати:

```text
Commit changes?

5 files changed
+143
-27

[Commit] [Cancel]
```

Після підтвердження попросити Codex або gateway створити commit з адекватним message.

---

# 13. Git safety

Перед запуском task:

```text
git status
```

Зберегти initial state.

Після task:

```text
git diff
git status
```

Не виконувати автоматично:

```text
git push
git reset --hard
git clean
git checkout .
```

без явного підтвердження користувача.

Особливо небезпечні операції повинні вимагати Telegram confirmation.

---

# 14. Project-specific configuration

Кожен project може мати:

```json
{
  "name": "Motor Backend",
  "path": "/home/user/projects/motor-backend",
  "testCommand": "./mvnw test"
}
```

або:

```json
{
  "name": "Detective Bot",
  "path": "/home/user/projects/detective-bot",
  "testCommand": "npm test"
}
```

Gateway не повинен намагатися універсально вгадувати production commands.

Конфігурація має мати можливість явно задавати:

* project path;
* test command;
* optional build command;
* optional run command;
* branch;
* allowed operations.

---

# 15. IntelliJ integration

Не керувати IntelliJ GUI.

Не використовувати mouse automation.

Не використовувати keyboard automation.

Codex повинен змінювати файли безпосередньо в repository.

IntelliJ автоматично побачить зміни.

Якщо потрібно, README повинен пояснювати:

```text
Open project in IntelliJ.
Run codex-remote on the same machine.
Keep IntelliJ open.
```

---

# 16. Logging

Локально вести structured logs:

```text
logs/
  app.log
  agent.log
```

Не записувати:

* Telegram bot token;
* API keys;
* passwords;
* secrets;
* sensitive environment variables.

Логувати:

```text
timestamp
user
project
task id
agent state
duration
exit code
```

---

# 17. Task IDs

Кожна задача отримує ID:

```text
TASK-0001
TASK-0002
TASK-0003
```

Наприклад:

```text
🤖 TASK-0042 started

Project: detective
```

Після завершення:

```text
🤖 TASK-0042 completed

Duration: 4m 12s
Files changed: 7
Tests: passed
```

Зберігати історію останніх задач.

---

# 18. Concurrency

На першому етапі дозволити:

* максимум одну активну Codex task на один project.

Але різні проєкти потенційно можуть працювати паралельно:

```text
motor      RUNNING
detective  IDLE
crypto     RUNNING
```

Не дозволяти двом agent processes одночасно змінювати один repository.

---

# 19. Telegram UX

Максимально використовувати inline keyboards.

Наприклад:

```text
⚙️ Motor Backend

Agent: RUNNING

[📊 Status]
[📝 New task]
[📄 Diff]
[🧪 Tests]
[🛑 Stop]
```

Для project selector:

```text
Select project:

[⚙️ Motor Backend]
[🎮 Detective Bot]
[💰 Crypto Bot]
```

Після вибору показати project dashboard.

---

# 20. Error handling

Якщо Codex завершується з помилкою:

```text
❌ Agent failed

Project: motor
Task: TASK-0012

Exit code: 1

Last output:
...
```

Не втрачати session state.

Користувач повинен мати можливість:

```text
/continue
```

або просто написати:

```text
Виправ помилку.
```

і продовжити роботу.

---

# 21. Long messages

Telegram має обмеження на довжину повідомлень.

Створити helper:

```ts
sendLongMessage()
```

який:

1. розбиває текст;
2. намагається не ламати code blocks;
3. при великих diff/logs може створювати temporary `.txt` / `.diff` файл;
4. відправляє файл через Telegram.

---

# 22. Configuration

Створити:

```text
.env.example
projects.example.json
```

Наприклад:

```env
TELEGRAM_BOT_TOKEN=
TELEGRAM_ALLOWED_USER_IDS=
PROJECTS_CONFIG=./projects.json
LOG_LEVEL=info
```

Не комітити `.env`.

---

# 23. Project structure

Запропонуй чисту структуру, наприклад:

```text
codex-remote/
├── src/
│   ├── index.ts
│   ├── config/
│   ├── telegram/
│   │   ├── bot.ts
│   │   ├── handlers/
│   │   └── keyboards/
│   ├── agent/
│   │   ├── AgentManager.ts
│   │   ├── CodexAdapter.ts
│   │   └── SessionManager.ts
│   ├── projects/
│   ├── git/
│   ├── tasks/
│   ├── storage/
│   └── utils/
├── data/
├── logs/
├── package.json
├── tsconfig.json
├── .env.example
├── projects.example.json
├── README.md
└── .gitignore
```

Можеш змінити структуру, якщо маєш кращу аргументацію.

---

# 24. Persistence

На першому етапі не потрібен PostgreSQL.

Використати SQLite або простий JSON storage.

Зберігати:

```text
projects
active project
agent sessions
task history
task status
timestamps
```

Архітектуру storage зробити через interface, щоб пізніше можна було замінити SQLite на PostgreSQL.

---

# 25. Important: Codex integration

Це найважливіша технічна частина.

Не симулювати Codex.

Не робити власний LLM agent.

Використовувати реальний встановлений Codex.

Спочатку визначити доступний спосіб інтеграції у поточній версії Codex.

Перевірити:

```bash
codex --help
codex --version
```

та відповідні subcommands/options.

Особливо перевірити:

* non-interactive execution;
* interactive execution;
* session resume;
* working directory;
* streaming output;
* permissions;
* sandbox;
* exit codes.

Якщо CLI має офіційний machine-readable / JSON output, віддати йому перевагу перед parsing human-readable terminal output.

Створити adapter:

```ts
interface CodingAgent {
    start(...): Promise<...>;
    send(...): Promise<...>;
    stop(...): Promise<...>;
}
```

`CodexAdapter` повинен бути єдиним місцем, яке знає деталі Codex CLI/API.

---

# 26. Security model for agent permissions

За замовчуванням агент повинен працювати тільки всередині вибраного repository.

Не дозволяти йому випадково працювати з:

```text
/home/user
/etc
/root
.ssh
.env outside project
```

якщо це не необхідно.

Перевірити можливості sandbox/approval режимів актуальної версії Codex і вибрати найбезпечніший режим, який при цьому дозволяє агенту нормально редагувати repository і запускати його тести.

Не обходити sandbox/security mechanisms.

---

# 27. User confirmation

Створити централізований mechanism:

```ts
requestConfirmation(...)
```

Наприклад:

```text
⚠️ Confirmation required

Agent wants to execute:

mvn clean install

[Allow once]
[Deny]
```

Для небезпечних операцій confirmation обов'язковий.

Не дозволяти Telegram повідомленню самому себе підтверджувати operation через підроблений callback.

Перевіряти callback user ID та pending confirmation ID.

---

# 28. README

Створити хороший README з:

1. prerequisites;
2. installation;
3. Telegram bot creation;
4. environment configuration;
5. project configuration;
6. запуск;
7. systemd service;
8. usage;
9. security;
10. troubleshooting.

---

# 29. systemd

Передбачити production-like запуск на ноутбуці:

```text
codex-remote.service
```

Він повинен:

* запускатися після network;
* автоматично рестартуватися;
* працювати від звичайного user account;
* не запускатися від root;
* мати доступ до Codex;
* мати доступ до configured repositories.

README повинен містити приклад systemd unit.

---

# 30. Development mode

Додати:

```bash
npm run dev
npm run build
npm start
npm test
```

TypeScript повинен компілюватися без помилок.

---

# 31. Testing

Написати unit tests для:

* project manager;
* authentication;
* task manager;
* state machine;
* Telegram command parsing;
* confirmation flow;
* git parser;
* session persistence.

Не потрібно тестувати сам Telegram API або реальний Codex у unit tests.

Створити mock `CodingAgent`.

---

# 32. MVP priority

Не намагайся одразу зробити абсолютно все.

Реалізуй у такому порядку:

### Phase 1

```text
Telegram
 ↓
project selection
 ↓
Codex
 ↓
result
```

### Phase 2

```text
persistent sessions
two-way communication
agent questions
```

### Phase 3

```text
git diff
tests
status
stop
```

### Phase 4

```text
confirmation system
task history
systemd
```

### Phase 5

```text
polish
logging
robust error handling
```

Після кожної фази переконайся, що система працює.

---

# 33. Definition of Done

Проєкт вважається готовим, якщо я можу:

1. Запустити gateway на ноутбуці.
2. Відкрити Telegram на телефоні.
3. Виконати `/start`.
4. Вибрати repository.
5. Написати coding task.
6. Побачити progress.
7. Отримати результат.
8. Попросити агента щось уточнити.
9. Відповісти йому з Telegram.
10. Побачити зміни через `/diff`.
11. Запустити `/test`.
12. Зупинити agent через `/stop`.
13. Перемкнутися на інший project.
14. Повернутися назад і продовжити попередню session.
15. Підтвердити або відхилити небезпечну операцію.
16. Перезапустити gateway і не втратити project/session/task state.

---

# 34. Coding style

Пиши production-quality TypeScript.

Не роби один величезний файл.

Не використовуй `any`, якщо можна використати нормальний type.

Не приховуй помилки через:

```ts
catch {}
```

Не використовуй shell string interpolation для user-controlled input.

Не додавай залежності без необхідності.

Якщо існує простіше рішення, вибирай простіше.

---

# 35. Final requirement

Почни з аналізу поточного середовища.

НЕ починай одразу створювати десятки файлів.

Спочатку:

1. перевір Codex;
2. перевір Node;
3. перевір Git;
4. визнач найнадійніший спосіб інтеграції;
5. коротко поясни запропоновану architecture;
6. після цього реалізуй MVP Phase 1;
7. протестуй його;
8. потім переходь до наступних фаз.

Якщо під час реалізації виявиться, що певна можливість Codex CLI відрізняється від припущень цього ТЗ, адаптуй реалізацію до фактично доступного API/CLI, а не вигадуй неіснуючі параметри.

Головний принцип:

**Телефон керує агентом, Telegram забезпечує двосторонній канал, Codex реально працює з repository, а IntelliJ залишається звичайним IDE, відкритим на тому самому repository.**

---

# 36. Phase 5B — Jira read-only integration

Після завершення базового gateway додати optional Jira integration. На першому
етапі вона працює лише на читання й дає дві можливості:

1. прочитати bounded набір полів ticket за key;
2. показати tickets, призначені поточному Jira account.

Запланований Telegram UX:

```text
/jira PROJ-123
/jira mine
```

Заборонено створювати/редагувати issues, виконувати transitions, змінювати
assignee, додавати comments, attachments, links або worklogs. Telegram input не
може задавати Jira hostname, endpoint, arbitrary JQL, account ID чи raw field
projection. Search `assigned to me` формує adapter через current Jira user.

Jira token є secret і завантажується з environment. Base URL, project allowlist,
custom-field mapping та limits належать operator configuration. REST response
нормалізується у domain types; Jira transport types не потрапляють у Telegram
layer. Rich text перетворюється на bounded plain text. Повні issue payloads не
persist-яться й не передаються Codex автоматично.

До реалізації обов'язково перевірити реальний deployment (Cloud/Data Center),
REST API version, auth, field metadata, pagination і rate limits. Детальний
scope, trust boundaries, configuration та acceptance описані в
[`docs/jira-integration.md`](docs/jira-integration.md).
