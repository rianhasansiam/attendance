import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createEmployee, updateEmployee } from "@/modules/employees/service";
import {
  removeCatalogRecord,
  saveAssignment,
  saveDriveCost,
  saveHoliday,
} from "@/modules/management/catalog";
import {
  createAttendanceCorrection,
  createLeave,
  reviewLeave,
  updateDevice,
  updateUser,
  correctAttendance,
} from "@/modules/management/workflows";
import {
  getAdminDashboard,
  getReport,
  reportRecords,
} from "@/modules/reports/service";
import type { Actor } from "@/modules/management/permissions";

const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("management PostgreSQL transactions", () => {
  let admin: Actor;
  let superAdmin: Actor;
  let officeId: string;
  let shiftId: string;
  const tag = randomUUID().slice(0, 8);

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    admin = await db.user.create({
      data: {
        name: "Test administrator",
        email: `admin-${tag}@example.test`,
        role: "ADMIN",
      },
      select: { id: true, role: true },
    });
    superAdmin = await db.user.create({
      data: {
        name: "Test super administrator",
        email: `super-${tag}@example.test`,
        role: "SUPER_ADMIN",
      },
      select: { id: true, role: true },
    });
    const office = await db.office.create({
      data: {
        name: `Management ${tag}`,
        address: "Test office",
        latitude: 0,
        longitude: 0,
        timezone: "UTC",
      },
    });
    officeId = office.id;
    shiftId = (
      await db.shift.create({
        data: {
          name: `Day ${tag}`,
          startTime: "09:00",
          endTime: "17:00",
          timezone: "UTC",
        },
      })
    ).id;
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  async function employee(name = "Test Employee") {
    const unique = randomUUID().slice(0, 8);
    const value = await createEmployee(admin, {
      name,
      email: `employee-${unique}@example.test`,
      employeeCode: `M-${unique}`,
      officeId,
      status: "ACTIVE",
    });
    await db.employee.update({
      where: { id: value.id },
      data: { joinedAt: new Date("2024-01-01T00:00:00Z") },
    });
    return value;
  }

  it("blocks admin modification of an elevated employee and admin role management", async () => {
    const target = await employee();
    await db.user.update({
      where: { id: target.userId },
      data: { role: "SUPER_ADMIN" },
    });
    await expect(
      updateEmployee(admin, target.id, { status: "INACTIVE" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      updateUser(admin, target.userId, { role: "EMPLOYEE" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      updateUser(superAdmin, superAdmin.id, { status: "INACTIVE" }),
    ).rejects.toMatchObject({ code: "SELF_ACCESS_CHANGE" });
    const device = await db.webAuthnCredential.create({
      data: {
        employeeId: target.id,
        name: "Privileged device",
        credentialId: randomUUID(),
        publicKey: new Uint8Array([1]),
        transports: [],
        deviceType: "singleDevice",
      },
    });
    await expect(
      updateDevice(admin, device.id, { approved: true }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      updateDevice(admin, device.id, { revoked: true }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("revokes identity credentials, OAuth links and sessions when authorized Google email changes", async () => {
    const target = await employee();
    await db.user.update({
      where: { id: target.userId },
      data: { googleAccountId: `google-${randomUUID()}` },
    });
    await db.session.create({
      data: {
        userId: target.userId,
        sessionToken: randomUUID(),
        expires: new Date("2099-01-01"),
      },
    });
    await db.account.create({
      data: {
        userId: target.userId,
        type: "oauth",
        provider: "google",
        providerAccountId: randomUUID(),
      },
    });
    const device = await db.webAuthnCredential.create({
      data: {
        employeeId: target.id,
        name: "Device",
        credentialId: randomUUID(),
        publicKey: new Uint8Array([1, 2]),
        transports: [],
        deviceType: "singleDevice",
        approved: true,
      },
    });
    await updateEmployee(admin, target.id, {
      email: `replacement-${randomUUID()}@example.test`,
    });
    expect(await db.session.count({ where: { userId: target.userId } })).toBe(
      0,
    );
    expect(await db.account.count({ where: { userId: target.userId } })).toBe(
      0,
    );
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: target.userId } }))
        .googleAccountId,
    ).toBeNull();
    expect(
      (
        await db.webAuthnCredential.findUniqueOrThrow({
          where: { id: device.id },
        })
      ).revokedAt,
    ).not.toBeNull();
    await expect(
      updateDevice(admin, device.id, { approved: true }),
    ).rejects.toMatchObject({ code: "DEVICE_REVOKED" });
  });

  it("prevents two concurrent overlapping shift assignments", async () => {
    const target = await employee();
    const results = await Promise.allSettled([
      saveAssignment(admin, {
        employeeId: target.id,
        shiftId,
        startDate: "2025-01-01",
        endDate: "2025-01-31",
      }),
      saveAssignment(admin, {
        employeeId: target.id,
        shiftId,
        startDate: "2025-01-15",
        endDate: "2025-02-15",
      }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      await db.employeeShift.count({ where: { employeeId: target.id } }),
    ).toBe(1);
  });

  it("prevents overlapping leave requests and repeat leave approval", async () => {
    const target = await employee();
    const results = await Promise.allSettled([
      createLeave(target.id, {
        startDate: "2025-02-10",
        endDate: "2025-02-12",
        reason: "Family event",
      }),
      createLeave(target.id, {
        startDate: "2025-02-11",
        endDate: "2025-02-14",
        reason: "Family event",
      }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const leave = await db.leave.findFirstOrThrow({
      where: { employeeId: target.id },
    });
    await expect(
      reviewLeave({ id: target.userId, role: "ADMIN" }, leave.id, {
        status: "APPROVED",
      }),
    ).rejects.toMatchObject({ code: "SELF_APPROVAL" });
    await reviewLeave(admin, leave.id, { status: "APPROVED" });
    await expect(
      reviewLeave(admin, leave.id, { status: "REJECTED" }),
    ).rejects.toMatchObject({ code: "LEAVE_ALREADY_REVIEWED" });
  });

  it("persists exact drive costs and audits recalculation and deletion", async () => {
    const created = await saveDriveCost(admin, {
      date: "2026-09-21",
      destinationFrom: "Dhaka office",
      destinationTo: "Gazipur warehouse",
      kilometers: 12.5,
      rateType: "IN_TIME",
    });
    expect(created.kilometers.toFixed(2)).toBe("12.50");
    expect(created.ratePerKilometer.toFixed(2)).toBe("5.00");
    expect(created.totalCost.toFixed(2)).toBe("62.50");
    expect(created.createdById).toBe(admin.id);

    const updated = await saveDriveCost(
      superAdmin,
      {
        date: "2026-09-22",
        destinationFrom: "Gazipur warehouse",
        destinationTo: "Dhaka office",
        kilometers: 12.5,
        rateType: "OVER_TIME",
      },
      created.id,
    );
    expect(updated.ratePerKilometer.toFixed(2)).toBe("10.00");
    expect(updated.totalCost.toFixed(2)).toBe("125.00");
    expect(updated.createdById).toBe(admin.id);

    await removeCatalogRecord(superAdmin, "drive-costs", created.id);
    expect(
      await db.driveCost.findUnique({ where: { id: created.id } }),
    ).toBeNull();
    const audits = await db.auditLog.findMany({
      where: { resource: "DriveCost", resourceId: created.id },
      select: { action: true, actorId: true },
    });
    expect(audits).toHaveLength(3);
    expect(audits).toEqual(
      expect.arrayContaining([
        { action: "DRIVE_COST_CREATED", actorId: admin.id },
        { action: "DRIVE_COST_UPDATED", actorId: superAdmin.id },
        { action: "DRIVE_COST_DELETED", actorId: superAdmin.id },
      ]),
    );
  });

  it("creates and corrects a missed punch with calculated duration and immutable audit records", async () => {
    const target = await employee();
    await saveAssignment(admin, {
      employeeId: target.id,
      shiftId,
      startDate: "2025-01-01",
    });
    const result = await createAttendanceCorrection(superAdmin, {
      employeeId: target.id,
      attendanceDate: "2025-01-06",
      checkInAt: "2025-01-06T09:30:00Z",
      checkOutAt: "2025-01-06T17:00:00Z",
      reason: "Manager confirmed missed punches",
    });
    expect(result).toMatchObject({
      status: "LATE",
      lateMinutes: 30,
      workedMinutes: 450,
    });
    for (const actor of [
      admin,
      { id: target.userId, role: "EMPLOYEE" } as const,
    ]) {
      await expect(
        createAttendanceCorrection(actor, {
          employeeId: target.id,
          attendanceDate: "2025-01-07",
          checkInAt: "2025-01-07T09:00:00Z",
          reason: "Attempted unauthorized correction",
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
      await expect(
        correctAttendance(actor, result.id, {
          checkInAt: "2025-01-06T08:00:00Z",
          reason: "Attempted unauthorized correction",
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    }
    expect(
      await db.attendance.count({ where: { employeeId: target.id } }),
    ).toBe(1);
    expect(
      await db.attendance.findUnique({ where: { id: result.id } }),
    ).toEqual(result);
    const corrected = await correctAttendance(superAdmin, result.id, {
      checkInAt: "2025-01-06T09:00:00Z",
      reason: "Manager corrected arrival time",
    });
    expect(corrected).toMatchObject({
      status: "PRESENT",
      lateMinutes: 0,
      workedMinutes: 480,
    });
    expect(
      await db.attendanceEvent.count({
        where: { attendanceId: result.id, type: "ADMIN_CORRECTION" },
      }),
    ).toBe(2);
    const audit = await db.auditLog.findFirstOrThrow({
      where: { resourceId: result.id },
    });
    await expect(
      db.auditLog.update({
        where: { id: audit.id },
        data: { action: "TAMPERED" },
      }),
    ).rejects.toThrow();
  });

  it("reports persisted attendance and scheduled absence, leave, holidays and weekends without leaking GPS or leave reasons", async () => {
    const target = await employee("=1+1");
    await saveAssignment(admin, {
      employeeId: target.id,
      shiftId,
      startDate: "2025-01-01",
    });
    await saveHoliday(admin, {
      name: `Holiday ${tag}`,
      officeId,
      date: "2025-01-02",
    });
    const leave = await createLeave(target.id, {
      startDate: "2025-01-03",
      endDate: "2025-01-03",
      reason: "Sensitive personal reason",
    });
    await reviewLeave(admin, leave.id, { status: "APPROVED" });
    await createAttendanceCorrection(superAdmin, {
      employeeId: target.id,
      attendanceDate: "2025-01-06",
      checkInAt: "2025-01-06T09:30:00Z",
      checkOutAt: "2025-01-06T17:00:00Z",
      reason: "Manager confirmed attendance",
    });
    const filters = {
      employeeId: target.id,
      from: "2025-01-01",
      to: "2025-01-07",
      format: "json" as const,
      page: 1,
      pageSize: 100,
    };
    const rows = await reportRecords(filters, new Date("2025-01-08T12:00:00Z"));
    expect(rows.map((row) => row.status)).toEqual([
      "ABSENT",
      "LATE",
      "WEEKEND",
      "WEEKEND",
      "LEAVE",
      "HOLIDAY",
      "ABSENT",
    ]);
    expect(JSON.stringify(rows)).not.toContain("Sensitive personal reason");
    expect(JSON.stringify(rows)).not.toContain("checkInLatitude");
    expect(
      await reportRecords(
        { ...filters, from: "2025-01-08", to: "2025-01-08" },
        new Date("2025-01-08T09:10:00Z"),
      ),
    ).toHaveLength(0);
    const csv = await getReport({ ...filters, format: "csv" });
    expect(csv).toBeInstanceOf(Response);
    expect(await (csv as Response).text()).toContain("'=1+1");
    const xlsx = await getReport({ ...filters, format: "xlsx" });
    const ExcelJS = await import("exceljs");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await (xlsx as Response).arrayBuffer());
    expect(workbook.worksheets[0].getCell("C2").value).toBe("=1+1");
    expect(workbook.worksheets[0].getCell("C2").type).toBe(
      ExcelJS.ValueType.String,
    );
  });

  it("includes the previous calendar date's ongoing overnight shift in current dashboard totals", async () => {
    const target = await employee();
    const night = await db.shift.create({
      data: {
        name: `Night ${tag}`,
        startTime: "20:00",
        endTime: "05:00",
        timezone: "UTC",
      },
    });
    await saveAssignment(admin, {
      employeeId: target.id,
      shiftId: night.id,
      startDate: "2025-01-01",
    });
    const now = new Date("2025-01-07T03:00:00Z");
    const before = await getAdminDashboard(now);
    await createAttendanceCorrection(superAdmin, {
      employeeId: target.id,
      attendanceDate: "2025-01-06",
      checkInAt: "2025-01-06T20:00:00Z",
      reason: "Manager confirmed overnight arrival",
    });
    const after = await getAdminDashboard(now);
    expect(after.presentToday).toBe(before.presentToday + 1);
    expect(after.currentlyCheckedIn).toBe(before.currentlyCheckedIn + 1);
  });
});
