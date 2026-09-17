/**
 * Checks that email delivery is configured correctly, and optionally sends a
 * real test message.
 *
 *   npm run email:check                 # report configuration only
 *   npm run email:check you@gmail.com   # also send a test email
 *
 * Reads .env.local via Node's --env-file, so the API key never has to be typed
 * on the command line.
 */

const key = process.env.RESEND_API_KEY;
const from = process.env.EMAIL_FROM ?? "Realtime Chat <onboarding@resend.dev>";
const to = process.argv[2];

const ok = (message) => console.log(`  OK    ${message}`);
const bad = (message) => console.log(`  FAIL  ${message}`);
const info = (message) => console.log(`        ${message}`);

console.log("\nEmail delivery check\n");

if (!key) {
  bad("RESEND_API_KEY is not set.");
  info("Login codes will print to the terminal running `npm run dev`.");
  info("That is fine for local development — nothing is broken.");
  info("");
  info("To send real email: add RESEND_API_KEY=re_... to .env.local");
  process.exit(0);
}

if (!key.startsWith("re_")) {
  bad(`RESEND_API_KEY does not look like a Resend key (expected "re_...").`);
  process.exit(1);
}

ok(`RESEND_API_KEY is set (${key.slice(0, 6)}…${key.slice(-4)})`);
ok(`EMAIL_FROM is ${from}`);

if (from.includes("onboarding@resend.dev")) {
  info("");
  info("Note: the shared resend.dev sender only delivers to the address that");
  info("owns your Resend account. Verify your own domain to email anyone else.");
}

if (!to) {
  console.log("\nPass an address to send a real test message:");
  console.log("  npm run email:check you@example.com\n");
  process.exit(0);
}

console.log(`\nSending a test message to ${to} …\n`);

const response = await fetch("https://api.resend.com/emails", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    from,
    to: [to],
    subject: "Realtime Chat email test",
    text: "If you are reading this, login codes will reach your inbox.",
  }),
});

const body = await response.text();

if (response.ok) {
  ok("Resend accepted the message.");
  info(body);
  info("");
  info("Check the inbox (and the spam folder) for the test message.");
  process.exit(0);
}

bad(`Resend rejected the request (HTTP ${response.status}).`);
info(body);
info("");

// The three failures that actually happen in practice.
if (response.status === 401) {
  info("401 means the API key is wrong or was revoked.");
  info("Create a fresh one at https://resend.com/api-keys");
} else if (response.status === 403) {
  info("403 is about EMAIL_FROM — the address mail is sent *from*, which is");
  info("not your own inbox. You cannot send from gmail.com (or any domain you");
  info("do not control); Resend has to verify ownership first.");
  info("");
  info("Either keep the shared sender:");
  info('  EMAIL_FROM="Realtime Chat <onboarding@resend.dev>"');
  info("which only delivers to the address that owns the Resend account, or");
  info("verify a domain at https://resend.com/domains to email anyone else.");
} else if (response.status === 422) {
  info("422 means the payload was rejected — most often a malformed");
  info("EMAIL_FROM. It must look like: Name <user@domain.com>");
}

process.exit(1);
