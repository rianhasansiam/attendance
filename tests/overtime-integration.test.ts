import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { Prisma } from "@prisma/client";
import { db } from "../src/lib/db";
import { DomainError } from "../src/lib/errors";
import {
  employeeDashboard,
  previewCheckout,
  recordAttendance,
} from "../src/modules/attendance/service";
import {
  listOvertimeRequests,
  reviewOvertimeRequest,
} from "../src/modules/attendance/overtime-approval";
import { correctAttendance } from "../src/modules/management/workflows";
import { deleteIdentity } from "../src/modules/management/delete-identity";
import { reportFilterSchema } from "../src/modules/management/validation";
import { getReport } from "../src/modules/reports/service";
import {
  calculateSalaries,
  salaryStatementForExport,
} from "../src/modules/salary/service";

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
Object.assign(process.env, {
  AUTH_SECRET: "overtime-integration-test-secret-never-for-production",
  AUTH_URL: "https://overtime.invalid",
  GOOGLE_CLIENT_ID: "overtime-test",
  GOOGLE_CLIENT_SECRET: "overtime-test",
  WEBAUTHN_RP_ID: "overtime.invalid",
  WEBAUTHN_ORIGIN: "https://overtime.invalid",
  TRUSTED_PROXY_MODE: "none",
});
const integration = database ? test : test.skip;
const headers = new Headers();
const reason =
  "Completed the monthly inventory and reconciled outstanding orders.";
after(async () => {
  if (database) await db.$disconnect();
});

async function fixture(
  extraMinutes = 75,
  role: "EMPLOYEE" | "SUPER_ADMIN" = "EMPLOYEE",
) {
  const key = randomUUID();
  const now = new Date();
  const scheduledEndAt = new Date(now.getTime() - extraMinutes * 60_000);
  const checkInAt = new Date(scheduledEndAt.getTime() - 510 * 60_000);
  const day = checkInAt.toISOString().slice(0, 10);
  const office = await db.office.create({
    data: {
      name: `Overtime office ${key}`,
      address: "Disposable test fixture",
      latitude: 0,
      longitude: 0,
      timezone: "UTC",
      weekendDays: [],
      requireWebAuthn: false,
      requireApprovedDevice: false,
      requireGeofence: false,
      requireOfficeNetwork: false,
    },
  });
  const department = await db.department.create({
    data: { name: `Overtime department ${key}` },
  });
  const user = await db.user.create({
    data: {
      name: `Overtime employee ${key}`,
      email: `${key}@example.test`,
      role,
      googleAccountId: `google-${key}`,
    },
  });
  const employee = await db.employee.create({
    data: {
      userId: user.id,
      officeId: office.id,
      departmentId: department.id,
      employeeCode: `OT-${key}`,
      joinedAt: new Date("2020-01-01Z"),
    },
  });
  const shift = await db.shift.create({
    data: {
      name: `Overtime shift ${key}`,
      startTime: "08:30",
      endTime: "17:00",
      timezone: "UTC",
    },
  });
  await db.employeeShift.create({
    data: {
      employeeId: employee.id,
      shiftId: shift.id,
      startDate: new Date("2020-01-01Z"),
    },
  });
  const session = await db.session.create({
    data: {
      userId: user.id,
      sessionToken: randomUUID(),
      expires: new Date(now.getTime() + 86_400_000),
    },
  });
  const attendance = await db.attendance.create({
    data: {
      employeeId: employee.id,
      officeId: office.id,
      shiftId: shift.id,
      attendanceDate: new Date(`${day}T00:00:00Z`),
      scheduledStartAt: checkInAt,
      scheduledEndAt,
      checkInAt,
      status: "PRESENT",
    },
  });
  return {
    actor: { ...user, employee, sessionId: session.id },
    attendance,
    department,
    day,
  };
}
async function reviewer(role: "SUPER_ADMIN" | "ADMIN" = "SUPER_ADMIN") {
  return db.user.create({
    data: {
      email: `${randomUUID()}@example.test`,
      name: "Overtime reviewer",
      role,
    },
  });
}
async function complete(f: Awaited<ReturnType<typeof fixture>>) {
  return recordAttendance(
    f.actor,
    "CHECK_OUT",
    { attendanceId: f.attendance.id, overtimeReason: reason },
    headers,
  );
}
async function report(
  f: Awaited<ReturnType<typeof fixture>>,
  actor: Awaited<ReturnType<typeof reviewer>>,
) {
  const result = await getReport(
    actor,
    reportFilterSchema.parse({
      from: f.day,
      to: f.day,
      employeeId: f.actor.employee.id,
      format: "json",
      page: 1,
      pageSize: 25,
    }),
  );
  assert.ok("summary" in result);
  return result;
}

integration(
  "eligible checkout requires reason, validates identity, and atomically creates one pending request",
  async () => {
    const f = await fixture();
    const preview = await previewCheckout(f.actor);
    assert.equal(preview.attendanceId, f.attendance.id);
    assert.equal(preview.eligible, true);
    assert.equal(preview.extraMinutes, 75);
    await assert.rejects(
      recordAttendance(
        f.actor,
        "CHECK_OUT",
        { attendanceId: f.attendance.id },
        headers,
      ),
      (error: unknown) =>
        error instanceof DomainError &&
        error.code === "OVERTIME_REASON_REQUIRED",
    );
    assert.equal(
      (
        await db.attendance.findUniqueOrThrow({
          where: { id: f.attendance.id },
        })
      ).checkOutAt,
      null,
    );
    await assert.rejects(
      recordAttendance(
        f.actor,
        "CHECK_OUT",
        { attendanceId: "different-record", overtimeReason: reason },
        headers,
      ),
      (error: unknown) => error instanceof DomainError && error.status === 409,
    );
    const result = await complete(f);
    assert.equal(result.overtimeRequestStatus, "PENDING");
    assert.equal(result.approvedOvertimeMinutes, 0);
    assert.equal(result.requestedOvertimeMinutes, 75);
    const saved = await db.overtimeRequest.findUniqueOrThrow({
      where: { attendanceId: f.attendance.id },
    });
    assert.equal(saved.reason, reason);
    assert.equal(saved.requestedMinutes, 75);
    assert.ok(saved.checkOutAt > f.attendance.checkInAt!);
    await assert.rejects(complete(f));
    assert.equal(
      await db.overtimeRequest.count({
        where: { attendanceId: f.attendance.id },
      }),
      1,
    );
    const recovered = await employeeDashboard(f.actor, headers);
    const row = recovered.recent.find(
      (record) => record.id === f.attendance.id,
    );
    assert.equal(row?.overtimeRequestStatus, "PENDING");
    assert.equal(row?.approvedOvertimeMinutes, 0);
  },
);

integration("normal checkout below 60 does not create a request", async () => {
  const f = await fixture(59);
  assert.equal((await previewCheckout(f.actor)).eligible, false);
  const result = await recordAttendance(
    f.actor,
    "CHECK_OUT",
    { attendanceId: f.attendance.id },
    headers,
  );
  assert.equal(result.approvedOvertimeMinutes, 0);
  assert.equal(result.overtimeRequestStatus, null);
  assert.equal(
    await db.overtimeRequest.count({
      where: { attendanceId: f.attendance.id },
    }),
    0,
  );
});

integration(
  "server catches threshold crossing after a below-threshold preview",
  async () => {
    const f = await fixture(59);
    assert.equal((await previewCheckout(f.actor)).eligible, false);
    await db.attendance.update({
      where: { id: f.attendance.id },
      data: { scheduledEndAt: new Date(Date.now() - 60 * 60_000) },
    });
    await assert.rejects(
      recordAttendance(
        f.actor,
        "CHECK_OUT",
        { attendanceId: f.attendance.id },
        headers,
      ),
      (error: unknown) =>
        error instanceof DomainError &&
        error.code === "OVERTIME_REASON_REQUIRED",
    );
    assert.equal(
      (
        await db.attendance.findUniqueOrThrow({
          where: { id: f.attendance.id },
        })
      ).checkOutAt,
      null,
    );
  },
);

integration(
  "pending and rejected requests contribute zero, approved requests contribute full duration",
  async () => {
    const f = await fixture();
    const admin = await reviewer();
    await complete(f);
    const request = await db.overtimeRequest.findUniqueOrThrow({
      where: { attendanceId: f.attendance.id },
    });
    assert.equal((await report(f, admin)).summary.overtimeMinutes, 0);
    const approved = await reviewOvertimeRequest(admin, request.id, {
      status: "APPROVED",
    });
    assert.equal(approved.status, "APPROVED");
    assert.equal(approved.reviewedBy?.id, admin.id);
    assert.ok(approved.reviewedAt);
    const result = await report(f, admin);
    assert.equal(result.summary.overtimeMinutes, 75);
    assert.equal(
      result.items.find((row) => row.id === f.attendance.id)
        ?.approvedOvertimeMinutes,
      75,
    );
    await assert.rejects(
      reviewOvertimeRequest(admin, request.id, { status: "REJECTED" }),
    );
    const other = await fixture();
    await complete(other);
    const rejected = await db.overtimeRequest.findUniqueOrThrow({
      where: { attendanceId: other.attendance.id },
    });
    await reviewOvertimeRequest(admin, rejected.id, {
      status: "REJECTED",
      rejectionReason: "Work was not authorized.",
    });
    assert.equal((await report(other, admin)).summary.overtimeMinutes, 0);
    assert.equal(
      (
        await db.overtimeRequest.findUniqueOrThrow({
          where: { id: rejected.id },
        })
      ).rejectionReason,
      "Work was not authorized.",
    );
  },
);

integration(
  "only a current active Super Admin can review, including their own overtime",
  async () => {
    const f = await fixture(75, "SUPER_ADMIN");
    await complete(f);
    const request = await db.overtimeRequest.findUniqueOrThrow({
      where: { attendanceId: f.attendance.id },
    });
    const admin = await reviewer("ADMIN");
    await assert.rejects(
      listOvertimeRequests(admin, {}),
      (error: unknown) => error instanceof DomainError && error.status === 403,
    );
    await assert.rejects(
      reviewOvertimeRequest(admin, request.id, { status: "APPROVED" }),
      (error: unknown) => error instanceof DomainError && error.status === 403,
    );
    const stale = await reviewer();
    await db.user.update({ where: { id: stale.id }, data: { role: "ADMIN" } });
    await assert.rejects(
      reviewOvertimeRequest(stale, request.id, { status: "APPROVED" }),
      (error: unknown) => error instanceof DomainError && error.status === 403,
    );
    await reviewOvertimeRequest(f.actor, request.id, { status: "APPROVED" });
    assert.equal((await report(f, f.actor)).summary.overtimeMinutes, 75);
  },
);

integration(
  "concurrent checkouts and decisions create only one request and one decision",
  async () => {
    const f = await fixture();
    const results = await Promise.allSettled([complete(f), complete(f)]);
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
    assert.equal(
      await db.overtimeRequest.count({
        where: { attendanceId: f.attendance.id },
      }),
      1,
    );
    const request = await db.overtimeRequest.findUniqueOrThrow({
      where: { attendanceId: f.attendance.id },
    });
    const [a, b] = await Promise.all([reviewer(), reviewer()]);
    const reviews = await Promise.allSettled([
      reviewOvertimeRequest(a, request.id, { status: "APPROVED" }),
      reviewOvertimeRequest(b, request.id, { status: "REJECTED" }),
    ]);
    assert.equal(
      reviews.filter((result) => result.status === "fulfilled").length,
      1,
    );
    assert.equal(
      await db.auditLog.count({
        where: {
          resourceId: request.id,
          action: {
            in: [
              "OVERTIME_APPROVED",
              "OVERTIME_REJECTED",
              "OVERTIME_REQUEST_APPROVED",
              "OVERTIME_REQUEST_REJECTED",
            ],
          },
        },
      }),
      1,
    );
  },
);

integration(
  "corrections invalidate approval and stale pending requests can only be rejected",
  async () => {
    const admin = await reviewer();
    for (const approved of [false, true]) {
      const f = await fixture();
      await complete(f);
      const request = await db.overtimeRequest.findUniqueOrThrow({
        where: { attendanceId: f.attendance.id },
      });
      if (approved)
        await reviewOvertimeRequest(admin, request.id, { status: "APPROVED" });
      await correctAttendance(admin, f.attendance.id, {
        checkOutAt: new Date(
          request.checkOutAt.getTime() - 60_000,
        ).toISOString(),
        reason: "Corrected a recorded checkout timestamp.",
      });
      assert.equal((await report(f, admin)).summary.overtimeMinutes, 0);
      const historical = await db.overtimeRequest.findUniqueOrThrow({
        where: { id: request.id },
      });
      assert.equal(historical.status, approved ? "APPROVED" : "PENDING");
      if (!approved) {
        await assert.rejects(
          reviewOvertimeRequest(admin, request.id, { status: "APPROVED" }),
          (error: unknown) =>
            error instanceof DomainError && error.code === "ATTENDANCE_CHANGED",
        );
        await reviewOvertimeRequest(admin, request.id, { status: "REJECTED" });
      }
    }
  },
);

integration(
  "saved overnight/end snapshots survive later assignment changes",
  async () => {
    const f = await fixture();
    await db.shift.update({
      where: { id: f.attendance.shiftId },
      data: { startTime: "22:00", endTime: "06:00" },
    });
    const result = await complete(f);
    assert.equal(result.requestedOvertimeMinutes, 75);
    const request = await db.overtimeRequest.findUniqueOrThrow({
      where: { attendanceId: f.attendance.id },
    });
    assert.equal(
      request.scheduledEndAt.getTime(),
      f.attendance.scheduledEndAt!.getTime(),
    );
  },
);

integration(
  "payroll uses approved credit and invalidates calculation tokens after decisions",
  async () => {
    const f = await fixture();
    const admin = await reviewer();
    await complete(f);
    const period = f.day.slice(0, 7);
    await db.salarySetting.create({
      data: {
        employeeId: f.actor.employee.id,
        effectiveMonth: new Date(`${period}-01T00:00:00Z`),
        revision: 1,
        baseSalary: new Prisma.Decimal(26000),
        overtimeHourlyRate: new Prisma.Decimal(60),
        createdById: admin.id,
      },
    });
    const input = {
      employeeIds: [f.actor.employee.id],
      period,
      from: f.day,
      to: f.day,
    };
    const [pending] = await calculateSalaries(admin, input);
    assert.equal(pending.payableOvertimeMinutes, 0);
    const request = await db.overtimeRequest.findUniqueOrThrow({
      where: { attendanceId: f.attendance.id },
    });
    await reviewOvertimeRequest(admin, request.id, { status: "APPROVED" });
    await assert.rejects(
      salaryStatementForExport(admin, {
        employeeId: f.actor.employee.id,
        period,
        from: f.day,
        to: f.day,
        token: pending.token,
      }),
      (error: unknown) =>
        error instanceof DomainError && error.code === "SALARY_SOURCE_CHANGED",
    );
    const [approved] = await calculateSalaries(admin, input);
    assert.equal(approved.payableOvertimeMinutes, 75);
    assert.equal(approved.overtimeEarnings, "75.00");
    const statement = await salaryStatementForExport(admin, {
      employeeId: f.actor.employee.id,
      period,
      from: f.day,
      to: f.day,
      token: approved.token,
    });
    assert.equal(statement.payableOvertimeMinutes, 75);
  },
);

integration(
  "unknown historical overtime has known zero approved credit and does not block payroll",
  async () => {
    const f = await fixture();
    const admin = await reviewer();
    await db.attendance.update({
      where: { id: f.attendance.id },
      data: {
        checkOutAt: new Date(),
        scheduledEndAt: null,
        overtimeMinutes: null,
        workedMinutes: 585,
      },
    });
    const period = f.day.slice(0, 7);
    await db.salarySetting.create({
      data: {
        employeeId: f.actor.employee.id,
        effectiveMonth: new Date(`${period}-01T00:00:00Z`),
        revision: 1,
        baseSalary: 26000,
        overtimeHourlyRate: 60,
        createdById: admin.id,
      },
    });
    const [calculation] = await calculateSalaries(admin, {
      employeeIds: [f.actor.employee.id],
      period,
      from: f.day,
      to: f.day,
    });
    assert.equal(calculation.payableOvertimeMinutes, 0);
    assert.equal(calculation.summary.unknownOvertimeRecords, 1);
  },
);

integration(
  "request filters and deleted-employee history preserve review boundaries",
  async () => {
    const f = await fixture();
    const admin = await reviewer();
    await complete(f);
    const query = {
      page: 1,
      pageSize: 25,
      status: "PENDING" as const,
      search: f.actor.employee.employeeCode,
      from: f.day,
      to: f.day,
      departmentId: f.department.id,
    };
    const listed = await listOvertimeRequests(admin, query);
    assert.equal(listed.total, 1);
    assert.equal(listed.items[0].attendanceId, f.attendance.id);
    assert.equal(
      (
        await listOvertimeRequests(admin, {
          ...query,
          search: "no-matching-employee",
        })
      ).total,
      0,
    );
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${f.actor.employee.id} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${f.actor.id} FOR UPDATE`;
      await deleteIdentity(tx, admin, f.actor.id, f.actor.employee.id, {});
    });
    const request = await db.overtimeRequest.findUniqueOrThrow({
      where: { attendanceId: f.attendance.id },
    });
    assert.equal(request.status, "PENDING");
    assert.equal(
      (
        await db.attendance.findUniqueOrThrow({
          where: { id: f.attendance.id },
        })
      ).employeeId,
      null,
    );
    await assert.rejects(
      reviewOvertimeRequest(admin, request.id, { status: "APPROVED" }),
      (error: unknown) =>
        error instanceof DomainError && error.code === "EMPLOYEE_DELETED",
    );
  },
);

integration(
  "rejection invalidates a payroll token even when approved credit remains zero",
  async () => {
    const f = await fixture();
    const admin = await reviewer();
    await complete(f);
    const period = f.day.slice(0, 7);
    await db.salarySetting.create({
      data: {
        employeeId: f.actor.employee.id,
        effectiveMonth: new Date(`${period}-01T00:00:00Z`),
        revision: 1,
        baseSalary: 26000,
        overtimeHourlyRate: 60,
        createdById: admin.id,
      },
    });
    const [pending] = await calculateSalaries(admin, {
      employeeIds: [f.actor.employee.id],
      period,
      from: f.day,
      to: f.day,
    });
    const request = await db.overtimeRequest.findUniqueOrThrow({
      where: { attendanceId: f.attendance.id },
    });
    await reviewOvertimeRequest(admin, request.id, { status: "REJECTED" });
    assert.equal((await report(f, admin)).summary.overtimeMinutes, 0);
    await assert.rejects(
      salaryStatementForExport(admin, {
        employeeId: f.actor.employee.id,
        period,
        from: f.day,
        to: f.day,
        token: pending.token,
      }),
      (error: unknown) =>
        error instanceof DomainError && error.code === "SALARY_SOURCE_CHANGED",
    );
  },
);

integration("a request-creation failure rolls checkout back", async () => {
  const f = await fixture();
  await db.$executeRawUnsafe(
    `CREATE FUNCTION overtime_test_reject_request() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.reason = 'forced request creation failure' THEN RAISE EXCEPTION 'test transaction failure'; END IF; RETURN NEW; END $$`,
  );
  await db.$executeRawUnsafe(
    `CREATE TRIGGER overtime_test_reject_request BEFORE INSERT ON "OvertimeRequest" FOR EACH ROW EXECUTE FUNCTION overtime_test_reject_request()`,
  );
  try {
    await assert.rejects(
      recordAttendance(
        f.actor,
        "CHECK_OUT",
        {
          attendanceId: f.attendance.id,
          overtimeReason: "forced request creation failure",
        },
        headers,
      ),
    );
    assert.equal(
      (
        await db.attendance.findUniqueOrThrow({
          where: { id: f.attendance.id },
        })
      ).checkOutAt,
      null,
    );
    assert.equal(
      await db.overtimeRequest.count({
        where: { attendanceId: f.attendance.id },
      }),
      0,
    );
  } finally {
    await db.$executeRawUnsafe(
      'DROP TRIGGER overtime_test_reject_request ON "OvertimeRequest"',
    );
    await db.$executeRawUnsafe("DROP FUNCTION overtime_test_reject_request()");
  }
});
