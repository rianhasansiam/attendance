import { z } from "zod";

const envSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "production", "test"])
      .default("development"),
    DATABASE_URL: z
      .string()
      .url()
      .refine((v) => /^postgres(ql)?:/.test(v), "PostgreSQL URL required"),
    AUTH_SECRET: z.string().min(32),
    AUTH_URL: z.string().url(),
    GOOGLE_CLIENT_ID: z.string().min(1),
    GOOGLE_CLIENT_SECRET: z.string().min(1),
    SMTP_HOST: z.string().trim().min(1).optional(),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
    SMTP_SECURE: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    SMTP_USER: z.string().min(1).optional(),
    SMTP_PASSWORD: z.string().min(1).optional(),
    EMAIL_FROM: z.email().optional(),
    ALLOWED_GOOGLE_DOMAIN: z.string().trim().toLowerCase().optional(),
    WEBAUTHN_RP_ID: z.string().min(1),
    WEBAUTHN_RP_NAME: z.string().min(1).default("XHYD Attendance"),
    WEBAUTHN_ORIGIN: z.string().url(),
    TRUSTED_PROXY_MODE: z.enum(["none", "nginx"]).default("none"),
    TRUSTED_PROXY_SECRET: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (Boolean(env.SMTP_USER) !== Boolean(env.SMTP_PASSWORD))
      ctx.addIssue({
        code: "custom",
        path: ["SMTP_USER"],
        message: "SMTP_USER and SMTP_PASSWORD must be configured together",
      });
    const origin = new URL(env.WEBAUTHN_ORIGIN);
    if (
      origin.origin !== env.WEBAUTHN_ORIGIN ||
      new URL(env.AUTH_URL).origin !== env.AUTH_URL
    )
      ctx.addIssue({
        code: "custom",
        message:
          "AUTH_URL and WEBAUTHN_ORIGIN must be origins without paths or trailing slash",
      });
    if (
      origin.origin !== new URL(env.AUTH_URL).origin ||
      origin.hostname !== env.WEBAUTHN_RP_ID
    )
      ctx.addIssue({
        code: "custom",
        message: "WebAuthn origin, RP ID, and application origin must match",
      });
    if (
      env.NODE_ENV === "production" &&
      (origin.protocol !== "https:" ||
        new URL(env.AUTH_URL).protocol !== "https:")
    )
      ctx.addIssue({ code: "custom", message: "Production requires HTTPS" });
    if (
      env.TRUSTED_PROXY_MODE === "nginx" &&
      (env.TRUSTED_PROXY_SECRET?.length ?? 0) < 32
    )
      ctx.addIssue({
        code: "custom",
        path: ["TRUSTED_PROXY_SECRET"],
        message: "Nginx proxy secret must be at least 32 characters",
      });
  });
export type AppEnv = z.infer<typeof envSchema>;
export function parseEnv(input: Record<string, string | undefined>): AppEnv {
  const result = envSchema.safeParse(input);
  if (!result.success)
    throw new Error(
      `Invalid server configuration: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  return result.data;
}
let cached: AppEnv | undefined;
export function getEnv(): AppEnv {
  return (cached ??= parseEnv(process.env));
}
