import { endSession } from "@/lib/auth/session";

/** POST-only: a GET would let a stray <img> or link sign someone out. */
export async function POST() {
  await endSession();
  return Response.json({ ok: true });
}
