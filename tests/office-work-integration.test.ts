import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import type { Role } from "@prisma/client";
import { db } from "../src/lib/db";
import { DomainError } from "../src/lib/errors";
import {
  createOfficeWorkTask,
  getOfficeWorkOverview,
  getOfficeWorkTask,
  listOfficeWorkAssignees,
  mutateOfficeWorkTask,
  updateOfficeWorkTask,
} from "../src/modules/office-work/service";
import { getRecord, listRecords } from "../src/modules/management/service";
import { deleteIdentity } from "../src/modules/management/delete-identity";
import { driveCostFilterSchema } from "../src/modules/management/validation";
import type {
  OfficeWorkActor,
  OfficeWorkTaskDTO,
} from "../src/modules/office-work/contracts";

const database = process.env.TEST_DATABASE_URL;
if (database) {
  const url = new URL(database);
  assert.ok(
    ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
      url.pathname.includes("test"),
    "Use an explicitly disposable local test database.",
  );
  process.env.DATABASE_URL = database;
}
const integration = database ? test : test.skip;
Object.assign(process.env, { OFFICE_WORK_TIMEZONE: "Asia/Dhaka" });
after(async () => {
  if (database) await db.$disconnect();
});
const denied = (status: number, code?: string) => (error: unknown) =>
  error instanceof DomainError &&
  error.status === status &&
  (!code || error.code === code);

async function fixture() {
  const key = `ow${randomUUID().replaceAll("-", "")}`;
  const user = async (
    label: string,
    role: Role,
    status: "ACTIVE" | "INACTIVE" = "ACTIVE",
  ) =>
    db.user.create({
      data: {
        name: `${key} ${label}`,
        email: `${key}-${label}@example.test`,
        googleAccountId: `${key}-${label}`,
        role,
        status,
      },
    });
  const [
    admin,
    manager,
    otherManager,
    employee,
    otherEmployee,
    inactive,
    legacyAdmin,
  ] = await Promise.all([
    user("admin", "SUPER_ADMIN"),
    user("manager", "MANAGE_DRIVER"),
    user("other-manager", "MANAGE_DRIVER"),
    user("employee", "EMPLOYEE"),
    user("other-employee", "EMPLOYEE"),
    user("inactive", "EMPLOYEE", "INACTIVE"),
    user("legacy-admin", "ADMIN"),
  ]);
  return {
    key,
    admin,
    manager,
    otherManager,
    employee,
    otherEmployee,
    inactive,
    legacyAdmin,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function create(
  f: Fixture,
  actor: OfficeWorkActor = f.manager,
  assigneeId = f.employee.id,
  extras: Record<string, unknown> = {},
) {
  return createOfficeWorkTask(actor, {
    title: `${f.key} report`,
    assigneeId,
    requestId: randomUUID(),
    ...extras,
  });
}
function editInput(
  task: OfficeWorkTaskDTO,
  changes: Record<string, unknown> = {},
) {
  return {
    title: task.title,
    description: task.description,
    priority: task.priority,
    dueDate: task.dueDate,
    expectedVersion: task.version,
    ...changes,
  };
}
function action(
  actor: OfficeWorkActor,
  task: OfficeWorkTaskDTO,
  operation: string,
  extras: Record<string, unknown> = {},
) {
  return mutateOfficeWorkTask(actor, task.id, {
    action: operation,
    expectedVersion: task.version,
    ...extras,
  });
}
const overview = (
  f: Fixture,
  actor: OfficeWorkActor,
  extras: Record<string, unknown> = {},
) => getOfficeWorkOverview(actor, { search: f.key, ...extras });

integration(
  "eligible assignees and creation enforce active current roles and employee directory restrictions",
  async () => {
    const f = await fixture();
    const adminChoices = await listOfficeWorkAssignees(f.admin, {
      search: f.key,
    });
    assert.ok(adminChoices.some((person) => person.id === f.employee.id));
    assert.ok(adminChoices.some((person) => person.id === f.manager.id));
    assert.ok(
      adminChoices.every(
        (person) =>
          person.role === "EMPLOYEE" || person.role === "MANAGE_DRIVER",
      ),
    );
    assert.ok(!adminChoices.some((person) => person.id === f.inactive.id));
    const managerChoices = await listOfficeWorkAssignees(f.manager, {
      search: f.key,
    });
    assert.ok(managerChoices.length > 0);
    assert.ok(managerChoices.every((person) => person.role === "EMPLOYEE"));
    await assert.rejects(listOfficeWorkAssignees(f.employee), denied(403));
    await assert.rejects(create(f, f.employee), denied(403));
    for (const target of [
      f.manager,
      f.otherManager,
      f.admin,
      f.legacyAdmin,
      f.inactive,
    ])
      await assert.rejects(
        create(f, f.manager, target.id),
        denied(400, "INVALID_ASSIGNEE"),
      );
    for (const target of [f.admin, f.legacyAdmin, f.inactive])
      await assert.rejects(
        create(f, f.admin, target.id),
        denied(400, "INVALID_ASSIGNEE"),
      );
    const assignedManager = await create(f, f.admin, f.manager.id);
    assert.equal(assignedManager.assigneeId, f.manager.id);
    assert.equal(assignedManager.createdById, f.admin.id);
  },
);

integration(
  "manager global visibility is independent from creator-limited management rights",
  async () => {
    const f = await fixture();
    const own = await create(f);
    const other = await create(f, f.otherManager, f.otherEmployee.id, {
      title: `${f.key} other manager`,
    });
    const adminTask = await create(f, f.admin, f.employee.id, {
      title: `${f.key} admin task`,
    });
    const listed = await overview(f, f.manager);
    assert.equal(listed.total, 3);
    assert.equal(listed.dashboard.total, 3);
    assert.deepEqual(
      new Set(listed.items.map((item) => item.id)),
      new Set([own.id, other.id, adminTask.id]),
    );
    assert.equal(
      (await getOfficeWorkTask(f.manager, other.id)).task.permissions.canEdit,
      false,
    );
    for (const task of [other, adminTask]) {
      await assert.rejects(
        updateOfficeWorkTask(
          f.manager,
          task.id,
          editInput(task, { title: `${f.key} unauthorized` }),
        ),
        denied(403),
      );
      await assert.rejects(
        action(f.manager, task, "reassign", { assigneeId: f.otherEmployee.id }),
        denied(403),
      );
    }
    const updated = await updateOfficeWorkTask(
      f.manager,
      own.id,
      editInput(own, { title: `${f.key} corrected` }),
    );
    assert.equal(updated.version, own.version + 1);
    assert.equal(updated.createdById, f.manager.id);
    await db.user.update({
      where: { id: f.employee.id },
      data: { role: "MANAGE_DRIVER" },
    });
    await assert.rejects(
      updateOfficeWorkTask(
        f.manager,
        updated.id,
        editInput(updated, { title: `${f.key} invalid after promotion` }),
      ),
      denied(403),
    );
    assert.equal(
      (await getOfficeWorkTask(f.manager, updated.id)).task.permissions
        .canReassign,
      false,
    );
  },
);

integration(
  "employee ID and filter tampering cannot widen lists, counts, details, activity or mutation access",
  async () => {
    const f = await fixture();
    const own = await create(f);
    const other = await create(f, f.admin, f.otherEmployee.id);
    const listed = await overview(f, f.employee);
    assert.equal(listed.total, 1);
    assert.equal(listed.dashboard.total, 1);
    assert.equal(listed.items[0].id, own.id);
    assert.deepEqual(listed.workload, []);
    assert.deepEqual(listed.creators, []);
    assert.deepEqual(listed.assignees, []);
    const forged = await overview(f, f.employee, {
      view: "all",
      assigneeId: f.otherEmployee.id,
    });
    assert.equal(forged.total, 0);
    assert.equal(forged.dashboard.total, 0);
    for (const read of [
      getOfficeWorkTask(f.employee, other.id),
      getOfficeWorkTask(f.employee, other.id, { page: 1, pageSize: 1 }),
    ])
      await assert.rejects(read, denied(404));
    await assert.rejects(action(f.employee, other, "start"), denied(404));
    await assert.rejects(
      updateOfficeWorkTask(
        f.employee,
        own.id,
        editInput(own, { title: "Unauthorized management edit" }),
      ),
      denied(403),
    );
    await assert.rejects(
      action(f.employee, own, "reassign", { assigneeId: f.otherEmployee.id }),
      denied(403),
    );
  },
);

integration(
  "manager assigned work follows ordinary lifecycle without receiving management rights",
  async () => {
    const f = await fixture();
    const pending = await create(f, f.admin, f.manager.id);
    assert.equal(pending.permissions.canEdit, true); // The DTO is for its super-admin creator.
    assert.equal(
      (await getOfficeWorkTask(f.manager, pending.id)).task.permissions.canEdit,
      false,
    );
    const processing = await action(f.manager, pending, "start");
    assert.equal(processing.status, "PROCESSING");
    assert.ok(processing.startedAt);
    const done = await action(f.manager, processing, "complete");
    assert.equal(done.status, "DONE");
    assert.equal(done.startedAt, processing.startedAt);
    assert.ok(done.completedAt);
    await assert.rejects(
      action(f.manager, done, "reopen", { reason: "Needs more work" }),
      denied(403),
    );
  },
);

integration(
  "invalid and repeated transitions reject and completion creates exactly one event",
  async () => {
    const f = await fixture();
    const pending = await create(f);
    await assert.rejects(action(f.employee, pending, "complete"), denied(409));
    const processing = await action(f.employee, pending, "start");
    await assert.rejects(action(f.employee, processing, "start"), denied(409));
    const done = await action(f.employee, processing, "complete");
    await assert.rejects(
      action(f.employee, processing, "complete"),
      denied(409, "TASK_CONFLICT"),
    );
    await assert.rejects(action(f.employee, done, "complete"), denied(409));
    const detail = await getOfficeWorkTask(f.employee, done.id);
    assert.equal(
      detail.activities.filter(
        (event) => event.action === "OFFICE_WORK_COMPLETED",
      ).length,
      1,
    );
    assert.equal(
      detail.activities.filter(
        (event) => event.action === "OFFICE_WORK_STARTED",
      ).length,
      1,
    );
    assert.equal(detail.task.completedAt, done.completedAt);
  },
);

integration(
  "administrative status overrides require and record reasons, while reopening preserves the original start",
  async () => {
    const f = await fixture();
    const pending = await create(f);
    await assert.rejects(
      action(f.admin, pending, "start"),
      denied(400, "OVERRIDE_REASON_REQUIRED"),
    );
    const started = await action(f.admin, pending, "start", {
      reason: "Recorded for the assignee",
    });
    await assert.rejects(
      action(f.admin, started, "complete"),
      denied(400, "OVERRIDE_REASON_REQUIRED"),
    );
    const done = await action(f.admin, started, "complete", {
      reason: "Verified completion in person",
    });
    const reopened = await action(f.manager, done, "reopen", {
      reason: "Add the outstanding figures",
    });
    assert.equal(reopened.status, "PROCESSING");
    assert.equal(reopened.completedAt, null);
    assert.equal(reopened.startedAt, started.startedAt);
    const events = (await getOfficeWorkTask(f.employee, pending.id)).activities;
    assert.equal(
      events.find((event) => event.action === "OFFICE_WORK_STARTED")?.reason,
      "Recorded for the assignee",
    );
    assert.equal(
      events.find((event) => event.action === "OFFICE_WORK_COMPLETED")?.reason,
      "Verified completion in person",
    );
    assert.equal(
      events.find((event) => event.action === "OFFICE_WORK_REOPENED")?.reason,
      "Add the outstanding figures",
    );
  },
);

integration(
  "reassignment confirms workflow reset, preserves history and ownership, and immediately revokes former access",
  async () => {
    const f = await fixture();
    const pending = await create(f);
    const processing = await action(f.employee, pending, "start");
    const done = await action(f.employee, processing, "complete");
    const count = (await getOfficeWorkTask(f.manager, done.id)).activityTotal;
    const unchanged = await action(f.manager, done, "reassign", {
      assigneeId: f.employee.id,
    });
    assert.equal(unchanged.version, done.version);
    assert.equal(unchanged.status, "DONE");
    assert.equal(
      (await getOfficeWorkTask(f.manager, done.id)).activityTotal,
      count,
    );
    await assert.rejects(
      action(f.manager, done, "reassign", { assigneeId: f.otherEmployee.id }),
      denied(409, "REASSIGN_CONFIRMATION_REQUIRED"),
    );
    const reset = await action(f.manager, done, "reassign", {
      assigneeId: f.otherEmployee.id,
      confirmReset: true,
    });
    assert.equal(reset.status, "PENDING");
    assert.equal(reset.startedAt, null);
    assert.equal(reset.completedAt, null);
    assert.equal(reset.createdById, f.manager.id);
    await assert.rejects(getOfficeWorkTask(f.employee, done.id), denied(404));
    assert.equal((await overview(f, f.employee)).dashboard.total, 0);
    const received = await getOfficeWorkTask(f.otherEmployee, done.id);
    const reassignment = received.activities.find(
      (event) => event.action === "OFFICE_WORK_REASSIGNED",
    );
    assert.equal(reassignment?.before?.assigneeId, f.employee.id);
    assert.equal(reassignment?.before?.status, "DONE");
    assert.equal(reassignment?.before?.startedAt, processing.startedAt);
    assert.equal(reassignment?.before?.completedAt, done.completedAt);
    assert.equal(reassignment?.after?.assigneeId, f.otherEmployee.id);
  },
);

integration(
  "only super admins archive, archives remain visible only in scope and all future mutations reject",
  async () => {
    const f = await fixture();
    const pending = await create(f);
    await assert.rejects(action(f.manager, pending, "archive"), denied(403));
    const archived = await action(f.admin, pending, "archive");
    assert.ok(archived.archivedAt);
    const active = await overview(f, f.manager);
    assert.equal(active.total, 0);
    assert.equal(active.dashboard.total, 0);
    const retained = await overview(f, f.employee, { archived: "archived" });
    assert.equal(retained.items[0].id, pending.id);
    assert.equal(retained.dashboard.total, 0);
    assert.equal(
      (await getOfficeWorkTask(f.employee, archived.id)).activityTotal,
      2,
    );
    await assert.rejects(
      getOfficeWorkTask(f.otherEmployee, archived.id),
      denied(404),
    );
    await assert.rejects(
      updateOfficeWorkTask(
        f.admin,
        archived.id,
        editInput(archived, { title: "Archived edit" }),
      ),
      denied(409, "TASK_ARCHIVED"),
    );
    for (const operation of ["start", "complete", "archive"])
      await assert.rejects(
        action(
          f.admin,
          archived,
          operation,
          operation === "archive"
            ? {}
            : {
                reason: "Administrative override",
              },
        ),
        denied(409),
      );
  },
);

integration(
  "stale actor role/status and assignee activity use current database accounts rather than client snapshots",
  async () => {
    const f = await fixture();
    const pending = await create(f);
    await db.user.update({
      where: { id: f.admin.id },
      data: { role: "ADMIN" },
    });
    await assert.rejects(overview(f, f.admin), denied(403));
    await assert.rejects(create(f, f.admin), denied(403));
    await db.user.update({
      where: { id: f.manager.id },
      data: { status: "INACTIVE" },
    });
    await assert.rejects(
      updateOfficeWorkTask(f.manager, pending.id, editInput(pending)),
      denied(403),
    );
    await assert.rejects(getOfficeWorkTask(f.manager, pending.id), denied(403));
    await db.user.update({
      where: { id: f.otherEmployee.id },
      data: { status: "INACTIVE" },
    });
    const otherAdmin = await db.user.create({
      data: { email: `${f.key}-backup@example.test`, role: "SUPER_ADMIN" },
    });
    await assert.rejects(
      action(otherAdmin, pending, "reassign", {
        assigneeId: f.otherEmployee.id,
      }),
      denied(400, "INVALID_ASSIGNEE"),
    );
  },
);

integration(
  "concurrent starts and edits reject stale versions and commit one corresponding activity",
  async () => {
    const f = await fixture();
    const pending = await create(f);
    const starts = await Promise.allSettled([
      action(f.employee, pending, "start"),
      action(f.employee, pending, "start"),
    ]);
    assert.equal(
      starts.filter((result) => result.status === "fulfilled").length,
      1,
    );
    assert.ok(
      starts.some(
        (result) =>
          result.status === "rejected" &&
          result.reason instanceof DomainError &&
          result.reason.status === 409,
      ),
    );
    const current = (await getOfficeWorkTask(f.manager, pending.id)).task;
    const edits = await Promise.allSettled([
      updateOfficeWorkTask(
        f.manager,
        current.id,
        editInput(current, { title: `${f.key} first edit` }),
      ),
      updateOfficeWorkTask(
        f.manager,
        current.id,
        editInput(current, { title: `${f.key} second edit` }),
      ),
    ]);
    assert.equal(
      edits.filter((result) => result.status === "fulfilled").length,
      1,
    );
    const detail = await getOfficeWorkTask(f.manager, pending.id);
    assert.equal(detail.task.version, pending.version + 2);
    assert.equal(
      detail.activities.filter(
        (event) => event.action === "OFFICE_WORK_STARTED",
      ).length,
      1,
    );
    assert.equal(
      detail.activities.filter((event) => event.action === "OFFICE_WORK_EDITED")
        .length,
      1,
    );
  },
);

integration(
  "repeated and concurrent create requests are idempotent and a reused key cannot change its payload or creator",
  async () => {
    const f = await fixture();
    const input = {
      title: `${f.key} duplicate-proof report`,
      assigneeId: f.employee.id,
      requestId: randomUUID(),
    };
    const [first, second] = await Promise.all([
      createOfficeWorkTask(f.manager, input),
      createOfficeWorkTask(f.manager, input),
    ]);
    assert.equal(first.id, second.id);
    assert.equal((await overview(f, f.manager)).total, 1);
    assert.equal(
      (await getOfficeWorkTask(f.manager, first.id)).activityTotal,
      1,
    );
    await assert.rejects(
      createOfficeWorkTask(f.manager, {
        ...input,
        title: `${f.key} changed payload`,
      }),
      denied(409, "IDEMPOTENCY_CONFLICT"),
    );
    await assert.rejects(
      createOfficeWorkTask(f.otherManager, input),
      denied(409, "IDEMPOTENCY_CONFLICT"),
    );
  },
);

integration(
  "task changes and audit history roll back atomically when activity insertion fails",
  async () => {
    const f = await fixture();
    const pending = await create(f);
    const trigger = `office_work_test_${randomUUID().replaceAll("-", "")}`;
    await db.$executeRawUnsafe(
      `CREATE FUNCTION ${trigger}() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN IF NEW."resourceId" = '${pending.id}' THEN RAISE EXCEPTION 'forced Office Work activity failure'; END IF; RETURN NEW; END $$`,
    );
    await db.$executeRawUnsafe(
      `CREATE TRIGGER ${trigger} BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION ${trigger}()`,
    );
    try {
      await assert.rejects(
        updateOfficeWorkTask(
          f.manager,
          pending.id,
          editInput(pending, { title: `${f.key} must roll back` }),
        ),
      );
      await assert.rejects(action(f.employee, pending, "start"));
      const after = await getOfficeWorkTask(f.manager, pending.id);
      assert.equal(after.task.title, pending.title);
      assert.equal(after.task.status, "PENDING");
      assert.equal(after.task.startedAt, null);
      assert.equal(after.task.version, pending.version);
      assert.equal(after.activityTotal, 1);
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER ${trigger} ON "AuditLog"`);
      await db.$executeRawUnsafe(`DROP FUNCTION ${trigger}()`);
    }
  },
);

integration(
  "dashboard base filters, list cards, workloads and My Work share consistent database scope",
  async () => {
    const f = await fixture();
    const empty = await overview(f, f.manager);
    assert.equal(empty.dashboard.completionPercent, 0);
    const today = empty.today;
    const yesterday = new Date(
      new Date(`${today}T00:00:00Z`).getTime() - 86400000,
    )
      .toISOString()
      .slice(0, 10);
    const overdue = await create(f, f.manager, f.employee.id, {
      dueDate: yesterday,
      priority: "HIGH",
    });
    await create(f, f.admin, f.otherEmployee.id, {
      title: `${f.key} due today`,
      dueDate: today,
    });
    const progress = await create(f, f.admin, f.manager.id, {
      title: `${f.key} my work`,
      dueDate: yesterday,
      priority: "HIGH",
    });
    await action(f.manager, progress, "start");
    const donePending = await create(f, f.manager, f.employee.id, {
      title: `${f.key} finished`,
      dueDate: yesterday,
    });
    const doneStarted = await action(f.employee, donePending, "start");
    await action(f.employee, doneStarted, "complete");
    await create(f, f.manager, f.employee.id, { title: `${f.key} undated` });
    const archived = await create(f, f.admin, f.employee.id, {
      title: `${f.key} archive`,
      dueDate: yesterday,
    });
    await action(f.admin, archived, "archive");
    const all = await overview(f, f.manager);
    assert.deepEqual(all.dashboard, {
      total: 5,
      pending: 3,
      processing: 1,
      done: 1,
      overdue: 2,
      dueToday: 1,
      highPriority: 2,
      completionPercent: 20,
    });
    assert.equal(
      all.workload.reduce(
        (sum, row) => sum + row.pending + row.processing + row.done,
        0,
      ),
      5,
    );
    assert.equal(
      all.workload.reduce((sum, row) => sum + row.overdue, 0),
      2,
    );
    for (const filter of [
      { status: "DONE" },
      { listFilter: "overdue" },
      { listFilter: "due-today" },
      { listFilter: "high-priority" },
    ]) {
      const selected = await overview(f, f.manager, filter);
      assert.deepEqual(selected.dashboard, all.dashboard);
      assert.ok(selected.items.length < all.items.length);
    }
    const filtered = await overview(f, f.manager, {
      priority: "HIGH",
      assigneeId: f.employee.id,
      createdById: f.manager.id,
      from: yesterday,
      to: today,
    });
    assert.equal(filtered.total, 1);
    assert.equal(filtered.items[0].id, overdue.id);
    assert.equal(filtered.dashboard.total, 1);
    const mine = await overview(f, f.manager, { view: "mine" });
    assert.equal(mine.total, 1);
    assert.equal(mine.dashboard.processing, 1);
    assert.equal(mine.dashboard.overdue, 1);
    assert.equal(mine.dashboard.total, 1);
    const employee = await overview(f, f.employee);
    assert.equal(employee.dashboard.total, 3);
    assert.equal(employee.dashboard.overdue, 1);
    assert.equal(employee.dashboard.done, 1);
    assert.equal(employee.dashboard.dueToday, 0);
    assert.deepEqual(employee.workload, []);
    assert.equal((await overview(f, f.admin)).dashboard.total, 5);
  },
);

integration(
  "search, sorting and pagination stay stable across server-filtered pages",
  async () => {
    const f = await fixture();
    const a = await create(f, f.manager, f.employee.id, {
      title: `${f.key} 50%_report`,
      dueDate: "2026-11-20",
      priority: "LOW",
    });
    const b = await create(f, f.manager, f.employee.id, {
      title: `${f.key} ordinary`,
      dueDate: "2026-11-21",
      priority: "HIGH",
    });
    const c = await create(f, f.manager, f.employee.id, {
      title: `${f.key} no deadline`,
      priority: "MEDIUM",
    });
    const literal = await overview(f, f.manager, { search: `${f.key} 50%_` });
    assert.equal(literal.total, 1);
    assert.equal(literal.items[0].id, a.id);
    const page1 = await overview(f, f.manager, {
      sort: "dueDate",
      page: 1,
      pageSize: 2,
    });
    const page2 = await overview(f, f.manager, {
      sort: "dueDate",
      page: 2,
      pageSize: 2,
    });
    assert.deepEqual(
      page1.items.map((task) => task.id),
      [a.id, b.id],
    );
    assert.deepEqual(
      page2.items.map((task) => task.id),
      [c.id],
    );
    assert.equal(page1.total, 3);
    assert.equal(page2.totalPages, 2);
    assert.equal(page2.page, 2);
    assert.deepEqual(
      (await overview(f, f.manager, { sort: "priority" })).items.map(
        (task) => task.id,
      ),
      [b.id, c.id, a.id],
    );
    const last = await overview(f, f.manager, { page: 999, pageSize: 2 });
    assert.equal(last.page, 2);
    const activity = await getOfficeWorkTask(f.manager, a.id, {
      page: 1,
      pageSize: 1,
    });
    assert.equal(activity.activities.length, 1);
    assert.equal(activity.activityTotal, 1);
  },
);

integration(
  "legacy audit list counts and direct IDs do not bypass Office Work role restrictions",
  async () => {
    const f = await fixture();
    const task = await create(f);
    const activity = await db.auditLog.findFirstOrThrow({
      where: { resource: "OfficeWorkTask", resourceId: task.id },
    });
    const query = driveCostFilterSchema.parse({ q: "OfficeWorkTask" });
    const hidden = await listRecords(f.legacyAdmin, "audit", query);
    assert.equal(hidden.total, 0);
    assert.deepEqual(hidden.items, []);
    await assert.rejects(
      getRecord(f.legacyAdmin, "audit", activity.id),
      denied(404),
    );
    const visible = await listRecords(f.admin, "audit", query);
    assert.ok(visible.total > 0);
    assert.equal(
      ((await getRecord(f.admin, "audit", activity.id)) as { id: string }).id,
      activity.id,
    );
  },
);

integration(
  "concurrent completion records one event and activity pages do not repeat entries",
  async () => {
    const f = await fixture();
    const pending = await create(f);
    const processing = await action(f.employee, pending, "start");
    const completions = await Promise.allSettled([
      action(f.employee, processing, "complete"),
      action(f.employee, processing, "complete"),
    ]);
    assert.equal(
      completions.filter((result) => result.status === "fulfilled").length,
      1,
    );
    const first = await getOfficeWorkTask(f.employee, pending.id, {
      page: 1,
      pageSize: 2,
    });
    const second = await getOfficeWorkTask(f.employee, pending.id, {
      page: 2,
      pageSize: 2,
    });
    assert.equal(first.activityTotal, 3);
    assert.equal(second.activityTotal, 3);
    assert.equal(first.activities.length, 2);
    assert.equal(second.activities.length, 1);
    assert.equal(
      new Set(
        [...first.activities, ...second.activities].map((event) => event.id),
      ).size,
      3,
    );
    assert.equal(first.activities[0].action, "OFFICE_WORK_COMPLETED");
    assert.equal(second.activities[0].action, "OFFICE_WORK_CREATED");
    assert.ok(first.task.completedAt);
    assert.equal(first.task.startedAt, processing.startedAt);
  },
);

integration(
  "edits preserve omitted optional fields and clear only explicit null values",
  async () => {
    const f = await fixture();
    const initial = await create(f, f.manager, f.employee.id, {
      description: "Retain these instructions",
      dueDate: "2026-12-01",
    });
    const edited = await updateOfficeWorkTask(f.manager, initial.id, {
      title: `${f.key} updated title`,
      priority: "HIGH",
      expectedVersion: initial.version,
    });
    assert.equal(edited.description, initial.description);
    assert.equal(edited.dueDate, initial.dueDate);
    const cleared = await updateOfficeWorkTask(f.manager, edited.id, {
      title: edited.title,
      priority: edited.priority,
      description: null,
      dueDate: null,
      expectedVersion: edited.version,
    });
    assert.equal(cleared.description, null);
    assert.equal(cleared.dueDate, null);
  },
);

integration(
  "processing reassignment requires reset confirmation and a manager cannot reopen another creator's completed task",
  async () => {
    const f = await fixture();
    const initial = await create(f);
    const processing = await action(f.employee, initial, "start");
    await assert.rejects(
      action(f.manager, processing, "reassign", {
        assigneeId: f.otherEmployee.id,
      }),
      denied(409, "REASSIGN_CONFIRMATION_REQUIRED"),
    );
    const reassigned = await action(f.manager, processing, "reassign", {
      assigneeId: f.otherEmployee.id,
      confirmReset: true,
    });
    assert.equal(reassigned.status, "PENDING");
    assert.equal(reassigned.startedAt, null);
    assert.equal(reassigned.completedAt, null);
    const otherCreator = await create(f, f.admin, f.employee.id);
    const otherProcessing = await action(f.employee, otherCreator, "start");
    const done = await action(f.employee, otherProcessing, "complete");
    await assert.rejects(
      action(f.manager, done, "reopen", { reason: "Unauthorized reopen" }),
      denied(403),
    );
  },
);

integration(
  "dashboard aggregate dates honor a Dhaka business-day boundary",
  async (t) => {
    const f = await fixture();
    t.mock.timers.enable({
      apis: ["Date"],
      now: Date.parse("2026-11-20T18:15:00.000Z"),
    });
    await create(f, f.manager, f.employee.id, {
      dueDate: "2026-11-20",
      title: `${f.key} prior business day`,
    });
    await create(f, f.manager, f.employee.id, {
      dueDate: "2026-11-21",
      title: `${f.key} current business day`,
    });
    const result = await overview(f, f.employee);
    assert.equal(result.timezone, "Asia/Dhaka");
    assert.equal(result.today, "2026-11-21");
    assert.equal(result.dashboard.overdue, 1);
    assert.equal(result.dashboard.dueToday, 1);
    assert.deepEqual(result.items.map((task) => task.dueDate).sort(), [
      "2026-11-20",
      "2026-11-21",
    ]);
  },
);

integration(
  "creation rolls back the task and idempotency key when initial activity insertion fails",
  async () => {
    const f = await fixture();
    const trigger = `office_work_test_${randomUUID().replaceAll("-", "")}`;
    await db.$executeRawUnsafe(
      `CREATE FUNCTION ${trigger}() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN IF NEW.resource = 'OfficeWorkTask' AND NEW."newState"->>'title' = '${f.key} failed creation' THEN RAISE EXCEPTION 'forced Office Work create failure'; END IF; RETURN NEW; END $$`,
    );
    await db.$executeRawUnsafe(
      `CREATE TRIGGER ${trigger} BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION ${trigger}()`,
    );
    const input = {
      title: `${f.key} failed creation`,
      assigneeId: f.employee.id,
      requestId: randomUUID(),
    };
    try {
      await assert.rejects(createOfficeWorkTask(f.manager, input));
      assert.equal((await overview(f, f.manager)).total, 0);
      assert.equal(
        await db.officeWorkTask.count({
          where: { requestId: input.requestId },
        }),
        0,
      );
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER ${trigger} ON "AuditLog"`);
      await db.$executeRawUnsafe(`DROP FUNCTION ${trigger}()`);
    }
    const retried = await createOfficeWorkTask(f.manager, input);
    assert.equal(
      (await getOfficeWorkTask(f.manager, retried.id)).activityTotal,
      1,
    );
  },
);

integration(
  "existing account deletion detaches archived task identities while preserving facts and redacting history",
  async () => {
    const f = await fixture();
    const pending = await create(f);
    const processing = await action(f.employee, pending, "start");
    const done = await action(f.employee, processing, "complete");
    const archived = await action(f.admin, done, "archive");
    const before = await getOfficeWorkTask(f.admin, archived.id);
    for (const user of [f.employee, f.manager]) {
      await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${f.admin.id} FOR SHARE`;
        await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${user.id} FOR UPDATE`;
        await deleteIdentity(tx, f.admin, user.id, undefined, {
          id: user.id,
          name: user.name,
        });
      });
    }
    const retained = await getOfficeWorkTask(f.admin, archived.id);
    assert.equal(retained.task.assigneeId, null);
    assert.equal(retained.task.createdById, null);
    assert.equal(retained.task.version, archived.version);
    assert.equal(retained.task.status, "DONE");
    assert.equal(retained.task.startedAt, archived.startedAt);
    assert.equal(retained.task.completedAt, archived.completedAt);
    assert.equal(retained.task.archivedAt, archived.archivedAt);
    assert.equal(retained.activityTotal, before.activityTotal);
    const history = JSON.stringify(retained.activities);
    assert.ok(!history.includes(f.employee.id));
    assert.ok(!history.includes(f.employee.name!));
    assert.ok(!history.includes(f.manager.id));
    assert.ok(history.includes("deleted info"));
    assert.equal(
      retained.activities.filter((event) => event.actor === null).length,
      3,
    );
  },
);
