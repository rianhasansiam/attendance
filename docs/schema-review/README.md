# Production schema review proposal

This directory contains a reviewed target schema and a coordinated migration
proposal. The running application's `prisma/schema.prisma` is not replaced by
these files. All 18 existing models, current attendance statuses, authentication
relations, the employee/business-date unique key, and `Attendance.shiftId` remain.

- `schema.prisma`: complete target, validated with the repository's Prisma 7.10.0.
- `migration.sql`: data-preserving column/type/index/reviewer-relation changes.
- `constraints.sql`: additional PostgreSQL CHECKs, snapshot trigger, and assignment exclusion constraint.
- `validation.mjs` / `validation.md`: isolated PostgreSQL rehearsal and its results.

Apply both SQL files together as a **new** Prisma migration, after deploying the
required application changes in a coordinated maintenance window. Neither SQL
file is intended to be applied independently. For a rolling deployment, separate
nullable expansion, dual writing, backfill, and final contraction instead.

## Decisions

- Replace validated `HH:mm` strings with integer wall-clock minutes, 0–1439.
  Preserve the existing rejection of equal start/end. The overnight predicate
  remains `endMinute <= startMinute`; equality would mean a 24-hour schedule and
  is not enabled by this proposal.
- `attendanceDate` is the local calendar date of scheduled start. `@db.Date`
  remains appropriate; the JavaScript UTC-midnight value is only a date carrier.
- Use `timestamptz(3)` for instants, not for business dates. The SQL explicitly
  interprets old timestamp values as UTC. Audit that assumption across Prisma,
  raw writes, imports, and database-default timestamps before production use.
- Preserve `shiftId`, and snapshot start/end instants, timezone, grace minutes,
  and half-day threshold. Never backfill unknown history from today's mutable
  Shift and label it authoritative. Legacy snapshots can remain all null;
  the trigger requires complete new snapshots, including a new check-in on an
  old no-punch row, and prohibits clearing established snapshots. Complete
  corrections remain possible and must be authorized and audited.
- Keep the existing combined `AttendanceStatus` for current reporting semantics.
  Add a separate day classification only when worked-on-holiday/leave reporting
  requires both dimensions at once. Pure nonworking days then need a nullable
  outcome or an explicit not-applicable outcome, not a fabricated ABSENT.
- Keep one employee/business-date row and the existing one-open-row partial
  unique index. If split shifts become real, retain Attendance as the day parent
  and introduce child work sessions with their own shift/schedule/punch evidence.
- Add named `LeaveReviewer` relation with `onDelete: Restrict`. Status and role
  authorization still belongs in the application; a foreign key only proves
  reviewer existence.
- Add a closed event enum covering all 11 values emitted by current source.
- Preserve existing raw holiday/open-attendance uniqueness and immutable history
  triggers. Add inclusive, nonoverlapping employee-assignment dates using
  `btree_gist` and an exclusion constraint.
- Database weekday validation enforces values 0–6, no nulls, one dimension,
  and at most seven entries. Keep the existing application validation rejecting
  duplicate weekdays; the SQL array-membership check does not enforce that.

## Index decisions

| Model | New or replacement index | Purpose |
| --- | --- | --- |
| User | status, role | Active role filtering and status-only prefix; not substring search |
| AttendanceEvent | attendanceId, createdAt DESC, id DESC | One attendance record's chronological history |
| AttendanceEvent | employeeId, createdAt DESC, id DESC | Replace existing employee history index; add stable ordering |
| AttendanceEvent | type, createdAt DESC, id DESC | Replace existing type history index; equality/in enum filters |
| AttendanceEvent | createdAt DESC, id DESC | Existing global admin event stream |
| WebAuthnChallenge | employeeId, purpose, sessionId, usedAt, expiresAt | Replace employee/purpose index for valid-by-context lookup; retain old equality prefix |
| Leave | status, createdAt DESC, id DESC | Replace status-only index for sorted pending/admin queues |
| AuditLog | createdAt DESC, id DESC | Replace timestamp-only index for global cursor pages |
| AuditLog | actorId, createdAt DESC, id DESC | Actor history |
| AuditLog | resource, resourceId, createdAt DESC, id DESC | Replace resource pair for chronological resource history |
| EmployeeShift | SQL exclusion's GiST index | Enforce nonoverlapping assignment date ranges |

The existing Attendance indexes already match employee/date, office/date,
status/date, shift/date, and updatedAt/id queries. Keep them. Keep expiry indexes
for challenge/session/rate-limit cleanup. Current challenge verification uses its
primary key; the context index does not speed up that primary-key path. Do not
also add a session/purpose index without an independent session-wide query.

## Migration procedure

1. Audit the actual database and migration status using a direct connection.
   Confirm both original partial indexes and immutable-history triggers exist.
   Review distinct event types, orphan reviewers, invalid geometry/numeric
   values, overlapping assignments, and duplicate global holidays. Determine
   the old timestamp storage convention. Do not print connection credentials.
2. Rehearse against an isolated copy with representative production data.
   The checked-in validation script uses a disposable local PostgreSQL cluster,
   never the `.env` database. It proves structural/data-preservation behavior,
   not production query speed or existing production-data cleanliness.
3. In the implementation checkout, prepare the target schema and app changes.
   Use `pnpm exec prisma migrate dev --name production_schema_hardening --create-only`
   against the isolated development database. Review every generated statement.
4. Replace destructive generated Shift/event changes with the reviewed SQL here.
   Put `BEGIN;`, the contents of `migration.sql`, the contents of
   `constraints.sql`, and `COMMIT;` in that new migration's `migration.sql`.
   Do not modify applied migrations. The original CHECKs/partial indexes/triggers
   are preserved and replayed through migration history, not recreated here.
5. Apply the new migration on the rehearsal database, generate Prisma Client,
   run app type checking and behavioral tests, and replay the entire history on
   an empty shadow database. Inspect `pg_constraint`, `pg_indexes`, and triggers:
   a schema-only diff cannot prove unsupported objects were preserved.
6. After staging succeeds, deploy using `pnpm exec prisma migrate deploy`, then
   the matching generated client/application. Keep writes quiesced during this
   coordinated migration. Do not run `db push` or development reset against
   production. Treat contract rollback as a planned restore/forward fix.

The supplied migration takes table locks and performs ordinary index builds.
For large tables, build replacement indexes with `CREATE INDEX CONCURRENTLY`
before dropping old ones, outside a transaction; use `CHECK ... NOT VALID`
followed by `VALIDATE CONSTRAINT` for eligible checks/FKs. Exclusion constraints
cannot use that same NOT VALID strategy; schedule their lock/build separately.
Timestamp and event-enum type conversions also need a measured deployment plan.

Prisma 7.10 supports partial indexes behind the `partialIndexes` Preview feature.
This proposal keeps the existing SQL-managed partial indexes without enabling a
preview feature. CHECKs, exclusion constraints, and triggers require custom SQL.
The existing `prisma-client-js` generator is retained for import compatibility;
its deprecation should be addressed in a separate generator/import migration.

## Required application changes

- Update Shift validation, management forms/catalog, seed data, report selects,
  types, and tests to use minutes. Parse/format `HH:mm` only at API/UI boundaries.
- Replace naive local-clock date selection with bounded candidate schedule
  windows for yesterday/today/tomorrow (when the early-arrival window is under
  24 hours). Check assignment dates for each candidate and reject zero/multiple
  eligible windows. New check-in at/after scheduled end is rejected by default.
- Choose an authoritative IANA timezone. For the common office model, require
  assigned shift timezone to match office timezone. Guard timezone updates and
  office transfers; checkout uses the original attendance office/snapshot.
- Resolve start and end local datetimes separately. Do not add 24 elapsed hours
  for an overnight boundary. Detect DST gaps/folds and reject or explicitly
  disambiguate; a local round-trip check only detects gaps.
- Write snapshots for all attendance creation/new check-in paths. Checkout and
  corrections calculate from snapshots. Handle legacy open rows before rollout
  or through an explicit, evidence-based correction path.
- Prefer new Shift IDs plus dated assignments for future schedule changes when
  unmaterialized historical schedules must remain stable. Reports currently
  synthesize missing ABSENT/LEAVE/HOLIDAY/WEEKEND rows using mutable calendars;
  finalize/persist daily results if those historical totals must be immutable.
- Replace event-type substring filters with typed equality/`in` matching. Keep
  descriptive error codes in `reason` and structured details in `metadata`.
- Require an active authorized reviewer and write reviewer ID/time with status
  atomically. Map FK/check/exclusion/uniqueness errors to domain responses.
- Preserve separate atomic challenge consumption before the attendance
  transaction. Recheck authorization and current security policy inside the
  short transaction; lock Employee, then credential/attendance consistently
  across attendance and admin correction paths. Retry Serializable conflicts
  only in a bounded internal retry, with the same consumed challenge context.
- Keep credentials/counters, punches, success event, and any audit record in
  one transaction. Write rejection events after rollback without masking the
  original error. No browser or network waits while database locks are held.
- Use bounded `select` queries and candidate assignment windows. Use value-based
  cursor pagination for large attendance/events/audit histories. Mutable
  updatedAt ordering is a live feed, not a consistent export snapshot.

Relevant source findings are in `src/modules/shifts/calculations.ts`,
`src/modules/attendance/service.ts`, `src/modules/management/corrections.ts`,
`src/modules/management/service.ts`, `src/modules/reports/service.ts`, and
`src/modules/webauthn/service.ts`.

References: [PostgreSQL constraints](https://www.postgresql.org/docs/current/ddl-constraints.html),
[date/time types](https://www.postgresql.org/docs/current/datatype-datetime.html),
[multicolumn indexes](https://www.postgresql.org/docs/current/indexes-multicolumn.html),
[range exclusion constraints](https://www.postgresql.org/docs/current/rangetypes.html),
[Prisma database features](https://docs.prisma.io/docs/orm/v7/reference/database-features),
[Prisma partial indexes](https://www.prisma.io/docs/orm/v7/prisma-schema/data-model/indexes).
