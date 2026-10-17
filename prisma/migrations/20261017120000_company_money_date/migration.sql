BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE "CompanyMoneyTransaction" ADD COLUMN "date" DATE;

-- Prisma stores createdAt as a UTC timestamp without a time zone. Backfill its
-- company-local calendar day without changing any existing financial facts.
-- ALTER TABLE holds an exclusive lock until COMMIT, so no concurrent writer can
-- use the brief, table-scoped immutability exception.
ALTER TABLE "CompanyMoneyTransaction" DISABLE TRIGGER "CompanyMoneyTransaction_immutable";
UPDATE "CompanyMoneyTransaction"
SET "date" = (("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Dhaka')::date;
ALTER TABLE "CompanyMoneyTransaction" ENABLE TRIGGER "CompanyMoneyTransaction_immutable";

-- Keep older deployed application instances compatible during the rollout.
ALTER TABLE "CompanyMoneyTransaction"
  ALTER COLUMN "date" SET DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Dhaka')::date,
  ALTER COLUMN "date" SET NOT NULL;

DROP INDEX "CompanyMoneyTransaction_createdAt_id_idx";
CREATE INDEX "CompanyMoneyTransaction_date_createdAt_id_idx"
  ON "CompanyMoneyTransaction"("date" DESC, "createdAt" DESC, "id" DESC);

COMMIT;
