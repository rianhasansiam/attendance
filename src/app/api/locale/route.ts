import { NextResponse } from "next/server";
import { isLocale, localeCookie, localeMaxAge } from "@/i18n/config";
export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin)
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
    secure: new URL(request.url).protocol === "https:",
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
