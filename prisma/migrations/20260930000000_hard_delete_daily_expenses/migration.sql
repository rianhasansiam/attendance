-- Deploy with application writers stopped, then regenerate Prisma and restart.
-- Existing soft-deleted transactions are permanently removed. Audit snapshots
-- remain, alongside only the receipt metadata needed to reject creation retries.
BEGIN;
LOCK TABLE "DailyExpenseTransaction" IN ACCESS EXCLUSIVE MODE;

CREATE TABLE "DailyExpenseTransactionDeletion" (
  "transactionId" TEXT NOT NULL,
  "ledgerId" TEXT NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "createdById" TEXT,
  "payloadHash" VARCHAR(64) NOT NULL,
  "deletedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DailyExpenseTransactionDeletion_pkey" PRIMARY KEY ("transactionId"),
  CONSTRAINT "DailyExpenseTransactionDeletion_ledgerId_fkey" FOREIGN KEY ("ledgerId")
    REFERENCES "DailyExpenseLedger"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "DailyExpenseTransactionDeletion_ledgerId_idempotencyKey_key"
  ON "DailyExpenseTransactionDeletion"("ledgerId", "idempotencyKey");

INSERT INTO "DailyExpenseTransactionDeletion"
  ("transactionId", "ledgerId", "idempotencyKey", "createdById", "payloadHash", "deletedAt")
SELECT "id", "ledgerId", "idempotencyKey", "createdById", "payloadHash", "deletedAt"
  FROM "DailyExpenseTransaction" WHERE "deletedAt" IS NOT NULL;
ALTER TABLE "DailyExpenseTransaction" DISABLE TRIGGER "DailyExpenseTransaction_immutable";
ALTER TABLE "DailyExpenseTransaction" DISABLE TRIGGER "DailyExpenseTransaction_immutable_delete";
DELETE FROM "DailyExpenseTransaction" WHERE "deletedAt" IS NOT NULL;
ALTER TABLE "DailyExpenseTransaction" ENABLE TRIGGER "DailyExpenseTransaction_immutable";
ALTER TABLE "DailyExpenseTransaction" ENABLE TRIGGER "DailyExpenseTransaction_immutable_delete";
ALTER TABLE "DailyExpenseTransaction" DROP COLUMN "deletedAt";

CREATE TRIGGER "DailyExpenseTransactionDeletion_immutable"
  BEFORE UPDATE ON "DailyExpenseTransactionDeletion"
  FOR EACH ROW WHEN (NOT allow_deleted_identity_update('DailyExpenseTransactionDeletion', to_jsonb(OLD), to_jsonb(NEW)))
  EXECUTE FUNCTION prevent_history_mutation();
CREATE TRIGGER "DailyExpenseTransactionDeletion_immutable_delete"
  BEFORE DELETE ON "DailyExpenseTransactionDeletion"
  FOR EACH ROW EXECUTE FUNCTION prevent_history_mutation();

CREATE OR REPLACE FUNCTION daily_expense_transaction_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  editor_id TEXT;
BEGIN
  editor_id := current_setting('app.daily_expenses_editor_id', true);
  IF editor_id IS NULL OR editor_id = '' THEN
    RAISE EXCEPTION 'Daily Expenses changes require an authorized editor' USING ERRCODE = '42501';
  END IF;
  PERFORM "id" FROM "User"
    WHERE "id" = editor_id AND "role" = 'SUPER_ADMIN' AND "status" = 'ACTIVE'
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Only active super administrators can change Daily Expenses records' USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'DELETE' THEN
    -- Coordinate with inserts and application retries for the same submission.
    PERFORM pg_advisory_xact_lock(hashtextextended(OLD."ledgerId" || ':' || OLD."idempotencyKey", 0));
    INSERT INTO "DailyExpenseTransactionDeletion"
      ("transactionId", "ledgerId", "idempotencyKey", "createdById", "payloadHash")
    VALUES (OLD."id", OLD."ledgerId", OLD."idempotencyKey", OLD."createdById", OLD."payloadHash");
    RETURN OLD;
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."ledgerId" IS DISTINCT FROM OLD."ledgerId"
    OR NEW."type" IS DISTINCT FROM OLD."type"
    OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
    OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey"
    OR NEW."payloadHash" IS DISTINCT FROM OLD."payloadHash" THEN
    RAISE EXCEPTION 'Daily Expenses transaction identity cannot be changed' USING ERRCODE = '23514';
  END IF;
  IF NEW."version"::bigint <> OLD."version"::bigint + 1 THEN
    RAISE EXCEPTION 'Daily Expenses changes must advance the record version' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION daily_expense_validate_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  ledger_timezone TEXT;
  category_archived BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."version" <> 1 THEN
      RAISE EXCEPTION 'New Daily Expenses records must start at version 1' USING ERRCODE = '23514';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW."ledgerId" || ':' || NEW."idempotencyKey", 0));
    IF EXISTS (
      SELECT 1 FROM "DailyExpenseTransactionDeletion"
      WHERE "transactionId" = NEW."id"
        OR ("ledgerId" = NEW."ledgerId" AND "idempotencyKey" = NEW."idempotencyKey")
    ) THEN
      RAISE EXCEPTION 'Deleted Daily Expenses submissions cannot be recreated' USING ERRCODE = '23514';
    END IF;
  END IF;
  SELECT "timezone" INTO ledger_timezone FROM "DailyExpenseLedger" WHERE "id" = NEW."ledgerId";
  IF ledger_timezone IS NOT NULL AND NEW."date" > (CURRENT_TIMESTAMP AT TIME ZONE ledger_timezone)::date THEN
    RAISE EXCEPTION 'Daily Expenses does not allow future transactions' USING ERRCODE = '23514';
  END IF;
  IF NEW."type" = 'EXPENSE' THEN
    SELECT "archived" INTO category_archived FROM "DailyExpenseCategory"
      WHERE "id" = NEW."categoryId" AND "ledgerId" = NEW."ledgerId" FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'An expense requires a category in its ledger' USING ERRCODE = '23514';
    END IF;
    IF category_archived AND (TG_OP = 'INSERT' OR NEW."categoryId" IS DISTINCT FROM OLD."categoryId") THEN
      RAISE EXCEPTION 'An expense requires an active category in its ledger' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
COMMIT;
