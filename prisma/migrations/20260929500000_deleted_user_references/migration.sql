-- Detach deleted identities while preserving attendance, financial and audit facts.
-- This migration also works before the optional Daily Expenses hard-delete
-- migration: it does not remove any existing soft-deleted financial records.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';

CREATE FUNCTION redact_deleted_identity(value JSONB, identity_context BOOLEAN DEFAULT FALSE)
RETURNS JSONB LANGUAGE plpgsql STABLE AS $$
DECLARE
  deleted_user TEXT := NULLIF(current_setting('app.deleted_user_id', true), '');
  deleted_employee TEXT := NULLIF(current_setting('app.deleted_employee_id', true), '');
  identity_object BOOLEAN;
  entry RECORD;
  result JSONB;
BEGIN
  IF value IS NULL THEN RETURN NULL; END IF;
  IF jsonb_typeof(value) = 'string' THEN
    IF (deleted_user IS NOT NULL AND value = to_jsonb(deleted_user))
      OR (deleted_employee IS NOT NULL AND value = to_jsonb(deleted_employee)) THEN
      RETURN '"deleted info"'::jsonb;
    END IF;
    RETURN value;
  ELSIF jsonb_typeof(value) = 'array' THEN
    SELECT COALESCE(jsonb_agg(redact_deleted_identity(item, identity_context) ORDER BY ordinal), '[]'::jsonb)
      INTO result FROM jsonb_array_elements(value) WITH ORDINALITY AS elements(item, ordinal);
    RETURN result;
  ELSIF jsonb_typeof(value) <> 'object' THEN
    RETURN value;
  END IF;

  identity_object := identity_context
    OR (deleted_user IS NOT NULL AND (
      value->>'id' = deleted_user OR value->>'userId' = deleted_user))
    OR (deleted_employee IS NOT NULL AND (
      value->>'id' = deleted_employee OR value->>'employeeId' = deleted_employee));
  result := '{}'::jsonb;
  FOR entry IN SELECT key, val FROM jsonb_each(value) AS properties(key, val) LOOP
    IF identity_object AND entry.key = ANY(ARRAY[
      'name', 'email', 'image', 'employeeCode', 'googleAccountId',
      'passwordHash', 'emailVerified', 'lastLoginAt'
    ]) AND entry.val <> 'null'::jsonb THEN
      result := result || jsonb_build_object(entry.key, 'deleted info');
    ELSE
      result := result || jsonb_build_object(entry.key,
        redact_deleted_identity(entry.val,
          COALESCE(identity_object, FALSE) AND entry.key = ANY(ARRAY['user', 'employee'])));
    END IF;
  END LOOP;
  RETURN result;
END;
$$;

-- Only the deletion transaction may make these exact identity-only changes.
-- Every field not listed below must remain byte-for-byte equivalent as JSONB;
-- in particular transaction amounts, versions and historical timestamps stay.
CREATE FUNCTION allow_deleted_identity_update(table_name TEXT, old_row JSONB, new_row JSONB)
RETURNS BOOLEAN LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  deleted_user TEXT := NULLIF(current_setting('app.deleted_user_id', true), '');
  deleted_employee TEXT := NULLIF(current_setting('app.deleted_employee_id', true), '');
  deletion_actor TEXT := NULLIF(current_setting('app.user_deletion_actor_id', true), '');
  identity_column TEXT;
  identity_id TEXT;
  json_columns TEXT[] := ARRAY[]::TEXT[];
  column_name TEXT;
  expected JSONB := old_row;
BEGIN
  IF deleted_user IS NULL OR deletion_actor IS NULL OR deleted_user = deletion_actor
    OR old_row IS NOT DISTINCT FROM new_row THEN RETURN FALSE; END IF;
  PERFORM "id" FROM "User"
    WHERE "id" = deletion_actor AND "role" = 'SUPER_ADMIN' AND "status" = 'ACTIVE'
    FOR SHARE;
  IF NOT FOUND THEN RETURN FALSE; END IF;

  CASE table_name
    WHEN 'AuditLog' THEN
      identity_column := 'actorId'; identity_id := deleted_user;
      json_columns := ARRAY['previousState', 'newState'];
    WHEN 'AttendanceEvent' THEN
      identity_column := 'employeeId'; identity_id := deleted_employee;
      json_columns := ARRAY['metadata'];
    WHEN 'DailyExpenseTransaction', 'DailyExpenseTransactionDeletion' THEN
      identity_column := 'createdById'; identity_id := deleted_user;
    WHEN 'LateApprovalRequest' THEN
      identity_column := 'reviewedById'; identity_id := deleted_user;
    ELSE RETURN FALSE;
  END CASE;

  IF old_row->identity_column IS DISTINCT FROM new_row->identity_column THEN
    IF identity_id IS NULL OR old_row->>identity_column IS DISTINCT FROM identity_id
      OR new_row->identity_column IS DISTINCT FROM 'null'::jsonb THEN RETURN FALSE; END IF;
    expected := expected || jsonb_build_object(identity_column, NULL);
  END IF;
  FOREACH column_name IN ARRAY json_columns LOOP
    IF old_row->column_name IS DISTINCT FROM new_row->column_name THEN
      IF new_row->column_name IS DISTINCT FROM redact_deleted_identity(old_row->column_name)
        THEN RETURN FALSE; END IF;
      expected := expected || jsonb_build_object(column_name, new_row->column_name);
    END IF;
  END LOOP;
  RETURN expected = new_row;
END;
$$;

-- Split UPDATE/DELETE triggers so unchanged history remains immutable and the
-- identity-only exception cannot authorize DELETE of a historical record.
DROP TRIGGER "AuditLog_immutable" ON "AuditLog";
CREATE TRIGGER "AuditLog_immutable" BEFORE UPDATE ON "AuditLog"
  FOR EACH ROW WHEN (NOT allow_deleted_identity_update('AuditLog', to_jsonb(OLD), to_jsonb(NEW)))
  EXECUTE FUNCTION prevent_history_mutation();
CREATE TRIGGER "AuditLog_immutable_delete" BEFORE DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION prevent_history_mutation();
DROP TRIGGER "AttendanceEvent_immutable" ON "AttendanceEvent";
CREATE TRIGGER "AttendanceEvent_immutable" BEFORE UPDATE ON "AttendanceEvent"
  FOR EACH ROW WHEN (NOT allow_deleted_identity_update('AttendanceEvent', to_jsonb(OLD), to_jsonb(NEW)))
  EXECUTE FUNCTION prevent_history_mutation();
CREATE TRIGGER "AttendanceEvent_immutable_delete" BEFORE DELETE ON "AttendanceEvent"
  FOR EACH ROW EXECUTE FUNCTION prevent_history_mutation();
DROP TRIGGER "DailyExpenseTransaction_immutable" ON "DailyExpenseTransaction";
CREATE TRIGGER "DailyExpenseTransaction_immutable" BEFORE UPDATE ON "DailyExpenseTransaction"
  FOR EACH ROW WHEN (NOT allow_deleted_identity_update('DailyExpenseTransaction', to_jsonb(OLD), to_jsonb(NEW)))
  EXECUTE FUNCTION daily_expense_transaction_immutable();
CREATE TRIGGER "DailyExpenseTransaction_immutable_delete" BEFORE DELETE ON "DailyExpenseTransaction"
  FOR EACH ROW EXECUTE FUNCTION daily_expense_transaction_immutable();
DROP TRIGGER "DailyExpenseTransaction_validate" ON "DailyExpenseTransaction";
CREATE TRIGGER "DailyExpenseTransaction_validate" BEFORE UPDATE ON "DailyExpenseTransaction"
  FOR EACH ROW WHEN (NOT allow_deleted_identity_update('DailyExpenseTransaction', to_jsonb(OLD), to_jsonb(NEW)))
  EXECUTE FUNCTION daily_expense_validate_transaction();
CREATE TRIGGER "DailyExpenseTransaction_validate_insert" BEFORE INSERT ON "DailyExpenseTransaction"
  FOR EACH ROW EXECUTE FUNCTION daily_expense_validate_transaction();

ALTER TABLE "EmployeeShift" ALTER COLUMN "employeeId" DROP NOT NULL;
ALTER TABLE "Attendance" ALTER COLUMN "employeeId" DROP NOT NULL;
ALTER TABLE "Leave" ALTER COLUMN "employeeId" DROP NOT NULL;
ALTER TABLE "DriveCost" ALTER COLUMN "createdById" DROP NOT NULL;
ALTER TABLE "DailyExpenseTransaction" ALTER COLUMN "createdById" DROP NOT NULL;

ALTER TABLE "EmployeeShift" DROP CONSTRAINT "EmployeeShift_employeeId_fkey",
  ADD CONSTRAINT "EmployeeShift_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Attendance" DROP CONSTRAINT "Attendance_employeeId_fkey",
  ADD CONSTRAINT "Attendance_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Leave" DROP CONSTRAINT "Leave_employeeId_fkey",
  ADD CONSTRAINT "Leave_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AttendanceEvent" DROP CONSTRAINT "AttendanceEvent_employeeId_fkey",
  ADD CONSTRAINT "AttendanceEvent_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DriveCost" DROP CONSTRAINT "DriveCost_createdById_fkey",
  ADD CONSTRAINT "DriveCost_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DailyExpenseTransaction" DROP CONSTRAINT "DailyExpenseTransaction_createdById_fkey",
  ADD CONSTRAINT "DailyExpenseTransaction_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AuditLog" DROP CONSTRAINT "AuditLog_actorId_fkey",
  ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LateApprovalRequest" DROP CONSTRAINT "LateApprovalRequest_reviewedById_fkey",
  ADD CONSTRAINT "LateApprovalRequest_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Reviewed requests retain their decision and timestamp after the reviewer is
-- deleted. New reviews still require a reviewer; only the scoped deletion
-- transaction can detach that identity from an otherwise unchanged decision.
ALTER TABLE "LateApprovalRequest" DROP CONSTRAINT "LateApprovalRequest_review_valid",
  ADD CONSTRAINT "LateApprovalRequest_review_valid" CHECK (
    ("status" = 'PENDING' AND "reviewedById" IS NULL AND "reviewedAt" IS NULL AND "reviewNote" IS NULL)
    OR ("status" <> 'PENDING' AND "reviewedAt" IS NOT NULL)
  );
CREATE FUNCTION late_approval_preserve_reviewer() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" <> 'PENDING' AND NEW."reviewedById" IS NULL THEN
    IF TG_OP = 'INSERT' THEN
      RAISE EXCEPTION 'A reviewed request requires a reviewer' USING ERRCODE = '23514';
    ELSIF NOT allow_deleted_identity_update('LateApprovalRequest', to_jsonb(OLD), to_jsonb(NEW)) THEN
      RAISE EXCEPTION 'A reviewed request requires a reviewer' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "LateApprovalRequest_preserve_reviewer" BEFORE INSERT OR UPDATE ON "LateApprovalRequest"
  FOR EACH ROW EXECUTE FUNCTION late_approval_preserve_reviewer();

-- A deployment may already have upgraded Daily Expenses, or may still retain
-- its soft-deletion column. Do not require or apply that independent migration.
DO $$
BEGIN
  IF to_regclass('"DailyExpenseTransactionDeletion"') IS NOT NULL THEN
    ALTER TABLE "DailyExpenseTransactionDeletion" ALTER COLUMN "createdById" DROP NOT NULL;
    DROP TRIGGER "DailyExpenseTransactionDeletion_immutable" ON "DailyExpenseTransactionDeletion";
    CREATE TRIGGER "DailyExpenseTransactionDeletion_immutable" BEFORE UPDATE ON "DailyExpenseTransactionDeletion"
      FOR EACH ROW WHEN (NOT allow_deleted_identity_update('DailyExpenseTransactionDeletion', to_jsonb(OLD), to_jsonb(NEW)))
      EXECUTE FUNCTION prevent_history_mutation();
    CREATE TRIGGER "DailyExpenseTransactionDeletion_immutable_delete" BEFORE DELETE ON "DailyExpenseTransactionDeletion"
      FOR EACH ROW EXECUTE FUNCTION prevent_history_mutation();
  END IF;
END;
$$;
COMMIT;
