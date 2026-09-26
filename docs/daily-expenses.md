# Daily Expenses

Daily Expenses is available at `/daily-expenses` in the existing sidebar, including mobile navigation. It owns a shared cash ledger and has no dependency on attendance, drive costs, leave, payroll, or Employee profiles.

## Access and scope

`canManageDailyExpenses` / `authorizeDailyExpenses` in `src/modules/daily-expenses/permissions.ts` allow active ADMIN and SUPER_ADMIN users. EMPLOYEE and MANAGE_DRIVER have no access. The page and every API entry point check the authenticated session; business entry points also enforce the centralized permission. Authenticated identity and ledger scope come from the server. There is no tenant model in this application, so the server selects the single ledger with workspace key `daily-expenses`. Adding tenants later requires a separate scoping migration before sharing this workspace across tenants.

ADMIN users have view-only access to summaries, transaction history, and category filters. Only active SUPER_ADMIN users can add balances or expenses, create or manage categories, and edit or delete saved records. `canWriteDailyExpenses` hides creation and category management controls; `authorizeDailyExpenseWrite` protects every mutation API and the corresponding services. `canEditDailyExpenseTransactions` and `canDeleteDailyExpenseTransactions` also hide record actions for other roles. Each change rechecks and locks the persisted user role/status within the database transaction, so a stale session role cannot authorize a demoted or inactive user.

PDF downloads are also restricted to active SUPER_ADMIN users through `canDownloadDailyExpenseReport` and `authorizeDailyExpenseReport` in the page, route, and report data service.

## Ledger and money

- Current Balance = non-deleted BALANCE_ADDED amounts − non-deleted EXPENSE amounts.
- Total Balance Added = non-deleted BALANCE_ADDED amounts, regardless of expenses.
- Deleting an expense increases Current Balance by its amount and reduces Total Expenses. Deleting a balance addition decreases Current Balance and Total Balance Added by its amount; the resulting balance may be negative.
- Both cards are all-time totals and ignore history filters and pagination. An empty ledger has zero for both cards and total expenses. Negative balances are allowed, including when the first entry is an expense. There are no daily/monthly resets.

PostgreSQL numeric aggregation produces both totals from one consistent statement. Each transaction uses Prisma Decimal / `numeric(18,2)` with a positive amount. The API accepts only decimal strings with at most 16 whole digits and two fractional digits; it rejects zero, negative, malformed, non-finite, overflowing, and over-precision values without rounding. JSON money values are strings. Display formatting also preserves exact digits.

`DAILY_EXPENSES_CURRENCY` defaults to `BDT`, matching the application's monetary convention. `DAILY_EXPENSES_TIMEZONE` defaults to `Asia/Dhaka`. These workspace-specific settings are read when the ledger is first created and then persisted; changing environment variables does not reinterpret an existing ledger. Only currencies with two decimal places are supported. Ledger configuration is immutable from creation, including before its first entry. No currency conversion is provided.

The business date is stored as a PostgreSQL date separately from the server-created recording timestamp. New entries default to today in the ledger timezone. Past/current business dates are accepted; future entries are rejected. Today filtering uses the same timezone.

## Categories and audited records

Category names are trimmed, normalized, limited to 80 characters, and unique case-insensitively within the ledger, including archived categories. Category archive/restore and rename are audited. Archived categories stay in history and filter choices but cannot be selected for new expenses. A composite foreign key prevents cross-ledger category references. Balance additions have no category; expenses require an active category.

Super admins can edit a record's amount, business date, note, and expense category. Its type, original recorder, recording timestamp, ledger, and original submission metadata remain immutable. An edit can retain its current archived category; selecting another category requires an active category in the same ledger. Every edit and its before/after audit commit atomically. Summary totals are calculated from the corrected values. Direct set-balance operations remain unavailable; user/category/ledger foreign keys restrict deletion rather than cascading financial records. Initial funds must be posted through Add Balance.

Each record has a positive integer `version`, initially 1. Edits send `expectedVersion`, lock the record, and increment its version. A stale edit returns `TRANSACTION_CONFLICT` (409) and the UI requires refreshing and reopening the record. An identical retry at the immediately following version returns the saved record without writing a second audit. The database independently requires a transaction-local authorized editor, preserves immutable fields, and validates dates/categories/amounts.

Deletion shows a confirmation with the record details and its balance effect. It sends the reviewed `expectedVersion`, locks the record, sets `deletedAt`, increments the version, and commits a `DAILY_EXPENSE_TRANSACTION_DELETED` before/after audit in the same transaction. Deleted records disappear from history, counts, and all monetary aggregates. Their original rows and submission keys are retained to prevent a retried creation from reintroducing the balance effect. An already completed deletion safely replays without a second audit. A newer live record version causes a conflict and must be reviewed again. Deleted records cannot be edited, restored, or physically removed through this workflow; audit history remains available.

## API, cache, and safe retries

The client uses the existing request-scoped Redux provider and injects endpoints into its shared RTK Query API:

| Method         | Endpoint                                |
| -------------- | --------------------------------------- |
| GET            | `/api/daily-expenses/summary`           |
| GET            | `/api/daily-expenses/transactions`      |
| GET            | `/api/daily-expenses/report`            |
| PATCH / DELETE | `/api/daily-expenses/transactions/[id]` |
| POST           | `/api/daily-expenses/balance`           |
| POST           | `/api/daily-expenses/expenses`          |
| GET / POST     | `/api/daily-expenses/categories`        |
| PATCH          | `/api/daily-expenses/categories/[id]`   |

JSON responses use the application's JSON envelope; PDF downloads use `application/pdf` with an attachment filename. Both use `Cache-Control: no-store`. Mutations retain existing same-origin validation and per-actor rate limiting. Financial and category changes commit atomically with generic audit records, never attendance events.

Each intended financial submission has a random idempotency key. The database uniquely constrains `(ledgerId, idempotencyKey)`. A retry with the same actor and normalized payload returns the original transaction; a different actor or payload returns a conflict. Concurrent duplicate submissions create one transaction and one audit record. No financial mutations are replayed automatically. Pending retry state stays in memory: keep the workspace open until confirmation. Same-tab sidebar navigation is guarded, and document exit warns before discarding the key; a forced close, browser crash, or session change cannot recover an unconfirmed client submission automatically. Check history before initiating a new operation after such an interruption. An ambiguous response offers a retry of the same frozen submission and key. A confirmed save closes the form; a later failed refresh is shown as a refresh error and must not cause a new submission.

Edits preserve the original creation payload hash, so a retry of a previously confirmed creation still resolves to the existing record, including its current corrected values. Edit retries retain the frozen record ID, expected version, and submitted fields; they cannot overwrite an intervening edit. A creation retry or edit targeting a deleted record returns `TRANSACTION_DELETED` (409); the UI resolves the pending submission and refreshes instead of recreating it. Deletion retries retain the record ID and expected version, and never apply the balance change twice.

Successful transactions invalidate only `DailyExpensesSummary` and `DailyExpensesTransactions`. Category creation invalidates `DailyExpensesCategories`; category updates also invalidate history displays. List-wide tags cover all pages and filters. Balances are never optimistically changed. Queries refetch on mount/focus/reconnect and support manual refresh. Shared logout/session cleanup clears restricted data. There is no offline submission, persistent client ledger, service-worker caching, or real-time cross-user subscription.

## PDF reports

Super admins can use Download PDF beside Transaction history. The download uses the applied date range, type, category, and note search filters, including matching records across all history pages. Unapplied filter drafts do not affect the report. Deleted records are excluded, and edits are reflected in the saved amounts. The control is disabled while a financial mutation is pending.

The landscape A4 report includes filter scope, currency, business timezone, generation time, all-time balances, separate filtered totals/count, and the date/type/category/note/recorder/signed amount for each transaction. All-time totals ignore the report filters, while filtered net change is funds added minus expenses in the exported records. An empty selection produces a valid PDF with zero filtered totals. All records and global totals are read in one consistent database snapshot; exact decimal arithmetic preserves cents even across 10,000 maximum-size amounts.

Exports support at most 10,000 matching records and fail with `REPORT_TOO_LARGE` rather than silently truncating; narrow the filters and try again. The route allows 30 requests per user per minute. The existing PDFKit renderer handles page breaks, long notes, and bundled Bengali fonts. Font files are included for the new route in the standalone build. PDF bytes are downloaded with the shared `PdfDownloadButton` and are not stored in Redux or browser storage. This feature requires no additional database migration.

## Migration and verification

The migration requires ICU-enabled PostgreSQL with `pg_catalog."und-x-icu"` for Unicode-aware category name uniqueness, independent of the database locale.

The additive migration `prisma/migrations/20260927000000_daily_expenses/migration.sql` creates the enum and three dedicated tables, constraints, indexes, and guard triggers. It changes no existing financial or attendance records and seeds no transactions. Apply it through the normal reviewed migration process before enabling the new application version. Do not reset an existing database.

The subsequent migration `prisma/migrations/20260928000000_daily_expense_transaction_edits/migration.sql` adds record versions and replaces the blanket update ban with the guarded super-admin edit workflow. Apply it before running the application version that supports edits; existing records receive version 1. The delete ban and original creation metadata protections remain in effect.

Migration `prisma/migrations/20260929000000_daily_expense_transaction_deletions/migration.sql` adds the nullable `deletedAt` field and guarded deletion behavior. Existing records remain active. The migration retains physical deletion protection, prohibits changing financial details while marking deletion, and makes deleted records immutable. Apply it before running this application version, which filters summary and history on `deletedAt`.

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

### Super-admin edit verification

Verified on 2026-09-24 with a fresh disposable PostgreSQL cluster on `127.0.0.1:55439`. All 10 migrations applied successfully to the local test databases. The full Vitest suite passed (38 files, 529 tests), including 34 Daily Expenses database tests. All 10 Daily Expenses browser tests passed, including ADMIN denial, super-admin expense/balance edits, retained creators, refreshed totals, audit snapshots, and stale-edit recovery. Prisma validation, TypeScript, ESLint, and the production build also passed. These test runs did not alter the configured remote database.

The edit migration was subsequently applied to the configured application database on 2026-09-24 to resolve history loading against the missing `version` column. A read-only query using the application's Prisma model confirmed that history loads successfully and records have valid versions.

### Super-admin deletion verification

Verified on 2026-09-24 with disposable local PostgreSQL databases and all 11 migrations. The full suite passed (38 files, 547 tests), including 42 Daily Expenses database tests. All 13 Daily Expenses browser tests passed, covering deletion authorization, confirmation/cancellation, expense and balance adjustments, audit snapshots, retries after a lost response, and stale-record recovery. Prisma validation, TypeScript, ESLint, production build, and diff checks passed.

The deletion migration was then applied to the configured application database. Read-only history and summary queries passed, including consistency between the current balance and its component totals. The local development server was restarted to load the regenerated Prisma Client. No existing application records were deleted during verification.

### PDF report verification

Verified on 2026-09-24 using disposable local PostgreSQL databases. All 39 test files and 561 tests passed, including 46 Daily Expenses database tests and exact report totals for 10,000 maximum-size amounts. All 16 Daily Expenses browser scenarios passed across the initial run and the targeted rerun of a corrected PDF exclusion assertion. The PDF cases cover super-admin access, all five applied filters, every history page, deleted/nonmatching record exclusion, long Bengali notes, and empty selections.

The six-page filtered fixture and one-page empty fixture were rendered and visually inspected for complete text, legible Bengali glyphs, table wrapping, headers, and page numbers. TypeScript, ESLint, production build, and diff checks passed; both Bengali font files were confirmed in the new route's trace and standalone output. The running local report route correctly rejects unauthenticated requests with no-store JSON. No schema migration or remote data mutation was needed for PDF downloads.
