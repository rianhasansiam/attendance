# Attendance performance audit and implementation

This is the historical performance record. The later [state-management refactor](state-management.md) replaces `useResource` with RTK Query and adds client-memory caching; its client behavior and deployment guidance supersede the corresponding sections below.

Measured and implemented on 20 September 2026. Next.js remains **16.3.5**, React **19.2.8**, Prisma **7.10.0**, with the existing pnpm package manager and PostgreSQL driver. No runtime dependencies or external cache infrastructure were added.

## Audit before implementation

The audit was presented before implementation. The installed guides under `node_modules/next/dist/docs/` were reviewed for `use cache`, Cache Components migration, `cacheLife`, tag invalidation, and dynamic rendering.

- Pages/layouts were Server Components, but the main admin, employee and resource workspaces were large Client Components fetching their data after hydration.
- Home/login explicitly exported `force-dynamic`. Protected pages and API routes were dynamic. There were no loading/Suspense boundaries. Server Actions were limited to Google sign-in/sign-out; management mutations used Route Handlers.
- API responses and client fetches used `no-store`; there was no application-data cache, `unstable_cache`, tag invalidation, or path revalidation.
- The dashboard invoked a report for every active office: **4 + 3 × office count** top-level Prisma operations, plus relation queries. Independent summary queries waited until those reports completed.
- Report pages loaded up to 50,001 fully hydrated attendance rows and 1,001 employee records before deriving statuses, sorting and slicing the requested page. GPS/IP columns were fetched and then discarded.
- Shared dropdowns fetched full management models/counts. Search requested data on every keystroke and obsolete requests were not aborted.
- Admin's `Metric` import pulled employee workspace/WebAuthn code into its client dependency graph. Employee profile performed an extra browser/API request despite having no interactions.
- Most management lists/history already had server pagination. Employee device history was unbounded; timestamp-based list ordering often lacked a unique tie breaker.
- Deployment files describe **one systemd Node process** behind Nginx with streaming enabled. No PM2 cluster, Docker replicas, or multiple-server configuration was found. Actual deployed topology was not independently inspected.

The ranked plan was: batch dashboard inputs; reduce report projections/derivation work; narrow reference lookups; reduce client dependencies/request churn; add display-only caching and streaming; validate indexes against query plans.

### Cache candidate decisions

| Data / original query location | Decision and reason | Lifetime / tag | Invalidation |
| --- | --- | --- | --- |
| Department dropdowns / `management/service.ts` | Cache only ID/name and list count; harmless display metadata | `referenceDisplay` / `departments:display` | Successful department create/update/deactivate |
| Office dropdowns / `management/service.ts` | Cache only ID/name/count; exclude coordinates, policies, status and networks | `referenceDisplay` / `offices:display` | Successful office create/update/deactivate |
| Shift dropdowns / `management/service.ts` | Cache only ID/name/count; actual schedules/validation stay authoritative | `referenceDisplay` / `shifts:display` | Successful shift create/update/deactivate |
| Full office/shift editing data / management service | Dynamic, so editors see current definitions | None | None needed |
| Holidays / catalog and reports | Dynamic; used by derived reporting, little isolated display benefit | None | None needed |
| Policy defaults / `catalog.ts`, application settings | Dynamic; defaults also participate in office creation | None | None needed |
| Employees / management service | Dynamic, including lookup labels | None | None needed |
| Historical reports / report service | Optimize projection/derivation first; corrections and leave changes can alter history | None | None needed |

### Never-cache boundaries

| Data | Authoritative code path |
| --- | --- |
| Google OAuth, sessions, role checks, account/identity status | `auth.ts`, `lib/auth.ts`; every page/API guard remains uncached |
| WebAuthn challenges, assertions, counters, approval/revocation | WebAuthn service and attendance transaction |
| Check-in/out, duplicate/open-attendance checks, current employee state | Attendance service, existing locks/unique constraints/transaction |
| GPS coordinates/accuracy/distance and geofence result | Current request evidence and current office configuration |
| Client IP, network approval and network result | Current headers and office networks on each attempt |
| Shift resolution, policy validation and server time | Current request/transaction reads and clock |
| Rate limiting, origin/CSRF checks, audit/security decisions | Existing security and transaction paths |
| Dashboard totals, employee today/recent data, devices, leaves | Fresh queries per request; no persistent data cache |

## Changes and query behavior

### Dashboard and reports

`src/modules/reports/service.ts` now loads shared inputs across active offices. Office date windows, overnight shifts, grace, joining dates, inactivity, approved leave, holidays and weekends retain their existing semantics. Independent total-employee/open-attendance/recent-activity queries start alongside derivation.

Dashboard reads use cursor batches of 500 attendance candidates and 250 employee schedules. Per-office limits are enforced inside each batch, so excessive data stops further reads immediately. Multiple offices can collectively exceed 1,000 employees without introducing a new organization-wide cap. The existing 1,000-employees/50,000-rows per-office limits remain.

Report JSON pagination first scans compact attendance candidates and the schedule inputs required to derive missing rows. After filtering and sorting the combined persisted/derived records, it hydrates **only stored records on the requested page**. Attendance values from the scan remain consistent with that response's totals/order if a concurrent correction occurs during hydration. All new requests still read current data. Reports select only display/schedule fields; GPS/IP/credential evidence and leave reasons are not fetched for reporting. CSV/XLSX retain complete, bounded exports.

Holiday membership uses a request-local set, joining dates are computed once per employee, and shift/day windows are calculated once per request. These local calculation maps are discarded at return; they are not an application-data cache and never participate in attendance acceptance.

### Reference lookup cache

`src/modules/management/lookups.ts` contains the only `"use cache"` function, `initialReferenceOptions`. It caches the initial 100 ID/name choices plus total count for departments, offices and shifts. There are **three fixed argument combinations**. Searches, other pages/page sizes, and employee choices stay dynamic. No session, actor, security configuration, or employee data enters the cache key or result.

`GET /api/admin/lookups/[resource]` authenticates/authorizes before invoking the data function. Responses remain `Cache-Control: no-store`; that prevents browser/proxy response reuse while Next reuses only the allowed inner database result.

`src/lib/cache/profiles.ts` defines `referenceDisplay`:

| Setting | Seconds | Reason |
| --- | --- | --- |
| `stale` | 30 | Conservative minimum client lifetime if reused in an RSC in future; the current API responses remain no-store |
| `revalidate` | 300 | Refresh labels after five minutes, limiting drift in another process |
| `expire` | 900 | At fifteen minutes the entry must be regenerated before being served; long-term stale labels are not retained |

The tags are centralized in `src/lib/cache/tags.ts`. No entity tags are needed because no individual entity is cached.

### Invalidation mapping

| Successful Route Handler mutation | Tag expired |
| --- | --- |
| POST/PATCH/DELETE departments | `departments:display` |
| POST/PATCH/DELETE offices | `offices:display` |
| POST/PATCH/DELETE shifts | `shifts:display` |
| Attendance, devices, employee identity/role, holidays, settings, networks, assignments, leave | None: corresponding data is uncached |

Handlers await the service transaction before calling `invalidateReferenceDisplay`. Failure/rollback produces no invalidation. Route Handlers use the installed version's `revalidateTag(tag, { expire: 0 })` to block the next lookup on fresh data. `updateTag` is reserved for Server Actions; the existing data mutations are Route Handlers. No whole-application/path invalidation was introduced.

Direct SQL or maintenance-script catalog changes bypass these handlers and are subject to the lifetime/restart behavior. Keep the invalidation call when adding future application mutation endpoints.

### Client and rendering changes

- Removed the client directive from shared presentational `ui.tsx`; separated request hooks into `use-resource.ts`.
- Moved `Metric` out of employee workspace, removing that dependency from admin pages.
- Load the browser WebAuthn library only when verification/registration is actually required.
- Render employee profile on the server with a narrow current query, removing its browser API waterfall.
- Debounce reference and management searches by 300 ms; abort superseded requests.
- Clear request state when a route hides/unmounts, refetch on reveal, and mark URL changes/refreshes pending. This accommodates Cache Components' preserved route state without showing old attendance as current after navigation.
- Added loading/Suspense boundaries for home/login and authenticated layouts. The build produces partial static shells with dynamic authenticated content; no authenticated page has a `use cache` directive.
- Preserve framework control-flow exceptions in the API error boundary with `unstable_rethrow`. This prevents prerender bailouts becoming application JSON failures.
- Internal navigation already used `next/link`. Avatar images already had explicit `next/image` dimensions; small provider avatars remain unoptimized. System fonts already avoid external font requests. ExcelJS was already dynamically imported on the server and remains so.

### Pagination and indexes

Management list ordering now includes ID tie breakers. Dropdowns can search and page beyond the initial 100 choices. Device history now returns `{ items, total, page, pageSize }` with a default page size of 25 and a maximum of 100; both `/api/webauthn/devices` and its employee alias use this shape, and the UI is updated. Dashboard device display queries only approved, non-revoked credentials, which existing registration rules bound to ten. Attendance/device decisions remain separate current reads.

One index was added: `Attendance(updatedAt DESC, id DESC)` for the eight-row recent-activity feed. In the 5,400-row local fixture, a representative `SELECT id ... ORDER BY updatedAt DESC, id DESC LIMIT 8` changed from a sequential scan plus top-N sort (1.600 ms, 126 shared buffers) to an index-only scan (0.038 ms, three buffers, eight rows). The complete feed selects more fields and can require heap reads; these numbers describe the representative plan, not production endpoint latency.

Existing date-range indexes were already used by the measured date query, so no additional date or duplicate open-attendance index was added. The new index costs storage and maintenance on attendance updates. Its migration was applied and tested **only on disposable local databases**, not the configured application database. Deploy it through the normal migration process.

## Before/after observations

Synthetic local fixture: 12 offices, 240 employees, 5,400 stored attendance rows over 30 days. One warm-up followed by five measured service invocations; medians below. SQL counts come from Prisma query events and include relation queries. These are local service measurements, not production network response-time promises.

| Metric | Before | After |
| --- | ---: | ---: |
| Admin dashboard SQL statements | 190 | 21 |
| Admin dashboard median | 26.48 ms | 6.74 ms |
| Dashboard serialized result | 13,946 bytes | 7,236 bytes |
| Report first page median | 109.57 ms | 31.20 ms |
| Report SQL statements | 15 | 18 |
| Report serialized page | 42,680 bytes | 21,520 bytes |
| Production build wall time | 5.39 s | 5.63 s |
| `.next/static` disk usage | 824 KiB | 812 KiB |

The report deliberately trades three more SQL statements for less full-row hydration, smaller results, and much less date-calculation work. Build time is approximately unchanged at this scale; no build-speed improvement is claimed. Intermediate runs varied with concurrent build/test activity; the final service sample was collected after those jobs completed.

Application-component client chunks, excluding framework chunks and separately loaded async chunks:

| Route | Before raw / gzip bytes | After raw / gzip bytes |
| --- | ---: | ---: |
| Login | 19,208 / 5,716 | 19,476 / 5,801 |
| Admin dashboard/reports | 118,709 / 35,764 | 93,675 / 28,855 |
| Employee dashboard | 86,691 / 28,221 | 77,523 / 25,321 |
| Employee profile | 86,691 / 28,221 | 54,229 / 17,955 |

The login increase is small shared-chunk overhead. Admin initial gzip fell about 19%; profile fell about 36%. Source/build inspection confirmed admin previously received the browser WebAuthn implementation through the employee `Metric` import.

Raw observations: [before](performance/before.json), [after](performance/after.json), [final client chunks](performance/client-bundles-after.json).

## Validation

- Initial baseline: lint/build passed; 93 tests passed without a database, then all 106 original tests passed against disposable PostgreSQL.
- Final `pnpm lint`: passed with no warnings.
- Final `pnpm typecheck`: passed; production build also completed TypeScript validation.
- `TEST_DATABASE_URL=... pnpm test --maxWorkers=1`: **133 tests passed**, including actual PostgreSQL/WebAuthn integration tests. One worker avoids unrelated suites contending for serializable predicate locks in a shared disposable database; concurrent attendance tests still exercise simultaneous transactions within their cases.
- `pnpm exec prisma validate`: passed. Both migrations deployed successfully to disposable local databases.
- `pnpm build`: passed; APIs remain dynamic and protected pages stream dynamic content inside partial shells.
- Playwright: **six workflows passed** on a separate disposable database and `.next-e2e` build directory. Tests cover check-in/out and immediate UI state, admin workflows, both exports, real Next cache hits followed by write invalidation, denial after deactivation, navigation refresh, server-rendered profile without its former API call, and paginated device history without credential material.
- Compiled production smoke: login, six admin pages, dashboard API, real cache hit, immediate post-write invalidation, no-store responses and revoked-session denial passed.
- Added regression tests cover updated authorization, changed geofence/network/GPS/WebAuthn policy, rollback/invalidation ordering, report derivation/pagination, overnight shifts, and early per-office limits.
- Desktop admin and mobile employee screenshots were visually reviewed. Existing branding changes were preserved.

Physical-device/Google-provider end-to-end login was not repeated; tests use local sessions and cryptographic WebAuthn fixtures. No credentials or production data were used in benchmark fixtures.

## Deployment limits and remaining work

The default Next in-memory cache is process-local. The supplied systemd setup uses one process, so mutation expiry works immediately there. Multiple workers/replicas do **not** share these invalidations: labels/counts can briefly differ until their own five-minute revalidation or fifteen-minute expiry. Auth, device approval/revocation, network/geofence, schedules, policy and attendance do not depend on those entries. No Redis, remote cache, custom handler, or client server-data cache was added.

Reports still scan bounded candidate/schedule data to calculate exact derived totals and ordering. A simple SQL `skip/take` would omit absent/leave/holiday/weekend rows; a future larger deployment may justify a dedicated SQL derivation strategy. Full exports remain bounded but consume memory. The 93-day/1,000-employee/50,000-row report limits remain.

Most interactive dashboards/lists still fetch their dynamic data after hydration. Auth remains deliberately rechecked rather than memoized, and separate filter dropdown requests still repeat authorization. Dashboard updates occur on requests, navigation, manual refresh, and own attendance mutations; no push subscription was introduced. Production database statistics, remote latency, concurrent-user load, and cold Neon compute were not benchmarked here.

## Files changed

| Area | Files |
| --- | --- |
| Next/cache configuration | `next.config.ts`; `src/lib/cache/{profiles,tags,invalidation}.ts`; `src/lib/api.ts` |
| Lookup endpoint and invalidation | `src/modules/management/lookups.ts`; `src/app/api/admin/lookups/[resource]/route.ts`; `src/app/api/admin/[resource]/route.ts`; `src/app/api/admin/[resource]/[id]/route.ts` |
| Query optimization | `src/modules/reports/service.ts`; `src/modules/management/service.ts`; `src/modules/attendance/{queries,service}.ts`; `src/app/api/attendance/history/route.ts`; `src/app/api/webauthn/devices/route.ts` |
| Rendering and client requests | `src/components/{ui,use-resource,employee-profile,employee-workspace,admin-workspace,resource-workspace}`; `src/app/{page,loading}.tsx`; `src/app/login/page.tsx`; admin/employee `layout.tsx` and `loading.tsx`; `src/app/employee/profile/page.tsx` |
| Schema | `prisma/schema.prisma`; `prisma/migrations/20260920000000_attendance_recent_index/migration.sql` |
| Validation and measurement | `tests/{api,auth-callbacks,attendance-integration,cache-invalidation,reports}.test.ts`; `tests/e2e/workflows.spec.ts`; `scripts/benchmark-performance.ts`; `scripts/measure-client-bundles.mjs` |
| Test-build isolation and documentation | `playwright.config.ts`; `tsconfig.json`; `.gitignore`; `eslint.config.mjs`; this report and its JSON observations; README link |

`src/components/app-shell.tsx` already contained the user's XHYD branding edit; it was not changed by this optimization. `.env` was not edited. Package versions and lockfile were preserved.

## Reproduce

Use an empty disposable local PostgreSQL database whose name includes `test`, then run:

```sh
DATABASE_URL="$TEST_DATABASE_URL" pnpm exec prisma migrate deploy
NODE_OPTIONS=--conditions=react-server pnpm exec tsx scripts/benchmark-performance.ts
pnpm build
node scripts/measure-client-bundles.mjs
```

The benchmark requires `TEST_DATABASE_URL` and explicitly rejects non-local hosts. It inserts only synthetic, idempotent fixtures. Use separate databases for the service benchmark, integration suite and browser suite so concurrent test mutations do not affect measurements or serializable transactions.
