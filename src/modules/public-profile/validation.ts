import { z } from "zod";

export const bloodGroups = [
  "A+",
  "A-",
  "B+",
  "B-",
  "AB+",
  "AB-",
  "O+",
  "O-",
] as const;

const optionalText = (maximum: number) =>
  z
    .string()
    .trim()
    .max(maximum)
    .transform((value) => value || null)
    .nullable()
    .optional();

const birthDate = z
  .string()
  .trim()
  .refine((value) => {
    if (!value) return true;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000"))
      return false;
    const date = new Date(`${value}T00:00:00.000Z`);
    return (
      !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value
    );
  }, "Enter a valid date of birth.")
  .refine(
    (value) => !value || value <= new Date().toISOString().slice(0, 10),
    "Date of birth cannot be in the future.",
  )
  .transform((value) => value || null)
  .nullable()
  .optional();

export const publicProfileUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    designation: optionalText(160),
    phone: optionalText(40),
    bloodGroup: z
      .union([z.enum(bloodGroups), z.literal("")])
      .transform((value) => value || null)
      .nullable()
      .optional(),
    publicDepartment: optionalText(160),
    homeAddress: optionalText(1000),
    dateOfBirth: birthDate,
  })
  .strict();

export const profileUpdateSchema = publicProfileUpdateSchema;
