import { ProfileLoadingIndicator } from "@/components/loading-indicator";
import { getLocale, getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { connection } from "next/server";
import { notFound, redirect } from "next/navigation";
import {
  BriefcaseBusiness,
  CalendarDays,
  Droplet,
  House,
  Layers3,
  Phone,
} from "lucide-react";
import { getPublicProfile } from "@/modules/public-profile/service";
import { PublicProfileAvatar } from "@/components/public-profile-avatar";
import styles from "../profile.module.css";

type Props = { params: Promise<{ slug: string }> };

export default function PublicProfilePage(props: Props) {
  return (
    <Suspense fallback={<ProfileLoadingIndicator className={styles.loading} />}>
      <Profile {...props} />
    </Suspense>
  );
}

async function Profile({ params }: Props) {
  // Read on each visit so deactivation or deletion removes the public profile.
  await connection();
  const t = await getTranslations("employee");
  const locale = await getLocale();
  const { slug } = await params;
  const profile = await getPublicProfile(slug, t("publicProfile.teamMember"));
  if (!profile) notFound();
  if (slug !== profile.slug)
    redirect(`/profile/${encodeURIComponent(profile.slug)}`);

  return (
    <article className={styles.card} aria-labelledby="profile-name">
      <div className={styles.cover} aria-hidden="true">
        <span>XHYD</span>
      </div>
      <div className={styles.content}>
        <PublicProfileAvatar name={profile.name} image={profile.image} />
        <p className={styles.eyebrow}>{t("publicProfile.people")}</p>
        <h1 id="profile-name" className={styles.name}>
          {profile.name}
        </h1>
        <p className={styles.intro}>{t("publicProfile.intro")}</p>
        <dl className={styles.details}>
          {[
            {
              label: t("publicProfile.designation"),
              value: profile.designation,
              Icon: BriefcaseBusiness,
            },
            {
              label: t("publicProfile.phone"),
              value: profile.phone,
              Icon: Phone,
            },
            {
              label: t("publicProfile.bloodGroup"),
              value: profile.bloodGroup,
              Icon: Droplet,
            },
            {
              label: t("profile.department"),
              value: profile.department,
              Icon: Layers3,
            },
            {
              label: t("publicProfile.address"),
              value: profile.homeAddress,
              Icon: House,
            },
            {
              label: t("publicProfile.birthday"),
              value: profile.dateOfBirth
                ? new Intl.DateTimeFormat(locale, {
                    day: "numeric",
                    month: "long",
                    year: "numeric",
                    timeZone: "UTC",
                  }).format(new Date(`${profile.dateOfBirth}T00:00:00.000Z`))
                : null,
              Icon: CalendarDays,
            },
          ].map(({ label, value, Icon }) => (
            <div className={styles.detail} key={label}>
              <dt>
                <span className={styles.detailIcon}>
                  <Icon size={20} aria-hidden="true" />
                </span>
                {label}
              </dt>
              <dd>{value || t("publicProfile.notListed")}</dd>
            </div>
          ))}
        </dl>
        <p className={styles.caption}>{t("publicProfile.caption")}</p>
      </div>
    </article>
  );
}
