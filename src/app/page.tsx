import { redirect } from "next/navigation";

import JoinForm from "@/components/JoinForm";
import { currentUser } from "@/lib/auth/session";

/**
 * The join screen is behind auth. Guarding here in a Server Component rather
 * than in `proxy.ts` because the session lookup hits node:sqlite, which the
 * proxy runtime cannot load.
 */
export default async function JoinPage() {
  const user = await currentUser();
  if (!user) redirect("/login");

  return <JoinForm displayName={user.displayName} email={user.email} />;
}
