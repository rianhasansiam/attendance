// Run against a disposable local database after `prisma migrate deploy`:
// TEST_DATABASE_URL=postgresql://.../attendance_benchmark_test \
// NODE_OPTIONS=--conditions=react-server pnpm exec tsx scripts/benchmark-performance.ts
import { performance } from "node:perf_hooks";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

async function main() {
  const database = process.env.TEST_DATABASE_URL;
  if (!database) throw new Error("TEST_DATABASE_URL is required");
  const url = new URL(database);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    !url.pathname.includes("test")
  )
    throw new Error("Benchmarks require a disposable local test database");
  process.env.DATABASE_URL = database;
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: database, max: 10 }),
    log: [{ emit: "event", level: "query" }],
  });
  let queries = 0;
  db.$on("query", () => queries++);
  Object.assign(globalThis, { attendanceDb: db });
  try {
    const now = new Date("2026-09-20T12:00:00.000Z");
    const offices = Array.from({ length: 12 }, (_, i) => ({
      id: `perf-office-${i}`,
      name: `Performance office ${i}`,
      address: "Synthetic benchmark fixture",
      latitude: 0,
      longitude: 0,
      timezone: "UTC",
      weekendDays: [0, 6],
    }));
    await db.office.createMany({ data: offices, skipDuplicates: true });
    await db.shift.createMany({
      data: [
        {
          id: "perf-shift",
          name: "Performance day",
          startTime: "09:00",
          endTime: "17:00",
          timezone: "UTC",
        },
      ],
      skipDuplicates: true,
    });
    const users = Array.from({ length: 240 }, (_, i) => ({
      id: `perf-user-${i}`,
      name: `Performance employee ${i}`,
      email: `perf-${i}@example.test`,
      googleAccountId: `perf-google-${i}`,
    }));
    await db.user.createMany({ data: users, skipDuplicates: true });
    await db.employee.createMany({
      data: users.map((user, i) => ({
        id: `perf-employee-${i}`,
        userId: user.id,
        employeeCode: `PERF-${String(i).padStart(4, "0")}`,
        officeId: offices[Math.floor(i / 20)].id,
        joinedAt: new Date("2025-01-01T00:00:00Z"),
      })),
      skipDuplicates: true,
    });
    await db.employeeShift.createMany({
      data: users.map((_, i) => ({
        id: `perf-assignment-${i}`,
        employeeId: `perf-employee-${i}`,
        shiftId: "perf-shift",
        startDate: new Date("2025-01-01T00:00:00Z"),
      })),
      skipDuplicates: true,
    });
    for (let day = 0; day < 30; day++) {
      const date = new Date(now.valueOf() - day * 86400000);
      date.setUTCHours(0, 0, 0, 0);
      await db.attendance.createMany({
        data: users
          .filter((_, i) => i % 4 !== 0)
          .map((user) => {
            const i = Number(user.id.replace("perf-user-", ""));
            return {
              id: `perf-attendance-${day}-${i}`,
              employeeId: `perf-employee-${i}`,
              officeId: offices[Math.floor(i / 20)].id,
              shiftId: "perf-shift",
              attendanceDate: date,
              checkInAt: new Date(date.valueOf() + 9 * 3600000),
              checkOutAt: day ? new Date(date.valueOf() + 17 * 3600000) : null,
              status: "PRESENT" as const,
              workedMinutes: day ? 480 : 0,
              checkInLatitude: 0,
              checkInLongitude: 0,
              checkInIp: "192.0.2.1",
            };
          }),
        skipDuplicates: true,
      });
    }
    await db.$executeRaw`ANALYZE`;
    const { getAdminDashboard, getReport } =
      await import("../src/modules/reports/service");
    async function measure(name: string, run: () => Promise<unknown>) {
      await run();
      const samples = [];
      for (let i = 0; i < 5; i++) {
        queries = 0;
        const start = performance.now();
        const result = await run();
        samples.push({
          ms: +(performance.now() - start).toFixed(2),
          queries,
          responseBytes: Buffer.byteLength(JSON.stringify(result)),
        });
      }
      samples.sort((a, b) => a.ms - b.ms);
      return { name, median: samples[2], samples };
    }
    const results = [];
    results.push(
      await measure("admin-dashboard-12-offices", () => getAdminDashboard(now)),
    );
    results.push(
      await measure("report-first-page-30-days", () =>
        getReport({
          from: "2026-08-22",
          to: "2026-09-20",
          format: "json",
          page: 1,
          pageSize: 25,
        }),
      ),
    );
    console.log(
      JSON.stringify(
        {
          fixture: { offices: 12, employees: 240, storedAttendance: 5400 },
          results,
        },
        null,
        2,
      ),
    );
  } finally {
    await db.$disconnect();
  }
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Benchmark failed");
  process.exitCode = 1;
});
