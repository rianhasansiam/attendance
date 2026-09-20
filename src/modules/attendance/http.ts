import { ZodError } from "zod";
import { api, readJson } from "@/lib/api";
import { requireEmployee } from "@/lib/auth";
import { db } from "@/lib/db";
import { DomainError } from "@/lib/errors";
import { assertSameOrigin, rateLimit } from "@/lib/security";
import type { EmployeeActor } from "@/modules/webauthn/service";
import {
  attendanceEvidenceSchema,
  recordAttendance,
  type AttendanceAction,
  type AttendanceEvidence,
} from "./service";

async function logPreflightRejection(
  action: AttendanceAction,
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

export function handleAttendanceRequest(
  request: Request,
  action: AttendanceAction,
) {
  return api(async () => {
    let actor: EmployeeActor | undefined;
    let evidence: AttendanceEvidence;
    try {
      assertSameOrigin(request);
      actor = await requireEmployee();
      await rateLimit(`attendance:${actor.id}`, 15, 60);
      evidence = await readJson(request, attendanceEvidenceSchema);
    } catch (error) {
      await logPreflightRejection(action, actor, error);
      throw error;
    }
    // The domain service owns its transactional success/rejection events. Keeping
    // this call outside the catch ensures those failures are never double logged.
    return recordAttendance(actor, action, evidence, request.headers);
  });
}
