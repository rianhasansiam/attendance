BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE "WorkReport" (
  "id" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "requestId" UUID NOT NULL,
  "createPayloadHash" VARCHAR(64) NOT NULL,
  "authorId" TEXT,
  "title" VARCHAR(200),
  "content" VARCHAR(10000) NOT NULL,
  "workDate" DATE NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "deletedAt" TIMESTAMP(3),
  CONSTRAINT "WorkReport_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WorkReport_content_valid" CHECK (length(btrim("content")) > 0),
  CONSTRAINT "WorkReport_version_valid" CHECK ("version" > 0),
  CONSTRAINT "WorkReport_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "WorkReport_requestId_key" ON "WorkReport"("requestId");
CREATE INDEX "WorkReport_deletedAt_workDate_createdAt_id_idx" ON "WorkReport"("deletedAt", "workDate", "createdAt" DESC, "id" DESC);
CREATE INDEX "WorkReport_authorId_deletedAt_workDate_createdAt_id_idx" ON "WorkReport"("authorId", "deletedAt", "workDate", "createdAt" DESC, "id" DESC);

CREATE FUNCTION work_report_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  actor_id TEXT := NULLIF(current_setting('app.work_report_actor_id', true), '');
  deleted_user TEXT := NULLIF(current_setting('app.deleted_user_id', true), '');
  deletion_actor TEXT := NULLIF(current_setting('app.user_deletion_actor_id', true), '');
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Work reports must be soft deleted' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'UPDATE' THEN
    -- Preserve the existing authorized account-deletion workflow, including historical reports.
    IF deleted_user IS NOT NULL AND deletion_actor IS NOT NULL AND deleted_user <> deletion_actor
      AND OLD."authorId" = deleted_user AND NEW."authorId" IS NULL
      AND to_jsonb(NEW) = (to_jsonb(OLD) || jsonb_build_object('authorId', NULL)) THEN
      PERFORM "id" FROM "User" WHERE "id" = deletion_actor AND "role" = 'SUPER_ADMIN' AND "status" = 'ACTIVE' FOR SHARE;
      IF FOUND THEN RETURN NEW; END IF;
    END IF;
    IF OLD."deletedAt" IS NOT NULL THEN RAISE EXCEPTION 'Deleted reports are read-only' USING ERRCODE = '23514'; END IF;
    IF NEW."id" IS DISTINCT FROM OLD."id"
      OR NEW."authorId" IS DISTINCT FROM OLD."authorId"
      OR NEW."workDate" IS DISTINCT FROM OLD."workDate"
      OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
      OR NEW."requestId" IS DISTINCT FROM OLD."requestId"
      OR NEW."createPayloadHash" IS DISTINCT FROM OLD."createPayloadHash"
      OR NEW."version" <> OLD."version" + 1 THEN
      RAISE EXCEPTION 'Report identity, work date and creation facts are immutable; version must advance' USING ERRCODE = '23514';
    END IF;
  END IF;
  -- There is deliberately no super-admin bypass for another author's report.
  IF actor_id IS NULL OR NEW."authorId" IS DISTINCT FROM actor_id THEN
    RAISE EXCEPTION 'Only the author can write this report' USING ERRCODE = '42501';
  END IF;
  PERFORM "id" FROM "User" WHERE "id" = actor_id AND "status" = 'ACTIVE'
    AND "role" IN ('SUPER_ADMIN', 'MANAGE_DRIVER', 'EMPLOYEE') FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Active Work Report access is required' USING ERRCODE = '42501'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "WorkReport_guard" BEFORE INSERT OR UPDATE OR DELETE ON "WorkReport"
  FOR EACH ROW EXECUTE FUNCTION work_report_guard();
COMMIT;
