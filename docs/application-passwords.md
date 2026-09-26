# Application passwords

Only a super administrator can create employee accounts from **Admin → Employees → Add employee** (`/admin/employees`). Enter the employee's email, initial application password and matching confirmation together with their employee details. The employee can then sign in with that email and password. There is no public registration or email password-recovery system.

Google sign-in remains available for the same authorized account. The application password belongs to XHYD; never enter a Google password into the employee form or application password fields.

## Provisioning and password settings

- Employee creation is restricted to `SUPER_ADMIN` in both the interface and API. Regular administrators can continue viewing and editing existing employee profiles, but cannot create accounts.
- The initial password is required, hashed before storage and never returned in employee records or saved in audit snapshots. The policy is 12–128 characters, with matching confirmation and no composition rules, trimming or truncation.
- Share the initial credentials with the employee through your approved private channel. No welcome or password-reset email is sent.
- **Account security**, available to every signed-in role, supports changing an existing password after verifying the current password. Existing Google-only accounts can set their first application password while authenticated.
- Saving a password invalidates all sessions, including the current session. The user must sign in again. Any legacy recovery tokens are also invalidated.
- An administrative email change clears the application password and revokes sessions, OAuth links and registered credentials. The user must verify the updated identity through Google sign-in before setting a new password in Account security.
- `/forgot-password`, `/reset-password`, `/api/password/forgot` and `/api/password/reset` are removed. Old recovery links and tokens cannot change a password. SMTP configuration is no longer used.

## Architecture and identity

Auth.js owns both Google and credentials sign-in, using its supported JWT strategy. Auth.js creates, encrypts, rotates and clears its cookies, with native CSRF, Google PKCE/state/nonce and canonical redirect checks. There is no custom login endpoint or cookie implementation.

Both providers resolve the same local `User` ID. Signing in cannot create an account. Google linking requires the authorized local email, a verified Google profile, the allowed Workspace domain when configured, and a matching or newly pinned Google subject.

The existing `Session` table is the revocation registry and binds WebAuthn challenges. Successful sign-in creates a registry entry under a user row lock. JWTs contain only `sub` and `sessionId`, plus Auth.js standard claims. Registry sessions expire after seven days; JWT rotation cannot extend a revoked or expired entry.

Roles (`EMPLOYEE`, `MANAGE_DRIVER`, `ADMIN`, `SUPER_ADMIN`) and account status are read from the database. Inactive, suspended and missing accounts cannot sign in. Employee roles also require an employee profile. Status and role changes revoke existing sessions.

Password hashing uses server-only Argon2id with 64 MiB memory, three iterations, one lane and a random salt. Unknown accounts and accounts without passwords perform a dummy hash verification. Passwords and hashes never enter client user objects, JWTs, session responses or logs. Audit snapshot redaction also covers password and token fields recursively.

Password changes derive the target identity from `requireUser()`, never a submitted user ID. After hashing outside the transaction, the service locks the user row and rechecks the session, eligibility and previous password hash. Concurrent changes cannot overwrite another update or issue a session using an outdated verified password.

## Rate limits

Existing atomic PostgreSQL rate-limit buckets apply separate IP and hashed-identifier limits across application instances, each in a 15-minute window:

| Action              | Per IP | Per account |
| ------------------- | -----: | ----------: |
| Credentials login   |     50 |          10 |
| Set/change password |     30 |           5 |

Only the configured trusted Nginx ingress may supply `x-real-ip`; arbitrary forwarded headers are ignored. Without trusted ingress, requests share the `unavailable` IP bucket. Limits expire automatically and do not permanently lock accounts. Login limiter failures issue no session.

## Attendance

Password sign-in does not replace attendance verification. Attendance still requires a live session, eligible account, session-bound challenge, passkey, approved device, and the configured location and office-network checks. The account may have a Google binding or an application password; all required attendance evidence is unchanged.

## Deployment and validation

The existing `20260926130000_application_passwords` migration provides nullable `User.passwordHash`. Password-recovery removal and the updated employee creation flow need no new database migration. Keep the historical `PasswordResetToken` model and table for compatibility with existing migrations, cleanup and account deletion. No public handler can issue or consume those tokens.

Install the updated lockfile, regenerate Prisma when required by your deployment, build, and restart all application instances so removed routes are no longer served. Argon2's native dependency remains required. Existing OAuth, origin, trusted-proxy and WebAuthn configuration remains required; SMTP variables are unused.

Relevant tests cover credential login and Google linking, role checks, password policy and hashing, initial employee provisioning, current-password verification, session revocation, database throttling, and absence of the removed recovery pages and endpoints. Database and browser tests use a separate disposable test database. Live Google consent and physical authenticators require deployment-specific acceptance checks.
