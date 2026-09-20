import "server-only";
import { revalidateTag } from "next/cache";
import { CACHE_TAGS } from "./tags";

/** Call from a Route Handler only after its catalog transaction commits. */
export function invalidateReferenceDisplay(resource: string) {
  if (Object.hasOwn(CACHE_TAGS, resource)) {
    // Route Handlers cannot use updateTag. Block on the next read so the
    // administrator sees their change immediately on this Node process.
    revalidateTag(CACHE_TAGS[resource as keyof typeof CACHE_TAGS], {
      expire: 0,
    });
  }
}
