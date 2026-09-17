import { isEmailShaped, normalizeEmail } from "@/lib/auth/config";
import {
  consoleCodesAllowed,
  emailIsConfigured,
  sendLoginCode,
} from "@/lib/auth/email";
import { issueCode, isRequestingTooOften, purgeExpired } from "@/lib/auth/store";

/**
 * Step one of sign-in: email an one-time code.
 *
 * Signup and login are the same flow, so this deliberately does not reveal
 * whether the address already has an account.
 */
export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const raw = (payload as { email?: unknown } | null)?.email;
  if (!isEmailShaped(raw)) {
    return Response.json(
      { error: "Enter a valid email address." },
      { status: 400 },
    );
  }

  const email = normalizeEmail(raw);

  if (await isRequestingTooOften(email)) {
    return Response.json(
      { error: "Too many codes requested. Try again later." },
      { status: 429 },
    );
  }

  // Refusing here rather than silently console-logging keeps a misconfigured
  // production deploy from looking like it works while nothing is delivered.
  if (!emailIsConfigured() && !consoleCodesAllowed()) {
    console.error("RESEND_API_KEY is not set; cannot send login codes.");
    return Response.json(
      { error: "Email delivery is not configured on this server." },
      { status: 500 },
    );
  }

  const { code } = await issueCode(email);

  try {
    const { loggedToConsole } = await sendLoginCode(email, code);
    await purgeExpired(); // Cheap housekeeping on a naturally rate-limited path.
    return Response.json({ ok: true, devCodeInConsole: loggedToConsole });
  } catch (error) {
    console.error("Failed to send login code:", error);
    return Response.json(
      { error: "Could not send the code. Try again in a moment." },
      { status: 502 },
    );
  }
}
