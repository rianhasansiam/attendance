export const CACHE_TAGS = {
  departments: "departments:display",
  offices: "offices:display",
  shifts: "shifts:display",
} as const;

export type CachedReference = keyof typeof CACHE_TAGS;
