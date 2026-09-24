import { ZodError, type ZodType } from "zod";
import { unstable_rethrow } from "next/navigation";
import { DomainError } from "@/lib/errors";

export async function api(handler: () => Promise<unknown>): Promise<Response> {
  try {
    const data = await handler();
    const response =
      data instanceof Response ? data : Response.json({ success: true, data });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    // Preserve framework control flow during Cache Components prerendering.
    unstable_rethrow(error);
    let safe = error instanceof DomainError ? error : undefined;
    const fieldErrors =
      error instanceof ZodError
        ? Object.fromEntries(
            [...new Set(error.issues.map((issue) => issue.path.join(".")))].map(
              (path) => [
                path || "_form",
                error.issues
                  .filter((issue) => issue.path.join(".") === path)
                  .map((issue) => issue.message),
              ],
            ),
          )
        : undefined;
    if (error instanceof ZodError)
      safe = new DomainError(
        "VALIDATION_ERROR",
        "Check the submitted fields and try again.",
      );
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? error.code
        : undefined;
    if (!safe && code === "P2002")
      safe = new DomainError(
        "CONFLICT",
        "A record with these details already exists.",
        409,
      );
    if (!safe && code === "P2003")
      safe = new DomainError(
        "REFERENCE_CONFLICT",
        "This record is referenced by other records or a selected record no longer exists.",
        409,
      );
    if (!safe && code === "P2025")
      safe = new DomainError(
        "NOT_FOUND",
        "The requested record was not found.",
        404,
      );
    if (!safe && code === "P2034")
      safe = new DomainError(
        "CONFLICT",
        "Another request updated this record. Please try again.",
        409,
      );
    if (!safe)
      console.error("Request failed", {
        category: error instanceof Error ? error.name : "UnknownError",
      });
    return Response.json(
      {
        success: false,
        error: {
          code: safe?.code ?? "INTERNAL_ERROR",
          message:
            safe?.message ??
            "Unable to complete the request. Please try again.",
          ...(fieldErrors ? { fieldErrors } : {}),
        },
      },
      { status: safe?.status ?? 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
export async function readJson<T>(
  request: Request,
  schema: ZodType<T>,
): Promise<T> {
  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  )
    throw new DomainError(
      "UNSUPPORTED_MEDIA_TYPE",
      "Send application/json data.",
      415,
    );
  // Bound streamed bodies too; Content-Length is not authoritative.
  const reader = request.body?.getReader();
  if (!reader)
    throw new DomainError("INVALID_JSON", "A JSON body is required.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 65536) {
      await reader.cancel();
      throw new DomainError(
        "BODY_TOO_LARGE",
        "The submitted data is too large.",
        413,
      );
    }
    chunks.push(value);
  }
  let input: unknown;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new DomainError("INVALID_JSON", "The submitted JSON is invalid.");
  }
  return schema.parse(input);
}
