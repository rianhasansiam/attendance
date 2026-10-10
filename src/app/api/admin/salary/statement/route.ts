import { api, readJson } from "@/lib/api";
import { DomainError } from "@/lib/errors";
import { assertSameOrigin, rateLimit } from "@/lib/security";
import { salaryExportInputSchema } from "@/modules/salary/contracts";
import { salaryStatementForExport } from "@/modules/salary/service";
import {
  salaryStatementDocx,
  salaryStatementFilename,
  SALARY_DOCX_MIME,
} from "@/modules/salary/docx";
import { requireSalaryAccess } from "../_access";

export function POST(request: Request) {
  return api(async () => {
    const actor = await requireSalaryAccess();
    assertSameOrigin(request);
    await rateLimit(`salary-statement:${actor.id}`, 20, 60);
    const input = await readJson(request, salaryExportInputSchema);
    const statement = await salaryStatementForExport(actor, input);
    let bytes: Buffer;
    try {
      bytes = await salaryStatementDocx(statement);
      if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b)
        throw new Error("Invalid DOCX package");
    } catch {
      throw new DomainError(
        "SALARY_DOCUMENT_FAILED",
        "Unable to generate the salary statement. Recalculate and try downloading again.",
        500,
      );
    }
    const filename = salaryStatementFilename(
      statement.employee.employeeCode,
      statement.period,
      statement.from,
      statement.to,
    );
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": SALARY_DOCX_MIME,
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": String(bytes.length),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
}
