# Salary calculator

The admin sidebar opens `/admin/salary-calculator`. Only `SUPER_ADMIN` can open the page, read salary settings, create effective-month revisions, calculate salaries, or download statements. The current role model has no delegated salary permission for `ADMIN`; ordinary admin access does not grant payroll access. The application has a shared workspace with no organization membership or per-admin office scope. Office and department filters narrow employee selection; they do not grant permissions.

The page supports employee search, office and department filters, pagination, salary configuration, individual or visible-page calculations, a breakdown, and private DOCX downloads. The selected month defaults on the server using the configured application timezone. Inclusive **From date** and **To date** controls default to the whole month and allow a custom range, such as 20–30 September 2026. Both dates must be real calendar dates within the selected payroll month, and the end cannot precede the start. Changing the month resets the dates to that month's bounds. Editing dates clears the displayed previews; apply filters before calculating again. Missing settings show **Not configured** and block calculation; an explicitly configured zero remains valid.

Salary is calculated for the selected inclusive range. The configured salary is a monthly reference amount, divided by the fixed divisor **26**, then multiplied by payable days. Payable days equal calendar days in the range minus weekends configured on the employee's office (`Office.weekendDays`, with 0 = Sunday through 6 = Saturday). Both boundary dates count. For example, 20–30 September 2026 contains 11 calendar days; an office with Friday and Saturday weekends excludes two dates, leaving nine payable days. A reference salary of 18,000 produces range base pay of 6,230.77 before overtime. Holidays, leave, absence, or missing attendance do not independently remove base-pay days; this policy excludes weekends only. The day count does not depend on whether a weekend attendance row is classified as Present.

The selected dates, reference salary, fixed divisor, calendar days, excluded weekends, payable days, formula, and range base pay appear in the breakdown and DOCX. Attendance and overtime are restricted to the same range. Weekend attendance remains in the authoritative overtime calculation; excluding weekends from base-pay days does not introduce a new overtime eligibility rule. A completed past range within the current month is not marked ongoing. For a range extending through today or later in the current month, base pay covers the selected calendar range while overtime reflects attendance recorded so far.

## Salary settings and calculation

`SalarySetting` stores append-only, effective-month revisions. Both amounts are exact `DECIMAL(18,2)` values. A setting takes effect from the first day of its month. The latest effective month on or before the payroll month wins; the latest revision wins within the same month. Saving a future revision does not change earlier payroll periods. Same-month corrections create another revision with its author and creation timestamp, and a `SALARY_SETTINGS_REVISED` audit entry. Financial fields are protected against in-place updates in PostgreSQL. Salary audit entries are also protected from the existing ADMIN audit endpoints.

The application currency and default timezone reuse the existing `DAILY_EXPENSES_CURRENCY` and `DAILY_EXPENSES_TIMEZONE` configuration and validator (defaults: `BDT`, `Asia/Dhaka`). The same two-decimal currency restriction applies. No new environment variable is required. Attendance timestamps use each record's configured shift timezone, matching the existing attendance export conventions.

The calculation service calls `reportRecords` once for the selected employee IDs and inclusive date range. The report handles schedule dates, overnight shifts, actual and derived attendance, approved leave, holidays, weekends, incomplete records, and future-date suppression. Each row uses `attendanceOutcome` and `countedOvertimeMinutes`, exactly as attendance reports do: full approved overtime credit minus the existing fixed late and completed-workday shortage deductions. Pending, rejected, outdated, and unrequested overtime earns zero credit. Historical unknown signed balances remain diagnostic and do not block payroll because their unapproved credit is known zero. See [overtime approval](overtime-approval.md).

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

Calculations issue a server-signed token bound to the actor, employee, payroll month, exact inclusive dates, generation time, salary revision, complete statement projection, office identity and weekend policy, and supporting attendance report. Tokens expire after two hours. Overtime request IDs, decisions, matching facts, and update timestamps participate in source validation, so approval, rejection, and attendance corrections require recalculation even when the credit stays zero. Retained previews are hidden on list refresh and route activation; older calculation responses cannot restore them. The download service verifies current sources and retains the preview's generation timestamp and exact amounts. A token for another employee, month, date range, or actor cannot be reused.

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

An older globally cached Prisma client can lack newly generated model delegates and cause a generic request error even when the migration is applied. `src/lib/db.ts` now reuses a cached client only when its constructor matches the current generated client; it replaces and retires stale clients.
