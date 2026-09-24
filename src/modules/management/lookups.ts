import "server-only";
import { cacheLife, cacheTag } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { CACHE_TAGS, type CachedReference } from "@/lib/cache/tags";
import { mayCacheReferenceDisplay } from "@/lib/cache/invalidation";
import { authorizeRole } from "@/modules/auth/authorization";
import type { Actor } from "./permissions";
import { paginationSchema } from "./validation";

export const lookupResourceSchema = z.enum([
  "departments",
  "offices",
  "shifts",
  "employees",
]);
type LookupResource = z.infer<typeof lookupResourceSchema>;
type Query = z.infer<typeof paginationSchema>;

async function referencePage(resource: CachedReference, query: Query) {
  const { page, pageSize, q } = query;
  const options = {
    where: q ? { name: { contains: q, mode: "insensitive" as const } } : {},
    select: { id: true, name: true },
    orderBy: [{ name: "asc" as const }, { id: "asc" as const }],
    take: pageSize,
    skip: (page - 1) * pageSize,
  };
  // These models deliberately share only the ID/name display projection.
  const [items, total] = await (resource === "departments"
    ? Promise.all([
        db.department.findMany(options),
        db.department.count({ where: options.where }),
      ])
    : resource === "offices"
      ? Promise.all([
          db.office.findMany(options),
          db.office.count({ where: options.where }),
        ])
      : Promise.all([
          db.shift.findMany(options),
          db.shift.count({ where: options.where }),
        ]));
  return { items, total, page, pageSize };
}

async function initialReferenceOptions(resource: CachedReference) {
  "use cache";
  cacheLife("referenceDisplay");
  cacheTag(CACHE_TAGS[resource]);
  return referencePage(resource, { page: 1, pageSize: 100 });
}

/** Accept only a server-authenticated actor, never an identity from request input.
 * No status, role, policy, coordinates, schedule, or credential data is cached.
 */
export async function listLookupOptions(
  actor: Actor,
  resource: LookupResource,
  query: Query,
) {
  authorizeRole(actor.role, "ADMIN");
  if (resource !== "employees") {
    // Only three fixed cache entries. Search text and arbitrary page windows
    // stay dynamic rather than filling memory with one-use search entries.
    if (
      !query.q &&
      query.page === 1 &&
      query.pageSize === 100 &&
      mayCacheReferenceDisplay(resource)
    )
      return initialReferenceOptions(resource);
    return referencePage(resource, query);
  }
  const { page, pageSize, q } = query;
  const where = q
    ? {
        OR: [
          { employeeCode: { contains: q, mode: "insensitive" as const } },
          {
            user: {
              OR: [
                { name: { contains: q, mode: "insensitive" as const } },
                { email: { contains: q, mode: "insensitive" as const } },
              ],
            },
          },
        ],
      }
    : {};
  const [items, total] = await Promise.all([
    db.employee.findMany({
      where,
      select: {
        id: true,
        employeeCode: true,
        user: { select: { name: true } },
      },
      orderBy: { employeeCode: "asc" },
      take: pageSize,
      skip: (page - 1) * pageSize,
    }),
    db.employee.count({ where }),
  ]);
  return { items, total, page, pageSize };
}
