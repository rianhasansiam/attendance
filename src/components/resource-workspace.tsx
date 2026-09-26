"use client";

import Link from "next/link";
import { useRef, useState, type FormEvent } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ExternalLink,
  Eye,
  Pencil,
  Plus,
  Search,
  Trash2,
  UserRoundPen,
} from "lucide-react";
import {
  ErrorNotice,
  items,
  label,
  Loading,
  nested,
  Notice,
  PageHeader,
  Refresh,
  Table,
  type DataRow,
} from "./ui";
import { useDebouncedValue } from "@/lib/client/use-debounced-value";
import { useUrlFilters, pageFromSearch } from "@/lib/client/use-url-filters";
import { confirmAction, promptAction } from "@/lib/client/alerts";
import { api, ClientRequestError } from "@/lib/client/request";
import { errorMessage, normalizeError } from "@/store/api/errors";
import { baseApi } from "@/store/api/base-api";
import { useAppDispatch } from "@/store/hooks";
import { isAmbiguousWrite } from "@/lib/client/attendance-ceremony";
import { useFreshness } from "@/store/freshness";
import { useQueryView } from "@/store/use-query-view";
import {
  useGetManagementQuery,
  useGetReferenceQuery,
  useLazyGetOfficeDefaultsQuery,
  useWriteManagementMutation,
  managementInvalidation,
} from "@/store/features/management/api";
import type {
  JsonRecord,
  ManagementResource,
  ReferenceResource,
} from "@/store/features/management/contracts";
import { Modal } from "./modal";
export { Modal } from "./modal";
import { fieldValue, resourceConfigs, type Field } from "./resource-config";
import { PasswordField, validateNewPassword } from "./auth/password-fields";

function PublicProfileLink({
  resource,
  row,
}: {
  resource: string;
  row: DataRow;
}) {
  if (resource !== "employees" && resource !== "users") return null;
  const id = resource === "employees" ? nested(row, "user.id") : row.id;
  const slug =
    resource === "employees"
      ? nested(row, "user.profileSlug")
      : row.profileSlug;
  const status =
    resource === "employees" ? nested(row, "user.status") : row.status;
  if (status !== "ACTIVE" || typeof id !== "string" || !id) return null;
  return (
    <Link
      href={`/profile/${encodeURIComponent(typeof slug === "string" && slug ? slug : id)}`}
      prefetch={false}
      target="_blank"
      rel="noopener noreferrer"
      title="View public profile (opens in new tab)"
      aria-label="View public profile (opens in new tab)"
      className="icon-button"
    >
      <ExternalLink size={16} />
    </Link>
  );
}

function EditPublicProfileLink({
  resource,
  row,
}: {
  resource: string;
  row: DataRow;
}) {
  if (resource !== "employees" && resource !== "users") return null;
  const id = resource === "employees" ? nested(row, "user.id") : row.id;
  if (typeof id !== "string" || !id) return null;
  return (
    <Link
      href={`/admin/users/${encodeURIComponent(id)}/profile`}
      prefetch={false}
      title="Edit public profile"
      aria-label="Edit public profile"
      className="icon-button"
    >
      <UserRoundPen size={16} />
    </Link>
  );
}

function ReferenceField({ field, value }: { field: Field; value: string }) {
  const [query, setQuery] = useState("");
  const search = useDebouncedValue(query);
  const [pagination, setPagination] = useState({ query: "", page: 1 });
  const page = pagination.query === search ? pagination.page : 1;
  const [selection, setSelection] = useState(value);
  const result = useGetReferenceQuery(
    {
      resource: field.resource as ReferenceResource,
      params: { page, pageSize: 100, q: search },
    },
    useFreshness(),
  );
  const { data, loading, error, refresh } = useQueryView(result);
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
      {error && (
        <>
          <small role="alert">{error}</small>
          <button
            type="button"
            className="button small secondary"
            onClick={refresh}
          >
            Retry options
          </button>
        </>
      )}
    </>
  );
}
export function FormField({
  field,
  row,
  disabled,
}: {
  field: Field;
  row: DataRow;
  disabled?: boolean;
}) {
  const value = fieldValue(row, field);
  if (field.type === "password")
    return (
      <PasswordField
        name={field.name}
        label={`${field.label}${field.required ? " *" : ""}`}
        autoComplete="new-password"
        hint={field.hint}
        minLength={field.minLength}
        maxLength={field.maxLength}
        disabled={disabled}
      />
    );
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
            <option
              key={option}
              value={option}
              disabled={field.disabledOptions?.includes(option)}
            >
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
export function AdminResource({
  resource,
  canCreateEmployees = false,
  canDeleteEmployees = false,
  canEditPublicProfiles = false,
  currentUserId,
}: {
  resource: ManagementResource;
  canCreateEmployees?: boolean;
  canDeleteEmployees?: boolean;
  canEditPublicProfiles?: boolean;
  currentUserId?: string;
}) {
  const config = resourceConfigs[resource];
  const { params, update } = useUrlFilters();
  const query = params.get("q") || "";
  const search = useDebouncedValue(query);
  const page = pageFromSearch(params.get("page"));
  function setPage(next: number) {
    update({ page: next });
  }
  const [editing, setEditing] = useState<DataRow | null>(null);
  const [viewing, setViewing] = useState<DataRow | null>(null);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const dialogPending = useRef(false);
  const [confirming, setConfirming] = useState(false);
  const [needsReconcile, setNeedsReconcile] = useState(false);
  const [actionError, setActionError] = useState("");
  const [message, setMessage] = useState("");
  const [deletedRecords, setDeletedRecords] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const result = useGetManagementQuery(
    { resource, params: { page, pageSize: 25, q: search } },
    useFreshness(),
  );
  const view = useQueryView(result);
  const searching = query !== search;
  const data = searching ? undefined : view.data;
  const loadedRows = items(data);
  // A confirmed deletion stays removed even if the invalidated list fails to
  // refresh and RTK Query retains its previous data.
  const rows = loadedRows.filter(
    (row) => !deletedRecords.has(`${resource}:${row.id}`),
  );
  const total = Math.max(
    0,
    (data?.total || 0) - (loadedRows.length - rows.length),
  );
  const loading = searching || view.loading;
  const { error, refresh, isFetching } = view;
  const [writeManagement] = useWriteManagementMutation();
  const dispatch = useAppDispatch();
  const [loadOfficeDefaults] = useLazyGetOfficeDefaultsQuery();
  async function refreshResource() {
    try {
      await refresh().unwrap();
      setNeedsReconcile(false);
    } catch {
      // A failed read cannot establish the outcome of an interrupted write.
    }
  }
  if (!config) return null;
  const canCreate =
    !config.readOnly &&
    !config.noCreate &&
    (resource !== "employees" || canCreateEmployees);
  const editingOwnAccount =
    resource === "users" &&
    Boolean(currentUserId) &&
    editing?.id === currentUserId;
  const fields = config.fields
    .filter((field) =>
      editing?.id ? field.edit !== false : field.create !== false,
    )
    .filter(
      (field) =>
        resource !== "employees" ||
        !editing?.id ||
        field.name !== "role" ||
        ["EMPLOYEE", "MANAGE_DRIVER"].includes(
          String(nested(editing, "user.role")),
        ),
    )
    .filter(
      (field) =>
        resource !== "employees" ||
        !editing?.id ||
        canEditPublicProfiles ||
        field.name !== "name",
    )
    .filter(
      (field) => !editingOwnAccount || !["role", "status"].includes(field.name),
    )
    .map((field) =>
      resource === "users" &&
      editing?.id &&
      !editing.employee &&
      field.name === "role"
        ? {
            ...field,
            disabledOptions: ["EMPLOYEE", "MANAGE_DRIVER"],
            hint: "Employee and Manage Driver roles require an employee profile. This account does not have one.",
          }
        : field,
    );
  async function mutate(
    id: string | null,
    payload: JsonRecord,
    method: "PATCH" | "POST" | "DELETE" = id ? "PATCH" : "POST",
  ) {
    if (
      submitting.current ||
      needsReconcile ||
      isFetching ||
      (method === "POST" && !canCreate) ||
      (resource === "employees" &&
        method === "DELETE" &&
        !canDeleteEmployees) ||
      (resource === "users" && method === "DELETE" && id === currentUserId)
    )
      return;
    submitting.current = true;
    setBusy(true);
    setActionError("");
    setMessage("");
    try {
      if (resource === "employees" && method === "POST") {
        // Credentials must not enter Redux mutation arguments or DevTools.
        const controller = new AbortController();
        const timeout = setTimeout(
          () =>
            controller.abort(
              new ClientRequestError(normalizeError("TIMEOUT_ERROR")),
            ),
          30_000,
        );
        try {
          await api("/api/admin/employees", {
            method: "POST",
            body: JSON.stringify(payload),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeout);
        }
        dispatch(
          baseApi.util.invalidateTags(managementInvalidation({ resource })),
        );
      } else {
        await writeManagement({
          resource,
          id: id || undefined,
          method,
          body: payload,
        }).unwrap();
      }
      if (method === "DELETE" && id)
        setDeletedRecords((previous) =>
          new Set(previous).add(`${resource}:${id}`),
        );
      setEditing(null);
      setMessage(
        resource === "employees" && method === "DELETE"
          ? "Employee and sign-in account permanently deleted."
          : resource === "users" && method === "DELETE"
            ? "User account permanently deleted."
            : "Your changes have been saved.",
      );
    } catch (error) {
      setActionError(errorMessage(error));
      if (isAmbiguousWrite(error)) {
        setNeedsReconcile(true);
        await refreshResource();
      }
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  async function openNew() {
    if (
      dialogPending.current ||
      submitting.current ||
      needsReconcile ||
      isFetching ||
      !canCreate
    )
      return;
    setActionError("");
    if (resource !== "offices") {
      setEditing({});
      return;
    }
    setBusy(true);
    try {
      const defaults = await loadOfficeDefaults().unwrap();
      setEditing(defaults);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  async function withActionDialog(action: () => Promise<void>) {
    if (
      dialogPending.current ||
      submitting.current ||
      needsReconcile ||
      isFetching
    )
      return;
    dialogPending.current = true;
    setConfirming(true);
    try {
      await action();
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      dialogPending.current = false;
      setConfirming(false);
    }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || needsReconcile || isFetching) return;
    const element = event.currentTarget;
    const form = new FormData(element);
    const creatingEmployee = resource === "employees" && !editing?.id;
    if (creatingEmployee) {
      if (!canCreate) return;
      const passwordError = validateNewPassword(
        String(form.get("password") || ""),
        String(form.get("confirmPassword") || ""),
      );
      if (passwordError) {
        setActionError(passwordError);
        return;
      }
    }
    const payload: JsonRecord = {};
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
                : String(value ?? "");
    }
    await mutate(editing?.id ? String(editing.id) : null, payload);
    if (creatingEmployee)
      for (const name of ["password", "confirmPassword"]) {
        const input = element.elements.namedItem(name);
        if (input instanceof HTMLInputElement) input.value = "";
      }
  }
  return (
    <>
      <PageHeader
        eyebrow="WORKSPACE MANAGEMENT"
        title={config.title}
        description={config.description}
        action={
          canCreate ? (
            <button
              disabled={busy || confirming || needsReconcile || isFetching}
              className="button"
              onClick={openNew}
            >
              <Plus size={16} />
              Add {config.singular}
            </button>
          ) : undefined
        }
      />
      <ErrorNotice message={error || (!editing ? actionError : "")} />
      {needsReconcile && !editing && (
        <Notice>
          Refresh these records successfully before trying another change.
        </Notice>
      )}
      {message && (
        <Notice notify>
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
                update({ q: event.target.value || null, page: null });
              }}
            />
          </div>
          <div className="buttons">
            <span className="muted" role="status" style={{ fontSize: 11 }}>
              {isFetching && data ? "Refreshing…" : `${total} records`}
            </span>
            <Refresh onClick={() => void refreshResource()} />
          </div>
        </div>
        {loading ? (
          <Loading />
        ) : (
          <Table
            rows={rows}
            columns={config.columns}
            actions={(row) => (
              <div className="row-actions">
                {resource === "devices" ? (
                  <>
                    {!row.revokedAt && !row.approved && (
                      <button
                        disabled={
                          busy || confirming || needsReconcile || isFetching
                        }
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
                        disabled={
                          busy || confirming || needsReconcile || isFetching
                        }
                        className="button small secondary"
                        onClick={() =>
                          void withActionDialog(async () => {
                            if (
                              await confirmAction({
                                title: "Revoke device?",
                                text: "It will no longer verify attendance.",
                                confirmText: "Revoke device",
                                danger: true,
                              })
                            )
                              await mutate(String(row.id), { revoked: true });
                          })
                        }
                      >
                        Revoke
                      </button>
                    )}
                  </>
                ) : resource === "leaves" ? (
                  <>
                    {row.status === "PENDING" && row.employee !== null && (
                      <>
                        <button
                          disabled={
                            busy || confirming || needsReconcile || isFetching
                          }
                          className="button small"
                          onClick={() =>
                            void withActionDialog(async () => {
                              const reviewNote = await promptAction({
                                title: "Approve leave?",
                                inputLabel: "Review note (optional)",
                                initialValue: "",
                                confirmText: "Approve leave",
                                maxLength: 1000,
                              });
                              if (reviewNote !== null)
                                await mutate(String(row.id), {
                                  status: "APPROVED",
                                  reviewNote,
                                });
                            })
                          }
                        >
                          Approve
                        </button>
                        <button
                          disabled={
                            busy || confirming || needsReconcile || isFetching
                          }
                          className="button small secondary"
                          onClick={() =>
                            void withActionDialog(async () => {
                              const reviewNote = await promptAction({
                                title: "Decline leave?",
                                inputLabel: "Review note (optional)",
                                initialValue: "",
                                confirmText: "Decline leave",
                                maxLength: 1000,
                              });
                              if (reviewNote !== null)
                                await mutate(String(row.id), {
                                  status: "REJECTED",
                                  reviewNote,
                                });
                            })
                          }
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
                    <PublicProfileLink resource={resource} row={row} />
                    {canEditPublicProfiles && (
                      <EditPublicProfileLink resource={resource} row={row} />
                    )}
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
                      disabled={
                        busy ||
                        confirming ||
                        needsReconcile ||
                        isFetching ||
                        (resource === "assignments" && row.employee === null)
                      }
                      className="icon-button"
                      onClick={() => {
                        setEditing(row);
                        setActionError("");
                      }}
                    >
                      <Pencil size={15} />
                    </button>
                    {(resource === "employees"
                      ? canDeleteEmployees &&
                        ["EMPLOYEE", "MANAGE_DRIVER"].includes(
                          String(nested(row, "user.role")),
                        )
                      : !config.noDelete &&
                        (resource !== "users" || row.id !== currentUserId)) && (
                      <button
                        disabled={
                          busy || confirming || needsReconcile || isFetching
                        }
                        aria-label={`Delete ${config.singular}`}
                        className="icon-button"
                        onClick={() =>
                          void withActionDialog(async () => {
                            if (
                              await confirmAction({
                                title: `Delete ${config.singular}?`,
                                text:
                                  resource === "employees"
                                    ? "Permanently delete this employee and their sign-in account? This cannot be undone. Related records will be kept with the employee’s details replaced by “deleted info”."
                                    : resource === "users"
                                      ? "Permanently delete this user account? This cannot be undone. Related records will be kept with the user’s details replaced by “deleted info”."
                                      : `Delete this ${config.singular}? Existing references may prevent deletion.`,
                                confirmText: `Delete ${config.singular}`,
                                danger: true,
                              })
                            )
                              await mutate(String(row.id), {}, "DELETE");
                          })
                        }
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
            Page {page} · {total} total records
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
              disabled={page * 25 >= total || loading}
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
            {resource === "users" && (
              <p className="muted">{String(editing.email || "")}</p>
            )}
            {editingOwnAccount && (
              <Notice>
                You can edit your name. Your own role and account status cannot
                be changed here.
              </Notice>
            )}
            {resource === "employees" &&
              Boolean(editing.id) &&
              !canEditPublicProfiles && (
                <p className="muted">
                  {String(nested(editing, "user.name") || "Employee")} · Only
                  Super Admin can change the name and public profile details.
                </p>
              )}
            {needsReconcile && (
              <>
                <Notice>
                  The result is uncertain. Refresh these records before another
                  change.
                </Notice>
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => void refreshResource()}
                >
                  Refresh records
                </button>
              </>
            )}
            <div className="form-grid">
              {fields.map((field) => (
                <FormField
                  key={field.name}
                  field={field}
                  row={editing}
                  disabled={busy}
                />
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
              <button
                disabled={busy || confirming || needsReconcile || isFetching}
                type="submit"
                className="button"
              >
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
