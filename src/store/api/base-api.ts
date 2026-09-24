import { createApi } from "@reduxjs/toolkit/query/react";
import { baseQuery } from "./base-query";
import { tagTypes } from "./tags";

export const baseApi = createApi({
  reducerPath: "workspaceApi",
  baseQuery,
  tagTypes,
  keepUnusedDataFor: 60,
  refetchOnFocus: true,
  refetchOnReconnect: true,
  endpoints: () => ({}),
});
