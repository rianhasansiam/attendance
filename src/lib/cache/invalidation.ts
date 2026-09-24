import "server-only";
import { revalidateTag } from "next/cache";
import { CACHE_TAGS, type CachedReference } from "./tags";

// A failed post-commit expiry must never turn a completed write into a retryable
// API failure. Until expiry succeeds, this process reads that display data fresh.
const bypassed = new Set<CachedReference>();

export function mayCacheReferenceDisplay(resource: CachedReference) {
  return (
    process.env.REFERENCE_DISPLAY_CACHE !== "disabled" &&
    !bypassed.has(resource)
  );
}

/** Call from a Route Handler only after its catalog transaction commits. */
export function invalidateReferenceDisplay(resource: string) {
  if (Object.hasOwn(CACHE_TAGS, resource)) {
    const reference = resource as CachedReference;
    // Route Handlers cannot use updateTag. Block on the next read so the
    // administrator sees their change immediately on this Node process.
    try {
      revalidateTag(CACHE_TAGS[reference], { expire: 0 });
      bypassed.delete(reference);
    } catch {
      bypassed.add(reference);
      // No error payload, request body, identity, or database values are logged.
      console.error("Reference display cache expiry failed after commit", {
        resource: reference,
      });
    }
  }
}
