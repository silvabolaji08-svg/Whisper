import { CODE_TTL_MS } from "./config";

/**
 * Sends login codes through Resend's REST API.
 *
 * Called directly with fetch rather than via the SDK: it is one POST, and
 * avoiding the dependency keeps the production install small.
 *
 * With no RESEND_API_KEY configured the code is logged to the server console
 * instead, so the whole flow is usable in development before any email
 * provider is set up.
 */

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export type DeliveryResult = { delivered: boolean; loggedToConsole: boolean };

const minutes = Math.round(CODE_TTL_MS / 60_000);

function textBody(code: string): string {
  return [
    `Your Realtime Chat sign-in code is ${code}`,
    "",
    `The code expires in ${minutes} minutes and can only be used once.`,
    "If you did not request it, you can ignore this email.",
  ].join("\n");
}

function htmlBody(code: string): string {
  // Inline styles only: email clients strip <style> blocks and ignore most CSS.
  return `
    <div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;color:#0f172a">
      <h1 style="margin:0 0 8px;font-size:20px">Your sign-in code</h1>
      <p style="margin:0 0 24px;color:#475569;font-size:14px;line-height:1.6">
        Enter this code to sign in to Realtime Chat.
      </p>
      <div style="font-size:32px;font-weight:700;letter-spacing:8px;background:#f1f5fd;border-radius:12px;padding:20px;text-align:center">
        ${code}
      </div>
      <p style="margin:24px 0 0;color:#64748b;font-size:13px;line-height:1.6">
        The code expires in ${minutes} minutes and can only be used once.
        If you did not request it, you can safely ignore this email.
      </p>
    </div>
  `;
}

export async function sendLoginCode(
  email: string,
  code: string,
): Promise<DeliveryResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM ?? "Realtime Chat <onboarding@resend.dev>";

  if (!apiKey) {
    // Development fallback. Never reached in production: the route refuses to
    // issue a code when the provider is unconfigured there.
    console.info(
      `\n  [auth] No RESEND_API_KEY set — login code for ${email} is: ${code}\n`,
    );
    return { delivered: false, loggedToConsole: true };
  }

  const response = await fetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [email],
      subject: `${code} is your Realtime Chat code`,
      text: textBody(code),
      html: htmlBody(code),
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Resend rejected the request (${response.status}): ${detail}`);
  }

  return { delivered: true, loggedToConsole: false };
}

/** True when a real provider is configured. */
export function emailIsConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY);
}

/**
 * Whether printing codes to the console is acceptable.
 *
 * Always fine outside production. In production it takes a deliberate opt-in,
 * so a deploy that simply forgot RESEND_API_KEY fails loudly instead of
 * appearing to work while no mail is ever sent. The test suite sets this
 * because it runs the server in production mode.
 */
export function consoleCodesAllowed(): boolean {
  return (
    process.env.NODE_ENV !== "production" ||
    process.env.AUTH_DEV_CONSOLE_CODES === "true"
  );
}
