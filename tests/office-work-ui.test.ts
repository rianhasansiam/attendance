import assert from "node:assert/strict";
import { before, beforeEach, mock, test } from "node:test";
import en from "../messages/en/officeWork.json";
import type {
  OfficeWorkOverviewDTO,
  OfficeWorkTaskDTO,
} from "../src/modules/office-work/contracts";
import { taskPermissions } from "../src/modules/office-work/permissions";

// Exercise rendered component output and event handlers with the same lightweight
// JSX/hook harness used by the existing client tests. Server policy remains real.
type Element = { type: unknown; props: Record<string, unknown> };
const element = (type: unknown, props: Record<string, unknown>) => ({
  type,
  props,
});
const noop = () => undefined;
let slots: unknown[] = [];
let cursor = 0;
let effect: (() => void) | undefined;
let cleanup: (() => void) | undefined;
let search = new URLSearchParams();
let overview: OfficeWorkOverviewDTO;
let queryError: unknown;
let taskReadError: unknown;
let actionCalls: unknown[] = [];
let completeWrite: (() => void) | undefined;
let pendingWrite = false;
const patches: Record<string, unknown>[] = [];
const queryArgs: unknown[] = [];
let detail: typeof import("../src/components/office-work-detail");
let form: typeof import("../src/components/office-work-form");
let workspace: typeof import("../src/components/office-work-workspace");

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
function render<T>(component: () => T): T {
  cursor = 0;
  const tree = component();
  if (effect) {
    const run = effect;
    effect = undefined;
    run();
  }
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
function textContent(tree: unknown): string {
  if (Array.isArray(tree)) return tree.map(textContent).join(" ");
  if (typeof tree === "string" || typeof tree === "number") return String(tree);
  if (!tree || typeof tree !== "object" || !("props" in tree)) return "";
  const node = tree as Element;
  return textContent(node.props.children);
}
function buttons(tree: unknown) {
  return nodes(tree).filter((node) => node.type === "button");
}
function click(tree: unknown, label: string) {
  const button = buttons(tree).find(
    (node) => textContent(node.props.children) === label,
  );
  assert.ok(button, `Missing button ${label}`);
  (button.props.onClick as () => void)();
}
const user = {
  id: "employee-1",
  name: "Assigned employee",
  email: "employee@example.test",
  role: "EMPLOYEE",
};
const manager = {
  id: "manager-1",
  name: "Manager",
  email: "manager@example.test",
  role: "MANAGE_DRIVER",
};
const base: OfficeWorkTaskDTO = {
  id: "task-1",
  version: 4,
  title: "Review <script>plain text</script>",
  description: "Keep descriptions as plain text.",
  status: "PENDING",
  priority: "HIGH",
  assigneeId: user.id,
  createdById: manager.id,
  assignee: user,
  createdBy: manager,
  dueDate: "2026-11-21",
  startedAt: null,
  completedAt: null,
  archivedAt: null,
  createdAt: "2026-11-20T09:00:00.000Z",
  updatedAt: "2026-11-20T09:00:00.000Z",
  overdue: false,
  permissions: {
    canEdit: false,
    canReassign: false,
    canStart: true,
    canComplete: false,
    canReopen: false,
    canArchive: false,
    requiresOverrideReason: false,
  },
};
function result(currentData: unknown, error?: unknown) {
  return {
    currentData,
    error,
    isFetching: false,
    isLoading: false,
    refetch: () => ({ unwrap: async () => currentData }),
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
      useEffect: (callback: () => () => void) => {
        cursor++;
        if (!cleanup)
          effect = () => {
            cleanup = callback();
          };
      },
      useEffectEvent: (fn: unknown) => fn,
      useSyncExternalStore: () => true,
    },
  });
  mock.module("next-intl", {
    namedExports: {
      useLocale: () => "en",
      useTranslations:
        () => (key: keyof typeof en, values?: Record<string, string>) => {
          let value = en[key] ?? key;
          for (const [name, replacement] of Object.entries(values ?? {}))
            value = value.replace(`{${name}}`, String(replacement));
          return value;
        },
    },
  });
  mock.module("lucide-react", {
    namedExports: {
      ClipboardList: () => null,
      Plus: () => null,
      X: () => null,
    },
  });
  mock.module("../src/components/office-work-workspace.module.css", {
    defaultExport: {
      workspace: "workspace",
      actionButtons: "actionButtons",
      form: "form",
      detail: "detail",
    },
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
  mock.module("../src/lib/client/use-debounced-value.ts", {
    namedExports: { useDebouncedValue: (value: unknown) => value },
  });
  mock.module("../src/lib/client/alerts.ts", {
    namedExports: {
      confirmAction: async () => true,
      promptAction: async () => "Required administrative reason",
    },
  });
  mock.module("../src/store/freshness.ts", {
    namedExports: { useFreshness: () => ({}) },
  });
  mock.module("../src/store/use-query-view.ts", {
    namedExports: {
      useQueryView: (query: ReturnType<typeof result>) => ({
        data: query.currentData,
        error: query.error ? "Failed" : "",
        loading: query.isLoading,
        isFetching: query.isFetching,
        refresh: query.refetch,
      }),
    },
  });
  mock.module("../src/store/features/office-work/api.ts", {
    namedExports: {
      useOfficeWorkQuery: (args: unknown) => {
        queryArgs.push(args);
        return result(overview, queryError);
      },
      useOfficeWorkTaskQuery: () =>
        result(
          {
            task: base,
            activities: [],
            activityPage: 1,
            activityPageSize: 20,
            activityTotal: 0,
          },
          taskReadError,
        ),
      useOfficeWorkAssigneesQuery: () => result([user]),
      useCreateOfficeWorkMutation: () => [() => ({ unwrap: async () => base })],
      useUpdateOfficeWorkMutation: () => [() => ({ unwrap: async () => base })],
      useActOnOfficeWorkMutation: () => [
        (args: unknown) => {
          actionCalls.push(args);
          return {
            unwrap: () =>
              pendingWrite
                ? new Promise<void>((resolve) => {
                    completeWrite = resolve;
                  })
                : Promise.resolve(base),
          };
        },
      ],
    },
  });
  const passthrough = (name: string) => (props: Record<string, unknown>) =>
    element(name, props);
  mock.module("../src/components/ui.tsx", {
    namedExports: {
      date: (value: unknown) => String(value),
      ErrorNotice: passthrough("ErrorNotice"),
      Loading: passthrough("Loading"),
      Pagination: passthrough("Pagination"),
      Empty: passthrough("Empty"),
      PageHeader: passthrough("PageHeader"),
      Notice: passthrough("Notice"),
    },
  });
  detail = await import("../src/components/office-work-detail");
  form = await import("../src/components/office-work-form");
  workspace = await import("../src/components/office-work-workspace");
});

beforeEach(() => {
  slots = [];
  cursor = 0;
  effect = undefined;
  cleanup = undefined;
  search = new URLSearchParams();
  queryError = undefined;
  taskReadError = undefined;
  actionCalls = [];
  completeWrite = undefined;
  pendingWrite = false;
  patches.length = 0;
  queryArgs.length = 0;
  overview = {
    items: [base],
    total: 1,
    page: 1,
    pageSize: 20,
    totalPages: 1,
    dashboard: {
      total: 6,
      pending: 3,
      processing: 2,
      done: 1,
      overdue: 1,
      dueToday: 2,
      highPriority: 2,
      completionPercent: 16.7,
    },
    workload: [
      { assignee: user, pending: 1, processing: 0, done: 0, overdue: 0 },
    ],
    assignees: [user, manager],
    creators: [manager],
    today: "2026-11-21",
    timezone: "Asia/Dhaka",
  };
});

test("UI action buttons follow authoritative task capabilities for each role and status", () => {
  const actors = [
    { id: "admin-1", role: "SUPER_ADMIN" },
    { id: manager.id, role: "MANAGE_DRIVER" },
    { id: user.id, role: "EMPLOYEE" },
  ];
  for (const actor of actors) {
    for (const status of ["PENDING", "PROCESSING", "DONE"] as const) {
      const task = {
        ...base,
        status,
        permissions: taskPermissions(actor, { ...base, status }),
      };
      const tree = detail.OfficeWorkActions({
        task,
        disabled: false,
        onEdit: noop,
        onReassign: noop,
        onAction: noop,
      });
      const labels = buttons(tree).map((button) =>
        textContent(button.props.children),
      );
      assert.equal(labels.includes(en.edit), task.permissions.canEdit);
      assert.equal(labels.includes(en.reassign), task.permissions.canReassign);
      assert.equal(labels.includes(en.start), task.permissions.canStart);
      assert.equal(labels.includes(en.complete), task.permissions.canComplete);
      assert.equal(labels.includes(en.reopen), task.permissions.canReopen);
      assert.equal(labels.includes(en.archive), task.permissions.canArchive);
    }
  }
  const assignedManager = {
    ...base,
    assignee: manager,
    assigneeId: manager.id,
    status: "PROCESSING" as const,
  };
  const permissions = taskPermissions(manager, assignedManager);
  assert.equal(permissions.canEdit, false);
  const labels = buttons(
    detail.OfficeWorkActions({
      task: { ...assignedManager, permissions },
      disabled: false,
      onEdit: noop,
      onReassign: noop,
      onAction: noop,
    }),
  ).map((button) => textContent(button.props.children));
  assert.deepEqual(labels, [en.complete]);
  const archived = { ...base, archivedAt: "2026-11-21T00:00:00Z" };
  assert.equal(
    buttons(
      detail.OfficeWorkActions({
        task: {
          ...archived,
          permissions: taskPermissions(actors[0], archived),
        },
        disabled: false,
        onEdit: noop,
        onReassign: noop,
        onAction: noop,
      }),
    ).length,
    0,
  );
});

test("employee view forces My Work, omits global filters, workload and create controls", () => {
  search = new URLSearchParams(
    "view=all&assigneeId=someone-else&createdById=manager-2",
  );
  const tree = render(() =>
    workspace.OfficeWorkWorkspace({ role: "EMPLOYEE" }),
  );
  assert.equal((queryArgs.at(-1) as { view: string }).view, "mine");
  assert.equal(Object.hasOwn(queryArgs.at(-1) as object, "assigneeId"), false);
  assert.equal(Object.hasOwn(queryArgs.at(-1) as object, "createdById"), false);
  assert.equal(
    buttons(tree).some((button) =>
      textContent(button.props.children).includes(en.create),
    ),
    false,
  );
  assert.equal(
    nodes(tree).some((node) => node.props.id === "work-assignee-filter"),
    false,
  );
  assert.equal(
    nodes(tree).some((node) => node.props.id === "work-creator-filter"),
    false,
  );
  assert.equal(textContent(tree).includes(en.workload), false);
});

test("management view offers all/mine scopes, creator/assignee filters and workload", () => {
  const tree = render(() =>
    workspace.OfficeWorkWorkspace({ role: "MANAGE_DRIVER" }),
  );
  assert.ok(
    buttons(tree).some(
      (button) => textContent(button.props.children) === en.allWork,
    ),
  );
  assert.ok(
    buttons(tree).some(
      (button) => textContent(button.props.children) === en.myWork,
    ),
  );
  assert.ok(
    nodes(tree).some((node) => node.props.id === "work-assignee-filter"),
  );
  assert.ok(
    nodes(tree).some((node) => node.props.id === "work-creator-filter"),
  );
  assert.ok(textContent(tree).includes(en.workload));
  click(tree, en.myWork);
  assert.deepEqual(patches.at(-1), {
    view: "mine",
    assigneeId: null,
    page: null,
  });
});

test("dashboard status selection resets pagination while retaining base filters and other card counts", () => {
  search = new URLSearchParams("search=inventory&priority=HIGH&page=4");
  let tree = render(() =>
    workspace.OfficeWorkWorkspace({ role: "MANAGE_DRIVER" }),
  );
  const pending = buttons(tree).find(
    (button) => button.props["aria-label"] === "Show Pending tasks",
  );
  assert.ok(pending);
  (pending.props.onClick as () => void)();
  tree = render(() => workspace.OfficeWorkWorkspace({ role: "MANAGE_DRIVER" }));
  assert.equal(search.get("search"), "inventory");
  assert.equal(search.get("priority"), "HIGH");
  assert.equal(search.get("page"), null);
  assert.equal(search.get("status"), "PENDING");
  const done = buttons(tree).find(
    (button) => button.props["aria-label"] === "Show Done tasks",
  );
  assert.ok(done);
  assert.match(textContent(done), /1/);
  assert.match(textContent(tree), /Task list: Pending/);
});

test("task list includes desktop table and readable mobile cards with plain text values", () => {
  const tree = render(() =>
    workspace.OfficeWorkWorkspace({ role: "MANAGE_DRIVER" }),
  );
  assert.ok(nodes(tree).some((node) => node.type === "table"));
  assert.ok(nodes(tree).some((node) => node.type === "article"));
  assert.ok(
    nodes(tree).some(
      (node) => node.type === "button" && textContent(node) === base.title,
    ),
  );
  assert.equal(
    nodes(tree).some((node) =>
      Object.hasOwn(node.props, "dangerouslySetInnerHTML"),
    ),
    false,
  );
});

test("empty, no matching, out-of-range and error states offer distinct recovery", () => {
  overview.items = [];
  overview.total = 0;
  let tree = render(() => workspace.OfficeWorkWorkspace({ role: "EMPLOYEE" }));
  let empty = nodes(tree).find((node) => node.props.title === en.emptyEmployee);
  assert.ok(empty);
  search.set("search", "missing");
  tree = render(() => workspace.OfficeWorkWorkspace({ role: "EMPLOYEE" }));
  empty = nodes(tree).find((node) => node.props.title === en.noMatches);
  assert.ok(empty);
  assert.ok(buttons(tree).some((button) => textContent(button) === en.clear));
  search = new URLSearchParams("page=50");
  overview.total = 2;
  tree = render(() => workspace.OfficeWorkWorkspace({ role: "EMPLOYEE" }));
  assert.ok(nodes(tree).find((node) => node.props.title === en.emptyPage));
  click(tree, en.firstPage);
  assert.equal(search.get("page"), null);
  queryError = { status: 500 };
  tree = render(() => workspace.OfficeWorkWorkspace({ role: "EMPLOYEE" }));
  assert.ok(buttons(tree).some((button) => textContent(button) === en.retry));
});

test("edit form labels bounded fields and retains date-only deadline", () => {
  const tree = render(() =>
    form.OfficeWorkForm({
      task: base,
      busy: false,
      blocked: false,
      error: "",
      close: noop,
      refresh: noop,
      submit: async () => {},
    }),
  );
  const inputs = nodes(tree);
  const title = inputs.find((node) => node.props.id === "office-work-title");
  assert.ok(title);
  assert.equal(title.props.required, true);
  assert.equal(title.props.maxLength, 200);
  const due = inputs.find((node) => node.props.id === "office-work-due");
  assert.ok(due);
  assert.equal(due.props.type, "date");
  assert.equal(due.props.value, "2026-11-21");
  assert.ok(
    inputs.find(
      (node) =>
        node.type === "label" &&
        node.props.htmlFor === "office-work-description",
    ),
  );
  assert.ok(
    inputs.find(
      (node) =>
        node.props.id === "office-work-current-assignee" &&
        node.props.readOnly === true,
    ),
  );
});

test("blocked forms expose refresh and cannot submit duplicate or stale edits", () => {
  let calls = 0;
  const tree = render(() =>
    form.OfficeWorkForm({
      task: base,
      busy: false,
      blocked: true,
      error: en.conflict,
      close: noop,
      refresh: noop,
      submit: async () => {
        calls++;
      },
    }),
  );
  assert.ok(
    buttons(tree).find((button) => textContent(button) === en.refreshTask),
  );
  assert.equal(
    buttons(tree).find((button) => button.props.type === "submit")?.props
      .disabled,
    true,
  );
  const formNode = nodes(tree).find((node) => node.type === "form");
  assert.ok(formNode);
  (formNode.props.onSubmit as (event: { preventDefault: () => void }) => void)({
    preventDefault: noop,
  });
  assert.equal(calls, 0);
});

test("detail suppresses cached data after a denied or reassigned task read", () => {
  taskReadError = { status: 404 };
  const tree = render(() =>
    detail.OfficeWorkDetail({
      id: base.id,
      timezone: "Asia/Dhaka",
      busy: false,
      blocked: false,
      error: "",
      close: noop,
      onEdit: noop,
      onReassign: noop,
      onAction: noop,
      onRefreshed: noop,
    }),
  );
  assert.equal(textContent(tree).includes(base.title), false);
  assert.equal(textContent(tree).includes(base.description!), false);
  assert.ok(
    nodes(tree).some((node) => node.props.message === en.taskUnavailable),
  );
});

test("a hidden in-flight workspace restores a refreshable gate and fences late write responses", async () => {
  pendingWrite = true;
  let tree = render(() => workspace.OfficeWorkWorkspace({ role: "EMPLOYEE" }));
  const actions = nodes(tree).find(
    (node) => node.type === detail.OfficeWorkActions,
  );
  assert.ok(actions);
  (actions.props.onAction as (task: OfficeWorkTaskDTO, action: string) => void)(
    base,
    "start",
  );
  assert.equal(actionCalls.length, 1);
  // Synchronous submission lock prevents the second click in the same render.
  (actions.props.onAction as (task: OfficeWorkTaskDTO, action: string) => void)(
    base,
    "start",
  );
  assert.equal(actionCalls.length, 1);
  assert.ok(cleanup);
  cleanup();
  cleanup = undefined;
  tree = render(() => workspace.OfficeWorkWorkspace({ role: "EMPLOYEE" }));
  const refresh = buttons(tree).filter(
    (button) => textContent(button) === en.refresh,
  );
  assert.ok(refresh.some((button) => button.props.disabled !== true));
  assert.ok(textContent(tree).includes(en.conflict));
  completeWrite?.();
  await new Promise((resolve) => setImmediate(resolve));
  tree = render(() => workspace.OfficeWorkWorkspace({ role: "EMPLOYEE" }));
  assert.ok(textContent(tree).includes(en.conflict));
  assert.equal(
    nodes(tree).some((node) => node.props.children === en.saved),
    false,
  );
});

test("create form validates the title and preserves one request identity across a safe retry", async () => {
  const submitted: {
    values: import("../src/components/office-work-form").OfficeWorkFormValues;
    requestId: string;
  }[] = [];
  const props = {
    busy: false,
    blocked: false,
    error: "",
    close: noop,
    refresh: noop,
    submit: async (
      values: import("../src/components/office-work-form").OfficeWorkFormValues,
      requestId: string,
    ) => {
      submitted.push({ values, requestId });
    },
  };
  let tree = render(() => form.OfficeWorkForm(props));
  let formNode = nodes(tree).find((node) => node.type === "form");
  assert.ok(formNode);
  await (
    formNode.props.onSubmit as (event: {
      preventDefault: () => void;
    }) => Promise<void>
  )({ preventDefault: noop });
  assert.equal(submitted.length, 0);
  tree = render(() => form.OfficeWorkForm(props));
  assert.ok(nodes(tree).some((node) => node.props.message === en.missingTitle));
  const title = nodes(tree).find(
    (node) => node.props.id === "office-work-title",
  );
  assert.ok(title);
  (title.props.onChange as (event: { target: { value: string } }) => void)({
    target: { value: "  Prepare handover  " },
  });
  const assignee = nodes(tree).find(
    (node) => node.type === form.OfficeWorkAssignee,
  );
  assert.ok(assignee);
  (assignee.props.onChange as (id: string) => void)(user.id);
  const due = nodes(tree).find((node) => node.props.id === "office-work-due");
  assert.ok(due);
  (due.props.onChange as (event: { target: { value: string } }) => void)({
    target: { value: "2026-11-21" },
  });
  tree = render(() => form.OfficeWorkForm(props));
  formNode = nodes(tree).find((node) => node.type === "form");
  assert.ok(formNode);
  const submit = formNode.props.onSubmit as (event: {
    preventDefault: () => void;
  }) => Promise<void>;
  await submit({ preventDefault: noop });
  await submit({ preventDefault: noop });
  assert.equal(submitted.length, 2);
  assert.deepEqual(submitted[0].values, {
    title: "Prepare handover",
    description: null,
    assigneeId: user.id,
    priority: "MEDIUM",
    dueDate: "2026-11-21",
  });
  assert.match(submitted[0].requestId, /^[0-9a-f-]{36}$/);
  assert.equal(submitted[0].requestId, submitted[1].requestId);
});

test("eligible-assignee control provides a labeled search and required bounded-result selection", () => {
  const tree = render(() =>
    form.OfficeWorkAssignee({ value: "", onChange: noop, disabled: false }),
  );
  assert.ok(
    nodes(tree).some(
      (node) =>
        node.type === "label" &&
        node.props.htmlFor === "office-work-person-search",
    ),
  );
  const search = nodes(tree).find(
    (node) => node.props.id === "office-work-person-search",
  );
  assert.ok(search);
  assert.equal(search.props.type, "search");
  assert.equal(search.props.maxLength, 200);
  const select = nodes(tree).find(
    (node) => node.props.id === "office-work-assignee",
  );
  assert.ok(select);
  assert.equal(select.props.required, true);
  assert.ok(
    nodes(tree).some(
      (node) => node.type === "option" && node.props.value === user.id,
    ),
  );
});
