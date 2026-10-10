"use client";

import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from "react";
import { useLocale, useTranslations } from "next-intl";
import { Calculator, Download, Pencil, RefreshCw } from "lucide-react";
import { skipToken } from "@reduxjs/toolkit/query/react";
import {
  salaryAmountSchema,
  SALARY_MONTHLY_DIVISOR,
  salaryMonthBounds,
  salaryPeriodSchema,
  salaryRangeSchema,
} from "@/modules/salary/contracts";
import type {
  SalaryCalculationDTO,
  SalaryEmployeePageDTO,
} from "@/modules/salary/contracts";
import { formatMoney } from "@/i18n/format-money";
import { useErrorMessage } from "@/i18n/errors";
import { signalAccessFailure } from "@/lib/client/session-events";
import { useUrlFilters, pageFromSearch } from "@/lib/client/use-url-filters";
import { useDebouncedValue } from "@/lib/client/use-debounced-value";
import { useFreshness } from "@/store/freshness";
import { useAppSelector } from "@/store/hooks";
import { useQueryView } from "@/store/use-query-view";
import { useGetReferenceQuery } from "@/store/features/management/api";
import {
  useCalculateSalaryMutation,
  useSalaryEmployeesQuery,
  useSaveSalarySettingsMutation,
} from "@/store/features/salary/api";
import { Modal } from "./modal";
import {
  duration,
  Empty,
  ErrorNotice,
  Loading,
  Notice,
  PageHeader,
  Pagination,
} from "./ui";
import styles from "./salary-workspace.module.css";

type EmployeeRow = SalaryEmployeePageDTO["items"][number];
type Filters = {
  period: string;
  from: string;
  to: string;
  search: string;
  departmentId: string;
  officeId: string;
};
type SettingsDraft = {
  row: EmployeeRow;
  effectiveMonth: string;
  baseSalary: string;
  overtimeHourlyRate: string;
};
type Busy = {
  kind: "calculate" | "save" | "download" | "refresh";
  employeeId?: string;
} | null;
const PAGE_SIZE = 20;
const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const subscribeHydration = () => () => {};
const clientHydrated = () => true;
const serverHydrated = () => false;
const snapshotKey = (
  employeeId: string,
  period: string,
  from: string,
  to: string,
) => `${employeeId}:${period}:${from}:${to}`;

function periodLabel(period: string, locale: string) {
  return new Date(`${period}-01T00:00:00Z`).toLocaleDateString(locale, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function dateLabel(date: string, locale: string) {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function weekdayLabel(day: number, locale: string) {
  return new Intl.DateTimeFormat(locale, {
    weekday: "long",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(2023, 0, 1 + day)));
}

function monthBounds(period: string) {
  return salaryPeriodSchema.safeParse(period).success
    ? salaryMonthBounds(period)
    : { from: "", to: "" };
}

/** Reuses the existing paginated lookup API, including catalogs above 100 entries. */
function SalaryLookupFilter({
  resource,
  value,
  disabled,
  onChange,
}: {
  resource: "departments" | "offices";
  value: string;
  disabled: boolean;
  onChange: (id: string) => void;
}) {
  const t = useTranslations("salary");
  const common = useTranslations("common");
  const admin = useTranslations("admin");
  const [search, setSearch] = useState("");
  const query = useDebouncedValue(search);
  const [paging, setPaging] = useState({ query: "", page: 1 });
  const page = paging.query === query ? paging.page : 1;
  const result = useGetReferenceQuery(
    { resource, params: { page, pageSize: 100, q: query } },
    useFreshness(),
  );
  const view = useQueryView(result);
  const label = t(resource === "departments" ? "department" : "office");
  const id = `salary-${resource}`;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        value={value}
        disabled={disabled || view.loading}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">
          {t(resource === "departments" ? "allDepartments" : "allOffices")}
        </option>
        {value && !view.data?.items.some((item) => item.id === value) && (
          <option value={value}>{admin("resources.currentSelection")}</option>
        )}
        {view.data?.items.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name}
          </option>
        ))}
      </select>
      {((view.data?.total ?? 0) > 100 || search || page > 1) && (
        <>
          <input
            type="search"
            aria-label={admin("resources.findField", { field: label })}
            value={search}
            placeholder={admin("resources.searchField", { field: label })}
            disabled={disabled}
            onChange={(event) => setSearch(event.target.value)}
          />
          <div className="buttons">
            <button
              className="button small secondary"
              type="button"
              disabled={disabled || view.isFetching || page <= 1}
              onClick={() => setPaging({ query, page: page - 1 })}
            >
              {common("previous")}
            </button>
            <button
              className="button small secondary"
              type="button"
              disabled={
                disabled ||
                view.isFetching ||
                page * 100 >= (view.data?.total ?? 0)
              }
              onClick={() => setPaging({ query, page: page + 1 })}
            >
              {common("next")}
            </button>
          </div>
        </>
      )}
      <ErrorNotice message={view.error} notify={false} />
    </div>
  );
}

export function SalaryWorkspace() {
  const t = useTranslations("salary");
  const locale = useLocale();
  const errorMessage = useErrorMessage();
  // Streamed inputs must wait for React handlers before accepting edits.
  const hydrated = useSyncExternalStore(
    subscribeHydration,
    clientHydrated,
    serverHydrated,
  );
  const active = useAppSelector(
    (state) => state.workspaceUi.status === "active",
  );
  const { params, update } = useUrlFilters();
  const requestedFrom = params.get("from") || "";
  const requestedTo = params.get("to") || "";
  const requestedPeriod = params.get("period") || requestedFrom.slice(0, 7);
  const invalidPeriod =
    !!requestedPeriod && !salaryPeriodSchema.safeParse(requestedPeriod).success;
  const invalidRange =
    !!(requestedFrom || requestedTo) &&
    !salaryRangeSchema.safeParse({
      period: requestedPeriod,
      ...(requestedFrom ? { from: requestedFrom } : {}),
      ...(requestedTo ? { to: requestedTo } : {}),
    }).success;
  const page = pageFromSearch(params.get("page"));
  const result = useSalaryEmployeesQuery(
    invalidPeriod || invalidRange || !active
      ? skipToken
      : {
          ...(requestedPeriod ? { period: requestedPeriod } : {}),
          ...(requestedFrom ? { from: requestedFrom } : {}),
          ...(requestedTo ? { to: requestedTo } : {}),
          search: params.get("search") || "",
          ...(params.get("departmentId")
            ? { departmentId: params.get("departmentId")! }
            : {}),
          ...(params.get("officeId")
            ? { officeId: params.get("officeId")! }
            : {}),
          page,
          pageSize: PAGE_SIZE,
        },
    useFreshness(true),
  );
  const view = useQueryView(result);
  const data =
    active && !invalidPeriod && !invalidRange ? view.data : undefined;
  const period = requestedPeriod || data?.period || "";
  const bounds = monthBounds(period);
  const from = requestedFrom || data?.from || bounds.from;
  const to = requestedTo || data?.to || bounds.to;
  const filterKey = `${period}|${from}|${to}|${params.get("search") || ""}|${params.get("departmentId") || ""}|${params.get("officeId") || ""}`;
  const filters: Filters = {
    period,
    from,
    to,
    search: params.get("search") || "",
    departmentId: params.get("departmentId") || "",
    officeId: params.get("officeId") || "",
  };
  const [editedFilters, setEditedFilters] = useState<{
    key: string;
    value: Filters;
  }>();
  const draft =
    editedFilters?.key === filterKey ? editedFilters.value : filters;
  const changeFilter = (patch: Partial<Filters>) => {
    setEditedFilters({ key: filterKey, value: { ...draft, ...patch } });
    if ("period" in patch || "from" in patch || "to" in patch) {
      setSnapshots({});
      setSelectedBreakdown(undefined);
      setFeedback(null);
    }
  };
  const draftBounds = monthBounds(draft.period);
  const rangePending =
    draft.period !== period || draft.from !== from || draft.to !== to;
  const [filterError, setFilterError] = useState<
    "invalidPeriod" | "invalidRange" | null
  >(null);
  const [settings, setSettings] = useState<SettingsDraft | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{
    effectiveMonth?: boolean;
    baseSalary?: boolean;
    overtimeHourlyRate?: boolean;
  }>({});
  const [snapshots, setSnapshots] = useState<
    Record<string, SalaryCalculationDTO>
  >({});
  const [selectedBreakdown, setSelectedBreakdown] = useState<string>();
  const [busy, setBusy] = useState<Busy>(null);
  const controlsDisabled =
    !!busy || !active || !hydrated || (!period && view.loading);
  const [feedback, setFeedback] = useState<"saved" | "calculated" | null>(null);
  const [actionError, setActionError] = useState<{
    error?: unknown;
    key: "saveFailed" | "calculationFailed" | "downloadFailed" | "stale";
  }>();
  const fence = useRef(false);
  const mounted = useRef(true);
  const downloadRequest = useRef<AbortController | null>(null);
  const downloadUrls = useRef(new Set<string>());
  const [saveSettings] = useSaveSalarySettingsMutation();
  const [calculateSalary] = useCalculateSalaryMutation();
  useEffect(() => {
    mounted.current = true;
    const urls = downloadUrls.current;
    return () => {
      mounted.current = false;
      downloadRequest.current?.abort();
      for (const url of urls) URL.revokeObjectURL(url);
      urls.clear();
    };
  }, []);

  function calculationFor(row: EmployeeRow) {
    const calculation =
      snapshots[snapshotKey(row.employee.id, period, from, to)];
    return calculation &&
      calculation.salaryDivisor === SALARY_MONTHLY_DIVISOR &&
      salaryAmountSchema.safeParse(calculation.monthlyBaseSalary).success &&
      salaryAmountSchema.safeParse(calculation.dailyRate).success &&
      Number.isSafeInteger(calculation.payableDays) &&
      calculation.payableDays >= 0 &&
      Array.isArray(calculation.configuredWeekendDays) &&
      Array.isArray(calculation.weekendDates) &&
      row.settings &&
      calculation.settings.id === row.settings.id &&
      calculation.settings.revision === row.settings.revision
      ? calculation
      : undefined;
  }
  function begin(next: NonNullable<Busy>) {
    if (fence.current || !active) return false;
    fence.current = true;
    setBusy(next);
    setActionError(undefined);
    setFeedback(null);
    return true;
  }
  function finish() {
    fence.current = false;
    if (mounted.current) setBusy(null);
  }
  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!salaryPeriodSchema.safeParse(draft.period).success) {
      setFilterError("invalidPeriod");
      return;
    }
    if (
      !salaryRangeSchema.safeParse({
        period: draft.period,
        from: draft.from,
        to: draft.to,
      }).success
    ) {
      setFilterError("invalidRange");
      return;
    }
    setFilterError(null);
    setSelectedBreakdown(undefined);
    update({ ...draft, page: 1 });
  }
  async function refresh() {
    if (!begin({ kind: "refresh" })) return;
    try {
      await view.refresh().unwrap();
    } catch {
      /* The query view supplies the refresh error and retains current data. */
    } finally {
      finish();
    }
  }
  function openSettings(row: EmployeeRow) {
    setFieldErrors({});
    setActionError(undefined);
    setSettings({
      row,
      effectiveMonth: period,
      baseSalary: row.settings?.baseSalary ?? "",
      overtimeHourlyRate: row.settings?.overtimeHourlyRate ?? "",
    });
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!settings || fence.current) return;
    const errors = {
      effectiveMonth: !salaryPeriodSchema.safeParse(settings.effectiveMonth)
        .success,
      baseSalary: !salaryAmountSchema.safeParse(settings.baseSalary).success,
      overtimeHourlyRate: !salaryAmountSchema.safeParse(
        settings.overtimeHourlyRate,
      ).success,
    };
    setFieldErrors(errors);
    if (
      Object.values(errors).some(Boolean) ||
      !begin({ kind: "save", employeeId: settings.row.employee.id })
    )
      return;
    try {
      await saveSettings({
        employeeId: settings.row.employee.id,
        effectiveMonth: settings.effectiveMonth,
        baseSalary: settings.baseSalary.trim(),
        overtimeHourlyRate: settings.overtimeHourlyRate.trim(),
      }).unwrap();
      if (!mounted.current) return;
      setSnapshots({});
      setSelectedBreakdown(undefined);
      setSettings(null);
      setFeedback("saved");
    } catch (error) {
      if (mounted.current) setActionError({ error, key: "saveFailed" });
      // Writes are never replayed automatically; an uncertain save is verified by a read.
      void view.refresh();
    } finally {
      finish();
    }
  }
  async function calculate(rows: EmployeeRow[]) {
    const configured = rows.filter((row) => row.settings);
    if (
      !period ||
      rangePending ||
      !configured.length ||
      !begin({
        kind: "calculate",
        ...(rows.length === 1 ? { employeeId: rows[0].employee.id } : {}),
      })
    )
      return;
    const employeeIds = configured.map((row) => row.employee.id);
    try {
      const calculated = await calculateSalary({
        period,
        from,
        to,
        employeeIds,
      }).unwrap();
      if (!mounted.current) return;
      setSnapshots((previous) => {
        const next = { ...previous };
        for (const item of calculated.items) {
          if (
            item.period === period &&
            item.from === from &&
            item.to === to &&
            employeeIds.includes(item.employee.id)
          )
            next[snapshotKey(item.employee.id, period, from, to)] = item;
        }
        return next;
      });
      setFeedback("calculated");
    } catch (error) {
      if (mounted.current) setActionError({ error, key: "calculationFailed" });
    } finally {
      finish();
    }
  }
  async function download(calculation: SalaryCalculationDTO) {
    if (!begin({ kind: "download", employeeId: calculation.employee.id }))
      return;
    const controller = new AbortController();
    downloadRequest.current = controller;
    try {
      const response = await fetch("/api/admin/salary/statement", {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          employeeId: calculation.employee.id,
          period: calculation.period,
          from: calculation.from,
          to: calculation.to,
          token: calculation.token,
        }),
      });
      if (
        !response.ok ||
        !response.headers.get("Content-Type")?.includes(DOCX_MIME)
      ) {
        const body = await response.json().catch(() => null);
        const code = body?.error?.code || "";
        signalAccessFailure(response.status, code);
        if (
          ["SALARY_SOURCE_CHANGED", "SALARY_CALCULATION_EXPIRED"].includes(code)
        ) {
          if (mounted.current) {
            setSnapshots((previous) => {
              const next = { ...previous };
              delete next[
                snapshotKey(
                  calculation.employee.id,
                  calculation.period,
                  calculation.from,
                  calculation.to,
                )
              ];
              return next;
            });
            setSelectedBreakdown(undefined);
          }
          throw { code, stale: true };
        }
        throw body?.error ?? new Error("Statement download failed.");
      }
      const blob = await response.blob();
      const signature = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
      if (
        signature.length !== 4 ||
        signature[0] !== 0x50 ||
        signature[1] !== 0x4b
      )
        throw new Error("Invalid salary document.");
      if (controller.signal.aborted || !mounted.current) return;
      const url = URL.createObjectURL(blob);
      downloadUrls.current.add(url);
      const link = document.createElement("a");
      link.href = url;
      link.download =
        response.headers
          .get("Content-Disposition")
          ?.match(/filename="([^"]+)"/)?.[1] ||
        `salary-statement-${calculation.employee.employeeCode.replace(/[^A-Za-z0-9_-]/g, "_")}-${calculation.period}.docx`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => {
        URL.revokeObjectURL(url);
        downloadUrls.current.delete(url);
      }, 1000);
    } catch (error) {
      if (!controller.signal.aborted && mounted.current)
        setActionError({
          error,
          key:
            error && typeof error === "object" && "stale" in error
              ? "stale"
              : "downloadFailed",
        });
    } finally {
      downloadRequest.current = null;
      finish();
    }
  }

  const breakdownRow = data?.items.find(
    (row) => row.employee.id === selectedBreakdown,
  );
  const breakdown = breakdownRow ? calculationFor(breakdownRow) : undefined;
  const configuredCount = data?.items.filter((row) => row.settings).length ?? 0;
  const amount = (value: string) => formatMoney(value, data!.currency, locale);
  return (
    <div className={styles.workspace}>
      <PageHeader
        eyebrow={t("eyebrow")}
        title={t("title")}
        description={t("description")}
        action={
          <button
            type="button"
            className="button secondary"
            disabled={!!busy || !data}
            onClick={() => void refresh()}
          >
            <RefreshCw size={15} />
            {t("refresh")}
          </button>
        }
      />
      <p className={`muted ${styles.scope}`}>{t("scope")}</p>
      <ErrorNotice
        message={
          !active
            ? t("unavailable")
            : invalidPeriod
              ? t("invalidPeriod")
              : invalidRange
                ? t("invalidRange")
                : view.error
        }
      />
      {actionError && !settings && (
        <ErrorNotice
          message={
            actionError.key === "stale"
              ? t("stale")
              : errorMessage(actionError.error, t(actionError.key))
          }
        />
      )}
      {feedback && <Notice>{t(feedback)}</Notice>}
      {data?.ongoing && (
        <div className={`notice ${styles.ongoing}`} role="status">
          {t("ongoing")}
        </div>
      )}
      <section className="card">
        <div className="card-header">
          <div>
            <h2>{t("employees")}</h2>
            <p>{t("tableNote")}</p>
            {data && (
              <p>
                {t("rangeLabel", {
                  from: dateLabel(from, locale),
                  to: dateLabel(to, locale),
                })}
              </p>
            )}
            {data && (
              <p>
                {t("currencyLabel", {
                  currency: data.currency,
                  timezone: data.timezone,
                })}
              </p>
            )}
          </div>
        </div>
        <form className={styles.filters} onSubmit={applyFilters} noValidate>
          <div className="field">
            <label htmlFor="salary-period">{t("period")}</label>
            <input
              id="salary-period"
              type="month"
              min="1900-01"
              max="2199-12"
              value={draft.period}
              disabled={controlsDisabled}
              onChange={(event) =>
                changeFilter({
                  period: event.target.value,
                  ...monthBounds(event.target.value),
                })
              }
              aria-invalid={filterError === "invalidPeriod" || invalidPeriod}
            />
          </div>
          <div className="field">
            <label htmlFor="salary-from">{t("from")}</label>
            <input
              id="salary-from"
              type="date"
              min={draftBounds.from}
              max={draftBounds.to}
              value={draft.from}
              disabled={controlsDisabled}
              aria-invalid={filterError === "invalidRange" || invalidRange}
              onChange={(event) => changeFilter({ from: event.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="salary-to">{t("to")}</label>
            <input
              id="salary-to"
              type="date"
              min={draftBounds.from}
              max={draftBounds.to}
              value={draft.to}
              disabled={controlsDisabled}
              aria-invalid={filterError === "invalidRange" || invalidRange}
              onChange={(event) => changeFilter({ to: event.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="salary-search">{t("search")}</label>
            <input
              id="salary-search"
              type="search"
              maxLength={200}
              value={draft.search}
              disabled={controlsDisabled}
              placeholder={t("searchPlaceholder")}
              onChange={(event) => changeFilter({ search: event.target.value })}
            />
          </div>
          <SalaryLookupFilter
            resource="departments"
            value={draft.departmentId}
            disabled={controlsDisabled}
            onChange={(departmentId) => changeFilter({ departmentId })}
          />
          <SalaryLookupFilter
            resource="offices"
            value={draft.officeId}
            disabled={controlsDisabled}
            onChange={(officeId) => changeFilter({ officeId })}
          />
          <div className={`buttons ${styles.filterActions}`}>
            <button
              className="button secondary"
              disabled={controlsDisabled}
              type="submit"
            >
              {t("apply")}
            </button>
            <button
              className="button secondary"
              disabled={controlsDisabled}
              type="button"
              onClick={() => {
                setFilterError(null);
                update({ search: "", officeId: "", departmentId: "", page: 1 });
              }}
            >
              {t("clear")}
            </button>
          </div>
          {filterError && (
            <div className={styles.full}>
              <ErrorNotice message={t(filterError)} notify={false} />
            </div>
          )}
          <p className={`muted ${styles.rangeHelp}`}>
            {t("rangePolicy")}
            {rangePending ? ` ${t("rangeDraft")}` : ""}
          </p>
        </form>
        {view.loading ? (
          <Loading />
        ) : data ? (
          <>
            <div className={styles.calculationActions}>
              <button
                className="button"
                disabled={
                  !!busy || view.isFetching || rangePending || !configuredCount
                }
                onClick={() => void calculate(data.items)}
              >
                <Calculator size={16} />
                {busy?.kind === "calculate" && !busy.employeeId
                  ? t("calculating")
                  : t("calculateVisible")}
              </button>
              <p className="muted">{t("attendanceSource")}</p>
            </div>
            {data.items.length ? (
              <div className={`table-scroll ${styles.table}`}>
                <table>
                  <thead>
                    <tr>
                      {(
                        [
                          "employee",
                          "baseSalary",
                          "rangeBasePay",
                          "hourlyRate",
                          "payableOvertime",
                          "overtimeEarnings",
                          "totalSalary",
                          "actions",
                        ] as const
                      ).map((key) => (
                        <th key={key}>{t(key)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((row) => {
                      const calculation = calculationFor(row);
                      const working = busy?.employeeId === row.employee.id;
                      return (
                        <tr key={row.employee.id}>
                          <td data-label={t("employee")}>
                            <div className={styles.identity}>
                              <strong>
                                {row.employee.name || row.employee.email}
                              </strong>
                              <span>{row.employee.employeeCode}</span>
                              <small>
                                {[
                                  row.employee.department,
                                  row.employee.designation,
                                  row.employee.officeName,
                                ]
                                  .filter(Boolean)
                                  .join(" · ")}
                              </small>
                            </div>
                          </td>
                          <td
                            data-label={t("baseSalary")}
                            className={styles.amount}
                          >
                            {row.settings ? (
                              <>
                                {amount(row.settings.baseSalary)}
                                <small className={styles.effective}>
                                  {t("effectiveLabel", {
                                    period: periodLabel(
                                      row.settings.effectiveMonth,
                                      locale,
                                    ),
                                  })}
                                </small>
                              </>
                            ) : (
                              <span className="badge amber">
                                {t("notConfigured")}
                              </span>
                            )}
                          </td>
                          <td
                            data-label={t("rangeBasePay")}
                            className={styles.amount}
                          >
                            {calculation ? amount(calculation.baseSalary) : "—"}
                          </td>
                          <td
                            data-label={t("hourlyRate")}
                            className={styles.amount}
                          >
                            {row.settings
                              ? amount(row.settings.overtimeHourlyRate)
                              : t("notConfigured")}
                          </td>
                          <td data-label={t("payableOvertime")}>
                            {calculation
                              ? duration(
                                  calculation.payableOvertimeMinutes,
                                  locale,
                                )
                              : t("notCalculated")}
                          </td>
                          <td
                            data-label={t("overtimeEarnings")}
                            className={styles.amount}
                          >
                            {calculation
                              ? amount(calculation.overtimeEarnings)
                              : "—"}
                          </td>
                          <td
                            data-label={t("totalSalary")}
                            className={styles.amount}
                          >
                            {calculation ? (
                              <strong>{amount(calculation.totalSalary)}</strong>
                            ) : (
                              "—"
                            )}
                          </td>
                          <td data-label={t("actions")}>
                            <div className={`buttons ${styles.rowActions}`}>
                              <button
                                className="button small secondary"
                                disabled={!!busy || view.isFetching}
                                onClick={() => openSettings(row)}
                              >
                                <Pencil size={13} />
                                {t("configure")}
                              </button>
                              <button
                                className="button small secondary"
                                disabled={
                                  !!busy ||
                                  view.isFetching ||
                                  rangePending ||
                                  !row.settings
                                }
                                title={
                                  !row.settings
                                    ? t("missingSettings")
                                    : rangePending
                                      ? t("rangeDraft")
                                      : undefined
                                }
                                onClick={() => void calculate([row])}
                              >
                                {working && busy?.kind === "calculate"
                                  ? t("calculating")
                                  : t(
                                      calculation ? "recalculate" : "calculate",
                                    )}
                              </button>
                              {calculation && (
                                <button
                                  className="button small secondary"
                                  disabled={!!busy}
                                  onClick={() =>
                                    setSelectedBreakdown(row.employee.id)
                                  }
                                >
                                  {t("breakdown")}
                                </button>
                              )}
                              <button
                                className="button small secondary"
                                disabled={
                                  !!busy ||
                                  !calculation ||
                                  view.isFetching ||
                                  rangePending
                                }
                                onClick={() =>
                                  calculation && void download(calculation)
                                }
                              >
                                <Download size={13} />
                                {working && busy?.kind === "download"
                                  ? t("generating")
                                  : t("download")}
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty
                title={t("emptyTitle")}
                description={t("emptyDescription")}
              />
            )}
            <Pagination
              page={data.page}
              pageSize={data.pageSize}
              total={data.total}
              loading={!!busy || view.isFetching}
              onPage={(page) => update({ page })}
            />
          </>
        ) : null}
      </section>
      {settings && active && (
        <Modal
          title={t("settingsTitle")}
          close={() => {
            if (!fence.current) setSettings(null);
          }}
        >
          <p className={styles.formIntro}>
            <strong>
              {settings.row.employee.name || settings.row.employee.email}
            </strong>{" "}
            · {settings.row.employee.employeeCode}
          </p>
          <p className="muted">{t("effectiveHint")}</p>
          <form onSubmit={save} noValidate>
            <fieldset disabled={!!busy} className={styles.fields}>
              <div className="field">
                <label htmlFor="salary-effective-month">
                  {t("effectiveMonth")}
                </label>
                <input
                  id="salary-effective-month"
                  type="month"
                  min="1900-01"
                  max="2199-12"
                  value={settings.effectiveMonth}
                  aria-invalid={!!fieldErrors.effectiveMonth}
                  onChange={(event) =>
                    setSettings({
                      ...settings,
                      effectiveMonth: event.target.value,
                    })
                  }
                />
                {fieldErrors.effectiveMonth && (
                  <span className={styles.fieldError}>
                    {t("invalidPeriod")}
                  </span>
                )}
              </div>
              {(["baseSalary", "overtimeHourlyRate"] as const).map((key) => (
                <div className="field" key={key}>
                  <label htmlFor={`salary-${key}`}>
                    {t(key === "baseSalary" ? "baseSalary" : "hourlyRate")}
                    {data ? ` (${data.currency})` : ""}
                  </label>
                  <input
                    id={`salary-${key}`}
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    value={settings[key]}
                    maxLength={19}
                    aria-invalid={!!fieldErrors[key]}
                    onChange={(event) =>
                      setSettings({ ...settings, [key]: event.target.value })
                    }
                  />
                  {fieldErrors[key] && (
                    <span className={styles.fieldError}>
                      {t("moneyInvalid")}
                    </span>
                  )}
                </div>
              ))}
            </fieldset>
            {actionError && (
              <ErrorNotice
                message={errorMessage(actionError.error, t(actionError.key))}
              />
            )}
            <div className="form-actions">
              <button
                className="button secondary"
                type="button"
                disabled={!!busy}
                onClick={() => setSettings(null)}
              >
                {t("cancel")}
              </button>
              <button className="button" type="submit" disabled={!!busy}>
                {busy?.kind === "save" ? t("saving") : t("save")}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {breakdown && active && (
        <Modal
          title={t("breakdownTitle")}
          close={() => {
            if (!fence.current) setSelectedBreakdown(undefined);
          }}
        >
          <p className={styles.formIntro}>
            <strong>
              {breakdown.employee.name || breakdown.employee.email}
            </strong>{" "}
            · {breakdown.employee.employeeCode}
          </p>
          <p>
            {t("periodLabel", {
              period: periodLabel(breakdown.period, locale),
            })}
          </p>
          <p>
            {t("rangeLabel", {
              from: dateLabel(breakdown.from, locale),
              to: dateLabel(breakdown.to, locale),
            })}
          </p>
          <p className={`muted ${styles.scope}`}>{t("rangePolicy")}</p>
          {breakdown.ongoing && (
            <p className={styles.ongoing}>{t("ongoing")}</p>
          )}
          <dl className={styles.breakdown}>
            <dt>{t("baseSalary")}</dt>
            <dd>
              {formatMoney(
                breakdown.monthlyBaseSalary,
                breakdown.currency,
                locale,
              )}
            </dd>
            <dt>{t("salaryDivisor")}</dt>
            <dd>
              {new Intl.NumberFormat(locale).format(breakdown.salaryDivisor)}
            </dd>
            <dt>{t("calendarDays")}</dt>
            <dd>
              {new Intl.NumberFormat(locale).format(breakdown.calendarDays)}
            </dd>
            <dt>{t("weekendDays")}</dt>
            <dd>
              {new Intl.NumberFormat(locale).format(breakdown.weekendDays)}
            </dd>
            <dt>{t("payableDays")}</dt>
            <dd>
              <strong>
                {new Intl.NumberFormat(locale).format(breakdown.payableDays)}
              </strong>
            </dd>
            <dt>{t("configuredWeekends")}</dt>
            <dd>
              {breakdown.configuredWeekendDays.length
                ? breakdown.configuredWeekendDays
                    .map((day) => weekdayLabel(day, locale))
                    .join(", ")
                : t("noWeekends")}
            </dd>
            <dt>{t("dailyRate")}</dt>
            <dd>
              {formatMoney(breakdown.dailyRate, breakdown.currency, locale)}
            </dd>
          </dl>
          <p className={styles.formula}>
            {t("baseFormula", {
              monthlySalary: formatMoney(
                breakdown.monthlyBaseSalary,
                breakdown.currency,
                locale,
              ),
              divisor: new Intl.NumberFormat(locale).format(
                breakdown.salaryDivisor,
              ),
              days: new Intl.NumberFormat(locale).format(breakdown.payableDays),
              basePay: formatMoney(
                breakdown.baseSalary,
                breakdown.currency,
                locale,
              ),
            })}
          </p>
          <p className={`muted ${styles.scope}`}>{t("dailyRateNote")}</p>
          {breakdown.weekendDates.length > 0 && (
            <details className={styles.weekendDates}>
              <summary>{t("weekendDates")}</summary>
              <p>
                {breakdown.weekendDates
                  .map((date) => dateLabel(date, locale))
                  .join(", ")}
              </p>
            </details>
          )}
          <dl className={styles.breakdown}>
            <dt>{t("rangeBasePay")}</dt>
            <dd>
              {formatMoney(breakdown.baseSalary, breakdown.currency, locale)}
            </dd>
            <dt>+ {t("overtimeEarnings")}</dt>
            <dd>
              {formatMoney(
                breakdown.overtimeEarnings,
                breakdown.currency,
                locale,
              )}
            </dd>
            <dt className={styles.total}>= {t("totalSalary")}</dt>
            <dd className={styles.total}>
              {formatMoney(breakdown.totalSalary, breakdown.currency, locale)}
            </dd>
            <dt>{t("payableOvertime")}</dt>
            <dd>{duration(breakdown.payableOvertimeMinutes, locale)}</dd>
            <dt>{t("hourlyRate")}</dt>
            <dd>
              {formatMoney(
                breakdown.overtimeHourlyRate,
                breakdown.currency,
                locale,
              )}
            </dd>
          </dl>
          <p className={`muted ${styles.scope}`}>{t("attendanceSource")}</p>
          <p className="muted">
            {t("generatedLabel", {
              date: new Date(breakdown.generatedAt).toLocaleString(locale, {
                timeZone: breakdown.timezone,
              }),
            })}
          </p>
          <div className="form-actions">
            <button
              className="button secondary"
              disabled={!!busy}
              onClick={() => void download(breakdown)}
            >
              <Download size={15} />
              {busy?.kind === "download" ? t("generating") : t("download")}
            </button>
          </div>
          {actionError && (
            <ErrorNotice
              message={errorMessage(actionError.error, t(actionError.key))}
              notify={false}
            />
          )}
        </Modal>
      )}
    </div>
  );
}
