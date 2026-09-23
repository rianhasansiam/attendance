import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  queryRaw: vi.fn(),
  findUser: vi.fn(),
  createUser: vi.fn(),
  updateUser: vi.fn(),
  findEmployee: vi.fn(),
  createEmployee: vi.fn(),
  updateEmployee: vi.fn(),
  deleteSessions: vi.fn(),
  findOffice: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: { $transaction: mocks.transaction } }));

import { createEmployee, updateEmployee } from "@/modules/employees/service";
import { updateUser } from "@/modules/management/workflows";

const admin = { id: "admin", role: "ADMIN" } as const;
const superAdmin = { id: "super", role: "SUPER_ADMIN" } as const;
const employeeInput = {
  name: "Employee",
  email: "employee@example.test",
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
  mocks.transaction.mockImplementation(async (work) =>
    work({
      $queryRaw: mocks.queryRaw,
      user: {
        findUnique: mocks.findUser,
        create: mocks.createUser,
        update: mocks.updateUser,
      },
      employee: {
        findUnique: mocks.findEmployee,
        create: mocks.createEmployee,
        update: mocks.updateEmployee,
      },
      office: { findFirst: mocks.findOffice },
      session: { deleteMany: mocks.deleteSessions },
      auditLog: { create: mocks.audit },
    }),
  );
  mocks.queryRaw.mockResolvedValue([{ userId: user.id }]);
  mocks.findOffice.mockResolvedValue({ id: "office" });
  mocks.findUser.mockResolvedValue({ ...user, employee: { id: employee.id } });
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
  it.each([undefined, "MANAGE_DRIVER"] as const)(
    "creates an employee profile with the selected role %s",
    async (role) => {
      await createEmployee(admin, { ...employeeInput, role });
      expect(mocks.createUser).toHaveBeenCalledWith({
        data: expect.objectContaining({ role: role ?? "EMPLOYEE" }),
      });
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
      mocks.findUser.mockResolvedValue({
        ...user,
        role: "ADMIN",
        employee: null,
      });
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
