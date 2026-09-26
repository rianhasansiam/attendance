import { ZodError } from "zod";
import { api, readJson } from "@/lib/api";
import { requireEmployee } from "@/lib/auth";
import { db } from "@/lib/db";
import { DomainError } from "@/lib/errors";
import { assertSameOrigin, rateLimit } from "@/lib/security";
import { measureServerTiming, requestServerTiming } from "@/lib/server-timing";
import type { EmployeeActor } from "@/modules/webauthn/service";
import {
  attendanceEvidenceSchema,
  lateReasonSchema,
  recordAttendance,
  saveLateReason,
  type AttendanceAction,
  type AttendanceEvidence,
} from "./service";

async function logAttendanceRejection(
  action: AttendanceAction | "LATE_REASON",
  actor: EmployeeActor | undefined,
  error: unknown,
) {
  try {
    // Anonymous traffic shares a small global logging budget; an attacker cannot
    // manufacture unbounded event rows or rate-limit keys with request fields.
    await rateLimit(
      actor
        ? `attendance-rejection:${actor.id}`
        : "attendance-rejection:anonymous",
      actor ? 30 : 10,
      60,
    );
    const reason =
      error instanceof DomainError
        ? error.code
        : error instanceof ZodError
          ? "VALIDATION_ERROR"
          : "INTERNAL_ERROR";
    await db.attendanceEvent.create({
      data: {
        employeeId: actor?.employee.id ?? null,
        type: `${action}_REJECTED`,
        reason,
      },
    });
  } catch (loggingError) {
    if (!(
      loggingError instanceof DomainError &&
      loggingError.code === "RATE_LIMITED"
    )) {
      console.error("Attendance rejection logging failed", {
        category:
          loggingError instanceof Error ? loggingError.name : "UnknownError",
      });
    }
    // Logging failure cannot replace or relax the original request denial.
  }
}

export async function handleAttendanceRequest(
  request: Request,
  action: AttendanceAction,
) {
  const timing = requestServerTiming(request);
  const response = await api(async () => {
    let actor: EmployeeActor | undefined;
    let evidence: AttendanceEvidence;
    try {
      assertSameOrigin(request);
      actor = await measureServerTiming(timing, "auth", requireEmployee);
      const rateLimitKey = `attendance:${actor.id}`;
      await measureServerTiming(timing, "rate_limit", () =>
        rateLimit(rateLimitKey, 15, 60),
      );
      evidence = await readJson(request, attendanceEvidenceSchema);
    } catch (error) {
      await logAttendanceRejection(action, actor, error);
      throw error;
    }
    // The domain service owns its transactional success/rejection events. Keeping
    // this call outside the catch ensures those failures are never double logged.
    return recordAttendance(actor, action, evidence, request.headers, timing);
  });
  return timing?.apply(response) ?? response;
}

export function handleLateReasonRequest(request: Request) {
  return api(async () => {
    let actor: EmployeeActor | undefined;
    try {
      assertSameOrigin(request);
      actor = await requireEmployee();
      await rateLimit(`attendance-late-reason:${actor.id}`, 15, 60);
      const input = await readJson(request, lateReasonSchema);
      return await saveLateReason(actor, input);
    } catch (error) {
      await logAttendanceRejection("LATE_REASON", actor, error);
      throw error;
    }
  });
}
