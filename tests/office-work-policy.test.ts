import assert from "node:assert/strict";
import { test } from "node:test";
import { DomainError } from "../src/lib/errors";
import {
  authorizeOfficeWork,
  canAssignOfficeWorkRole,
  canCreateOfficeWork,
  taskPermissions,
  visibilityWhere,
} from "../src/modules/office-work/permissions";
import {
  isOfficeWorkOverdue,
  todayInTimezone,
  transitionPatch,
} from "../src/modules/office-work/policy";
import type { OfficeWorkStatus } from "../src/modules/office-work/contracts";

const admin = { id: "super-admin", role: "SUPER_ADMIN" };
const manager = { id: "manager", role: "MANAGE_DRIVER" };
const employee = { id: "employee", role: "EMPLOYEE" };
const task = {
  assigneeId: employee.id,
  createdById: manager.id,
  assignee: { role: "EMPLOYEE" },
  status: "PENDING" as OfficeWorkStatus,
  archivedAt: null,
  startedAt: null as Date | null,
  completedAt: null as Date | null,
};
const domainError = (status: number, code?: string) => (error: unknown) =>
  error instanceof DomainError &&
  error.status === status &&
  (!code || error.code === code);

for (const role of ["ADMIN", "manager_driver", "MANAGER", "unknown", ""]) {
  test(`unauthorized role ${JSON.stringify(role)} cannot inherit feature access`, () => {
    assert.throws(
      () => authorizeOfficeWork({ id: "actor", role }),
      domainError(403),
    );
    assert.throws(
      () => visibilityWhere({ id: "actor", role }),
      domainError(403),
    );
    assert.equal(canCreateOfficeWork(role), false);
    assert.equal(canAssignOfficeWorkRole(role, "EMPLOYEE"), false);
  });
}

test("inactive users fail access even if their role is authorized", () => {
  for (const actor of [admin, manager, employee]) {
    for (const status of ["INACTIVE", "SUSPENDED"]) {
      assert.throws(
        () => authorizeOfficeWork({ ...actor, status }),
        domainError(403),
      );
    }
  }
});

test("visibility is global for management and keyed to authenticated user for employees", () => {
  assert.deepEqual(visibilityWhere(admin), {});
  assert.deepEqual(visibilityWhere(manager), {});
  assert.deepEqual(visibilityWhere(employee), { assigneeId: employee.id });
});

test("assignment policy uses existing exact roles with no admin or manager self-assignment loophole", () => {
  for (const role of ["EMPLOYEE", "MANAGE_DRIVER", "SUPER_ADMIN", "ADMIN"]) {
    assert.equal(
      canAssignOfficeWorkRole(admin.role, role),
      ["EMPLOYEE", "MANAGE_DRIVER"].includes(role),
    );
    assert.equal(
      canAssignOfficeWorkRole(manager.role, role),
      role === "EMPLOYEE",
    );
    assert.equal(canAssignOfficeWorkRole(employee.role, role), false);
  }
});

test("global management visibility does not grant management of another creator's task", () => {
  const own = taskPermissions(manager, task);
  assert.equal(own.canEdit, true);
  assert.equal(own.canReassign, true);
  assert.equal(own.canArchive, false);
  assert.equal(
    taskPermissions(manager, { ...task, createdById: admin.id }).canEdit,
    false,
  );
  assert.equal(
    taskPermissions(manager, { ...task, createdById: "another-manager" })
      .canReassign,
    false,
  );
  assert.equal(
    taskPermissions(manager, { ...task, assignee: { role: "MANAGE_DRIVER" } })
      .canEdit,
    false,
  );
});

test("a manager assigned their own work can progress it without gaining management rights", () => {
  const assigned = {
    ...task,
    assigneeId: manager.id,
    assignee: { role: manager.role },
    createdById: admin.id,
  };
  const pending = taskPermissions(manager, assigned);
  assert.equal(pending.canStart, true);
  assert.equal(pending.canEdit, false);
  assert.equal(pending.canReassign, false);
  assert.equal(pending.canReopen, false);
  assert.equal(
    taskPermissions(manager, { ...assigned, status: "PROCESSING" }).canComplete,
    true,
  );
});

test("employee permissions disappear immediately after reassignment and archived tasks expose no writes", () => {
  assert.equal(taskPermissions(employee, task).canStart, true);
  assert.equal(taskPermissions(employee, task).canEdit, false);
  const inaccessible = taskPermissions(employee, {
    ...task,
    assigneeId: "another-employee",
  });
  assert.ok(Object.values(inaccessible).every((value) => value === false));
  for (const actor of [admin, manager, employee]) {
    assert.ok(
      Object.values(
        taskPermissions(actor, { ...task, archivedAt: new Date() }),
      ).every((value) => value === false),
    );
  }
});

test("ordinary lifecycle requires the current assignee and progresses pending to processing to done", () => {
  const startedAt = new Date("2026-11-21T01:00:00Z");
  const completedAt = new Date("2026-11-21T02:00:00Z");
  const started = transitionPatch(
    employee,
    task,
    { action: "start", expectedVersion: 1 },
    startedAt,
  );
  assert.deepEqual(started, { status: "PROCESSING", startedAt });
  const completed = transitionPatch(
    employee,
    { ...task, ...started },
    { action: "complete", expectedVersion: 2 },
    completedAt,
  );
  assert.deepEqual(completed, { status: "DONE", completedAt });
  assert.throws(
    () =>
      transitionPatch(employee, task, {
        action: "complete",
        expectedVersion: 1,
      }),
    domainError(409),
  );
  assert.throws(
    () =>
      transitionPatch(manager, task, { action: "start", expectedVersion: 1 }),
    domainError(403),
  );
  assert.throws(
    () =>
      transitionPatch(
        employee,
        { ...task, ...started },
        { action: "start", expectedVersion: 2 },
      ),
    domainError(409),
  );
});

test("super-admin overrides require a reason and still obey lifecycle order", () => {
  assert.throws(
    () => transitionPatch(admin, task, { action: "start", expectedVersion: 1 }),
    domainError(400, "OVERRIDE_REASON_REQUIRED"),
  );
  assert.throws(
    () =>
      transitionPatch(admin, task, {
        action: "start",
        expectedVersion: 1,
        reason: " ",
      }),
    domainError(400),
  );
  const start = transitionPatch(admin, task, {
    action: "start",
    expectedVersion: 1,
    reason: "Started on behalf of the assignee",
  });
  assert.equal(start.status, "PROCESSING");
  assert.throws(
    () =>
      transitionPatch(admin, task, {
        action: "complete",
        expectedVersion: 1,
        reason: "Administrative override",
      }),
    domainError(409),
  );
});

test("reopening needs management rights and a reason and preserves the original start timestamp", () => {
  const startedAt = new Date("2026-11-21T01:00:00Z");
  const completedAt = new Date("2026-11-21T02:00:00Z");
  const done = { ...task, status: "DONE" as const, startedAt, completedAt };
  assert.deepEqual(
    transitionPatch(manager, done, {
      action: "reopen",
      expectedVersion: 3,
      reason: "Correction required",
    }),
    { status: "PROCESSING", completedAt: null },
  );
  assert.throws(
    () =>
      transitionPatch(employee, done, {
        action: "reopen",
        expectedVersion: 3,
        reason: "Correction required",
      }),
    domainError(403),
  );
  assert.throws(
    () =>
      transitionPatch(manager, done, {
        action: "reopen",
        expectedVersion: 3,
        reason: " ",
      }),
    domainError(400),
  );
  assert.throws(
    () =>
      transitionPatch(
        admin,
        { ...done, archivedAt: new Date() },
        { action: "reopen", expectedVersion: 3, reason: "Correction required" },
      ),
    domainError(409),
  );
});

test("only super admins can archive and archived tasks cannot transition", () => {
  const now = new Date("2026-11-21T01:00:00Z");
  assert.deepEqual(
    transitionPatch(
      admin,
      task,
      { action: "archive", expectedVersion: 1 },
      now,
    ),
    { archivedAt: now },
  );
  for (const actor of [manager, employee]) {
    assert.throws(
      () =>
        transitionPatch(actor, task, { action: "archive", expectedVersion: 1 }),
      domainError(403),
    );
  }
});

test("business date follows configured timezone at midnight boundaries, never browser timezone", () => {
  const instant = new Date("2026-11-20T18:00:00.000Z");
  assert.equal(todayInTimezone("Asia/Dhaka", instant), "2026-11-21");
  assert.equal(todayInTimezone("UTC", instant), "2026-11-20");
  assert.equal(todayInTimezone("America/Los_Angeles", instant), "2026-11-20");
  assert.equal(
    todayInTimezone("Asia/Dhaka", new Date(instant.getTime() - 1)),
    "2026-11-20",
  );
});

test("overdue is derived and excludes today, finished, undated and archived tasks", () => {
  const base = { dueDate: "2026-11-20", status: "PENDING", archivedAt: null };
  assert.equal(isOfficeWorkOverdue(base, "2026-11-21"), true);
  for (const change of [
    { dueDate: "2026-11-21" },
    { dueDate: "2026-11-22" },
    { dueDate: null },
    { status: "DONE" },
    { archivedAt: new Date() },
  ]) {
    assert.equal(
      isOfficeWorkOverdue({ ...base, ...change }, "2026-11-21"),
      false,
    );
  }
});
