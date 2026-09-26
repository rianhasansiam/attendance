import "server-only";
import { db } from "@/lib/db";

function publicImage(image: string | null) {
  if (!image || /[\\\s]/.test(image)) return null;
  if (image.startsWith("/") && !image.startsWith("//")) return image;
  try {
    const url = new URL(image);
    return url.protocol === "https:" &&
      /^lh[3-6]\.googleusercontent\.com$/.test(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.port
      ? image
      : null;
  } catch {
    return null;
  }
}

/** Anonymous view: keep this allowlist separate from authenticated projections. */
export async function getPublicProfile(identifier: string) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(identifier)) return null;
  const user = await db.user.findFirst({
    where: {
      OR: [{ profileSlug: identifier }, { id: identifier }],
      status: "ACTIVE",
    },
    select: {
      profileSlug: true,
      name: true,
      image: true,
      designation: true,
      phone: true,
      bloodGroup: true,
      publicDepartment: true,
      homeAddress: true,
      dateOfBirth: true,
    },
  });
  if (!user) return null;
  // Never fall back to email when a name or photo is missing.
  return {
    slug: user.profileSlug,
    name: user.name?.trim() || "Team member",
    image: publicImage(user.image),
    designation: user.designation,
    phone: user.phone,
    bloodGroup: user.bloodGroup,
    department: user.publicDepartment,
    homeAddress: user.homeAddress,
    dateOfBirth: user.dateOfBirth?.toISOString().slice(0, 10) ?? null,
  };
}
