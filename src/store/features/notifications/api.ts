import { baseApi } from "@/store/api/base-api";
import type { SidebarNotificationCounts } from "@/modules/notifications/contracts";

export const notificationsApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    sidebarNotifications: build.query<SidebarNotificationCounts, void>({
      query: () => "/api/notifications",
      // Existing mutations already invalidate these domains after a decision,
      // leave submission/cancellation, task change, or account update.
      providesTags: [
        "LateApprovals",
        "OvertimeRequests",
        "Leave",
        "OfficeWork",
      ],
    }),
  }),
});

export const { useSidebarNotificationsQuery } = notificationsApi;
