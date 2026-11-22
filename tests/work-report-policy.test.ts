import assert from "node:assert/strict";
import { test } from "node:test";
import { DomainError } from "../src/lib/errors";
import {
  authorizeReportOwnership,
  authorizeWorkReport,
  canAccessWorkReport,
  reportPermissions,
  visibilityWhere,
} from "../src/modules/work-report/permissions";
import {
  todayInTimezone,
  workReportConflict,
  workReportTimezone,
} from "../src/modules/work-report/policy";

const roles = ["SUPER_ADMIN", "MANAGE_DRIVER", "EMPLOYEE"] as const;
const forbidden = (error: unknown) =>
  error instanceof DomainError && error.status === 403;

for (const role of roles) {
  test(`${role} can read the same shared non-deleted scope and manage only their own report`, () => {
    const actor = { id: "viewer", role, status: "ACTIVE" };
    assert.equal(canAccessWorkReport(role), true);
    authorizeWorkReport(actor);
    assert.deepEqual(visibilityWhere(actor), { deletedAt: null });
    assert.deepEqual(
      reportPermissions(actor, { authorId: actor.id, deletedAt: null }),
      { canEdit: true, canDelete: true },
    );
    authorizeReportOwnership(actor, { authorId: actor.id, deletedAt: null });
    for (const authorId of [
      "employee-author",
      "manager-author",
      "super-admin-author",
      null,
    ]) {
      assert.deepEqual(
        reportPermissions(actor, { authorId, deletedAt: null }),
        { canEdit: false, canDelete: false },
      );
      assert.throws(
        () => authorizeReportOwnership(actor, { authorId, deletedAt: null }),
        forbidden,
      );
    }
    assert.deepEqual(
      reportPermissions(actor, { authorId: actor.id, deletedAt: new Date() }),
      { canEdit: false, canDelete: false },
    );
    assert.throws(
      () =>
        authorizeReportOwnership(actor, {
          authorId: actor.id,
          deletedAt: new Date(),
        }),
      forbidden,
    );
  });
}

for (const role of ["ADMIN", "manager_driver", "MANAGER", "unknown", ""]) {
  test(`the role ${JSON.stringify(role)} cannot inherit Work Report access`, () => {
    const actor = { id: "viewer", role };
    assert.equal(canAccessWorkReport(role), false);
    assert.throws(() => authorizeWorkReport(actor), forbidden);
    assert.throws(() => visibilityWhere(actor), forbidden);
    assert.throws(
      () => reportPermissions(actor, { authorId: actor.id, deletedAt: null }),
      forbidden,
    );
  });
}

test("inactive, suspended and missing actors are denied regardless of role", () => {
  for (const role of roles) {
    for (const status of ["INACTIVE", "SUSPENDED"])
      assert.throws(
        () => authorizeWorkReport({ id: "viewer", role, status }),
        forbidden,
      );
    assert.throws(() => authorizeWorkReport({ id: "", role }), forbidden);
  }
});

test("business date follows a Dhaka midnight boundary rather than browser or UTC date", () => {
  const midnight = new Date("2026-11-21T18:00:00.000Z");
  assert.equal(todayInTimezone("Asia/Dhaka", midnight), "2026-11-22");
  assert.equal(todayInTimezone("UTC", midnight), "2026-11-21");
  assert.equal(todayInTimezone("America/Los_Angeles", midnight), "2026-11-21");
  assert.equal(
    todayInTimezone("Asia/Dhaka", new Date(midnight.getTime() - 1)),
    "2026-11-21",
  );
});

test("timezone configuration uses the existing business-timezone fallbacks and rejects invalid values", () => {
  const names = [
    "WORK_REPORT_TIMEZONE",
    "OFFICE_WORK_TIMEZONE",
    "DAILY_EXPENSES_TIMEZONE",
  ] as const;
  const saved = Object.fromEntries(
    names.map((name) => [name, process.env[name]]),
  );
  try {
    for (const name of names) delete process.env[name];
    assert.equal(workReportTimezone(), "Asia/Dhaka");
    process.env.DAILY_EXPENSES_TIMEZONE = "Asia/Singapore";
    assert.equal(workReportTimezone(), "Asia/Singapore");
    process.env.OFFICE_WORK_TIMEZONE = "Europe/London";
    assert.equal(workReportTimezone(), "Europe/London");
    process.env.WORK_REPORT_TIMEZONE = "America/New_York";
    assert.equal(workReportTimezone(), "America/New_York");
    process.env.WORK_REPORT_TIMEZONE = "invalid/timezone";
    assert.throws(workReportTimezone, /Invalid Work Report business timezone/);
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
});

test("stale-write conflicts explicitly offer refresh rather than silent overwrite", () => {
  const conflict = workReportConflict();
  assert.equal(conflict.status, 409);
  assert.equal(conflict.code, "WORK_REPORT_CONFLICT");
  assert.match(conflict.message, /Refresh/);
});
