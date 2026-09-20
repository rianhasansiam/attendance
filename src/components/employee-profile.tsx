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
  return (
    <>
      <PageHeader
        eyebrow="YOUR WORKSPACE"
        title="My profile"
        description="Your details, connected to your Google account."
      />
      <section className="card">
        <div className="card-body">
          <div className="profile-banner">
            {user.image ? (
              <Image
                unoptimized
                src={user.image}
                alt="Google profile"
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
              ["Employee ID", employee.employeeCode],
              ["Department", employee.department?.name],
              ["Office", employee.office.name],
              ["Office timezone", employee.office.timezone],
              ["Joined", date(employee.joinedAt)],
              ["Account role", user.role],
            ].map(([key, value]) => (
              <div className="detail-item" key={key}>
                <dt>{key}</dt>
                <dd>{label(value)}</dd>
              </div>
            ))}
          </dl>
          <p className="muted" style={{ marginTop: 35, fontSize: 12 }}>
            Need to update your information? Contact your administrator.
          </p>
        </div>
      </section>
    </>
  );
}
