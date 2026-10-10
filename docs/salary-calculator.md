# Salary calculator

The admin sidebar opens `/admin/salary-calculator`. Only `SUPER_ADMIN` can open the page, read salary settings, create effective-month revisions, calculate salaries, or download statements. The current role model has no delegated salary permission for `ADMIN`; ordinary admin access does not grant payroll access. The application has a shared workspace with no organization membership or per-admin office scope. Office and department filters narrow employee selection; they do not grant permissions.

The page supports employee search, office and department filters, pagination, salary configuration, individual or visible-page calculations, a breakdown, and private DOCX downloads. The selected month defaults on the server using the configured application timezone. Inclusive **From date** and **To date** controls default to the whole month and allow a custom range, such as 20–30 September 2026. Both dates must be real calendar dates within the selected payroll month, and the end cannot precede the start. Changing the month resets the dates to that month's bounds. Editing dates clears the displayed previews; apply filters before calculating again. Missing settings show **Not configured** and block calculation; an explicitly configured zero remains valid.

Salary is calculated for the selected inclusive range. The configured salary is a monthly reference amount, divided by the fixed divisor **26**, then multiplied by payable days. Payable days equal calendar days in the range minus weekends configured on the employee's office (`Office.weekendDays`, with 0 = Sunday through 6 = Saturday). Both boundary dates count. For example, 20–30 September 2026 contains 11 calendar days; an office with Friday and Saturday weekends excludes two dates, leaving nine payable days. A reference salary of 18,000 produces range base pay of 6,230.77 before overtime. Holidays, leave, absence, or missing attendance do not independently remove base-pay days; this policy excludes weekends only. The day count does not depend on whether a weekend attendance row is classified as Present.

The selected dates, reference salary, fixed divisor, calendar days, excluded weekends, payable days, formula, and range base pay appear in the breakdown and DOCX. Attendance and overtime are restricted to the same range. Weekend attendance remains in the authoritative overtime calculation; excluding weekends from base-pay days does not introduce a new overtime eligibility rule. A completed past range within the current month is not marked ongoing. For a range extending through today or later in the current month, base pay covers the selected calendar range while overtime reflects attendance recorded so far.

## Salary settings and calculation

`SalarySetting` stores append-only, effective-month revisions. Both amounts are exact `DECIMAL(18,2)` values. A setting takes effect from the first day of its month. The latest effective month on or before the payroll month wins; the latest revision wins within the same month. Saving a future revision does not change earlier payroll periods. Same-month corrections create another revision with its author and creation timestamp, and a `SALARY_SETTINGS_REVISED` audit entry. Financial fields are protected against in-place updates in PostgreSQL. Salary audit entries are also protected from the existing ADMIN audit endpoints.

The application currency and default timezone reuse the existing `DAILY_EXPENSES_CURRENCY` and `DAILY_EXPENSES_TIMEZONE` configuration and validator (defaults: `BDT`, `Asia/Dhaka`). The same two-decimal currency restriction applies. No new environment variable is required. Attendance timestamps use each record's configured shift timezone, matching the existing attendance export conventions.

The calculation service calls `reportRecords` once for the selected employee IDs and inclusive date range. The existing report handles schedule dates, overnight shifts, actual and derived attendance, approved leave, holidays, weekends, incomplete records, and future-date suppression. Each returned row uses the existing `attendanceOutcome` projection and `countedOvertimeMinutes` policy, exactly as the attendance report does. The existing signed lateness and completed-workday adjustments are retained. Approval classification and matching attendance facts are retained; payroll does not introduce another approval or overtime policy. Completed legacy records with unknown overtime block the calculation with an actionable correction message.

Prisma Decimal arithmetic uses integer minutes and a high-precision Decimal context:

```text
Payable days = inclusive calendar days − configured office weekend days
Range base pay = configured monthly reference salary / 26 × payable days
Overtime earnings = payable overtime minutes × configured hourly rate / 60
Total calculated salary = range base pay + overtime earnings
```

Base pay multiplies the exact monthly reference by payable days before dividing by 26, so a recurring daily-rate intermediate cannot shift an exact half-cent below its rounding boundary. The displayed daily rate is not used to calculate base pay. Range base pay and overtime earnings are each rounded once to two decimal places using half-up rounding; the total adds these displayed components. The daily-rate DTO is rounded only for display. No tax, absence, unpaid leave, bonuses, allowances, or separate joining/leaving deductions are added. Calculation and download do not mark payroll paid, create expenses, edit attendance, or initiate approvals. A full-month range uses this same formula and is not a special full-month salary mode. The divisor stays 26 even if the selected month has a different number of calendar or working days.

## Preview and download integrity

All salary routes require a current persisted session and SUPER_ADMIN role. POST requests enforce the application's existing same-origin checks. Requests use strict schemas and cannot submit overtime, totals, or statement content. Queries and batch size are bounded; effective settings are selected in bulk using indexed lateral lookups.

Calculations issue a server-signed token bound to the actor, employee, payroll month, exact inclusive dates, generation time, salary revision, complete statement projection, office identity and weekend policy, and supporting attendance report. Tokens expire after two hours. The download service reads the current authoritative sources, verifies the token and source digest, and requires recalculation if those sources changed, including an office transfer or weekend-policy change. It retains the preview's generation timestamp and exact amounts. A token for another employee, month, date range, or actor cannot be reused.

The document generator uses `docx` 9.9.0 to create editable OOXML with A4 portrait pages and 19 mm margins. Page one contains the company header, employee details, salary formula and day counts, salary summary, and scope. An explicit page break starts attendance details on page two. Rows are chronological, table headers repeat on continuation pages, ordinary rows stay together, overnight timestamps include their calendar date, and missing timestamps use an em dash. A footer contains page numbers. The existing company logo is read from a fixed local asset and omitted gracefully when unavailable. The existing standalone packaging script copies this public asset.

The first page uses compact employee metadata, a labeled calculation table, and an emphasized total. An **Acknowledgment** section provides blank employee signature and date fields, plus prepared-by signature, name, and date fields. Signing acknowledges receipt and review of the statement; it does not record salary payment or approval. The signature block stays with the complete summary on page one. Each footer identifies the employee and payroll month alongside the page count.

The download is an authenticated POST response with the DOCX MIME type, a sanitized attachment filename (including both dates for custom ranges), and `Cache-Control: no-store`. Documents are not saved to public storage. Failed or empty document generation returns an actionable JSON error.

## Migration

New migration: `prisma/migrations/20261010120000_salary_settings/migration.sql`. It adds one table, employee and author relationships, month/revision/amount constraints, effective-setting indexes, and the financial-history update trigger. Existing employee deletion workflows clear nullable references while retaining revisions and audit evidence.

For a development database, apply the checked-in migration and regenerate the client:

```sh
pnpm exec prisma migrate dev
pnpm db:generate
```

For production, with the deployment's database environment configured:

```sh
pnpm db:migrate
pnpm db:generate
pnpm build
```

The existing `prisma.config.ts` derives Neon's direct endpoint for migrations and respects an explicit `DATABASE_URL` override. The application's pooled connection remains configured for normal traffic. Rehearse migrations in an isolated database or Neon branch before production deployment.

After changing the Prisma schema, regenerate the client and restart a development server that was already running:

```sh
pnpm db:generate
# Restart the running development process, then start it again.
pnpm dev
```

An older globally cached Prisma client can lack newly generated model delegates and cause a generic request error even when the migration is applied. `src/lib/db.ts` now reuses a cached client only when its constructor matches the current generated client; it replaces and retires stale clients. The salary-settings failure reported on 10 October was checked against an up-to-date database, and the local server was regenerated and restarted. No employee salary values were changed during diagnosis.

## Verification

```sh
DATABASE_URL="$TEST_DATABASE_URL" pnpm db:migrate
TEST_DATABASE_URL="$TEST_DATABASE_URL" pnpm test
TEST_DATABASE_URL="$TEST_DATABASE_URL" pnpm exec playwright test tests/e2e/salary-calculator.spec.ts
pnpm lint
pnpm typecheck
pnpm build
```

`TEST_DATABASE_URL` must point to a disposable PostgreSQL database with `test` in its name. Salary fixtures cover permissions, settings and history, monetary precision, authoritative overtime, timezone and payroll boundaries, inclusive custom ranges, weekend exclusion, the fixed 26-day divisor, range/office-policy token binding, source changes, document agreement, long names, absent optional details and logos, and attendance overflow.

Generate synthetic samples with:

```sh
node --conditions react-server --import tsx scripts/generate-salary-samples.ts /tmp/attendance-salary-docx-qa
```

## Changed files

| Files                                                                                                                                                | Purpose                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `src/modules/salary/contracts.ts`, `calculations.ts`, `service.ts`, `version.ts`, `docx.ts`                                                          | Shared validation/DTOs, precise calculation, history persistence, source-bound export tokens, editable statements. |
| `prisma/schema.prisma`, `prisma/migrations/20261010120000_salary_settings/migration.sql`                                                             | Salary revision model, relationships, indexes, financial/date constraints and history update protection.           |
| `src/app/api/admin/salary/_access.ts`, `route.ts`, `settings/route.ts`, `calculate/route.ts`, `statement/route.ts`                                   | Authorized list, configuration, calculations and private downloads.                                                |
| `src/app/admin/salary-calculator/page.tsx`, `src/components/salary-workspace.tsx`, `salary-workspace.module.css`, `src/store/features/salary/api.ts` | Protected route, responsive interface and workspace data integration.                                              |
| `src/components/app-shell.tsx`, `src/app/admin/layout.tsx`, `src/store/api/tags.ts`                                                                  | Sidebar entry, salary messages and cache invalidation tags.                                                        |
| `messages/{en,zh-CN}/{navigation,salary}.json`, `src/i18n/{messages,feature-messages,types.d}.ts*`                                                   | English/Chinese labels and namespace integration.                                                                  |
| `src/modules/reports/service.ts`                                                                                                                     | Optional bounded employee-ID scope using the unchanged authoritative report logic.                                 |
| `src/modules/daily-expenses/service.ts`                                                                                                              | Export of the existing currency/timezone validator for reuse.                                                      |
| `src/modules/management/service.ts`                                                                                                                  | Confidential salary audit protection in general admin list/detail endpoints.                                       |
| `src/lib/db.ts`, `tests/db-client.test.ts`                                                                                                           | Refresh stale generated Prisma clients retained across development reloads and cover cache reuse and cleanup.      |
| `tests/salary*.test.ts`, `tests/fixtures/salary-statement.ts`, `tests/e2e/salary-calculator.spec.ts`                                                 | Financial, database, permissions, source integrity, document, UI and browser regression coverage.                  |
| `tests/server-display-boundaries.test.ts`, `tests/late-approval-integration.test.ts`                                                                 | Salary audit privacy and correction of an older assertion to match the existing signed overtime policy.            |
| `scripts/generate-salary-samples.ts`                                                                                                                 | Reproducible fixture documents for rendering and visual review.                                                    |
| `package.json`, `pnpm-lock.yaml`                                                                                                                     | Added `docx` 9.9.0 and its dependency lock entries.                                                                |
| `docs/salary-calculator.md`                                                                                                                          | Architecture, payroll scope, rollout and verification record.                                                      |

## Range salary verification from 10 October 2026

All database validation used a disposable local PostgreSQL cluster. The application's configured production database and environment file were not changed.

| Check                                           | Actual result                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Migration deployment in the disposable database | All 21 checked-in migrations applied successfully. Salary constraints also exercised in independently migrated isolated test schemas.                                                                                                                                                                                                                                                                   |
| `TEST_DATABASE_URL=… pnpm test`                 | 106 suites, 1,586 tests passed; no skipped tests, including inclusive ranges, office weekend policies, half-cent rounding, hydration, and stale Prisma client replacement.                                                                                                                                                                                                                              |
| Salary Playwright suite                         | All 6 browser tests passed, including the configuration/calculation/download workflow, custom 20–30 September range with 18,000 ÷ 26 × 9 payable days and matching DOCX/preview totals, changing ranges, stale-data recalculation, desktop/mobile width, role/guest access, and ADMIN audit privacy.                                                                                                    |
| `pnpm lint`                                     | Passed with no warnings.                                                                                                                                                                                                                                                                                                                                                                                |
| `pnpm typecheck`                                | Passed.                                                                                                                                                                                                                                                                                                                                                                                                 |
| `pnpm db:validate`, `pnpm db:generate`          | Passed.                                                                                                                                                                                                                                                                                                                                                                                                 |
| `pnpm build`                                    | Passed; standalone assets packaged.                                                                                                                                                                                                                                                                                                                                                                     |
| Built standalone runtime                        | List/settings/calculation/DOCX returned 200; 18,000 ÷ 26 × 9 = 6,230.77 plus 400.00 overtime matched the 6,630.77 DOCX; 0.17 ÷ 26 × 13 rounded to 0.09; all four guest salary endpoints returned 401; document included the packaged logo and `no-store`.                                                                                                                                               |
| DOCX layout                                     | Bundled LibreOffice rendered the 31-row sample to 2 pages, the long-name/no-logo 80-row sample to 4 pages, and the 20–30 September custom-range sample to 2 pages with exactly 11 rows. All 8 final pages inspected: complete summary on page 1, attendance on page 2, selected dates, repeated continuation headers, readable totals/page numbers, no clipping, truncation or unnecessary blank pages. |
| Formatting                                      | All new salary files passed Prettier checks. The repository-wide check still flags the unchanged `src/components/corporate/header.tsx`.                                                                                                                                                                                                                                                                 |

The two older late-approval assertions were independently reproduced against the original `HEAD` report service before correction: both expected zero where the existing counted overtime policy returns a minus-30-minute adjustment. Only their expectations changed; attendance rules did not change.

Visual inspection used LibreOffice. Microsoft Word's renderer was not available for a separate layout check. No production migration or deployment was performed.

## DOCX design and acknowledgment verification from 10 October 2026

The document design update changes only DOCX presentation, synthetic sample tooling, document tests, browser download assertions, and this documentation. Salary amounts, weekend rules, settings, and API permissions retain the verified range policy. No migration, dependency, or configuration change is required.

The final checks passed: 9 DOCX tests, 39 salary HTTP tests, all 6 salary browser tests, repository lint, TypeScript, and the production build. Browser downloads verify the blank employee and preparer fields appear before the attendance page break.

Bundled LibreOffice rendered four synthetic samples: standard (2 pages, 31 attendance rows), long-name/no-logo overflow (4 pages, 80 rows), September 20–30 range (2 pages, 11 rows), and combined long-name/no-logo/ongoing/signed-overtime (2 pages, 31 rows). All 10 final page images were inspected, including an independent review. Complete salary summaries and acknowledgment forms remain on page one; attendance starts on page two; continuation headers, overnight dates, totals, and employee/month/page footers are readable without clipping. Microsoft Word was not available for a separate renderer check.
