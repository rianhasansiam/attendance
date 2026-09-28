"use client";

import Image from "next/image";
import { useTranslations } from "next-intl";
import { useState } from "react";
import styles from "@/app/profile/profile.module.css";

export function PublicProfileAvatar({
  name,
  image,
}: {
  name: string;
  image: string | null;
}) {
  const t = useTranslations("employee");
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => Array.from(part)[0])
    .join("")
    .toUpperCase();
  return (
    <div className={styles.avatar}>
      {image && failedImage !== image ? (
        <Image
          src={image}
          alt={t("publicProfile.photo", { name })}
          width={112}
          height={112}
          unoptimized
          referrerPolicy="no-referrer"
          onError={() => setFailedImage(image)}
        />
      ) : (
        <span aria-label={t("publicProfile.initials", { name })}>
          {initials}
        </span>
      )}
    </div>
  );
}
