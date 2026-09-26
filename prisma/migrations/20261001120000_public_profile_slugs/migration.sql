BEGIN;

ALTER TABLE "User" ADD COLUMN "profileSlug" VARCHAR(100) NOT NULL DEFAULT '';

-- Allocate in the database so every account creation path (including seed and
-- Auth.js) receives a slug. Serialize this small allocation step to handle
-- concurrent registrations and collisions such as "Sam" / "Sam 2".
CREATE FUNCTION assign_public_profile_slug() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  base_slug TEXT;
  candidate TEXT;
  suffix INTEGER := 1;
BEGIN
  IF NEW."profileSlug" <> '' THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(187462, 1);
  base_slug := trim(both '_' from left(
    regexp_replace(lower(coalesce(NEW."name", '')), '[^a-z0-9]+', '_', 'g'),
    80
  ));
  IF base_slug = '' THEN
    base_slug := 'team_member';
  END IF;
  -- Keep generated CUID account IDs unambiguous as legacy route identifiers.
  IF base_slug ~ '^c[a-z0-9]{24}$' THEN
    base_slug := 'member_' || base_slug;
  END IF;
  candidate := base_slug;
  WHILE EXISTS (
    SELECT 1 FROM "User"
    WHERE "profileSlug" = candidate OR "id" = candidate
  ) OR candidate = NEW."id" LOOP
    suffix := suffix + 1;
    candidate := base_slug || '_' || suffix;
  END LOOP;
  NEW."profileSlug" := candidate;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "User_assign_profile_slug"
BEFORE INSERT OR UPDATE OF "profileSlug" ON "User"
FOR EACH ROW EXECUTE FUNCTION assign_public_profile_slug();

-- Give the oldest account the unsuffixed name, deterministically.
DO $$
DECLARE account RECORD;
BEGIN
  FOR account IN SELECT "id" FROM "User" ORDER BY "createdAt", "id" LOOP
    UPDATE "User" SET "profileSlug" = '' WHERE "id" = account."id";
  END LOOP;
END;
$$;

CREATE UNIQUE INDEX "User_profileSlug_key" ON "User"("profileSlug");
ALTER TABLE "User" ADD CONSTRAINT "User_profileSlug_format"
  CHECK ("profileSlug" ~ '^[a-z0-9]+(_[a-z0-9]+)*$');

COMMIT;
