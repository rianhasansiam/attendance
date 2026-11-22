"use client";

import Image from "next/image";
import { useLocale, useTranslations } from "next-intl";
import type { WorkReportDTO } from "@/modules/work-report/contracts";
import { date } from "./ui";
import styles from "./work-report-workspace.module.css";

export function WorkReportCard({
  report,
  timezone,
  disabled,
  onEdit,
  onDelete,
}: {
  report: WorkReportDTO;
  timezone: string;
  disabled: boolean;
  onEdit: (report: WorkReportDTO) => void;
  onDelete: (report: WorkReportDTO) => void;
}) {
  const t = useTranslations("workReport");
  const common = useTranslations("common");
  const locale = useLocale();
  const name = report.author
    ? report.author.name?.trim() || t("teamMember")
    : t("deletedAuthor");
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0])
    .join("")
    .toUpperCase();
  const timestamp = (value: string) =>
    new Date(value).toLocaleString(locale, {
      timeZone: timezone,
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  const role = report.author?.role;
  return (
    <article
      className={styles.report}
      aria-label={report.title || `${name} · ${date(report.workDate, locale)}`}
    >
      <header className={styles.reportHeader}>
        <div className={styles.identity}>
          {report.author?.image ? (
            <Image
              src={report.author.image}
              unoptimized
              width={38}
              height={38}
              alt=""
              className={styles.avatar}
            />
          ) : (
            <span className={styles.avatar} aria-hidden="true">
              {initials}
            </span>
          )}
          <div>
            <strong>{name}</strong>
            {role && common.has(`status.${role as "EMPLOYEE"}`) && (
              <small>{common(`status.${role as "EMPLOYEE"}`)}</small>
            )}
          </div>
        </div>
        <div className={styles.reportActions}>
          {report.permissions.canEdit && (
            <button
              className="button small secondary"
              disabled={disabled}
              onClick={() => onEdit(report)}
            >
              {t("edit")}
            </button>
          )}
          {report.permissions.canDelete && (
            <button
              className="button small danger"
              disabled={disabled}
              onClick={() => onDelete(report)}
            >
              {t("delete")}
            </button>
          )}
        </div>
      </header>
      {report.title && <h3>{report.title}</h3>}
      <p className={styles.content}>{report.content}</p>
      <footer className={styles.reportFooter}>
        <span>{t("workDate", { date: date(report.workDate, locale) })}</span>
        <time dateTime={report.createdAt}>
          {t("postedAt", { time: timestamp(report.createdAt) })}
        </time>
        {report.edited && (
          <time dateTime={report.updatedAt}>
            {t("edited", { time: timestamp(report.updatedAt) })}
          </time>
        )}
      </footer>
    </article>
  );
}
