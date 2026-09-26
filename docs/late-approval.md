# Late approval and overtime implementation

Implemented on 2026-09-26.

## Behavior and calculations

The existing late-reason dialog retains its required reason and adds an optional
**Request late approval** checkbox. Saving the reason and creating the request
happen in the same transaction. A unique attendance reference prevents duplicate
requests; identical retries return the existing result without repeating events.

Admin and Super Admin can review requests at `/admin/late-approvals`, filter by
status, and approve or reject with an optional review note. A request transitions
once from `PENDING` to `APPROVED` or `REJECTED`. Review records the reviewer and time
and writes both the administrative audit and attendance event transactionally.

The attendance record keeps its original status, punches, late duration, and
reason. API display projections expose the original `actualStatus`,
`actualLateMinutes`, `lateApprovalStatus`, `isExcusedLate`, `effectiveLateMinutes`,
and effective `status`. Approved lateness has zero effective late minutes; a
`LATE` status becomes `PRESENT` for reporting. Half-day status remains half-day.
Pending, rejected, and unrequested late arrivals retain their late count.

An approval only excuses the check-in and late-duration facts captured in its
request. A subsequent correction preserves the audit decision but stops it from
excusing different arrival facts. A pending request whose facts changed cannot be
approved; it can still be rejected.

Checkout or status corrections preserve the recorded late duration when the
arrival timestamp is unchanged, even if the shift start or grace settings were
edited later. New or changed arrival timestamps are recalculated using the
captured start when available and the existing shift grace rule.

The existing grace definition is unchanged: elapsed minutes at or below grace
produce zero late minutes; once grace is exceeded, actual late minutes are
`ceil((checkIn - scheduledStart) / 60000)`.

The canonical shift calculation uses:

```text
workedMinutes = max(0, floor((checkOut - checkIn) / 60000))
rawOvertimeMinutes = max(0, floor((checkOut - max(checkIn, scheduledEnd)) / 60000))
overtimeMinutes = max(0, rawOvertimeMinutes - actualLateMinutes)
```

Approval never changes this overtime calculation. For an 08:30–17:00 schedule,
09:00–17:30 yields 30 late minutes, 30 raw overtime minutes, and zero effective
overtime, whether approved or not. Check-out and corrections persist this result;
dashboard, history, report totals, JSON, and PDF use the same server projection.
Existing date-fns-tz, overnight, grace, half-day, leave, holiday, and weekend rules
remain in use. No new break, overtime threshold, or rounding policy was added.

## Schema and API

Migration `20260926120000_late_approval` adds:

- `LateApprovalStatus` (`PENDING`, `APPROVED`, `REJECTED`).
- `LateApprovalRequest`, uniquely referencing attendance. Employee identity is
  obtained through attendance; no duplicate attendance or employee record is made.
  The request stores immutable reason, check-in, late duration, scheduled-start
  snapshot, request time, reviewer, review time, and optional note.
- Nullable `Attendance.scheduledStartAt`, captured for new attendance. Historical
  completed rows retain unknown starts rather than guessing historical schedules.
- Foreign keys, a positive-lateness check, review-field consistency checks, and
  indexes for request status/time and reviewer.

The migration recalculates known historical overtime from existing punches and
captured scheduled ends. It does not alter punches, stored actual status, actual
late duration, or audit history. Completed legacy records without a scheduled-end
snapshot retain unknown overtime.

API changes:

- `POST /api/attendance/late-reason`: adds optional boolean `requestApproval`.
- `GET /api/admin/late-approvals`: bounded `page`, `pageSize`, and optional `status`.
- `PATCH /api/admin/late-approvals/[id]`: accepts `status` and optional `reviewNote`.

Existing role helpers, database sessions, same-origin checks, rate limits, and
strict request validation apply. Submission rechecks attendance ownership and
employee/session authorization. Review rechecks the active persisted admin role
and prevents self-review. Serializable transactions and a conditional pending-only
update protect competing decisions. Clients cannot supply authoritative lateness,
overtime, reviewer, timestamps, or approval status at submission. Passkey, location,
network, and device verification are unchanged.

## Files

- Schema/migration: `prisma/schema.prisma`,
  `prisma/migrations/20260926120000_late_approval/migration.sql`.
- Calculations/services: `src/modules/shifts/calculations.ts`,
  `src/modules/attendance/{service,queries,outcome,late-approval}.ts`,
  `src/modules/management/{corrections,workflows}.ts`,
  `src/modules/reports/{service,attendance-pdf}.ts`.
- Routes/page: `src/app/api/admin/late-approvals/route.ts`,
  `src/app/api/admin/late-approvals/[id]/route.ts`,
  `src/app/admin/late-approvals/page.tsx`.
- UI: `src/components/{late-reason-dialog,late-approvals-workspace,app-shell,ui,employee-workspace,admin-workspace}.tsx`.
- Client contracts/cache: `src/store/features/{attendance,reports}/{api,contracts}.ts`
  plus `src/store/features/management/api.ts` and `src/store/api/tags.ts`.
- Updated tests: `tests/{attendance-cache,attendance-domain,late-reason,management,reports}.test.ts`.
- Added tests: `tests/attendance-outcome.test.ts`,
  `tests/late-approval-{http,integration,migration,ui}.test.ts`, and
  `tests/e2e/late-approval.spec.ts`.

Coverage includes on-time and late overtime (equal, smaller, and greater than
after-hours time), nonnegative totals, grace boundaries, overnight/timezone rules,
all request states, unchanged arrival facts after approval, approval followed by
real checkout, employee ownership and strict payloads, both administrator roles,
demoted/inactive reviewers, self-review denial, duplicate/concurrent requests and
decisions, corrections after shift edits, report filters/totals/history/PDF,
historical migration parity and constraints, and client recovery/cache races.

## Validation results

| Command/check                               | Result                                                                                                  |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `pnpm lint`                                 | Passed                                                                                                  |
| `pnpm typecheck`                            | Passed                                                                                                  |
| `pnpm db:validate`                          | Passed                                                                                                  |
| `TEST_DATABASE_URL=… pnpm test`             | 746 tests passed across 52 files; zero skipped, including real database integration and migration tests |
| `TEST_DATABASE_URL=… pnpm test:e2e`         | All 47 browser workflows passed                                                                         |
| Final late-approval Playwright rerun        | 3 feature workflows passed after follow-up changes                                                      |
| All 12 migrations on isolated PostgreSQL 18 | Applied successfully                                                                                    |
| `pnpm build`                                | Passed                                                                                                  |
| `git diff --check`                          | Passed                                                                                                  |

The test database was local and disposable, at port 55438. No remote data was
used or modified. Mobile request and history screens and the desktop review modal
were visually checked. The late request keeps one reason textarea and the
checkbox fits at a 390px viewport. Existing authentication, passkey, geofence,
network, correction, reporting, and unrelated application suites also passed.

## Deployment

1. Test the migration against an isolated database or branch with representative
   historical data.
2. In a coordinated release, stop older application writers, run
   `pnpm db:migrate` using the target database's direct migration connection,
   then build/start the updated app (`pnpm build`, `pnpm start`).
3. Do not run `prisma db push`, reset attendance, or reseed production. There is
   no separate timestamp backfill or manual overtime subtraction to run.

Validation used disposable local PostgreSQL. No migration or deployment was
performed against the configured remote database.
