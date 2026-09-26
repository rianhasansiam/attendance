import "server-only";
import { randomBytes } from "node:crypto";
import { argon2id, hash, verify } from "argon2";
import { newPasswordSchema, PASSWORD_MAX_LENGTH } from "./password-validation";

const options = {
  type: argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
} as const;
export async function hashPassword(password: string): Promise<string> {
  return hash(newPasswordSchema.parse(password), options);
}

// Unknown emails and Google-only accounts still perform the same expensive verification.
let dummyHash: Promise<string> | undefined;
export async function verifyPassword(
  passwordHash: string | null | undefined,
  password: string,
): Promise<boolean> {
  if (!password || password.length > PASSWORD_MAX_LENGTH) return false;
  const encoded =
    passwordHash ??
    (await (dummyHash ??= hash(randomBytes(32).toString("hex"), options)));
  try {
    const valid = await verify(encoded, password);
    return !!passwordHash && valid;
  } catch {
    return false;
  }
}
