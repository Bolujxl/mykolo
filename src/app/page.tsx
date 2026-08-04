import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { isSessionRecordValid } from "@/lib/auth/sessions";

export default async function Home() {
  const session = await getSession();

  if (
    session.userId &&
    session.sessionId &&
    (await isSessionRecordValid(session.sessionId, session.userId))
  ) {
    redirect("/dashboard");
  }

  redirect("/login");
}
