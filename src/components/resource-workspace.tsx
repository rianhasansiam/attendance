"use client";

import Link from "next/link";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Eye,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import {
  ErrorNotice,
  items,
  label,
  Loading,
  nested,
  Notice,
  PageHeader,
  Table,
  type DataRow,
} from "./ui";
import { api, useDebouncedValue, useResource } from "./use-resource";
import { fieldValue, resourceConfigs, type Field } from "./resource-config";

type ResourceData = {
  items: DataRow[];
  total: number;
  page: number;
  pageSize: number;
};
export function Modal({
  title,
  children,
  close,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const container = ref.current;
    container
      ?.querySelector<HTMLElement>(
        "button, input, select, textarea, [tabindex]",
      )
      ?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
      if (event.key !== "Tab") return;
      const focusable = container?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]',
      );
      if (!focusable?.length) return;
      const first = focusable[0],
        last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, [close]);
  return (
    <div className="modal-backdrop">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="modal"
      >
        <div className="card-header">
          <h2>{title}</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="Close dialog"
            onClick={close}
          >
            <X size={19} />
          </button>
        </div>
        <div className="card-body">{children}</div>
      </div>
    </div>
  );
}
function ReferenceField({ field, value }: { field: Field; value: string }) {
  const [query, setQuery] = useState("");
  const search = useDebouncedValue(query);
  const [pagination, setPagination] = useState({ query: "", page: 1 });
  const page = pagination.query === search ? pagination.page : 1;
  const [selection, setSelection] = useState(value);
  const { data, loading, error } = useResource<ResourceData>(
    `/api/admin/lookups/${field.resource}?page=${page}&pageSize=100&q=${encodeURIComponent(search)}`,
  );
  const rows = items(data);
  return (
    <>
      <input
        type="search"
        aria-label={`Find ${field.label.toLowerCase()}`}
        placeholder={`Search ${field.label.toLowerCase()}…`}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <select
        id={field.name}
        name={field.name}
        required={field.required}
        value={selection}
        onChange={(event) => setSelection(event.target.value)}
      >
        <option value="">
          {loading ? "Loading options…" : `Select ${field.label.toLowerCase()}`}
        </option>
        {selection && !rows.some((row) => row.id === selection) && (
          <option value={selection}>Current selection</option>
        )}
        {rows.map((row) => (
          <option key={String(row.id)} value={String(row.id)}>
            {label(nested(row, "user.name") || row.name || row.employeeCode)}
            {row.employeeCode ? ` · ${row.employeeCode}` : ""}
          </option>
        ))}
      </select>
      {(page > 1 || (data?.total || 0) > 100) && (
        <div className="buttons">
          <button
            type="button"
            className="button small secondary"
            disabled={loading || page <= 1}
            onClick={() => setPagination({ query: search, page: page - 1 })}
          >
            Previous options
          </button>
          <button
            type="button"
            className="button small secondary"
            disabled={loading || page * 100 >= (data?.total || 0)}
            onClick={() => setPagination({ query: search, page: page + 1 })}
          >
            Next options
          </button>
        </div>
      )}
      {error && <small role="alert">{error}</small>}
    </>
  );
}
export function FormField({ field, row }: { field: Field; row: DataRow }) {
  const value = fieldValue(row, field);
  if (field.type === "checkbox")
    return (
      <label className="field-checkbox">
        <input
          type="checkbox"
          name={field.name}
          defaultChecked={Boolean(value)}
        />
        {field.label}
      </label>
    );
  if (field.type === "days")
    return (
      <fieldset className="field full">
        <legend>{field.label}</legend>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 13 }}>
          {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(
            (day, index) => (
              <label className="field-checkbox" key={day}>
                <input
                  name={field.name}
                  value={index}
                  type="checkbox"
                  defaultChecked={Array.isArray(value) && value.includes(index)}
                />
                {day}
              </label>
            ),
          )}
        </div>
      </fieldset>
    );
  return (
    <div className={`field ${field.type === "textarea" ? "full" : ""}`}>
      <label htmlFor={field.name}>
        {field.label}
        {field.required && " *"}
      </label>
      {field.resource ? (
        <ReferenceField field={field} value={String(value ?? "")} />
      ) : field.type === "select" ? (
        <select
          id={field.name}
          name={field.name}
          defaultValue={String(value ?? "")}
          required={field.required}
        >
          {field.options?.map((option) => (
            <option key={option} value={option}>
              {option.replaceAll("_", " ")}
            </option>
          ))}
        </select>
      ) : field.type === "textarea" ? (
        <textarea
          id={field.name}
          name={field.name}
          defaultValue={String(value ?? "")}
          required={field.required}
          maxLength={1000}
        />
      ) : (
        <input
          id={field.name}
          name={field.name}
          defaultValue={String(value ?? "")}
          type={field.type || "text"}
          required={field.required}
          min={field.min}
          max={field.max}
          step={
            field.type === "number" &&
            ["latitude", "longitude"].includes(field.name)
              ? "any"
              : undefined
          }
          maxLength={field.type === "email" ? 254 : 500}
        />
      )}
      {field.hint && <small>{field.hint}</small>}
    </div>
  );
}
export function AdminResource({ resource }: { resource: string }) {
  const config = resourceConfigs[resource];
  const [query, setQuery] = useState("");
  const search = useDebouncedValue(query);
  const [pagination, setPagination] = useState({ query: "", page: 1 });
  const page = pagination.query === search ? pagination.page : 1;
  function setPage(next: number) {
    setPagination({ query: search, page: next });
  }
  const [editing, setEditing] = useState<DataRow | null>(null);
  const [viewing, setViewing] = useState<DataRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [message, setMessage] = useState("");
  const { data, error, loading, refresh } = useResource<ResourceData>(
    `/api/admin/${resource}?page=${page}&pageSize=25&q=${encodeURIComponent(search)}`,
  );
  if (!config) return null;
  const fields = config.fields
    .filter((field) =>
      editing?.id ? field.edit !== false : field.create !== false,
    )
    .map((field) =>
      resource === "users" && editing?.id && field.name === "role"
        ? { ...field, options: ["EMPLOYEE", "ADMIN", "SUPER_ADMIN"] }
        : field,
    );
  async function mutate(
    id: string | null,
    payload: DataRow,
    method = id ? "PATCH" : "POST",
  ) {
    setBusy(true);
    setActionError("");
    setMessage("");
    try {
      await api(`/api/admin/${resource}${id ? `/${id}` : ""}`, {
        method,
        body: JSON.stringify(payload),
      });
      setEditing(null);
      setMessage("Your changes have been saved.");
      refresh();
    } catch (error) {
      setActionError(
        error instanceof Error
          ? error.message
          : "Unable to save. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function openNew() {
    setActionError("");
    if (resource !== "offices") {
      setEditing({});
      return;
    }
    setBusy(true);
    try {
      const defaults = await api<DataRow>("/api/admin/office-defaults");
      setEditing(defaults);
    } catch (error) {
      setActionError(
        error instanceof Error
          ? error.message
          : "Unable to load office defaults.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const payload: DataRow = {};
    for (const field of fields) {
      const value = form.get(field.name);
      payload[field.name] =
        field.type === "checkbox"
          ? form.has(field.name)
          : field.type === "days"
            ? form.getAll(field.name).map(Number)
            : field.type === "number"
              ? Number(value)
              : value === "" &&
                  [
                    "departmentId",
                    "officeId",
                    "endDate",
                    "description",
                  ].includes(field.name)
                ? null
                : value;
    }
    await mutate(editing?.id ? String(editing.id) : null, payload);
  }
  return (
    <>
      <PageHeader
        eyebrow="WORKSPACE MANAGEMENT"
        title={config.title}
        description={config.description}
        action={
          !config.readOnly && !config.noCreate ? (
            <button disabled={busy} className="button" onClick={openNew}>
              <Plus size={16} />
              Add {config.singular}
            </button>
          ) : undefined
        }
      />
      <ErrorNotice message={error || (!editing ? actionError : "")} />
      {message && (
        <Notice>
          <Check size={16} />
          {message}
        </Notice>
      )}
      <section className="card">
        <div className="toolbar">
          <div className="search-field">
            <Search size={16} />
            <input
              aria-label={`Search ${config.title.toLowerCase()}`}
              placeholder={`Search ${config.title.toLowerCase()}…`}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
              }}
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
            rows={items(data)}
            columns={config.columns}
            actions={(row) => (
              <div className="row-actions">
                {resource === "devices" ? (
                  <>
                    {!row.revokedAt && !row.approved && (
                      <button
                        disabled={busy}
                        className="button small"
                        onClick={() =>
                          mutate(String(row.id), { approved: true })
                        }
                      >
                        Approve
                      </button>
                    )}
                    {!row.revokedAt && (
                      <button
                        disabled={busy}
                        className="button small secondary"
                        onClick={() => {
                          if (
                            window.confirm(
                              "Revoke this device? It will no longer verify attendance.",
                            )
                          )
                            void mutate(String(row.id), { revoked: true });
                        }}
                      >
                        Revoke
                      </button>
                    )}
                  </>
                ) : resource === "leaves" ? (
                  <>
                    {row.status === "PENDING" && (
                      <>
                        <button
                          disabled={busy}
                          className="button small"
                          onClick={() => {
                            const reviewNote = window.prompt(
                              "Review note (optional)",
                              "",
                            );
                            if (reviewNote !== null)
                              void mutate(String(row.id), {
                                status: "APPROVED",
                                reviewNote,
                              });
                          }}
                        >
                          Approve
                        </button>
                        <button
                          disabled={busy}
                          className="button small secondary"
                          onClick={() => {
                            const reviewNote = window.prompt(
                              "Review note (optional)",
                              "",
                            );
                            if (reviewNote !== null)
                              void mutate(String(row.id), {
                                status: "REJECTED",
                                reviewNote,
                              });
                          }}
                        >
                          Decline
                        </button>
                      </>
                    )}
                  </>
                ) : config.readOnly ? (
                  <button
                    aria-label="View audit entry"
                    className="icon-button"
                    onClick={() => setViewing(row)}
                  >
                    <Eye size={16} />
                  </button>
                ) : (
                  <>
                    {resource === "employees" && (
                      <Link
                        title="View employee attendance"
                        className="icon-button"
                        href={`/admin/attendance?employeeId=${row.id}`}
                      >
                        <Eye size={16} />
                      </Link>
                    )}
                    <button
                      aria-label={`Edit ${config.singular}`}
                      className="icon-button"
                      onClick={() => {
                        setEditing(row);
                        setActionError("");
                      }}
                    >
                      <Pencil size={15} />
                    </button>
                    {!config.noDelete && (
                      <button
                        disabled={busy}
                        aria-label={`Delete ${config.singular}`}
                        className="icon-button"
                        onClick={() => {
                          if (
                            window.confirm(
                              `Delete this ${config.singular}? Existing references may prevent deletion.`,
                            )
                          )
                            void mutate(String(row.id), {}, "DELETE");
                        }}
                      >
                        <Trash2 size={15} />
                      </button>
                    )}
                  </>
                )}
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
              className="button small secondary"
              disabled={page <= 1 || loading}
              onClick={() => setPage(page - 1)}
            >
              <ArrowLeft size={13} />
              Previous
            </button>
            <button
              className="button small secondary"
              disabled={page * 25 >= (data?.total || 0) || loading}
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
          title={`${editing.id ? "Edit" : "Add"} ${config.singular}`}
          close={() => {
            if (!busy) setEditing(null);
          }}
        >
          <form onSubmit={submit}>
            <ErrorNotice message={actionError} />
            <div className="form-grid">
              {fields.map((field) => (
                <FormField key={field.name} field={field} row={editing} />
              ))}
            </div>
            <div className="form-actions">
              <button
                disabled={busy}
                type="button"
                className="button secondary"
                onClick={() => setEditing(null)}
              >
                Cancel
              </button>
              <button disabled={busy} type="submit" className="button">
                {busy ? "Saving…" : "Save changes"}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {viewing && (
        <Modal title="Audit entry" close={() => setViewing(null)}>
          <dl className="detail-list">
            {["action", "resource", "resourceId", "createdAt"].map((key) => (
              <div className="detail-item" key={key}>
                <dt>{key}</dt>
                <dd>{label(viewing[key])}</dd>
              </div>
            ))}
          </dl>
          <h3 style={{ margin: "25px 0 10px" }}>Previous state</h3>
          <pre className="json-detail">
            {JSON.stringify(viewing.previousState, null, 2)}
          </pre>
          <h3 style={{ margin: "20px 0 10px" }}>New state</h3>
          <pre className="json-detail">
            {JSON.stringify(viewing.newState, null, 2)}
          </pre>
        </Modal>
      )}
    </>
  );
}
