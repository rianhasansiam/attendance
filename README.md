# Office Attendance

A modular Next.js application for Google-authorized employees, passkey-confirmed attendance, office geofencing and network verification. Includes employee/admin interfaces, management workflows, CSV/Excel reports, and append-only audit history.

See the [performance audit and measurements](docs/performance.md) for query changes, display-only Next.js caching, invalidation rules, and validation results.

Late check-ins prompt the employee to enter a reason after attendance is recorded. The prompt uses the shift's existing grace period, preserves the check-in time, and returns on the dashboard until a reason is saved. Reasons appear in employee history, administrator attendance records, and CSV/Excel reports. Apply the included `20260921000000_attendance_late_reason` migration with `pnpm db:migrate` before running this version against an existing database.

Only super administrators can correct attendance records or create manual attendance corrections for employees. Administrators can view and export attendance reports. Every correction requires a reason and is recorded in the audit log.

Delayed checkout automatically records overtime: full minutes actually worked after the scheduled shift end, shown as hours and minutes in employee/admin attendance tables and decimal hours in CSV/Excel exports. Arrival lateness does not reduce overtime. The scheduled end is captured at check-in, including overnight shifts, so later Shift edits do not change it. Corrections recalculate overtime from that saved end; removing checkout resets overtime to zero. Previously completed records without a historical schedule snapshot show `—` (blank in exports), including after corrections. Legacy open records use their linked shift and original business date to establish the end at checkout. Apply `20260922000000_attendance_overtime` with `pnpm db:migrate`, then run `pnpm db:generate` before starting the updated application. This records time only; it does not calculate overtime pay or approval.

Administrators and super administrators can use **Drive Cost** to record dated trips and calculate costs at ৳5/km during in-time or ৳10/km during overtime. Rates and totals are derived on the server, saved as exact decimals, and recorded in the audit log. Apply the included `20260923000000_drive_costs` migration with `pnpm db:migrate` before using this workspace page.

Read [architecture](docs/architecture.md) for module boundaries, security decisions, and known trust limits, and [verification](docs/verification.md) for completed checks and live acceptance steps. The original specification is [implimentation_plan.md](implimentation_plan.md).

## Local setup

Requirements: Node.js 22.12+ (24 LTS recommended), pnpm 12.3.4, and PostgreSQL 16+. Install dependencies and configure environment:

```sh
pnpm install
cp .env.example .env
```

Set `DATABASE_URL`, `AUTH_SECRET` (generate with `openssl rand -base64 48`), Google OAuth credentials, and the WebAuthn/app origin. Secrets stay on the server. `.env` is ignored by Git. `AUTH_URL` and `WEBAUTHN_ORIGIN` must be identical origins without a trailing slash; `WEBAUTHN_RP_ID` is the hostname only. Localhost development can use HTTP; production requires HTTPS.

Create a dedicated PostgreSQL database/user, then:

```sh
pnpm db:generate
pnpm db:migrate
# Set SEED_ADMIN_EMAIL to an authorized Google email and SEED_ADMIN_NAME in .env
pnpm db:seed
pnpm dev
```

The seed only provisions the requested super administrator; it creates no demo users, offices, IPs, coordinates or schedules and does not elevate an existing employee. Sign in through Google, then create an office, department and shift, authorized employee profiles, date-bounded assignments, and office networks. Employees register passkeys after Google sign-in; administrators approve them. Accounts must be ACTIVE before login.

All office attendance checks default to required. `TRUSTED_PROXY_MODE=none` returns no trusted client IP, so strict office-network attendance fails closed in direct development. Use a local Nginx ingress to test network enforcement, or have a super administrator explicitly disable only the office's network policy while developing. Disabling a policy is a deliberate configuration change and is audited. Never trust forwarded headers from a public direct Next.js listener.

## Google Cloud OAuth configuration

1. Create or select a project in [Google Cloud Console](https://console.cloud.google.com/).
2. Configure Google Auth Platform branding/consent screen and audience. Use Internal for a Workspace-only application where appropriate; otherwise add permitted test accounts while in testing mode.
3. Request only `openid`, `email`, and `profile`. Do not request Gmail/Drive access.
4. Create an OAuth 2.0 Client ID with application type **Web application**.
5. If configuring authorized JavaScript origins, add your application's origin (for development, `http://localhost:3000`). The application uses a server OAuth redirect flow.
6. Add `http://localhost:3000/api/auth/callback/google` as the development authorized redirect URI.
7. Add the production callback using your actual hostname: `https://YOUR_HOST/api/auth/callback/google`. Callback scheme, host, port and path must match exactly.
8. Copy the Client ID and Client Secret into `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` on the server.
9. Set `AUTH_URL`, `WEBAUTHN_ORIGIN` and `WEBAUTHN_RP_ID` for each environment. Callback URLs are derived from the configured origin, not hardcoded in application code.
10. Optionally set `ALLOWED_GOOGLE_DOMAIN` to your Google Workspace domain. Both verified Workspace identity (`hd`) and the pre-authorized local user are still required.
11. Before production, configure the production consent screen/audience, domain ownership requirements and publication status applicable to your Google organization.

References: [Google OAuth web server applications](https://developers.google.com/identity/protocols/oauth2/web-server), [Auth.js Google provider](https://authjs.dev/getting-started/providers/google), [Auth.js Next.js integration](https://authjs.dev/reference/nextjs).

There is no public registration, password, OTP, magic-link or passkey account login. An administrator provisions the Google email before the employee signs in. Email changes invalidate sessions, OAuth account links and registered credentials so the new identity must authenticate and register again.

## Commands and verification

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm db:validate
pnpm build
```

PostgreSQL integration tests are opt-in via `TEST_DATABASE_URL` and must use a disposable test database with the migration applied. They add uniquely named fixtures, exercise real constraints, and do not target production:

```sh
DATABASE_URL="$TEST_DATABASE_URL" pnpm db:migrate
TEST_DATABASE_URL="$TEST_DATABASE_URL" pnpm test
```

`TEST_DATABASE_URL="$TEST_DATABASE_URL" pnpm test:e2e` runs browser checks. Install Chromium first with `pnpm exec playwright install chromium`; see `playwright.config.ts` and `tests/e2e` for the isolated test environment. Real Google login and a physical authenticator require credentials and user interaction; automated tests do not claim to validate Google's live consent flow or every device's biometric interface.

## Neon database and function

This workspace is linked to Neon project `lucky-hat-77060397`, branch `production`. [neon.ts](neon.ts) declares the `api` function from [hello.ts](hello.ts), which returns `Hello from Neon Functions`. The attendance application uses the Neon database through `DATABASE_URL`.

Prisma CLI commands automatically derive Neon's direct endpoint from `DATABASE_URL` for migrations. The application keeps the configured pooled connection. An explicit `DATABASE_URL` override also selects the target for Prisma commands, including disposable test databases.

Deploy the function with:

```sh
neon deploy --no-env-pull
```

The flag preserves the local environment without pulling storage credentials for the project's existing bucket. Object storage is not configured for this application, and no AWS account or `AWS_*` environment variables are required.

## VPS deployment

1. Provision a supported Node LTS runtime and PostgreSQL. Run PostgreSQL on loopback/private network. Use a dedicated application database and role; use a separate migration owner if your operational setup permits. Disable public database access. Configure backups and test restore procedures.
2. Deploy source and lockfile to `/srv/attendance` owned by an unprivileged `attendance` account. Run `pnpm install --frozen-lockfile`, `pnpm db:generate`, `pnpm db:migrate`, `pnpm db:seed` (first deployment only), and `pnpm build`. Inject environment variables when running migrations and seeding. Build does not embed production secrets.
3. Store production environment values in `/etc/attendance.env`, readable only by the service account/root. Set `NODE_ENV=production`, HTTPS origins, Google production credentials and a strong `AUTH_SECRET`.
4. Install the [systemd service example](ops/attendance.service.example), adjusting the Node binary path. `pnpm start` and the example bind Next.js to `127.0.0.1`. If using the standalone bundle instead, copy `public` and `.next/static` into its expected directories and set `HOSTNAME=127.0.0.1`.
5. Install Nginx and a valid TLS certificate. Adapt [ops/nginx.conf.example](ops/nginx.conf.example). Restrict public ingress to 80/443 and reject unknown hosts. Only Nginx may reach Node.
6. Set `TRUSTED_PROXY_MODE=nginx`. Generate a separate random `TRUSTED_PROXY_SECRET` of at least 32 characters and configure exactly the same value in Nginx's overwritten `X-Attendance-Proxy-Secret` header. Nginx must overwrite `X-Real-IP` with `$remote_addr`. Arbitrary `X-Forwarded-For` is ignored. Keep Nginx configuration containing the secret private.
7. When using Cloudflare/a load balancer, configure Nginx `set_real_ip_from` only for documented provider ranges and restrict origin ingress. Never accept a user-provided IP header or trust all proxies. Update provider ranges as part of operations.
8. Register actual office egress IPs/CIDRs in the admin UI. IPv4 and IPv6 are supported. IPv6 addresses must be registered when office clients use IPv6. Office network verification identifies approved egress, not a Wi-Fi SSID.
9. Run `pnpm db:cleanup` hourly via a service timer/cron with the same environment. It removes expired sessions, challenges and rate-limit buckets, and leaves attendance/audit history untouched.
10. Monitor service availability and sanitized errors. Define a retention policy for location/IP/attendance data, protect exports and backups, and review admin access. Append-only event/audit tables cannot be edited/deleted using normal row writes; archival is a separately controlled database operation.

Use Nginx `limit_req_zone`/`limit_req` at the HTTP/server level for ingress abuse protection in addition to application database-backed per-user mutation limits. Scope limits to authentication and write endpoints and test normal office-wide traffic so a shared egress IP is not inadvertently blocked.

## Operational acceptance checks

Before enabling attendance for staff, verify Google callbacks and unauthorized-account denial, admin/employee isolation, device registration/approval/revocation, inside/outside/low-accuracy GPS outcomes, approved/wrong office networks, concurrent check-ins, check-out, overnight shifts, leave/holiday reports, and both exports. Confirm secure cookies and HTTPS WebAuthn on the actual hostname. Passkeys are origin-bound: changing the hostname/RP ID requires registering compatible credentials again.

The PWA is installable and attendance remains online-only. The service worker does not cache protected API responses or queue attendance submissions. GPS can be spoofed, and synchronized passkeys are not unique hardware identifiers; read the architecture document's security boundaries before setting workplace policy.




After changing prisma/schema.prisma, run against a development database:
pnpm db:dev --name describe_your_change
pnpm db:generate
Then apply the migration to production:
pnpm db:migrate
pnpm db:generate
Your current .env points to production—switch to a development database before running db:dev. Keep generated migration files; don’t manually delete tables.
