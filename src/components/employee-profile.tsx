import { useLocale, useTranslations } from "next-intl";
import Image from "next/image";
import { Badge, date, label, PageHeader } from "./ui";

export function EmployeeProfile({
  employee,
  user,
}: {
  employee: {
    employeeCode: string;
    joinedAt: Date;
    department: { name: string } | null;
    office: { name: string; timezone: string };
  };
  user: {
    name: string | null;
    email: string;
    image: string | null;
    status: string;
    role: string;
  };
}) {
  const t = useTranslations("employee");
  const statuses = useTranslations("common.status");
  const locale = useLocale();
  return (
    <>
      <PageHeader
        eyebrow={t("profile.eyebrow")}
        title={t("profile.title")}
        description={t("profile.description")}
      />
      <section className="card">
        <div className="card-body">
          <div className="profile-banner">
            {user.image ? (
              <Image
                unoptimized
                src={user.image}
                alt={t("profile.googlePhoto")}
                width={64}
                height={64}
                style={{ borderRadius: "50%" }}
              />
            ) : (
              <span className="avatar">
                {(user.name || user.email).slice(0, 2).toUpperCase()}
              </span>
            )}
            <div>
              <h2>{label(user.name)}</h2>
              <p>{user.email}</p>
            </div>
            <Badge value={user.status} />
          </div>
          <dl className="detail-list">
            {[
              [t("columns.employeeId"), employee.employeeCode],
              [t("profile.department"), employee.department?.name],
              [t("profile.office"), employee.office.name],
              [t("profile.timezone"), employee.office.timezone],
              [t("profile.joined"), date(employee.joinedAt, locale)],
              [
                t("profile.role"),
                user.role === "EMPLOYEE"
                  ? statuses("EMPLOYEE")
                  : user.role === "ADMIN"
                    ? statuses("ADMIN")
                    : user.role === "SUPER_ADMIN"
                      ? statuses("SUPER_ADMIN")
                      : user.role === "MANAGE_DRIVER"
                        ? statuses("MANAGE_DRIVER")
                        : user.role,
              ],
            ].map(([key, value]) => (
              <div className="detail-item" key={key}>
                <dt>{key}</dt>
                <dd>{label(value)}</dd>
              </div>
            ))}
          </dl>
          <p className="muted" style={{ marginTop: 35, fontSize: 12 }}>
            {t("profile.updateHelp")}
          </p>
        </div>
      </section>
    </>
  );
}
