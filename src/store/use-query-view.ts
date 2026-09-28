"use client";
import { useTranslations } from "next-intl";
import { useErrorMessage } from "@/i18n/errors";
import { isAccessError } from "./api/errors";

// Presentation only: RTK Query owns fetching, cancellation, subscriptions and data.
// currentData avoids rendering a previous filter/employee while new arguments load.
export function useQueryView<T, R>(query: {
  currentData?: T;
  error?: unknown;
  isFetching: boolean;
  isLoading: boolean;
  refetch: () => R;
}) {
  const t = useTranslations("common");
  const errorMessage = useErrorMessage();
  const data = isAccessError(query.error) ? undefined : query.currentData;
  return {
    data,
    loading: query.isLoading || (query.isFetching && data === undefined),
    error: query.error
      ? data
        ? t("refreshFailed", { message: errorMessage(query.error) })
        : errorMessage(query.error)
      : "",
    refresh: query.refetch,
    isFetching: query.isFetching,
  };
}
