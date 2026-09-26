import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { removeCatalogRecord } from "@/modules/management/catalog";
import type { Actor } from "@/modules/management/permissions";

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("catalog database deletion", () => {
  let admin: Actor;
  let fixtureOfficeId: string;

  beforeAll(async () => {
    if (!databaseUrl || !new URL(databaseUrl).pathname.includes("test"))
      throw new Error(
        "Catalog deletion tests require a disposable test database.",
      );
    process.env.DATABASE_URL = databaseUrl;
    admin = await db.user.create({
      data: {
        email: `catalog-delete-${randomUUID()}@example.test`,
        role: "ADMIN",
      },
      select: { id: true, role: true },
    });
    fixtureOfficeId = (await makeOffice()).id;
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  function makeOffice(active = true) {
    return db.office.create({
      data: {
        name: `Delete test ${randomUUID()}`,
        address: "Test office",
        latitude: 0,
        longitude: 0,
        timezone: "UTC",
        active,
      },
    });
  }

  function makeShift(active = true) {
    return db.shift.create({
      data: {
        name: `Delete test ${randomUUID()}`,
        startTime: "09:00",
        endTime: "17:00",
        timezone: "UTC",
        active,
      },
    });
  }

  function makeEmployee(officeId = fixtureOfficeId, departmentId?: string) {
    return db.employee.create({
      data: {
        employeeCode: `CD-${randomUUID()}`,
        office: { connect: { id: officeId } },
        ...(departmentId
          ? { department: { connect: { id: departmentId } } }
          : {}),
        user: {
          create: { email: `catalog-employee-${randomUUID()}@example.test` },
        },
      },
    });
  }

  async function makeCatalogRecord(resource: string, active: boolean) {
    switch (resource) {
      case "departments": {
        const record = await db.department.create({
          data: { name: `Delete test ${randomUUID()}`, active },
        });
        return {
          record,
          read: () => db.department.findUnique({ where: { id: record.id } }),
        };
      }
      case "offices": {
        const record = await makeOffice(active);
        return {
          record,
          read: () => db.office.findUnique({ where: { id: record.id } }),
        };
      }
      case "networks": {
        const record = await db.officeNetwork.create({
          data: {
            officeId: (await makeOffice()).id,
            publicIpOrCidr: "192.0.2.1",
            active,
          },
        });
        return {
          record,
          read: () => db.officeNetwork.findUnique({ where: { id: record.id } }),
        };
      }
      case "shifts": {
        const record = await makeShift(active);
        return {
          record,
          read: () => db.shift.findUnique({ where: { id: record.id } }),
        };
      }
      default:
        throw new Error("Unknown catalog fixture");
    }
  }

  for (const resource of ["departments", "offices", "networks", "shifts"]) {
    it.each([true, false])(
      `removes ${resource} from the database with active=%s and retains a deletion audit`,
      async (active) => {
        const { record, read } = await makeCatalogRecord(resource, active);

        expect(await removeCatalogRecord(admin, resource, record.id)).toEqual({
          id: record.id,
        });
        expect(await read()).toBeNull();
        const audit = await db.auditLog.findFirstOrThrow({
          where: { resourceId: record.id, action: "RECORD_REMOVED" },
        });
        expect(audit.actorId).toBe(admin.id);
        expect(audit.previousState).toMatchObject({ id: record.id, active });
        expect(audit.newState).toBeNull();
      },
    );
  }

  async function expectReferenced(
    resource: string,
    id: string,
    message: RegExp,
  ) {
    await expect(
      removeCatalogRecord(admin, resource, id),
    ).rejects.toMatchObject({
      code: "REFERENCE_CONFLICT",
      status: 409,
      message: expect.stringMatching(message),
    });
    expect(
      await db.auditLog.count({
        where: { resourceId: id, action: "RECORD_REMOVED" },
      }),
    ).toBe(0);
  }

  it("preserves a department and its employees when the department is still assigned", async () => {
    const { record, read } = await makeCatalogRecord("departments", true);
    const employee = await makeEmployee(fixtureOfficeId, record.id);

    await expectReferenced(
      "departments",
      record.id,
      /Reassign those employees/,
    );

    expect(await read()).toMatchObject({ active: true });
    expect(
      await db.employee.findUnique({ where: { id: employee.id } }),
    ).toMatchObject({ departmentId: record.id });
  });

  it("preserves an office and its networks when employees still belong to it", async () => {
    const office = await makeOffice();
    const employee = await makeEmployee(office.id);
    const network = await db.officeNetwork.create({
      data: { officeId: office.id, publicIpOrCidr: "192.0.2.1" },
    });

    await expectReferenced(
      "offices",
      office.id,
      /employees, attendance, or holidays/,
    );

    expect(
      await db.office.findUnique({ where: { id: office.id } }),
    ).toMatchObject({ active: true });
    expect(
      await db.employee.findUnique({ where: { id: employee.id } }),
    ).toMatchObject({ officeId: office.id });
    expect(
      await db.officeNetwork.findUnique({ where: { id: network.id } }),
    ).not.toBeNull();
  });

  it("keeps office holiday references intact", async () => {
    const office = await makeOffice();
    const holiday = await db.holiday.create({
      data: {
        name: "Office holiday",
        officeId: office.id,
        date: new Date("2026-01-01"),
      },
    });

    await expectReferenced("offices", office.id, /holidays/);

    expect(
      await db.holiday.findUnique({ where: { id: holiday.id } }),
    ).toMatchObject({ officeId: office.id });
  });

  it("removes an unused office together with its network configuration", async () => {
    const office = await makeOffice();
    const network = await db.officeNetwork.create({
      data: { officeId: office.id, publicIpOrCidr: "192.0.2.1" },
    });

    await removeCatalogRecord(admin, "offices", office.id);

    expect(await db.office.findUnique({ where: { id: office.id } })).toBeNull();
    expect(
      await db.officeNetwork.findUnique({ where: { id: network.id } }),
    ).toBeNull();
  });

  it("preserves a shift still referenced by an employee assignment", async () => {
    const shift = await makeShift();
    const employee = await makeEmployee();
    const assignment = await db.employeeShift.create({
      data: {
        employeeId: employee.id,
        shiftId: shift.id,
        startDate: new Date("2026-01-01"),
      },
    });

    await expectReferenced("shifts", shift.id, /Remove assignments first/);

    expect(
      await db.shift.findUnique({ where: { id: shift.id } }),
    ).toMatchObject({ active: true });
    expect(
      await db.employeeShift.findUnique({ where: { id: assignment.id } }),
    ).not.toBeNull();
  });

  it("preserves offices, shifts, and attendance history when attendance references them", async () => {
    const office = await makeOffice();
    const shift = await makeShift();
    // Use a different current office so historical attendance is the only office reference.
    const employee = await makeEmployee();
    const attendance = await db.attendance.create({
      data: {
        employeeId: employee.id,
        officeId: office.id,
        shiftId: shift.id,
        attendanceDate: new Date("2026-01-02"),
        status: "PRESENT",
      },
    });

    await expectReferenced(
      "offices",
      office.id,
      /attendance history must be kept/,
    );
    await expectReferenced(
      "shifts",
      shift.id,
      /attendance history must be kept/,
    );

    expect(
      await db.office.findUnique({ where: { id: office.id } }),
    ).toMatchObject({ active: true });
    expect(
      await db.shift.findUnique({ where: { id: shift.id } }),
    ).toMatchObject({ active: true });
    expect(
      await db.attendance.findUnique({ where: { id: attendance.id } }),
    ).not.toBeNull();
  });

  it("rejects employees and driver managers without changing the record", async () => {
    const { record, read } = await makeCatalogRecord("departments", true);
    for (const role of ["EMPLOYEE", "MANAGE_DRIVER"] as const) {
      await expect(
        removeCatalogRecord({ id: admin.id, role }, "departments", record.id),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    expect(await read()).not.toBeNull();
  });

  it("rolls deletion back if its audit cannot be written", async () => {
    const { record, read } = await makeCatalogRecord("departments", true);

    await expect(
      removeCatalogRecord(
        { id: randomUUID(), role: "ADMIN" },
        "departments",
        record.id,
      ),
    ).rejects.toMatchObject({ code: "P2003" });

    expect(await read()).toMatchObject({ active: true });
  });
});
