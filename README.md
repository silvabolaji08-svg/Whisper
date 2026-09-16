# Realtime Chat

A multi-room realtime chat app built with Next.js (App Router), Socket.IO, and SQLite.

## Features

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
npm run dev
```

Open http://localhost:3000, pick a display name and a room, then open the same room in
a second browser window to see messages sync live.

## Scripts

| Script          | What it does                                          |
| --------------- | ----------------------------------------------------- |
| `npm run dev`   | Custom server with Socket.IO, watching for changes    |
| `npm run build` | Production build of the Next.js app                   |
| `npm start`     | Runs the production build (run `build` first)         |
| `npm run lint`  | ESLint                                                |
| `npm test`      | End-to-end tests against a real server (see below)    |

`npm run dev:next` starts Next.js alone, without the socket server — useful only for
working on pages in isolation, since chat will not connect.

## How it works

```
server.ts          Custom Node server: Next.js request handler + Socket.IO
src/lib/db.ts      SQLite persistence (node:sqlite)
src/lib/types.ts   Shared message/event types and input validation
src/lib/useChat.ts Client hook owning the socket lifecycle
src/lib/useTheme.ts Theme store + the pre-paint init script
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

## Testing

```bash
npm test
```

The suite boots the real server on a free port with a throwaway SQLite database
(`CHAT_DATA_DIR`), then drives it over actual Socket.IO connections. It covers join
and room normalization, presence on join/leave, broadcast fan-out, room isolation,
the rate limiter, typing indicators, and history replay to a late joiner. Nothing is
mocked, so it catches the integration bugs unit tests miss.

## Theming

Colour lives in one place: the semantic tokens at the top of `src/app/globals.css`
(`--bg`, `--fg-muted`, `--bubble-own`, …), defined once for light and again for dark.
Components only ever reference a token, so changing a palette never means touching a
component.

The theme follows the OS unless someone uses the toggle, which writes `data-theme` to
`<html>` and remembers the choice. An inline script in `<head>` applies the stored
value before the first paint.

## Deploying

This app needs a host that supports **long-lived Node processes**, because Socket.IO
holds persistent WebSocket connections. Railway, Render, Fly.io, and a plain VPS all
work:

```bash
npm run build
npm start        # honours the PORT environment variable
```

It will **not** work on Vercel's serverless platform, which cannot hold open sockets. To
deploy there, replace the Socket.IO layer with a hosted realtime service such as Pusher,
Ably, or Supabase Realtime — the client hook in `src/lib/useChat.ts` and the handlers in
`server.ts` are the only places that would change.

## Known constraints

- Rooms are unauthenticated: anyone with the URL can join, and display names are not
  reserved. Add real auth before using this for anything private.
- Presence is per connection, so one person with two tabs open appears once by name but
  holds two connections.
- `node:sqlite` is still marked experimental by Node and prints a warning on startup.
