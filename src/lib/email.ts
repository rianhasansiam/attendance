import "server-only";
import nodemailer from "nodemailer";
import { getEnv } from "@/lib/env";

/** SMTP credentials belong to the application mail service, never a login user. */
export async function sendPasswordResetEmail(
  email: string,
  token: string,
): Promise<void> {
  const env = getEnv();
  if (!env.SMTP_HOST || !env.EMAIL_FROM)
    throw new Error("Password reset email is not configured");
  const resetUrl = new URL("/reset-password", env.AUTH_URL);
  // Fragments are not sent in HTTP requests, access logs, or referrer headers.
  resetUrl.hash = new URLSearchParams({ token }).toString();
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    requireTLS: !env.SMTP_SECURE,
    ...(env.SMTP_USER && env.SMTP_PASSWORD
      ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } }
      : {}),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
    dnsTimeout: 10_000,
    logger: false,
    debug: false,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  try {
    const result = await transport.sendMail({
      from: { name: "XHYD Attendance", address: env.EMAIL_FROM },
      to: { name: "", address: email },
      subject: "Set or reset your XHYD Attendance password",
      text: [
        "Use this link to set or reset your XHYD Attendance application password:",
        resetUrl.toString(),
        "This single-use link expires in 30 minutes. A newer request replaces it.",
        "Choose an application password. Never enter your Google password here.",
        "If you did not request this email, you can ignore it.",
      ].join("\n\n"),
    });
    if (!result.accepted.length || result.rejected.length)
      throw new Error("Password reset email was not accepted");
  } finally {
    transport.close();
  }
}
