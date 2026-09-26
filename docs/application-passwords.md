# Application passwords

The existing administrator-provisioned `User` can now sign in with Google or an application password. There is no public registration and no credentials-specific `User` or `Account` creation. The password is for XHYD, never the user's Google password.

## Architecture and identity

- Installed versions: Next.js **16.3.5**, `next-auth` **5.0.0-beta.32**, `@auth/core` **0.41.3**, Prisma **7.10.0**.
- Previously, `src/auth.ts` used a restricted Prisma adapter, Google OAuth, database sessions, verified-email/Workspace/Google-subject checks, and an explicit session allowlist. There was no JWT callback, password hashing or email delivery utility. Authentication and RBAC run in the data/service layer; no middleware/proxy auth bypass was added.
- Both providers now use Auth.js's supported **JWT strategy**. This installed Credentials provider issues JWT sessions; mixing it with the database strategy would not produce working sessions. See the [Auth.js Credentials reference](https://authjs.dev/reference/core/providers/credentials) and [session strategies](https://authjs.dev/concepts/session-strategies).
- Auth.js exclusively creates, encrypts, rotates and clears its cookies. Its native CSRF flow, Google PKCE/state/nonce checks and canonical redirect restrictions remain enabled. There is no custom login endpoint, cookie encoder or session-token decoding workaround.
- The existing `Session` table remains the revocation registry and WebAuthn challenge binding. Successful sign-in creates one entry under a `User` row lock. The encrypted JWT contains only `sub` and `sessionId` (plus Auth.js standard claims). Its random database `sessionToken` is not used as a cookie.
- Both sign-ins return the same local user ID. Google linking still requires the pre-authorized email, verified Google profile, allowed Workspace domain when configured, and matching/pinned Google subject. A password entered with a matching email cannot link a Google identity or create a user.
- Roles (`EMPLOYEE`, `MANAGE_DRIVER`, `ADMIN`, `SUPER_ADMIN`) are reloaded from the database. Inactive/suspended/missing users are denied; employee roles require an Employee profile. Existing permissions, employee relationships, reports and attendance history remain authoritative.
- Existing lower/trim normalization and the database's unique email plus `User_email_normalized` CHECK constraint are reused.

## Password and recovery behavior

- `User.passwordHash` is nullable. Existing Google-only users retain `null`; they do not need a password for Google sign-in.
- Central server-only hashing uses **Argon2id**, 64 MiB memory, three iterations, one lane and a random salt. The policy is 12–128 characters, with no composition rules, trimming or truncation. Unknown/Google-only users still perform a dummy hash verification. Hashes never enter client user objects, JWT claims, session responses or logs.
- **Account security**, available to every role, shows Set password or Change password. The server derives identity from `requireUser()`. Changes require the existing application password; setting the first password requires an authenticated session and matching confirmation. The session, eligibility and prior password hash are checked again under the user lock.
- Forgot password always returns the same message for valid email submissions, including unknown/ineligible accounts and throttled attempts. Database lookup and SMTP delivery run with Next.js `after()` to keep account-dependent work outside public-response timing.
- Recovery uses 32 cryptographically random bytes. Only a SHA-256 digest is stored. Tokens bind to the user's ID and current email, expire after 30 minutes, are single-use, and replace earlier pending tokens. Concurrent consumption is serialized and checked atomically. A reset verifies mailbox ownership and can establish a password on an existing administrator-provisioned account that has never used Google.
- Reset links use `/reset-password#token=...`. The fragment is read into a component ref and removed from browser history; the token is only submitted in the JSON POST body. It does not appear in access-log URLs, referrers, hidden inputs, Redux state or session data. Do not configure infrastructure to log authentication/password request bodies.
- Setting, changing or resetting a password invalidates **all sessions**, including the current session, and all pending reset tokens. Users sign in again. Password sign-in and password updates lock the same user row and compare the verified password hash, preventing a reset-racing login from issuing a session using the old password.
- An administrative email change clears the application password and reset tokens alongside the existing OAuth/session/passkey revocations. Ownership verification must happen again for the new email.
- Audit events record `PASSWORD_SET`, `PASSWORD_CHANGED`, `PASSWORD_RESET` and invalid/expired reset attempts without password or token material. Defensive redaction covers password/hash/token fields recursively, including administrative snapshots.

## Rate limits

Existing atomic PostgreSQL rate-limit buckets are reused across application instances. Each action has separate IP and hashed identifier limits in a 15-minute window:

| Action              | Per IP | Per account/token |
| ------------------- | -----: | ----------------: |
| Credentials login   |     50 |                10 |
| Forgot password     |     20 |                 3 |
| Reset consumption   |     30 |                 5 |
| Set/change password |     30 |                 5 |

Only the existing authenticated Nginx ingress may supply `x-real-ip`; arbitrary forwarded headers are ignored. Without a valid trusted ingress, requests share an `unavailable` IP bucket, which deliberately fails closed and may throttle unrelated users. Configure `TRUSTED_PROXY_MODE=nginx` and the existing proxy secret correctly for production. Limits expire automatically; there are no permanent account lockouts. Login limiter failures issue no session, and forgot failures keep the generic response.

## Sessions and attendance

Registry sessions have an absolute seven-day lifetime. JWT cookie rotation cannot extend a revoked or expired registry entry. Logout deletes the current entry; administrative role/status changes retain their existing session deletion behavior. Session callbacks and protected services check the live registry.

**Existing opaque database-session cookies require a fresh sign-in after this release.** Existing user/account/passkey/attendance records are preserved, and users do not need to register passkeys again. Coordinate application-instance replacement so old and new session strategies do not alternate during rollout.

Attendance remains a separate verification ceremony. Its live session, account status, challenge binding, passkey, approved-device, location and office-network checks remain in place. The former Google-only identity prerequisite now accepts either a Google binding or a stored application-password identity; required attendance evidence is unchanged.

## SMTP and deployment

Configure the application mail service using server-only environment variables:

```dotenv
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=application-mail-user
SMTP_PASSWORD=application-mail-service-secret
EMAIL_FROM=attendance@example.com
```

Port 587 uses required STARTTLS. For implicit TLS, use port 465 and `SMTP_SECURE=true`. Credentials must be supplied as a pair, or omitted for an authorized relay. TLS certificate verification remains enabled; debug logging, arbitrary URL/file message access and token logging are disabled. `AUTH_URL` controls the canonical link origin.

Missing SMTP configuration does not break Google/password sign-in. Recovery still returns the generic message, logs a fixed operational failure and invalidates an undeliverable token. `after()` is not a durable delivery queue: monitor failures and ask the user to request a new link after correcting delivery. No external email was sent during development tests.

1. Install dependencies with `pnpm install --frozen-lockfile`. `pnpm-workspace.yaml` explicitly permits Argon2's native install step; keep the generated native dependency in standalone deployments.
2. Test migration `20260926130000_application_passwords` on an isolated database/Neon branch. It adds nullable `User.passwordHash` and the indexed `PasswordResetToken` table (`id`, `userId`, `email`, `tokenHash`, `expiresAt`, `createdAt`, `usedAt`, cascading user relation).
3. Apply the reviewed migration using the deployment environment's `DATABASE_URL`: `pnpm db:migrate`, then `pnpm db:generate`. The existing Prisma configuration resolves Neon's direct endpoint for migrations.
4. Configure SMTP and the existing OAuth/proxy/WebAuthn environment, run `pnpm build`, deploy the application, and have users sign in again once.
5. Keep the existing hourly `pnpm db:cleanup`; it now also removes expired reset tokens.
6. Verify live Google consent/callback, SMTP inbox delivery, reset link handling by your email client and a physical passkey on the deployment. Automated verification does not substitute for those external checks.

No production migration or deployment was performed during this implementation.

## Changed files and validation

Core changes: `src/auth.ts`, `src/lib/auth.ts`, `src/types/next-auth.d.ts`; new `src/modules/auth/{account-policy,credentials,password,password-validation,auth-rate-limit,password-management,password-reset}.ts`; `src/lib/{email,env}.ts`; `src/app/api/account/password/route.ts` and `src/app/api/password/{forgot,reset}/route.ts`.

UI changes: the existing login page; new forgot/reset/account-security pages and `src/components/auth/*`; two account-security navigation links in `app-shell.tsx`; scoped additions to `globals.css`. Related safeguards: attendance/WebAuthn identity predicates, employee email-change revocation, audit redaction, cleanup, dependency manifests/lockfile, native server externals and the additive Prisma migration. Existing unrelated work was preserved.

Tests cover existing Google authorization and linking, every role, password identity resolution, generic failures, Argon2 and policy, native Auth.js CSRF/cookies/JWT/session/logout, own-account boundaries, current-password verification, reset expiry/replay/races/email binding, database throttling, SMTP configuration and sanitized failures, client loading/error states and mobile layout. Existing browser fixtures now use standard Auth.js JWTs backed by the same test Session registry; no application test bypass was added.

Verification was performed against a separate local disposable PostgreSQL database, never the configured production database.

| Executed command/check                                                                                      | Result                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                                                                            | Passed, including Argon2 native dependency installation policy                                                            |
| `DATABASE_URL=<disposable database> pnpm db:migrate`                                                        | All 13 migrations applied successfully, including the new password migration                                              |
| `pnpm db:generate` and `pnpm db:validate`                                                                   | Passed with Prisma 7.10.0                                                                                                 |
| PostgreSQL transaction applying the actual new migration over existing User/Google Account/Session fixtures | Passed; user ID, Google binding and related records preserved; password hash remains null; probe rolled back              |
| `pnpm lint`                                                                                                 | Passed                                                                                                                    |
| `pnpm typecheck`                                                                                            | Passed                                                                                                                    |
| `TEST_DATABASE_URL=<disposable database> pnpm test`                                                         | **61 suites, 829 tests passed**, including real database integration/concurrency and installed Auth.js HTTP handler tests |
| `TEST_DATABASE_URL=<disposable database> pnpm test:e2e`                                                     | **55 browser tests passed** in the final complete run                                                                     |
| `pnpm build`                                                                                                | Production compilation, TypeScript and prerendering passed                                                                |
| Mobile screenshots and viewport measurements                                                                | Login, forgot and reset pages visually inspected; no horizontal overflow at 390px                                         |
| `git diff --check`                                                                                          | Passed                                                                                                                    |

The browser suite includes real password sign-in/logout for all four roles, Google-session-to-password setup on the same user, password change/reset, generic forgotten-password responses, role and attendance access, and a password-only employee using a Chromium virtual authenticator for actual WebAuthn registration/signatures. Unapproved devices were rejected; approved-device check-in/check-out and consumed session-bound challenges succeeded. Initial browser failures were corrected test setup/assertions: retained hidden route fields, invalid employee fixtures, in-flight cookie replacement, and employee lookup pagination in the accumulated disposable database.

Not executed: live Google consent/callback with a real Google account, delivery through a production SMTP server to an inbox, or physical biometric/hardware interaction. Google authorization/linking callbacks and its retained provider configuration were covered automatically; SMTP delivery was mocked; browser WebAuthn used a virtual authenticator. These external deployment checks and production migration remain the operator's rollout steps above.
