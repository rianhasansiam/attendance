import type { ReactNode } from "react";
import {
  AlertCircle,
  ArrowUpRight,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";

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
export function ErrorNotice({ message }: { message?: string }) {
  return message ? (
    <div className="notice error" role="alert">
      <AlertCircle size={18} />
      <span>{message}</span>
    </div>
  ) : null;
}
export function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="notice success" role="status">
      {children}
    </div>
  );
}
export function Loading() {
  return (
    <div className="loading" role="status">
      <LoaderCircle className="spin" size={22} /> Loading your workspace…
    </div>
  );
}
export function Empty({
  title = "Nothing here yet",
  description = "New records will appear here when they’re added.",
}: {
  title?: string;
  description?: string;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <ArrowUpRight size={24} />
      </div>
      <h3>{title}</h3>
      <p className="muted">{description}</p>
    </div>
  );
}
export function Refresh({ onClick }: { onClick: () => void }) {
  return (
    <button className="button secondary" onClick={onClick}>
      <RefreshCw size={15} />
      Refresh
    </button>
  );
}
export function Badge({ value }: { value: unknown }) {
  const text = String(value ?? "Pending");
  return (
    <span
      className={`badge ${["ACTIVE", "PRESENT", "APPROVED", "Verified"].includes(text) ? "green" : ["LATE", "PENDING", "HALF_DAY"].includes(text) ? "amber" : ["ABSENT", "REJECTED", "SUSPENDED", "REVOKED"].includes(text) ? "red" : ""}`}
    >
      {text.replaceAll("_", " ").toLowerCase()}
    </span>
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
export function label(value: unknown): string {
  if (value == null || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "object") {
    const row = value as DataRow;
    return String(row.name || row.email || row.id || "—");
  }
  return String(value);
}
export function date(value: unknown) {
  return value
    ? new Date(String(value)).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      })
    : "—";
}
export function time(value: unknown, timeZone?: string) {
  return value
    ? new Date(String(value)).toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        ...(timeZone ? { timeZone } : {}),
      })
    : "—";
}
export function duration(value: unknown) {
  const minutes = Number(value || 0);
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
export function Table({
  rows,
  columns,
  actions,
}: {
  rows: DataRow[];
  columns: {
    key: string;
    label: string;
    format?:
      "date" | "time" | "badge" | "duration" | "nullable-duration" | "text";
  }[];
  actions?: (row: DataRow) => ReactNode;
}) {
  if (!rows.length) return <Empty />;
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key}>{column.label}</th>
            ))}
            {actions && <th className="align-right">Actions</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={String(row.id || index)}>
              {columns.map((column) => {
                const value = nested(row, column.key);
                return (
                  <td key={column.key}>
                    {column.format === "badge" ? (
                      <Badge value={value} />
                    ) : column.format === "date" ? (
                      date(value)
                    ) : column.format === "time" ? (
                      time(value)
                    ) : column.format === "duration" ||
                      column.format === "nullable-duration" ? (
                      column.format === "nullable-duration" && value == null ? (
                        "—"
                      ) : (
                        duration(value)
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
                        {label(value)}
                      </span>
                    ) : (
                      label(value)
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
  return (
    <div className="pagination">
      <span>
        Page {page} · {total} records
      </span>
      <div className="buttons">
        <button
          className="button small secondary"
          disabled={loading || page <= 1}
          onClick={() => onPage(page - 1)}
        >
          Previous
        </button>
        <button
          className="button small secondary"
          disabled={loading || page * pageSize >= total}
          onClick={() => onPage(page + 1)}
        >
          Next
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
