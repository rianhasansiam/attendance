# Check-in and checkout performance

Implemented against baseline commit `635c7f1`. The changes are limited to attendance confirmation, verification scheduling, display-cache invalidation and opt-in measurements. No dependency, production configuration, deployment, schema or migration changes are required. Existing unrelated daily-expenses edits are preserved.

## Revised request flow

1. A user click starts a local attempt and, if enabled, a timing trace.
2. POST `/api/webauthn/authenticate/options` supplies current `required` (passkey) and `requireGeofence` flags from the authoritative office read. The dashboard's potentially stale policy is not used to decide whether to collect location. Missing/malformed requirements stop the attempt.
3. When both checks are required and the Permissions API reports location permission already granted, passkey verification and fresh GPS run together. First-time, unsupported, denied, failed or slow permission inspection falls back to the existing sequential passkey-then-GPS flow. Permission inspection waits at most 200 ms. GPS is never collected on dashboard load or before the options response.
4. All required evidence must be ready before the one attendance POST. GPS still requests high accuracy, `maximumAge: 0`, and the existing 20-second timeout. A fix older than 30 seconds, accounting for its timestamp and elapsed client time, is reacquired once before submission; another stale fix fails the attempt. Failure/cancellation aborts supported operations and ignores late GPS callbacks.
5. The server performs the existing authoritative checks and transaction. Success is returned only after attendance, credential updates and the success event commit. The single-use challenge remains consumed separately. No security writes or events are deferred.
6. The committed, sanitized POST result is allowlisted again before entering Redux. `applyConfirmedAttendance` merges it into `employeeDay(undefined)`, preserving unrelated dashboard fields and updating `today` and `recent` using the returned ID/date, including overnight checkout. An older in-flight day-query thunk is aborted; settling that thunk does not await its network response. A replacement query triggered by queued invalidation after commit can complete normally. Reset/session/attempt guards prevent stale cache updates.
7. React renders times, status, totals, buttons and any late-reason prompt from this confirmed cache entry. HISTORY, admin SUMMARY, events, Reports and Audit are invalidated independently. The confirmation does not issue or wait for another employee-day GET. DAY still refreshes on mount/reveal, focus, reconnect, manual refresh and visible/online polling. Other browser stores retain their independent refresh behavior; this adds no push channel.

Late reasons remain a separate mutation with the existing save-once validation and audit event. Their invalidation still includes DAY so the submitted reason reaches all relevant display data.

## Recovery and retained routes

A lost or malformed attendance POST response may represent a committed write. Recovery performs an authoritative GET; it never replays the POST or reuses the challenge. A successful GET alone does not unlock attendance: checkout must match the original open record ID/date/check-in and show a valid new checkout. Check-in must show a newly observed arrival at or after the dashboard's observed server time. An overnight record can be found in `recent` after the dashboard advances to a new day.

If the read fails or does not establish the intended transition, both buttons remain locked and manual refresh can retry only the read. This intentionally does not infer that a missing record proves the original submission failed. A known committed save followed by an unrelated failed refresh remains a confirmed success with cached attendance visible; the refresh error is separate. Hiding a retained Activity route cancels its attempt and clears transient busy state; late callbacks cannot submit. Pending recovery may resume its read when the user returns and refreshes.

## Opt-in measurements

Open `/employee/dashboard?attendanceTiming=1`, or run `window.__ATTENDANCE_TIMING__ = true` in that tab's DevTools console before the click. This is a temporary local diagnostic flag, not persisted configuration. Disabled tracing records no stage clocks or logs. No new service receives telemetry.

Each enabled attempt emits one `[attendance-timing]` console entry when it reaches a terminal outcome. Its random `traceId`, action, outcome, finite timing spans, `wallMs` and optional `postToVisibleMs` are the only logged data. Pending uncertain recovery keeps the trace open until confirmed or cancelled. Records, employee IDs, coordinates, credentials, session values, request bodies and error contents are never logged by this instrumentation.

| Client metric     | Meaning                                                                                                                 |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `options`         | Options request, including response parsing                                                                             |
| `passkey`         | Browser-library loading and passkey ceremony                                                                            |
| `gps`             | Initial location acquisition                                                                                            |
| `gps-refresh`     | Freshness-triggered reacquisition, if needed                                                                            |
| `post`            | Attendance request through response parsing                                                                             |
| `recovery`        | Authoritative recovery GET, when needed                                                                                 |
| `wallMs`          | Click through the React effect observing committed attendance and cleared busy state; includes browser/user interaction |
| `postToVisibleMs` | Successful POST response to that committed React display                                                                |

Each span has a start offset and duration. Parallel spans overlap; do not add their durations to derive elapsed time. The display metric observes the DOM commit/effect, not a hardware screen-paint timestamp.

Enabled options and attendance requests send `x-attendance-timing: 1`. Their responses expose `Server-Timing` in DevTools Network:

| Server metric                 | Meaning                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------- |
| `auth`, `rate_limit`          | Existing authentication and rate-limit work                                                 |
| `initial_policy`, `challenge` | Current office read and options/challenge handling                                          |
| `tx_acquire`                  | Transaction call until Prisma invokes its callback; includes connection/pool/start overhead |
| `employee_lock`               | Employee row-lock query, including wait                                                     |
| `authoritative_reads`         | Accumulated existing reads inside the transaction                                           |
| `verification`                | Passkey checks (including credential reads/lock/update), GPS and office network checks      |
| `db_write`                    | Attendance and success-event writes                                                         |
| `tx_finish`                   | Callback completion until commit/rollback settles, including driver overhead                |
| `transaction`, `total`        | Transaction and route wall time respectively                                                |

These metrics are nested/overlapping and are not additive. They are not individual SQL query timings. Server total excludes network delivery. Timing changes wrap existing operations; no query or index optimization was justified by measured production evidence. Repeated policy/session reads remain at their existing security boundaries.

## Reproducible device measurement

No real-device baseline or percentage speedup is claimed. Unit tests verify that confirmation needs no second day GET and that verification branches overlap; those assertions are not physical latency measurements.

1. Use an isolated test deployment/database and real enrolled/approved test credentials. Keep the same browser, device, network, office policy, server mode and database placement for each comparison. Do not disable required security checks to benchmark them. Use separate attendance fixtures for each sample because completed records cannot be checked in again.
2. For a baseline, run commit `635c7f1` in a separate checkout. Record the click and the attendance timestamp/button-state change using the browser Performance panel with screenshots. Include the options, attendance POST and dashboard GET requests in the recording. The old success banner alone is not the endpoint: the comparison is the updated attendance display and correct button state.
3. Run the revised build with `?attendanceTiming=1`. Record the same interaction and capture the allowlisted console timing entry and corresponding `Server-Timing` headers. Do not export request bodies, authentication headers or an unsanitized HAR.
4. Measure check-in and checkout separately, with both verifications enabled. Include cold and warmed runs, and first-time versus already-granted location permission separately. Repeat enough independent fixtures (for example 20 per condition) to report sample count, median and p95 rather than a single favorable run.
5. For granted permission, confirm the `gps` and `passkey` spans overlap and the POST starts after both finish. For first permission, verify sequential prompts. Verify that a passkey interaction exceeding 30 seconds causes `gps-refresh` before the POST. Preserve the 20-second acquisition timeout.
6. Count requests from click to updated display: one options request, at most one attendance POST, and no success-triggered employee-day GET. A focus/poll/manual GET can still occur independently. Check that history/admin/report views refresh through their defined mechanisms.
7. Simulate a lost POST response and failed recovery GET, then restore connectivity. Both buttons must stay locked until the intended action is observed. Separately fail a later refresh after confirmed success: saved times and the appropriate action state must remain visible.

Physical browser acceptance remains necessary for iOS Safari and Android/desktop passkey providers, device-specific Permissions API behavior, first-time location prompts, OS cancellation, actual GPS acquisition and user-activation requirements. Automated Chromium workflows and mocked ceremonies do not prove physical-device behavior.

## Validation coverage

Tests cover all four passkey/GPS policy combinations, either parallel completion order, both branch failures, safe first permission, GPS denial/timeout/staleness, server accuracy rejection, passkey cancellation, expired/consumed challenges, double clicks, stale reads, queued invalidation, account/reset/unmount guards, overnight records, late reasons, uncertain outcomes and evidence exclusion from Redux/logs. PostgreSQL suites exercise actual locks, constraints, signed assertions, policy changes and atomic success/rejection behavior. Final automated checks against disposable local PostgreSQL (existing migrations applied only to those test databases):

- `TEST_DATABASE_URL=<isolated local test DB> DATABASE_URL=<same DB> pnpm exec vitest run`: **47 files, 676 tests passed, no skips** (19.23 seconds for this suite run; not an attendance latency benchmark).
- `pnpm lint`: passed with no errors or warnings.
- `pnpm typecheck`: passed.
- Prettier check of all changed TypeScript/TSX files: passed.
- `pnpm build`: passed with explicit local test database and test auth configuration; attendance APIs remain dynamic.
- `TEST_DATABASE_URL=<separate isolated local test DB> DATABASE_URL=<same DB> pnpm exec playwright test tests/e2e/workflows.spec.ts tests/e2e/overtime.spec.ts`: **15 browser workflows passed**. This covers attendance, late reasons, overnight/overtime display, reports, access and navigation.

These commands used `DOTENV_CONFIG_PATH` pointing to a nonexistent temporary file for Prisma/Vitest fixture setup and explicit local database URLs. The application `.env` was not edited. Existing WebCrypto experimental and PostgreSQL driver deprecation notices did not fail the checks. No physical-device timings, real Google-provider sign-in, production load or cold remote database behavior were measured.

## Changed files

| File                                                 | Purpose                                                                                                       |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `src/lib/client/attendance-timing.ts`                | Opt-in client stage spans and confirmed-display timing; allowlisted output only                               |
| `src/lib/server-timing.ts`                           | Opt-in fixed-name server timing response headers                                                              |
| `src/lib/client/attendance-ceremony.ts`              | Fresh options policy, permission-aware parallel evidence collection, freshness and sibling cancellation       |
| `src/components/employee-workspace.tsx`              | Immediate confirmed cache update, late prompt, timing completion and guarded recovery/lifecycle state         |
| `src/lib/client/attendance-recovery.ts`              | Verify the intended transition in authoritative recovery data                                                 |
| `src/store/features/attendance/api.ts`               | Whitelisted merged day/recent cache, old-read fencing and scoped invalidation                                 |
| `src/store/features/reports/api.ts`                  | Admin summary tag aligned with selective invalidation                                                         |
| `src/modules/attendance/http.ts`                     | Time the existing HTTP guards and attach opt-in metrics                                                       |
| `src/modules/attendance/service.ts`                  | Measure existing policy/challenge/transaction/verification/write boundaries without changing attendance rules |
| `src/modules/webauthn/service.ts`                    | Return current geofence requirement with options and measure existing options work                            |
| `src/app/api/webauthn/authenticate/options/route.ts` | Opt-in timing around existing options guards/service                                                          |
| `tests/attendance-client.test.ts`                    | Rendered confirmation, late/overnight flows, recovery, Activity/session, old-read and privacy regressions     |
| `tests/attendance-cache.test.ts`                     | Preserved metadata, scoped invalidation, old/replacement reads and reset guards                               |
| `tests/attendance-ceremony.test.ts`                  | Policy combinations, overlap, permissions, cancellation, freshness and one POST                               |
| `tests/attendance-recovery.test.ts`                  | Exact intended transition, original overnight record and invalid/backdated results                            |
| `tests/attendance-timing.test.ts`                    | Client opt-in, overlap interpretation and privacy                                                             |
| `tests/server-timing.test.ts`                        | Server opt-in and nested/failed-phase timing                                                                  |
| `tests/attendance-server-timing.test.ts`             | Transaction completion, separate challenge consumption and rejection invariants                               |
| `tests/webauthn-options.test.ts`                     | Fresh policy combinations and existing HTTP security boundaries                                               |
| `tests/attendance-http.test.ts`                      | Timing headers and unchanged canonical response/rejection behavior                                            |
| `tests/employee-drive-query.test.ts`                 | Updated request count after eliminating unnecessary employee-day invalidation                                 |
| `docs/state-management.md`                           | Updated cache/flow/security documentation                                                                     |
| `docs/attendance-performance.md`                     | This implementation, measurement and validation record                                                        |
| `README.md`                                          | Link to the current attendance performance notes                                                              |
