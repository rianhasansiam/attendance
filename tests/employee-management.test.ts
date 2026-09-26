import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  queryRaw: vi.fn(),
  executeRaw: vi.fn(),
  updateLeave: vi.fn(),
  findUser: vi.fn(),
  createUser: vi.fn(),
  updateUser: vi.fn(),
  findEmployee: vi.fn(),
  createEmployee: vi.fn(),
  updateEmployee: vi.fn(),
  deleteSessions: vi.fn(),
  deleteEmployee: vi.fn(),
  deleteUser: vi.fn(),
  deleteCredentials: vi.fn(),
  findOffice: vi.fn(),
  audit: vi.fn(),
  hashPassword: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: { $transaction: mocks.transaction } }));
vi.mock("@/modules/auth/password", () => ({
  hashPassword: mocks.hashPassword,
}));

import {
  createEmployee,
  deleteEmployee,
  updateEmployee,
} from "@/modules/employees/service";
import { removeRecord } from "@/modules/management/service";
import { updateUser } from "@/modules/management/workflows";

const admin = { id: "admin", role: "ADMIN" } as const;
const superAdmin = { id: "super", role: "SUPER_ADMIN" } as const;
const employeeInput = {
  name: "Employee",
  email: "employee@example.test",
  password: "employee initial passphrase",
  confirmPassword: "employee initial passphrase",
  employeeCode: "E1",
  officeId: "office",
  status: "ACTIVE",
} as const;
const user = {
  id: "employee-user",
  name: employeeInput.name,
  email: employeeInput.email,
  role: "EMPLOYEE",
  status: "ACTIVE",
};
const employee = { id: "employee", userId: user.id, user };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.hashPassword.mockResolvedValue("$argon2id$test-password-hash");
  mocks.transaction.mockImplementation(async (work) =>
    work({
      $queryRaw: mocks.queryRaw,
      $executeRaw: mocks.executeRaw,
      user: {
        findUnique: mocks.findUser,
        create: mocks.createUser,
        update: mocks.updateUser,
        delete: mocks.deleteUser,
      },
      employee: {
        findUnique: mocks.findEmployee,
        create: mocks.createEmployee,
        update: mocks.updateEmployee,
        delete: mocks.deleteEmployee,
      },
      office: { findFirst: mocks.findOffice },
      session: { deleteMany: mocks.deleteSessions },
      webAuthnCredential: { deleteMany: mocks.deleteCredentials },
      auditLog: { create: mocks.audit },
      leave: { updateMany: mocks.updateLeave },
    }),
  );
  mocks.queryRaw.mockImplementation(async (query, ...values) =>
    String(query[0]).includes("to_regprocedure")
      ? [{ ready: true, receipts: false }]
      : String(query[0]).includes("SELECT redact_deleted_identity")
        ? [{ snapshot: JSON.parse(values[0]) }]
        : String(query[0]).includes('SELECT "id", "role", "status"')
          ? [{ ...superAdmin, status: "ACTIVE" }]
          : [{ userId: user.id }],
  );
  mocks.findOffice.mockResolvedValue({ id: "office" });
  mocks.findUser.mockImplementation(async ({ where }) =>
    where.id === superAdmin.id
      ? { ...superAdmin, status: "ACTIVE" }
      : { ...user, employee: { id: employee.id } },
  );
  mocks.createUser.mockImplementation(async ({ data }) => ({
    ...user,
    ...data,
  }));
  mocks.updateUser.mockImplementation(async ({ data }) => ({
    ...user,
    ...data,
  }));
  mocks.findEmployee.mockResolvedValue(employee);
  mocks.createEmployee.mockResolvedValue(employee);
  mocks.updateEmployee.mockResolvedValue(employee);
});

describe("employee role management", () => {
  it("rejects employee creation by a regular administrator before hashing or database work", async () => {
    await expect(createEmployee(admin, employeeInput)).rejects.toMatchObject({
      code: "FORBIDDEN",
      status: 403,
    });
    expect(mocks.hashPassword).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it.each([undefined, "MANAGE_DRIVER"] as const)(
    "creates an employee profile with the selected role %s",
    async (role) => {
      await createEmployee(superAdmin, { ...employeeInput, role });
      expect(mocks.hashPassword).toHaveBeenCalledExactlyOnceWith(
        employeeInput.password,
      );
      expect(mocks.createUser).toHaveBeenCalledWith({
        data: expect.objectContaining({
          role: role ?? "EMPLOYEE",
          passwordHash: "$argon2id$test-password-hash",
        }),
        select: expect.any(Object),
      });
      expect(JSON.stringify(mocks.audit.mock.calls)).not.toMatch(
        /initial passphrase|passwordHash|argon2id/,
      );
      expect(mocks.createEmployee).toHaveBeenCalledWith({
        data: {
          employeeCode: employeeInput.employeeCode,
          officeId: employeeInput.officeId,
          userId: user.id,
        },
        include: expect.any(Object),
      });
    },
  );

  it.each(["EMPLOYEE", "MANAGE_DRIVER"] as const)(
    "rejects employee administration by %s accounts",
    async (role) => {
      const actor = { id: user.id, role };
      await expect(createEmployee(actor, employeeInput)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      await expect(
        updateEmployee(actor, employee.id, { role: "MANAGE_DRIVER" }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(mocks.transaction).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["EMPLOYEE", "MANAGE_DRIVER"],
    ["MANAGE_DRIVER", "EMPLOYEE"],
  ] as const)(
    "revokes existing sessions when an administrator changes %s to %s",
    async (previousRole, role) => {
      mocks.findEmployee.mockResolvedValue({
        ...employee,
        user: { ...user, role: previousRole },
      });
      await updateEmployee(admin, employee.id, { role });
      expect(mocks.updateUser).toHaveBeenCalledWith({
        where: { id: user.id },
        data: expect.objectContaining({ role }),
      });
      expect(mocks.deleteSessions).toHaveBeenCalledWith({
        where: { userId: user.id },
      });
      expect(mocks.updateEmployee).toHaveBeenCalledWith({
        where: { id: employee.id },
        data: {},
        include: expect.any(Object),
      });
    },
  );

  it.each(["EMPLOYEE", "MANAGE_DRIVER"] as const)(
    "requires an employee profile before assigning %s through user management",
    async (role) => {
      mocks.findUser.mockImplementation(async ({ where }) =>
        where.id === superAdmin.id
          ? { ...superAdmin, status: "ACTIVE" }
          : { ...user, role: "ADMIN", employee: null },
      );
      await expect(
        updateUser(superAdmin, user.id, { role }),
      ).rejects.toMatchObject({
        code: "EMPLOYEE_REQUIRED",
      });
      expect(mocks.updateUser).not.toHaveBeenCalled();
    },
  );

  it.each(["ADMIN", "SUPER_ADMIN"] as const)(
    "prevents demoting %s through employee management",
    async (role) => {
      mocks.findEmployee.mockResolvedValue({
        ...employee,
        user: { ...user, role },
      });
      await expect(
        updateEmployee(superAdmin, employee.id, { role: "MANAGE_DRIVER" }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(mocks.updateUser).not.toHaveBeenCalled();
    },
  );

  it("allows super administrators to assign the driver manager role to an employee", async () => {
    await updateUser(superAdmin, user.id, { role: "MANAGE_DRIVER" });
    expect(mocks.updateUser).toHaveBeenCalledWith({
      where: { id: user.id },
      data: { role: "MANAGE_DRIVER" },
      select: expect.any(Object),
    });
    expect(mocks.deleteSessions).toHaveBeenCalledWith({
      where: { userId: user.id },
    });
  });
});

describe("employee deletion", () => {
  it.each(["ADMIN", "EMPLOYEE", "MANAGE_DRIVER"] as const)(
    "rejects %s deletion through either service entry point before database work",
    async (role) => {
      const actor = { id: "other-user", role };
      await expect(deleteEmployee(actor, employee.id)).rejects.toMatchObject({
        code: "FORBIDDEN",
        status: 403,
      });
      await expect(
        removeRecord(actor, "employees", employee.id),
      ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
      expect(mocks.transaction).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["EMPLOYEE", "ACTIVE"],
    ["MANAGE_DRIVER", "ACTIVE"],
    ["EMPLOYEE", "INACTIVE"],
  ] as const)(
    "permanently deletes a %s account with status %s",
    async (role, status) => {
      const previous = { ...employee, user: { ...user, role, status } };
      mocks.findEmployee.mockResolvedValue(previous);

      await expect(
        removeRecord(superAdmin, "employees", employee.id),
      ).resolves.toEqual({ id: employee.id });

      expect(mocks.transaction).toHaveBeenCalledOnce();
      expect(mocks.deleteCredentials).toHaveBeenCalledExactlyOnceWith({
        where: { employeeId: employee.id },
      });
      expect(mocks.deleteEmployee).toHaveBeenCalledExactlyOnceWith({
        where: { id: employee.id },
      });
      expect(mocks.deleteUser).toHaveBeenCalledExactlyOnceWith({
        where: { id: user.id },
      });
      expect(mocks.updateEmployee).not.toHaveBeenCalled();
      expect(mocks.updateUser).not.toHaveBeenCalled();
      expect(mocks.audit).toHaveBeenCalledExactlyOnceWith({
        data: {
          actorId: superAdmin.id,
          action: "EMPLOYEE_DELETED",
          resource: "Employee",
          resourceId: employee.id,
          previousState: previous,
        },
      });
    },
  );

  it("returns a clear conflict when a related record changes during deletion", async () => {
    mocks.deleteEmployee.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Foreign key constraint", {
        code: "P2003",
        clientVersion: "test",
      }),
    );
    await expect(deleteEmployee(superAdmin, employee.id)).rejects.toMatchObject(
      {
        code: "REFERENCE_CONFLICT",
        status: 409,
      },
    );
    expect(mocks.deleteUser).not.toHaveBeenCalled();
    expect(mocks.updateUser).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it.each(["ADMIN", "SUPER_ADMIN"] as const)(
    "prevents deleting a %s account through its employee profile",
    async (role) => {
      mocks.findEmployee.mockResolvedValue({
        ...employee,
        user: { ...user, role },
      });

      await expect(
        deleteEmployee(superAdmin, employee.id),
      ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });

      expect(mocks.updateUser).not.toHaveBeenCalled();
      expect(mocks.updateEmployee).not.toHaveBeenCalled();
      expect(mocks.deleteEmployee).not.toHaveBeenCalled();
      expect(mocks.deleteUser).not.toHaveBeenCalled();
      expect(mocks.deleteCredentials).not.toHaveBeenCalled();
      expect(mocks.audit).not.toHaveBeenCalled();
    },
  );

  it.each([
    { ...superAdmin, role: "ADMIN", status: "ACTIVE" },
    { ...superAdmin, status: "INACTIVE" },
    null,
  ])(
    "rejects stale permissions before touching the target",
    async (currentActor) => {
      mocks.queryRaw.mockImplementation(async (query) =>
        String(query[0]).includes('SELECT "id", "role", "status"')
          ? currentActor
            ? [currentActor]
            : []
          : [{ userId: user.id }],
      );
      await expect(
        deleteEmployee(superAdmin, employee.id),
      ).rejects.toMatchObject({
        code: "FORBIDDEN",
        status: 403,
      });
      expect(mocks.findEmployee).not.toHaveBeenCalled();
      expect(mocks.deleteEmployee).not.toHaveBeenCalled();
      expect(mocks.deleteCredentials).not.toHaveBeenCalled();
    },
  );

  it("returns not found without changing accounts when the employee does not exist", async () => {
    mocks.queryRaw.mockResolvedValueOnce([]);

    await expect(
      deleteEmployee(superAdmin, "missing-employee"),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });

    expect(mocks.updateUser).not.toHaveBeenCalled();
    expect(mocks.updateEmployee).not.toHaveBeenCalled();
    expect(mocks.deleteSessions).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});
