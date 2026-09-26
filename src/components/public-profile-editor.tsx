"use client";

import Link from "next/link";
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
import { errorMessage, normalizeError } from "@/store/api/errors";
import { baseApi } from "@/store/api/base-api";
import { managementInvalidation } from "@/store/features/management/api";
import { useAppDispatch } from "@/store/hooks";

export function PublicProfileEditor({
  profile,
}: {
  profile: ManagedPublicProfile;
}) {
  const [savedProfile, setSavedProfile] = useState(profile);
  const [revision, setRevision] = useState(0);
  const [pending, setPending] = useState(false);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
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
      setMessage(
        "Current public profile loaded. You can review and save changes.",
      );
    } catch (error) {
      setError(errorMessage(error));
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
      setError(parsed.error.issues[0]?.message || "Check the profile details.");
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
      setMessage("Public profile saved.");
    } catch (error) {
      setError(errorMessage(error));
      if (isAmbiguousWrite(error)) setNeedsRefresh(true);
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="PUBLIC PROFILE"
        title="Edit public profile"
        description={`Manage the public information for ${savedProfile.name || "this user"}. These details are visible to anyone visiting their public profile.`}
        action={
          <Link
            className="button secondary"
            href={`/profile/${encodeURIComponent(profile.id)}`}
            prefetch={false}
            target="_blank"
            rel="noopener noreferrer"
          >
            <ExternalLink size={16} /> View public profile
          </Link>
        }
      />
      <section className="card" style={{ padding: 24, maxWidth: 900 }}>
        <form
          key={revision}
          onSubmit={submit}
          aria-label="Edit public profile"
          aria-busy={pending}
        >
          <ErrorNotice message={error} />
          {message && <Notice notify>{message}</Notice>}
          {needsRefresh && (
            <Notice>
              The save result is uncertain. Reload the current profile before
              making another change.
            </Notice>
          )}
          <div className="form-grid">
            <div className="field">
              <label htmlFor="profile-name">Name *</label>
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
              <label htmlFor="profile-designation">Designation</label>
              <input
                id="profile-designation"
                name="designation"
                defaultValue={savedProfile.designation ?? ""}
                maxLength={160}
                disabled={pending || needsRefresh}
              />
            </div>
            <div className="field">
              <label htmlFor="profile-phone">Phone</label>
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
              <label htmlFor="profile-blood-group">Blood group</label>
              <select
                id="profile-blood-group"
                name="bloodGroup"
                defaultValue={savedProfile.bloodGroup ?? ""}
                disabled={pending || needsRefresh}
              >
                <option value="">Not provided</option>
                {bloodGroups.map((group) => (
                  <option key={group} value={group}>
                    {group}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="profile-department">Department</label>
              <input
                id="profile-department"
                name="publicDepartment"
                defaultValue={savedProfile.publicDepartment ?? ""}
                maxLength={160}
                disabled={pending || needsRefresh}
              />
              <small>Department displayed on this public profile.</small>
            </div>
            <div className="field">
              <label htmlFor="profile-birthday">Date of birth</label>
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
              <label htmlFor="profile-home-address">Home address</label>
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
            <Link className="button secondary" href="/admin/users">
              <ArrowLeft size={16} /> All users
            </Link>
            {needsRefresh && (
              <button
                type="button"
                className="button secondary"
                disabled={pending}
                onClick={() => void refreshProfile()}
              >
                {pending ? "Loading…" : "Reload current profile"}
              </button>
            )}
            <button
              className="button"
              type="submit"
              disabled={pending || needsRefresh}
            >
              {pending ? "Saving…" : "Save public profile"}
            </button>
          </div>
        </form>
      </section>
    </>
  );
}
