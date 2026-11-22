# Work Report

`/work-report` is a shared team feed for the existing roles `SUPER_ADMIN`, `MANAGE_DRIVER`, and `EMPLOYEE`. Every authorized user can read the team's non-deleted reports and post updates as themselves. **Only the original author can edit or delete a report**, including reports written by managers or super administrators. The legacy `ADMIN` role has no Work Report access. The application currently has no tenant model; this feature shares reports within the existing application.

Work Report is separate from Office Work task assignments, work-result updates, attendance, overtime, and payroll. Posting a report immediately publishes it to the team; it does not update a task or enter an approval workflow.

## Setup

Apply the additive database migration, generate the client, and restart the updated application through the existing deployment workflow:

```sh
pnpm db:generate
pnpm db:migrate
pnpm build
```

The additive migration is `20261122140000_work_report`; it creates no demo reports or user accounts. Reports use a date-only work date and the existing timestamp convention. The server assigns today's business date when creating a report. Browsing an earlier date changes only the feed; it cannot backdate a new post. Multiple reports by the same person on the same date are allowed.

Business dates use `WORK_REPORT_TIMEZONE`, then `OFFICE_WORK_TIMEZONE`, then `DAILY_EXPENSES_TIMEZONE`, and finally `Asia/Dhaka`. Configure an IANA timezone on the server if the business uses a different timezone.

## Feed and ownership

The feed defaults to everyone's reports for today. Date, author, title/content search, and My Reports filters run on the server before pagination. Posts sort by creation time descending with a stable ID tiebreaker; editing does not move a report to the top. Cards preserve content line breaks and render entered text safely. Attribution and author-filter responses omit email addresses and other unnecessary account data.

Creating always takes the author from the authenticated session. Editing accepts only the title and content plus the required concurrency version; original author, work date, and creation time stay unchanged. Authors can edit older reports. Deletion requires confirmation, soft-deletes the report, and removes it from the feed, search, author filters, and ordinary detail reads. There is no permanent-delete endpoint or administrator override.

The feature reuses existing sessions, same-origin mutation protection, rate limiting, validation, no-store response envelopes, and append-only audit logging. Changes and their audit entry commit together. A UUID request ID makes create retries idempotent. Optimistic versions protect edits and deletion from stale writes; HTTP 409 conflicts offer a refresh path. Account roles and active status are rechecked against current database data. Deleted accounts retain historical reporting facts through the existing account-deletion convention.

## API

All operations use the existing authenticated, no-store API envelopes:

| Method and route               | Operation                                                         |
| ------------------------------ | ----------------------------------------------------------------- |
| `GET /api/work-report`         | Shared feed with date, author, My Reports, search, and pagination |
| `POST /api/work-report`        | Publish a report as the signed-in user for today's business date  |
| `GET /api/work-report/:id`     | Read a non-deleted report                                         |
| `PATCH /api/work-report/:id`   | Author-only title/content edit with `expectedVersion`             |
| `DELETE /api/work-report/:id`  | Author-only soft deletion with `expectedVersion`                  |
| `GET /api/work-report/authors` | Minimal author-filter options                                     |

## Verification

```sh
pnpm test:work-report
pnpm test:office-work
pnpm db:validate
pnpm typecheck
pnpm lint
pnpm build
```

Validation, policy, HTTP, and client/UI tests use the existing Node test runner. Migration rehearsal and service tests require an explicitly disposable local PostgreSQL database whose name contains `test`:

```sh
DATABASE_URL=postgresql://TEST_USER@127.0.0.1:TEST_PORT/attendance_work_report_test pnpm db:migrate
TEST_DATABASE_URL=postgresql://TEST_USER@127.0.0.1:TEST_PORT/attendance_work_report_test pnpm test:work-report
```

Integration tests create fixture accounts/reports and exercise transaction-failure triggers only in that local test database. Migration rehearsal uses an isolated schema and rolls back. Never target a production or shared database with these tests.
