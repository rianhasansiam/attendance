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
import {
  ErrorNotice,
  Loading,
  Notice,
  PageHeader,
  Refresh,
  Table,
  type DataRow,
} from "./ui";
import { useDebouncedValue } from "@/lib/client/use-debounced-value";
import { useUrlFilters, pageFromSearch } from "@/lib/client/use-url-filters";
import { isAmbiguousWrite } from "@/lib/client/attendance-ceremony";
import { useQueryView } from "@/store/use-query-view";
import { useFreshness } from "@/store/freshness";
import { errorMessage } from "@/store/api/errors";
import {
  useDriveCostsQuery,
  useDriveCostCalculationQuery,
  useSaveDriveCostMutation,
  useDeleteDriveCostMutation,
  useUpdateDriveCostPaymentMutation,
  type CalculationArgs,
} from "@/store/features/drive-costs/api";
import {
  DRIVE_COST_RATES,
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
const RATES: Record<RateType, number> = {
  IN_TIME: Number(DRIVE_COST_RATES.IN_TIME),
  OVER_TIME: Number(DRIVE_COST_RATES.OVER_TIME),
};

function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatNumber(value: unknown): string {
  return numberValue(value).toLocaleString("en-BD", {
    maximumFractionDigits: 2,
  });
}

function taka(value: unknown): string {
  return `৳${numberValue(value).toLocaleString("en-BD", {
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

function formatDateLabel(dateString: string): string {
  return new Date(dateString + "T00:00:00").toLocaleDateString("en-BD", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function DriveCostWorkspace({
  canEditPaymentStatus = false,
}: {
  canEditPaymentStatus?: boolean;
}) {
  const { params: urlParams, update } = useUrlFilters();
  const query = urlParams.get("q") || "";
  const search = useDebouncedValue(query);
  const dateFilters = {
    from: urlParams.get("from") || "",
    to: urlParams.get("to") || "",
  };
  const dateFilterKey = `${dateFilters.from}|${dateFilters.to}`;
  const [dateEdit, setDateEdit] = useState({
    key: dateFilterKey,
    ...dateFilters,
  });
  const dateDraft = dateEdit.key === dateFilterKey ? dateEdit : dateFilters;
  const setDateDraft = (draft: { from: string; to: string }) =>
    setDateEdit({ key: dateFilterKey, ...draft });
  const params = new URLSearchParams({ q: search });
  if (dateFilters.from) params.set("from", dateFilters.from);
  if (dateFilters.to) params.set("to", dateFilters.to);
  const filterKey = params.toString();
  const page = pageFromSearch(urlParams.get("page"));
  const [editing, setEditing] = useState<DriveCostDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [needsReconcile, setNeedsReconcile] = useState(false);
  const [actionError, setActionError] = useState("");
  const [message, setMessage] = useState("");
  const costsQuery = useDriveCostsQuery(
    {
      page,
      pageSize: PAGE_SIZE,
      q: search,
      ...(dateFilters.from ? { from: dateFilters.from } : {}),
      ...(dateFilters.to ? { to: dateFilters.to } : {}),
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

  // Draft inputs are local; the calculation and records belong to RTK Query.
  const [calcMode, setCalcMode] = useState<"single" | "range">("single");
  const [calcDate, setCalcDate] = useState(today());
  const [calcFrom, setCalcFrom] = useState(today());
  const [calcTo, setCalcTo] = useState(today());
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
      await refresh().unwrap();
      if (calcArgs && calcOpen) await refreshCalculation().unwrap();
      setNeedsReconcile(false);
    } catch {
      // Preserve the uncertainty gate until authoritative reads succeed.
    }
  }

  async function showWriteError(error: unknown) {
    setActionError(errorMessage(error));
    if (isAmbiguousWrite(error)) {
      setNeedsReconcile(true);
      await refreshCosts();
    }
  }

  function applyDateFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    update({ from: dateDraft.from, to: dateDraft.to, page: 1 });
  }

  function resetFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setDateDraft({ from: "", to: "" });
    update({ q: "", from: "", to: "", page: 1 });
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
      setActionError("Enter a distance greater than zero.");
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
      setMessage(
        editing.id
          ? "Drive cost updated successfully."
          : "Drive cost added successfully.",
      );
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
      setMessage(
        `Drive cost marked as ${paymentStatus === "PAID" ? "paid" : "unpaid"}.`,
      );
    } catch (error) {
      await showWriteError(error);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  async function remove(row: DataRow) {
    if (submitting.current || needsReconcile) return;
    const from = String(row.destinationFrom ?? "this destination");
    const to = String(row.destinationTo ?? "this destination");
    if (!window.confirm(`Delete the drive cost from ${from} to ${to}?`)) return;
    submitting.current = true;
    setBusy(true);
    setActionError("");
    setMessage("");
    try {
      await deleteDriveCost(String(row.id)).unwrap();
      setMessage("Drive cost deleted successfully.");
      if ((data?.items.length || 0) === 1 && page > 1) setPage(page - 1);
    } catch (error) {
      await showWriteError(error);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  function runCalculation() {
    const args =
      calcMode === "single"
        ? { from: calcDate }
        : { from: calcFrom, to: calcTo };
    if (calcArgs?.from === args.from && calcArgs?.to === args.to) {
      void refreshCalculation();
    } else {
      setCalcArgs(args);
    }
  }

  const tableRows: DataRow[] = (data?.items || []).map((record) => ({
    ...record,
    rateTypeLabel: record.rateType === "OVER_TIME" ? "Over time" : "In time",
    tripTypeLabel: record.isRoundTrip ? "Round trip (×2)" : "One way",
    paymentStatusLabel: record.paymentStatus === "PAID" ? "Paid" : "Unpaid",
    kilometersLabel: formatNumber(
      numberValue(record.kilometers) * (record.isRoundTrip ? 2 : 1),
    ),
    rateLabel: `${taka(record.ratePerKilometer)} / km`,
    totalLabel: taka(record.totalCost),
  }));
  const selectedRate = editing ? RATES[editing.rateType] : RATES.IN_TIME;
  const previewKilometers = numberValue(editing?.kilometers);
  const previewTotal =
    previewKilometers * selectedRate * (editing?.isRoundTrip ? 2 : 1);

  const calcRecordRows: DataRow[] = (calcResult?.records || []).map(
    (record) => ({
      ...record,
      rateTypeLabel: record.rateType === "OVER_TIME" ? "Over time" : "In time",
      tripTypeLabel: record.isRoundTrip ? "Round trip (×2)" : "One way",
      paymentStatusLabel: record.paymentStatus === "PAID" ? "Paid" : "Unpaid",
      kilometersLabel: formatNumber(
        numberValue(record.kilometers) * (record.isRoundTrip ? 2 : 1),
      ),
      rateLabel: `${taka(record.ratePerKilometer)} / km`,
      totalLabel: taka(record.totalCost),
    }),
  );

  return (
    <>
      <PageHeader
        eyebrow="TRAVEL EXPENSES"
        title="Drive Cost"
        description="Calculate and keep a clear record of every drive."
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
              {calcOpen ? "Hide calculator" : "Cost calculator"}
            </button>
            <button
              className="button"
              disabled={busy || needsReconcile}
              onClick={openNew}
            >
              <Plus size={16} />
              Add drive cost
            </button>
          </div>
        }
      />
      <ErrorNotice message={error || (!editing ? actionError : "")} />
      {isFetching && data && (
        <p className="muted" role="status">
          Refreshing drive costs…
        </p>
      )}
      {needsReconcile && (
        <Notice>
          Refresh drive costs successfully before trying another change.
        </Notice>
      )}
      {message && (
        <Notice>
          <Check size={16} />
          {message}
        </Notice>
      )}

      {/* Cost Calculator Section */}
      {calcOpen && (
        <section className="card calc-card">
          <div className="calc-header">
            <div className="calc-title">
              <Calculator size={18} />
              <div>
                <h3>Cost Calculator</h3>
                <p>
                  Calculate total drive costs for a single day or a date range.
                </p>
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
              Single day
            </button>
            <button
              type="button"
              className={`calc-mode-tab ${calcMode === "range" ? "is-active" : ""}`}
              onClick={() => setCalcMode("range")}
            >
              <Calendar size={14} />
              Date range
            </button>
          </div>

          <div className="calc-inputs">
            {calcMode === "single" ? (
              <div className="field">
                <label htmlFor="calc-date">Date</label>
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
                  <label htmlFor="calc-from">From date</label>
                  <input
                    id="calc-from"
                    type="date"
                    value={calcFrom}
                    onChange={(e) => setCalcFrom(e.target.value)}
                  />
                </div>
                <div className="field">
                  <label htmlFor="calc-to">To date</label>
                  <input
                    id="calc-to"
                    type="date"
                    value={calcTo}
                    onChange={(e) => setCalcTo(e.target.value)}
                  />
                </div>
              </>
            )}
            <button
              type="button"
              className="button calc-run-btn"
              disabled={calcBusy}
              onClick={() => void runCalculation()}
            >
              {calcBusy ? "Calculating…" : "Calculate"}
            </button>
          </div>

          <ErrorNotice message={calcError} />
          {calcBusy && calcResult && (
            <p className="muted" role="status">
              Refreshing calculation…
            </p>
          )}

          {calcResult && (
            <div className="calc-results">
              <PdfDownloadButton
                href={`/api/admin/drive-costs/report?${new URLSearchParams({ from: calcResult.dateFrom, to: calcResult.dateTo })}`}
                filename="drive-cost-report.pdf"
                disabled={calcBusy}
              />
              <div className="calc-date-label">
                {calcResult.isSingleDay
                  ? formatDateLabel(calcResult.dateFrom)
                  : `${formatDateLabel(calcResult.dateFrom)} — ${formatDateLabel(calcResult.dateTo)}`}
              </div>

              {calcResult.totalRecords === 0 ? (
                <div className="calc-empty">
                  <p>
                    No drive costs found for this{" "}
                    {calcResult.isSingleDay ? "date" : "date range"}.
                  </p>
                </div>
              ) : (
                <>
                  {/* Summary cards */}
                  <div className="calc-summary-grid">
                    <div className="calc-summary-card calc-total">
                      <small>Grand total</small>
                      <strong>{taka(calcResult.totalCost)}</strong>
                      <p>
                        {calcResult.totalRecords} trip
                        {calcResult.totalRecords !== 1 ? "s" : ""} ·{" "}
                        {formatNumber(calcResult.totalKilometers)} km
                      </p>
                    </div>
                    <div className="calc-summary-card">
                      <small>In time</small>
                      <strong>
                        {taka(calcResult.breakdown.inTime.totalCost)}
                      </strong>
                      <p>
                        {calcResult.breakdown.inTime.records} trip
                        {calcResult.breakdown.inTime.records !== 1
                          ? "s"
                          : ""} ·{" "}
                        {formatNumber(calcResult.breakdown.inTime.kilometers)}{" "}
                        km
                      </p>
                    </div>
                    <div className="calc-summary-card">
                      <small>Over time</small>
                      <strong>
                        {taka(calcResult.breakdown.overTime.totalCost)}
                      </strong>
                      <p>
                        {calcResult.breakdown.overTime.records} trip
                        {calcResult.breakdown.overTime.records !== 1
                          ? "s"
                          : ""}{" "}
                        ·{" "}
                        {formatNumber(calcResult.breakdown.overTime.kilometers)}{" "}
                        km
                      </p>
                    </div>
                  </div>

                  {/* Trip details table */}
                  <div className="calc-details">
                    <h4>Trip details</h4>
                    <Table
                      rows={calcRecordRows}
                      dateGroupKey="date"
                      columns={[
                        { key: "date", label: "Date", format: "date" },
                        { key: "destinationFrom", label: "From" },
                        { key: "destinationTo", label: "To" },
                        { key: "tripTypeLabel", label: "Trip type" },
                        {
                          key: "rateTypeLabel",
                          label: "Rate type",
                          format: "badge",
                        },
                        { key: "kilometersLabel", label: "Total km" },
                        { key: "rateLabel", label: "Rate" },
                        { key: "totalLabel", label: "Total" },
                        {
                          key: "paymentStatusLabel",
                          label: "Payment status",
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
          aria-label="Filter drive costs by date"
          onSubmit={applyDateFilters}
          onReset={resetFilters}
        >
          <div className="field">
            <label htmlFor="drive-cost-filter-from">From date</label>
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
            <label htmlFor="drive-cost-filter-to">To date</label>
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
          <div className="buttons">
            <button className="button" type="submit" disabled={loading}>
              Apply filters
            </button>
            <button
              className="button secondary"
              type="reset"
              disabled={loading}
            >
              Reset filters
            </button>
          </div>
          <p className="muted">
            Use the same date in both fields for a single day. Leave a field
            blank for an open-ended range.
          </p>
        </form>
        <div className="toolbar">
          <div className="search-field">
            <Search size={16} />
            <input
              type="search"
              aria-label="Search drive costs"
              placeholder="Search destinations…"
              value={query}
              onChange={(event) => update({ q: event.target.value, page: 1 })}
            />
          </div>
          <span className="muted" style={{ fontSize: 11 }}>
            {data?.total || 0} records
          </span>
        </div>
        {loading ? (
          <Loading />
        ) : (
          <Table
            rows={tableRows}
            dateGroupKey="date"
            columns={[
              { key: "date", label: "Date", format: "date" },
              { key: "destinationFrom", label: "From" },
              { key: "destinationTo", label: "To" },
              { key: "tripTypeLabel", label: "Trip type" },
              { key: "rateTypeLabel", label: "Rate type", format: "badge" },
              { key: "kilometersLabel", label: "Total km" },
              { key: "rateLabel", label: "Rate" },
              { key: "totalLabel", label: "Total" },
              {
                key: "paymentStatusLabel",
                label: "Payment status",
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
                    aria-label={`Mark ${row.paymentStatus === "PAID" ? "unpaid" : "paid"} for drive cost from ${String(row.destinationFrom)} to ${String(row.destinationTo)}`}
                    onClick={() => void changePaymentStatus(row)}
                  >
                    {row.paymentStatus === "PAID" ? "Mark unpaid" : "Mark paid"}
                  </button>
                )}
                <button
                  type="button"
                  disabled={busy || needsReconcile}
                  className="icon-button"
                  aria-label={`Edit drive cost from ${String(row.destinationFrom)} to ${String(row.destinationTo)}`}
                  onClick={() => openEdit(row)}
                >
                  <Pencil size={15} />
                </button>
                <button
                  type="button"
                  disabled={busy || needsReconcile}
                  className="icon-button"
                  aria-label={`Delete drive cost from ${String(row.destinationFrom)} to ${String(row.destinationTo)}`}
                  onClick={() => void remove(row)}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            )}
          />
        )}
        <div className="pagination">
          <span>
            Page {page} · {data?.total || 0} total records
          </span>
          <div className="buttons">
            <button
              type="button"
              className="button small secondary"
              disabled={page <= 1 || loading}
              onClick={() => setPage(page - 1)}
            >
              <ArrowLeft size={13} />
              Previous
            </button>
            <button
              type="button"
              className="button small secondary"
              disabled={page * PAGE_SIZE >= (data?.total || 0) || loading}
              onClick={() => setPage(page + 1)}
            >
              Next
              <ArrowRight size={13} />
            </button>
          </div>
        </div>
      </section>
      {editing && (
        <Modal
          title={editing.id ? "Edit drive cost" : "Add drive cost"}
          close={() => {
            if (!busy) setEditing(null);
          }}
        >
          <form onSubmit={submit}>
            <ErrorNotice message={actionError} />
            <div className="form-grid">
              <div className="field">
                <label htmlFor="drive-cost-date">Date *</label>
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
                  Kilometers (one way) *
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
                  Enter the one-way distance. Round trips include the return
                  journey.
                </small>
              </div>
              <div className="field">
                <label htmlFor="drive-cost-from">Destination from *</label>
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
                <label htmlFor="drive-cost-to">Destination to *</label>
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
                <label htmlFor="drive-cost-trip-type">Trip type</label>
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
                  <option value="one-way">One way</option>
                  <option value="round-trip">Round trip (×2)</option>
                </select>
                <small id="drive-cost-trip-help" className="muted">
                  For office → destination → office, choose round trip to double
                  the distance and cost.
                </small>
              </div>
              <fieldset className="field full drive-cost-rate-field">
                <legend>Rate type *</legend>
                <div className="drive-cost-rate-options">
                  {(
                    [
                      ["IN_TIME", "In time", "Standard work time"],
                      ["OVER_TIME", "Over time", "Outside work time"],
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
                      <b>৳{RATES[value]}/km</b>
                    </label>
                  ))}
                </div>
              </fieldset>
              <div className="drive-cost-preview full" aria-live="polite">
                <span>
                  <small>Calculated total</small>
                  <strong>{taka(previewTotal)}</strong>
                </span>
                <p>
                  {formatNumber(previewKilometers)} km × ৳{selectedRate}/km
                  {editing.isRoundTrip ? " × 2" : ""}
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
                Cancel
              </button>
              <button
                disabled={busy || needsReconcile}
                type="submit"
                className="button"
              >
                {busy ? "Saving…" : "Save drive cost"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
