You are a senior full-stack software engineer and software architect.

Build a production-ready Office Attendance Management System.

This is not a basic CRUD application. Build it using modular, maintainable, scalable architecture with strict server-side validation and security.

# Technology Stack

Use:

* Next.js latest stable version
* App Router
* React
* TypeScript strict mode
* Tailwind CSS
* PostgreSQL
* Prisma ORM
* Auth.js
* Google OAuth 2.0
* Google Cloud Console OAuth credentials
* Zod
* WebAuthn / Passkeys
* `@simplewebauthn/server`
* `@simplewebauthn/browser`

The application must support deployment on a VPS using:

* Node.js
* PostgreSQL
* Nginx
* HTTPS

Use a modular monolith architecture.

Do not introduce unnecessary microservices.

---

# Authentication Requirement

IMPORTANT:

The application must use ONLY Google OAuth for account authentication.

Do NOT implement:

* email/password login
* credential authentication
* password hashing
* password reset
* registration with passwords
* OTP login
* magic link authentication

Employees and administrators authenticate using:

Google Account
→ Google OAuth 2.0
→ Auth.js
→ Application Session

Use Google Cloud Console OAuth credentials:

* GOOGLE_CLIENT_ID
* GOOGLE_CLIENT_SECRET

Use Auth.js for Google OAuth integration.

Persist authenticated users using Prisma and PostgreSQL.

---

# Google OAuth Flow

Authentication flow:

Employee/Admin
→ Click "Continue with Google"
→ Redirect to Google
→ User selects Google account
→ Google authenticates user
→ OAuth callback
→ Auth.js validates OAuth response
→ Application loads user record
→ Role and account status are checked
→ Secure session established
→ Redirect to appropriate dashboard

Example:

EMPLOYEE
→ `/employee/dashboard`

ADMIN / SUPER_ADMIN
→ `/admin/dashboard`

---

# Google Account Authorization

Google authentication proves the identity of the Google account.

However, authentication does NOT automatically mean the Google account is authorized to use the attendance system.

Create a local User/Employee record.

A Google user may access the system only when their email matches an authorized user in the database.

Example:

Database:

```text
Employee

email: employee@company.com
status: ACTIVE
role: EMPLOYEE
```

Google authentication:

```text
Google email:
employee@company.com
```

If email matches and the account is active:

ALLOW LOGIN

Otherwise:

DENY ACCESS

````

Do not automatically create unrestricted employee accounts for any Google account.

---

# Optional Company Domain Restriction

Design authentication so that an allowed Google Workspace domain can optionally be configured.

Example:

```env
ALLOWED_GOOGLE_DOMAIN=vocox.com
````

If enabled:

```text
rian@vocox.com
→ allowed

random@gmail.com
→ rejected
```

However, database authorization must still be checked even when domain restriction exists.

Domain validation is an additional rule, not a replacement for database authorization.

Put this logic in a centralized authorization service.

---

# User Model

Design a User model containing appropriate fields such as:

```text
id
name
email
image
googleAccountId
role
status
createdAt
updatedAt
lastLoginAt
```

Suggested enums:

```text
Role:
SUPER_ADMIN
ADMIN
EMPLOYEE

UserStatus:
ACTIVE
INACTIVE
SUSPENDED
```

Email must be unique.

Use the verified email returned by Google OAuth.

Do not trust an email sent manually by the browser.

---

# Authentication Security

Implement secure OAuth/session handling.

Requirements:

* Auth.js
* Google OAuth
* secure HttpOnly cookies
* Secure cookies in production
* SameSite protection
* secure session handling
* CSRF/state protection through the authentication framework
* session expiration
* backend authorization
* environment variable validation

Never expose:

```text
GOOGLE_CLIENT_SECRET
AUTH_SECRET
database credentials
OAuth tokens
```

to frontend code.

---

# Role-Based Access Control

Implement:

```text
SUPER_ADMIN
ADMIN
EMPLOYEE
```

RBAC must be checked on the backend.

Never rely only on frontend route hiding.

Example:

```text
Employee:
- attendance
- attendance history
- registered devices
- profile

Admin:
- employee management
- attendance management
- office management
- shift management
- reports

Super Admin:
- everything
- admin management
- global settings
```

Create centralized authorization helpers such as:

```ts
requireUser()
requireEmployee()
requireAdmin()
requireSuperAdmin()
```

Do not duplicate authorization logic across route handlers.

---

# First Login Behavior

Employees should normally be created by an administrator before their first Google login.

Recommended flow:

Admin
→ Creates employee
→ Enters official Google email
→ Assigns office
→ Assigns department
→ Assigns shift
→ Employee opens attendance website
→ Continue with Google
→ Google email matches employee
→ Account activated/session created
→ Employee dashboard

Do not allow public self-registration.

---

# Main System Features

Build:

1. Google OAuth authentication
2. Role-based authorization
3. Employee management
4. Department management
5. Office management
6. Shift management
7. Employee shift assignment
8. WebAuthn device/passkey registration
9. GPS geofencing
10. Office network verification
11. Check-in
12. Check-out
13. Attendance status calculation
14. Late calculation
15. Working-hour calculation
16. Attendance history
17. Admin dashboard
18. Reports
19. Holidays
20. Leave management
21. Audit logging
22. Failed attendance attempt logging

---

# Attendance Authentication

Google OAuth handles application identity.

WebAuthn is a separate security layer used for attendance confirmation.

Architecture:

```text
Google OAuth
     ↓
Who is the employee?
     ↓
Authenticated Session
     ↓
Employee clicks CHECK IN
     ↓
WebAuthn verification
     ↓
GPS verification
     ↓
Office network verification
     ↓
Attendance accepted
```

Do NOT replace Google OAuth with WebAuthn.

They solve different problems.

Google OAuth:
application login/identity

WebAuthn:
attendance/device verification

---

# WebAuthn

Do not store fingerprint information.

Never request or store:

* fingerprint images
* fingerprint templates
* Touch ID data
* Face ID data
* biometric data

Use WebAuthn / Passkeys.

The employee device performs user verification locally.

Possible authenticators include:

* fingerprint
* Touch ID
* Face ID
* Windows Hello
* supported device verification methods

The server receives only cryptographic authentication evidence.

Use:

```text
@simplewebauthn/server
@simplewebauthn/browser
```

Require user verification for attendance authentication where supported.

---

# Device Registration

Employee should register their device/passkey after signing in through Google.

Flow:

```text
Google Login
    ↓
Employee Dashboard
    ↓
Register Device
    ↓
Server generates WebAuthn challenge
    ↓
Browser/WebAuthn authenticator
    ↓
Fingerprint / Touch ID / Face ID
    ↓
Server verifies registration
    ↓
Credential stored
```

Credential should contain appropriate information such as:

```text
id
employeeId
credentialId
publicKey
counter
transports
deviceType
backedUp
approved
createdAt
revokedAt
```

Support:

* device registration
* device approval
* device revocation
* viewing registered devices

---

# Office Model

Office should contain:

```text
id
name
address
latitude
longitude
geofenceRadiusMeters
timezone
active
createdAt
updatedAt
```

Office configuration must come from the database.

Do not trust office coordinates supplied by employees.

---

# GPS Geofencing

The browser may collect only:

```text
latitude
longitude
accuracy
```

using the browser Geolocation API.

The frontend must NOT determine whether the employee is inside the office.

Backend performs geofence verification.

Backend should:

1. validate coordinates
2. validate reported GPS accuracy
3. load office coordinates
4. calculate distance
5. compare distance with office radius
6. approve/reject location verification

Use the Haversine formula.

Create a reusable service:

```ts
calculateDistanceMeters()
```

Write unit tests.

---

# Office Wi-Fi / Network Verification

Do NOT attempt to read the Wi-Fi SSID from a browser.

Instead verify the public network IP seen by the backend.

Create:

```text
OfficeNetwork
```

Fields:

```text
id
officeId
publicIpOrCidr
active
description
createdAt
updatedAt
```

Flow:

```text
Employee device
→ Office Wi-Fi
→ Office Router
→ Attendance Backend
→ Backend detects client IP
→ Compare with approved office network
```

If strict office-network verification is enabled and IP does not match:

```text
WRONG_NETWORK
```

Reject attendance.

---

# Proxy Security

The application may run behind:

```text
Nginx
Cloudflare
Reverse Proxy
```

Create a centralized utility for client IP extraction.

Do not blindly trust arbitrary:

```text
X-Forwarded-For
```

or similar headers.

Only trust forwarded IP information from configured trusted proxies.

Document the production proxy configuration.

---

# Attendance Policy

Create a centralized AttendancePolicy system.

Example:

```ts
interface AttendancePolicy {
  requireWebAuthn: boolean;
  requireGeofence: boolean;
  requireOfficeNetwork: boolean;
  requireApprovedDevice: boolean;
  maximumGpsAccuracyMeters: number;
}
```

Do not scatter these rules across API routes.

Policies may eventually be configured per office.

Example:

```text
Main Office:

WebAuthn: required
GPS: required
Office Network: required
Approved Device: required
GPS accuracy <= 50 meters
```

---

# Attendance Verification Pipeline

Create a dedicated service such as:

```text
AttendanceVerificationService
```

or:

```ts
verifyAttendanceAttempt()
```

Server-side flow:

```text
1. Verify Auth.js session
2. Resolve Google-authenticated user
3. Verify user exists in database
4. Verify user status is ACTIVE
5. Resolve employee
6. Resolve assigned office
7. Resolve current shift
8. Validate attendance policy
9. Verify WebAuthn challenge/assertion
10. Verify credential is registered
11. Verify credential is approved
12. Validate GPS coordinates
13. Validate GPS accuracy
14. Calculate office distance
15. Verify geofence
16. Detect client IP
17. Verify office network
18. Verify current attendance state
19. Calculate attendance status
20. Save attendance transactionally
21. Create AttendanceEvent
22. Create appropriate audit/security data
23. Return sanitized response
```

The browser is untrusted.

The browser may provide evidence.

The backend makes the final decision.

---

# Never Trust Frontend Flags

Never accept values such as:

```json
{
  "biometricVerified": true,
  "insideOffice": true,
  "officeWifi": true,
  "isLate": false,
  "workedHours": 8
}
```

as authoritative.

The server must calculate these values.

Frontend should submit only required evidence.

---

# Server Time

Server time is authoritative.

Never use device/browser time for attendance.

Use server-generated timestamps for:

```text
checkInAt
checkOutAt
createdAt
updatedAt
```

The user must not be able to manipulate attendance by changing their device clock.

---

# Shift Management

Shift should support:

```text
id
name
startTime
endTime
graceMinutes
halfDayThreshold
timezone
active
```

Support overnight shifts.

Example:

```text
20:00
to
05:00
```

Do not assume the shift ends on the same calendar day.

---

# Attendance Status

Support:

```text
PRESENT
LATE
ABSENT
HALF_DAY
LEAVE
HOLIDAY
WEEKEND
```

Example:

```text
Shift starts: 09:00
Grace period: 15 minutes

09:00–09:15
→ PRESENT

after 09:15
→ LATE
```

Store:

```text
lateMinutes
```

instead of only the status.

---

# Check-In

Employee clicks:

```text
CHECK IN
```

Flow:

```text
Authenticated Google session
        ↓
Request WebAuthn challenge
        ↓
User verification
        ↓
Retrieve GPS
        ↓
Submit WebAuthn assertion + GPS
        ↓
Backend verifies everything
        ↓
Detect office network
        ↓
Calculate attendance status
        ↓
Transaction
        ↓
Attendance recorded
```

---

# Check-Out

Check-out must perform the configured security verification again.

Flow:

```text
CHECK OUT
→ WebAuthn
→ GPS
→ Office network
→ backend verification
→ check-out timestamp
```

Calculate:

```text
workedMinutes =
checkOutAt - checkInAt
```

Calculate on the backend.

---

# Attendance Database

Design robust Prisma models.

Core models:

```text
User
Account
Session
Employee
Department
Office
OfficeNetwork
Shift
EmployeeShift
WebAuthnCredential
Attendance
AttendanceEvent
Holiday
Leave
AuditLog
```

Use Auth.js-compatible Account/Session models when required by the chosen session strategy.

Add appropriate:

* unique constraints
* foreign keys
* indexes
* timestamps

Prevent duplicate attendance records with database constraints where appropriate.

---

# Attendance Record

Attendance should contain appropriate fields such as:

```text
id
employeeId
officeId
shiftId

attendanceDate

checkInAt
checkOutAt

checkInLatitude
checkInLongitude
checkInAccuracy
checkInDistanceMeters
checkInIp

checkOutLatitude
checkOutLongitude
checkOutAccuracy
checkOutDistanceMeters
checkOutIp

checkInCredentialId
checkOutCredentialId

status
lateMinutes
workedMinutes

createdAt
updatedAt
```

Avoid storing unnecessary sensitive data.

---

# Attendance Event

Create an immutable AttendanceEvent system.

Examples:

```text
CHECK_IN_SUCCESS
CHECK_IN_REJECTED
CHECK_OUT_SUCCESS
CHECK_OUT_REJECTED
DEVICE_REGISTERED
DEVICE_APPROVED
DEVICE_REVOKED
ADMIN_CORRECTION
```

Rejection reasons may include:

```text
OUTSIDE_GEOFENCE
GPS_ACCURACY_TOO_LOW
WRONG_NETWORK
WEBAUTHN_FAILED
DEVICE_NOT_APPROVED
NO_ACTIVE_SHIFT
ALREADY_CHECKED_IN
NOT_CHECKED_IN
USER_NOT_AUTHORIZED
USER_INACTIVE
```

---

# Employee Dashboard

Create a responsive mobile-first employee dashboard.

Display:

```text
Employee name
Google profile image
Employee ID
Department
Office
Shift

Today's status
Check-in time
Check-out time
Late minutes
Worked duration

Device status
Location status
Office network status
```

Main buttons:

```text
CHECK IN
CHECK OUT
```

Provide clear user-friendly errors.

---

# Admin Dashboard

Admin dashboard should show:

```text
Total employees
Present today
Late today
Absent today
Currently checked in
Checked out
```

Pages:

```text
Employees
Departments
Offices
Office Networks
Shifts
Shift Assignments
Attendance
Devices
Leaves
Holidays
Reports
Audit Logs
Settings
```

---

# Employee Management

Admin can:

```text
Create employee
Edit employee
Activate/deactivate employee
Set Google email
Assign department
Assign office
Assign shift
View attendance
View registered devices
Approve device
Revoke device
```

The employee Google email is important because OAuth authentication must match it.

---

# Reports

Support filters:

```text
Employee
Department
Office
Shift
Status
Date range
```

Export initially:

```text
CSV
Excel
```

Architecture should allow PDF reporting later.

---

# Audit Logging

Log important administrator/security actions:

```text
employee created
employee updated
employee disabled
role changed
office changed
shift changed
attendance manually corrected
device approved
device revoked
attendance policy modified
```

Include:

```text
actor
action
resource
resourceId
previousState where appropriate
newState where appropriate
timestamp
```

Never log:

```text
Google client secret
Auth.js secret
cookies
OAuth tokens
raw WebAuthn challenges unnecessarily
raw biometric information
```

---

# API Architecture

Use consistent responses.

Success:

```json
{
  "success": true,
  "data": {}
}
```

Failure:

```json
{
  "success": false,
  "error": {
    "code": "OUTSIDE_GEOFENCE",
    "message": "You are outside the office attendance area."
  }
}
```

Use centralized domain error handling.

Never expose:

```text
Prisma errors
SQL errors
stack traces
OAuth secrets
internal WebAuthn errors
```

to users.

---

# Security Requirements

Implement:

* Google OAuth through Auth.js
* OAuth state/CSRF protection
* secure server sessions
* HttpOnly cookies
* Secure cookies in production
* SameSite protection
* backend RBAC
* Zod validation
* rate limiting
* WebAuthn challenge expiration
* single-use WebAuthn challenges
* replay protection
* safe IP extraction
* server timestamps
* database transactions
* audit logging
* security headers
* environment validation
* production-safe error handling

---

# Environment Variables

Create `.env.example`.

Expected variables may include:

```env
DATABASE_URL=

AUTH_SECRET=

GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

AUTH_URL=

ALLOWED_GOOGLE_DOMAIN=

WEBAUTHN_RP_ID=
WEBAUTHN_RP_NAME=
WEBAUTHN_ORIGIN=

TRUSTED_PROXY_MODE=
```

Do not put real secrets inside `.env.example`.

---

# Google Cloud Console Documentation

Document how to configure Google Cloud Console.

Include:

1. Create/select Google Cloud project.
2. Configure OAuth consent screen.
3. Create OAuth 2.0 Client ID.
4. Choose Web Application.
5. Configure authorized JavaScript origins if required.
6. Configure Auth.js OAuth callback URL.
7. Copy Client ID.
8. Copy Client Secret.
9. Add them to environment variables.
10. Configure production callback URL.
11. Explain localhost development callback configuration.

Do not hard-code callback URLs.

Use environment-aware configuration.

---

# Transaction Safety

Attendance check-in and check-out must be transactionally safe.

Prevent race conditions.

Example:

Two simultaneous CHECK IN requests

must NOT create:

```text
Attendance #1
Attendance #2
```

Use:

* database unique constraints
* transactions
* appropriate locking/concurrency handling

Frontend button disabling alone is not sufficient.

---

# Testing

Create automated tests for:

Google OAuth authorization logic:

1. authorized employee email
2. unknown Google email
3. inactive employee
4. wrong Google Workspace domain
5. role authorization
6. unauthorized admin route

Attendance:

7. inside geofence
8. outside geofence
9. poor GPS accuracy
10. approved office network
11. wrong network
12. valid WebAuthn flow where practical
13. expired challenge
14. reused challenge
15. revoked credential
16. unapproved device
17. duplicate check-in
18. check-out without check-in
19. late calculation
20. grace-period calculation
21. worked-minute calculation
22. overnight shift
23. transaction race condition

Focus heavily on domain/service tests.

---

# Project Architecture

Prefer:

```text
src/
├── app/
│   ├── (auth)/
│   ├── employee/
│   ├── admin/
│   └── api/
│
├── modules/
│   ├── auth/
│   ├── employees/
│   ├── departments/
│   ├── offices/
│   ├── shifts/
│   ├── attendance/
│   ├── webauthn/
│   ├── geofence/
│   ├── network/
│   ├── reports/
│   └── audit/
│
├── lib/
│   ├── db/
│   ├── auth/
│   ├── security/
│   ├── validation/
│   └── logger/
│
└── prisma/
    └── schema.prisma
```

Use domain-oriented modules.

Avoid giant route handlers.

---

# Code Quality

Use:

* TypeScript strict mode
* no unnecessary `any`
* reusable services
* small functions
* clear domain types
* centralized validation
* centralized authorization
* centralized attendance policies
* proper database indexes
* transactions
* consistent error handling

Avoid:

* duplicated logic
* hard-coded coordinates
* hard-coded office IP
* hard-coded employee emails
* hard-coded shift schedules
* client-side authorization
* client-generated attendance time
* raw biometric storage
* frontend-controlled verification flags

---

# UI

Build a professional responsive interface.

Authentication screen should contain only:

```text
Company logo
Office Attendance System

[ Continue with Google ]
```

Do not display:

```text
Email input
Password input
Register
Forgot Password
```

Employee UI should be mobile-first.

Admin UI should be optimized for desktop while remaining responsive.

---

# PWA

Prepare the employee application as an installable PWA.

Do NOT implement offline attendance submission.

Attendance requires an active connection because the backend must verify:

```text
session
WebAuthn
GPS
network
server timestamp
attendance state
```

---

# Production Requirements

Prepare:

```text
Prisma migrations
database seed
.env.example
environment validation
build command
lint command
test command
production README
Nginx configuration guidance
HTTPS requirements
Google OAuth production configuration
trusted proxy configuration
PostgreSQL deployment documentation
```

---

# Development Order

Implement in this order:

Phase 1
Inspect existing repository

Phase 2
Design final architecture

Phase 3
Prisma database schema

Phase 4
Google OAuth + Auth.js

Phase 5
Google user authorization + RBAC

Phase 6
Employee management

Phase 7
Department/office management

Phase 8
Shift management

Phase 9
Basic attendance domain

Phase 10
GPS/geofence service

Phase 11
Office network verification

Phase 12
WebAuthn device registration

Phase 13
WebAuthn attendance verification

Phase 14
Secure check-in

Phase 15
Secure check-out

Phase 16
Attendance calculations

Phase 17
Employee dashboard

Phase 18
Admin dashboard

Phase 19
Reports

Phase 20
Audit/event logging

Phase 21
Automated tests

Phase 22
Security hardening

Phase 23
PWA optimization

Phase 24
Production documentation

---

# Critical Authentication Principle

The authentication architecture must be:

```text
Google OAuth
     ↓
Google verifies identity
     ↓
Auth.js receives authenticated identity
     ↓
Backend finds matching local User/Employee
     ↓
Backend checks:
- authorized email
- account status
- role
- optional company domain
     ↓
Secure session
```

Google authentication alone must NOT automatically grant access.

Local database authorization remains authoritative.

---

# Final Attendance Rule

Conceptually:

```text
Authenticated Google User
        +
Authorized Local Employee
        +
Active Employee
        +
Valid Shift
        +
Approved Registered Device
        +
Successful WebAuthn Verification
        +
Inside Office Geofence
        +
Acceptable GPS Accuracy
        +
Approved Office Network
        +
Valid Attendance State
        =
Attendance Accepted
```

---

# Before Coding

First inspect the repository.

Then provide:

1. Current architecture summary
2. Current dependencies
3. Current Prisma/database structure
4. Files that need to change
5. Files/modules that need to be added
6. Proposed final folder structure
7. Proposed Prisma schema
8. Google OAuth architecture
9. Authorization/RBAC architecture
10. Attendance verification architecture
11. Security risks and mitigations
12. Implementation order

Then begin implementation.

Do not ask unnecessary questions if a secure and reasonable engineering decision can be made from the existing repository.

Do not rewrite unrelated working functionality.

After meaningful implementation phases run:

```text
TypeScript check
lint
tests
Prisma validation
production build
```

Fix errors before considering the implementation complete.
