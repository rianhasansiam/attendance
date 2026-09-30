"use client";

import { useTranslations } from "next-intl";
import { useEmployeeError, useEmployeeMessage } from "./employee-feedback";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { ErrorNotice, Notice, PageHeader } from "@/components/ui";
import { api, ClientRequestError } from "@/lib/client/request";
import { isAmbiguousWrite } from "@/lib/client/attendance-ceremony";
import {
  bloodGroups,
  publicProfileUpdateSchema,
} from "@/modules/public-profile/validation";
import type { ManagedPublicProfile } from "@/modules/public-profile/management";
import { normalizeError } from "@/store/api/errors";
import { baseApi } from "@/store/api/base-api";
import { managementInvalidation } from "@/store/features/management/api";
import { useAppDispatch } from "@/store/hooks";

export function PublicProfileEditor({
  profile,
  isOwnProfile = false,
}: {
  profile: ManagedPublicProfile;
  isOwnProfile?: boolean;
}) {
  const t = useTranslations("employee");
  const router = useRouter();
  const title = t(
    isOwnProfile ? "publicProfile.editOwnTitle" : "publicProfile.editTitle",
  );
  const [savedProfile, setSavedProfile] = useState(profile);
  const [revision, setRevision] = useState(0);
  const [pending, setPending] = useState(false);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [error, setError] = useEmployeeError();
  const [message, setMessage] = useEmployeeMessage();
  const submitting = useRef(false);
  const dispatch = useAppDispatch();
  const endpoint = `/api/admin/users/${encodeURIComponent(profile.id)}/public-profile`;

  async function request<T>(init?: RequestInit) {
    const controller = new AbortController();
    const timeout = setTimeout(
      () =>
        controller.abort(
          new ClientRequestError(normalizeError("TIMEOUT_ERROR")),
        ),
      30_000,
    );
    try {
      return await api<T>(endpoint, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  async function refreshProfile() {
    if (submitting.current) return;
    submitting.current = true;
    setPending(true);
    setError("");
    try {
      const current = await request<ManagedPublicProfile>();
      setSavedProfile(current);
      setRevision((value) => value + 1);
      setNeedsRefresh(false);
      setMessage("publicProfile.loaded");
    } catch (error) {
      setError(error);
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || needsRefresh) return;
    const values = new FormData(event.currentTarget);
    const parsed = publicProfileUpdateSchema.safeParse({
      name: values.get("name"),
      designation: values.get("designation"),
      phone: values.get("phone"),
      bloodGroup: values.get("bloodGroup"),
      publicDepartment: values.get("publicDepartment"),
      homeAddress: values.get("homeAddress"),
      dateOfBirth: values.get("dateOfBirth"),
    });
    setMessage("");
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = issue?.path[0];
      const fields = {
        name: "publicProfile.name",
        designation: "publicProfile.designation",
        phone: "publicProfile.phone",
        bloodGroup: "publicProfile.bloodGroup",
        publicDepartment: "profile.department",
        homeAddress: "publicProfile.address",
        dateOfBirth: "publicProfile.birthday",
      } as const;
      setError(
        issue?.message === "Enter a valid date of birth."
          ? { key: "publicProfile.invalidBirthday" }
          : issue?.message === "Date of birth cannot be in the future."
            ? { key: "publicProfile.futureBirthday" }
            : issue?.code === "too_small" && field === "name"
              ? { key: "publicProfile.requiredName" }
              : issue?.code === "too_big" &&
                  typeof field === "string" &&
                  field in fields
                ? {
                    key: "publicProfile.tooLong",
                    values: {
                      maximum: Number(issue.maximum),
                    },
                    translatedValues: {
                      field: fields[field as keyof typeof fields],
                    },
                  }
                : { key: "publicProfile.invalid" },
      );
      return;
    }
    submitting.current = true;
    setPending(true);
    setError("");
    try {
      const saved = await request<ManagedPublicProfile>({
        method: "PATCH",
        body: JSON.stringify(parsed.data),
      });
      setSavedProfile(saved);
      setRevision((value) => value + 1);
      dispatch(
        baseApi.util.invalidateTags(
          managementInvalidation({ resource: "users", id: profile.id }),
        ),
      );
      setMessage("publicProfile.saved");
      if (isOwnProfile) router.refresh();
    } catch (error) {
      setError(error);
      if (isAmbiguousWrite(error)) setNeedsRefresh(true);
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  return (
    <>
      <PageHeader
        eyebrow={t("publicProfile.eyebrow")}
        title={title}
        description={
          isOwnProfile
            ? t("publicProfile.editOwnDescription")
            : t("publicProfile.editDescription", {
                name: savedProfile.name || t("publicProfile.thisUser"),
              })
        }
        action={
          <Link
            className="button secondary"
            href={`/profile/${encodeURIComponent(savedProfile.profileSlug)}`}
            prefetch={false}
            target="_blank"
            rel="noopener noreferrer"
          >
            <ExternalLink size={16} /> {t("publicProfile.view")}
          </Link>
        }
      />
      <section className="card" style={{ padding: 24, maxWidth: 900 }}>
        <form
          key={revision}
          onSubmit={submit}
          aria-label={title}
          aria-busy={pending}
        >
          <ErrorNotice message={error} />
          {message && <Notice notify>{message}</Notice>}
          {needsRefresh && <Notice>{t("publicProfile.reconcile")}</Notice>}
          <div className="form-grid">
            <div className="field">
              <label htmlFor="profile-name">{t("publicProfile.name")}</label>
              <input
                id="profile-name"
                name="name"
                autoComplete="off"
                defaultValue={savedProfile.name ?? ""}
                required
                maxLength={160}
                disabled={pending || needsRefresh}
              />
            </div>
            <div className="field">
              <label htmlFor="profile-designation">
                {t("publicProfile.designation")}
              </label>
              <input
                id="profile-designation"
                name="designation"
                defaultValue={savedProfile.designation ?? ""}
                maxLength={160}
                disabled={pending || needsRefresh}
              />
            </div>
            <div className="field">
              <label htmlFor="profile-phone">{t("publicProfile.phone")}</label>
              <input
                id="profile-phone"
                name="phone"
                type="tel"
                autoComplete="off"
                defaultValue={savedProfile.phone ?? ""}
                maxLength={40}
                disabled={pending || needsRefresh}
              />
            </div>
            <div className="field">
              <label htmlFor="profile-blood-group">
                {t("publicProfile.bloodGroup")}
              </label>
              <select
                id="profile-blood-group"
                name="bloodGroup"
                defaultValue={savedProfile.bloodGroup ?? ""}
                disabled={pending || needsRefresh}
              >
                <option value="">{t("publicProfile.notProvided")}</option>
                {bloodGroups.map((group) => (
                  <option key={group} value={group}>
                    {group}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="profile-department">
                {t("profile.department")}
              </label>
              <input
                id="profile-department"
                name="publicDepartment"
                defaultValue={savedProfile.publicDepartment ?? ""}
                maxLength={160}
                disabled={pending || needsRefresh}
              />
              <small>{t("publicProfile.departmentHelp")}</small>
            </div>
            <div className="field">
              <label htmlFor="profile-birthday">
                {t("publicProfile.birthday")}
              </label>
              <input
                id="profile-birthday"
                name="dateOfBirth"
                type="date"
                autoComplete="off"
                defaultValue={savedProfile.dateOfBirth ?? ""}
                max={new Date().toISOString().slice(0, 10)}
                disabled={pending || needsRefresh}
              />
            </div>
            <div className="field full">
              <label htmlFor="profile-home-address">
                {t("publicProfile.address")}
              </label>
              <textarea
                id="profile-home-address"
                name="homeAddress"
                autoComplete="off"
                defaultValue={savedProfile.homeAddress ?? ""}
                maxLength={1000}
                disabled={pending || needsRefresh}
              />
            </div>
          </div>
          <div className="form-actions">
            <Link className="button secondary" href="/admin/employees">
              <ArrowLeft size={16} /> {t("publicProfile.directory")}
            </Link>
            {needsRefresh && (
              <button
                type="button"
                className="button secondary"
                disabled={pending}
                onClick={() => void refreshProfile()}
              >
                {pending ? t("common.loading") : t("publicProfile.reload")}
              </button>
            )}
            <button
              className="button"
              type="submit"
              disabled={pending || needsRefresh}
            >
              {pending
                ? t("common.saving")
                : t(
                    isOwnProfile
                      ? "publicProfile.saveOwn"
                      : "publicProfile.save",
                  )}
            </button>
          </div>
        </form>
      </section>
    </>
  );
}
