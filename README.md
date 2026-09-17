# Whisper

A multi-room realtime chat app built with Next.js (App Router), Socket.IO, and SQLite.

## Features

- **Passwordless accounts** — sign in with a one-time code emailed to you. No
  passwords are stored, so there are none to leak or reset.
- **Live messaging** over WebSockets — messages appear instantly for everyone in a room.
- **Multiple rooms** addressed by URL (`/r/general`). Share the link to invite someone.
- **Presence** — see who is currently in the room, with a live connection indicator.
- **Typing indicators** that expire on their own if someone stops mid-sentence.
- **Persistent history** — the last 100 messages per room are stored in SQLite and
  replayed to anyone who joins later.
- **Rate limiting** — 15 messages per 10 seconds per connection.
- **Light and dark themes** that follow the OS by default, with a manual toggle that
  persists and applies before first paint (no flash of the wrong theme).
- **Chat UX** — messages grouped by author, day separators, an auto-growing composer,
  a jump-to-latest button with an unread count, copy-room-link, and Enter-to-send
  (Shift+Enter for a newline).

## Requirements

Node.js **22.5 or newer**. The app uses the built-in `node:sqlite` module, so there is
no native database dependency to compile.

## Getting started

```bash
npm install
cp .env.example .env.local   # optional for local development
npm run dev
```

Open http://localhost:3000 and sign in with your email address.

**Without an email provider configured, the login code is printed to the terminal
running `npm run dev`** — copy it from there. That is all you need to develop locally;
see [Email delivery](#email-delivery) to send real messages.

Once signed in, pick a room, then open the same room in a second browser window (or a
private window, signed in as a different address) to see messages sync live.

## Scripts

| Script          | What it does                                          |
| --------------- | ----------------------------------------------------- |
| `npm run dev`   | Custom server with Socket.IO, watching for changes    |
| `npm run build` | Production build of the Next.js app                   |
| `npm start`     | Runs the production build (run `build` first)         |
| `npm run typecheck` | TypeScript, no emit                               |
| `npm test`      | End-to-end tests against a real server (see below)    |
| `npm run email:check` | Verify email delivery is configured (see below) |
| `npm run lint`  | ESLint                                                |

`npm run dev:next` starts Next.js alone, without the socket server — useful only for
working on pages in isolation, since chat will not connect.

## How it works

```
server.ts          Local/self-hosted server: Next.js + the WebSocket endpoint
src/lib/realtime/  Frame protocol, connection logic, and the presence hub
src/app/api/socket/ The same endpoint as a Vercel Route Handler
src/lib/db.ts      SQLite persistence (node:sqlite)
src/lib/types.ts   Shared message/event types and input validation
src/lib/useChat.ts Client hook owning the socket lifecycle and reconnects
src/lib/useTheme.ts Theme store + the pre-paint init script
src/lib/database.ts Postgres access (node-postgres, or PGlite locally)
src/lib/auth/      Login codes, sessions, and email delivery
src/app/api/auth/  Sign-in, verify, sign-out and profile endpoints
src/app/login/     Sign-in screen
src/components/    Chat UI, icon set, theme toggle
src/app/globals.css Semantic design tokens for both themes
src/app/r/[room]/  Room route
tests/             End-to-end tests
```

The server is the single source of truth. A client emits `join`, `message`, and
`typing`; the server validates and persists, then broadcasts `history`, `message`,
`presence`, and `typing` back to the room. Usernames and message bodies are stripped of
control characters and length-capped on both ends, and room names are normalized to a
URL-safe slug so one room can never split across two URLs.

Messages are stored in `data/chat.db`, which is gitignored. Delete that file to reset
all history. Set `CHAT_DATA_DIR` to put the database elsewhere, such as a mounted
volume in production.

## Accounts and sign-in

Sign-in is passwordless. You enter an email address, receive a six-digit code, and
enter it. Signing up and logging in are the same flow: the account is created the
first time an address proves it can receive a code.

There are no passwords anywhere in the system — nothing to hash, reset, or leak.

**What the server stores.** Codes and session tokens are never written in the clear:

- Login codes are kept as an HMAC-SHA256 keyed with `AUTH_SECRET`. A plain hash would
  be pointless, since six digits is only a million candidates and would fall to a
  lookup table instantly.
- Session tokens are 32 random bytes; only their SHA-256 is stored.

**How a code is protected.** It expires after 10 minutes, survives at most 5 wrong
guesses, is single-use, and is invalidated the moment a newer code is requested. An
address may request 5 codes per hour. Comparison is constant-time.

**Sessions** last 30 days in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` in
production), so no script on the page can read the token.

**The socket is authenticated too.** The browser sends the session cookie with the
WebSocket upgrade, and the server resolves it to an account before any event is
handled. A connection without a valid session is refused outright.

Crucially, the display name in a message comes from the **account**, never from the
client payload — so a modified client cannot post as someone else.

### Email delivery

Codes are sent with [Resend](https://resend.com). Set `RESEND_API_KEY` and
`EMAIL_FROM` in `.env.local`. `EMAIL_FROM` must use a domain verified in Resend;
the default `onboarding@resend.dev` only delivers to the address that owns the
Resend account, which is fine for a first test.

To confirm a key works before relying on it:

```bash
npm run email:check                       # report configuration only
npm run email:check you@example.com       # also send a real test message
```

It reads `.env.local`, so the key never goes on the command line, and it
explains the specific failure when Resend rejects a request.

With no key set, codes are printed to the server console instead. In production that
fallback is refused outright — a deploy that forgot the key fails loudly rather than
appearing to work while no mail is ever sent. `AUTH_DEV_CONSOLE_CODES=true` forces console output even when a key *is*
configured — the test suite relies on it, since Next loads `.env.local`
automatically and a developer's own key would otherwise break the suite.

## Testing

```bash
npm test
```

The suite boots the real server on a free port with a throwaway SQLite database
(`CHAT_DATA_DIR`) and drives it over actual HTTP and Socket.IO connections. Nothing is
mocked, so it catches the integration bugs unit tests miss.

It signs in the way a person does — requesting a code, reading it from the server's
console output, and exchanging it for a session — then covers:

- the OTP flow: wrong codes, reuse of a spent code, supersession by a newer code, and
  the cookie's `HttpOnly`/`SameSite` flags
- the socket refusing connections with no cookie, a forged token, or a signed-out one
- identity coming from the account rather than the client payload
- presence, broadcast fan-out, room isolation, typing indicators, history replay
- the rate limiter, including that it survives a reconnect

A `pretest` step builds into `.next-test`, separate from `.next`, so `npm test` works
**while `npm run dev` is running** — Next allows only one dev server per directory.

`.github/workflows/ci.yml` runs lint, typecheck and the suite on every push and pull
request. It needs no services or secrets: the tests use a throwaway SQLite database
and read login codes from the server's own console output.

## Theming

Colour lives in one place: the semantic tokens at the top of `src/app/globals.css`
(`--bg`, `--fg-muted`, `--bubble-own`, …), defined once for light and again for dark.
Components only ever reference a token, so changing a palette never means touching a
component.

The theme follows the OS unless someone uses the toggle, which writes `data-theme` to
`<html>` and remembers the choice. An inline script in `<head>` applies the stored
value before the first paint.

## Deploying

The app runs in two shapes from one codebase.

### On a long-lived host (Railway, Render, Fly.io, a VPS)

`server.ts` serves both Next.js and the WebSocket endpoint. Nothing external is
required beyond email:

```bash
npm run build
npm start        # honours PORT
```

Set `AUTH_SECRET` and `RESEND_API_KEY`. Without `DATABASE_URL` the app keeps its
data in PGlite under `CHAT_DATA_DIR`, so point that at a mounted volume, or set
`DATABASE_URL` and use a managed Postgres.

### On Vercel

Vercel does not run custom servers, so `server.ts` is not used there. The
WebSocket endpoint is the Route Handler at `src/app/api/socket/route.ts`, built
on Vercel's `experimental_upgradeWebSocket`. Both call the same code; only the
upgrade differs.

The two are served from **different paths** — `/api/socket` on Vercel, `/_ws`
on the custom server — and the page tells the client which to use. They have to
differ: Next's own upgrade handler ends any upgrade whose path matches a route
and only leaves unmatched paths alone for a custom WebSocket server, so the
local socket cannot share a path with the Route Handler.

Because functions have no disk and no shared memory, two services are required:

1. **Postgres** — add Neon from the Vercel Marketplace. It sets `DATABASE_URL`.
2. **Redis** — add Upstash from the Marketplace, and expose it as `REDIS_URL`.
   Without it, presence and fan-out break as soon as two people land on
   different instances.

Then set `AUTH_SECRET` and `RESEND_API_KEY` in the project's environment
variables and deploy.

**Expect a reconnect every few minutes.** A WebSocket is closed when the
function reaches its maximum duration — 300 seconds on Hobby, and extended
durations are Pro-only. The client treats this as routine: it reconnects with
jittered backoff, holds the "Live" indicator through a short grace period,
queues anything typed while the socket is down, and de-duplicates replayed
messages. Billing is Active-CPU, so idle connection time is not charged.

WebSocket support on Vercel is in public beta and the Next.js binding is still
named `experimental_upgradeWebSocket`.

## Known constraints

- Rooms are private only by obscurity: any **signed-in** user who has the URL can
  join. There is no per-room membership or invite list yet.
- The Vercel Route Handler transport can only be exercised by deploying; the
  shared connection logic underneath it is covered by the test suite through the
  local `ws` transport.
- Display names are not unique, so two accounts can pick the same one. Messages are
  attributed to the account, but the name shown is not a reliable identifier.
- Deliverability depends on your Resend domain setup; an unverified domain will land
  codes in spam.
- Presence is per connection, so one person with two tabs open appears once by name but
  holds two connections.
- `node:sqlite` is still marked experimental by Node and prints a warning on startup.
