import { Suspense } from "react";
import { useTranslations } from "next-intl";
import { UserRound } from "lucide-react";
import styles from "../profile.module.css";

export default function ProfileNotFound() {
  return (
    <Suspense fallback={null}>
      <ProfileNotFoundContent />
    </Suspense>
  );
}
function ProfileNotFoundContent() {
  const t = useTranslations("employee");
  return (
    <section className={styles.unavailable}>
      <span className={styles.unavailableIcon}>
        <UserRound size={32} aria-hidden="true" />
      </span>
      <p className={styles.eyebrow}>{t("publicProfile.eyebrow")}</p>
      <h1>{t("publicProfile.unavailable")}</h1>
      <p>{t("publicProfile.unavailableDescription")}</p>
    </section>
  );
}
