"use client";
import { errorMessage, isAccessError } from "./api/errors";

// Presentation only: RTK Query owns fetching, cancellation, subscriptions and data.
// currentData avoids rendering a previous filter/employee while new arguments load.
export function useQueryView<T, R>(query: {
  currentData?: T;
  error?: unknown;
  isFetching: boolean;
  isLoading: boolean;
  refetch: () => R;
}) {
  const data = isAccessError(query.error) ? undefined : query.currentData;
  return {
    data,
    loading: query.isLoading || (query.isFetching && data === undefined),
    error: query.error
      ? `${data ? "Refresh failed. Showing previously loaded data. " : ""}${errorMessage(query.error)}`
      : "",
    refresh: query.refetch,
    isFetching: query.isFetching,
  };
}
