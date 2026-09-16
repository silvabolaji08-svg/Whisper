import { currentUser } from "@/lib/auth/session";
import { updateDisplayName } from "@/lib/auth/store";

/** Renames the signed-in account. The name others see in a room. */
export async function PATCH(request: Request) {
  const user = await currentUser();
  if (!user) {
    return Response.json({ error: "Not signed in." }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const name = (payload as { displayName?: unknown } | null)?.displayName;
  const updated = updateDisplayName(user.id, typeof name === "string" ? name : "");

  if (!updated) {
    return Response.json(
      { error: "Display names need at least one visible character." },
      { status: 400 },
    );
  }

  return Response.json({ ok: true, user: { displayName: updated.displayName } });
}
