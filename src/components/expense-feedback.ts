"use client";

import { useState } from "react";
import { useTranslations, type TranslationValues } from "next-intl";
import { useErrorMessage } from "@/i18n/errors";
import type messages from "../../messages/en/expenses.json";

export type ExpenseMessage = {
  key: keyof typeof messages;
  values?: TranslationValues;
};

type Feedback = ExpenseMessage | { error: unknown } | "";

/** Keep message identity and raw errors so feedback follows the active locale. */
export function useExpenseFeedback() {
  const t = useTranslations("expenses");
  const errorMessage = useErrorMessage();
  const [feedback, setFeedback] = useState<Feedback>("");
  const message = !feedback
    ? ""
    : "key" in feedback
      ? t(feedback.key, feedback.values)
      : errorMessage(feedback.error);
  return [message, setFeedback] as const;
}
