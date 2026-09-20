-- The live admin dashboard orders by updatedAt/id and returns only eight rows.
-- Avoid sorting the entire attendance table for this feed.
CREATE INDEX "Attendance_updatedAt_id_idx" ON "Attendance"("updatedAt" DESC, "id" DESC);
