"use client";

import { useState } from "react";
import { useTranslations, type TranslationValues } from "next-intl";
import { useErrorMessage } from "@/i18n/errors";
import type messages from "../../messages/en/employee.json";

type LeafKeys<T> = {
  [K in keyof T & string]: T[K] extends string ? K : `${K}.${LeafKeys<T[K]>}`;
}[keyof T & string];
type EmployeeMessageKey = LeafKeys<typeof messages>;
type Message = {
  key: EmployeeMessageKey;
  values?: TranslationValues;
  translatedValues?: Record<string, EmployeeMessageKey>;
};

/** Store message identity so visible feedback follows language changes. */
export function useEmployeeMessage() {
  const t = useTranslations("employee");
  const [key, setKey] = useState<EmployeeMessageKey | "">("");
  return [key ? t(key) : "", setKey] as const;
}

export function useEmployeeError() {
  const t = useTranslations("employee");
  const errorMessage = useErrorMessage();
  const [error, setError] = useState<unknown>("");
  const message = !error
    ? ""
    : typeof error === "object" && "key" in error
      ? t((error as Message).key, {
          ...(error as Message).values,
          ...Object.fromEntries(
            Object.entries((error as Message).translatedValues ?? {}).map(
              ([name, key]) => [name, t(key)],
            ),
          ),
        })
      : error instanceof Error && error.name === "NotAllowedError"
        ? t("errors.deviceCancelled")
        : errorMessage(error);
  return [message, setError] as const;
}
