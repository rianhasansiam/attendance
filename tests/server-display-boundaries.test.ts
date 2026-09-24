import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  correction: vi.fn(),
  create: vi.fn(),
  list: vi.fn(),
  detail: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  requireSuperAdmin: async () => ({ id: "super", role: "SUPER_ADMIN" }),
}));
vi.mock("@/lib/security", () => ({
  assertSameOrigin: vi.fn(),
  rateLimit: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: {
    auditLog: {
      findMany: mocks.list,
      findUnique: mocks.detail,
      count: async () => 1,
    },
    attendanceEvent: {
      findMany: mocks.list,
      findUnique: mocks.detail,
      count: async () => 1,
    },
  },
}));
vi.mock("@/modules/management/workflows", async (original) => ({
  ...(await original<object>()),
  correctAttendance: mocks.correction,
  createAttendanceCorrection: mocks.create,
}));
import { PATCH } from "@/app/api/admin/attendance/[id]/route";
import { POST } from "@/app/api/admin/attendance/route";
import { listRecords, getRecord } from "@/modules/management/service";

beforeEach(() => vi.resetAllMocks());
const admin = { id: "admin", role: "ADMIN" } as const;

describe("safe browser display DTOs", () => {
  it("returns attendance correction display fields without GPS, IP or credential evidence", async () => {
    const record = {
      id: "attendance",
      attendanceDate: new Date("2026-09-24"),
      checkInAt: new Date(),
      checkOutAt: null,
      status: "PRESENT",
      lateMinutes: 0,
      lateReason: null,
      workedMinutes: 0,
      overtimeMinutes: 0,
      checkInLatitude: 23.1234567,
      checkInLongitude: 90.1234567,
      checkInIp: "private-ip",
      checkInCredentialId: "private-credential",
    };
    mocks.correction.mockResolvedValue(record);
    mocks.create.mockResolvedValue(record);
    const request = (method: string, body: object) =>
      new Request("https://example.test/api/admin/attendance", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const responses = [
      await PATCH(request("PATCH", { reason: "Attendance verified" }), {
        params: Promise.resolve({ id: "attendance" }),
      }),
      await POST(
        request("POST", {
          employeeId: "employee",
          attendanceDate: "2026-09-24",
          checkInAt: "2026-09-24T09:00:00.000Z",
          reason: "Attendance verified",
        }),
      ),
    ];
    for (const response of responses) {
      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.data).toMatchObject({ id: "attendance", status: "PRESENT" });
      expect(JSON.stringify(json)).not.toMatch(
        /checkInLatitude|checkInLongitude|private-ip|private-credential/,
      );
    }
  });

  it.each(["audit", "events"] as const)(
    "redacts %s list/detail snapshots without altering stored objects",
    async (resource) => {
      const snapshot = {
        status: "PRESENT",
        checkInLatitude: 23.1234567,
        nested: { credentialId: "private-credential", distanceMeters: 1.23456 },
      };
      const row =
        resource === "audit"
          ? { id: "id", previousState: snapshot, newState: snapshot }
          : { id: "id", metadata: snapshot };
      mocks.list.mockResolvedValue([row]);
      mocks.detail.mockResolvedValue(row);
      const values = [
        await listRecords(admin, resource, { page: 1, pageSize: 20 }),
        await getRecord(admin, resource, "id"),
      ];
      for (const value of values) {
        const text = JSON.stringify(value);
        expect(text).toContain("PRESENT");
        expect(text).toContain("[redacted]");
        expect(text).not.toMatch(/23\.1234567|private-credential|1\.23456/);
      }
      expect(snapshot.checkInLatitude).toBe(23.1234567);
    },
  );
});
