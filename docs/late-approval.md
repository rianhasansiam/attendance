# Late approval and overtime implementation

## Behavior and calculations

The existing late-reason dialog retains its required reason and adds an optional
**Request late approval** checkbox. Saving the reason and creating the request
happen in the same transaction. A unique attendance reference prevents duplicate
requests; identical retries return the existing result without repeating events.

Both `EMPLOYEE` and `MANAGE_DRIVER` users with an employee profile can submit
requests for their own attendance through **My day**. Manage Driver keeps the
same employee attendance permissions; it cannot review, approve, or reject
requests. Review remains available to Admin and Super Admin.

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
endBalanceMinutes = floor((checkOut - scheduledEnd) / 60000)
overtimeMinutes = min(workedMinutes, endBalanceMinutes - actualLateMinutes)
```

Late approval never changes this stored signed work-hour balance. For an 08:30–17:00 schedule,
09:00–17:30 yields 30 late minutes, 30 raw overtime minutes, and zero effective
overtime, whether approved or not. Leaving at 17:00 instead yields `-30` minutes;
leaving at 16:00 yields `-90` minutes. Open attendance stays at zero until checkout.
Check-out and corrections persist this result. Official overtime credit is a
separate [Super Admin overtime approval](overtime-approval.md) projection: at
least 60 minutes of actual work after scheduled end must be requested and approved.
Late approval alone never grants overtime credit.
Existing date-fns-tz, overnight, grace, half-day, leave, holiday, and weekend rules
remain in use. The existing completed-minute rounding and break rules are preserved.

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

The subsequent `20260927120000_signed_overtime` migration allows negative
balances and recalculates completed records with a known scheduled end using the
signed formula above. It preserves unknown historical balances, open attendance,
punches, and approval records. Apply it before running this version.

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

## Deployment

1. Test the migration against an isolated database or branch with representative
   historical data.
2. In a coordinated release, stop older application writers, run
   `pnpm db:migrate` using the target database's direct migration connection,
   then build/start the updated app (`pnpm build`, `pnpm start`).
3. Do not run `prisma db push`, reset attendance, or reseed production. There is
   no separate timestamp backfill or manual overtime subtraction to run.
