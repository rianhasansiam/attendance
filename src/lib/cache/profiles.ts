// Display labels only. Security/configuration reads never use this profile.
export const cacheProfiles = {
  referenceDisplay: { stale: 30, revalidate: 300, expire: 900 },
};
