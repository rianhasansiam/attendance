import "server-only";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { DomainError } from "@/lib/errors";
import { writeAudit } from "@/modules/audit/service";
import { assertSuperAdmin, type Actor } from "@/modules/management/permissions";
import { publicProfileUpdateSchema } from "./validation";

const editorSelect = {
  id: true,
  name: true,
  designation: true,
  phone: true,
  bloodGroup: true,
  publicDepartment: true,
  homeAddress: true,
  dateOfBirth: true,
} satisfies Prisma.UserSelect;

type ProfileRecord = Prisma.UserGetPayload<{ select: typeof editorSelect }>;
export type ManagedPublicProfile = {
  id: string;
  name: string;
  designation: string | null;
  phone: string | null;
  bloodGroup: string | null;
  publicDepartment: string | null;
  homeAddress: string | null;
  dateOfBirth: string | null;
};

function editorProfile(user: ProfileRecord): ManagedPublicProfile {
  return {
    id: user.id,
    name: user.name ?? "",
    designation: user.designation,
    phone: user.phone,
    bloodGroup: user.bloodGroup,
    publicDepartment: user.publicDepartment,
    homeAddress: user.homeAddress,
    dateOfBirth: user.dateOfBirth?.toISOString().slice(0, 10) ?? null,
  };
}

async function lockProfileAccess(
  tx: Prisma.TransactionClient,
  actor: Actor,
  targetId: string,
  writing: boolean,
) {
  // Follow employee/user management's lock order so deletion, role changes,
  // and public profile changes cannot race through stale actor permissions.
  if (writing) {
    await tx.$queryRaw`SELECT "id" FROM "Employee" WHERE "userId" = ${targetId} FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" IN (${actor.id}, ${targetId}) ORDER BY "id" FOR UPDATE`;
  } else {
    await tx.$queryRaw`SELECT "id" FROM "Employee" WHERE "userId" = ${targetId} FOR SHARE`;
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" IN (${actor.id}, ${targetId}) ORDER BY "id" FOR SHARE`;
  }
  const currentActor = await tx.user.findUnique({
    where: { id: actor.id },
    select: { id: true, role: true, status: true },
  });
  if (!currentActor || currentActor.status !== "ACTIVE")
    throw new DomainError(
      "FORBIDDEN",
      "An active super administrator account is required to edit public profiles.",
      403,
    );
  assertSuperAdmin(currentActor);
}

export async function getManagedPublicProfile(actor: Actor, id: string) {
  assertSuperAdmin(actor);
  return db.$transaction(async (tx) => {
    await lockProfileAccess(tx, actor, id, false);
    const user = await tx.user.findUnique({
      where: { id },
      select: editorSelect,
    });
    if (!user) throw new DomainError("NOT_FOUND", "User not found.", 404);
    return editorProfile(user);
  });
}

export async function updatePublicProfile(
  actor: Actor,
  id: string,
  input: unknown,
) {
  assertSuperAdmin(actor);
  const parsed = publicProfileUpdateSchema.parse(input);
  return db.$transaction(async (tx) => {
    await lockProfileAccess(tx, actor, id, true);
    const previous = await tx.user.findUnique({
      where: { id },
      select: editorSelect,
    });
    if (!previous) throw new DomainError("NOT_FOUND", "User not found.", 404);
    const updated = await tx.user.update({
      where: { id },
      data: {
        ...parsed,
        dateOfBirth: parsed.dateOfBirth
          ? new Date(`${parsed.dateOfBirth}T00:00:00.000Z`)
          : parsed.dateOfBirth,
      },
      select: editorSelect,
    });
    const before = editorProfile(previous);
    const result = editorProfile(updated);
    const changedFields = Object.keys(parsed).filter(
      (field) =>
        before[field as keyof ManagedPublicProfile] !==
        result[field as keyof ManagedPublicProfile],
    );
    // Audit which fields changed, without copying phone, address, birthday,
    // or other profile values into retained account-deletion history.
    await writeAudit(
      actor.id,
      "PUBLIC_PROFILE_UPDATED",
      "User",
      id,
      undefined,
      { changedFields },
      tx,
    );
    return result;
  });
}
