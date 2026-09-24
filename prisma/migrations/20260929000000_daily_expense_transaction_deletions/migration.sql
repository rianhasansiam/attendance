-- Preserve posted rows and submission keys for auditing and safe retries.
-- Application totals and history ignore rows after their audited deletion.
ALTER TABLE "DailyExpenseTransaction"
  ADD COLUMN "deletedAt" TIMESTAMP(3);

CREATE OR REPLACE FUNCTION daily_expense_transaction_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  editor_id TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Daily Expenses records cannot be permanently deleted' USING ERRCODE = '23514';
  END IF;
  IF OLD."deletedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'Deleted Daily Expenses records cannot be changed or restored' USING ERRCODE = '23514';
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
  IF NEW."deletedAt" IS NOT NULL AND (
    NEW."amount" IS DISTINCT FROM OLD."amount"
    OR NEW."date" IS DISTINCT FROM OLD."date"
    OR NEW."note" IS DISTINCT FROM OLD."note"
    OR NEW."categoryId" IS DISTINCT FROM OLD."categoryId"
  ) THEN
    RAISE EXCEPTION 'Deleting a Daily Expenses record cannot also change its financial details' USING ERRCODE = '23514';
  END IF;
  IF NEW."version"::bigint <> OLD."version"::bigint + 1 THEN
    RAISE EXCEPTION 'Daily Expenses changes must advance the record version' USING ERRCODE = '23514';
  END IF;

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
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION daily_expense_validate_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  ledger_timezone TEXT;
  category_archived BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."version" <> 1 OR NEW."deletedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'New Daily Expenses records must be active and start at version 1' USING ERRCODE = '23514';
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
    -- Existing categories, including archived ones, remain attached to edits
    -- and deletions; changing the category still requires an active choice.
    IF category_archived AND (TG_OP = 'INSERT' OR NEW."categoryId" IS DISTINCT FROM OLD."categoryId") THEN
      RAISE EXCEPTION 'An expense requires an active category in its ledger' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
