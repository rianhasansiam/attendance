-- Existing records start at version 1. Keep creation identity and safe retry
-- metadata immutable while allowing audited super-administrator corrections.
ALTER TABLE "DailyExpenseTransaction"
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD CONSTRAINT "DailyExpenseTransaction_version_valid" CHECK ("version" > 0);

CREATE OR REPLACE FUNCTION daily_expense_transaction_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  editor_id TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Posted Daily Expenses transactions cannot be deleted' USING ERRCODE = '23514';
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
    RAISE EXCEPTION 'Daily Expenses edits must advance the record version' USING ERRCODE = '23514';
  END IF;

  editor_id := current_setting('app.daily_expenses_editor_id', true);
  IF editor_id IS NULL OR editor_id = '' THEN
    RAISE EXCEPTION 'Daily Expenses edits require an authorized editor' USING ERRCODE = '42501';
  END IF;
  -- Shared locks conflict with account role/status updates until this financial
  -- transaction commits. Session state alone cannot authorize a stale actor.
  PERFORM "id" FROM "User"
    WHERE "id" = editor_id AND "role" = 'SUPER_ADMIN' AND "status" = 'ACTIVE'
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Only active super administrators can edit Daily Expenses records' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION daily_expense_validate_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  ledger_timezone TEXT;
  category_archived BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' AND NEW."version" <> 1 THEN
    RAISE EXCEPTION 'New Daily Expenses transactions must start at version 1' USING ERRCODE = '23514';
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
    -- Archived historical categories may be retained during a correction.
    -- New expenses and changes of category always require an active category.
    IF category_archived AND (TG_OP = 'INSERT' OR NEW."categoryId" IS DISTINCT FROM OLD."categoryId") THEN
      RAISE EXCEPTION 'An expense requires an active category in its ledger' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER "DailyExpenseTransaction_validate" ON "DailyExpenseTransaction";
CREATE TRIGGER "DailyExpenseTransaction_validate" BEFORE INSERT OR UPDATE ON "DailyExpenseTransaction"
  FOR EACH ROW EXECUTE FUNCTION daily_expense_validate_transaction();
