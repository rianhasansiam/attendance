import { UserRound } from "lucide-react";
import styles from "../profile.module.css";

export default function ProfileNotFound() {
  return (
    <section className={styles.unavailable}>
      <span className={styles.unavailableIcon}>
        <UserRound size={32} aria-hidden="true" />
      </span>
      <p className={styles.eyebrow}>PUBLIC PROFILE</p>
      <h1>Profile unavailable</h1>
      <p>This profile is no longer available or the link is incorrect.</p>
    </section>
  );
}
