# Overtime approval

Employees qualify after 60 completed minutes worked beyond their captured duty end. Eligible minutes are `max(0, floor((checkout - max(checkin, scheduledEnd)) / 60000))`. The threshold is a minimum, not a deduction: approval of 75 requested minutes credits all 75. Time before duty end never earns overtime.

## Employee checkout

Checkout first reads a private server preview of the active attendance record. At 60 minutes or more, the existing modal shows the employee, scheduled end, checkout-time preview, extra duration, and a required 10–1,000-character reason. Cancel leaves attendance open. Submit starts the existing passkey/GPS/network verification; final server time determines the actual checkout and requested duration.

`GET /api/attendance/check-out` returns the preview. The existing POST adds the expected `attendanceId` and optional `overtimeReason`. The server recomputes eligibility and atomically saves checkout and one Pending request. It accepts no client duration, approval status, or authoritative timestamp. If verification crosses the threshold after an ineligible preview, the client collects a reason and starts fresh verification. Consumed assertions and stale location evidence are never replayed. Lost responses use the existing authoritative attendance recovery.

Saved schedule boundaries govern different and overnight shifts. Legacy open rows retain the existing linked-shift/business-date fallback. Invalid schedules fail closed. A record reopened by correction that already has an overtime request cannot create another eligible checkout request; a Super Admin must complete the attendance correction.

## Super Admin review

Only Super Admins can open `/admin/overtime-requests` or its list/review APIs. The table supports employee-name/ID search, status, inclusive attendance-date range, department, and pagination. Pending requests appear first by default, newest first. Approval and rejection require confirmation; rejection permits an optional reason. Super Admin self-review is allowed.

`GET /api/admin/overtime-requests` lists requests; `PATCH /api/admin/overtime-requests/[id]` accepts Approved or Rejected, with a rejection reason only for rejection. The service rechecks the persisted active role inside its transaction. Employee locks, a unique attendance reference, and a conditional Pending-only transition prevent competing checkouts and decisions. A decision stores reviewer/time and writes audit and attendance events in the same transaction. Deleted employees' requests remain read-only history; deleting a reviewer retains the decision timestamp.

Corrections preserve the original request and its status. Approval counts only while captured check-in, scheduled end, checkout, and requested duration still match attendance. An outdated Pending request can be rejected but cannot be approved. There is no request editing, reopening, revision, or historical submission workflow.

## Official totals and payroll

Attendance displays expose requested duration/status and approved minutes separately from the retained signed work-hour balance. Pending, rejected, outdated, and unrequested records contribute zero positive credit on all dates. Historical records are preserved without automatic requests or approvals. Unknown historical schedules remain unknown facts, while their unapproved credit is known zero.

The shared net-total policy subtracts the existing 30-minute penalty for actual lateness above five minutes and the shortage below 510 worked minutes on completed days. These deductions also apply when credit is zero and can make totals negative. Approval grants full requested extra time without the former actual-lateness offset; late approval does not waive the separate deductions.

Employee/admin views, filtered totals, PDF reports, and salary/DOCX calculations share this policy. Report hydration retains the scanned request facts, preventing concurrent decisions from mixing row and total snapshots. Salary tokens cover request status and source facts; changes require recalculation before download. Retained salary previews become stale on relevant refreshes and route activation.

## Migration and deployment

`20261114000000_overtime_approval` adds the request enum/table, unique attendance reference, queue indexes, foreign keys, and eligibility/review-state constraints. It does not rewrite attendance, infer historical schedules, create requests, or auto-approve prior overtime.

Rehearse migrations on an isolated database with representative historical data. Apply `pnpm db:migrate` with a valid deployment connection, then regenerate/build and switch every application instance to the approval-aware release. Stop older writers during the coordinated cutover: they do not enforce checkout reasons or approval-only credit. Retain the additive schema if rolling back, and use an approval-aware application build. Do not reset, push, or reseed production data.

## Focused verification

`pnpm test:overtime` uses Node's test runner and existing `tsx`; it adds no packages. Unit/HTTP/client tests run without a database. Integration tests require `TEST_DATABASE_URL` pointing to a disposable local PostgreSQL database whose name contains `test`, with all migrations applied. Fixtures are synthetic and the database must be discarded afterward.

```sh
DATABASE_URL="$TEST_DATABASE_URL" pnpm db:migrate
TEST_DATABASE_URL="$TEST_DATABASE_URL" pnpm test:overtime
pnpm lint
pnpm typecheck
pnpm format:check
pnpm db:validate
pnpm build
```

Coverage includes threshold boundaries, full approved durations, reason validation, authorization/self-review, duplicate and concurrent decisions, transaction rollback, correction mismatches, schedule snapshots, historical zero credit, and salary token invalidation. Browser verification additionally covers responsive English/Chinese dialogs/tables, cancellation, confirmation, and network recovery. Physical passkey and GPS-provider behavior still requires an enrolled device.
