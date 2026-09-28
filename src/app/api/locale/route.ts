import { NextResponse } from "next/server";
import { isLocale, localeCookie, localeMaxAge } from "@/i18n/config";
import { getEnv } from "@/lib/env";
export async function POST(request: Request) {
  // Behind Nginx, request.url can contain Next's internal loopback address.
  // Use the configured public origin, never caller-supplied forwarding headers.
  const publicUrl = new URL(getEnv().AUTH_URL);
  if (
    request.headers.get("origin") !== publicUrl.origin ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    return NextResponse.json({ error: "INVALID_ORIGIN" }, { status: 403 });
  const body = await request.json().catch(() => null);
  if (!isLocale(body?.locale))
    return NextResponse.json({ error: "INVALID_LOCALE" }, { status: 400 });
  const response = NextResponse.json({ locale: body.locale });
  response.cookies.set(localeCookie, body.locale, {
    path: "/",
    maxAge: localeMaxAge,
    httpOnly: true,
    sameSite: "lax",
    secure: publicUrl.protocol === "https:",
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
