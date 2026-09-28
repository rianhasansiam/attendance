"use client";

import { useRef, useState, type FormEvent } from "react";
import { skipToken } from "@reduxjs/toolkit/query/react";
import {
  ArrowLeft,
  ArrowRight,
  Calculator,
  Calendar,
  Check,
  Pencil,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { Modal } from "./modal";
import { PdfDownloadButton } from "./pdf-download-button";
import { DriveCostBalanceSection } from "./drive-cost-balance-section";
import {
  ErrorNotice,
  Loading,
  Notice,
  PageHeader,
  Refresh,
  Table,
  type DataRow,
} from "./ui";
import { confirmAction } from "@/lib/client/alerts";
import { useDebouncedValue } from "@/lib/client/use-debounced-value";
import { useUrlFilters, pageFromSearch } from "@/lib/client/use-url-filters";
import { isAmbiguousWrite } from "@/lib/client/attendance-ceremony";
import { useQueryView } from "@/store/use-query-view";
import { useFreshness } from "@/store/freshness";
import { useLocale, useTranslations } from "next-intl";
import { useExpenseFeedback } from "./expense-feedback";
import {
  useDriveCostsQuery,
  useDriveCostCalculationQuery,
  useDriveCostBalanceQuery,
  useSaveDriveCostMutation,
  useDeleteDriveCostMutation,
  useUpdateDriveCostPaymentMutation,
  type CalculationArgs,
  type DriveCostPaymentStatus,
} from "@/store/features/drive-costs/api";
import {
  DRIVE_COST_RATE_CHANGE_DATE,
  getDriveCostRates,
  type DriveCostRateType as RateType,
} from "@/modules/drive-costs/rates";

type DriveCostDraft = {
  id?: string;
  date: string;
  destinationFrom: string;
  destinationTo: string;
  kilometers: string;
  isRoundTrip: boolean;
  rateType: RateType;
};

const PAGE_SIZE = 25;
type PaymentStatusFilter = DriveCostPaymentStatus | "";
type ListFilters = {
  from: string;
  to: string;
  paymentStatus: PaymentStatusFilter;
};

function paymentStatusFilter(value: string | null): PaymentStatusFilter {
  return value === "PAID" || value === "UNPAID" ? value : "";
}

function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatNumber(value: unknown, locale: string): string {
  return numberValue(value).toLocaleString(locale, {
    maximumFractionDigits: 2,
  });
}

function taka(value: unknown, locale: string): string {
  return `৳${numberValue(value).toLocaleString(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function today(): string {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 10);
}

function draftFromRow(row: DataRow): DriveCostDraft {
  return {
    id: String(row.id),
    date: String(row.date).slice(0, 10),
    destinationFrom: String(row.destinationFrom ?? ""),
    destinationTo: String(row.destinationTo ?? ""),
    kilometers: String(row.kilometers ?? ""),
    isRoundTrip: row.isRoundTrip === true,
    rateType: row.rateType === "OVER_TIME" ? "OVER_TIME" : "IN_TIME",
  };
}

function formatDateLabel(dateString: string, locale: string): string {
  return new Date(dateString + "T00:00:00Z").toLocaleDateString(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function DriveCostWorkspace({
  canEditPaymentStatus = false,
}: {
  canEditPaymentStatus?: boolean;
}) {
  const t = useTranslations("expenses");
  const locale = useLocale();
  const { params: urlParams, update } = useUrlFilters();
  const query = urlParams.get("q") || "";
  const search = useDebouncedValue(query);
  const dateFilters: ListFilters = {
    from: urlParams.get("from") || "",
    to: urlParams.get("to") || "",
    paymentStatus: paymentStatusFilter(urlParams.get("paymentStatus")),
  };
  const dateFilterKey = `${dateFilters.from}|${dateFilters.to}|${dateFilters.paymentStatus}`;
  const [dateEdit, setDateEdit] = useState({
    key: dateFilterKey,
    ...dateFilters,
  });
  const dateDraft = dateEdit.key === dateFilterKey ? dateEdit : dateFilters;
  const setDateDraft = (draft: ListFilters) =>
    setDateEdit({ key: dateFilterKey, ...draft });
  const params = new URLSearchParams({ q: search });
  if (dateFilters.from) params.set("from", dateFilters.from);
  if (dateFilters.to) params.set("to", dateFilters.to);
  if (dateFilters.paymentStatus)
    params.set("paymentStatus", dateFilters.paymentStatus);
  const filterKey = params.toString();
  const page = pageFromSearch(urlParams.get("page"));
  const [editing, setEditing] = useState<DriveCostDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [needsReconcile, setNeedsReconcile] = useState(false);
  const [actionError, setActionError] = useExpenseFeedback();
  const [message, setMessage] = useExpenseFeedback();
  const costsQuery = useDriveCostsQuery(
    {
      page,
      pageSize: PAGE_SIZE,
      q: search,
      ...(dateFilters.from ? { from: dateFilters.from } : {}),
      ...(dateFilters.to ? { to: dateFilters.to } : {}),
      ...(dateFilters.paymentStatus
        ? { paymentStatus: dateFilters.paymentStatus }
        : {}),
    },
    useFreshness(),
  );
  const costsView = useQueryView(costsQuery);
  const { refresh, isFetching } = costsView;
  const waitingForSearch = query !== search;
  const data = waitingForSearch ? undefined : costsView.data;
  const error = waitingForSearch ? "" : costsView.error;
  const loading = waitingForSearch || costsView.loading;
  const [saveDriveCost] = useSaveDriveCostMutation();
  const [deleteDriveCost] = useDeleteDriveCostMutation();
  const [updatePayment] = useUpdateDriveCostPaymentMutation();
  const balanceQuery = useDriveCostBalanceQuery(undefined, useFreshness());
  const balanceView = useQueryView(balanceQuery);

  // Draft inputs are local; the calculation and records belong to RTK Query.
  const [calcMode, setCalcMode] = useState<"single" | "range">("single");
  const [calcDate, setCalcDate] = useState(today());
  const [calcFrom, setCalcFrom] = useState(today());
  const [calcTo, setCalcTo] = useState(today());
  const [calcPaymentStatus, setCalcPaymentStatus] =
    useState<PaymentStatusFilter>("");
  const [calcArgs, setCalcArgs] = useState<CalculationArgs>();
  const [calcOpen, setCalcOpen] = useState(false);
  const calculationQuery = useDriveCostCalculationQuery(calcArgs ?? skipToken, {
    ...useFreshness(),
    skip: !calcOpen,
  });
  const {
    data: calcResult,
    error: calcError,
    isFetching: calcBusy,
    refresh: refreshCalculation,
  } = useQueryView(calculationQuery);

  function setPage(page: number) {
    update({ page });
  }

  async function refreshCosts() {
    try {
      await Promise.all([refresh().unwrap(), balanceView.refresh().unwrap()]);
      if (calcArgs && calcOpen) await refreshCalculation().unwrap();
      setNeedsReconcile(false);
    } catch {
      // Preserve the uncertainty gate until authoritative reads succeed.
    }
  }

  async function showWriteError(error: unknown) {
    setActionError({ error });
    if (isAmbiguousWrite(error)) {
      setNeedsReconcile(true);
      await refreshCosts();
    }
  }

  function applyDateFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    update({
      from: dateDraft.from,
      to: dateDraft.to,
      paymentStatus: dateDraft.paymentStatus,
      page: 1,
    });
  }

  function resetFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setDateDraft({ from: "", to: "", paymentStatus: "" });
    update({ q: "", from: "", to: "", paymentStatus: "", page: 1 });
  }

  function openNew() {
    setActionError("");
    setMessage("");
    setEditing({
      date: today(),
      destinationFrom: "",
      destinationTo: "",
      kilometers: "",
      isRoundTrip: false,
      rateType: "IN_TIME",
    });
  }

  function openEdit(row: DataRow) {
    setActionError("");
    setMessage("");
    setEditing(draftFromRow(row));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing || submitting.current || needsReconcile) return;
    const kilometers = Number(editing.kilometers);
    if (!Number.isFinite(kilometers) || kilometers <= 0) {
      setActionError({ key: "positiveDistance" });
      return;
    }
    submitting.current = true;
    setBusy(true);
    setActionError("");
    setMessage("");
    try {
      await saveDriveCost({
        id: editing.id,
        input: {
          date: editing.date,
          destinationFrom: editing.destinationFrom.trim(),
          destinationTo: editing.destinationTo.trim(),
          kilometers,
          isRoundTrip: editing.isRoundTrip,
          rateType: editing.rateType,
        },
      }).unwrap();
      setEditing(null);
      setMessage(editing.id ? { key: "driveUpdated" } : { key: "driveAdded" });
    } catch (error) {
      await showWriteError(error);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  async function changePaymentStatus(row: DataRow) {
    if (submitting.current || needsReconcile) return;
    submitting.current = true;
    setBusy(true);
    setActionError("");
    setMessage("");
    const paymentStatus = row.paymentStatus === "PAID" ? "UNPAID" : "PAID";
    try {
      await updatePayment({ id: String(row.id), paymentStatus }).unwrap();
      setMessage({
        key: "drivePaymentSaved",
        values: { status: paymentStatus },
      });
    } catch (error) {
      await showWriteError(error);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  async function remove(row: DataRow) {
    if (submitting.current || needsReconcile) return;
    const from = String(row.destinationFrom ?? t("thisDestination"));
    const to = String(row.destinationTo ?? t("thisDestination"));
    submitting.current = true;
    setBusy(true);
    try {
      if (
        !(await confirmAction({
          title: t("deleteDriveTitle"),
          text: t("deleteDriveConfirm", { from, to }),
          confirmText: t("deleteDrive"),
          cancelText: t("cancel"),
          danger: true,
        }))
      )
        return;
      setActionError("");
      setMessage("");
      await deleteDriveCost(String(row.id)).unwrap();
      setMessage({ key: "driveDeleted" });
      if ((data?.items.length || 0) === 1 && page > 1) setPage(page - 1);
    } catch (error) {
      await showWriteError(error);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  function runCalculation() {
    const args: CalculationArgs = {
      ...(calcMode === "single"
        ? { from: calcDate }
        : { from: calcFrom, to: calcTo }),
      ...(calcPaymentStatus ? { paymentStatus: calcPaymentStatus } : {}),
    };
    if (
      calcArgs?.from === args.from &&
      calcArgs?.to === args.to &&
      calcArgs?.paymentStatus === args.paymentStatus
    ) {
      void refreshCalculation();
    } else {
      setCalcArgs(args);
    }
  }

  const tableRows: DataRow[] = (data?.items || []).map((record) => ({
    ...record,
    rateTypeLabel:
      record.rateType === "OVER_TIME" ? t("overTime") : t("inTime"),
    tripTypeLabel: record.isRoundTrip ? t("roundTrip") : t("oneWay"),
    paymentStatusLabel:
      record.paymentStatus === "PAID" ? t("paid") : t("unpaid"),
    kilometersLabel: formatNumber(
      numberValue(record.kilometers) * (record.isRoundTrip ? 2 : 1),
      locale,
    ),
    rateLabel: t("ratePerKm", { rate: taka(record.ratePerKilometer, locale) }),
    totalLabel: taka(record.totalCost, locale),
  }));
  const rates = getDriveCostRates(editing?.date ?? today());
  const selectedRate = Number(rates[editing?.rateType ?? "IN_TIME"]);
  const previewKilometers = numberValue(editing?.kilometers);
  // Valid distances have at most two decimal places. Work in hundredths of a
  // kilometer and paisa so halfway totals round up exactly as they do on save.
  const distanceHundredths = Math.round(previewKilometers * 100);
  const ratePaisa = Math.round(selectedRate * 100);
  const previewTotal =
    Math.floor(
      (distanceHundredths * ratePaisa * (editing?.isRoundTrip ? 2 : 1) + 50) /
        100,
    ) / 100;

  const calcRecordRows: DataRow[] = (calcResult?.records || []).map(
    (record) => ({
      ...record,
      rateTypeLabel:
        record.rateType === "OVER_TIME" ? t("overTime") : t("inTime"),
      tripTypeLabel: record.isRoundTrip ? t("roundTrip") : t("oneWay"),
      paymentStatusLabel:
        record.paymentStatus === "PAID" ? t("paid") : t("unpaid"),
      kilometersLabel: formatNumber(
        numberValue(record.kilometers) * (record.isRoundTrip ? 2 : 1),
        locale,
      ),
      rateLabel: t("ratePerKm", {
        rate: taka(record.ratePerKilometer, locale),
      }),
      totalLabel: taka(record.totalCost, locale),
    }),
  );

  return (
    <>
      <PageHeader
        eyebrow={t("travelExpenses")}
        title={t("driveCost")}
        description={t("driveDescription")}
        action={
          <div className="page-header-actions">
            <Refresh onClick={() => void refreshCosts()} />
            <PdfDownloadButton
              href={`/api/admin/drive-costs/report?${filterKey}`}
              filename="drive-cost-report.pdf"
              disabled={loading}
            />
            <button
              className="button secondary"
              onClick={() => setCalcOpen(!calcOpen)}
            >
              <Calculator size={16} />
              {calcOpen ? t("hideCalculator") : t("costCalculator")}
            </button>
            <button
              className="button"
              disabled={busy || needsReconcile}
              onClick={openNew}
            >
              <Plus size={16} />
              {t("addDrive")}
            </button>
          </div>
        }
      />
      <ErrorNotice message={error || (!editing ? actionError : "")} />
      {isFetching && data && (
        <p className="muted" role="status">
          {t("refreshingDrive")}
        </p>
      )}
      {needsReconcile && <Notice>{t("reconcileDrive")}</Notice>}
      {message && (
        <Notice notify>
          <Check size={16} />
          {message}
        </Notice>
      )}

      <DriveCostBalanceSection
        canAddBalance={canEditPaymentStatus}
        data={balanceView.data}
        error={balanceView.error}
        loading={balanceView.loading}
        isFetching={balanceView.isFetching}
        refresh={() => void balanceView.refresh()}
      />

      {/* Cost Calculator Section */}
      {calcOpen && (
        <section className="card calc-card">
          <div className="calc-header">
            <div className="calc-title">
              <Calculator size={18} />
              <div>
                <h3>{t("calculatorTitle")}</h3>
                <p>{t("calculatorDescription")}</p>
              </div>
            </div>
          </div>

          <div className="calc-mode-tabs">
            <button
              type="button"
              className={`calc-mode-tab ${calcMode === "single" ? "is-active" : ""}`}
              onClick={() => setCalcMode("single")}
            >
              <Calendar size={14} />
              {t("singleDay")}
            </button>
            <button
              type="button"
              className={`calc-mode-tab ${calcMode === "range" ? "is-active" : ""}`}
              onClick={() => setCalcMode("range")}
            >
              <Calendar size={14} />
              {t("dateRange")}
            </button>
          </div>

          <div className="calc-inputs">
            {calcMode === "single" ? (
              <div className="field">
                <label htmlFor="calc-date">{t("date")}</label>
                <input
                  id="calc-date"
                  type="date"
                  value={calcDate}
                  onChange={(e) => setCalcDate(e.target.value)}
                />
              </div>
            ) : (
              <>
                <div className="field">
                  <label htmlFor="calc-from">{t("fromDate")}</label>
                  <input
                    id="calc-from"
                    type="date"
                    value={calcFrom}
                    onChange={(e) => setCalcFrom(e.target.value)}
                  />
                </div>
                <div className="field">
                  <label htmlFor="calc-to">{t("toDate")}</label>
                  <input
                    id="calc-to"
                    type="date"
                    value={calcTo}
                    onChange={(e) => setCalcTo(e.target.value)}
                  />
                </div>
              </>
            )}
            <div className="field">
              <label htmlFor="calc-payment-status">{t("paymentStatus")}</label>
              <select
                id="calc-payment-status"
                value={calcPaymentStatus}
                onChange={(event) =>
                  setCalcPaymentStatus(paymentStatusFilter(event.target.value))
                }
              >
                <option value="">{t("all")}</option>
                <option value="PAID">{t("paid")}</option>
                <option value="UNPAID">{t("unpaid")}</option>
              </select>
            </div>
            <button
              type="button"
              className="button calc-run-btn"
              disabled={calcBusy}
              onClick={() => void runCalculation()}
            >
              {calcBusy ? t("calculating") : t("calculate")}
            </button>
          </div>

          <ErrorNotice message={calcError} />
          {calcBusy && calcResult && (
            <p className="muted" role="status">
              {t("refreshingCalculation")}
            </p>
          )}

          {calcResult && (
            <div className="calc-results">
              <PdfDownloadButton
                href={`/api/admin/drive-costs/report?${new URLSearchParams({ from: calcResult.dateFrom, to: calcResult.dateTo, ...(calcResult.paymentStatus ? { paymentStatus: calcResult.paymentStatus } : {}) })}`}
                filename="drive-cost-report.pdf"
                disabled={calcBusy}
              />
              <div className="calc-date-label">
                {calcResult.isSingleDay
                  ? formatDateLabel(calcResult.dateFrom, locale)
                  : `${formatDateLabel(calcResult.dateFrom, locale)} — ${formatDateLabel(calcResult.dateTo, locale)}`}
                {" · "}
                {calcResult.paymentStatus === "PAID"
                  ? t("paidTrips")
                  : calcResult.paymentStatus === "UNPAID"
                    ? t("unpaidTrips")
                    : t("allPaymentStatuses")}
              </div>

              {calcResult.totalRecords === 0 ? (
                <div className="calc-empty">
                  <p>
                    {t("noDriveCosts", {
                      period: calcResult.isSingleDay ? "day" : "range",
                    })}
                  </p>
                </div>
              ) : (
                <>
                  {/* Summary cards */}
                  <div className="calc-summary-grid">
                    <div className="calc-summary-card calc-total">
                      <small>{t("grandTotal")}</small>
                      <strong>{taka(calcResult.totalCost, locale)}</strong>
                      <p>
                        {t("driveSummary", {
                          count: calcResult.totalRecords,
                          kilometers: formatNumber(
                            calcResult.totalKilometers,
                            locale,
                          ),
                        })}
                      </p>
                    </div>
                    <div className="calc-summary-card">
                      <small>{t("inTime")}</small>
                      <strong>
                        {taka(calcResult.breakdown.inTime.totalCost, locale)}
                      </strong>
                      <p>
                        {t("driveSummary", {
                          count: calcResult.breakdown.inTime.records,
                          kilometers: formatNumber(
                            calcResult.breakdown.inTime.kilometers,
                            locale,
                          ),
                        })}
                      </p>
                    </div>
                    <div className="calc-summary-card">
                      <small>{t("overTime")}</small>
                      <strong>
                        {taka(calcResult.breakdown.overTime.totalCost, locale)}
                      </strong>
                      <p>
                        {t("driveSummary", {
                          count: calcResult.breakdown.overTime.records,
                          kilometers: formatNumber(
                            calcResult.breakdown.overTime.kilometers,
                            locale,
                          ),
                        })}
                      </p>
                    </div>
                  </div>

                  {/* Trip details table */}
                  <div className="calc-details">
                    <h4>{t("tripDetails")}</h4>
                    <Table
                      rows={calcRecordRows}
                      dateGroupKey="date"
                      columns={[
                        { key: "date", label: t("date"), format: "date" },
                        { key: "destinationFrom", label: t("from") },
                        { key: "destinationTo", label: t("to") },
                        { key: "tripTypeLabel", label: t("tripType") },
                        {
                          key: "rateTypeLabel",
                          label: t("rateType"),
                          format: "badge",
                        },
                        { key: "kilometersLabel", label: t("totalKm") },
                        { key: "rateLabel", label: t("rate") },
                        { key: "totalLabel", label: t("total") },
                        {
                          key: "paymentStatusLabel",
                          label: t("paymentStatus"),
                          format: "badge",
                        },
                      ]}
                    />
                  </div>
                </>
              )}
            </div>
          )}
        </section>
      )}

      <section className="card">
        <form
          className="drive-cost-date-filters"
          aria-label={t("filterDriveDates")}
          onSubmit={applyDateFilters}
          onReset={resetFilters}
        >
          <div className="field">
            <label htmlFor="drive-cost-filter-from">{t("fromDate")}</label>
            <input
              id="drive-cost-filter-from"
              name="from"
              type="date"
              disabled={loading}
              value={dateDraft.from}
              max={dateDraft.to || undefined}
              onChange={(event) =>
                setDateDraft({ ...dateDraft, from: event.target.value })
              }
            />
          </div>
          <div className="field">
            <label htmlFor="drive-cost-filter-to">{t("toDate")}</label>
            <input
              id="drive-cost-filter-to"
              name="to"
              type="date"
              disabled={loading}
              value={dateDraft.to}
              min={dateDraft.from || undefined}
              onChange={(event) =>
                setDateDraft({ ...dateDraft, to: event.target.value })
              }
            />
          </div>
          <div className="field">
            <label htmlFor="drive-cost-filter-payment-status">
              {t("paymentStatus")}
            </label>
            <select
              id="drive-cost-filter-payment-status"
              name="paymentStatus"
              disabled={loading}
              value={dateDraft.paymentStatus}
              onChange={(event) =>
                setDateDraft({
                  ...dateDraft,
                  paymentStatus: paymentStatusFilter(event.target.value),
                })
              }
            >
              <option value="">{t("all")}</option>
              <option value="PAID">{t("paid")}</option>
              <option value="UNPAID">{t("unpaid")}</option>
            </select>
          </div>
          <div className="buttons">
            <button className="button" type="submit" disabled={loading}>
              {t("applyFilters")}
            </button>
            <button
              className="button secondary"
              type="reset"
              disabled={loading}
            >
              {t("resetFilters")}
            </button>
          </div>
          <p className="muted">{t("dateFilterHelp")}</p>
        </form>
        <div className="toolbar">
          <div className="search-field">
            <Search size={16} />
            <input
              type="search"
              aria-label={t("searchDrive")}
              placeholder={t("searchDestinations")}
              value={query}
              onChange={(event) => update({ q: event.target.value, page: 1 })}
            />
          </div>
          <span className="muted" style={{ fontSize: 11 }}>
            {t("recordCount", { count: data?.total || 0 })}
          </span>
        </div>
        {loading ? (
          <Loading />
        ) : (
          <Table
            rows={tableRows}
            dateGroupKey="date"
            columns={[
              { key: "date", label: t("date"), format: "date" },
              { key: "destinationFrom", label: t("from") },
              { key: "destinationTo", label: t("to") },
              { key: "tripTypeLabel", label: t("tripType") },
              { key: "rateTypeLabel", label: t("rateType"), format: "badge" },
              { key: "kilometersLabel", label: t("totalKm") },
              { key: "rateLabel", label: t("rate") },
              { key: "totalLabel", label: t("total") },
              {
                key: "paymentStatusLabel",
                label: t("paymentStatus"),
                format: "badge",
              },
            ]}
            actions={(row) => (
              <div className="row-actions">
                {canEditPaymentStatus && (
                  <button
                    type="button"
                    disabled={busy || needsReconcile || isFetching}
                    className="button small secondary"
                    aria-label={t("markPaymentLabel", {
                      status: String(row.paymentStatus),
                      from: String(row.destinationFrom),
                      to: String(row.destinationTo),
                    })}
                    onClick={() => void changePaymentStatus(row)}
                  >
                    {row.paymentStatus === "PAID"
                      ? t("markUnpaid")
                      : t("markPaid")}
                  </button>
                )}
                <button
                  type="button"
                  disabled={busy || needsReconcile}
                  className="icon-button"
                  aria-label={t("editDriveLabel", {
                    from: String(row.destinationFrom),
                    to: String(row.destinationTo),
                  })}
                  onClick={() => openEdit(row)}
                >
                  <Pencil size={15} />
                </button>
                <button
                  type="button"
                  disabled={busy || needsReconcile}
                  className="icon-button"
                  aria-label={t("deleteDriveLabel", {
                    from: String(row.destinationFrom),
                    to: String(row.destinationTo),
                  })}
                  onClick={() => void remove(row)}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            )}
          />
        )}
        <div className="pagination">
          <span>{t("pagination", { page, count: data?.total || 0 })}</span>
          <div className="buttons">
            <button
              type="button"
              className="button small secondary"
              disabled={page <= 1 || loading}
              onClick={() => setPage(page - 1)}
            >
              <ArrowLeft size={13} />
              {t("previous")}
            </button>
            <button
              type="button"
              className="button small secondary"
              disabled={page * PAGE_SIZE >= (data?.total || 0) || loading}
              onClick={() => setPage(page + 1)}
            >
              {t("next")}
              <ArrowRight size={13} />
            </button>
          </div>
        </div>
      </section>
      {editing && (
        <Modal
          title={editing.id ? t("editDrive") : t("addDrive")}
          close={() => {
            if (!busy) setEditing(null);
          }}
        >
          <form onSubmit={submit}>
            <ErrorNotice message={actionError} />
            <div className="form-grid">
              <div className="field">
                <label htmlFor="drive-cost-date">{t("requiredDate")}</label>
                <input
                  id="drive-cost-date"
                  name="date"
                  type="date"
                  required
                  value={editing.date}
                  onChange={(event) =>
                    setEditing({ ...editing, date: event.target.value })
                  }
                />
              </div>
              <div className="field">
                <label htmlFor="drive-cost-kilometers">
                  {t("requiredKilometers")}
                </label>
                <input
                  id="drive-cost-kilometers"
                  name="kilometers"
                  type="number"
                  min="0.01"
                  max="100000"
                  step="0.01"
                  required
                  aria-describedby="drive-cost-distance-help"
                  value={editing.kilometers}
                  onChange={(event) =>
                    setEditing({ ...editing, kilometers: event.target.value })
                  }
                />
                <small id="drive-cost-distance-help" className="muted">
                  {t("distanceHelp")}
                </small>
              </div>
              <div className="field">
                <label htmlFor="drive-cost-from">{t("requiredFrom")}</label>
                <input
                  id="drive-cost-from"
                  name="destinationFrom"
                  required
                  maxLength={160}
                  value={editing.destinationFrom}
                  onChange={(event) =>
                    setEditing({
                      ...editing,
                      destinationFrom: event.target.value,
                    })
                  }
                />
              </div>
              <div className="field">
                <label htmlFor="drive-cost-to">{t("requiredTo")}</label>
                <input
                  id="drive-cost-to"
                  name="destinationTo"
                  required
                  maxLength={160}
                  value={editing.destinationTo}
                  onChange={(event) =>
                    setEditing({
                      ...editing,
                      destinationTo: event.target.value,
                    })
                  }
                />
              </div>
              <div className="field full">
                <label htmlFor="drive-cost-trip-type">{t("tripType")}</label>
                <select
                  id="drive-cost-trip-type"
                  name="isRoundTrip"
                  aria-describedby="drive-cost-trip-help"
                  value={editing.isRoundTrip ? "round-trip" : "one-way"}
                  onChange={(event) =>
                    setEditing({
                      ...editing,
                      isRoundTrip: event.target.value === "round-trip",
                    })
                  }
                >
                  <option value="one-way">{t("oneWay")}</option>
                  <option value="round-trip">{t("roundTrip")}</option>
                </select>
                <small id="drive-cost-trip-help" className="muted">
                  {t("roundTripHelp")}
                </small>
              </div>
              <fieldset className="field full drive-cost-rate-field">
                <legend>{t("requiredRateType")}</legend>
                <div className="drive-cost-rate-options">
                  {(
                    [
                      ["IN_TIME", t("inTime"), t("standardTime")],
                      ["OVER_TIME", t("overTime"), t("outsideTime")],
                    ] as const
                  ).map(([value, title, description]) => (
                    <label
                      className={`drive-cost-rate-option ${editing.rateType === value ? "is-selected" : ""}`}
                      key={value}
                    >
                      <input
                        type="radio"
                        name="rateType"
                        value={value}
                        checked={editing.rateType === value}
                        onChange={() =>
                          setEditing({ ...editing, rateType: value })
                        }
                      />
                      <span>
                        <strong>{title}</strong>
                        <small>{description}</small>
                      </span>
                      <b>
                        {t("ratePerKm", { rate: taka(rates[value], locale) })}
                      </b>
                    </label>
                  ))}
                </div>
                <small className="muted">
                  {t("rateChangeHelp", {
                    date: formatDateLabel(DRIVE_COST_RATE_CHANGE_DATE, locale),
                  })}
                </small>
              </fieldset>
              <div className="drive-cost-preview full" aria-live="polite">
                <span>
                  <small>{t("calculatedTotal")}</small>
                  <strong>{taka(previewTotal, locale)}</strong>
                </span>
                <p>
                  {t("calculationFormula", {
                    kilometers: formatNumber(previewKilometers, locale),
                    rate: taka(selectedRate, locale),
                    roundTrip: editing.isRoundTrip ? "yes" : "no",
                  })}
                </p>
              </div>
            </div>
            <div className="form-actions">
              <button
                disabled={busy || needsReconcile}
                type="button"
                className="button secondary"
                onClick={() => setEditing(null)}
              >
                {t("cancel")}
              </button>
              <button
                disabled={busy || needsReconcile}
                type="submit"
                className="button"
              >
                {busy ? t("saving") : t("saveDrive")}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
