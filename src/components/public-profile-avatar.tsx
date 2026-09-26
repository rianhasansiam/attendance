"use client";

import Image from "next/image";
import { useState } from "react";
import styles from "@/app/profile/profile.module.css";

export function PublicProfileAvatar({
  name,
  image,
}: {
  name: string;
  image: string | null;
}) {
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
          alt={`${name}’s profile photo`}
          width={112}
          height={112}
          unoptimized
          referrerPolicy="no-referrer"
          onError={() => setFailedImage(image)}
        />
      ) : (
        <span aria-label={`${name}’s initials`}>{initials}</span>
      )}
    </div>
  );
}
