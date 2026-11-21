BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';

CREATE TYPE "OfficeWorkStatus" AS ENUM ('PENDING', 'PROCESSING', 'DONE');
CREATE TYPE "OfficeWorkPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

CREATE TABLE "OfficeWorkTask" (
  "id" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "requestId" UUID NOT NULL,
  "createPayloadHash" VARCHAR(64) NOT NULL,
  "title" VARCHAR(200) NOT NULL,
  "description" VARCHAR(10000),
  "status" "OfficeWorkStatus" NOT NULL DEFAULT 'PENDING',
  "priority" "OfficeWorkPriority" NOT NULL DEFAULT 'MEDIUM',
  "assigneeId" TEXT,
  "createdById" TEXT,
  "dueDate" DATE,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "archivedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OfficeWorkTask_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OfficeWorkTask_title_valid" CHECK (length(btrim("title")) > 0),
  CONSTRAINT "OfficeWorkTask_version_valid" CHECK ("version" > 0),
  CONSTRAINT "OfficeWorkTask_lifecycle_valid" CHECK (
    ("status" = 'PENDING' AND "startedAt" IS NULL AND "completedAt" IS NULL)
    OR ("status" = 'PROCESSING' AND "startedAt" IS NOT NULL AND "completedAt" IS NULL)
    OR ("status" = 'DONE' AND "startedAt" IS NOT NULL AND "completedAt" IS NOT NULL AND "completedAt" >= "startedAt")
  ),
  CONSTRAINT "OfficeWorkTask_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "OfficeWorkTask_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "OfficeWorkTask_requestId_key" ON "OfficeWorkTask"("requestId");
CREATE INDEX "OfficeWorkTask_assigneeId_archivedAt_status_createdAt_id_idx" ON "OfficeWorkTask"("assigneeId", "archivedAt", "status", "createdAt" DESC, "id" DESC);
CREATE INDEX "OfficeWorkTask_archivedAt_status_dueDate_id_idx" ON "OfficeWorkTask"("archivedAt", "status", "dueDate", "id");
CREATE INDEX "OfficeWorkTask_createdById_archivedAt_createdAt_id_idx" ON "OfficeWorkTask"("createdById", "archivedAt", "createdAt" DESC, "id" DESC);
CREATE INDEX "OfficeWorkTask_archivedAt_createdAt_id_idx" ON "OfficeWorkTask"("archivedAt", "createdAt" DESC, "id" DESC);
CREATE INDEX "OfficeWorkTask_archivedAt_dueDate_id_idx" ON "OfficeWorkTask"("archivedAt", "dueDate", "id");
CREATE INDEX "AuditLog_resource_history_idx" ON "AuditLog"("resource", "resourceId", "createdAt" DESC, "id" DESC);

CREATE FUNCTION office_work_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  deleted_user TEXT := NULLIF(current_setting('app.deleted_user_id', true), '');
  deletion_actor TEXT := NULLIF(current_setting('app.user_deletion_actor_id', true), '');
  expected JSONB;
BEGIN
  -- Match the established account-deletion convention without making tasks deletable.
  IF TG_OP = 'UPDATE' AND deleted_user IS NOT NULL AND deletion_actor IS NOT NULL AND deleted_user <> deletion_actor THEN
    PERFORM "id" FROM "User" WHERE "id" = deletion_actor AND "role" = 'SUPER_ADMIN' AND "status" = 'ACTIVE' FOR SHARE;
    IF FOUND THEN
      expected := to_jsonb(OLD);
      IF OLD."assigneeId" = deleted_user THEN expected := expected || jsonb_build_object('assigneeId', NULL); END IF;
      IF OLD."createdById" = deleted_user THEN expected := expected || jsonb_build_object('createdById', NULL); END IF;
      -- A single deletion can fire the two FK updates separately.
      IF (to_jsonb(NEW) - 'assigneeId' - 'createdById') = (expected - 'assigneeId' - 'createdById')
        AND (NEW."assigneeId" IS NOT DISTINCT FROM OLD."assigneeId" OR (OLD."assigneeId" = deleted_user AND NEW."assigneeId" IS NULL))
        AND (NEW."createdById" IS NOT DISTINCT FROM OLD."createdById" OR (OLD."createdById" = deleted_user AND NEW."createdById" IS NULL))
        AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN RETURN NEW;
      END IF;
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Office work history cannot be deleted' USING ERRCODE = '23514'; END IF;
  IF OLD."archivedAt" IS NOT NULL THEN RAISE EXCEPTION 'Archived tasks are read-only' USING ERRCODE = '23514'; END IF;
  IF NEW."createdById" IS DISTINCT FROM OLD."createdById"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
    OR NEW."requestId" IS DISTINCT FROM OLD."requestId"
    OR NEW."createPayloadHash" IS DISTINCT FROM OLD."createPayloadHash"
    OR NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'Invalid task ownership or version change' USING ERRCODE = '23514';
  END IF;
  IF NEW."assigneeId" IS DISTINCT FROM OLD."assigneeId"
    AND (NEW."status" <> 'PENDING' OR NEW."startedAt" IS NOT NULL OR NEW."completedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'Reassignment must reset the lifecycle' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "OfficeWorkTask_guard" BEFORE UPDATE OR DELETE ON "OfficeWorkTask"
  FOR EACH ROW EXECUTE FUNCTION office_work_guard();

COMMIT;
