"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations, useLocale } from "next-intl";
import { useMemo, useRef, useState, type FormEvent } from "react";
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
  UserRoundPlus,
  UserCog,
  UserRoundPen,
} from "lucide-react";
import {
  date,
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
import { normalizeError } from "@/store/api/errors";
import { useErrorMessage } from "@/i18n/errors";
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
import {
  adminOptionLabel,
  auditValueLabel,
  fieldValue,
  getResourceConfigs,
  type Field,
} from "./resource-config";
import { PasswordField, validateNewPassword } from "./auth/password-fields";

function PublicProfileLink({
  resource,
  row,
}: {
  resource: string;
  row: DataRow;
}) {
  const t = useTranslations("admin");
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
      title={t("resources.viewPublicProfile")}
      aria-label={t("resources.viewPublicProfile")}
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
  const t = useTranslations("admin");
  if (resource !== "employees" && resource !== "users") return null;
  const id = resource === "employees" ? nested(row, "user.id") : row.id;
  if (typeof id !== "string" || !id) return null;
  return (
    <Link
      href={`/admin/users/${encodeURIComponent(id)}/profile`}
      prefetch={false}
      title={t("resources.editPublicProfile")}
      aria-label={t("resources.editPublicProfile")}
      className="icon-button"
    >
      <UserRoundPen size={16} />
    </Link>
  );
}

function ReferenceField({ field, value }: { field: Field; value: string }) {
  const t = useTranslations("admin");
  const locale = useLocale();
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
        aria-label={t("resources.findField", {
          field: field.label.toLowerCase(),
        })}
        placeholder={t("resources.searchField", {
          field: field.label.toLowerCase(),
        })}
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
          {loading
            ? t("resources.loadingOptions")
            : t("resources.selectField", { field: field.label.toLowerCase() })}
        </option>
        {selection && !rows.some((row) => row.id === selection) && (
          <option value={selection}>{t("resources.currentSelection")}</option>
        )}
        {rows.map((row) => (
          <option key={String(row.id)} value={String(row.id)}>
            {label(
              nested(row, "user.name") || row.name || row.employeeCode,
              locale,
            )}
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
            {t("resources.previousOptions")}
          </button>
          <button
            type="button"
            className="button small secondary"
            disabled={loading || page * 100 >= (data?.total || 0)}
            onClick={() => setPagination({ query: search, page: page + 1 })}
          >
            {t("resources.nextOptions")}
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
            {t("resources.retryOptions")}
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
  const t = useTranslations("admin");
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
          {(["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const).map(
            (day, index) => (
              <label className="field-checkbox" key={day}>
                <input
                  name={field.name}
                  value={index}
                  type="checkbox"
                  defaultChecked={Array.isArray(value) && value.includes(index)}
                />
                {t(`days.${day}`)}
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
              {adminOptionLabel(t, option)}
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
  canManageUsers = false,
  currentUserId,
}: {
  resource: ManagementResource;
  canCreateEmployees?: boolean;
  canDeleteEmployees?: boolean;
  canEditPublicProfiles?: boolean;
  canManageUsers?: boolean;
  currentUserId?: string;
}) {
  const t = useTranslations("admin");
  const locale = useLocale();
  const router = useRouter();
  const configs = useMemo(() => getResourceConfigs(t), [t]);
  const config = configs[resource];
  const errorMessage = useErrorMessage();
  const { params, update } = useUrlFilters();
  const query = params.get("q") || "";
  const search = useDebouncedValue(query);
  const page = pageFromSearch(params.get("page"));
  function setPage(next: number) {
    update({ page: next });
  }
  const [editing, setEditing] = useState<DataRow | null>(null);
  const [editingResource, setEditingResource] =
    useState<ManagementResource>(resource);
  const [addingEmployeeProfile, setAddingEmployeeProfile] = useState(false);
  const [employeePasswordEnabled, setEmployeePasswordEnabled] = useState(false);
  const [viewing, setViewing] = useState<DataRow | null>(null);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const pendingEmployeeProfileUserId = useRef<string | null>(null);
  const dialogPending = useRef(false);
  const [confirming, setConfirming] = useState(false);
  const [needsReconcile, setNeedsReconcile] = useState(false);
  const [actionError, setActionError] = useState("");
  const [message, setMessage] = useState<
    | ""
    | "resources.employeeDeleted"
    | "resources.userDeleted"
    | "resources.saved"
  >("");
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
      const profileUserId = pendingEmployeeProfileUserId.current;
      if (profileUserId) {
        // Adding an employee ID can move this account to another search page.
        // Reconcile the account directly before enabling another write.
        const account = await api<DataRow>(
          `/api/admin/users/${encodeURIComponent(profileUserId)}`,
          { signal: AbortSignal.timeout(30_000) },
        );
        if (account.employee) {
          dispatch(
            baseApi.util.invalidateTags(
              managementInvalidation({ resource: "employees" }),
            ),
          );
          setEditing(null);
          setAddingEmployeeProfile(false);
          setActionError("");
          setMessage("resources.saved");
          if (profileUserId === currentUserId) router.refresh();
        }
        pendingEmployeeProfileUserId.current = null;
      }
      setNeedsReconcile(false);
    } catch {
      // A failed read cannot establish the outcome of an interrupted write.
    }
  }
  if (!config) return null;
  const editingConfig = configs[editingResource];
  const canCreate =
    !config.readOnly &&
    !config.noCreate &&
    (resource !== "employees" || canCreateEmployees);
  const editingOwnAccount =
    Boolean(currentUserId) &&
    (editingResource === "users"
      ? editing?.id === currentUserId
      : editingResource === "employees" &&
        nested(editing ?? {}, "user.id") === currentUserId);
  const fields = editingConfig.fields
    .filter(
      (field) =>
        !addingEmployeeProfile ||
        ["employeeCode", "officeId", "departmentId"].includes(field.name),
    )
    .filter((field) =>
      editing?.id ? field.edit !== false : field.create !== false,
    )
    .filter(
      (field) =>
        editingResource !== "employees" ||
        field.type !== "password" ||
        employeePasswordEnabled,
    )
    .filter(
      (field) =>
        editingResource !== "employees" ||
        !editing?.id ||
        field.name !== "role" ||
        ["EMPLOYEE", "MANAGE_DRIVER"].includes(
          String(nested(editing, "user.role")),
        ),
    )
    .filter(
      (field) =>
        editingResource !== "employees" ||
        !editing?.id ||
        canEditPublicProfiles ||
        field.name !== "name",
    )
    .filter(
      (field) => !editingOwnAccount || !["role", "status"].includes(field.name),
    )
    .map((field) =>
      editingResource === "users" &&
      editing?.id &&
      !editing.employee &&
      field.name === "role"
        ? {
            ...field,
            disabledOptions: ["EMPLOYEE", "MANAGE_DRIVER"],
            hint: t("resources.employeeProfileRequired"),
          }
        : editingResource === "employees" && field.name === "role"
          ? {
              ...field,
              options: editing?.id
                ? ["EMPLOYEE", "MANAGE_DRIVER"]
                : field.options,
              hint: t(
                editing?.id
                  ? "fields.driverRoleHint"
                  : "fields.employeeRoleHint",
              ),
            }
          : field,
    );
  async function mutate(
    id: string | null,
    payload: JsonRecord,
    method: "PATCH" | "POST" | "DELETE" = id ? "PATCH" : "POST",
    targetResource: ManagementResource = resource,
    directoryRowId: string | null = id,
    employeeProfileUserId?: string,
  ) {
    if (
      submitting.current ||
      needsReconcile ||
      isFetching ||
      (resource === "employees" &&
        targetResource === "users" &&
        !canManageUsers) ||
      (employeeProfileUserId &&
        (resource !== "employees" || !canManageUsers)) ||
      (method === "POST" && !employeeProfileUserId && !canCreate) ||
      (targetResource === "employees" &&
        method === "DELETE" &&
        !canDeleteEmployees) ||
      (targetResource === "users" &&
        method === "DELETE" &&
        id === currentUserId)
    )
      return;
    submitting.current = true;
    setBusy(true);
    setActionError("");
    setMessage("");
    try {
      if (targetResource === "employees" && method === "POST") {
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
          await api(
            employeeProfileUserId
              ? `/api/admin/users/${encodeURIComponent(employeeProfileUserId)}/employee-profile`
              : "/api/admin/employees",
            {
              method: "POST",
              body: JSON.stringify(payload),
              signal: controller.signal,
            },
          );
        } finally {
          clearTimeout(timeout);
        }
        dispatch(
          baseApi.util.invalidateTags(managementInvalidation({ resource })),
        );
      } else {
        await writeManagement({
          resource: targetResource,
          id: id || undefined,
          method,
          body: payload,
        }).unwrap();
      }
      if (method === "DELETE" && directoryRowId)
        setDeletedRecords((previous) =>
          new Set(previous).add(`${resource}:${directoryRowId}`),
        );
      setEditing(null);
      setAddingEmployeeProfile(false);
      if (employeeProfileUserId === currentUserId && employeeProfileUserId)
        router.refresh();
      setMessage(
        targetResource === "employees" && method === "DELETE"
          ? "resources.employeeDeleted"
          : targetResource === "users" && method === "DELETE"
            ? "resources.userDeleted"
            : "resources.saved",
      );
    } catch (error) {
      setActionError(errorMessage(error));
      if (isAmbiguousWrite(error)) {
        pendingEmployeeProfileUserId.current = employeeProfileUserId ?? null;
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
    setEditingResource(resource);
    setAddingEmployeeProfile(false);
    setEmployeePasswordEnabled(false);
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
    const creatingEmployee =
      editingResource === "employees" && !editing?.id && !addingEmployeeProfile;
    if (addingEmployeeProfile && !canManageUsers) return;
    if (creatingEmployee) {
      if (!canCreate) return;
      if (employeePasswordEnabled) {
        const passwordError = validateNewPassword(
          String(form.get("password") || ""),
          String(form.get("confirmPassword") || ""),
        );
        if (passwordError) {
          setActionError(passwordError);
          return;
        }
      }
    }
    const payload: JsonRecord = {};
    for (const field of fields) {
      const value = form.get(field.name);
      // Accounts missing employment data may already have an employee role.
      // Preserve that role when its disabled option is left selected; the
      // account's name and status can still be edited independently.
      if (
        editingResource === "users" &&
        field.name === "role" &&
        field.disabledOptions?.includes(String(editing?.role)) &&
        (value === null || value === editing?.role)
      )
        continue;
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
    await mutate(
      !addingEmployeeProfile && editing?.id ? String(editing.id) : null,
      payload,
      !addingEmployeeProfile && editing?.id ? "PATCH" : "POST",
      editingResource,
      editing?.id ? String(editing.id) : null,
      addingEmployeeProfile
        ? String(nested(editing ?? {}, "user.id"))
        : undefined,
    );
    if (creatingEmployee)
      for (const name of ["password", "confirmPassword"]) {
        const input = element.elements.namedItem(name);
        if (input instanceof HTMLInputElement) input.value = "";
      }
  }
  return (
    <>
      <PageHeader
        eyebrow={t("resources.eyebrow")}
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
              {t("resources.add", { resource: config.singular })}
            </button>
          ) : undefined
        }
      />
      <ErrorNotice message={error || (!editing ? actionError : "")} />
      {needsReconcile && !editing && (
        <Notice>{t("resources.refreshBeforeChange")}</Notice>
      )}
      {message && (
        <Notice notify>
          <Check size={16} />
          {t(message)}
        </Notice>
      )}
      <section className="card">
        <div className="toolbar">
          <div className="search-field">
            <Search size={16} />
            <input
              aria-label={t("resources.searchLabel", {
                resource: config.title.toLowerCase(),
              })}
              placeholder={t("resources.searchPlaceholder", {
                resource: config.title.toLowerCase(),
              })}
              value={query}
              onChange={(event) => {
                update({ q: event.target.value || null, page: null });
              }}
            />
          </div>
          <div className="buttons">
            <span className="muted" role="status" style={{ fontSize: 11 }}>
              {isFetching && data
                ? t("common.refreshing")
                : t("common.records", { count: total })}
            </span>
            <Refresh onClick={() => void refreshResource()} />
          </div>
        </div>
        {loading ? (
          <Loading />
        ) : (
          <Table
            rows={rows}
            columns={config.columns.map((column) =>
              resource === "events" && column.key === "reason"
                ? {
                    ...column,
                    render: (value, row) =>
                      typeof row.type === "string" &&
                      row.type.endsWith("_REJECTED") &&
                      value
                        ? errorMessage({ code: String(value) })
                        : label(value, locale),
                  }
                : column,
            )}
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
                        {t("common.approve")}
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
                                title: t("resources.revokeDeviceTitle"),
                                text: t("resources.revokeDeviceDescription"),
                                confirmText: t("resources.revokeDevice"),
                                danger: true,
                              })
                            )
                              await mutate(String(row.id), { revoked: true });
                          })
                        }
                      >
                        {t("common.revoke")}
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
                                title: t("resources.approveLeaveTitle"),
                                inputLabel: t("resources.reviewNote"),
                                initialValue: "",
                                confirmText: t("resources.approveLeave"),
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
                          {t("common.approve")}
                        </button>
                        <button
                          disabled={
                            busy || confirming || needsReconcile || isFetching
                          }
                          className="button small secondary"
                          onClick={() =>
                            void withActionDialog(async () => {
                              const reviewNote = await promptAction({
                                title: t("resources.declineLeaveTitle"),
                                inputLabel: t("resources.reviewNote"),
                                initialValue: "",
                                confirmText: t("resources.declineLeave"),
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
                          {t("common.decline")}
                        </button>
                      </>
                    )}
                  </>
                ) : config.readOnly ? (
                  <button
                    aria-label={t("resources.viewAuditEntry")}
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
                    {resource === "employees" &&
                      row.hasEmployeeProfile !== false && (
                        <Link
                          title={t("resources.viewEmployeeAttendance")}
                          aria-label={t("resources.viewEmployeeAttendance")}
                          className="icon-button"
                          href={`/admin/attendance?employeeId=${encodeURIComponent(String(row.id))}`}
                        >
                          <Eye size={16} />
                        </Link>
                      )}
                    {resource === "employees" &&
                      canManageUsers &&
                      row.hasEmployeeProfile === false &&
                      typeof nested(row, "user.id") === "string" && (
                        <button
                          title={t("resources.addEmployeeProfile")}
                          aria-label={t("resources.addEmployeeProfile")}
                          disabled={
                            busy || confirming || needsReconcile || isFetching
                          }
                          className="icon-button"
                          onClick={() => {
                            setEditingResource("employees");
                            setAddingEmployeeProfile(true);
                            setEmployeePasswordEnabled(false);
                            setEditing(row);
                            setActionError("");
                          }}
                        >
                          <UserRoundPlus size={16} />
                        </button>
                      )}
                    {resource === "employees" &&
                      canManageUsers &&
                      typeof nested(row, "user.id") === "string" && (
                        <button
                          title={t("resources.manageUserAccount")}
                          aria-label={t("resources.manageUserAccount")}
                          disabled={
                            busy || confirming || needsReconcile || isFetching
                          }
                          className="icon-button"
                          onClick={() => {
                            setEditingResource("users");
                            setAddingEmployeeProfile(false);
                            setEditing({
                              ...(row.user as DataRow),
                              employee:
                                row.hasEmployeeProfile !== false
                                  ? { id: row.id }
                                  : null,
                            });
                            setActionError("");
                          }}
                        >
                          <UserCog size={16} />
                        </button>
                      )}
                    {(resource !== "employees" ||
                      (row.hasEmployeeProfile !== false &&
                        (canEditPublicProfiles ||
                          !["ADMIN", "SUPER_ADMIN"].includes(
                            String(nested(row, "user.role")),
                          )))) && (
                      <button
                        aria-label={t("resources.edit", {
                          resource: config.singular,
                        })}
                        disabled={
                          busy ||
                          confirming ||
                          needsReconcile ||
                          isFetching ||
                          (resource === "assignments" && row.employee === null)
                        }
                        className="icon-button"
                        onClick={() => {
                          setEditingResource(resource);
                          setAddingEmployeeProfile(false);
                          setEditing(row);
                          setActionError("");
                        }}
                      >
                        <Pencil size={15} />
                      </button>
                    )}
                    {(resource === "employees"
                      ? canManageUsers
                        ? typeof nested(row, "user.id") === "string" &&
                          nested(row, "user.id") !== currentUserId
                        : row.hasEmployeeProfile !== false &&
                          canDeleteEmployees &&
                          ["EMPLOYEE", "MANAGE_DRIVER"].includes(
                            String(nested(row, "user.role")),
                          )
                      : !config.noDelete &&
                        (resource !== "users" || row.id !== currentUserId)) && (
                      <button
                        disabled={
                          busy || confirming || needsReconcile || isFetching
                        }
                        aria-label={t("resources.delete", {
                          resource:
                            resource === "employees" && canManageUsers
                              ? configs.users.singular
                              : config.singular,
                        })}
                        className="icon-button"
                        onClick={() =>
                          void withActionDialog(async () => {
                            const deletingDirectoryAccount =
                              resource === "employees" && canManageUsers;
                            const deleteResource = deletingDirectoryAccount
                              ? "users"
                              : resource;
                            const deleteSingular =
                              configs[deleteResource].singular;
                            if (
                              await confirmAction({
                                title: t("resources.deleteTitle", {
                                  resource: deleteSingular,
                                }),
                                text:
                                  deleteResource === "employees"
                                    ? t("resources.deleteEmployeeDescription")
                                    : deleteResource === "users"
                                      ? t("resources.deleteUserDescription")
                                      : t("resources.deleteDescription", {
                                          resource: config.singular,
                                        }),
                                confirmText: t("resources.delete", {
                                  resource: deleteSingular,
                                }),
                                danger: true,
                              })
                            )
                              await mutate(
                                String(
                                  deletingDirectoryAccount
                                    ? nested(row, "user.id")
                                    : row.id,
                                ),
                                {},
                                "DELETE",
                                deleteResource,
                                String(row.id),
                              );
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
          <span>{t("resources.page", { page, count: total })}</span>
          <div className="buttons">
            <button
              className="button small secondary"
              disabled={page <= 1 || loading}
              onClick={() => setPage(page - 1)}
            >
              <ArrowLeft size={13} />
              {t("common.previous")}
            </button>
            <button
              className="button small secondary"
              disabled={page * 25 >= total || loading}
              onClick={() => setPage(page + 1)}
            >
              {t("common.next")}
              <ArrowRight size={13} />
            </button>
          </div>
        </div>
      </section>
      {editing && (
        <Modal
          title={
            addingEmployeeProfile
              ? t("resources.addEmployeeProfile")
              : resource === "employees" && editingResource === "users"
                ? t("resources.manageUserAccount")
                : t(editing.id ? "resources.edit" : "resources.add", {
                    resource: editingConfig.singular,
                  })
          }
          close={() => {
            if (!busy) {
              setEditing(null);
              setAddingEmployeeProfile(false);
            }
          }}
        >
          <form onSubmit={submit}>
            <ErrorNotice message={actionError} />
            {editingResource === "users" && (
              <p className="muted">{String(editing.email || "")}</p>
            )}
            {addingEmployeeProfile && (
              <>
                <p className="muted">
                  {label(nested(editing, "user.name"), locale)} ·{" "}
                  {label(nested(editing, "user.email"), locale)}
                </p>
                <Notice>{t("resources.addEmployeeProfileHint")}</Notice>
              </>
            )}
            {editingOwnAccount && !addingEmployeeProfile && (
              <Notice>{t("resources.ownAccountHint")}</Notice>
            )}
            {editingResource === "employees" &&
              Boolean(editing.id) &&
              !addingEmployeeProfile &&
              !canEditPublicProfiles && (
                <p className="muted">
                  {t("resources.profileRestricted", {
                    name: String(
                      nested(editing, "user.name") || t("labels.employee"),
                    ),
                  })}
                </p>
              )}
            {needsReconcile && (
              <>
                <Notice>{t("resources.uncertainChange")}</Notice>
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => void refreshResource()}
                >
                  {t("resources.refreshRecords")}
                </button>
              </>
            )}
            <div className="form-grid">
              {editingResource === "employees" && !editing.id && (
                <div className="field full">
                  <label className="field-checkbox">
                    <input
                      id="employee-password-enabled"
                      type="checkbox"
                      checked={employeePasswordEnabled}
                      disabled={busy}
                      onChange={(event) => {
                        setEmployeePasswordEnabled(event.target.checked);
                        setActionError("");
                      }}
                    />
                    {t("labels.setApplicationPassword")}
                  </label>
                </div>
              )}
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
                onClick={() => {
                  setEditing(null);
                  setAddingEmployeeProfile(false);
                }}
              >
                {t("common.cancel")}
              </button>
              <button
                disabled={busy || confirming || needsReconcile || isFetching}
                type="submit"
                className="button"
              >
                {busy ? t("common.saving") : t("common.saveChanges")}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {viewing && (
        <Modal title={t("resources.auditEntry")} close={() => setViewing(null)}>
          <dl className="detail-list">
            {(["action", "resource", "resourceId", "createdAt"] as const).map(
              (key) => (
                <div className="detail-item" key={key}>
                  <dt>{t(`audit.${key}`)}</dt>
                  <dd>
                    {key === "createdAt"
                      ? date(viewing[key], locale)
                      : key === "action" || key === "resource"
                        ? auditValueLabel(t, viewing[key])
                        : label(viewing[key], locale)}
                  </dd>
                </div>
              ),
            )}
          </dl>
          <h3 style={{ margin: "25px 0 10px" }}>
            {t("resources.previousState")}
          </h3>
          <pre className="json-detail">
            {JSON.stringify(viewing.previousState, null, 2)}
          </pre>
          <h3 style={{ margin: "20px 0 10px" }}>{t("resources.newState")}</h3>
          <pre className="json-detail">
            {JSON.stringify(viewing.newState, null, 2)}
          </pre>
        </Modal>
      )}
    </>
  );
}
