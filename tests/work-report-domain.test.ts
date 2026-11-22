import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  workReportAuthorsQuerySchema,
  workReportCreateSchema,
  workReportDateSchema,
  workReportDeleteSchema,
  workReportListSchema,
  workReportUpdateSchema,
} from "../src/modules/work-report/contracts";

const requestId = randomUUID();
const valid = {
  content: "  Reconciled the stock figures.\n\nPrepared tomorrow's orders.  ",
  requestId,
};

test("report creation trims outer whitespace, preserves line breaks and supports an optional title", () => {
  const parsed = workReportCreateSchema.parse(valid);
  assert.equal(
    parsed.content,
    "Reconciled the stock figures.\n\nPrepared tomorrow's orders.",
  );
  assert.equal(parsed.title, undefined);
  assert.equal(
    workReportCreateSchema.parse({ ...valid, title: "  Daily work  " }).title,
    "Daily work",
  );
  assert.equal(
    workReportCreateSchema.parse({ ...valid, title: null }).title,
    null,
  );
  assert.equal(
    workReportCreateSchema.parse({ ...valid, title: " " }).title,
    "",
  );
});

test("create retry UUIDs use a canonical value and content remains plain text", () => {
  assert.equal(
    workReportCreateSchema.parse({
      ...valid,
      requestId: requestId.toUpperCase(),
    }).requestId,
    requestId,
  );
  assert.equal(
    workReportCreateSchema.parse({
      ...valid,
      content: "<script>alert('literal text')</script>",
    }).content,
    "<script>alert('literal text')</script>",
  );
});

for (const [label, change] of [
  ["empty content", { content: "" }],
  ["blank content", { content: " \t\n " }],
  ["oversized content", { content: "x".repeat(10001) }],
  ["oversized title", { title: "x".repeat(201) }],
  ["nonstring content", { content: 1 }],
  ["missing retry key", { requestId: undefined }],
  ["invalid retry key", { requestId: "request-1" }],
  ["forged author", { authorId: "someone-else" }],
  ["forged date", { workDate: "2026-11-01" }],
  ["forged tenant", { tenantId: "other-organization" }],
  ["forged organization", { organizationId: "other-organization" }],
  ["forged timestamp", { createdAt: "2026-11-01T00:00:00Z" }],
  ["forged deletion", { deletedAt: null }],
  ["unrequested workflow", { status: "APPROVED" }],
] as const) {
  test(`report creation rejects ${label}`, () => {
    assert.equal(
      workReportCreateSchema.safeParse({ ...valid, ...change }).success,
      false,
    );
  });
}

test("length limits accept exactly the documented maximums", () => {
  assert.equal(
    workReportCreateSchema.safeParse({
      ...valid,
      title: "x".repeat(200),
      content: "x".repeat(10000),
    }).success,
    true,
  );
});

test("report edits allow only title and content plus a positive concurrency version", () => {
  const edit = {
    title: "Revised",
    content: "Corrected work description",
    expectedVersion: 2,
  };
  assert.deepEqual(workReportUpdateSchema.parse(edit), edit);
  for (const protectedField of [
    "authorId",
    "workDate",
    "createdAt",
    "updatedAt",
    "deletedAt",
    "tenantId",
    "organizationId",
    "version",
    "requestId",
  ]) {
    assert.equal(
      workReportUpdateSchema.safeParse({ ...edit, [protectedField]: "forged" })
        .success,
      false,
    );
  }
  for (const expectedVersion of [undefined, 0, -1, 1.5, "2", 2147483647]) {
    assert.equal(
      workReportUpdateSchema.safeParse({ ...edit, expectedVersion }).success,
      false,
    );
    assert.equal(
      workReportDeleteSchema.safeParse({ expectedVersion }).success,
      false,
    );
  }
  assert.deepEqual(workReportDeleteSchema.parse({ expectedVersion: 2 }), {
    expectedVersion: 2,
  });
  assert.equal(
    workReportDeleteSchema.safeParse({ expectedVersion: 2, permanent: true })
      .success,
    false,
  );
});

test("shared feed defaults to everyone with bounded server pagination", () => {
  const defaults = workReportListSchema.parse({});
  assert.equal(defaults.mine, false);
  assert.equal(defaults.date, undefined);
  assert.equal(defaults.page, 1);
  assert.equal(defaults.pageSize, 20);
  const parsed = workReportListSchema.parse({
    search: "  report  ",
    authorId: "user-1",
    date: "2026-11-21",
    mine: "true",
    page: "2",
    pageSize: "10",
  });
  assert.equal(parsed.search, "report");
  assert.equal(parsed.mine, true);
  assert.equal(parsed.page, 2);
  assert.equal(parsed.pageSize, 10);
  assert.equal(workReportListSchema.parse({ mine: "false" }).mine, false);
});

for (const [label, invalid] of [
  ["unbounded page", { pageSize: 101 }],
  ["zero page", { page: 0 }],
  ["scientific page", { page: "1e2" }],
  ["invalid mine flag", { mine: "all" }],
  ["oversized search", { search: "x".repeat(201) }],
  ["invalid date", { date: "2026-02-30" }],
  ["timestamp date", { date: "2026-11-21T00:00:00Z" }],
  ["forged tenant scope", { tenantId: "other" }],
  ["deleted report scope", { deleted: "all" }],
  ["unrestricted sort", { sort: "updatedAt" }],
  ["forged author path", { authorId: "../../user" }],
] as const) {
  test(`feed rejects ${label}`, () => {
    assert.equal(workReportListSchema.safeParse(invalid).success, false);
  });
}

test("date-only filters validate calendar dates without browser timezone shifts", () => {
  for (const date of ["2026-11-22", "2024-02-29", "0001-01-01"])
    assert.equal(workReportDateSchema.parse(date), date);
  for (const date of [
    "2026-02-29",
    "2026-00-01",
    "2026-11-00",
    "0000-01-01",
    "2026-1-01",
  ])
    assert.equal(workReportDateSchema.safeParse(date).success, false);
});

test("author lookup accepts only minimal search and date criteria", () => {
  assert.deepEqual(
    workReportAuthorsQuerySchema.parse({
      search: "  Sam  ",
      date: "2026-11-21",
    }),
    { search: "Sam", date: "2026-11-21" },
  );
  for (const field of ["email", "phone", "includeDeleted", "tenantId"])
    assert.equal(
      workReportAuthorsQuerySchema.safeParse({ [field]: "forged" }).success,
      false,
    );
});
