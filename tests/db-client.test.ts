import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  constructor: undefined as unknown,
  clients: [] as unknown[],
  adapters: [] as unknown[],
}));
vi.mock("@prisma/client", () => ({
  get PrismaClient() {
    return runtime.constructor;
  },
}));
vi.mock("@prisma/adapter-pg", () => ({
  PrismaPg: class {
    constructor(public options: unknown) {
      runtime.adapters.push(options);
    }
  },
}));

const cache = globalThis as unknown as { attendanceDb?: unknown };
const previousCache = cache.attendanceDb;

function generatedClient() {
  return class {
    $disconnect = vi.fn().mockResolvedValue(undefined);
    user = { findUnique: vi.fn().mockResolvedValue({ id: "user" }) };
    salarySetting = { findFirst: vi.fn().mockResolvedValue({ id: "salary" }) };
    constructor(public options: unknown) {
      runtime.clients.push(this);
    }
    $transaction(handler: (client: unknown) => unknown) {
      return handler(this);
    }
  };
}

beforeEach(() => {
  vi.resetModules();
  runtime.clients = [];
  runtime.adapters = [];
  runtime.constructor = generatedClient();
  delete cache.attendanceDb;
  vi.stubEnv("DATABASE_URL", "postgresql://test@127.0.0.1:1/db_client_test");
});
afterEach(() => {
  cache.attendanceDb = previousCache;
  vi.unstubAllEnvs();
});

describe("lazy generated Prisma client cache", () => {
  it("constructs lazily with the existing connection/pool settings and reuses the current generated client", async () => {
    const { db } = await import("@/lib/db");
    expect(runtime.clients).toHaveLength(0);
    expect(runtime.adapters).toHaveLength(0);
    const delegate = db.user;
    expect(runtime.clients).toHaveLength(1);
    expect(runtime.adapters).toEqual([
      { connectionString: process.env.DATABASE_URL, max: 10 },
    ]);
    expect(runtime.clients[0]).toMatchObject({ options: { log: [] } });
    expect(db.user).toBe(delegate);
    expect(db.salarySetting).toBe(
      (runtime.clients[0] as { salarySetting: unknown }).salarySetting,
    );
    expect(runtime.clients).toHaveLength(1);
  });

  it("keeps a compatible generated client across module reloads and binds client methods", async () => {
    const { db } = await import("@/lib/db");
    const transaction = db.$transaction;
    const current = runtime.clients[0] as {
      $disconnect: ReturnType<typeof vi.fn>;
    };
    expect(await transaction(async (client) => client)).toBe(current);
    vi.resetModules();
    const reloaded = await import("@/lib/db");
    expect(reloaded.db.user).toBe(db.user);
    expect(runtime.clients).toHaveLength(1);
    expect(current.$disconnect).not.toHaveBeenCalled();
  });

  it("replaces a client from a previous generated constructor and retires its pool once", async () => {
    const OldClient = generatedClient();
    const stale = new OldClient({});
    delete (stale as Partial<typeof stale>).salarySetting;
    cache.attendanceDb = stale;
    runtime.clients = [];
    const { db } = await import("@/lib/db");
    const currentDelegate = db.salarySetting;
    expect(currentDelegate.findFirst).toBeTypeOf("function");
    expect(cache.attendanceDb).not.toBe(stale);
    expect(runtime.clients).toHaveLength(1);
    expect(db.salarySetting).toBe(currentDelegate);
    await Promise.resolve();
    expect(stale.$disconnect).toHaveBeenCalledOnce();
    expect(await db.$transaction(async (client) => client)).toBe(
      cache.attendanceDb,
    );
  });

  it("reuses a current generated proxy whose instanceof check is false", async () => {
    const CurrentClient = generatedClient();
    runtime.constructor = CurrentClient;
    const current = new CurrentClient({});
    const proxy = new Proxy(current, {
      getPrototypeOf: () => Object.prototype,
    });
    expect(proxy instanceof CurrentClient).toBe(false);
    expect(proxy.constructor).toBe(CurrentClient);
    cache.attendanceDb = proxy;
    const { db } = await import("@/lib/db");
    expect(db.salarySetting).toBe(current.salarySetting);
    expect(runtime.clients).toHaveLength(1);
    expect(runtime.adapters).toHaveLength(0);
    expect(current.$disconnect).not.toHaveBeenCalled();
  });

  it.each(["reject", "throw"] as const)(
    "keeps the fresh client usable when stale cleanup fails (%s)",
    async (mode) => {
      const OldClient = generatedClient();
      const stale = new OldClient({});
      if (mode === "reject")
        stale.$disconnect.mockRejectedValue(
          new Error("Old pool cleanup failed"),
        );
      else
        stale.$disconnect.mockImplementation(() => {
          throw new Error("Old pool cleanup failed");
        });
      cache.attendanceDb = stale;
      runtime.clients = [];
      const { db } = await import("@/lib/db");
      expect(await db.salarySetting.findFirst()).toEqual({ id: "salary" });
      await Promise.resolve();
      await Promise.resolve();
      expect(stale.$disconnect).toHaveBeenCalledOnce();
      expect(await db.user.findUnique({ where: { id: "user" } })).toEqual({
        id: "user",
      });
      expect(runtime.clients).toHaveLength(1);
    },
  );

  it("requires a connection string on access, including when a compatible cache already exists", async () => {
    const { db } = await import("@/lib/db");
    expect(db.user).toBeDefined();
    vi.stubEnv("DATABASE_URL", "");
    expect(() => db.user).toThrow("DATABASE_URL is required");
    expect(runtime.clients).toHaveLength(1);
    delete cache.attendanceDb;
    vi.resetModules();
    const importedWithoutEnvironment = await import("@/lib/db");
    expect(() => importedWithoutEnvironment.db.user).toThrow(
      "DATABASE_URL is required",
    );
    expect(runtime.clients).toHaveLength(1);
  });
});
