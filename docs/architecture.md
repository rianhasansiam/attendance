# Architecture and implementation map

For the current Redux/RTK Query data flow, cache ownership, authentication cleanup and verification, see [State management and data flow](state-management.md) and the [state audit](state-audit.md). The baseline below records the original application implementation.

## Baseline inspection

The repository began as an untouched Next.js 16.3.5 App Router starter, React 19.2.8, strict TypeScript, Tailwind CSS 4, ESLint 9, and pnpm 12. It had no database, models, authentication, routes, or business modules. The supplied plan is `implimentation_plan.md` (the filename has a spelling difference from the request). Existing working functionality was limited to the starter page.

## Changes and module boundaries

Replace the starter `app/` with `src/app/` and update the TypeScript alias, package scripts, dependency lock, Next configuration, README, and ignore rules. Add:

```text
src/
  app/                  Server pages, client presentation, thin API routes
    login/              Google-only authentication
    employee/           Dashboard, history, devices, profile, leave
    admin/              Dashboard, management, reports, audit, settings
    api/                Auth.js, attendance, WebAuthn, admin and employee endpoints
  components/           Responsive shell, forms, feedback and domain screens
  modules/
    auth/               Verified Google identity and role policies
    employees/          Provisioning, account updates and device invalidation
    management/         Validated catalog operations and approval workflows
    attendance/         Verification orchestration, state and policy
    shifts/             Timezone, overnight, lateness and duration calculations
    geofence/           Haversine and accuracy verification
    network/            Authenticated ingress and CIDR matching
    webauthn/           Registration, assertion and single-use challenge storage
    reports/            Derived day statuses and CSV/Excel export
    audit/              Transactional structured audit writes
  lib/                  Lazy DB, configuration, authorization, errors, API, rate limits
  auth.ts               Google provider, restricted Prisma adapter and DB sessions
prisma/                 Schema, initial migration and authorized admin seed
scripts/                Expired security-state maintenance
tests/                  Domain, integration and browser checks
ops/                    Nginx and systemd deployment examples
```

The dependency set adds Auth.js, Prisma PostgreSQL adapter, Zod, SimpleWebAuthn, IP/CIDR utilities, timezone date utilities, and ExcelJS. Vitest and Playwright handle verification. Prisma CLI/client/adapter use compatible 7.10 versions; the registry's Prisma 8 release candidate is deliberately not used. Auth.js's v5 integration is currently distributed with the `beta` version label and is pinned in package.json/lockfile; evaluate upstream release notes during upgrades.

## Data design

`prisma/schema.prisma` is the definitive schema. User owns OAuth Accounts, database Sessions and an optional Employee; email and Google subject are unique. Employee belongs to an Office and optional Department, with date-bounded EmployeeShift assignments. Office owns public IP/CIDR networks and attendance policy. Shift stores local start/end, timezone, grace and half-day minutes. Credentials store cryptographic keys and counters; challenges bind an employee, session, action and expiration. Attendance has a unique employee/date key, verification evidence and server-computed metrics. Append-only AttendanceEvent and AuditLog rows retain outcomes and administrative changes. Holiday and Leave model exceptions; SystemSetting stores global presentation settings; RateLimit stores shared atomic counters.

The migration adds SQL checks, one-open-attendance partial uniqueness and immutable history triggers in addition to Prisma foreign keys, indexes and unique constraints.

## Identity and authorization

Google OAuth (PKCE, state, nonce) establishes verified email and subject. A centralized policy checks an existing local user, ACTIVE status, subject binding and optional Google Workspace `hd` plus email domain. Public user creation is disabled at adapter level. Only a verified Google identity can link to a pre-provisioned email; no password, OTP, magic link or passkey login provider exists. Google tokens are discarded after authentication. Database sessions have a seven-day lifetime, with activity-based renewal writes throttled to once per hour and secure HttpOnly/SameSite cookies managed by Auth.js. Session responses use an explicit public field allowlist.

Every protected request re-reads the user and current role. Employee, admin and super-admin helpers are centralized. Management updates invalidate sessions on email/status/role changes. Elevated roles and global settings require super-admin permissions. Client navigation is convenience only.

## Attendance pipeline

Authenticate → active employee and office → assigned shift / open attendance → office policy → single-use session/action-bound challenge → cryptographic passkey verification and approval/revocation → server geofence and GPS accuracy → trusted ingress IP against office networks → server timestamps and attendance state → serialized database transaction → attendance and immutable event.

Challenges are consumed in an independent atomic update before verification, so failed assertions cannot reuse them after rollback. Employee and credential row locks plus serializable transactions and database unique indexes defend concurrent writes. Checkout repeats policy checks. Shift dates use the configured timezone, including overnight shifts. Report-only missing statuses are derived for scheduled days; no attendance submission is fabricated or accepted offline.

## Security boundaries and limitations

Browser inputs are evidence, never authoritative flags. Strict Zod objects reject extra fields. Mutations require an exact configured Origin; rate limits share PostgreSQL state. API errors and logs omit raw ORM errors, tokens, challenges and secrets. No biometrics are collected. Forwarded IP headers are ignored unless the isolated Nginx ingress overwrites `X-Real-IP` and authenticates using a server-only secret. Direct backend network access must be blocked.

A browser-reported GPS position can be spoofed. Passkeys can synchronize between devices; an approved credential is not proof of unique physical hardware. Cryptographic user verification proves control of the passkey, not a specific biometric. The combined policy reduces abuse but cannot guarantee physical presence against a fully compromised endpoint. Configure appropriate operational review and approval practices.

Security headers include a baseline CSP; Next.js hydration currently needs inline scripts/styles. A deployment requiring a stricter nonce CSP should add per-request nonces and validate all routes. GPS/IP evidence and employee records are sensitive operational data: restrict database access, define retention, encrypt backups and do not publicly cache protected responses.

## Implementation and verification order

Inspection and framework guide review → schema and migration → configuration/Auth.js/RBAC → management and core domain modules → WebAuthn/GPS/network pipeline → transactional check-in/out → responsive dashboards and reports → security tests → PWA → VPS deployment instructions. Validation includes TypeScript, ESLint, Vitest, schema validation, a production build, fresh PostgreSQL migration, actual concurrency tests and browser smoke checks. Live Google OAuth and physical authenticator acceptance require deployment credentials and a user device.
