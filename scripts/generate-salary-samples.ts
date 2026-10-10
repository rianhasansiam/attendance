import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { salaryStatementDocx } from "../src/modules/salary/docx";
import { calculateSalaryAmounts } from "../src/modules/salary/calculations";
import { salaryStatementFixture } from "../tests/fixtures/salary-statement";

// Run with node --conditions react-server --import tsx scripts/generate-salary-samples.ts [output directory].
async function main() {
  const output = path.resolve(process.argv[2] ?? "test-results/salary-docx");
  await mkdir(output, { recursive: true });
  const standard = path.join(output, "salary-statement-standard.docx");
  const overflow = path.join(
    output,
    "salary-statement-long-name-no-logo-overflow.docx",
  );
  const custom = path.join(
    output,
    "salary-statement-range-pay-2026-09-20-to-2026-09-30.docx",
  );
  const negative = path.join(
    output,
    "salary-statement-long-name-no-logo-signed-overtime.docx",
  );
  await writeFile(
    standard,
    await salaryStatementDocx(salaryStatementFixture()),
  );
  await writeFile(
    overflow,
    await salaryStatementDocx(
      salaryStatementFixture({ rows: 80, longName: true, ongoing: true }),
      { logo: null },
    ),
  );
  await writeFile(
    custom,
    await salaryStatementDocx(
      salaryStatementFixture({
        period: "2026-09",
        from: "2026-09-20",
        to: "2026-09-30",
        monthlyBaseSalary: "18000.00",
        overtimePerRecordedDay: 125,
      }),
    ),
  );
  const signed = salaryStatementFixture({ longName: true, ongoing: true });
  signed.attendance = signed.attendance.map((row, index) => ({
    ...row,
    payableOvertimeMinutes: -row.payableOvertimeMinutes,
    ...(index === 0
      ? {
          checkInAt: `${row.date}T16:00:00.000Z`,
          checkOutAt: "2026-11-01T01:30:00.000Z",
        }
      : {}),
  }));
  signed.payableOvertimeMinutes *= -1;
  signed.summary.payableOvertimeMinutes = signed.payableOvertimeMinutes;
  Object.assign(
    signed,
    calculateSalaryAmounts(
      signed.monthlyBaseSalary,
      signed.overtimeHourlyRate,
      signed.payableOvertimeMinutes,
      signed.payableDays,
    ),
  );
  await writeFile(negative, await salaryStatementDocx(signed, { logo: null }));
  console.log(
    `Generated synthetic salary samples:\n${standard}\n${overflow}\n${custom}\n${negative}`,
  );
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
