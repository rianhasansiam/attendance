# Public profiles

Anyone can visit `/profile/<name-slug>` without signing in; for example, **Rian Hasan Siam** becomes `/profile/rian_hasan_siam`. Slugs use lowercase ASCII letters and numbers separated by underscores. Duplicate names receive numeric suffixes (`rian_hasan_siam_2`); names without ASCII letters or numbers use `team_member`. Slugs are assigned when accounts are created and stay unchanged when display names are edited. Existing `/profile/<user-id>` links redirect to the named URL.

Active accounts of every role are supported, including administrators without an employee record. The page displays name, existing profile photo, designation, phone, blood group, department, home address and date of birth. Empty details show **Not listed**. Email, authentication data, employee identifiers, attendance and financial records are excluded from the public query.

Super administrators can open **Edit public profile** from **Employees** or **All Users**. The editor lives at `/admin/users/<user-id>/profile`, with its protected read/write API at `/api/admin/users/<user-id>/public-profile`. Both the page and API require Super Admin. The service rechecks the persisted actor's active status and role during writes. Regular Admins cannot change the displayed name through the employee API, but retain their other employee-management permissions.

Profile details belong to `User`, so administrator profiles do not require an employee record. Public department is a separate text field: internal department assignment or catalog changes do not edit a public profile. The migration copies existing employee departments, and new employees start with their selected department's name. Super Admin can subsequently set the public department in the profile editor.

Date of birth is stored as a PostgreSQL `DATE`, validated as a real calendar date no later than today, and displayed in UTC to avoid timezone shifts. Blood group accepts A+, A-, B+, B-, AB+, AB-, O+ or O-. New optional fields can be cleared. Saving is audited without retaining the additional personal-field values in audit history. Account deletion removes these fields with the user row.

Public profiles read current data on every request. Inactive, suspended, deleted and unknown users all show **Profile unavailable** without revealing an account's status.

## Database update

Apply `20261001120000_public_profile_slugs` and regenerate Prisma before starting the updated application. The migration backfills existing accounts (oldest first), adds a unique slug index, and installs a trigger that assigns slugs for all account creation paths. Allocation is serialized during account creation to prevent duplicate URLs under concurrent requests.

If an unrelated migration is intentionally deferred, apply only this migration using the same `prisma db execute` / `prisma migrate resolve --applied` workflow below, substituting `20261001120000_public_profile_slugs`. Otherwise use `pnpm db:migrate` followed by `pnpm db:generate`.

Apply `20260930120000_public_profile_details` and regenerate Prisma before restarting the application. This additive migration adds nullable profile fields and initializes public departments without changing authentication or attendance.

Review pending migrations before deploying. If `20260930000000_hard_delete_daily_expenses` is intentionally still pending, apply only the public-profile migration:

```sh
pnpm exec prisma db execute --file prisma/migrations/20260930120000_public_profile_details/migration.sql
pnpm exec prisma migrate resolve --applied 20260930120000_public_profile_details
pnpm db:generate
```

Do not repeat the SQL after the migration has been applied. With no intentionally deferred migrations, the normal deployment migration workflow is sufficient.
