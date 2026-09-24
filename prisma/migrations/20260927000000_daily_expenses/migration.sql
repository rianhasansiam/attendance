-- Independent shared cash ledger. No existing business tables or records change.
CREATE TYPE "DailyExpenseTransactionType" AS ENUM ('BALANCE_ADDED', 'EXPENSE');

CREATE TABLE "DailyExpenseLedger" (
  "id" TEXT NOT NULL,
  "workspaceKey" VARCHAR(64) NOT NULL,
  "currency" VARCHAR(3) NOT NULL,
  "timezone" VARCHAR(100) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DailyExpenseLedger_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DailyExpenseLedger_currency_valid" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "DailyExpenseLedger_timezone_valid" CHECK (char_length("timezone") > 0)
);
CREATE UNIQUE INDEX "DailyExpenseLedger_workspaceKey_key" ON "DailyExpenseLedger"("workspaceKey");

CREATE TABLE "DailyExpenseCategory" (
  "id" TEXT NOT NULL,
  "ledgerId" TEXT NOT NULL,
  "name" VARCHAR(80) NOT NULL,
  -- Generated in PostgreSQL, so different callers cannot bypass name uniqueness.
  -- Explicit Unicode case mapping also works when the database uses C locale.
  -- Lowercasing can expand a valid 80-character name (for example dotted I).
  "normalizedName" TEXT GENERATED ALWAYS AS (lower(btrim("name") COLLATE pg_catalog."und-x-icu")) STORED NOT NULL,
  "archived" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DailyExpenseCategory_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DailyExpenseCategory_name_valid" CHECK (
    "name" = btrim("name") AND char_length("name") BETWEEN 1 AND 80
  ),
  CONSTRAINT "DailyExpenseCategory_ledgerId_fkey" FOREIGN KEY ("ledgerId")
    REFERENCES "DailyExpenseLedger"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "DailyExpenseCategory_ledgerId_normalizedName_key" ON "DailyExpenseCategory"("ledgerId", "normalizedName");
CREATE UNIQUE INDEX "DailyExpenseCategory_ledgerId_id_key" ON "DailyExpenseCategory"("ledgerId", "id");
CREATE INDEX "DailyExpenseCategory_ledgerId_archived_name_idx" ON "DailyExpenseCategory"("ledgerId", "archived", "name");

CREATE TABLE "DailyExpenseTransaction" (
  "id" TEXT NOT NULL,
  "ledgerId" TEXT NOT NULL,
  "type" "DailyExpenseTransactionType" NOT NULL,
  "amount" DECIMAL(18,2) NOT NULL,
  "categoryId" TEXT,
  "date" DATE NOT NULL,
  "note" VARCHAR(1000),
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "payloadHash" VARCHAR(64) NOT NULL,
  CONSTRAINT "DailyExpenseTransaction_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DailyExpenseTransaction_amount_valid" CHECK (
    "amount" > 0 AND "amount" < 'Infinity'::numeric AND "amount" <> 'NaN'::numeric
  ),
  CONSTRAINT "DailyExpenseTransaction_category_valid" CHECK (
    ("type" = 'EXPENSE' AND "categoryId" IS NOT NULL)
    OR ("type" = 'BALANCE_ADDED' AND "categoryId" IS NULL)
  ),
  CONSTRAINT "DailyExpenseTransaction_date_valid" CHECK ("date" >= DATE '0001-01-01'),
  CONSTRAINT "DailyExpenseTransaction_idempotency_valid" CHECK (
    char_length("idempotencyKey") BETWEEN 16 AND 128
    AND "idempotencyKey" ~ '^[A-Za-z0-9_-]+$'
    AND "payloadHash" ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT "DailyExpenseTransaction_ledgerId_fkey" FOREIGN KEY ("ledgerId")
    REFERENCES "DailyExpenseLedger"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "DailyExpenseTransaction_ledgerId_categoryId_fkey" FOREIGN KEY ("ledgerId", "categoryId")
    REFERENCES "DailyExpenseCategory"("ledgerId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "DailyExpenseTransaction_createdById_fkey" FOREIGN KEY ("createdById")
    REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "DailyExpenseTransaction_ledgerId_idempotencyKey_key" ON "DailyExpenseTransaction"("ledgerId", "idempotencyKey");
CREATE INDEX "DailyExpenseTransaction_ledgerId_date_createdAt_id_idx" ON "DailyExpenseTransaction"("ledgerId", "date" DESC, "createdAt" DESC, "id" DESC);
CREATE INDEX "DailyExpenseTransaction_ledgerId_type_date_idx" ON "DailyExpenseTransaction"("ledgerId", "type", "date" DESC);
CREATE INDEX "DailyExpenseTransaction_ledgerId_categoryId_date_idx" ON "DailyExpenseTransaction"("ledgerId", "categoryId", "date" DESC);
CREATE INDEX "DailyExpenseTransaction_createdById_idx" ON "DailyExpenseTransaction"("createdById");

-- No configuration mutation API exists. Fixing configuration from ledger creation
-- also closes the race between a first entry and a configuration change.
CREATE FUNCTION daily_expense_ledger_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Daily Expenses ledger configuration is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "DailyExpenseLedger_immutable" BEFORE UPDATE ON "DailyExpenseLedger"
  FOR EACH ROW EXECUTE FUNCTION daily_expense_ledger_immutable();

-- Shared row locks allow concurrent expenses while serializing with category
-- archive/rename writes. Checking without this lock would permit archive races.
CREATE FUNCTION daily_expense_validate_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  ledger_timezone TEXT;
  category_archived BOOLEAN;
BEGIN
  SELECT "timezone" INTO ledger_timezone FROM "DailyExpenseLedger" WHERE "id" = NEW."ledgerId";
  IF ledger_timezone IS NOT NULL AND NEW."date" > (CURRENT_TIMESTAMP AT TIME ZONE ledger_timezone)::date THEN
    RAISE EXCEPTION 'Daily Expenses does not allow future transactions' USING ERRCODE = '23514';
  END IF;
  IF NEW."type" = 'EXPENSE' THEN
    SELECT "archived" INTO category_archived FROM "DailyExpenseCategory"
      WHERE "id" = NEW."categoryId" AND "ledgerId" = NEW."ledgerId" FOR SHARE;
    IF NOT FOUND OR category_archived THEN
      RAISE EXCEPTION 'An expense requires an active category in its ledger' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "DailyExpenseTransaction_validate" BEFORE INSERT ON "DailyExpenseTransaction"
  FOR EACH ROW EXECUTE FUNCTION daily_expense_validate_transaction();

CREATE FUNCTION daily_expense_transaction_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Posted Daily Expenses transactions cannot be changed or deleted' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER "DailyExpenseTransaction_immutable" BEFORE UPDATE OR DELETE ON "DailyExpenseTransaction"
  FOR EACH ROW EXECUTE FUNCTION daily_expense_transaction_immutable();
