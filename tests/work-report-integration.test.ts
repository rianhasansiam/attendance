import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import type { Role } from "@prisma/client";
import { db } from "../src/lib/db";
import { DomainError } from "../src/lib/errors";
import {
  createWorkReport,
  deleteWorkReport,
  getWorkReport,
  listWorkReportAuthors,
  listWorkReports,
  updateWorkReport,
} from "../src/modules/work-report/service";
import type {
  WorkReportActor,
  WorkReportDTO,
} from "../src/modules/work-report/contracts";
import { deleteIdentity } from "../src/modules/management/delete-identity";
import { getRecord, listRecords } from "../src/modules/management/service";
import { driveCostFilterSchema } from "../src/modules/management/validation";

const database = process.env.TEST_DATABASE_URL;
if (database) {
  const url = new URL(database);
  assert.ok(
    ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
      url.pathname.includes("test"),
    "Use an explicitly disposable local test database.",
  );
  process.env.DATABASE_URL = database;
}
const integration = database ? test : test.skip;
process.env.WORK_REPORT_TIMEZONE = "Asia/Dhaka";
after(async () => {
  if (database) await db.$disconnect();
});
const denied = (status: number, code?: string) => (error: unknown) =>
  error instanceof DomainError &&
  error.status === status &&
  (!code || error.code === code);

async function fixture() {
  const key = `wr${randomUUID().replaceAll("-", "")}`;
  const user = (label: string, role: Role) =>
    db.user.create({
      data: {
        name: `${key} ${label}`,
        email: `${key}-${label}@example.test`,
        phone: "private-phone-number",
        googleAccountId: `${key}-${label}`,
        role,
      },
    });
  const [admin, manager, employee, otherEmployee, legacyAdmin] =
    await Promise.all([
      user("super", "SUPER_ADMIN"),
      user("manager", "MANAGE_DRIVER"),
      user("employee", "EMPLOYEE"),
      user("other", "EMPLOYEE"),
      user("legacy", "ADMIN"),
    ]);
  return { key, admin, manager, employee, otherEmployee, legacyAdmin };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const post = (
  f: Fixture,
  actor: WorkReportActor = f.employee,
  fields: Record<string, unknown> = {},
) =>
  createWorkReport(actor, {
    content: `${f.key} Completed the stock report.\nPrepared tomorrow's orders.`,
    requestId: randomUUID(),
    ...fields,
  });
const feed = (
  f: Fixture,
  actor: WorkReportActor = f.employee,
  filters: Record<string, unknown> = {},
) => listWorkReports(actor, { search: f.key, ...filters });
const edit = (
  actor: WorkReportActor,
  report: WorkReportDTO,
  changes: Record<string, unknown> = {},
) =>
  updateWorkReport(actor, report.id, {
    content: report.content,
    expectedVersion: report.version,
    ...changes,
  });
const remove = (actor: WorkReportActor, report: WorkReportDTO) =>
  deleteWorkReport(actor, report.id, { expectedVersion: report.version });
const auditCount = (id: string, action?: string) =>
  db.auditLog.count({
    where: {
      resource: "WorkReport",
      resourceId: id,
      ...(action ? { action } : {}),
    },
  });

integration(
  "all three roles publish as themselves and share the same team feed and details",
  async () => {
    const f = await fixture();
    const authors = [f.admin, f.manager, f.employee];
    const reports = [];
    for (const author of authors) {
      const report = await post(f, author);
      assert.equal(report.authorId, author.id);
      assert.equal(report.author?.id, author.id);
      assert.equal(report.edited, false);
      reports.push(report);
    }
    for (const viewer of [...authors, f.otherEmployee]) {
      const result = await feed(f, viewer);
      assert.equal(result.total, 3);
      assert.deepEqual(
        new Set(result.items.map((report) => report.id)),
        new Set(reports.map((report) => report.id)),
      );
      for (const report of reports) {
        const detail = await getWorkReport(viewer, report.id);
        assert.equal(detail.content, report.content);
        assert.deepEqual(detail.permissions, {
          canEdit: report.authorId === viewer.id,
          canDelete: report.authorId === viewer.id,
        });
      }
    }
  },
);

integration(
  "authors of every role can edit and soft-delete their own reports without changing original posting facts",
  async () => {
    const f = await fixture();
    for (const actor of [f.admin, f.manager, f.employee]) {
      const original = await post(f, actor, { title: "Original title" });
      const updated = await edit(actor, original, {
        title: "Revised title",
        content: `${f.key} Corrected figures.\nPreserved line breaks.`,
      });
      assert.equal(updated.authorId, original.authorId);
      assert.equal(updated.workDate, original.workDate);
      assert.equal(updated.createdAt, original.createdAt);
      assert.ok(updated.updatedAt >= original.updatedAt);
      assert.equal(updated.edited, true);
      assert.equal(updated.version, original.version + 1);
      assert.equal(updated.title, "Revised title");
      const removed = await remove(actor, updated);
      assert.deepEqual(removed, {
        id: original.id,
        version: updated.version + 1,
        deleted: true,
      });
      await assert.rejects(getWorkReport(actor, original.id), denied(404));
      const retained = await db.workReport.findUniqueOrThrow({
        where: { id: original.id },
      });
      assert.ok(retained.deletedAt);
      assert.equal(retained.authorId, actor.id);
      assert.equal(await auditCount(original.id), 3);
    }
    assert.equal((await feed(f, f.employee)).total, 0);
  },
);

integration(
  "employee, manager and super admin cannot edit or delete another author's report",
  async () => {
    const f = await fixture();
    for (const author of [f.admin, f.manager, f.employee]) {
      const original = await post(f, author);
      for (const viewer of [
        f.admin,
        f.manager,
        f.employee,
        f.otherEmployee,
      ].filter((viewer) => viewer.id !== author.id)) {
        await assert.rejects(
          edit(viewer, original, { content: `${f.key} Unauthorized override` }),
          denied(403),
        );
        await assert.rejects(remove(viewer, original), denied(403));
      }
      const unchanged = await getWorkReport(f.otherEmployee, original.id);
      assert.equal(unchanged.content, original.content);
      assert.equal(unchanged.version, original.version);
      assert.equal(await auditCount(original.id), 1);
    }
  },
);

integration(
  "legacy ADMIN, inactive current accounts and missing actors cannot read, post or mutate reports",
  async () => {
    const f = await fixture();
    const original = await post(f);
    for (const operation of [
      () => feed(f, f.legacyAdmin),
      () => listWorkReportAuthors(f.legacyAdmin),
      () => getWorkReport(f.legacyAdmin, original.id),
      () => post(f, f.legacyAdmin),
      () => edit(f.legacyAdmin, original),
      () => remove(f.legacyAdmin, original),
    ])
      await assert.rejects(operation(), denied(403));
    await db.user.update({
      where: { id: f.employee.id },
      data: { status: "INACTIVE" },
    });
    for (const operation of [
      () => feed(f),
      () => listWorkReportAuthors(f.employee),
      () => getWorkReport(f.employee, original.id),
      () => post(f),
      () => edit(f.employee, original),
      () => remove(f.employee, original),
    ])
      await assert.rejects(operation(), denied(403));
    // Historical content remains shared even when its author's account is inactive.
    assert.equal(
      (await getWorkReport(f.manager, original.id)).content,
      original.content,
    );
    await db.user.update({
      where: { id: f.manager.id },
      data: { role: "ADMIN" },
    });
    await assert.rejects(feed(f, f.manager), denied(403));
    await assert.rejects(
      post(f, { ...f.manager, role: "SUPER_ADMIN" }),
      denied(403),
    );
    await assert.rejects(
      feed(f, { id: "nonexistent-actor", role: "SUPER_ADMIN" }),
      denied(403),
    );
  },
);

integration(
  "forged author, work date, tenant, timestamps and deletion fields are rejected by services",
  async () => {
    const f = await fixture();
    const original = await post(f);
    for (const [field, value] of Object.entries({
      authorId: f.admin.id,
      workDate: "2020-01-01",
      tenantId: "other-organization",
      organizationId: "other-organization",
      createdAt: "2020-01-01T00:00:00Z",
      updatedAt: "2020-01-01T00:00:00Z",
      deletedAt: null,
    })) {
      await assert.rejects(post(f, f.employee, { [field]: value }));
      await assert.rejects(edit(f.employee, original, { [field]: value }));
    }
    assert.equal((await feed(f)).total, 1);
    assert.equal(
      (await getWorkReport(f.admin, original.id)).authorId,
      f.employee.id,
    );
    await assert.rejects(
      remove({ ...f.admin, role: "EMPLOYEE" }, original),
      denied(403),
    );
  },
);

integration(
  "multiple same-day reports are allowed and concurrent create retries yield one report and one activity",
  async () => {
    const f = await fixture();
    const first = await post(f);
    const second = await post(f);
    assert.notEqual(first.id, second.id);
    assert.equal(first.workDate, second.workDate);
    const requestId = randomUUID();
    const input = {
      title: "Retry-safe report",
      content: `${f.key} Completed a retry-safe post`,
      requestId,
    };
    const [a, b] = await Promise.all([
      createWorkReport(f.employee, input),
      createWorkReport(f.employee, {
        ...input,
        requestId: requestId.toUpperCase(),
      }),
    ]);
    assert.equal(a.id, b.id);
    assert.equal(await auditCount(a.id), 1);
    assert.equal((await feed(f)).total, 3);
    await assert.rejects(
      createWorkReport(f.employee, {
        ...input,
        content: `${f.key} Different payload`,
      }),
      denied(409, "IDEMPOTENCY_CONFLICT"),
    );
    await assert.rejects(
      createWorkReport(f.admin, input),
      denied(409, "IDEMPOTENCY_CONFLICT"),
    );
  },
);

integration(
  "server work date follows the Dhaka day boundary and previous-day browsing never backdates a new post",
  async (t) => {
    const f = await fixture();
    t.mock.timers.enable({
      apis: ["Date"],
      now: Date.parse("2026-11-21T17:59:59.999Z"),
    });
    const yesterday = await post(f);
    assert.equal(yesterday.workDate, "2026-11-21");
    t.mock.timers.setTime(Date.parse("2026-11-21T18:00:00.000Z"));
    const olderFeed = await feed(f, f.employee, { date: "2026-11-21" });
    assert.equal(olderFeed.date, "2026-11-21");
    assert.equal(olderFeed.today, "2026-11-22");
    assert.equal(olderFeed.total, 1);
    const today = await post(f);
    assert.equal(today.workDate, "2026-11-22");
    const current = await feed(f);
    assert.equal(current.date, "2026-11-22");
    assert.equal(current.timezone, "Asia/Dhaka");
    assert.equal(current.total, 1);
    assert.equal(current.items[0].id, today.id);
    const olderEdit = await edit(f.employee, yesterday, {
      content: `${f.key} Corrected yesterday after midnight`,
    });
    assert.equal(olderEdit.workDate, "2026-11-21");
    assert.equal(olderEdit.createdAt, yesterday.createdAt);
    assert.equal(
      (await feed(f, f.employee, { date: "2026-11-21" })).items[0].id,
      yesterday.id,
    );
  },
);

integration(
  "a create retry on the next business day retains its original date and a deleted retry never resurrects a report",
  async (t) => {
    const f = await fixture();
    const input = {
      content: `${f.key} Delivery confirmation`,
      requestId: randomUUID(),
    };
    t.mock.timers.enable({
      apis: ["Date"],
      now: Date.parse("2026-11-21T17:00:00Z"),
    });
    const original = await createWorkReport(f.employee, input);
    t.mock.timers.setTime(Date.parse("2026-11-22T18:00:00Z"));
    const retry = await createWorkReport(f.employee, input);
    assert.equal(retry.id, original.id);
    assert.equal(retry.workDate, "2026-11-21");
    assert.equal(await auditCount(original.id), 1);
    await remove(f.employee, retry);
    await assert.rejects(createWorkReport(f.employee, input), denied(404));
    assert.equal(
      (await feed(f, f.employee, { date: original.workDate })).total,
      0,
    );
    assert.equal(await auditCount(original.id), 2);
  },
);

integration(
  "feed, detail and author options expose only the account fields needed for attribution",
  async () => {
    const f = await fixture();
    const first = await post(f, f.admin);
    await post(f, f.manager);
    await post(f, f.employee);
    const sources = [
      await getWorkReport(f.employee, first.id),
      ...(await feed(f, f.employee)).items,
    ];
    const allowed = ["id", "image", "name", "role"];
    for (const report of sources)
      assert.deepEqual(Object.keys(report.author!).sort(), allowed);
    const authors = await listWorkReportAuthors(f.employee, { search: f.key });
    assert.equal(authors.length, 3);
    for (const author of authors)
      assert.deepEqual(Object.keys(author).sort(), allowed);
    const exposed = JSON.stringify({ sources, authors });
    for (const author of [f.admin, f.manager, f.employee]) {
      assert.ok(!exposed.includes(author.email));
      assert.ok(!exposed.includes(author.phone!));
      assert.ok(!exposed.includes(author.googleAccountId!));
    }
  },
);

integration(
  "search, author, My Reports and date filters run before stable chronological pagination",
  async (t) => {
    const f = await fixture();
    t.mock.timers.enable({
      apis: ["Date"],
      now: Date.parse("2026-11-22T03:00:00Z"),
    });
    const a = await post(f, f.employee, {
      title: `${f.key} 50%_stock`,
      content: `${f.key} Completed inventory`,
    });
    const b = await post(f, f.manager, {
      title: "Dispatch",
      content: `${f.key} Completed the invoice matching`,
    });
    const c = await post(f, f.admin, {
      title: "Review",
      content: `${f.key} Third team update`,
    });
    const all = await feed(f, f.employee);
    const ordered = all.items.map((report) => report.id);
    const page1 = await feed(f, f.employee, { page: 1, pageSize: 2 });
    const page2 = await feed(f, f.employee, { page: 2, pageSize: 2 });
    assert.deepEqual(
      [...page1.items, ...page2.items].map((report) => report.id),
      ordered,
    );
    assert.equal(
      new Set([...page1.items, ...page2.items].map((report) => report.id)).size,
      3,
    );
    assert.equal(page2.totalPages, 2);
    assert.equal(
      (await feed(f, f.employee, { page: 999, pageSize: 2 })).page,
      2,
    );
    const literal = await feed(f, f.employee, { search: `${f.key} 50%_` });
    assert.deepEqual(
      literal.items.map((report) => report.id),
      [a.id],
    );
    assert.deepEqual(
      (
        await feed(f, f.employee, { search: `${f.key} completed the INVOICE` })
      ).items.map((report) => report.id),
      [b.id],
    );
    assert.deepEqual(
      (await feed(f, f.employee, { authorId: f.admin.id })).items.map(
        (report) => report.id,
      ),
      [c.id],
    );
    assert.deepEqual(
      (await feed(f, f.employee, { mine: "true" })).items.map(
        (report) => report.id,
      ),
      [a.id],
    );
    assert.equal(
      (await feed(f, f.employee, { mine: true, authorId: f.admin.id })).total,
      0,
    );
    await edit(f.employee, a, {
      content: `${f.key} Edited earlier post without bumping its order`,
    });
    assert.deepEqual(
      (await feed(f, f.employee)).items.map((report) => report.id),
      ordered,
    );
    t.mock.timers.setTime(Date.parse("2026-11-23T03:00:00Z"));
    await post(f, f.otherEmployee);
    assert.equal((await feed(f, f.employee)).total, 1);
    assert.equal((await feed(f, f.employee, { date: "2026-11-22" })).total, 3);
    const yesterdayAuthors = await listWorkReportAuthors(f.employee, {
      date: "2026-11-22",
      search: f.key,
    });
    assert.equal(yesterdayAuthors.length, 3);
    const todayAuthors = await listWorkReportAuthors(f.employee, {
      date: "2026-11-23",
      search: f.key,
    });
    assert.deepEqual(
      todayAuthors.map((author) => author.id),
      [f.otherEmployee.id],
    );
  },
);

integration(
  "soft-deleted reports disappear from normal detail, feed, searches and author filters and cannot be mutated again",
  async () => {
    const f = await fixture();
    const report = await post(f);
    await remove(f.employee, report);
    for (const actor of [f.employee, f.manager, f.admin]) {
      await assert.rejects(getWorkReport(actor, report.id), denied(404));
      await assert.rejects(
        edit(actor, report, { content: `${f.key} Deleted modification` }),
        denied(404),
      );
      await assert.rejects(remove(actor, report), denied(404));
      assert.equal((await feed(f, actor)).total, 0);
      assert.deepEqual(
        await listWorkReportAuthors(actor, { search: f.key }),
        [],
      );
    }
    assert.equal(await auditCount(report.id, "WORK_REPORT_DELETED"), 1);
  },
);

integration(
  "concurrent edits reject stale versions and commit exactly one edit event",
  async () => {
    const f = await fixture();
    const report = await post(f);
    const results = await Promise.allSettled([
      edit(f.employee, report, { content: `${f.key} First concurrent edit` }),
      edit(f.employee, report, { content: `${f.key} Second concurrent edit` }),
    ]);
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
    assert.ok(
      results.some(
        (result) =>
          result.status === "rejected" &&
          result.reason instanceof DomainError &&
          result.reason.code === "WORK_REPORT_CONFLICT",
      ),
    );
    const current = await getWorkReport(f.admin, report.id);
    assert.equal(current.version, report.version + 1);
    assert.equal(await auditCount(report.id, "WORK_REPORT_UPDATED"), 1);
    await assert.rejects(
      remove(f.employee, report),
      denied(409, "WORK_REPORT_CONFLICT"),
    );
  },
);

integration(
  "an update/delete race commits one operation and never overwrites a deleted or newer report",
  async () => {
    const f = await fixture();
    const report = await post(f);
    const results = await Promise.allSettled([
      edit(f.employee, report, { content: `${f.key} Raced edit` }),
      remove(f.employee, report),
    ]);
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
    const saved = await db.workReport.findUniqueOrThrow({
      where: { id: report.id },
    });
    assert.equal(saved.version, report.version + 1);
    assert.equal(await auditCount(report.id), 2);
    if (saved.deletedAt)
      await assert.rejects(getWorkReport(f.manager, report.id), denied(404));
    else
      assert.equal(
        (await getWorkReport(f.manager, report.id)).content,
        `${f.key} Raced edit`,
      );
  },
);

integration(
  "title omission preserves it, explicit null clears it and unchanged writes do not fabricate edited history",
  async () => {
    const f = await fixture();
    const report = await post(f, f.employee, { title: "Keep this title" });
    const unchanged = await edit(f.employee, report);
    assert.equal(unchanged.version, report.version);
    assert.equal(unchanged.updatedAt, report.updatedAt);
    assert.equal(unchanged.edited, false);
    assert.equal(await auditCount(report.id), 1);
    const changed = await edit(f.employee, report, {
      content: `${f.key} Changed content only`,
    });
    assert.equal(changed.title, report.title);
    const cleared = await edit(f.employee, changed, { title: null });
    assert.equal(cleared.title, null);
  },
);

integration(
  "create and edit/delete changes roll back when their matching audit insertion fails",
  async () => {
    const f = await fixture();
    const report = await post(f);
    const trigger = `work_report_test_${randomUUID().replaceAll("-", "")}`;
    const failedContent = `${f.key} Fail initial activity`;
    await db.$executeRawUnsafe(
      `CREATE FUNCTION ${trigger}() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN IF NEW.resource = 'WorkReport' AND (NEW."resourceId" = '${report.id}' OR NEW."newState"->>'content' = '${failedContent}') THEN RAISE EXCEPTION 'forced Work Report activity failure'; END IF; RETURN NEW; END $$`,
    );
    await db.$executeRawUnsafe(
      `CREATE TRIGGER ${trigger} BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION ${trigger}()`,
    );
    const failedInput = { content: failedContent, requestId: randomUUID() };
    try {
      await assert.rejects(createWorkReport(f.employee, failedInput));
      assert.equal(
        await db.workReport.count({
          where: { requestId: failedInput.requestId },
        }),
        0,
      );
      await assert.rejects(
        edit(f.employee, report, { content: `${f.key} Must roll back` }),
      );
      await assert.rejects(remove(f.employee, report));
      const unchanged = await getWorkReport(f.admin, report.id);
      assert.equal(unchanged.content, report.content);
      assert.equal(unchanged.version, report.version);
      assert.equal(await auditCount(report.id), 1);
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER ${trigger} ON "AuditLog"`);
      await db.$executeRawUnsafe(`DROP FUNCTION ${trigger}()`);
    }
    const retried = await createWorkReport(f.employee, failedInput);
    assert.equal(await auditCount(retried.id), 1);
  },
);

integration(
  "legacy global audit lists and direct IDs cannot expose WorkReport content to the excluded ADMIN role",
  async () => {
    const f = await fixture();
    const report = await post(f);
    const event = await db.auditLog.findFirstOrThrow({
      where: { resource: "WorkReport", resourceId: report.id },
    });
    const query = driveCostFilterSchema.parse({ q: "WorkReport" });
    const hidden = await listRecords(f.legacyAdmin, "audit", query);
    assert.equal(hidden.total, 0);
    assert.deepEqual(hidden.items, []);
    await assert.rejects(
      getRecord(f.legacyAdmin, "audit", event.id),
      denied(404),
    );
    assert.ok((await listRecords(f.admin, "audit", query)).total > 0);
    assert.equal(
      ((await getRecord(f.admin, "audit", event.id)) as { id: string }).id,
      event.id,
    );
  },
);

integration(
  "existing account deletion preserves active and soft-deleted reports while detaching author identity and redacting audit",
  async () => {
    const f = await fixture();
    const active = await post(f);
    const deleted = await post(f);
    await remove(f.employee, deleted);
    const deletedBefore = await db.workReport.findUniqueOrThrow({
      where: { id: deleted.id },
    });
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${f.admin.id} FOR SHARE`;
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${f.employee.id} FOR UPDATE`;
      await deleteIdentity(tx, f.admin, f.employee.id, undefined, {
        id: f.employee.id,
        name: f.employee.name,
      });
    });
    const retained = await getWorkReport(f.manager, active.id);
    assert.equal(retained.authorId, null);
    assert.equal(retained.author, null);
    assert.equal(retained.content, active.content);
    assert.equal(retained.workDate, active.workDate);
    assert.equal(retained.version, active.version);
    assert.equal(retained.createdAt, active.createdAt);
    assert.deepEqual(retained.permissions, {
      canEdit: false,
      canDelete: false,
    });
    await assert.rejects(edit(f.admin, retained), denied(403));
    await assert.rejects(getWorkReport(f.manager, deleted.id), denied(404));
    const deletedAfter = await db.workReport.findUniqueOrThrow({
      where: { id: deleted.id },
    });
    assert.equal(deletedAfter.authorId, null);
    assert.equal(deletedAfter.version, deletedBefore.version);
    assert.deepEqual(deletedAfter.deletedAt, deletedBefore.deletedAt);
    const history = await db.auditLog.findMany({
      where: {
        resource: "WorkReport",
        resourceId: { in: [active.id, deleted.id] },
      },
    });
    assert.ok(history.every((event) => event.actorId === null));
    assert.ok(!JSON.stringify(history).includes(f.employee.id));
    assert.ok(JSON.stringify(history).includes("deleted info"));
    await assert.rejects(feed(f, f.employee), denied(403));
  },
);
