// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { Provider } from "react-redux";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SalaryWorkspace } from "@/components/salary-workspace";
import { AppShell } from "@/components/app-shell";
import { loadMessages } from "@/i18n/messages";
import type { Locale } from "@/i18n/config";
import {
  makeStore,
  clearWorkspaceData,
  type AppStore,
} from "@/store/make-store";
import { workspaceClosed } from "@/store/features/workspace-ui/slice";
import { salaryMonthBounds } from "@/modules/salary/contracts";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(window.location.search),
  usePathname: () => window.location.pathname,
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("next-auth/react", () => ({ signOut: vi.fn() }));
vi.mock("@/lib/client/alerts", () => ({
  enqueueNotification: vi.fn(() => () => {}),
}));

const NativeRequest = globalThis.Request;
const employee = {
  id: "employee-1",
  employeeCode: "EMP001",
  name: "Long Employee Name",
  email: "employee@example.test",
  department: "Operations",
  designation: "Engineer",
  officeName: "Dhaka",
};
const settings = {
  id: "setting-1",
  effectiveMonth: "2026-09",
  revision: 1,
  baseSalary: "30000.00",
  overtimeHourlyRate: "200.00",
  createdAt: "2026-09-01T00:00:00Z",
  createdBy: null,
};
const calculation = {
  employee,
  settings,
  period: "2026-10",
  from: "2026-10-01",
  to: "2026-10-31",
  generatedAt: "2026-10-10T06:00:00Z",
  timezone: "Asia/Dhaka",
  currency: "BDT",
  monthlyBaseSalary: "30000.00",
  dailyRate: "1153.85",
  salaryDivisor: 26,
  calendarDays: 31,
  weekendDays: 10,
  payableDays: 21,
  configuredWeekendDays: [5, 6],
  weekendDates: [
    "2026-10-02",
    "2026-10-03",
    "2026-10-09",
    "2026-10-10",
    "2026-10-16",
    "2026-10-17",
    "2026-10-23",
    "2026-10-24",
    "2026-10-30",
    "2026-10-31",
  ],
  baseSalary: "24230.77",
  overtimeHourlyRate: "200.00",
  payableOvertimeMinutes: 750,
  overtimeEarnings: "2500.00",
  totalSalary: "26730.77",
  ongoing: true,
  token: "preview-token",
  attendance: [],
  summary: {
    workedMinutes: 5000,
    payableOvertimeMinutes: 750,
    records: 10,
    unknownOvertimeRecords: 0,
    statusCounts: {},
  },
};
let root: Root;
let container: HTMLDivElement;
let store: AppStore;
let requests: Request[];
let resolveWrite: ((response: Response) => void) | undefined;
let holdWrites: boolean;
let staleExport: boolean;
let downloaded: string[];
let savedSettings = settings;

function response(data: unknown) {
  return Response.json({ success: true, data });
}

beforeEach(() => {
  requests = [];
  holdWrites = false;
  staleExport = false;
  downloaded = [];
  savedSettings = settings;
  resolveWrite = undefined;
  window.history.replaceState(null, "", "/admin/salary-calculator");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "Request",
    class extends NativeRequest {
      constructor(input: RequestInfo | URL, init?: RequestInit) {
        super(
          typeof input === "string"
            ? new URL(input, "https://attendance.test")
            : input,
          init,
        );
      }
    },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      requests.push(request);
      const url = new URL(request.url);
      if (request.method !== "GET" && holdWrites)
        return new Promise<Response>((resolve) => {
          resolveWrite = resolve;
        });
      if (url.pathname.endsWith("/settings")) {
        const input = await request.clone().json();
        savedSettings = { ...settings, ...input, id: "setting-2", revision: 2 };
        return response(savedSettings);
      }
      if (url.pathname.endsWith("/calculate")) {
        const input = await request.clone().json();
        const rangeCalculation =
          input.period === "2026-09" &&
          input.from === "2026-09-19" &&
          input.to === "2026-09-30"
            ? {
                ...calculation,
                calendarDays: 12,
                weekendDays: 3,
                payableDays: 9,
                weekendDates: ["2026-09-19", "2026-09-25", "2026-09-26"],
                baseSalary: "10384.62",
                totalSalary: "12884.62",
              }
            : savedSettings.baseSalary === "18000.00" &&
                input.from === "2026-09-20" &&
                input.to === "2026-09-30"
              ? {
                  ...calculation,
                  monthlyBaseSalary: "18000.00",
                  dailyRate: "692.31",
                  calendarDays: 11,
                  weekendDays: 2,
                  payableDays: 9,
                  weekendDates: ["2026-09-25", "2026-09-26"],
                  settings: savedSettings,
                  baseSalary: "6230.77",
                  payableOvertimeMinutes: 120,
                  overtimeEarnings: "400.00",
                  totalSalary: "6630.77",
                }
              : calculation;
        return response({
          items: [
            {
              ...rangeCalculation,
              period: input.period,
              from: input.from,
              to: input.to,
              ongoing: input.period === "2026-10" && input.to >= "2026-10-10",
            },
          ],
        });
      }
      if (url.pathname.endsWith("/statement")) {
        if (staleExport)
          return Response.json(
            {
              success: false,
              error: { code: "SALARY_SOURCE_CHANGED", message: "Recalculate." },
            },
            { status: 409 },
          );
        return new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]), {
          headers: {
            "Content-Type":
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "Content-Disposition":
              'attachment; filename="salary-statement-EMP001-2026-10.docx"',
          },
        });
      }
      if (url.pathname.includes("/lookups/"))
        return response({
          items: [{ id: "lookup-1", name: "Operations" }],
          total: 1,
          page: 1,
          pageSize: 100,
        });
      const period = url.searchParams.get("period") || "2026-10";
      const bounds = salaryMonthBounds(period);
      const from = url.searchParams.get("from") || bounds.from;
      const to = url.searchParams.get("to") || bounds.to;
      return response({
        items: [
          { employee, settings: savedSettings },
          {
            employee: {
              ...employee,
              id: "employee-2",
              employeeCode: "EMP002",
              name: "Missing Settings",
            },
            settings: null,
          },
        ],
        period,
        from,
        to,
        today: "2026-10-10",
        ongoing: period === "2026-10" && to >= "2026-10-10",
        currentPeriod: "2026-10",
        currency: "BDT",
        timezone: "Asia/Dhaka",
        total: 2,
        page: 1,
        pageSize: 20,
        totalPages: 1,
      });
    }),
  );
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:salary");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    downloaded.push(this.download);
  });
  store = makeStore();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  clearWorkspaceData(store);
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function button(text: string, parent: Element = container) {
  return [...parent.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === text,
  );
}
function row(code: string) {
  return [...container.querySelectorAll("tbody tr")].find((item) =>
    item.textContent?.includes(code),
  )!;
}
async function eventually(assertion: () => void) {
  await act(async () => {
    await vi.waitFor(assertion);
  });
}
async function render(locale: Locale = "en", expectEmployees = true) {
  const messages = await loadMessages(locale);
  await act(async () => {
    root.render(
      h(NextIntlClientProvider, {
        locale,
        timeZone: "Asia/Dhaka",
        messages,
        children: h(Provider, { store, children: h(SalaryWorkspace) }),
      }),
    );
  });
  if (expectEmployees)
    await eventually(() =>
      expect(container.textContent).toContain(employee.employeeCode),
    );
}
async function fill(selector: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(selector)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function submit(selector: string) {
  await act(async () => {
    container
      .querySelector(selector)!
      .closest("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

it("defaults to the server timezone month and blocks missing settings without substituting zero", async () => {
  await render();
  expect(
    container.querySelector<HTMLInputElement>("#salary-period")?.value,
  ).toBe("2026-10");
  expect(container.querySelector<HTMLInputElement>("#salary-from")?.value).toBe(
    "2026-10-01",
  );
  expect(container.querySelector<HTMLInputElement>("#salary-to")?.value).toBe(
    "2026-10-31",
  );
  const listRead = requests.find(
    (request) => new URL(request.url).pathname === "/api/admin/salary",
  )!;
  expect(new URL(listRead.url).searchParams.has("period")).toBe(false);
  expect(container.textContent).toContain("ongoing month");
  expect(container.textContent).toContain(
    "Existing signed overtime adjustments are preserved",
  );
  expect(row("EMP002").textContent).toContain("Not configured");
  expect(button("Calculate", row("EMP002"))?.disabled).toBe(true);
  expect(button("Download DOCX", row("EMP002"))?.disabled).toBe(true);
  expect(button("Download DOCX", row("EMP001"))?.disabled).toBe(true);
  expect(requests.every((request) => request.method === "GET")).toBe(true);
});

it("validates salary settings on the client and submits exact zero strings once while busy", async () => {
  await render();
  await act(async () => button("Salary settings", row("EMP002"))!.click());
  await fill("#salary-baseSalary", "-1");
  await fill("#salary-overtimeHourlyRate", "NaN");
  await submit("#salary-baseSalary");
  expect(container.textContent).toContain("Enter a non-negative amount");
  expect(requests.every((request) => request.method === "GET")).toBe(true);
  await fill("#salary-baseSalary", "0");
  await fill("#salary-overtimeHourlyRate", "0.00");
  holdWrites = true;
  await submit("#salary-baseSalary");
  await submit("#salary-baseSalary");
  await eventually(() =>
    expect(
      requests.filter((request) => request.method === "POST"),
    ).toHaveLength(1),
  );
  expect(
    await requests
      .find((request) => request.method === "POST")!
      .clone()
      .json(),
  ).toEqual({
    employeeId: "employee-2",
    effectiveMonth: "2026-10",
    baseSalary: "0",
    overtimeHourlyRate: "0.00",
  });
  expect(button("Saving…")?.disabled).toBe(true);
  await act(async () =>
    resolveWrite!(
      response({ ...settings, baseSalary: "0.00", overtimeHourlyRate: "0.00" }),
    ),
  );
  await eventually(() =>
    expect(container.textContent).toContain("Salary settings saved"),
  );
  expect(container.querySelector('[role="dialog"]')).toBeNull();
});

it("calculates only configured visible employee identifiers and displays the server fractional-hour breakdown", async () => {
  await render();
  holdWrites = true;
  await act(async () => {
    button("Calculate configured employees on this page")!.click();
    button("Calculate configured employees on this page")!.click();
  });
  await eventually(() =>
    expect(
      requests.filter((request) => request.method === "POST"),
    ).toHaveLength(1),
  );
  const write = requests.find((request) => request.method === "POST")!;
  expect(await write.clone().json()).toEqual({
    period: "2026-10",
    from: "2026-10-01",
    to: "2026-10-31",
    employeeIds: ["employee-1"],
  });
  await act(async () => resolveWrite!(response({ items: [calculation] })));
  await eventually(() =>
    expect(row("EMP001").textContent).toContain("BDT 26,730.77"),
  );
  expect(row("EMP001").textContent).toContain("12h 30m");
  expect(row("EMP001").textContent).toContain("BDT 2,500.00");
  await act(async () => button("View breakdown", row("EMP001"))!.click());
  const dialog = container.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain("+ Overtime earnings");
  expect(dialog.textContent).toContain("= Total calculated salary");
  expect(dialog.textContent).toContain("BDT 26,730.77");
});

it("downloads the exact preview token with a server filename and disables stale previews until recalculation", async () => {
  await render();
  await act(async () => button("Calculate", row("EMP001"))!.click());
  await eventually(() =>
    expect(button("Download DOCX", row("EMP001"))?.disabled).toBe(false),
  );
  await act(async () => button("Download DOCX", row("EMP001"))!.click());
  await eventually(() =>
    expect(downloaded).toEqual(["salary-statement-EMP001-2026-10.docx"]),
  );
  const downloadRequest = requests.find((request) =>
    request.url.endsWith("/statement"),
  )!;
  expect(await downloadRequest.clone().json()).toEqual({
    employeeId: "employee-1",
    period: "2026-10",
    from: "2026-10-01",
    to: "2026-10-31",
    token: "preview-token",
  });
  expect(downloadRequest.cache).toBe("no-store");
  staleExport = true;
  await act(async () => button("Download DOCX", row("EMP001"))!.click());
  await eventually(() =>
    expect(container.textContent).toContain("Recalculate before downloading"),
  );
  expect(button("Download DOCX", row("EMP001"))?.disabled).toBe(true);
  expect(row("EMP001").textContent).not.toContain("BDT 26,730.77");
  expect(downloaded).toHaveLength(1);
  expect(container.textContent).toContain(
    "Salary settings, attendance, or the office weekend policy changed",
  );
  await render("zh-CN");
  expect(container.textContent).toContain(
    "工资设置、考勤或办公室周末规则已更改",
  );
});

it("keeps period-specific previews separate and sends employee search plus department and office filters", async () => {
  await render();
  await act(async () => button("Calculate", row("EMP001"))!.click());
  await eventually(() =>
    expect(row("EMP001").textContent).toContain("BDT 26,730.77"),
  );
  await fill("#salary-period", "2026-09");
  expect(container.querySelector<HTMLInputElement>("#salary-from")?.value).toBe(
    "2026-09-01",
  );
  expect(container.querySelector<HTMLInputElement>("#salary-to")?.value).toBe(
    "2026-09-30",
  );
  await fill("#salary-search", "EMP001");
  const department = container.querySelector<HTMLSelectElement>(
    "#salary-departments",
  )!;
  await act(async () => {
    department.value = "lookup-1";
    department.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await submit("#salary-period");
  await render();
  expect(row("EMP001").textContent).not.toContain("BDT 26,730.77");
  expect(button("Download DOCX", row("EMP001"))?.disabled).toBe(true);
  const query = new URL(requests.at(-1)!.url).searchParams;
  expect(query.get("period")).toBe("2026-09");
  expect(query.get("search")).toBe("EMP001");
  expect(query.get("departmentId")).toBe("lookup-1");
});

it("preserves salary drafts when switching locale and removes confidential data when the session closes", async () => {
  await render();
  await act(async () => button("Salary settings", row("EMP001"))!.click());
  await fill("#salary-baseSalary", "12345.67");
  await render("zh-CN");
  expect(container.textContent).toContain("员工工资设置");
  expect(
    container.querySelector<HTMLInputElement>("#salary-baseSalary")!.value,
  ).toBe("12345.67");
  await act(async () => store.dispatch(workspaceClosed("expired")));
  expect(container.textContent).not.toContain("BDT 30,000.00");
  expect(container.querySelector('[role="dialog"]')).toBeNull();
});

it("fences duplicate downloads and reports invalid content without saving a document", async () => {
  await render();
  await act(async () => button("Calculate", row("EMP001"))!.click());
  await eventually(() =>
    expect(button("Download DOCX", row("EMP001"))?.disabled).toBe(false),
  );
  holdWrites = true;
  await act(async () => {
    button("Download DOCX", row("EMP001"))!.click();
    button("Download DOCX", row("EMP001"))!.click();
  });
  await eventually(() =>
    expect(
      requests.filter((request) => request.url.endsWith("/statement")),
    ).toHaveLength(1),
  );
  await act(async () =>
    resolveWrite!(
      new Response("", {
        headers: {
          "Content-Type":
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        },
      }),
    ),
  );
  await eventually(() =>
    expect(container.textContent).toContain(
      "The statement could not be downloaded",
    ),
  );
  expect(downloaded).toHaveLength(0);
  expect(button("Download DOCX", row("EMP001"))?.disabled).toBe(false);
});

it.each(["ADMIN", "EMPLOYEE", "MANAGE_DRIVER", "SUPER_ADMIN"])(
  "shows the Salary calculator sidebar link only to a super admin (%s)",
  async (role) => {
    const messages = await loadMessages("en");
    await act(async () => {
      root.render(
        h(NextIntlClientProvider, {
          locale: "en",
          messages,
          children: h(Provider, {
            store,
            children: h(AppShell, {
              user: {
                id: "actor",
                profileSlug: "actor",
                name: "Actor",
                email: "actor@example.test",
                role,
              },
              mode: "admin",
              children: h("div", null, "Workspace"),
            }),
          }),
        }),
      );
    });
    const link = container.querySelector(
      'nav a[href="/admin/salary-calculator"]',
    );
    if (role === "SUPER_ADMIN")
      expect(link?.textContent).toBe("Salary calculator");
    else expect(link).toBeNull();
  },
);

it("calculates and exports September 19–30 for one employee with the exact selected attendance dates", async () => {
  await render();
  await fill("#salary-period", "2026-09");
  await fill("#salary-from", "2026-09-19");
  await fill("#salary-to", "2026-09-30");
  await submit("#salary-from");
  await render();
  const listRead = requests
    .filter((request) => new URL(request.url).pathname === "/api/admin/salary")
    .at(-1)!;
  expect(new URL(listRead.url).searchParams.get("from")).toBe("2026-09-19");
  expect(new URL(listRead.url).searchParams.get("to")).toBe("2026-09-30");
  await act(async () => button("Calculate", row("EMP001"))!.click());
  await eventually(() =>
    expect(button("Download DOCX", row("EMP001"))?.disabled).toBe(false),
  );
  const calculationRequest = requests.find((request) =>
    request.url.endsWith("/calculate"),
  )!;
  expect(await calculationRequest.clone().json()).toEqual({
    period: "2026-09",
    from: "2026-09-19",
    to: "2026-09-30",
    employeeIds: ["employee-1"],
  });
  await act(async () => button("View breakdown", row("EMP001"))!.click());
  const dialog = container.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain(
    "Salary and attendance period: Sep 19, 2026 – Sep 30, 2026",
  );
  expect(dialog.textContent).toContain("Both start and end dates are included");
  expect(dialog.textContent).toContain("BDT 30,000.00");
  await act(async () => button("Download DOCX", dialog)!.click());
  await eventually(() => expect(downloaded).toHaveLength(1));
  const statementRequest = requests.find((request) =>
    request.url.endsWith("/statement"),
  )!;
  expect(await statementRequest.clone().json()).toEqual({
    employeeId: "employee-1",
    period: "2026-09",
    from: "2026-09-19",
    to: "2026-09-30",
    token: "preview-token",
  });
});

it("clears a previous range preview immediately and requires applying the changed dates before calculating", async () => {
  await render();
  await act(async () => button("Calculate", row("EMP001"))!.click());
  await eventually(() =>
    expect(button("Download DOCX", row("EMP001"))?.disabled).toBe(false),
  );
  await fill("#salary-from", "2026-10-03");
  expect(row("EMP001").textContent).not.toContain("BDT 26,730.77");
  expect(button("Download DOCX", row("EMP001"))?.disabled).toBe(true);
  expect(button("Calculate", row("EMP001"))?.disabled).toBe(true);
  expect(container.textContent).toContain(
    "Apply the changed dates before calculating",
  );
  await submit("#salary-from");
  await render();
  expect(button("Calculate", row("EMP001"))?.disabled).toBe(false);
  expect(button("Download DOCX", row("EMP001"))?.disabled).toBe(true);
  await act(async () => button("Calculate", row("EMP001"))!.click());
  await eventually(() =>
    expect(button("Download DOCX", row("EMP001"))?.disabled).toBe(false),
  );
  const lastCalculation = requests
    .filter((request) => request.url.endsWith("/calculate"))
    .at(-1)!;
  expect(await lastCalculation.clone().json()).toEqual({
    period: "2026-10",
    from: "2026-10-03",
    to: "2026-10-31",
    employeeIds: ["employee-1"],
  });
});

it("infers the monthly salary period from a valid URL range and preserves the inclusive dates", async () => {
  window.history.replaceState(
    null,
    "",
    "/admin/salary-calculator?from=2026-09-19&to=2026-09-30",
  );
  await render();
  expect(
    container.querySelector<HTMLInputElement>("#salary-period")!.value,
  ).toBe("2026-09");
  expect(container.querySelector<HTMLInputElement>("#salary-from")!.value).toBe(
    "2026-09-19",
  );
  expect(container.querySelector<HTMLInputElement>("#salary-to")!.value).toBe(
    "2026-09-30",
  );
  const listRequest = requests.find(
    (request) => new URL(request.url).pathname === "/api/admin/salary",
  )!;
  expect(new URL(listRequest.url).searchParams.get("period")).toBe("2026-09");
  expect(container.textContent).not.toContain("ongoing month");
});

it.each([
  "period=2026-09&from=2026-09-30&to=2026-09-19",
  "period=2026-09&from=2026-09-19&to=2026-10-01",
  "period=2026-09&from=2026-09-19",
  "period=2026-09&from=2026-09-31&to=2026-09-31",
])(
  "rejects invalid URL date ranges before issuing salary reads (%s)",
  async (query) => {
    window.history.replaceState(null, "", `/admin/salary-calculator?${query}`);
    await render("en", false);
    expect(container.textContent).toContain(
      "Choose both dates within the selected payroll month",
    );
    expect(
      requests.some(
        (request) => new URL(request.url).pathname === "/api/admin/salary",
      ),
    ).toBe(false);
    expect(requests.every((request) => request.method === "GET")).toBe(true);
  },
);

it("blocks reversed draft dates and resets month ranges with leap-year bounds", async () => {
  await render();
  const salaryReadCount = requests.filter(
    (request) => new URL(request.url).pathname === "/api/admin/salary",
  ).length;
  await fill("#salary-from", "2026-10-20");
  await fill("#salary-to", "2026-10-19");
  await submit("#salary-from");
  expect(container.textContent).toContain(
    "Choose both dates within the selected payroll month",
  );
  expect(
    requests.filter(
      (request) => new URL(request.url).pathname === "/api/admin/salary",
    ),
  ).toHaveLength(salaryReadCount);
  expect(button("Calculate", row("EMP001"))?.disabled).toBe(true);
  await fill("#salary-period", "2028-02");
  expect(container.querySelector<HTMLInputElement>("#salary-from")!.value).toBe(
    "2028-02-01",
  );
  expect(container.querySelector<HTMLInputElement>("#salary-to")!.value).toBe(
    "2028-02-29",
  );
  expect(container.querySelector<HTMLInputElement>("#salary-from")!.max).toBe(
    "2028-02-29",
  );
});

it("uses server range completion metadata so a past range in the current month has no ongoing warning", async () => {
  window.history.replaceState(
    null,
    "",
    "/admin/salary-calculator?period=2026-10&from=2026-10-01&to=2026-10-09",
  );
  await render();
  expect(container.textContent).not.toContain("ongoing month");
  await act(async () => button("Calculate", row("EMP001"))!.click());
  await eventually(() =>
    expect(button("View breakdown", row("EMP001"))).toBeDefined(),
  );
  await act(async () => button("View breakdown", row("EMP001"))!.click());
  expect(container.querySelector('[role="dialog"]')!.textContent).not.toContain(
    "ongoing month",
  );
});

it("keeps streamed filters disabled until hydration attaches their change and submit handlers", async () => {
  window.history.replaceState(
    null,
    "",
    "/admin/salary-calculator?period=2026-09",
  );
  const messages = await loadMessages("en");
  const tree = h(NextIntlClientProvider, {
    locale: "en",
    timeZone: "Asia/Dhaka",
    messages,
    children: h(Provider, { store, children: h(SalaryWorkspace) }),
  });
  await act(async () => root.unmount());
  container.innerHTML = renderToString(tree);
  for (const selector of [
    "#salary-period",
    "#salary-from",
    "#salary-to",
    "#salary-search",
  ]) {
    expect(container.querySelector<HTMLInputElement>(selector)!.disabled).toBe(
      true,
    );
  }
  expect(button("Apply filters")!.disabled).toBe(true);
  await act(async () => {
    root = hydrateRoot(container, tree);
  });
  await eventually(() =>
    expect(container.textContent).toContain(employee.employeeCode),
  );
  expect(
    container.querySelector<HTMLInputElement>("#salary-from")!.disabled,
  ).toBe(false);
  await fill("#salary-from", "2026-09-19");
  await fill("#salary-to", "2026-09-30");
  await submit("#salary-from");
  expect(new URLSearchParams(window.location.search).get("from")).toBe(
    "2026-09-19",
  );
  expect(new URLSearchParams(window.location.search).get("to")).toBe(
    "2026-09-30",
  );
});

it("shows the server 26-day reference formula and nine payable days without multiplying the rounded daily display", async () => {
  savedSettings = { ...settings, baseSalary: "18000.00" };
  window.history.replaceState(
    null,
    "",
    "/admin/salary-calculator?period=2026-09&from=2026-09-20&to=2026-09-30",
  );
  await render();
  await act(async () => button("Salary settings", row("EMP001"))!.click());
  expect(
    container.querySelector('label[for="salary-baseSalary"]')!.textContent,
  ).toBe("Monthly reference salary (BDT)");
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[aria-label="Close dialog"]')!
      .click(),
  );
  await act(async () => button("Calculate", row("EMP001"))!.click());
  await eventually(() =>
    expect(row("EMP001").textContent).toContain("BDT 6,630.77"),
  );
  expect(
    row("EMP001").querySelector('[data-label="Monthly reference salary"]')!
      .textContent,
  ).toContain("BDT 18,000.00");
  expect(
    row("EMP001").querySelector('[data-label="Range base pay"]')!.textContent,
  ).toBe("BDT 6,230.77");
  expect(
    row("EMP001").querySelector('[data-label="Overtime earnings"]')!
      .textContent,
  ).toBe("BDT 400.00");
  await act(async () => button("View breakdown", row("EMP001"))!.click());
  const dialog = container.querySelector('[role="dialog"]')!;
  const detail = (label: string) =>
    [...dialog.querySelectorAll("dt")].find(
      (node) => node.textContent === label,
    )!.nextElementSibling!.textContent;
  expect(detail("Monthly reference salary")).toBe("BDT 18,000.00");
  expect(detail("Fixed salary divisor")).toBe("26");
  expect(detail("Calendar days (inclusive)")).toBe("11");
  expect(detail("Excluded weekend days")).toBe("2");
  expect(detail("Payable days")).toBe("9");
  expect(detail("Configured office weekends")).toBe("Friday, Saturday");
  expect(detail("Daily rate (display)")).toBe("BDT 692.31");
  expect(dialog.textContent).toContain(
    "(BDT 18,000.00 ÷ 26) × 9 payable days = BDT 6,230.77",
  );
  expect(dialog.textContent).toContain("The daily rate is rounded for display");
  expect(dialog.textContent).not.toContain("6,230.79");
  expect(dialog.querySelector("details")!.textContent).toContain(
    "Sep 25, 2026, Sep 26, 2026",
  );
  expect(dialog.textContent).toContain("+ Overtime earnings");
  expect(dialog.textContent).toContain("= Total calculated salary");
});

it("hides old monthly-base preview responses missing the range pay policy instead of exposing stale totals or downloads", async () => {
  await render();
  holdWrites = true;
  await act(async () => button("Calculate", row("EMP001"))!.click());
  await eventually(() => expect(resolveWrite).toBeDefined());
  const oldPreview: Record<string, unknown> = {
    ...calculation,
    baseSalary: "30000.00",
    totalSalary: "32500.00",
  };
  for (const key of [
    "monthlyBaseSalary",
    "dailyRate",
    "salaryDivisor",
    "calendarDays",
    "weekendDays",
    "payableDays",
    "configuredWeekendDays",
    "weekendDates",
  ])
    delete oldPreview[key];
  await act(async () => resolveWrite!(response({ items: [oldPreview] })));
  await eventually(() =>
    expect(button("Calculate", row("EMP001"))?.disabled).toBe(false),
  );
  expect(row("EMP001").textContent).not.toContain("BDT 32,500.00");
  expect(
    row("EMP001").querySelector('[data-label="Range base pay"]')!.textContent,
  ).toBe("—");
  expect(button("View breakdown", row("EMP001"))).toBeUndefined();
  expect(button("Download DOCX", row("EMP001"))?.disabled).toBe(true);
});

it("allows a zero-payable-day weekend range while preserving server overtime earnings", async () => {
  window.history.replaceState(
    null,
    "",
    "/admin/salary-calculator?period=2026-09&from=2026-09-25&to=2026-09-26",
  );
  await render();
  holdWrites = true;
  await act(async () => button("Calculate", row("EMP001"))!.click());
  await eventually(() => expect(resolveWrite).toBeDefined());
  await act(async () =>
    resolveWrite!(
      response({
        items: [
          {
            ...calculation,
            period: "2026-09",
            from: "2026-09-25",
            to: "2026-09-26",
            calendarDays: 2,
            weekendDays: 2,
            payableDays: 0,
            weekendDates: ["2026-09-25", "2026-09-26"],
            baseSalary: "0.00",
            payableOvertimeMinutes: 30,
            overtimeEarnings: "100.00",
            totalSalary: "100.00",
            ongoing: false,
          },
        ],
      }),
    ),
  );
  await eventually(() =>
    expect(button("Download DOCX", row("EMP001"))?.disabled).toBe(false),
  );
  expect(
    row("EMP001").querySelector('[data-label="Range base pay"]')!.textContent,
  ).toBe("BDT 0.00");
  expect(
    row("EMP001").querySelector('[data-label="Total calculated salary"]')!
      .textContent,
  ).toBe("BDT 100.00");
  await act(async () => button("View breakdown", row("EMP001"))!.click());
  expect(container.querySelector('[role="dialog"]')!.textContent).toContain(
    "× 0 payable days = BDT 0.00",
  );
});
