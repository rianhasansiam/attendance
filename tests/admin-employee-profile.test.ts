import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  employeeProfileCreateSchema,
  employeeSchema,
  employeeUpdateSchema,
} from "@/modules/management/validation";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  queryRaw: vi.fn(),
  findUser: vi.fn(),
  updateUser: vi.fn(),
  createEmployee: vi.fn(),
  findOffice: vi.fn(),
  findDepartment: vi.fn(),
  audit: vi.fn(),
  deleteSessions: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: { $transaction: mocks.transaction } }));

import { createEmployeeProfile } from "@/modules/employees/service";

const actor = { id: "super-admin", role: "SUPER_ADMIN" } as const;
const target = { id: "admin-user", role: "ADMIN", employee: null };
const input = {
  employeeCode: "ADM-001",
  officeId: "office",
  departmentId: "department",
};
const employee = {
  id: "employee-profile",
  userId: target.id,
  ...input,
  user: { id: target.id, role: target.role, email: "admin@example.test" },
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.transaction.mockImplementation(async (work) =>
    work({
      $queryRaw: mocks.queryRaw,
      user: { findUnique: mocks.findUser, update: mocks.updateUser },
      employee: { create: mocks.createEmployee },
      office: { findFirst: mocks.findOffice },
      department: { findFirst: mocks.findDepartment },
      auditLog: { create: mocks.audit },
      session: { deleteMany: mocks.deleteSessions },
    }),
  );
  mocks.findUser.mockImplementation(async ({ where }) =>
    where.id === actor.id
      ? { ...actor, status: "ACTIVE", employee: null }
      : target,
  );
  mocks.findOffice.mockResolvedValue({ id: input.officeId, active: true });
  mocks.findDepartment.mockResolvedValue({
    id: input.departmentId,
    active: true,
  });
  mocks.createEmployee.mockResolvedValue(employee);
});

describe("administrator employee profile validation", () => {
  it.each(["SUPER_ADMIN", "ADMIN", "EMPLOYEE", "MANAGE_DRIVER"] as const)(
    "allows new %s accounts to be created with employment details",
    (role) => {
      expect(
        employeeSchema.parse({
          ...input,
          name: "New member",
          email: "new@example.test",
          role,
        }),
      ).toMatchObject({ role, status: "ACTIVE" });
    },
  );

  it.each(["ADMIN", "SUPER_ADMIN"])(
    "continues rejecting %s role escalation through the employee update schema",
    (role) => {
      expect(employeeUpdateSchema.safeParse({ role }).success).toBe(false);
    },
  );

  it.each([
    { ...input, userId: "different-user" },
    { ...input, role: "SUPER_ADMIN" },
    { ...input, status: "INACTIVE" },
    { ...input, name: "Changed name" },
    { ...input, email: "different@example.test" },
    { ...input, password: "some-password" },
    { ...input, employeeCode: "invalid employee code" },
    { ...input, officeId: "" },
  ])("rejects invalid or identity-changing attachment data %j", (value) => {
    expect(employeeProfileCreateSchema.safeParse(value).success).toBe(false);
  });
});

describe("attach employment to an existing account", () => {
  it.each(["ADMIN", "SUPER_ADMIN", "EMPLOYEE", "MANAGE_DRIVER"] as const)(
    "attaches a %s profile without touching the existing account or sessions",
    async (role) => {
      mocks.findUser.mockResolvedValueOnce({ ...actor, status: "ACTIVE" });
      mocks.findUser.mockResolvedValueOnce({ ...target, role });

      expect(await createEmployeeProfile(actor, target.id, input)).toEqual(
        employee,
      );

      expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), {
        isolationLevel: "Serializable",
        timeout: 30_000,
      });
      expect(mocks.createEmployee).toHaveBeenCalledExactlyOnceWith({
        data: { ...input, userId: target.id },
        include: expect.objectContaining({
          user: {
            select: expect.objectContaining({
              id: true,
              role: true,
              email: true,
            }),
          },
        }),
      });
      const selectedUser =
        mocks.createEmployee.mock.calls[0][0].include.user.select;
      expect(selectedUser).not.toHaveProperty("passwordHash");
      expect(selectedUser).not.toHaveProperty("googleAccountId");
      expect(mocks.updateUser).not.toHaveBeenCalled();
      expect(mocks.deleteSessions).not.toHaveBeenCalled();
      expect(mocks.audit).toHaveBeenCalledExactlyOnceWith({
        data: {
          actorId: actor.id,
          action: "EMPLOYEE_PROFILE_CREATED",
          resource: "Employee",
          resourceId: employee.id,
          newState: employee,
        },
      });
    },
  );

  it("lets a super administrator attach their own employee profile", async () => {
    await createEmployeeProfile(actor, actor.id, input);
    expect(mocks.createEmployee).toHaveBeenCalledWith({
      data: { ...input, userId: actor.id },
      include: expect.any(Object),
    });
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });

  it.each(["ADMIN", "EMPLOYEE", "MANAGE_DRIVER"] as const)(
    "rejects %s callers before database work",
    async (role) => {
      await expect(
        createEmployeeProfile({ ...actor, role }, target.id, input),
      ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
      expect(mocks.transaction).not.toHaveBeenCalled();
    },
  );

  it.each([
    { ...actor, role: "ADMIN", status: "ACTIVE" },
    { ...actor, status: "INACTIVE" },
    { ...actor, status: "SUSPENDED" },
    null,
  ])("checks persisted actor authorization %j", async (currentActor) => {
    mocks.findUser.mockResolvedValueOnce(currentActor);
    await expect(
      createEmployeeProfile(actor, target.id, input),
    ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    expect(mocks.findUser).toHaveBeenCalledOnce();
    expect(mocks.createEmployee).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("rejects attachment to a deleted account", async () => {
    mocks.findUser.mockResolvedValueOnce({ ...actor, status: "ACTIVE" });
    mocks.findUser.mockResolvedValueOnce(null);
    await expect(
      createEmployeeProfile(actor, target.id, input),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    expect(mocks.createEmployee).not.toHaveBeenCalled();
  });

  it("rejects a second employee profile without replacing the existing one", async () => {
    mocks.findUser.mockResolvedValueOnce({ ...actor, status: "ACTIVE" });
    mocks.findUser.mockResolvedValueOnce({
      ...target,
      employee: { id: "existing-profile" },
    });
    await expect(
      createEmployeeProfile(actor, target.id, input),
    ).rejects.toMatchObject({ code: "EMPLOYEE_PROFILE_EXISTS", status: 409 });
    expect(mocks.createEmployee).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it.each([
    ["office", "OFFICE_UNAVAILABLE"],
    ["department", "DEPARTMENT_UNAVAILABLE"],
  ])("rejects an inactive or missing %s", async (resource, code) => {
    (resource === "office"
      ? mocks.findOffice
      : mocks.findDepartment
    ).mockResolvedValue(null);
    await expect(
      createEmployeeProfile(actor, target.id, input),
    ).rejects.toMatchObject({ code });
    expect(mocks.createEmployee).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it.each([
    { code: "P2002" },
    { code: "P2034" },
    { code: "P2010", meta: { code: "40001" } },
    { code: "P2010", meta: { code: "40P01" } },
    {
      code: "P2010",
      meta: {
        driverAdapterError: { cause: { kind: "TransactionWriteConflict" } },
      },
    },
  ])(
    "reports concurrent or duplicate writes as a safe conflict %j",
    async (error) => {
      mocks.transaction.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError("Private database error", {
          ...error,
          clientVersion: "test",
        }),
      );
      await expect(
        createEmployeeProfile(actor, target.id, input),
      ).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
    },
  );
});
