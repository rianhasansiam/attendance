CREATE TABLE "SalarySetting" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT,
    "effectiveMonth" DATE NOT NULL,
    "revision" INTEGER NOT NULL,
    "baseSalary" DECIMAL(18,2) NOT NULL,
    "overtimeHourlyRate" DECIMAL(18,2) NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SalarySetting_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SalarySetting_nonnegative_amounts" CHECK (
        "baseSalary" >= 0 AND "overtimeHourlyRate" >= 0
        AND "baseSalary" != 'NaN'::numeric AND "overtimeHourlyRate" != 'NaN'::numeric
    ),
    CONSTRAINT "SalarySetting_positive_revision" CHECK ("revision" > 0),
    CONSTRAINT "SalarySetting_month_start" CHECK (EXTRACT(DAY FROM "effectiveMonth") = 1)
);

CREATE UNIQUE INDEX "SalarySetting_employeeId_effectiveMonth_revision_key" ON "SalarySetting"("employeeId", "effectiveMonth", "revision");
CREATE INDEX "SalarySetting_employeeId_effectiveMonth_revision_idx" ON "SalarySetting"("employeeId", "effectiveMonth" DESC, "revision" DESC);
CREATE INDEX "SalarySetting_createdById_idx" ON "SalarySetting"("createdById");

ALTER TABLE "SalarySetting" ADD CONSTRAINT "SalarySetting_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SalarySetting" ADD CONSTRAINT "SalarySetting_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Keep financial history append-only while allowing the established hard-delete
-- workflows to clear employee/actor references through ON DELETE SET NULL.
CREATE FUNCTION "preserve_salary_setting_revision"() RETURNS TRIGGER AS $$
BEGIN
    IF (NEW."id", NEW."effectiveMonth", NEW."revision", NEW."baseSalary", NEW."overtimeHourlyRate", NEW."createdAt")
        IS DISTINCT FROM
       (OLD."id", OLD."effectiveMonth", OLD."revision", OLD."baseSalary", OLD."overtimeHourlyRate", OLD."createdAt")
       OR (NEW."employeeId" IS DISTINCT FROM OLD."employeeId" AND NEW."employeeId" IS NOT NULL)
       OR (NEW."createdById" IS DISTINCT FROM OLD."createdById" AND NEW."createdById" IS NOT NULL) THEN
        RAISE EXCEPTION 'Salary settings are immutable; create a new revision';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "SalarySetting_preserve_revision" BEFORE UPDATE ON "SalarySetting"
FOR EACH ROW EXECUTE FUNCTION "preserve_salary_setting_revision"();
