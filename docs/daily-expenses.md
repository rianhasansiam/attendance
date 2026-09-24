# Daily Expenses

Daily Expenses is available at `/daily-expenses` in the existing sidebar, including mobile navigation. It owns a shared cash ledger and has no dependency on attendance, drive costs, leave, payroll, or Employee profiles.

## Access and scope

`canManageDailyExpenses` / `authorizeDailyExpenses` in `src/modules/daily-expenses/permissions.ts` allow active ADMIN and SUPER_ADMIN users. EMPLOYEE and MANAGE_DRIVER have no access. The page and every API entry point check the authenticated session; business entry points also enforce the centralized permission. Authenticated identity and ledger scope come from the server. There is no tenant model in this application, so the server selects the single ledger with workspace key `daily-expenses`. Adding tenants later requires a separate scoping migration before sharing this workspace across tenants.

## Ledger and money

- Current Balance = all BALANCE_ADDED amounts − all EXPENSE amounts.
- Total Balance Added = all BALANCE_ADDED amounts, regardless of expenses.
- Both cards are all-time totals and ignore history filters and pagination. An empty ledger has zero for both cards and total expenses. Negative balances are allowed, including when the first entry is an expense. There are no daily/monthly resets.

PostgreSQL numeric aggregation produces both totals from one consistent statement. Each transaction uses Prisma Decimal / `numeric(18,2)` with a positive amount. The API accepts only decimal strings with at most 16 whole digits and two fractional digits; it rejects zero, negative, malformed, non-finite, overflowing, and over-precision values without rounding. JSON money values are strings. Display formatting also preserves exact digits.

`DAILY_EXPENSES_CURRENCY` defaults to `BDT`, matching the application's monetary convention. `DAILY_EXPENSES_TIMEZONE` defaults to `Asia/Dhaka`. These workspace-specific settings are read when the ledger is first created and then persisted; changing environment variables does not reinterpret an existing ledger. Only currencies with two decimal places are supported. Ledger configuration is immutable from creation, including before its first entry. No currency conversion is provided.

The business date is stored as a PostgreSQL date separately from the server-created recording timestamp. New entries default to today in the ledger timezone. Past/current business dates are accepted; future entries are rejected. Today filtering uses the same timezone.

## Categories and immutable history

Category names are trimmed, normalized, limited to 80 characters, and unique case-insensitively within the ledger, including archived categories. Category archive/restore and rename are audited. Archived categories stay in history and filter choices but cannot be selected for new expenses. A composite foreign key prevents cross-ledger category references. Balance additions have no category; expenses require an active category.

There are no transaction edit/delete or set-balance endpoints or controls. The migration enforces immutable posted transactions. User/category/ledger foreign keys restrict deletion rather than cascading financial records. Initial funds must be posted through Add Balance.

## API, cache, and safe retries

The client uses the existing request-scoped Redux provider and injects endpoints into its shared RTK Query API:

| Method     | Endpoint                              |
| ---------- | ------------------------------------- |
| GET        | `/api/daily-expenses/summary`         |
| GET        | `/api/daily-expenses/transactions`    |
| POST       | `/api/daily-expenses/balance`         |
| POST       | `/api/daily-expenses/expenses`        |
| GET / POST | `/api/daily-expenses/categories`      |
| PATCH      | `/api/daily-expenses/categories/[id]` |

All responses use the application's JSON envelope and `Cache-Control: no-store`. Mutations retain existing same-origin validation and per-actor rate limiting. Financial and category changes commit atomically with generic audit records, never attendance events.

Each intended financial submission has a random idempotency key. The database uniquely constrains `(ledgerId, idempotencyKey)`. A retry with the same actor and normalized payload returns the original transaction; a different actor or payload returns a conflict. Concurrent duplicate submissions create one transaction and one audit record. No financial mutations are replayed automatically. Pending retry state stays in memory: keep the workspace open until confirmation. Same-tab sidebar navigation is guarded, and document exit warns before discarding the key; a forced close, browser crash, or session change cannot recover an unconfirmed client submission automatically. Check history before initiating a new operation after such an interruption. An ambiguous response offers a retry of the same frozen submission and key. A confirmed save closes the form; a later failed refresh is shown as a refresh error and must not cause a new submission.

Successful transactions invalidate only `DailyExpensesSummary` and `DailyExpensesTransactions`. Category creation invalidates `DailyExpensesCategories`; category updates also invalidate history displays. List-wide tags cover all pages and filters. Balances are never optimistically changed. Queries refetch on mount/focus/reconnect and support manual refresh. Shared logout/session cleanup clears restricted data. There is no offline submission, persistent client ledger, service-worker caching, or real-time cross-user subscription.

## Migration and verification

The migration requires ICU-enabled PostgreSQL with `pg_catalog."und-x-icu"` for Unicode-aware category name uniqueness, independent of the database locale.

The additive migration `prisma/migrations/20260927000000_daily_expenses/migration.sql` creates the enum and three dedicated tables, constraints, indexes, and guard triggers. It changes no existing financial or attendance records and seeds no transactions. Apply it through the normal reviewed migration process before enabling the new application version. Do not reset an existing database.

Use only a disposable, non-production PostgreSQL database with `test` in its database name for verification. Set `TEST_DATABASE_URL` to its connection string, then run:

```sh
DATABASE_URL="$TEST_DATABASE_URL" pnpm db:migrate
pnpm db:validate
pnpm db:generate
pnpm typecheck
pnpm lint
TEST_DATABASE_URL="$TEST_DATABASE_URL" pnpm test
TEST_DATABASE_URL="$TEST_DATABASE_URL" pnpm exec playwright test tests/e2e/daily-expenses.spec.ts
pnpm build
```

The daily-expenses integration suite creates an isolated temporary schema, applies actual migrations, and exercises real PostgreSQL constraints, transactions, atomic auditing, concurrent idempotency, and aggregate correctness. Browser tests use only the isolated database and cover session access, saves, history filters, safe retries, failed refreshes, responsive layout, and keyboard dialogs. Chromium must be installed for Playwright.

## Implementation verification record

Verified on 2026-09-24 using a dedicated local PostgreSQL cluster on `127.0.0.1:55438`; the final database was `daily_expenses_final_test`. Production was not migrated, reset, or deployed. Existing unrelated working-tree work was preserved.

The final commands and results were:

| Command                                                                                                | Result                                                                                                              |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL=postgresql://rianhasansiam@127.0.0.1:55438/daily_expenses_final_test pnpm db:migrate`    | All 9 additive migrations applied to the new isolated database.                                                     |
| `pnpm db:validate`                                                                                     | Passed.                                                                                                             |
| `pnpm db:generate`                                                                                     | Passed; Prisma Client 7.10.0 generated.                                                                             |
| `pnpm typecheck`                                                                                       | Passed.                                                                                                             |
| `pnpm lint`                                                                                            | Passed.                                                                                                             |
| `TEST_DATABASE_URL=postgresql://rianhasansiam@127.0.0.1:55438/daily_expenses_final_test pnpm test`     | 38 test files, 510 tests passed, including 26 real PostgreSQL Daily Expenses tests.                                 |
| `TEST_DATABASE_URL=postgresql://rianhasansiam@127.0.0.1:55438/daily_expenses_final_test pnpm test:e2e` | 36 browser tests passed, including 8 Daily Expenses scenarios and existing attendance/drive-cost/session workflows. |
| `DATABASE_URL=postgresql://rianhasansiam@127.0.0.1:55438/daily_expenses_final_test pnpm build`         | Production build passed, including all Daily Expenses routes.                                                       |
| `git diff --check`                                                                                     | Passed.                                                                                                             |

Desktop and 390px mobile screenshots were visually reviewed. No checks were disabled. Node Web Crypto experimental warnings, an existing `pg` concurrent-query deprecation warning in the broader suite, and Next development cache-bypass notices were non-blocking. The new workspace's instant-navigation warning was resolved by placing its loading/authentication boundary at the page level. No verification checks remain blocked.

Operational limitations are deliberate: one two-decimal currency per immutable ledger; ICU-enabled PostgreSQL is required; there is no live cross-user subscription or recovery of an unconfirmed in-memory submission after the browser/session is discarded. Apply the reviewed migration through the application's normal release process before using this feature on an existing deployment.
