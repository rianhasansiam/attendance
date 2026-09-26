import { z } from "zod";

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;
export const normalizedEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .email();
const passwordInput = z
  .string()
  .max(PASSWORD_MAX_LENGTH, "Use at most 128 characters.");
export const newPasswordSchema = passwordInput.min(
  PASSWORD_MIN_LENGTH,
  "Use at least 12 characters.",
);
export const credentialsSchema = z.object({
  email: normalizedEmailSchema,
  password: passwordInput.min(1),
});
const matchingPasswords = {
  message: "Passwords do not match.",
  path: ["confirmPassword"],
};
export const passwordChangeSchema = z
  .object({
    currentPassword: passwordInput.optional(),
    newPassword: newPasswordSchema,
    confirmPassword: passwordInput,
  })
  .strict()
  .refine(
    (input) => input.newPassword === input.confirmPassword,
    matchingPasswords,
  );
