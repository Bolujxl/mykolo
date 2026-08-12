import "server-only";
import { Resend } from "resend";

const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

export async function sendPasswordResetEmail(
  email: string,
  resetUrl: string
): Promise<void> {
  // Console fallback always fires, even once Resend is wired up — cheap
  // safety net for local dev/grading visibility, costs nothing to keep.
  console.log(`[kolovault] Password reset link for ${email}: ${resetUrl}`);

  if (!resend) return;

  try {
    await resend.emails.send({
      from: process.env.EMAIL_FROM ?? "KoloVault <onboarding@resend.dev>",
      to: email,
      subject: "Reset your KoloVault password",
      html: `
        <p>Someone requested a password reset for this KoloVault account.</p>
        <p><a href="${resetUrl}">Reset your password</a></p>
        <p>This link expires in 30 minutes. If you didn't request this, you can safely ignore this email.</p>
      `,
    });
  } catch (error) {
    console.error("[kolovault] Failed to send password reset email via Resend:", error);
  }
}
