CREATE TYPE "CompanyMoneyTransactionType" AS ENUM ('ADD', 'REMOVE');

CREATE TABLE "CompanyMoneyTransaction" (
  "id" TEXT NOT NULL,
  "requestId" UUID NOT NULL,
  "type" "CompanyMoneyTransactionType" NOT NULL,
  "amount" DECIMAL(12,2) NOT NULL,
  "note" VARCHAR(500),
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CompanyMoneyTransaction_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CompanyMoneyTransaction_amount_positive" CHECK (
    "amount" > 0 AND "amount" != 'NaN'::numeric
  ),
  CONSTRAINT "CompanyMoneyTransaction_createdById_fkey" FOREIGN KEY ("createdById")
    REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "CompanyMoneyTransaction_requestId_key"
  ON "CompanyMoneyTransaction"("requestId");
CREATE INDEX "CompanyMoneyTransaction_createdAt_id_idx"
  ON "CompanyMoneyTransaction"("createdAt" DESC, "id" DESC);
CREATE INDEX "CompanyMoneyTransaction_createdById_idx"
  ON "CompanyMoneyTransaction"("createdById");

-- Share the application lock so all writers, including direct SQL inserts,
-- observe the preceding committed balance before they attempt a withdrawal.
CREATE FUNCTION validate_company_money_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  current_balance NUMERIC;
BEGIN
  -- Waiting for an advisory lock refreshes subsequent statement snapshots only
  -- at READ COMMITTED. Reject older fixed snapshots rather than risk overdraft.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Company money writes require READ COMMITTED isolation'
      USING ERRCODE = '23514';
  END IF;
  PERFORM pg_advisory_xact_lock(187463, 1);
  PERFORM "id" FROM "User" WHERE "id" = NEW."createdById"
    AND "role" = 'SUPER_ADMIN' AND "status" = 'ACTIVE' FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Only an active super administrator may change company money'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."type" = 'REMOVE' THEN
    SELECT COALESCE(SUM(CASE WHEN "type" = 'ADD' THEN "amount" ELSE -"amount" END), 0)
      INTO current_balance FROM "CompanyMoneyTransaction";
    IF NEW."amount" > current_balance THEN
      RAISE EXCEPTION 'Company money balance is insufficient' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "CompanyMoneyTransaction_validate" BEFORE INSERT ON "CompanyMoneyTransaction"
  FOR EACH ROW EXECUTE FUNCTION validate_company_money_transaction();

CREATE FUNCTION preserve_company_money_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- The foreign key may detach a deleted author, preserving every financial fact.
  IF TG_OP = 'UPDATE' AND OLD."createdById" IS NOT NULL AND NEW."createdById" IS NULL
    AND (to_jsonb(NEW) - 'createdById') = (to_jsonb(OLD) - 'createdById')
    AND NULLIF(current_setting('app.deleted_user_id', true), '') = OLD."createdById"
    AND EXISTS (SELECT 1 FROM "User"
      WHERE "id" = NULLIF(current_setting('app.user_deletion_actor_id', true), '')
      AND "role" = 'SUPER_ADMIN' AND "status" = 'ACTIVE')
    AND NOT EXISTS (SELECT 1 FROM "User" WHERE "id" = OLD."createdById") THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Company money history is immutable' USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER "CompanyMoneyTransaction_immutable" BEFORE UPDATE OR DELETE ON "CompanyMoneyTransaction"
  FOR EACH ROW EXECUTE FUNCTION preserve_company_money_transaction();
