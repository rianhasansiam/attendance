# Office Work

Open `/office-work` from the existing workspace navigation. Office Work uses the existing authenticated session and the database roles `SUPER_ADMIN`, `MANAGE_DRIVER`, and `EMPLOYEE`. The legacy `ADMIN` role has no Office Work access.

## Setup

Apply the additive migration and regenerate the Prisma client before starting the updated application:

```sh
pnpm db:generate
pnpm db:migrate
pnpm build
# Restart the application's existing process.
```

The migration is `20261121140000_office_work_tracker`. It adds tasks and indexes and reuses append-only `AuditLog` entries for activity; it creates no users or tasks. Task creation requires one active eligible assignee. If an existing account is subsequently permanently removed through the application's account-deletion workflow, historical task references can become null while activity snapshots remain available.

Business dates use `OFFICE_WORK_TIMEZONE`, falling back to `DAILY_EXPENSES_TIMEZONE`, then `Asia/Dhaka`. Set an IANA timezone on the server if a different business timezone is needed. Due dates are stored as PostgreSQL `DATE` and transported as `YYYY-MM-DD`; event timestamps are ISO timestamps.

## Permissions and workflow

| Role            | Visibility                                                          | Task management                                                                                                                            | Assignment targets            |
| --------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- |
| `SUPER_ADMIN`   | All tasks and global metrics                                        | Create, edit, reassign, reopen, archive; start/complete for another assignee with a reason                                                 | Active employees and managers |
| `MANAGE_DRIVER` | All tasks and global metrics; My Work scopes cards and list to self | Create; edit/reassign/reopen only their original tasks while the current assignee is still an employee; start/complete their assigned work | Active employees              |
| `EMPLOYEE`      | Currently assigned tasks and their own metrics                      | Start/complete assigned work                                                                                                               | None                          |

Ordinary work progresses **Pending → Processing → Done**. Reopening requires a reason, changes Done to Processing, clears completion, and preserves the original start. Reassignment changes the task to Pending and clears lifecycle timestamps; changing an in-progress or completed assignment requires explicit reset confirmation. Reassigning to the same person is a no-op. Only super administrators can archive, and archived tasks are read-only. There is no task-deletion endpoint or completion-approval workflow.

Each write commits its activity in the same database transaction. Task mutations require the current `expectedVersion`; conflicts return HTTP 409 with a refresh message. Create requests carry a UUID `requestId` so retries cannot create duplicate tasks. Creator identity remains the original creator after reassignment. Current account roles/status are rechecked on the server; old assignees immediately lose task and activity access.

## Filters and metrics

Search, assignee, creator, priority, and due-date boundaries define the base dataset. Cards and workload summarize that dataset. Status, Overdue, Due Today, and High Priority selections narrow the list without zeroing unrelated cards. My Work scopes both the list and cards to the current user. Employees cannot use query parameters to widen their scope and receive neither global workload nor user-directory data.

Archived tasks are omitted by default and always omitted from dashboard metrics. Overdue means an unfinished, unarchived task with a due date before the current business date; Due Today counts unfinished tasks due on that date. Completion percentage is Done divided by all non-archived tasks in scope, or zero when empty. Filters, stable sorting, and bounded pagination run on the server.

## API

All routes use the existing no-store success/error envelopes, persisted sessions, input validation, and same-origin mutation protection.

| Method and route                    | Operation                                               |
| ----------------------------------- | ------------------------------------------------------- |
| `GET /api/office-work`              | Scoped list, dashboard, workload, and creator filters   |
| `POST /api/office-work`             | Create a task                                           |
| `GET /api/office-work/:id`          | Scoped task detail and paginated activity               |
| `PATCH /api/office-work/:id`        | Edit allowed management fields                          |
| `POST /api/office-work/:id/actions` | `start`, `complete`, `reopen`, `reassign`, or `archive` |
| `GET /api/office-work/:id/activity` | Scoped paginated activity                               |
| `GET /api/office-work/assignees`    | Eligible active assignment targets for task creators    |

## Verification

```sh
pnpm test:office-work
pnpm db:validate
pnpm typecheck
pnpm lint
pnpm build
```

The test suite uses the existing Node test runner. Pure validation/policy and HTTP tests run without a database. For migration, service, concurrency, and transaction tests, provision an explicitly disposable local PostgreSQL database whose name contains `test`, apply the migrations, and run:

```sh
DATABASE_URL=postgresql://TEST_USER@127.0.0.1:TEST_PORT/attendance_office_work_test pnpm db:migrate
TEST_DATABASE_URL=postgresql://TEST_USER@127.0.0.1:TEST_PORT/attendance_office_work_test pnpm test:office-work
```

Never point the integration suite at a shared or production database. The suite creates fixture accounts/tasks and tests failure-trigger rollback only in the disposable database. Migration rehearsal uses an isolated schema rolled back after verification.
