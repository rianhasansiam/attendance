import assert from "node:assert/strict";
import { before, beforeEach, mock, test } from "node:test";
import en from "../messages/en/workReport.json";
import { reportPermissions } from "../src/modules/work-report/permissions";
import type {
  WorkReportDTO,
  WorkReportFeedDTO,
} from "../src/modules/work-report/contracts";

type Element = { type: unknown; props: Record<string, unknown> };
const element = (type: unknown, props: Record<string, unknown>) => ({
  type,
  props,
});
const noop = () => undefined;
let slots: unknown[] = [];
let cursor = 0;
let effects: (() => void)[] = [];
let search = new URLSearchParams();
let feed: WorkReportFeedDTO;
let readError: unknown;
let writeError: unknown;
let loading = false;
let confirm = true;
let pending = false;
let resolveWrite: (() => void) | undefined;
const calls: { method: string; input: unknown }[] = [];
const queries: unknown[] = [];
const authorQueries: unknown[] = [];
const patches: Record<string, unknown>[] = [];
const listeners = new Map<string, Set<unknown>>();
let form: typeof import("../src/components/work-report-form");
let card: typeof import("../src/components/work-report-card");
let workspace: typeof import("../src/components/work-report-workspace");
function useState(initial: unknown) {
  const index = cursor++;
  if (!(index in slots))
    slots[index] = typeof initial === "function" ? initial() : initial;
  return [
    slots[index],
    (value: unknown) => {
      slots[index] = typeof value === "function" ? value(slots[index]) : value;
    },
  ];
}
function useRef(current: unknown) {
  const index = cursor++;
  if (!(index in slots)) slots[index] = { current };
  return slots[index];
}
function useEffect(callback: () => void | (() => void), deps: unknown[]) {
  const index = cursor++;
  const previous = slots[index] as
    { deps: unknown[]; cleanup?: () => void } | undefined;
  if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i])))
    effects.push(() => {
      previous?.cleanup?.();
      slots[index] = { deps, cleanup: callback() };
    });
}
function render<T>(component: () => T): T {
  cursor = 0;
  effects = [];
  const tree = component();
  for (const effect of effects) effect();
  return tree;
}
function nodes(tree: unknown): Element[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== "object" || !("props" in tree)) return [];
  const node = tree as Element;
  return [
    node,
    ...Object.values(node.props)
      .filter((value) => typeof value !== "function")
      .flatMap(nodes),
  ];
}
function text(tree: unknown): string {
  if (Array.isArray(tree)) return tree.map(text).join(" ");
  if (typeof tree === "string" || typeof tree === "number") return String(tree);
  if (!tree || typeof tree !== "object" || !("props" in tree)) return "";
  return text((tree as Element).props.children);
}
function buttons(tree: unknown) {
  return nodes(tree).filter((node) => node.type === "button");
}
function button(tree: unknown, label: string) {
  const found = buttons(tree).find((node) => text(node) === label);
  assert.ok(found, label);
  return found;
}
function change(tree: unknown, id: string, value: string) {
  const field = nodes(tree).find((node) => node.props.id === id);
  assert.ok(field, id);
  (field.props.onChange as (event: { target: { value: string } }) => void)({
    target: { value },
  });
}
async function submit(tree: unknown) {
  const node = nodes(tree).find((node) => node.type === "form");
  assert.ok(node);
  await (
    node.props.onSubmit as (event: {
      preventDefault: () => void;
    }) => Promise<void>
  )({ preventDefault: noop });
}
const author = {
  id: "employee",
  name: "Team Member",
  image: null,
  role: "EMPLOYEE",
};
const report: WorkReportDTO = {
  id: "report-1",
  version: 1,
  authorId: author.id,
  author,
  title: "Daily handover",
  content: "Completed inventory.\n<script>plain text</script>",
  workDate: "2026-11-22",
  createdAt: "2026-11-22T00:01:00.000Z",
  updatedAt: "2026-11-22T00:01:00.000Z",
  edited: false,
  permissions: { canEdit: true, canDelete: true },
};
function query(currentData: unknown, error?: unknown) {
  return {
    currentData,
    error,
    isLoading: loading,
    isFetching: loading,
    refetch: () => ({ unwrap: async () => currentData }),
  };
}
function mutation(method: string) {
  return (input: unknown) => {
    calls.push({ method, input });
    return {
      unwrap: () =>
        writeError
          ? Promise.reject(writeError)
          : pending
            ? new Promise<void>((resolve) => {
                resolveWrite = resolve;
              })
            : Promise.resolve(report),
    };
  };
}
before(async () => {
  mock.module("react/jsx-runtime", {
    namedExports: { jsx: element, jsxs: element, Fragment: "fragment" },
  });
  mock.module("react", {
    namedExports: {
      useState,
      useRef,
      useEffect,
      useEffectEvent: (fn: unknown) => fn,
    },
    defaultExport: {
      createContext: () => ({}),
      forwardRef: () => null,
      createElement: () => null,
    },
  });
  mock.module("next/image", { defaultExport: () => null });
  mock.module("next-intl", {
    namedExports: {
      useLocale: () => "en",
      useTranslations: () =>
        Object.assign(
          (key: keyof typeof en, values?: Record<string, string>) => {
            let value = en[key] ?? key;
            for (const [name, replacement] of Object.entries(values ?? {}))
              value = value.replace(`{${name}}`, String(replacement));
            return value;
          },
          { has: () => true },
        ),
    },
  });
  mock.module("lucide-react", { namedExports: { X: () => null } });
  mock.module("../src/components/work-report-workspace.module.css", {
    defaultExport: {
      workspace: "workspace",
      content: "content",
      report: "report",
      composer: "composer",
    },
  });
  mock.module("../src/lib/client/alerts.ts", {
    namedExports: { confirmAction: async () => confirm },
  });
  mock.module("../src/lib/client/use-debounced-value.ts", {
    namedExports: { useDebouncedValue: (value: unknown) => value },
  });
  mock.module("../src/lib/client/use-url-filters.ts", {
    namedExports: {
      pageFromSearch: (value: string | null) =>
        Number(value) > 0 ? Number(value) : 1,
      useUrlFilters: () => ({
        params: search,
        update: (patch: Record<string, unknown>) => {
          patches.push(patch);
          for (const [key, value] of Object.entries(patch))
            if (value === null || value === undefined || value === "")
              search.delete(key);
            else search.set(key, String(value));
        },
      }),
    },
  });
  mock.module("../src/store/freshness.ts", {
    namedExports: { useFreshness: () => ({}) },
  });
  mock.module("../src/store/use-query-view.ts", {
    namedExports: {
      useQueryView: (result: ReturnType<typeof query>) => ({
        data: result.currentData,
        error: result.error ? "Error" : "",
        loading: result.isLoading,
        isFetching: result.isFetching,
        refresh: result.refetch,
      }),
    },
  });
  mock.module("../src/store/features/work-report/api.ts", {
    namedExports: {
      useWorkReportFeedQuery: (args: unknown) => {
        queries.push(args);
        return query(feed, readError);
      },
      useWorkReportAuthorsQuery: (args: unknown) => {
        authorQueries.push(args);
        return query([author]);
      },
      useCreateWorkReportMutation: () => [mutation("POST")],
      useUpdateWorkReportMutation: () => [mutation("PATCH")],
      useDeleteWorkReportMutation: () => [mutation("DELETE")],
      useLazyWorkReportQuery: () => [
        (id: unknown) => {
          calls.push({ method: "GET", input: id });
          return { unwrap: async () => ({ ...report, version: 2 }) };
        },
      ],
    },
  });
  const component = (name: string) =>
    Object.assign((props: Record<string, unknown>) => element(name, props), {
      displayName: name,
    });
  mock.module("../src/components/ui.tsx", {
    namedExports: {
      date: (value: unknown) => String(value),
      Empty: component("Empty"),
      ErrorNotice: component("ErrorNotice"),
      Loading: component("Loading"),
      Notice: component("Notice"),
      PageHeader: component("PageHeader"),
      Pagination: component("Pagination"),
    },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      addEventListener: (name: string, fn: unknown) => {
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name)!.add(fn);
      },
      removeEventListener: (name: string, fn: unknown) =>
        listeners.get(name)?.delete(fn),
    },
  });
  form = await import("../src/components/work-report-form");
  card = await import("../src/components/work-report-card");
  workspace = await import("../src/components/work-report-workspace");
});
beforeEach(() => {
  slots = [];
  cursor = 0;
  effects = [];
  search = new URLSearchParams();
  readError = undefined;
  writeError = undefined;
  loading = false;
  confirm = true;
  pending = false;
  resolveWrite = undefined;
  calls.length = 0;
  queries.length = 0;
  authorQueries.length = 0;
  patches.length = 0;
  listeners.clear();
  feed = {
    items: [report],
    total: 1,
    page: 1,
    pageSize: 20,
    totalPages: 1,
    date: "2026-11-22",
    today: "2026-11-22",
    timezone: "Asia/Dhaka",
  };
});

test("all roles see shared feed cards but only the author sees mutation controls", () => {
  for (const role of ["SUPER_ADMIN", "MANAGE_DRIVER", "EMPLOYEE"]) {
    for (const own of [true, false]) {
      const permissions = reportPermissions(
        { id: own ? author.id : "another-person", role },
        { authorId: author.id, deletedAt: null },
      );
      const tree = card.WorkReportCard({
        report: { ...report, permissions },
        timezone: "Asia/Dhaka",
        disabled: false,
        onEdit: noop,
        onDelete: noop,
      });
      assert.ok(text(tree).includes(report.content));
      assert.equal(buttons(tree).length, own ? 2 : 0, `${role}/${own}`);
    }
  }
});
test("feed preserves line breaks and renders titles/content as text with minimal author attribution", () => {
  const edited = {
    ...report,
    edited: true,
    updatedAt: "2026-11-22T01:00:00.000Z",
  };
  const tree = card.WorkReportCard({
    report: edited,
    timezone: "Asia/Dhaka",
    disabled: false,
    onEdit: noop,
    onDelete: noop,
  });
  assert.ok(text(tree).includes(report.content));
  assert.ok(text(tree).includes(author.name));
  assert.equal(
    nodes(tree).some((node) =>
      Object.hasOwn(node.props, "dangerouslySetInnerHTML"),
    ),
    false,
  );
  assert.ok(
    nodes(tree).some(
      (node) =>
        node.type === "time" && node.props.dateTime === edited.updatedAt,
    ),
  );
  assert.equal(text(tree).includes("@"), false);
});
test("default feed is everyone's today; My Reports clears author and resets pagination", () => {
  let tree = render(() => workspace.WorkReportWorkspace());
  assert.deepEqual(queries.at(-1), { page: 1, pageSize: 20, mine: false });
  search = new URLSearchParams("authorId=manager&page=4");
  tree = render(() => workspace.WorkReportWorkspace());
  (button(tree, en.myReports).props.onClick as () => void)();
  assert.deepEqual(patches.at(-1), {
    mine: "true",
    authorId: null,
    page: null,
  });
  tree = render(() => workspace.WorkReportWorkspace());
  assert.equal((queries.at(-1) as { mine: boolean }).mine, true);
  assert.equal(Object.hasOwn(queries.at(-1) as object, "authorId"), false);
});
test("historical browsing labels the composer for server today without a client-controlled work date", async () => {
  search = new URLSearchParams("date=2026-11-20");
  feed = { ...feed, date: "2026-11-20" };
  const tree = render(() => workspace.WorkReportWorkspace());
  assert.ok(text(tree).includes("New reports will still be posted for today"));
  const composer = nodes(tree).find(
    (node) => node.type === form.WorkReportForm,
  );
  assert.ok(composer);
  assert.equal(composer.props.today, "2026-11-22");
  const save = composer.props.onSave as (
    values: { title: null; content: string },
    requestId: string,
  ) => Promise<boolean>;
  assert.equal(
    await save(
      { title: null, content: "A fresh update" },
      "f1890c81-668c-4be9-83b9-55b60cbf72a6",
    ),
    true,
  );
  assert.deepEqual(calls[0], {
    method: "POST",
    input: {
      title: null,
      content: "A fresh update",
      requestId: "f1890c81-668c-4be9-83b9-55b60cbf72a6",
    },
  });
  const updated = render(() => workspace.WorkReportWorkspace());
  assert.ok(button(updated, en.viewToday));
});
test("empty date, no matching results, out-of-range pages, loading and errors have recovery states", () => {
  feed = { ...feed, items: [], total: 0 };
  let tree = render(() => workspace.WorkReportWorkspace());
  assert.ok(nodes(tree).some((node) => node.props.title === en.emptyDate));
  search.set("search", "missing");
  tree = render(() => workspace.WorkReportWorkspace());
  assert.ok(nodes(tree).some((node) => node.props.title === en.emptyMatching));
  assert.ok(button(tree, en.clear));
  search = new URLSearchParams("page=99");
  feed.total = 2;
  tree = render(() => workspace.WorkReportWorkspace());
  assert.ok(nodes(tree).some((node) => node.props.title === en.emptyPage));
  assert.ok(button(tree, en.firstPage));
  loading = true;
  tree = render(() => workspace.WorkReportWorkspace());
  assert.ok(
    nodes(tree).some(
      (node) =>
        typeof node.type === "function" &&
        (node.type as { displayName?: string }).displayName === "Loading",
    ),
  );
  loading = false;
  readError = { status: 500 };
  tree = render(() => workspace.WorkReportWorkspace());
  assert.ok(button(tree, en.retry));
});
test("author filter is searchable and does not fall back to email addresses", () => {
  let tree = render(() =>
    workspace.WorkReportAuthorFilter({
      value: "",
      date: "2026-11-22",
      disabled: false,
      onChange: noop,
    }),
  );
  change(tree, "report-author-search", "Manager");
  tree = render(() =>
    workspace.WorkReportAuthorFilter({
      value: "",
      date: "2026-11-22",
      disabled: false,
      onChange: noop,
    }),
  );
  assert.deepEqual(authorQueries.at(-1), {
    search: "Manager",
    date: "2026-11-22",
  });
  assert.equal(text(tree).includes("@"), false);
  assert.ok(nodes(tree).some((node) => node.props.id === "report-author"));
});
test("composer validates required text, preserves failed text/UUID, and clears only after success", async () => {
  let success = false;
  const submitted: { values: unknown; requestId: string }[] = [];
  const props = {
    today: "2026-11-22",
    timezone: "Asia/Dhaka",
    busy: false,
    blocked: false,
    error: "",
    onSave: async (values: unknown, requestId: string) => {
      submitted.push({ values, requestId });
      return success;
    },
    onRefresh: noop,
  };
  let tree = render(() => form.WorkReportForm(props));
  await submit(tree);
  assert.equal(submitted.length, 0);
  tree = render(() => form.WorkReportForm(props));
  assert.ok(
    nodes(tree).some((node) => node.props.message === en.contentRequired),
  );
  change(tree, "report-title", "  Update  ");
  change(tree, "report-content", "  Results\nNext steps  ");
  tree = render(() => form.WorkReportForm(props));
  await submit(tree);
  tree = render(() => form.WorkReportForm(props));
  assert.equal(
    nodes(tree).find((node) => node.props.id === "report-content")?.props.value,
    "  Results\nNext steps  ",
  );
  success = true;
  await submit(tree);
  tree = render(() => form.WorkReportForm(props));
  assert.equal(
    nodes(tree).find((node) => node.props.id === "report-content")?.props.value,
    "",
  );
  assert.equal(submitted[0].requestId, submitted[1].requestId);
  assert.deepEqual(submitted[0].values, {
    title: "Update",
    content: "Results\nNext steps",
  });
});
test("editor protects unsaved changes and cancelling discard keeps entered content", async () => {
  let closed = 0;
  const props = {
    report,
    today: "2026-11-22",
    timezone: "Asia/Dhaka",
    busy: false,
    blocked: false,
    error: "",
    onSave: async () => false,
    onRefresh: noop,
    onClose: () => {
      closed++;
    },
  };
  let tree = render(() => form.WorkReportForm(props));
  change(tree, "report-edit-content", "Unsaved corrections");
  tree = render(() => form.WorkReportForm(props));
  assert.equal(listeners.get("beforeunload")?.size, 1);
  confirm = false;
  (button(tree, en.cancel).props.onClick as () => void)();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, 0);
  confirm = true;
  (button(tree, en.cancel).props.onClick as () => void)();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, 1);
});
test("delete confirmation and single-submit gate prevent canceled or duplicate deletes", async () => {
  let tree = render(() => workspace.WorkReportWorkspace());
  let item = nodes(tree).find((node) => node.type === card.WorkReportCard);
  assert.ok(item);
  confirm = false;
  (item.props.onDelete as (report: WorkReportDTO) => void)(report);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 0);
  tree = render(() => workspace.WorkReportWorkspace());
  item = nodes(tree).find((node) => node.type === card.WorkReportCard);
  assert.ok(item);
  confirm = true;
  pending = true;
  (item.props.onDelete as (report: WorkReportDTO) => void)(report);
  (item.props.onDelete as (report: WorkReportDTO) => void)(report);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    method: "DELETE",
    input: { id: report.id, input: { expectedVersion: 1 } },
  });
  resolveWrite?.();
});
test("ambiguous posting failure keeps a refreshable submission gate and performs no retry", async () => {
  let tree = render(() => workspace.WorkReportWorkspace());
  let composer = nodes(tree).find((node) => node.type === form.WorkReportForm);
  assert.ok(composer);
  writeError = { status: "FETCH_ERROR", code: "NETWORK_ERROR" };
  const save = composer.props.onSave as (
    values: { title: null; content: string },
    requestId: string,
  ) => Promise<boolean>;
  assert.equal(
    await save(
      { title: null, content: "Keep this entered content" },
      "f1890c81-668c-4be9-83b9-55b60cbf72a6",
    ),
    false,
  );
  tree = render(() => workspace.WorkReportWorkspace());
  composer = nodes(tree).find((node) => node.type === form.WorkReportForm);
  assert.ok(composer);
  assert.equal(composer.props.blocked, true);
  assert.equal(calls.length, 1);
  assert.ok(button(tree, en.refresh));
});

test("clearing a failed composer requires confirmation and starts a distinct intentional report identity", async () => {
  const identities: string[] = [];
  let cleared = 0;
  const props = {
    today: "2026-11-22",
    timezone: "Asia/Dhaka",
    busy: false,
    blocked: false,
    error: "",
    onSave: async (_values: unknown, requestId: string) => {
      identities.push(requestId);
      return false;
    },
    onRefresh: noop,
    onClear: () => {
      cleared++;
    },
  };
  let tree = render(() => form.WorkReportForm(props));
  change(tree, "report-content", "First attempted report");
  tree = render(() => form.WorkReportForm(props));
  await submit(tree);
  confirm = false;
  (button(tree, en.clearForm).props.onClick as () => void)();
  await new Promise((resolve) => setImmediate(resolve));
  tree = render(() => form.WorkReportForm(props));
  assert.equal(
    nodes(tree).find((node) => node.props.id === "report-content")?.props.value,
    "First attempted report",
  );
  assert.equal(cleared, 0);
  confirm = true;
  (button(tree, en.clearForm).props.onClick as () => void)();
  await new Promise((resolve) => setImmediate(resolve));
  tree = render(() => form.WorkReportForm(props));
  assert.equal(
    nodes(tree).find((node) => node.props.id === "report-content")?.props.value,
    "",
  );
  assert.equal(cleared, 1);
  change(tree, "report-content", "An intentional new report");
  tree = render(() => form.WorkReportForm(props));
  await submit(tree);
  assert.notEqual(identities[0], identities[1]);
});
