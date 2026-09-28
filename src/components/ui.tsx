import { useLocale, useTranslations, createTranslator } from "next-intl";
import { localizeKnownMessage } from "@/i18n/errors";
import enCommon from "../../messages/en/common.json";
import zhCommon from "../../messages/zh-CN/common.json";
import { Children, isValidElement, type ReactNode } from "react";
import { AlertNotification } from "@/components/alert-notification";
import { DELETED_INFO } from "@/lib/deleted-info";
import { AlertCircle, ArrowUpRight, RefreshCw } from "lucide-react";

export type DataRow = Record<string, unknown>;
export function PageHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1>{title}</h1>
        <p className="muted">{description}</p>
      </div>
      {action}
    </div>
  );
}
export function ErrorNotice({
  message,
  notify = true,
}: {
  message?: string;
  notify?: boolean;
}) {
  const locale = useLocale();
  const localized = message ? localizeKnownMessage(message, locale) : "";
  return message ? (
    <div className="notice error" role="alert">
      <AlertCircle size={18} />
      <span>{localized}</span>
      {notify && <AlertNotification message={localized} kind="error" />}
    </div>
  ) : null;
}
function notificationText(children: ReactNode): string {
  return Children.toArray(children)
    .map((child) => {
      if (typeof child === "string" || typeof child === "number")
        return String(child);
      if (isValidElement<{ children?: ReactNode }>(child))
        return notificationText(child.props.children);
      return "";
    })
    .join("");
}

export function Notice({
  children,
  notify = false,
}: {
  children: ReactNode;
  notify?: boolean;
}) {
  return (
    <div className="notice success" role="status">
      {children}
      {notify && (
        <AlertNotification
          message={notificationText(children)}
          kind="success"
        />
      )}
    </div>
  );
}
export { LoadingIndicator as Loading } from "./loading-indicator";

export function Empty({
  title,
  description,
}: {
  title?: string;
  description?: string;
}) {
  const t = useTranslations("common");
  return (
    <div className="empty">
      <div className="empty-icon">
        <ArrowUpRight size={24} />
      </div>
      <h3>{title || t("emptyTitle")}</h3>
      <p className="muted">{description || t("emptyDescription")}</p>
    </div>
  );
}
export function Refresh({ onClick }: { onClick: () => void }) {
  const t = useTranslations("common");
  return (
    <button className="button secondary" onClick={onClick}>
      <RefreshCw size={15} />
      {t("refresh")}
    </button>
  );
}
export function Badge({ value }: { value: unknown }) {
  const t = useTranslations("common");
  const text = String(value ?? "Pending");
  return (
    <span
      className={`badge ${["ACTIVE", "PRESENT", "APPROVED", "Verified"].includes(text) ? "green" : ["LATE", "PENDING", "HALF_DAY"].includes(text) ? "amber" : ["ABSENT", "REJECTED", "SUSPENDED", "REVOKED"].includes(text) ? "red" : ""}`}
    >
      {t.has(
        `status.${text.toUpperCase().replaceAll(" ", "_") as keyof typeof enCommon.status}`,
      )
        ? t(
            `status.${text.toUpperCase().replaceAll(" ", "_") as keyof typeof enCommon.status}`,
          )
        : text.replaceAll("_", " ").toLowerCase()}
    </span>
  );
}
export function AttendanceStatus({ record }: { record: DataRow }) {
  const t = useTranslations("common");
  return (
    <div
      className="stack"
      style={{
        gap: 5,
        alignItems: "flex-start",
        fontSize: 12,
        lineHeight: 1.4,
        letterSpacing: "normal",
        fontWeight: 400,
      }}
    >
      <Badge value={record.status} />
      {record.actualStatus != null && record.actualStatus !== record.status && (
        <small className="muted">
          {t("actualStatus", {
            status: t.has(
              `status.${record.actualStatus as keyof typeof enCommon.status}`,
            )
              ? t(
                  `status.${record.actualStatus as keyof typeof enCommon.status}`,
                )
              : String(record.actualStatus),
          })}
        </small>
      )}
      {record.lateApprovalStatus != null && (
        <small>
          {t("lateApproval")} <Badge value={record.lateApprovalStatus} />
        </small>
      )}
      {record.isExcusedLate === true && (
        <small className="muted">{t("excusedLate")}</small>
      )}
      {record.lateApprovalStatus === "APPROVED" &&
        record.isExcusedLate === false && (
          <small className="muted">
            {t(
              Number(record.lateMinutes) > 0
                ? "lateStillCounted"
                : "approvalMismatch",
            )}
          </small>
        )}
    </div>
  );
}
export function nested(row: DataRow, key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>(
      (value, part) =>
        value && typeof value === "object"
          ? (value as DataRow)[part]
          : undefined,
      row,
    );
}
export function label(value: unknown, locale = "en"): string {
  const t = createTranslator({
    locale,
    messages: locale === "zh-CN" ? zhCommon : enCommon,
  });
  if (value == null || value === "") return "—";
  if (typeof value === "boolean") return t(value ? "yes" : "no");
  if (typeof value === "object") {
    const row = value as DataRow;
    return String(row.name || row.email || row.id || "—");
  }
  return String(value);
}
export function date(value: unknown, locale = "en") {
  return value
    ? new Date(String(value)).toLocaleDateString(locale, {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      })
    : "—";
}
export function time(value: unknown, timeZone?: string, locale = "en") {
  return value
    ? new Date(String(value)).toLocaleTimeString(locale, {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: timeZone || "Asia/Dhaka",
      })
    : "—";
}
export function duration(value: unknown, locale = "en") {
  const t = createTranslator({
    locale,
    messages: locale === "zh-CN" ? zhCommon : enCommon,
  });
  const minutes = Number(value || 0);
  const magnitude = Math.abs(minutes);
  return t("duration", {
    sign: minutes < 0 ? "-" : "",
    hours: Math.floor(magnitude / 60),
    minutes: magnitude % 60,
  });
}
export function Table({
  rows,
  columns,
  actions,
  dateGroupKey,
}: {
  rows: DataRow[];
  columns: {
    key: string;
    label: string;
    render?: (value: unknown, row: DataRow) => ReactNode;
    format?:
      | "date"
      | "time"
      | "badge"
      | "attendance-status"
      | "duration"
      | "nullable-duration"
      | "text";
  }[];
  actions?: (row: DataRow) => ReactNode;
  dateGroupKey?: string;
}) {
  const locale = useLocale();
  const t = useTranslations("common");
  if (!rows.length) return <Empty />;
  const dateGroups = new Map<string, number>();
  const rowClasses = dateGroupKey
    ? rows.map((row) => {
        const groupDate = date(nested(row, dateGroupKey), locale);
        if (!dateGroups.has(groupDate)) {
          dateGroups.set(groupDate, dateGroups.size % 2);
        }
        return `date-group-${dateGroups.get(groupDate)}`;
      })
    : [];
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key}>{column.label}</th>
            ))}
            {actions && <th className="align-right">{t("actions")}</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={String(row.id || index)} className={rowClasses[index]}>
              {columns.map((column) => {
                const missingIdentity = [
                  "employee",
                  "attendance.employee",
                  "actor",
                  "createdBy",
                ].some(
                  (path) =>
                    column.key.startsWith(`${path}.`) &&
                    nested(row, path) === null,
                );
                const value = missingIdentity
                  ? DELETED_INFO
                  : nested(row, column.key);
                return (
                  <td key={column.key}>
                    {missingIdentity ? (
                      t("deleted")
                    ) : column.render ? (
                      column.render(value, row)
                    ) : column.format === "attendance-status" ? (
                      <AttendanceStatus record={row} />
                    ) : column.format === "badge" ? (
                      <Badge value={value} />
                    ) : column.format === "date" ? (
                      date(value, locale)
                    ) : column.format === "time" ? (
                      time(value, undefined, locale)
                    ) : column.format === "duration" ||
                      column.format === "nullable-duration" ? (
                      column.format === "nullable-duration" && value == null ? (
                        "—"
                      ) : (
                        duration(value, locale)
                      )
                    ) : column.format === "text" ? (
                      <span
                        style={{
                          display: "block",
                          minWidth: 180,
                          maxWidth: 320,
                          whiteSpace: "pre-wrap",
                          overflowWrap: "anywhere",
                        }}
                      >
                        {label(value, locale)}
                      </span>
                    ) : (
                      label(value, locale)
                    )}
                  </td>
                );
              })}
              {actions && <td className="align-right">{actions(row)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
export function items(data: unknown): DataRow[] {
  if (Array.isArray(data)) return data as DataRow[];
  if (data && typeof data === "object") {
    const result = data as DataRow;
    return (result.items || result.rows || result.records || []) as DataRow[];
  }
  return [];
}
export function Pagination({
  page,
  pageSize,
  total,
  loading,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  loading: boolean;
  onPage: (page: number) => void;
}) {
  const t = useTranslations("common");
  return (
    <div className="pagination">
      <span>{t("pagination", { page, total })}</span>
      <div className="buttons">
        <button
          className="button small secondary"
          disabled={loading || page <= 1}
          onClick={() => onPage(page - 1)}
        >
          {t("previous")}
        </button>
        <button
          className="button small secondary"
          disabled={loading || page * pageSize >= total}
          onClick={() => onPage(page + 1)}
        >
          {t("next")}
        </button>
      </div>
    </div>
  );
}

export function Metric({
  title,
  value,
  note,
  icon,
  featured = false,
}: {
  title: string;
  value: ReactNode;
  note: string;
  icon: ReactNode;
  featured?: boolean;
}) {
  return (
    <div className={`stat-card ${featured ? "featured" : ""}`}>
      <div className="stat-top">
        <span>{title}</span>
        <span className="stat-icon">{icon}</span>
      </div>
      <div
        className="stat-value"
        style={
          typeof value === "string" && value.length > 14
            ? { fontSize: 19, padding: "6px 0" }
            : undefined
        }
      >
        {value}
      </div>
      <p className="stat-note">{note}</p>
    </div>
  );
}
