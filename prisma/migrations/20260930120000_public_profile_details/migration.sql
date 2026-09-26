BEGIN;

ALTER TABLE "User"
  ADD COLUMN "designation" TEXT,
  ADD COLUMN "phone" TEXT,
  ADD COLUMN "bloodGroup" TEXT,
  ADD COLUMN "publicDepartment" TEXT,
  ADD COLUMN "homeAddress" TEXT,
  ADD COLUMN "dateOfBirth" DATE,
  ADD CONSTRAINT "User_bloodGroup_valid" CHECK (
    "bloodGroup" IS NULL OR "bloodGroup" IN ('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-')
  );

-- Preserve the currently displayed department, then let Super Admin manage
-- public details independently from internal attendance assignments.
UPDATE "User" AS u
SET "publicDepartment" = d."name"
FROM "Employee" AS e
JOIN "Department" AS d ON d."id" = e."departmentId"
WHERE e."userId" = u."id";

COMMIT;
