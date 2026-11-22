/** Counts are keyed by destination so admin and employee scopes stay separate. */
export type SidebarNotificationHref =
  | "/admin/late-approvals"
  | "/admin/overtime-requests"
  | "/admin/leaves"
  | "/employee/leaves"
  | "/office-work";

export type SidebarNotificationCounts = Partial<
  Record<SidebarNotificationHref, number>
>;
