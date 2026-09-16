import { isEmailShaped, normalizeEmail, CODE_LENGTH } from "@/lib/auth/config";
import { startSession } from "@/lib/auth/session";
import { verifyCode } from "@/lib/auth/store";

/** Step two: exchange a correct code for a session cookie. */
const MESSAGES: Record<string, string> = {
  "no-code": "That code has expired or was already used. Request a new one.",
  expired: "That code has expired. Request a new one.",
  "too-many-attempts": "Too many incorrect attempts. Request a new code.",
  mismatch: "That code is not correct.",
};

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const body = payload as { email?: unknown; code?: unknown } | null;

  if (!isEmailShaped(body?.email)) {
    return Response.json({ error: "Enter a valid email address." }, { status: 400 });
  }

  const code = typeof body?.code === "string" ? body.code.trim() : "";
  if (!new RegExp(`^\\d{${CODE_LENGTH}}$`).test(code)) {
    return Response.json(
      { error: `Enter the ${CODE_LENGTH}-digit code from your email.` },
      { status: 400 },
    );
  }

  const email = normalizeEmail(body.email);
  const result = verifyCode(email, code);

  if (!result.ok) {
    // 401 for a wrong guess, 410 once the code is unusable, so the client can
    // decide between "try again" and "request a new code".
    const status = result.reason === "mismatch" ? 401 : 410;
    return Response.json({ error: MESSAGES[result.reason] }, { status });
  }

  await startSession(result.user.id);

  return Response.json({
    ok: true,
    user: { id: result.user.id, email: result.user.email, displayName: result.user.displayName },
  });
}
