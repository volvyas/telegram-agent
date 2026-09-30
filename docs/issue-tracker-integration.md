# Generic Bug Tracker read-only integration

Статус: **DEV-049 complete — GitHub capability verified**, 2026-09-29.

## Мета і межі першої ітерації

Bug tracker є optional capability конкретного project. Telegram і application
layer працюють з provider-neutral `IssueTracker`; provider обирається лише з
operator-owned `projects.json`. Перша реалізація підтримує GitHub Issues.
`jira` є зарезервованим provider type і до появи `JiraAdapter` повертає typed
`UNSUPPORTED_PROVIDER`, не заважаючи gateway обслуговувати інші projects.

Перша ітерація дозволяє тільки:

1. прочитати одне issue з configured GitHub repository за number;
2. показати open issues цього repository, призначені власнику configured token.

Create/edit/close/reopen, comments, labels, assignees, milestones, reactions,
locks, transfers та інші mutations відсутні в domain API. Issue payload не
persist-иться й не передається Codex автоматично.

## Перевірені GitHub capabilities

Дослідження виконано за актуальною офіційною GitHub REST документацією та
unauthenticated `GET` probes до public test repository. Жоден mutation endpoint
не викликався.

- REST API є versioned. На 2026-09-29 актуальна documented version —
  `2026-03-10`; її треба явно передавати в `X-GitHub-Api-Version`. GitHub
  гарантує попередній version щонайменше 24 місяці після нового release, але
  GitHub Enterprise Server може підтримувати інший subset. Джерело:
  [API versions](https://docs.github.com/en/rest/about-the-rest-api/api-versions).
- Рекомендовані headers: `Accept: application/vnd.github+json`,
  `Authorization: Bearer <token>` і pinned API version. Invalid token дає `401`,
  insufficient access може виглядати як `403` або `404`. Джерело:
  [Authenticating to the REST API](https://docs.github.com/en/rest/authentication/authenticating-to-the-rest-api).
- `GET /user` повертає authenticated user; fine-grained PAT не потребує окремої
  user permission. Adapter використовує тільки `login`, не private profile
  fields. Джерело:
  [Get the authenticated user](https://docs.github.com/en/rest/users/users#get-the-authenticated-user).
- `GET /repos/{owner}/{repo}/issues/{issue_number}` потребує repository
  permission `Issues: read` для private resources. Для public repository
  endpoint доступний без token. `301`, `404` і `410` мають окрему семантику.
  Джерело: [Get an issue](https://docs.github.com/en/rest/issues/issues#get-an-issue).
- GitHub Issues endpoints можуть повертати pull requests; наявність top-level
  `pull_request` однозначно їх ідентифікує. Джерело:
  [REST API endpoints for issues](https://docs.github.com/en/rest/issues/issues).
- `GET /search/issues` підтримує `is:issue`, repository та assignee qualifiers,
  `sort=updated`, `order=desc`, максимум 100 items per page і максимум 1,000
  results per search. Response може мати `incomplete_results: true`. Authenticated
  search має окремий ліміт 30 requests/minute. Джерело:
  [Search issues and pull requests](https://docs.github.com/en/rest/search/search#search-issues-and-pull-requests).
- Pagination треба брати з RFC-style `Link` response header; GitHub прямо не
  рекомендує вручну будувати next URL. Джерела:
  [Using pagination](https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api),
  [REST API best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api).
- Primary authenticated limit для personal access token зазвичай становить
  5,000 requests/hour. Rate-limit state приходить у `x-ratelimit-*`; при
  exhausted primary/secondary limit GitHub повертає `403` або `429` і може
  додати `retry-after`. Джерело:
  [Rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api).
- Для GitHub Enterprise Server REST base має форму
  `https://HOSTNAME/api/v3`. Конкретну API version треба звіряти з версією
  instance. Джерело:
  [GHES authentication](https://docs.github.com/en/enterprise-server@3.21/rest/authentication/authenticating-to-the-rest-api).

## Результати safe probes

Probe від 2026-09-29:

```text
GET https://api.github.com/repos/octocat/Hello-World/issues
    ?state=all&per_page=2&page=1
Accept: application/vnd.github+json
X-GitHub-Api-Version: 2026-03-10
```

Спостереження без збереження raw response:

- `200 application/json`;
- `x-github-api-version-selected: 2026-03-10`;
- unauthenticated core budget змінився з 60 на 59 requests/hour;
- обидва елементи першої сторінки мали `pull_request`;
- `Link rel="next"` містив server-owned opaque `after` cursor, хоча request мав
  `page=1`;
- public issue мав очікувані array/null/string shapes для labels, assignees,
  milestone та body.

Authenticated probe не виконувався: у environment немає виділеного read-only
`GITHUB_TOKEN`. DEV-056 має повторити lookup, `/user` і assigned search з
fine-grained test token. Existing Git remote credentials не є test credentials
і adapter не має їх читати або використовувати.

Sanitized implementation fixtures з мінімальними потрібними fields:

- [`fixtures/github/user.json`](fixtures/github/user.json);
- [`fixtures/github/issue.json`](fixtures/github/issue.json);
- [`fixtures/github/search-page.json`](fixtures/github/search-page.json).

Fixtures є synthetic schema examples: вони не містять token, email, numeric
account ID, raw headers або private repository data.

## Вибраний integration flow

### Common request policy

Adapter створює URL тільки з validated provider config і власних endpoint
templates. Telegram input ніколи не задає origin, owner, repository, query або
fields. Дозволені тільки `GET` requests:

| Operation | Endpoint | Adapter-owned input |
| --- | --- | --- |
| Resolve identity | `/user` | none |
| Get issue | `/repos/{owner}/{repo}/issues/{number}` | validated number |
| List mine | `/search/issues` | fixed generated query and pagination |

Common headers:

```text
Accept: application/vnd.github+json
Authorization: Bearer <environment secret>
X-GitHub-Api-Version: <validated operator config>
User-Agent: telegram-agent/<application-version>
```

Token ніколи не додається в URL. Response redirects автоматично не follow-яться.
`301` для transferred issue стає typed `ISSUE_MOVED`, бо redirect може змінити
configured repository boundary. Майбутній explicit same-origin redirect flow
потребує окремого security decision.

### `getIssue(reference)`

GitHub reference після Telegram normalization — positive safe integer без
leading sign; `#123` перетворюється на `123` у handler. Adapter percent-encodes
configured owner/repository path segments і виконує:

```text
GET {apiBaseUrl}/repos/{owner}/{repository}/issues/{number}
```

Response проходить runtime shape validation. Якщо payload має property
`pull_request`, adapter повертає `NOT_AN_ISSUE`; він не викликає Pull Requests
API. Нормалізуються тільки:

- provider (`github`), repository і `#number`;
- title, state, state reason;
- author login та assignee logins;
- label names і optional milestone title;
- raw Markdown body як untrusted plain text input для formatter;
- created/updated/closed timestamps;
- validated public web URL.

Comments, events, timeline, reactions, attachments і rendered HTML не
запитуються. `body_html` не приймається; formatter bounded-ить raw body та
відправляє його як escaped/plain Telegram text.

### `listAssignedToMe(page?)`

Adapter один раз resolve-ить `login` через authenticated `GET /user` і cache-ить
його in-memory на lifetime adapter instance. Cache не persist-иться. Listing
використовує лише adapter-generated lexical query:

```text
repo:{owner}/{repository} is:issue is:open assignee:{authenticatedLogin}
```

Request:

```text
GET {apiBaseUrl}/search/issues
    ?q=<percent-encoded-fixed-query>
    &sort=updated
    &order=desc
    &per_page=<configured-page-size>
```

`is:issue` відкидає pull requests server-side. Runtime validation все одно
відхиляє будь-який returned item з `pull_request` як malformed provider
response. `incomplete_results: true` не маскується: page отримує typed
`incomplete: true`, щоб Telegram formatter показав warning.

Цей вибір кращий за repository Issues endpoint із client-side filter: змішана
сторінка issues/PR інакше створює sparse pages або змушує adapter втрачати
елементи при bounded multi-page fill. Trade-offs Search API: окремий lower rate
limit, максимум 1,000 results та eventual indexing. Для interactive bounded
`mine` вони прийнятні; direct lookup не залежить від search index.

### Pagination

Adapter читає тільки `rel="next"`/`rel="prev"` з `Link`. Перед request кожний
link повторно перевіряється:

- scheme `https` і exact configured origin;
- exact `/search/issues` path під configured API base path;
- відсутність credentials і fragment;
- query зберігає exact adapter-generated `q`, `sort`, `order`, `per_page`;
- дозволена лише provider pagination component (`page`, `after` або `before`),
  її size bounded.

Raw URL/cursor не надсилається Telegram і не приймається від нього. Application
layer зберігає короткоживий opaque random callback ID, bound до Telegram user,
project, provider і query kind; server-side record містить validated provider
page token. TTL і maximum pagination depth визначає DEV-054.

## Provider-neutral architecture

```text
Telegram /issue
  -> AuthGuard
  -> active ProjectConfig
  -> IssueTrackerResolver
  -> IssueTracker (domain port)
  -> GitHubIssueTracker
  -> allowlisted GitHub REST origin + three GET endpoint shapes
```

Planned domain direction for DEV-051:

```ts
interface IssueTracker {
  getIssue(reference: IssueReference): Promise<IssueDetails>;
  listAssignedToMe(page?: PageToken): Promise<IssuePage>;
}

interface IssueDetails {
  readonly provider: "github" | "jira";
  readonly reference: string;
  readonly repository?: string;
  readonly title: string;
  readonly state: string;
  readonly url?: string;
  readonly author?: string;
  readonly assignees: readonly string[];
  readonly labels: readonly string[];
  readonly milestone?: string;
  readonly body?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt?: string;
  readonly metadata: Readonly<Record<string, string>>;
}
```

Це design direction, не остаточний code contract. `metadata` містить лише
adapter-allowlisted scalar values (для GitHub першої версії — `stateReason`), не
raw provider JSON. `PageToken` opaque поза adapter/resolver. Provider transport
types не виходять у domain або Telegram.

## Configuration direction для DEV-050

Рекомендована project-owned форма:

```json
{
  "issueTracker": {
    "type": "github",
    "owner": "example-org",
    "repository": "example-service",
    "tokenEnv": "GITHUB_ISSUES_TOKEN",
    "apiBaseUrl": "https://api.github.com",
    "apiVersion": "2026-03-10",
    "pageSize": 10
  }
}
```

`tokenEnv` — operator config key name, не token. DEV-050 має вирішити, чи
дозволяти довільні bounded env names, чи використати фіксовану variable; в обох
випадках secret читається тільки з environment і реєструється в redactor.

Validation baseline:

- `owner`/`repository`: non-empty bounded GitHub name segments, без `/`, `.` або
  `..`; URL будує adapter, а не string concatenation;
- `apiBaseUrl`: absolute HTTPS, без credentials/query/fragment; GitHub.com exact
  `https://api.github.com`, GHES explicit `https://host/api/v3`;
- `apiVersion`: exact `YYYY-MM-DD`, operator-owned і pinned;
- `pageSize`: default 10, range 1..50 (нижче upstream max 100);
- missing `issueTracker`: capability disabled;
- `type: "jira"`: valid reserved config, runtime `UNSUPPORTED_PROVIDER`;
- unknown provider/keys або partial GitHub config: startup config error.

Один project не виводить repository з local Git remote: remote може не бути
GitHub, мати інший repository, містити credentials або змінитися після startup.
Mapping local project -> tracker repository є explicit trusted configuration.

## Authentication і least privilege

Для першої live реалізації рекомендовано fine-grained personal access token:

- resource owner і repository access обмежені одним потрібним repository;
- repository permission `Issues: read`;
- без жодної write permission;
- мінімальний практичний expiration;
- organization approval/SSO виконані, якщо policy цього вимагає.

GitHub рекомендує fine-grained PAT і мінімальні permissions/expiration:
[Keeping API credentials secure](https://docs.github.com/en/rest/authentication/keeping-your-api-credentials-secure).
Для довгоживучого multi-user deployment GitHub App user token може бути кращим,
але installation-only token не відповідає поняттю `assigned to me`; це не scope
першої ітерації.

## Runtime limits і error mapping

Defaults треба зафіксувати в DEV-052 tests, рекомендований baseline:

| Limit | Direction |
| --- | --- |
| Connect/request timeout | 3 s / 10 s |
| Response body | 1 MiB hard cap |
| Issue title | 512 Unicode code points |
| Issue body after normalization | 12,000 code points |
| Labels/assignees | 50 each, 100 chars per value |
| Page size | default 10, maximum 50 |
| Redirects | 0 |
| Rate-limit retry | at most 1, only within bounded delay budget |

Typed mapping:

| GitHub/transport condition | Domain error |
| --- | --- |
| invalid/missing token (`401`) | `AUTHENTICATION_FAILED` |
| forbidden or rate limit (`403`) | inspect safe rate headers, then `FORBIDDEN` or `RATE_LIMITED` |
| `429` | `RATE_LIMITED` |
| issue/repository hidden or absent (`404`) | `NOT_FOUND` |
| transferred issue (`301`) | `ISSUE_MOVED` |
| deleted issue (`410`) | `ISSUE_GONE` |
| search validation (`422`) | `PROVIDER_REJECTED_QUERY` (internal diagnostic only) |
| timeout/abort/network | `TIMEOUT`, `ABORTED`, `UNAVAILABLE` |
| invalid shape, wrong repository, PR in issue result | `MALFORMED_RESPONSE` or `NOT_AN_ISSUE` |
| body over hard cap | `RESPONSE_TOO_LARGE` |

Error messages to Telegram do not contain origin, query, response body, token,
stack or raw provider message. Logs may contain provider, operation, safe status,
rate-limit remaining/reset and diagnostic ID, never authorization/header/query
payloads that could expose repository or identity unexpectedly.

Retry obeys `retry-after` first, then `x-ratelimit-reset` only if delay fits the
configured cap and AbortSignal remains active. Otherwise it fails fast. No
retry on `401`, `404`, `410`, `422` or malformed response.

## Fixtures and next-task acceptance

DEV-050/051/052 tests мають використовувати supplied fixtures як seed, але
додати cases для null/absent fields, mixed PR payload, pagination links,
`incomplete_results`, every typed error, oversized JSON і hostile strings.
Fixtures не оновлюються копіюванням raw private response; дозволені тільки
hand-minimized synthetic values або sanitized public examples.

DEV-049 acceptance виконано:

- офіційні version/auth/endpoints/permissions/pagination/rate limits перевірені;
- GitHub.com public REST behavior підтверджено read-only probe;
- pull-request exclusion має server-side `is:issue` і defense-in-depth check;
- project-to-repository mapping та Jira extension point зафіксовані;
- fixtures не містять sensitive data;
- authenticated live verification явно перенесено в DEV-056, бо окремого
  least-privilege test token у середовищі немає.
