import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { api, readJson } from "@/lib/api";
import { DomainError } from "@/lib/errors";
import { redirect } from "next/navigation";

describe("API boundary", () => {
  it("preserves framework control-flow errors instead of converting them to JSON", async () => {
    await expect(api(async () => redirect("/login"))).rejects.toThrow(
      "NEXT_REDIRECT",
    );
  });
  it("wraps success and prevents response caching", async () => {
    const response = await api(async () => ({ id: "123" }));
    expect(await response.json()).toEqual({
      success: true,
      data: { id: "123" },
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("preserves a safe domain rejection", async () => {
    const response = await api(async () => {
      throw new DomainError("FORBIDDEN", "Access denied.", 403);
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      success: false,
      error: { code: "FORBIDDEN", message: "Access denied." },
    });
  });
  it("sanitizes unexpected errors including secrets and database details", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await api(async () => {
      throw new Error("postgresql://private:password@db/production");
    });
    const text = await response.text();
    expect(response.status).toBe(500);
    expect(text).not.toContain("password");
    expect(JSON.stringify(log.mock.calls)).not.toContain("password");
    log.mockRestore();
  });
  it("rejects client-controlled authority fields", async () => {
    const request = new Request("http://localhost/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "User", role: "SUPER_ADMIN" }),
    });
    await expect(
      readJson(request, z.object({ name: z.string() }).strict()),
    ).rejects.toBeInstanceOf(z.ZodError);
  });
  it("rejects invalid JSON and oversized bodies without trusting Content-Length", async () => {
    const make = (body: string) =>
      new Request("http://localhost/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
    await expect(readJson(make("{"), z.unknown())).rejects.toMatchObject({
      code: "INVALID_JSON",
    });
    await expect(
      readJson(make(JSON.stringify("x".repeat(65537))), z.unknown()),
    ).rejects.toMatchObject({ code: "BODY_TOO_LARGE" });
  });
  it("keeps downloadable exports private", async () => {
    const response = await api(
      async () =>
        new Response("csv", { headers: { "content-type": "text/csv" } }),
    );
    expect(response.headers.get("content-type")).toBe("text/csv");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
