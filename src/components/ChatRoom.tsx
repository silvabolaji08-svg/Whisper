"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import Link from "next/link";

import ThemeToggle from "@/components/ThemeToggle";
import {
  AlertIcon,
  ArrowDownIcon,
  ArrowLeftIcon,
  CheckIcon,
  CloseIcon,
  LinkIcon,
  MessageIcon,
  SendIcon,
} from "@/components/icons";
import { useChat, type ConnectionStatus } from "@/lib/useChat";
import { useStoredName } from "@/lib/useStoredName";
import { avatarClass, initial } from "@/lib/avatar";
import { cleanText, MAX_MESSAGE_LENGTH, MAX_USERNAME_LENGTH } from "@/lib/types";
import type { ChatMessage } from "@/lib/types";

/** Treat consecutive messages from one person within this window as a single group. */
const GROUPING_WINDOW_MS = 5 * 60 * 1000;
/** Below this distance from the bottom the view is considered "pinned". */
const PIN_THRESHOLD_PX = 80;
/** Composer grows with content up to this height, then scrolls internally. */
const COMPOSER_MAX_PX = 160;

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

const dayFormatter = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  month: "long",
  day: "numeric",
});

function dayKey(timestamp: number): string {
  const d = new Date(timestamp);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** "Today"/"Yesterday" where it helps, otherwise the full date. */
function dayLabel(timestamp: number): string {
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);

  if (dayKey(timestamp) === dayKey(today.getTime())) return "Today";
  if (dayKey(timestamp) === dayKey(yesterday.getTime())) return "Yesterday";
  return dayFormatter.format(timestamp);
}

const STATUS_META: Record<ConnectionStatus, { label: string; color: string }> = {
  connecting: { label: "Connecting", color: "var(--away)" },
  online: { label: "Live", color: "var(--online)" },
  offline: { label: "Offline", color: "var(--danger)" },
};

/** Prompt shown when we have no stored display name (e.g. someone opened a room link directly). */
function NamePrompt({
  room,
  onSubmit,
}: {
  room: string;
  onSubmit: (name: string) => void;
}) {
  const [value, setValue] = useState("");

  return (
    <div className="flex flex-1 flex-col">
      <header className="flex justify-end p-4">
        <ThemeToggle />
      </header>
      <main className="flex flex-1 items-center justify-center px-4 pb-16">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const name = cleanText(value, MAX_USERNAME_LENGTH);
            if (name) onSubmit(name);
          }}
          className="w-full max-w-sm space-y-5 rounded-2xl border border-border-default bg-surface p-7 shadow-(--shadow-lg)"
        >
          <div>
            <h1 className="font-display text-xl font-semibold">
              Choose a display name
            </h1>
            <p className="mt-1.5 text-sm leading-relaxed text-fg-muted">
              This is how you will appear in{" "}
              <span className="font-medium text-fg">#{room}</span>.
            </p>
          </div>
          <div className="space-y-2">
            <label htmlFor="display-name" className="block text-sm font-medium">
              Display name
            </label>
            <input
              id="display-name"
              autoFocus
              value={value}
              onChange={(event) => setValue(event.target.value)}
              maxLength={MAX_USERNAME_LENGTH}
              placeholder="Ada"
              className="w-full rounded-xl border border-border-default bg-bg-elevated px-3.5 py-3 text-sm outline-none transition-colors duration-150 placeholder:text-fg-subtle hover:border-border-strong focus:border-primary focus:ring-4 focus:ring-primary/15"
            />
          </div>
          <button
            type="submit"
            className="w-full cursor-pointer rounded-xl px-4 py-3 text-sm font-semibold surface-brand shadow-(--shadow-md) transition-[filter,transform] duration-150 hover:brightness-110 active:scale-[0.99]"
          >
            Continue
          </button>
        </form>
      </main>
    </div>
  );
}

/** Overlapping avatars for the first few people present, with a +N overflow chip. */
function PresenceStack({ users }: { users: string[] }) {
  const shown = users.slice(0, 3);
  const extra = users.length - shown.length;

  if (users.length === 0) return null;

  return (
    <div className="flex items-center -space-x-2">
      {shown.map((user) => (
        <span
          key={user}
          title={user}
          className={`grid size-7 place-items-center rounded-full text-[11px] font-semibold text-white ring-2 ring-surface ${avatarClass(user)}`}
        >
          {initial(user)}
        </span>
      ))}
      {extra > 0 ? (
        <span className="grid size-7 place-items-center rounded-full bg-surface-muted text-[11px] font-semibold text-fg-muted ring-2 ring-surface">
          +{extra}
        </span>
      ) : null}
    </div>
  );
}

function TypingIndicator({ names }: { names: string[] }) {
  const label =
    names.length === 1
      ? `${names[0]} is typing`
      : names.length === 2
        ? `${names[0]} and ${names[1]} are typing`
        : `${names[0]} and ${names.length - 1} others are typing`;

  return (
    <div className="flex items-center gap-2.5 px-1 animate-fade-in">
      <span
        className="flex items-center gap-1 rounded-full bg-surface-muted px-2.5 py-1.5"
        aria-hidden="true"
      >
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="typing-dot size-1.5 rounded-full bg-fg-subtle"
          />
        ))}
      </span>
      <span className="truncate text-xs text-fg-subtle">{label}…</span>
    </div>
  );
}

export default function ChatRoom({ room }: { room: string }) {
  const [storedName, setStoredName] = useStoredName();
  // Set when someone names themselves here, so the room renders without waiting on storage.
  const [sessionName, setSessionName] = useState<string | null>(null);
  const username = sessionName ?? storedName;
  const [draft, setDraft] = useState("");
  const [copied, setCopied] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [unread, setUnread] = useState(0);

  const {
    messages,
    users,
    typingUsers,
    status,
    error,
    send,
    notifyTyping,
    dismissError,
  } = useChat(room, username ?? "");

  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const pinnedToBottom = useRef(true);
  const seenCount = useRef(0);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior });
    pinnedToBottom.current = true;
    setAtBottom(true);
    setUnread(0);
  }, []);

  // Only auto-scroll when the reader was already at the bottom, so scrolling back
  // through history is not yanked away by an incoming message. Anything that
  // arrives while scrolled up becomes an unread count on the jump button.
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node) return;

    const added = messages.length - seenCount.current;
    seenCount.current = messages.length;

    if (pinnedToBottom.current) {
      node.scrollTop = node.scrollHeight;
      setUnread(0);
    } else if (added > 0) {
      setUnread((count) => count + added);
    }
  }, [messages]);

  // Typing bubbles change the content height too, but must never steal scroll.
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (node && pinnedToBottom.current) node.scrollTop = node.scrollHeight;
  }, [typingUsers]);

  function handleScroll() {
    const node = scrollRef.current;
    if (!node) return;
    const distanceFromBottom =
      node.scrollHeight - node.scrollTop - node.clientHeight;
    const pinned = distanceFromBottom < PIN_THRESHOLD_PX;
    pinnedToBottom.current = pinned;
    setAtBottom(pinned);
    if (pinned) setUnread(0);
  }

  // Grow the composer with its content instead of showing a fixed-height box.
  useLayoutEffect(() => {
    const node = composerRef.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, COMPOSER_MAX_PX)}px`;
  }, [draft]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
    } catch {
      // Clipboard can be blocked; the URL bar is still the fallback.
    }
  }

  function submit(event?: FormEvent) {
    event?.preventDefault();
    const body = draft.trim();
    if (!body) return;
    pinnedToBottom.current = true;
    send(body);
    setDraft("");
    scrollToBottom();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends, Shift+Enter inserts a newline.
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  const items = useMemo(() => buildTimeline(messages), [messages]);
  const statusMeta = STATUS_META[status];
  const remaining = MAX_MESSAGE_LENGTH - draft.length;

  // `undefined` is the pre-hydration state, where the stored name is not readable yet.
  if (username === undefined) {
    return (
      <main className="flex flex-1 items-center justify-center p-6">
        <p className="text-sm text-fg-subtle animate-fade-in">Loading #{room}…</p>
      </main>
    );
  }

  if (!username) {
    return (
      <NamePrompt
        room={room}
        onSubmit={(name) => {
          setStoredName(name);
          setSessionName(name);
        }}
      />
    );
  }

  return (
    // Pinned to exactly one viewport so the message list is the only thing that
    // scrolls — the header and composer stay put.
    <main className="flex h-dvh flex-col overflow-hidden">
      <header className="z-10 flex shrink-0 items-center gap-2 border-b border-border-default bg-surface/85 px-3 py-2.5 backdrop-blur-md sm:px-4">
        <Link
          href="/"
          aria-label="Back to rooms"
          title="Back to rooms"
          className="grid size-11 shrink-0 place-items-center rounded-xl text-fg-muted transition-colors duration-150 hover:bg-surface-hover hover:text-fg"
        >
          <ArrowLeftIcon />
        </Link>

        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 truncate font-display text-base font-semibold">
            <span className="truncate">#{room}</span>
            <span
              className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-medium text-fg-muted"
              title={`Connection: ${statusMeta.label}`}
            >
              <span
                className="size-1.5 rounded-full"
                style={{ backgroundColor: statusMeta.color }}
                aria-hidden="true"
              />
              {statusMeta.label}
            </span>
          </h1>
          <p className="truncate text-xs text-fg-subtle">
            {users.length === 1 ? "1 person here" : `${users.length} people here`}
            {users.length > 0 ? ` · ${users.join(", ")}` : ""}
          </p>
        </div>

        <div className="hidden sm:block">
          <PresenceStack users={users} />
        </div>

        <button
          type="button"
          onClick={copyLink}
          aria-label={copied ? "Room link copied" : "Copy room link"}
          title={copied ? "Copied" : "Copy room link"}
          className="grid size-11 shrink-0 cursor-pointer place-items-center rounded-xl text-fg-muted transition-colors duration-150 hover:bg-surface-hover hover:text-fg"
        >
          {copied ? (
            <CheckIcon style={{ color: "var(--online)" }} />
          ) : (
            <LinkIcon />
          )}
        </button>
        <ThemeToggle />
      </header>

      {/* Politely announced so a screen reader hears the copy confirmation. */}
      <span aria-live="polite" className="sr-only">
        {copied ? "Room link copied to clipboard" : ""}
      </span>

      {error ? (
        <div
          role="alert"
          className="flex shrink-0 items-center gap-2.5 border-b border-border-default bg-danger-soft px-4 py-2.5 text-sm text-danger animate-fade-in"
        >
          <AlertIcon size={18} className="shrink-0" />
          <span className="flex-1">{error}</span>
          <button
            type="button"
            onClick={dismissError}
            aria-label="Dismiss message"
            className="grid size-8 shrink-0 cursor-pointer place-items-center rounded-lg transition-colors duration-150 hover:bg-danger/10"
          >
            <CloseIcon size={16} />
          </button>
        </div>
      ) : null}

      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="scrollbar-thin flex-1 space-y-1 overflow-y-auto px-3 py-6 sm:px-6"
        >
          {items.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center animate-fade-in">
              <span
                className="grid size-12 place-items-center rounded-2xl bg-surface-muted text-fg-subtle"
                aria-hidden="true"
              >
                <MessageIcon size={24} />
              </span>
              <p className="font-display text-base font-medium">
                No messages yet
              </p>
              <p className="max-w-xs text-sm leading-relaxed text-fg-subtle">
                Say hello, or copy the room link to invite someone into #{room}.
              </p>
            </div>
          ) : (
            items.map((item) =>
              item.kind === "day" ? (
                <div
                  key={item.key}
                  className="flex items-center gap-3 py-4"
                  role="separator"
                  aria-label={item.label}
                >
                  <span className="h-px flex-1 bg-border-default" />
                  <span className="text-[11px] font-medium tracking-wide text-fg-subtle uppercase">
                    {item.label}
                  </span>
                  <span className="h-px flex-1 bg-border-default" />
                </div>
              ) : (
                <MessageGroup
                  key={item.group.id}
                  group={item.group}
                  isOwn={item.group.username === username}
                />
              ),
            )
          )}

          {typingUsers.length > 0 ? (
            <div className="pt-2">
              <TypingIndicator names={typingUsers} />
            </div>
          ) : null}
        </div>

        {/* Jump-to-latest, shown only once the reader has scrolled away. */}
        {!atBottom ? (
          <button
            type="button"
            onClick={() => scrollToBottom("smooth")}
            className="absolute bottom-4 left-1/2 flex -translate-x-1/2 cursor-pointer items-center gap-2 rounded-full border border-border-default bg-surface px-4 py-2.5 text-xs font-medium shadow-(--shadow-lg) transition-colors duration-150 hover:bg-surface-hover animate-pop-in"
          >
            <ArrowDownIcon size={16} />
            {unread > 0
              ? `${unread} new message${unread === 1 ? "" : "s"}`
              : "Jump to latest"}
          </button>
        ) : null}
      </div>

      <div className="shrink-0 border-t border-border-default bg-surface/85 px-3 py-3 backdrop-blur-md sm:px-4">
        <form onSubmit={submit} className="flex items-end gap-2">
          <div className="relative flex-1">
            <label htmlFor="composer" className="sr-only">
              Message #{room}
            </label>
            <textarea
              id="composer"
              ref={composerRef}
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                notifyTyping(event.target.value.trim().length > 0);
              }}
              onBlur={() => notifyTyping(false)}
              onKeyDown={handleKeyDown}
              rows={1}
              maxLength={MAX_MESSAGE_LENGTH}
              placeholder={`Message #${room}`}
              className="scrollbar-thin block w-full resize-none rounded-2xl border border-border-default bg-bg-elevated px-4 py-3 text-sm leading-relaxed outline-none transition-colors duration-150 placeholder:text-fg-subtle hover:border-border-strong focus:border-primary focus:ring-4 focus:ring-primary/15"
              style={{ maxHeight: COMPOSER_MAX_PX }}
            />
            {/* Only warn as the cap gets close, rather than counting always. */}
            {remaining <= 200 ? (
              <span className="absolute right-3 bottom-1.5 text-[11px] text-fg-subtle">
                {remaining}
              </span>
            ) : null}
          </div>

          <button
            type="submit"
            disabled={!draft.trim() || status !== "online"}
            aria-label="Send message"
            title={status === "online" ? "Send message" : "Not connected"}
            className="grid size-12 shrink-0 cursor-pointer place-items-center rounded-2xl surface-brand shadow-(--shadow-md) transition-[filter,transform,opacity] duration-150 hover:brightness-110 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
          >
            <SendIcon />
          </button>
        </form>
        <p className="mt-1.5 px-1 text-[11px] text-fg-subtle">
          <kbd className="font-sans font-medium">Enter</kbd> to send ·{" "}
          <kbd className="font-sans font-medium">Shift</kbd> +{" "}
          <kbd className="font-sans font-medium">Enter</kbd> for a new line
        </p>
      </div>
    </main>
  );
}

type Group = {
  id: string;
  username: string;
  createdAt: number;
  messages: ChatMessage[];
};

type TimelineItem =
  | { kind: "day"; key: string; label: string }
  | { kind: "group"; group: Group };

/** Flattens messages into day separators plus author-grouped runs. */
function buildTimeline(messages: ChatMessage[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  let currentDay: string | null = null;
  let last: Group | null = null;

  for (const message of messages) {
    const day = dayKey(message.createdAt);
    if (day !== currentDay) {
      currentDay = day;
      last = null; // A day break always starts a fresh group.
      items.push({ kind: "day", key: day, label: dayLabel(message.createdAt) });
    }

    const closeInTime =
      last !== null &&
      message.createdAt - last.messages[last.messages.length - 1].createdAt <
        GROUPING_WINDOW_MS;

    if (last && last.username === message.username && closeInTime) {
      last.messages.push(message);
    } else {
      last = {
        id: message.id,
        username: message.username,
        createdAt: message.createdAt,
        messages: [message],
      };
      items.push({ kind: "group", group: last });
    }
  }

  return items;
}

function MessageGroup({ group, isOwn }: { group: Group; isOwn: boolean }) {
  return (
    <div
      className={`flex gap-2.5 py-1.5 animate-message-in ${isOwn ? "flex-row-reverse" : ""}`}
    >
      <div
        className={`mt-auto grid size-8 shrink-0 place-items-center rounded-full text-xs font-semibold text-white shadow-(--shadow-sm) ${avatarClass(group.username)}`}
        aria-hidden="true"
      >
        {initial(group.username)}
      </div>

      <div
        className={`flex min-w-0 max-w-[min(75%,42rem)] flex-col ${isOwn ? "items-end" : "items-start"}`}
      >
        <div
          className={`mb-1 flex items-baseline gap-2 px-1 text-xs ${isOwn ? "flex-row-reverse" : ""}`}
        >
          <span className="font-medium text-fg-muted">
            {isOwn ? "You" : group.username}
          </span>
          <time
            dateTime={new Date(group.createdAt).toISOString()}
            className="text-fg-subtle"
          >
            {timeFormatter.format(group.createdAt)}
          </time>
        </div>

        <div
          className={`flex w-full flex-col gap-1 ${isOwn ? "items-end" : "items-start"}`}
        >
          {group.messages.map((message, index) => {
            const isLast = index === group.messages.length - 1;
            // Square off the corner nearest the avatar on the last bubble so the
            // run reads as one unit pointing at its author.
            const tail = isOwn
              ? isLast
                ? "rounded-br-md"
                : ""
              : isLast
                ? "rounded-bl-md"
                : "";

            return (
              <p
                key={message.id}
                className={`max-w-full rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap wrap-break-word ${tail} ${
                  isOwn ? "" : "border border-border-default shadow-(--shadow-sm)"
                }`}
                style={
                  isOwn
                    ? {
                        background: "var(--bubble-own)",
                        color: "var(--bubble-own-fg)",
                      }
                    : {
                        background: "var(--bubble-peer)",
                        color: "var(--bubble-peer-fg)",
                      }
                }
              >
                {message.text}
              </p>
            );
          })}
        </div>
      </div>
    </div>
  );
}
