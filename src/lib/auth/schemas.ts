import { z } from "zod";
import { passwordSchema } from "./password";

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email("Enter a valid email address.")
  .max(254);

export const signupSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Password is required."),
});

export const requestResetSchema = z.object({
  email: emailSchema,
});

export const confirmResetSchema = z.object({
  token: z.string().min(1),
  password: passwordSchema,
});

export const entrySchema = z.object({
  amount: z
    .number()
    .finite()
    .positive("Amount must be greater than zero.")
    .max(1_000_000, "Amount is too large."),
  note: z.string().trim().max(280).optional().default(""),
  date: z.coerce.date(),
});

export const goalSchema = z.object({
  goalAmount: z
    .number()
    .finite()
    .positive("Goal must be greater than zero.")
    .max(10_000_000, "Goal is too large.")
    .nullable(),
});
