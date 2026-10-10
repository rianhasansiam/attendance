# Office Attendance

The public `/` homepage introduces **XHYD** as a multinational business group. Employee sign-in and role-based dashboard routing remain available at `/workspace`; authentication and attendance permissions are unchanged.

Homepage content is centralized in `src/data/company.ts`, with scoped styling and reusable server-rendered sections in `src/components/corporate/`. Navigation, native dialogs, inquiry drafting, and progressive scroll reveals use small client components. The existing XHYD logo, self-hosted Manrope font (SIL OFL), and optimized local imagery avoid external browser dependencies. `public/images/xhyd/provenance.json` records the exact prompts for the original AI-generated illustrative imagery; those visuals do not depict verified XHYD facilities. The world map uses public-domain Natural Earth coastlines.

The public homepage and login panel share `src/components/corporate/brand.css`. Brand red `#C30708` and black `#101010` come from interior pixel samples of the unchanged official `public/company_logo.jpeg`; light red `#F1666A` provides accessible text and controls on dark surfaces. White logo plates preserve the original colors on dark navigation/footer backgrounds. Only illustrative photography receives a CSS grayscale treatment. The global map stays visible on mobile, and motion honors reduced-motion preferences. The editable native `social-card.svg` contains the exact original logo and renders to the matching 1200 × 630 PNG through the existing Sharp dependency.

The full website shares the XHYD identity: global palette aliases and a self-hosted Manrope font cover all routes, while `src/components/workspace-theme.css` styles every admin and employee shell through `.workspace-theme`. Dashboards, attendance, tables, forms, reports, driver costs, daily expenses, account security, public profiles, error screens, loading states, and body-mounted dialogs use the same red, black, and white palette. Shared workspace logos and branded install icons retain the exact official logo. Authentication, navigation destinations, permissions, mutations, and data handling remain unchanged.

Optional verified public details are configured on the server:

- `XHYD_CONTACT_EMAIL`: public partnership email, used for a real email-client handoff.
- `XHYD_CONTACT_URL`: an existing HTTPS contact destination.
- `XHYD_SITE_URL`: verified HTTPS corporate origin, enabling canonical and absolute social-sharing image URLs. Configure before the production build.

Missing or invalid contact details show an honest inquiry-drafting alternative with **Copy inquiry**, without sending or storing messages. No office addresses, social accounts, partner logos, or operational statistics are invented. The footer year follows Asia/Dhaka at request time.

Run `pnpm test:homepage` against a running local preview (defaults to `http://localhost:3000`; override with `XHYD_PREVIEW_URL`). These browser checks require no test database and cover responsive layouts, accessible navigation/dialogs, real anchor targets, reduced motion, and public metadata. The existing `pnpm test:e2e` suite retains its disposable-database requirement.

The existing localized root layout uses streamed Suspense rendering: corporate content is present in server HTML, but browsers with JavaScript fully disabled do not display it. The homepage browser suite records this inherited layout limitation explicitly.

English and 简体中文 are available from the language selector. Selection persists across navigation and browser reopening without changing URLs or sessions. See [localization architecture, translation editing, and verification](docs/localization.md). No database migration is needed for this feature.

State management: [architecture, cache matrix and test instructions](docs/state-management.md) · [verified findings and baseline](docs/state-audit.md).

A modular Next.js application for administrator-authorized employees, passkey-confirmed attendance, office geofencing and network verification. Includes employee/admin interfaces, management workflows, PDF reports, and append-only audit history.

See the [performance audit and measurements](docs/performance.md) for query changes, display-only Next.js caching, invalidation rules, and validation results. The [check-in/out performance notes](docs/attendance-performance.md) describe immediate confirmed display, concurrent verification, opt-in timing, and device measurement steps.

Late check-ins prompt the employee to enter a reason after attendance is recorded. The prompt uses the shift's existing grace period, preserves the check-in time, and returns on the dashboard until a reason is saved. Reasons appear in employee history, administrator attendance records, and PDF reports. Apply the included `20260921000000_attendance_late_reason` migration with `pnpm db:migrate` before running this version against an existing database.

Only super administrators can correct attendance records or create manual attendance corrections for employees. Administrators can view and export attendance reports. Every correction requires a reason and is recorded in the audit log.

Each attendance record whose displayed **Late (min) is greater than 5 subtracts a fixed 30 minutes from total overtime** in the selected date range. Exactly 5 minutes has no deduction. The rule uses the recorded `lateMinutes` value, including the existing arrival-grace calculation, and applies regardless of extra work or late approval. It also applies to open records and historical records with known late minutes, even when their overtime is unknown. For example, 90 counted overtime minutes minus one late-record deduction gives a 60-minute total; two late records deduct 60 minutes. Deductions can make the total negative. No extra-work makeup requirement is used.

Completed attendance with both check-in and checkout must reach **8 hours 30 minutes (510 worked minutes)**. Each completed day below that target deducts `510 - workedMinutes` from total overtime, in addition to any fixed late deduction. Working 8 hours deducts 30 minutes; working 8 hours 29 minutes deducts 1; exactly 8 hours 30 minutes or more has no shortage deduction. A completed 8-hour day with Late (min) greater than 5 therefore deducts 60 minutes in total. The fixed 510-minute target applies regardless of configured shift length. Open attendance, absence, leave, holidays and weekends without completed punches have no shortage deduction. Completed historical records with unknown overtime can still have a shortage because their worked minutes are known. Corrections recalculate deductions; removing checkout removes the shortage deduction while retaining any late deduction.

Daily overtime retains its existing signed work-hour balance: time after scheduled end offsets actual late minutes, while early departure or lateness not made up shows a negative value. Employee/admin attendance tables and PDF reports display this balance. Each record with at least 30 minutes of overtime is green and contributes its full duration to report totals. Smaller credits, zero, and negative shortfalls stay visible in red and do not contribute overtime credits. Totals sum qualifying credits and subtract fixed late deductions and completed-day shortages across all filtered pages; the displayed negative daily balance is not deducted again. Early arrival does not earn overtime. Scheduled boundaries are captured at check-in, including overnight shifts, so later Shift edits do not change them. No new database migration is needed for these total rules.

Previously completed records without a historical scheduled-end snapshot show `—` (Unknown in PDFs), including after corrections. Legacy open records establish their schedule at checkout using the linked shift and original business date. Apply `20260927120000_signed_overtime` with `pnpm db:migrate` before running this version if not already applied: it permits negative balances and recalculates known historical overtime. This records time only; it does not calculate overtime pay or approval.

Administrators, super administrators, and users with the Manage Driver role can use **Drive Cost** to record dated trips and calculate costs by trip date: before September 26, 2026, rates are ৳5/km in-time and ৳10/km overtime; from September 26, 2026 onward, they are ৳5.50/km and ৳11/km. One-way or round-trip totals are rounded once to two decimal places (half up). Rates and totals are derived on the server, saved as exact decimals, and recorded in the audit log. The trip list and cost calculator each support All, Paid, and Unpaid filters; their PDF downloads use the applied filters.

**Drive cost balance** is shared across all trips and dates: total funds added minus the current total of paid trips, including existing paid records. Unpaid trips do not reduce it, and the balance can be negative. Only super administrators can add funds or change payment status. Editing or deleting a paid trip, or marking it unpaid, automatically updates the balance. Funding additions are audited and retries with the same request identifier do not add funds twice. Apply the included migrations with `pnpm db:migrate`, then run `pnpm db:generate` before starting this version. `20261002120000_drive_cost_balance` adds funding records; `20261003120000_drive_cost_rate_change` recalculates existing trips dated September 26, 2026 onward at the new rates, including paid trips and their balance deductions. Trips before that date keep their saved costs.

The `MANAGE_DRIVER` role has all employee access plus **Drive Cost** in the employee workspace. It can view, add, edit, delete, calculate, and export drive costs, without access to other administrator features. Administrators can assign or remove this role through **Users & employees → Add/Edit employee → Role**; changing a role signs out existing sessions. An employee profile is required. Apply `20260925000000_manage_driver_role` with `pnpm db:migrate`, then run `pnpm db:generate` before starting the updated application.

Choose **Round trip (×2)** for office → destination → office and enter the one-way kilometers. The cost is kilometers × rate × 2, and the list, calculator, and PDF show the total distance including the return journey. Existing records stay one-way. Apply `20260924000000_drive_cost_round_trips` with `pnpm db:migrate`, then run `pnpm db:generate` before starting the updated application.

Read [architecture](docs/architecture.md) for module boundaries, security decisions, and known trust limits, and [verification](docs/verification.md) for completed checks and live acceptance steps. The original specification is [implimentation_plan.md](implimentation_plan.md).

**Users & employees** at `/admin/employees` combines the former Employees and All Users pages. Admins and Super Admins can search every account by name, email or employee ID, including accounts without employee records. Accounts without an employee record show **—** for employee ID, department and office; attendance and employee-edit actions require an employee record. Old `/admin/users` links redirect here and preserve search and pagination. This page merge needs no database migration.

Super administrators can **Add employee**, **Manage account**, edit public profiles, and **Delete user** from this one page. Manage account changes names, roles and statuses; employee roles require an existing employee profile. Regular administrators retain their existing employee editing and status controls.

**Admin and Super Admin can also have employee profiles without changing their role.** For an existing account, a Super Admin selects **Add employee profile** on its row and enters an employee ID, active office and optional department. This also works for the signed-in Super Admin. It attaches the profile to the same account and preserves its Google identity, password and sessions. For new accounts, **Add employee → Role** supports Employee, Manage Driver, Admin and Super Admin and creates the employee profile together with the account. Accounts with a profile appear in employee selectors and can receive shift assignments and attendance records. Admins with a profile can open **Employee profile** or **My workspace** from the navigation and return through **Admin workspace**. Existing accounts need this one-time setup because an employee ID and office are required; no office is assigned automatically. No new migration is required.

UI **Delete** actions remove the corresponding database rows: employees, departments, offices, networks, shifts, assignments, holidays, drive costs, and Daily Expenses transactions. Referenced records are protected rather than cascading historical data. Audit logs remain; financial deletion also keeps a minimal retry receipt to prevent duplicate requests from restoring a deleted transaction. **Archive**, **Cancel**, and **Revoke** retain their distinct meanings. Deploy the permanent-deletion migration described in [Daily Expenses](docs/daily-expenses.md) before running the updated application.

Account-management APIs remain restricted to Super Admin. Role/status updates revoke sessions, and changes are audited. You cannot delete your own account or remove your own access; the last active super administrator is protected. **Delete user** uses `DELETE /api/admin/users/:id` and removes the account, optional employee profile, sessions, OAuth links, password-reset tokens and passkeys together. Attendance, leave, assignments, financial records and audit history remain with detached identity references displayed as **deleted info**. Structured identity snapshots in audits and events are redacted in the same transaction. Attendance facts, financial amounts, approvals and submission keys remain unchanged. Deleted employees' attendance, leave requests and shift assignments cannot be reassigned or reviewed.

Apply `20260929500000_deleted_user_references` before using account deletion, then regenerate Prisma and restart the application. This migration changes identity references to nullable fields and adds a narrowly authorized identity-redaction exception to immutable history; ordinary history updates and deletes remain protected. It supports both legacy and upgraded Daily Expenses databases and does not purge financial records. Where `20260930000000_hard_delete_daily_expenses` is intentionally pending, apply only the identity migration with `pnpm exec prisma db execute --file prisma/migrations/20260929500000_deleted_user_references/migration.sql`, then record it with `pnpm exec prisma migrate resolve --applied 20260929500000_deleted_user_references`. Review pending migrations before using `pnpm db:migrate`.

UI confirmations, optional review-note prompts, and action notifications use [SweetAlert2](https://sweetalert2.github.io/) through `src/lib/client/alerts.ts`. Confirmation defaults to Cancel; callbacks await an explicit decision, prevent duplicate clicks, and cancel on navigation/session loss. Success/error toasts share the application theme and never replace a pending confirmation. Inline feedback, complex forms, and uncertain-operation recovery remain available. Use `confirmAction`/`promptAction` for dialogs, `<Notice notify>` for successful action feedback, and `ErrorNotice` for errors. No database migration is needed for this UI change.

Public profiles are available without sign-in at `/profile/<name-slug>`; existing `/profile/<user-id>` links redirect to the named URL. Open **Public profile** in the signed-in navigation, or use the public-profile action in **Users & employees**, then share that URL. Profiles show name, photo, email, employee ID, designation, phone, blood group, department, home address and date of birth. Email comes from the user account, and employee ID is the employee code (`Employee.employeeCode`); accounts without an employee record show **Not listed** for employee ID. Only Super Admin can edit the name and additional profile details using **Edit public profile** in **Users & employees**. Attendance, financial records and authentication/security data stay private. Inactive, suspended, deleted and unknown accounts show **Profile unavailable**. See [public profile setup](docs/public-profiles.md) for the required migration and permissions.

Super administrators can use **My profile** in the navigation to update their own name, designation, phone, blood group, department, home address and date of birth. The shortcut works with or without an employee record. Saved changes appear on their public profile and refresh the signed-in display; their role, account status and sign-in access are preserved.

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

The seed only provisions the requested super administrator; it creates no demo users, offices, IPs, coordinates or schedules and does not elevate an existing employee. Sign in through Google, then create an office. Open **Users & employees**, find your own account and choose **Add employee profile** to assign your employee ID and office. Configure departments, shifts, date-bounded assignments and office networks as needed. As a super administrator, create employee or administrator accounts from **Admin → Users & employees → Add employee** using their Google account email and choosing the appropriate role; no application password is required. To also enable password sign-in, select **Set an application password (optional)** and enter a password and confirmation. Users register passkeys after signing in; administrators approve them. Accounts must be ACTIVE before login.

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

Restart the application after changing server environment values. This project explicitly reads `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`; use those names even though Auth.js examples may use its automatic `AUTH_GOOGLE_ID`/`AUTH_GOOGLE_SECRET` names.

References: [Google OAuth web server applications](https://developers.google.com/identity/protocols/oauth2/web-server), [Auth.js Google provider](https://authjs.dev/getting-started/providers/google), [Auth.js Next.js integration](https://authjs.dev/reference/nextjs).

Only super administrators can register employee accounts, using **Admin → Users & employees → Add employee** (`/admin/employees`). Google sign-in is the default: register the employee's exact Google account email and leave the optional password setting off. The employee selects **Continue with Google** on `/login`, chooses that account, and signs in without an application password. The first successful sign-in links the verified Google identity to the existing employee; it does not create another user. Unknown, inactive, unverified, or nonmatching Google accounts remain blocked. Leave `ALLOWED_GOOGLE_DOMAIN` unset to allow authorized personal Gmail accounts; a configured domain requires the matching Google Workspace identity.

An optional initial application password (12–128 characters, with confirmation) enables password sign-in on the same account. A Google-only employee can also set one later from Account security after signing in. There is no public registration or forgot-password system. Password saves revoke all sessions. Administrative email changes clear the application password and revoke sessions, OAuth links and registered credentials; use verified Google sign-in for the updated identity before setting a new password. See [application password setup and security behavior](docs/application-passwords.md) for provisioning, password policy and rate limits. SMTP is not required, and optional employee passwords need no new database migration.

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
4. Install the [systemd service example](ops/attendance.service.example), adjusting the Node binary path. `pnpm build` prepares the standalone server and copies `public` and `.next/static` into its runtime directories. `pnpm start` and the example launch `.next/standalone/server.js` on `127.0.0.1:3000`; set `PORT` to use another port. Deploy the complete `.next/standalone` directory when distributing only the runtime bundle. `NEXT_TEST_DIST_DIR` selects the same custom build directory for building, packaging, and `pnpm start`.
5. Install Nginx and a valid TLS certificate. Adapt [ops/nginx.conf.example](ops/nginx.conf.example). Restrict public ingress to 80/443 and reject unknown hosts. Only Nginx may reach Node.
6. Set `TRUSTED_PROXY_MODE=nginx`. Generate a separate random `TRUSTED_PROXY_SECRET` of at least 32 characters and configure exactly the same value in Nginx's overwritten `X-Attendance-Proxy-Secret` header. Nginx must overwrite `X-Real-IP` with `$remote_addr`. Arbitrary `X-Forwarded-For` is ignored. Keep Nginx configuration containing the secret private.
7. When using Cloudflare/a load balancer, configure Nginx `set_real_ip_from` only for documented provider ranges and restrict origin ingress. Never accept a user-provided IP header or trust all proxies. Update provider ranges as part of operations.
8. Register actual office egress IPs/CIDRs in the admin UI. IPv4 and IPv6 are supported. IPv6 addresses must be registered when office clients use IPv6. Office network verification identifies approved egress, not a Wi-Fi SSID.
9. Run `pnpm db:cleanup` hourly via a service timer/cron with the same environment. It removes expired sessions, challenges and rate-limit buckets, and leaves attendance/audit history untouched.
10. Monitor service availability and sanitized errors. Define a retention policy for location/IP/attendance data, protect exports and backups, and review admin access. Append-only event/audit tables cannot be edited/deleted using normal row writes; archival is a separately controlled database operation.

Use Nginx `limit_req_zone`/`limit_req` at the HTTP/server level for ingress abuse protection in addition to application database-backed per-user mutation limits. Scope limits to authentication and write endpoints and test normal office-wide traffic so a shared egress IP is not inadvertently blocked.

For an existing standalone build, run `pnpm build:standalone` to refresh its assets from the matching build, then restart the application. Next.js omits `public` and `.next/static` from standalone output by default; missing copies cause CSS, JavaScript, fonts, and logos to return 404 while the page HTML still loads. The packaging command checks the build IDs and required directories before replacing assets.

For a VPS using PM2 with the application at `/var/www/attendance`, load the production environment through the existing deployment configuration, then use the commands below for the first deployment. This server's `xhyd` process uses port 3003; Nginx's `proxy_pass` must target the same loopback port.

```sh
cd /var/www/attendance
pnpm install --frozen-lockfile
pnpm build
HOSTNAME=127.0.0.1 PORT=3003 pm2 start .next/standalone/server.js --name xhyd --cwd /var/www/attendance
pm2 save
```

For subsequent deployments, run `pnpm build`, then `pm2 restart xhyd` and `pm2 save`. This preserves the process's stored production environment. Use `--update-env` only when intentionally changing that environment. Restart only this application's process. After deployment, confirm the homepage and `/company_logo.jpeg` load, and that a CSS file and a JavaScript file referenced by the current page HTML return HTTP 200 with their correct content types through the public HTTPS domain.

If **Continue with Google** returns HTTP 502 and Nginx logs `upstream sent too big header while reading response header from upstream`, the OAuth response exceeded the [proxy header buffer](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_buffer_size). Apply the example's `proxy_buffer_size 16k`, `proxy_buffers 4 16k`, and `proxy_busy_buffers_size 32k` settings in the app's `location /` block, keeping `proxy_buffering off` for Next.js streaming. Run `sudo nginx -t`, then `sudo systemctl reload nginx`, and retry sign-in.

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

pnpm db:migrate
