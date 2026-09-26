import "server-only";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { DomainError } from "@/lib/errors";
import { writeAudit } from "@/modules/audit/service";
import { authorizeRole, isEmployeeRole } from "@/modules/auth/authorization";
import {
  assertMayManageUser,
  type Actor,
} from "@/modules/management/permissions";
import {
  employeeSchema,
  employeeUpdateSchema,
} from "@/modules/management/validation";

export const publicUserSelect = {
  id: true,
  name: true,
  email: true,
  image: true,
  role: true,
  status: true,
  lastLoginAt: true,
} satisfies Prisma.UserSelect;
export const employeeInclude = {
  user: { select: publicUserSelect },
  office: true,
  department: true,
} satisfies Prisma.EmployeeInclude;

/** Own-profile read shared by the Server Component and the JSON endpoint.
 * The actor comes from requireUser/requirePageUser, never request input.
 */
export async function getOwnEmployeeProfile(actor: {
  id: string;
  employee: { id: string } | null;
}) {
  if (!actor.employee)
    throw new DomainError(
      "NO_EMPLOYEE",
      "An employee profile is required.",
      403,
    );
  const employee = await db.employee.findUnique({
    where: { id: actor.employee.id, userId: actor.id },
    include: {
      ...employeeInclude,
      shifts: { include: { shift: true }, orderBy: { startDate: "desc" } },
    },
  });
  if (!employee)
    throw new DomainError(
      "NO_EMPLOYEE",
      "An employee profile is required.",
      403,
    );
  return employee;
}

async function validateAssignments(
  tx: Prisma.TransactionClient,
  officeId?: string,
  departmentId?: string | null,
) {
  if (
    officeId &&
    !(await tx.office.findFirst({ where: { id: officeId, active: true } }))
  ) {
    throw new DomainError("OFFICE_UNAVAILABLE", "Choose an active office.");
  }
  if (
    departmentId &&
    !(await tx.department.findFirst({
      where: { id: departmentId, active: true },
    }))
  ) {
    throw new DomainError(
      "DEPARTMENT_UNAVAILABLE",
      "Choose an active department.",
    );
  }
}

export async function createEmployee(
  actor: Actor,
  input: z.infer<typeof employeeSchema>,
) {
  authorizeRole(actor.role, "ADMIN");
  return db.$transaction(async (tx) => {
    await validateAssignments(tx, input.officeId, input.departmentId);
    const { name, email, status, role = "EMPLOYEE", ...employee } = input;
    const user = await tx.user.create({
      data: { name, email, status, role },
    });
    const created = await tx.employee.create({
      data: { ...employee, userId: user.id },
      include: employeeInclude,
    });
    await writeAudit(
      actor.id,
      "EMPLOYEE_CREATED",
      "Employee",
      created.id,
      undefined,
      created,
      tx,
    );
    return created;
  });
}

export async function updateEmployee(
  actor: Actor,
  id: string,
  input: z.infer<typeof employeeUpdateSchema>,
) {
  authorizeRole(actor.role, "ADMIN");
  return db.$transaction(async (tx) => {
    const identities = await tx.$queryRaw<
      { userId: string }[]
    >`SELECT "userId" FROM "Employee" WHERE "id" = ${id} FOR UPDATE`;
    if (!identities[0])
      throw new DomainError("NOT_FOUND", "Employee not found.", 404);
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${identities[0].userId} FOR UPDATE`;
    const previous = await tx.employee.findUnique({
      where: { id },
      include: employeeInclude,
    });
    if (!previous)
      throw new DomainError("NOT_FOUND", "Employee not found.", 404);
    assertMayManageUser(actor, previous.user, {
      role: input.role,
      status: input.status,
    });
    if (input.role && !isEmployeeRole(previous.user.role))
      throw new DomainError(
        "FORBIDDEN",
        "Use user management to change administrator roles.",
        403,
      );
    await validateAssignments(tx, input.officeId, input.departmentId);
    const { name, email, status, role, ...employee } = input;
    // An email change resets every sign-in method and requires fresh verification.
    if (email && email !== previous.user.email) {
      await tx.passwordResetToken.deleteMany({
        where: { userId: previous.userId },
      });
      await tx.account.deleteMany({ where: { userId: previous.userId } });
      await tx.session.deleteMany({ where: { userId: previous.userId } });
      await tx.webAuthnCredential.updateMany({
        where: { employeeId: id, revokedAt: null },
        data: { revokedAt: new Date(), approved: false },
      });
      await tx.webAuthnChallenge.deleteMany({ where: { employeeId: id } });
    }
    if (
      (status && status !== "ACTIVE") ||
      (role && role !== previous.user.role)
    )
      await tx.session.deleteMany({ where: { userId: previous.userId } });
    await tx.user.update({
      where: { id: previous.userId },
      data: {
        name,
        email,
        status,
        role,
        ...(email && email !== previous.user.email
          ? {
              googleAccountId: null,
              passwordHash: null,
              emailVerified: null,
              image: null,
            }
          : {}),
      },
    });
    const updated = await tx.employee.update({
      where: { id },
      data: employee,
      include: employeeInclude,
    });
    await writeAudit(
      actor.id,
      status && status !== "ACTIVE" ? "EMPLOYEE_DISABLED" : "EMPLOYEE_UPDATED",
      "Employee",
      id,
      previous,
      updated,
      tx,
    );
    return updated;
  });
}
