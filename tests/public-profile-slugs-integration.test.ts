import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { getPublicProfile } from "@/modules/public-profile/service";

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("public profile slug allocation", () => {
  const ids: string[] = [];

  beforeAll(() => {
    if (!databaseUrl || !new URL(databaseUrl).pathname.includes("test"))
      throw new Error("Slug tests require a disposable test database");
    process.env.DATABASE_URL = databaseUrl;
  });

  afterAll(async () => {
    await db.user.deleteMany({ where: { id: { in: ids } } });
    await db.$disconnect();
  });

  async function create(name: string | null) {
    const user = await db.user.create({
      data: { name, email: `slug-${randomUUID()}@example.test` },
    });
    ids.push(user.id);
    return user;
  }

  it("turns a full name with trailing whitespace into the requested URL", async () => {
    const user = await create("  Rian   Hasan Siam ");
    expect(user.profileSlug).toBe("rian_hasan_siam");
    const profile = await getPublicProfile("rian_hasan_siam");
    expect(profile?.slug).toBe("rian_hasan_siam");
    expect(profile?.name).toBe("Rian   Hasan Siam");
    expect(await getPublicProfile(user.id)).toEqual(profile);

    await db.user.update({
      where: { id: user.id },
      data: { name: "New name" },
    });
    expect((await getPublicProfile(user.profileSlug))?.name).toBe("New name");
    await db.user.update({
      where: { id: user.id },
      data: { status: "INACTIVE" },
    });
    expect(await getPublicProfile(user.profileSlug)).toBeNull();
    expect(await getPublicProfile(user.id)).toBeNull();
  });

  it("allocates distinct URLs for simultaneous duplicate names", async () => {
    const name = `Concurrent ${randomUUID().replaceAll("-", "")}`;
    const base = name.toLowerCase().replaceAll(" ", "_");
    const users = await Promise.all(
      Array.from({ length: 6 }, () => create(name)),
    );
    expect(users.map((user) => user.profileSlug).sort()).toEqual(
      [
        base,
        ...Array.from({ length: 5 }, (_, index) => `${base}_${index + 2}`),
      ].sort(),
    );
  });

  it("handles collisions with naturally numbered names", async () => {
    const name = `Numbered ${randomUUID().replaceAll("-", "")}`;
    const first = await create(name);
    await create(`${name} 2`);
    expect((await create(name)).profileSlug).toBe(`${first.profileSlug}_3`);
  });

  it("uses a neutral unique slug for unnamed accounts and bounds long names", async () => {
    const first = await create(null);
    const second = await create("---");
    expect(first.profileSlug).toMatch(/^team_member(?:_\d+)?$/);
    expect(second.profileSlug).not.toBe(first.profileSlug);
    expect(
      (await create("A".repeat(150))).profileSlug.length,
    ).toBeLessThanOrEqual(100);
  });

  it("reserves legacy CUID identifiers", async () => {
    const user = await create("cmu8rqygy0000wzoji0oxaiez");
    expect(user.profileSlug).toBe("member_cmu8rqygy0000wzoji0oxaiez");
  });
});
