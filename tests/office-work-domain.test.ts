import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  officeWorkActionSchema,
  officeWorkActivityQuerySchema,
  officeWorkCreateSchema,
  officeWorkDateSchema,
  officeWorkListSchema,
  officeWorkUpdateSchema,
} from "../src/modules/office-work/contracts";

const task = {
  title: "  Prepare the stock report  ",
  assigneeId: "employee-user-1",
  requestId: randomUUID(),
};

test("creation validates its writable fields, trims plain text and defaults priority", () => {
  const input = officeWorkCreateSchema.parse({
    ...task,
    description: "  Compare the <script>literal text</script> figures.  ",
    dueDate: "2026-11-21",
  });
  assert.equal(input.title, "Prepare the stock report");
  assert.equal(input.priority, "MEDIUM");
  assert.equal(
    input.description,
    "Compare the <script>literal text</script> figures.",
  );
  assert.equal(input.dueDate, "2026-11-21");
});

for (const input of [
  { ...task, title: " " },
  { ...task, title: "x".repeat(201) },
  { ...task, description: "x".repeat(10001) },
  { ...task, assigneeId: "" },
  { ...task, assigneeId: "../../another-user" },
  { ...task, priority: "URGENT" },
  { ...task, requestId: "not-a-uuid" },
  { ...task, createdById: "super-admin" },
  { ...task, status: "DONE" },
  { ...task, startedAt: "2026-11-21T00:00:00Z" },
  { ...task, actorId: "another-actor" },
]) {
  test(`creation rejects invalid or protected input: ${Object.keys(input).at(-1)}`, () => {
    assert.equal(officeWorkCreateSchema.safeParse(input).success, false);
  });
}

for (const date of ["2026-11-21", "2024-02-29", "0001-01-01"]) {
  test(`date-only deadlines preserve ${date}`, () => {
    assert.equal(officeWorkDateSchema.parse(date), date);
  });
}
for (const date of [
  "2026-02-29",
  "2026-02-30",
  "2026-13-01",
  "2026-11-00",
  "2026-1-01",
  "0000-01-01",
  "2026-11-21T00:00:00Z",
  "21/11/2026",
]) {
  test(`date-only deadlines reject ${date}`, () => {
    assert.equal(officeWorkDateSchema.safeParse(date).success, false);
  });
}

test("edits require a positive concurrency version and cannot change ownership, assignment or lifecycle", () => {
  const editable = {
    title: "Updated report",
    priority: "MEDIUM",
    expectedVersion: 2,
  };
  assert.equal(officeWorkUpdateSchema.parse(editable).expectedVersion, 2);
  assert.equal(
    officeWorkUpdateSchema.safeParse({
      title: editable.title,
      expectedVersion: 2,
    }).success,
    false,
  );
  for (const protectedField of [
    "createdById",
    "assigneeId",
    "status",
    "startedAt",
    "completedAt",
    "archivedAt",
    "version",
  ]) {
    assert.equal(
      officeWorkUpdateSchema.safeParse({
        ...editable,
        [protectedField]: "forged",
      }).success,
      false,
    );
  }
  for (const expectedVersion of [undefined, 0, -1, 1.5, "2", 2147483647]) {
    assert.equal(
      officeWorkUpdateSchema.safeParse({ ...editable, expectedVersion })
        .success,
      false,
    );
  }
});

test("actions have an explicit allowlist and reopening always requires a nonblank reason", () => {
  for (const action of ["start", "complete", "archive"]) {
    assert.equal(
      officeWorkActionSchema.safeParse({ action, expectedVersion: 1 }).success,
      true,
    );
  }
  assert.equal(
    officeWorkActionSchema.safeParse({
      action: "reopen",
      expectedVersion: 1,
      reason: "  Further review required  ",
    }).success,
    true,
  );
  for (const reason of [undefined, "", " ", "x".repeat(1001)]) {
    assert.equal(
      officeWorkActionSchema.safeParse({
        action: "reopen",
        expectedVersion: 1,
        reason,
      }).success,
      false,
    );
  }
  assert.equal(
    officeWorkActionSchema.safeParse({ action: "delete", expectedVersion: 1 })
      .success,
    false,
  );
  assert.equal(
    officeWorkActionSchema.safeParse({
      action: "complete",
      expectedVersion: 1,
      completedAt: "2026-11-21",
    }).success,
    false,
  );
  assert.equal(
    officeWorkActionSchema.safeParse({
      action: "reassign",
      expectedVersion: 1,
      assigneeId: "employee-2",
      confirmReset: true,
    }).success,
    true,
  );
  assert.equal(
    officeWorkActionSchema.safeParse({
      action: "reassign",
      expectedVersion: 1,
      assigneeId: "employee-2",
      confirmReset: "true",
    }).success,
    false,
  );
});

test("list defaults and bounded paging reject unsafe or unsupported filters", () => {
  const defaults = officeWorkListSchema.parse({});
  assert.equal(defaults.page, 1);
  assert.equal(defaults.pageSize, 20);
  assert.equal(defaults.archived, "active");
  assert.equal(defaults.sort, "newest");
  const filters = officeWorkListSchema.parse({
    search: "  Report  ",
    page: "2",
    pageSize: "10",
    status: "DONE",
    priority: "HIGH",
    from: "2026-11-01",
    to: "2026-11-21",
  });
  assert.equal(filters.search, "Report");
  assert.equal(filters.page, 2);
  assert.equal(filters.pageSize, 10);
  for (const invalid of [
    { pageSize: 101 },
    { page: 0 },
    { page: "1e2" },
    { page: "-1" },
    { search: "x".repeat(201) },
    { sort: "title; DROP TABLE tasks" },
    { from: "2026-11-21", to: "2026-11-01" },
    { employeeId: "forged" },
    { status: "OVERDUE" },
    { listFilter: "private" },
  ]) {
    assert.equal(officeWorkListSchema.safeParse(invalid).success, false);
  }
  assert.equal(
    officeWorkActivityQuerySchema.safeParse({ pageSize: 101 }).success,
    false,
  );
  assert.equal(
    officeWorkActivityQuerySchema.safeParse({ assigneeId: "forged" }).success,
    false,
  );
});
