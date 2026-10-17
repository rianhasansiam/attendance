BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE "CompanyMoneyTransaction" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "CompanyMoneyTransaction" ADD CONSTRAINT "CompanyMoneyTransaction_positive_version" CHECK ("version" > 0);

CREATE TYPE "CompanyMoneyMutationOperation" AS ENUM ('CREATE', 'UPDATE', 'DELETE');
CREATE TABLE "CompanyMoneyMutationReceipt" (
  "requestId" UUID NOT NULL,
  "operation" "CompanyMoneyMutationOperation" NOT NULL,
  "transactionId" TEXT NOT NULL,
  "actorId" TEXT,
  "payload" JSONB NOT NULL,
  "resultVersion" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CompanyMoneyMutationReceipt_pkey" PRIMARY KEY ("requestId"),
  CONSTRAINT "CompanyMoneyMutationReceipt_positive_version" CHECK ("resultVersion" > 0),
  CONSTRAINT "CompanyMoneyMutationReceipt_payload_object" CHECK (jsonb_typeof("payload") = 'object'),
  CONSTRAINT "CompanyMoneyMutationReceipt_actorId_fkey" FOREIGN KEY ("actorId")
    REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "CompanyMoneyMutationReceipt_transactionId_idx" ON "CompanyMoneyMutationReceipt"("transactionId");
CREATE INDEX "CompanyMoneyMutationReceipt_actorId_idx" ON "CompanyMoneyMutationReceipt"("actorId");

-- Preserve original submissions before enabling edits/deletes. No business facts
-- or creation timestamps are changed by this migration.
INSERT INTO "CompanyMoneyMutationReceipt"
  ("requestId", "operation", "transactionId", "actorId", "payload", "resultVersion", "createdAt")
SELECT "requestId", 'CREATE', "id", "createdById",
  jsonb_build_object('type', "type", 'amount', "amount"::text,
    'date', to_char("date", 'YYYY-MM-DD'), 'note', "note"),
  "version", "createdAt"
FROM "CompanyMoneyTransaction";

CREATE FUNCTION preserve_company_money_mutation_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."actorId" IS NOT NULL AND NEW."actorId" IS NULL
    AND (to_jsonb(NEW) - 'actorId') = (to_jsonb(OLD) - 'actorId')
    AND NULLIF(current_setting('app.deleted_user_id', true), '') = OLD."actorId"
    AND EXISTS (SELECT 1 FROM "User"
      WHERE "id" = NULLIF(current_setting('app.user_deletion_actor_id', true), '')
      AND "role" = 'SUPER_ADMIN' AND "status" = 'ACTIVE')
    AND NOT EXISTS (SELECT 1 FROM "User" WHERE "id" = OLD."actorId") THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Company money mutation receipts are immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER "CompanyMoneyMutationReceipt_immutable" BEFORE UPDATE OR DELETE ON "CompanyMoneyMutationReceipt"
  FOR EACH ROW EXECUTE FUNCTION preserve_company_money_mutation_receipt();

CREATE OR REPLACE FUNCTION validate_company_money_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  current_balance NUMERIC;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Company money writes require READ COMMITTED isolation' USING ERRCODE = '23514';
  END IF;
  PERFORM pg_advisory_xact_lock(187463, 1);
  PERFORM "id" FROM "User" WHERE "id" = NEW."createdById"
    AND "role" = 'SUPER_ADMIN' AND "status" = 'ACTIVE' FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Only an active super administrator may change company money' USING ERRCODE = '23514';
  END IF;
  IF NEW."version" <> 1 THEN
    RAISE EXCEPTION 'New company money records must start at version 1' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM "CompanyMoneyMutationReceipt"
    WHERE "requestId" = NEW."requestId"
      OR ("transactionId" = NEW."id" AND "operation" = 'CREATE')) THEN
    RAISE EXCEPTION 'Existing company money submissions cannot be recreated' USING ERRCODE = '23514';
  END IF;
  IF NEW."type" = 'REMOVE' THEN
    SELECT COALESCE(SUM(CASE WHEN "type" = 'ADD' THEN "amount" ELSE -"amount" END), 0)
      INTO current_balance FROM "CompanyMoneyTransaction";
    IF NEW."amount" > current_balance THEN
      RAISE EXCEPTION 'Company money balance is insufficient' USING ERRCODE = '23514';
    END IF;
  END IF;
  INSERT INTO "CompanyMoneyMutationReceipt"
    ("requestId", "operation", "transactionId", "actorId", "payload", "resultVersion")
  VALUES (NEW."requestId", 'CREATE', NEW."id", NEW."createdById",
    jsonb_build_object('type', NEW."type", 'amount', NEW."amount"::text,
      'date', to_char(NEW."date", 'YYYY-MM-DD'), 'note', NEW."note"), 1);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION preserve_company_money_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  editor_id TEXT;
  projected_balance NUMERIC;
BEGIN
  -- Account deletion may detach the original author at any isolation level.
  IF TG_OP = 'UPDATE' AND OLD."createdById" IS NOT NULL AND NEW."createdById" IS NULL
    AND (to_jsonb(NEW) - 'createdById') = (to_jsonb(OLD) - 'createdById')
    AND NULLIF(current_setting('app.deleted_user_id', true), '') = OLD."createdById"
    AND EXISTS (SELECT 1 FROM "User"
      WHERE "id" = NULLIF(current_setting('app.user_deletion_actor_id', true), '')
      AND "role" = 'SUPER_ADMIN' AND "status" = 'ACTIVE')
    AND NOT EXISTS (SELECT 1 FROM "User" WHERE "id" = OLD."createdById") THEN
    RETURN NEW;
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Company money writes require READ COMMITTED isolation' USING ERRCODE = '23514';
  END IF;
  PERFORM pg_advisory_xact_lock(187463, 1);
  editor_id := NULLIF(current_setting('app.company_money_editor_id', true), '');
  PERFORM "id" FROM "User" WHERE "id" = editor_id
    AND "role" = 'SUPER_ADMIN' AND "status" = 'ACTIVE' FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Company money changes require an active super administrator editor' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW."id", NEW."requestId", NEW."createdById", NEW."createdAt") IS DISTINCT FROM
      (OLD."id", OLD."requestId", OLD."createdById", OLD."createdAt") THEN
      RAISE EXCEPTION 'Company money transaction identity cannot change' USING ERRCODE = '23514';
    END IF;
    IF NEW."version"::bigint <> OLD."version"::bigint + 1 THEN
      RAISE EXCEPTION 'Company money changes must advance the record version' USING ERRCODE = '23514';
    END IF;
  END IF;
  SELECT COALESCE(SUM(CASE WHEN "type" = 'ADD' THEN "amount" ELSE -"amount" END), 0)
    - CASE WHEN OLD."type" = 'ADD' THEN OLD."amount" ELSE -OLD."amount" END
    INTO projected_balance FROM "CompanyMoneyTransaction";
  IF TG_OP = 'UPDATE' THEN
    projected_balance := projected_balance + CASE WHEN NEW."type" = 'ADD' THEN NEW."amount" ELSE -NEW."amount" END;
  END IF;
  IF projected_balance < 0 THEN
    RAISE EXCEPTION 'Company money balance is insufficient' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

COMMIT;
