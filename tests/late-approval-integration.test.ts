import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Role } from "@prisma/client";
import { db } from "@/lib/db";
import {
  saveLateReason,
  employeeDashboard,
  recordAttendance,
} from "@/modules/attendance/service";
import { reviewLateApproval } from "@/modules/attendance/late-approval";
import { correctAttendance } from "@/modules/management/workflows";
import { getAdminDashboard, getReport } from "@/modules/reports/service";
import type { EmployeeActor } from "@/modules/webauthn/service";

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("late approval PostgreSQL workflow", () => {
  beforeAll(() => {
    if (!databaseUrl || !new URL(databaseUrl).pathname.includes("test"))
      throw new Error("Late approval tests require a disposable test database");
    Object.assign(process.env, {
      DATABASE_URL: databaseUrl,
      NODE_ENV: "test",
      AUTH_SECRET: "late-approval-test-secret-with-at-least-32-characters",
      AUTH_URL: "http://localhost:3000",
      GOOGLE_CLIENT_ID: "test-client",
      GOOGLE_CLIENT_SECRET: "test-secret",
      WEBAUTHN_RP_ID: "localhost",
      WEBAUTHN_RP_NAME: "Attendance tests",
      WEBAUTHN_ORIGIN: "http://localhost:3000",
      TRUSTED_PROXY_MODE: "none",
    });
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  async function reviewer(role: Role = "ADMIN") {
    return db.user.create({
      data: {
        name: `Late approval ${role}`,
        email: `late-review-${randomUUID()}@example.test`,
        role,
      },
      select: { id: true, role: true },
    });
  }

  async function fixture(role: Role = "EMPLOYEE", daysAgo = 0) {
    const suffix = randomUUID();
    const day = new Date(Date.now() - daysAgo * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const office = await db.office.create({
      data: {
        name: `Late approval ${suffix}`,
        address: "Test office",
        latitude: 0,
        longitude: 0,
        timezone: "UTC",
        weekendDays: [],
        requireWebAuthn: false,
        requireGeofence: false,
        requireOfficeNetwork: false,
      },
    });
    const shift = await db.shift.create({
      data: {
        name: `Late approval ${suffix}`,
        startTime: "08:30",
        endTime: "17:00",
        graceMinutes: 15,
        timezone: "UTC",
      },
    });
    const user = await db.user.create({
      data: {
        email: `late-employee-${suffix}@example.test`,
        name: `Late employee ${suffix}`,
        googleAccountId: suffix,
        role,
        employee: {
          create: {
            employeeCode: suffix,
            officeId: office.id,
            joinedAt: new Date("2020-01-01T00:00:00Z"),
            shifts: {
              create: {
                shiftId: shift.id,
                startDate: new Date("2020-01-01T00:00:00Z"),
              },
            },
          },
        },
      },
      include: { employee: true },
    });
    const session = await db.session.create({
      data: {
        userId: user.id,
        sessionToken: randomUUID(),
        expires: new Date(Date.now() + 3_600_000),
      },
    });
    const actor: EmployeeActor = {
      ...user,
      employee: user.employee!,
      sessionId: session.id,
    };
    const attendance = await db.attendance.create({
      data: {
        employeeId: actor.employee.id,
        officeId: office.id,
        shiftId: shift.id,
        attendanceDate: new Date(`${day}T00:00:00Z`),
        scheduledStartAt: new Date(`${day}T08:30:00Z`),
        scheduledEndAt: new Date(`${day}T17:00:00Z`),
        checkInAt: new Date(`${day}T09:00:00Z`),
        checkOutAt: new Date(`${day}T17:30:00Z`),
        status: "LATE",
        lateMinutes: 30,
        workedMinutes: 510,
        // A legacy stored value must be corrected at the canonical read boundary.
        overtimeMinutes: 30,
      },
    });
    const input = {
      attendanceId: attendance.id,
      reason: "  Train service was delayed.  ",
      requestApproval: true,
    };
    return { actor, attendance, input, day };
  }

  async function submit(value: Awaited<ReturnType<typeof fixture>>) {
    await saveLateReason(value.actor, value.input);
    return db.lateApprovalRequest.findUniqueOrThrow({
      where: { attendanceId: value.attendance.id },
    });
  }

  async function report(
    actor: Awaited<ReturnType<typeof reviewer>>,
    value: Awaited<ReturnType<typeof fixture>>,
    status?: "LATE",
  ) {
    const result = await getReport(actor, {
      employeeId: value.actor.employee.id,
      from: value.day,
      to: value.day,
      page: 1,
      pageSize: 25,
      format: "json",
      ...(status ? { status } : {}),
    });
    if (!("items" in result)) throw new Error("Expected JSON report");
    return result;
  }

  it("stores one pending request with server-owned snapshots and allows identical retries", async () => {
    const value = await fixture();
    const request = await submit(value);
    await saveLateReason(value.actor, value.input);
    expect(request).toMatchObject({
      attendanceId: value.attendance.id,
      status: "PENDING",
      reason: "Train service was delayed.",
      checkInAt: value.attendance.checkInAt,
      scheduledStartAt: value.attendance.scheduledStartAt,
      lateMinutes: 30,
      reviewedAt: null,
    });
    expect(request.requestedAt).toBeInstanceOf(Date);
    expect(
      await db.lateApprovalRequest.count({
        where: { attendanceId: value.attendance.id },
      }),
    ).toBe(1);
    expect(
      await db.attendance.count({
        where: { employeeId: value.actor.employee.id },
      }),
    ).toBe(1);
  });

  it("supports opting into approval after the same reason was already saved", async () => {
    const value = await fixture();
    await saveLateReason(value.actor, {
      ...value.input,
      requestApproval: false,
    });
    expect(
      await db.lateApprovalRequest.count({
        where: { attendanceId: value.attendance.id },
      }),
    ).toBe(0);
    await submit(value);
    expect(
      await db.lateApprovalRequest.count({
        where: { attendanceId: value.attendance.id },
      }),
    ).toBe(1);
  });

  it("persists zero overtime when an approved late arrival works only enough after hours to offset lateness", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-09-23T09:00:00Z"));
      const value = await fixture();
      // Start with an empty attendance day to exercise the actual verification pipeline.
      await db.attendance.delete({ where: { id: value.attendance.id } });
      await db.session.update({
        where: { id: value.actor.sessionId },
        data: { expires: new Date("2026-09-24T00:00:00Z") },
      });
      const checkIn = await recordAttendance(
        value.actor,
        "CHECK_IN",
        {},
        new Headers(),
      );
      expect(checkIn.lateMinutes).toBe(30);
      await saveLateReason(value.actor, {
        ...value.input,
        attendanceId: checkIn.id,
      });
      const request = await db.lateApprovalRequest.findUniqueOrThrow({
        where: { attendanceId: checkIn.id },
      });
      await reviewLateApproval(await reviewer(), request.id, {
        status: "APPROVED",
      });
      vi.setSystemTime(new Date("2026-09-23T17:30:00Z"));
      const checkOut = await recordAttendance(
        value.actor,
        "CHECK_OUT",
        {},
        new Headers(),
      );
      expect(checkOut).toMatchObject({
        status: "PRESENT",
        actualStatus: "LATE",
        lateMinutes: 30,
        effectiveLateMinutes: 0,
        overtimeMinutes: 0,
        workedMinutes: 510,
        checkInAt: new Date("2026-09-23T09:00:00Z"),
      });
      expect(
        await db.attendance.findUniqueOrThrow({ where: { id: checkIn.id } }),
      ).toMatchObject({
        status: "LATE",
        lateMinutes: 30,
        overtimeMinutes: 0,
        checkInAt: new Date("2026-09-23T09:00:00Z"),
        checkOutAt: new Date("2026-09-23T17:30:00Z"),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("prevents concurrent submissions from creating duplicate requests", async () => {
    const value = await fixture();
    const outcomes = await Promise.allSettled([
      saveLateReason(value.actor, value.input),
      saveLateReason(value.actor, value.input),
    ]);
    expect(outcomes.some((result) => result.status === "fulfilled")).toBe(true);
    expect(
      await db.lateApprovalRequest.count({
        where: { attendanceId: value.attendance.id },
      }),
    ).toBe(1);
  });

  it("keeps unrequested, pending and rejected attendance penalized in reports", async () => {
    const value = await fixture();
    const admin = await reviewer();
    for (const status of [null, "PENDING", "REJECTED"] as const) {
      if (status === "PENDING") await submit(value);
      if (status === "REJECTED") {
        const request = await db.lateApprovalRequest.findUniqueOrThrow({
          where: { attendanceId: value.attendance.id },
        });
        await reviewLateApproval(admin, request.id, {
          status: "REJECTED",
          reviewNote: "The delay does not qualify for an excuse.",
        });
      }
      const result = await report(admin, value, "LATE");
      expect(result.total).toBe(1);
      expect(result.items[0]).toMatchObject({
        status: "LATE",
        actualStatus: "LATE",
        lateMinutes: 30,
        effectiveLateMinutes: 30,
        lateApprovalStatus: status,
        isExcusedLate: false,
        overtimeMinutes: 0,
      });
    }
  });

  it.each(["ADMIN", "SUPER_ADMIN"] as const)(
    "%s approval excuses reports and dashboards without changing arrival or generating overtime",
    async (role) => {
      const value = await fixture();
      const admin = await reviewer(role);
      const request = await submit(value);
      const now = new Date(`${value.day}T12:00:00Z`);
      const before = await getAdminDashboard(admin, now);
      await reviewLateApproval(admin, request.id, {
        status: "APPROVED",
        reviewNote: "Transit disruption verified.",
      });
      const stored = await db.attendance.findUniqueOrThrow({
        where: { id: value.attendance.id },
      });
      expect(stored.checkInAt).toEqual(value.attendance.checkInAt);
      expect(stored.checkOutAt).toEqual(value.attendance.checkOutAt);
      expect(stored.lateMinutes).toBe(30);
      expect(stored.status).toBe("LATE");
      const result = await report(admin, value);
      expect(result.items[0]).toMatchObject({
        status: "PRESENT",
        actualStatus: "LATE",
        lateMinutes: 30,
        effectiveLateMinutes: 0,
        lateApprovalStatus: "APPROVED",
        isExcusedLate: true,
        overtimeMinutes: 0,
      });
      expect(result.summary.overtimeMinutes).toBe(0);
      expect((await report(admin, value, "LATE")).total).toBe(0);
      expect((await getAdminDashboard(admin, now)).lateToday).toBe(
        before.lateToday - 1,
      );
      const dashboard = await employeeDashboard(value.actor, new Headers());
      expect(
        dashboard.recent.find((record) => record.id === stored.id),
      ).toMatchObject({
        checkInAt: value.attendance.checkInAt,
        effectiveLateMinutes: 0,
        overtimeMinutes: 0,
      });
      expect(
        await db.lateApprovalRequest.findUniqueOrThrow({
          where: { id: request.id },
        }),
      ).toMatchObject({
        status: "APPROVED",
        requestedAt: request.requestedAt,
        reviewedAt: expect.any(Date),
        reviewedById: admin.id,
        reviewNote: "Transit disruption verified.",
      });
    },
  );

  it("allows employees to submit only for their own attendance and rejects status injection", async () => {
    const owner = await fixture();
    const other = await fixture();
    await expect(
      saveLateReason(other.actor, owner.input),
    ).rejects.toMatchObject({
      code: "ATTENDANCE_NOT_FOUND",
    });
    await expect(
      saveLateReason(owner.actor, {
        ...owner.input,
        status: "APPROVED",
      } as typeof owner.input),
    ).rejects.toMatchObject({ name: "ZodError" });
    expect(
      await db.lateApprovalRequest.count({
        where: { attendanceId: owner.attendance.id },
      }),
    ).toBe(0);
  });

  it.each(["EMPLOYEE", "MANAGE_DRIVER"] as const)(
    "prevents %s from reviewing",
    async (role) => {
      const value = await fixture();
      const request = await submit(value);
      const actor = await reviewer(role);
      await expect(
        reviewLateApproval(actor, request.id, { status: "APPROVED" }),
      ).rejects.toMatchObject({ status: 403 });
      expect(
        (
          await db.lateApprovalRequest.findUniqueOrThrow({
            where: { id: request.id },
          })
        ).status,
      ).toBe("PENDING");
    },
  );

  it.each(["demoted", "inactive"] as const)(
    "rejects a stale actor after the reviewer is %s",
    async (change) => {
      const value = await fixture();
      const request = await submit(value);
      const admin = await reviewer();
      await db.user.update({
        where: { id: admin.id },
        data:
          change === "demoted" ? { role: "EMPLOYEE" } : { status: "INACTIVE" },
      });
      await expect(
        reviewLateApproval(admin, request.id, { status: "APPROVED" }),
      ).rejects.toMatchObject({ status: 403 });
    },
  );

  it("prevents administrators from approving their own attendance", async () => {
    const value = await fixture("ADMIN");
    const request = await submit(value);
    await expect(
      reviewLateApproval(value.actor, request.id, { status: "APPROVED" }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("finalizes exactly once when approval and rejection race and preserves the winning audit", async () => {
    const value = await fixture();
    const request = await submit(value);
    const approve = await reviewer();
    const reject = await reviewer("SUPER_ADMIN");
    const results = await Promise.allSettled([
      reviewLateApproval(approve, request.id, {
        status: "APPROVED",
        reviewNote: "Approved once",
      }),
      reviewLateApproval(reject, request.id, {
        status: "REJECTED",
        reviewNote: "Rejected once",
      }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    const finalized = await db.lateApprovalRequest.findUniqueOrThrow({
      where: { id: request.id },
    });
    expect(["APPROVED", "REJECTED"]).toContain(finalized.status);
    expect(finalized.reviewedAt).toBeInstanceOf(Date);
    expect(finalized.reviewedById).toBe(
      finalized.status === "APPROVED" ? approve.id : reject.id,
    );
    expect(finalized.reviewNote).toBe(
      finalized.status === "APPROVED" ? "Approved once" : "Rejected once",
    );
    await expect(
      reviewLateApproval(approve, request.id, { status: "APPROVED" }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      await db.lateApprovalRequest.findUniqueOrThrow({
        where: { id: request.id },
      }),
    ).toEqual(finalized);
    expect(
      await db.auditLog.count({
        where: {
          resourceId: request.id,
          action: { in: ["LATE_APPROVAL_APPROVED", "LATE_APPROVAL_REJECTED"] },
        },
      }),
    ).toBe(1);
  });

  it("rejects approval if an audited correction changed the arrival snapshot", async () => {
    const value = await fixture("EMPLOYEE", 1);
    const request = await submit(value);
    const admin = await reviewer("SUPER_ADMIN");
    await correctAttendance(admin, value.attendance.id, {
      checkInAt: `${value.day}T09:10:00.000Z`,
      reason: "Corrected the verified arrival time before review.",
    });
    await expect(
      reviewLateApproval(admin, request.id, { status: "APPROVED" }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      (
        await db.lateApprovalRequest.findUniqueOrThrow({
          where: { id: request.id },
        })
      ).status,
    ).toBe("PENDING");
  });
});
