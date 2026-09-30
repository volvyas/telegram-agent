# Jira read-only integration

Статус: **Planned, Phase 5B**, 2026-09-24.

## Мета і scope

Gateway має дозволити authorized Telegram user:

1. прочитати поля Jira ticket за його key;
2. отримати bounded список tickets, призначених поточному Jira account.

Початковий режим є виключно read-only. Gateway не створює і не редагує issues,
не змінює assignee/status, не виконує transitions, не додає comments,
attachments, worklogs або links. Jira data не передається Codex автоматично.

## Попереднє capability дослідження

Перед реалізацією треба зафіксувати тип deployment (Jira Cloud або Jira Data
Center), фактичну версію REST API, підтримувану authentication scheme,
endpoint поточного user, issue lookup, field metadata, search і pagination.
Офіційна документація та відповіді реального instance мають пріоритет над
припущеннями цього документа.

Вибраний account/token повинен мати лише browse/read permissions для потрібних
projects. Якщо API реалізує read-only search через `POST`, adapter може
використати його тільки для allowlisted search endpoint із власноруч сформованим
JQL/projection body; це не розширює domain API до write operations.

## Telegram UX

Заплановані команди:

```text
/jira PROJ-123     # показати підтримувані поля одного ticket
/jira mine         # tickets, assigned to current Jira account
```

`/jira` без argument показує usage. Ticket key проходить bounded validation і
не інтерполюється в URL або JQL без URL/query encoding. Telegram user не може
передати arbitrary JQL, account ID, endpoint, hostname або список REST fields.

Список `mine` використовує server-side поняття поточного Jira user і має
детермінований order, configurable page size та жорсткий maximum. Pagination
показується opaque callback-кнопками, прив'язаними до user і query snapshot;
сирий JQL у callback payload не записується.

## Ticket fields

MVP нормалізує й показує bounded subset:

- key, summary, status та issue type;
- priority, assignee і reporter;
- description;
- labels, components і fix versions;
- created та updated timestamps.

Description з Jira rich-text/ADF перетворюється на plain text без HTML/Markdown
injection. Відсутні або недоступні поля відображаються як unavailable, а не як
runtime failure. Comments, attachments, worklogs і changelog за замовчуванням
не запитуються.

Custom fields підтримуються через operator-owned mapping у config:
`display label -> Jira field ID`. Значення custom fields проходять allowlisted
typed conversion або bounded safe JSON rendering. Gateway не завантажує й не
показує всі поля автоматично, бо вони можуть містити secrets або надмірні дані.

## Архітектура

```text
Telegram /jira
  -> AuthGuard
  -> JiraHandler
  -> IssueTracker (domain port)
  -> JiraAdapter
  -> allowlisted Jira REST origin/endpoints
```

Заплановані contracts:

```ts
interface IssueTracker {
  getIssue(key: IssueKey): Promise<IssueDetails>;
  listAssignedToMe(page?: PageToken): Promise<IssuePage>;
}

interface IssueDetails {
  key: string;
  summary: string;
  status: string;
  issueType: string;
  priority?: string;
  assignee?: string;
  reporter?: string;
  description?: string;
  labels: readonly string[];
  components: readonly string[];
  fixVersions: readonly string[];
  createdAt: string;
  updatedAt: string;
  customFields: Readonly<Record<string, string>>;
}
```

Telegram types не виходять за handler/formatter, а Jira SDK/HTTP response types
не виходять за adapter. Adapter не надає generic `request`, raw JQL або mutation
methods application layer.

## Configuration and secrets

Фінальні variable names уточнюються capability task, базова форма:

```dotenv
JIRA_BASE_URL=https://example.atlassian.net
JIRA_AUTH_TOKEN=
JIRA_USER_EMAIL=
JIRA_ASSIGNED_PAGE_SIZE=10
```

Для auth schemes без email `JIRA_USER_EMAIL` не потрібний. Base URL має бути
absolute HTTPS URL без credentials, query і fragment. Redirect на інший origin
заборонений. Token не записується у project config, storage, Telegram messages
або logs; structured logger реєструє його як configured secret.

Project/field allowlists зберігаються в operator-owned config, а не надходять із
Telegram. Persisted state може містити лише opaque pagination token з коротким
TTL; issue descriptions та повні Jira responses не persist-яться.

## Reliability and limits

- explicit connect/request timeout та abort on shutdown;
- bounded response body, field sizes, list size і pagination depth;
- retry лише для safe transient/rate-limit responses із server hint та cap;
- typed handling для auth failure, forbidden/not found, rate limit, timeout,
  malformed response і unavailable Jira;
- Telegram-safe errors без URL, token, raw response або stack trace;
- optional short-lived in-memory cache допускається лише після вимірювання і не
  є частиною першої реалізації.

## Testing and acceptance

Unit tests використовують fake HTTP transport/fixture responses для Cloud або
Data Center variant, вибраного capability task. Contract tests покривають field
mapping, ADF/plain-text conversion, absent fields, custom fields, pagination і
typed failures. Security tests доводять відсутність mutation endpoints,
arbitrary JQL, cross-origin redirects і secret leakage.

Opt-in integration test працює з read-only test account та test project. Він
читає known issue і перевіряє `assigned to me`, але ніколи не створює й не
змінює Jira data. Live acceptance з Telegram перевіряє обидві команди, empty
result, unavailable field, pagination та restart без persistence Jira payloads.
