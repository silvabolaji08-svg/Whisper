"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import ThemeToggle from "@/components/ThemeToggle";
import { AlertIcon, MessageIcon, ShuffleIcon } from "@/components/icons";
import { useStoredName } from "@/lib/useStoredName";
import {
  cleanText,
  normalizeRoom,
  MAX_ROOM_LENGTH,
  MAX_USERNAME_LENGTH,
} from "@/lib/types";

const ROOM_WORDS = [
  "amber", "basalt", "cedar", "delta", "ember", "flint",
  "garnet", "harbor", "indigo", "juniper", "kestrel", "lumen",
];

function suggestRoom(): string {
  const word = ROOM_WORDS[Math.floor(Math.random() * ROOM_WORDS.length)];
  return `${word}-${Math.floor(Math.random() * 900 + 100)}`;
}

const inputClass =
  "w-full rounded-xl border border-border-default bg-bg-elevated px-3.5 py-3 text-sm text-fg outline-none transition-colors duration-150 placeholder:text-fg-subtle hover:border-border-strong focus:border-primary focus:ring-4 focus:ring-primary/15";

export default function JoinPage() {
  const router = useRouter();
  const [storedName, setStoredName] = useStoredName();

  // `null` means untouched, so the remembered name shows through until it is edited.
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const username = nameDraft ?? storedName ?? "";

  // A fixed default keeps server and client markup identical; Shuffle adds randomness.
  const [room, setRoom] = useState("general");
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();

    const name = cleanText(username, MAX_USERNAME_LENGTH);
    const slug = normalizeRoom(room);

    if (!name) {
      setError("Enter a display name so others know who is talking.");
      return;
    }
    if (!slug) {
      setError("Room names need at least one letter or number.");
      return;
    }

    setStoredName(name);
    router.push(`/r/${slug}`);
  }

  return (
    <div className="relative flex flex-1 flex-col overflow-hidden">
      {/* Decorative colour wash behind the card. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10"
        style={{
          background:
            "radial-gradient(60rem 30rem at 50% -10%, var(--primary-soft), transparent 70%)",
        }}
      />

      <header className="flex justify-end p-4">
        <ThemeToggle />
      </header>

      <main className="flex flex-1 items-center justify-center px-4 pb-16">
        <div className="w-full max-w-md">
          <div className="mb-8 flex flex-col items-center text-center">
            <span
              className="mb-5 grid size-14 place-items-center rounded-2xl surface-brand shadow-(--shadow-md)"
              aria-hidden="true"
            >
              <MessageIcon size={26} />
            </span>
            <h1 className="font-display text-3xl font-semibold sm:text-4xl">
              Realtime Chat
            </h1>
            <p className="mt-2.5 max-w-sm text-sm leading-relaxed text-fg-muted">
              Pick a name and a room. Anyone who opens the same room joins the
              conversation.
            </p>
          </div>

          <form
            onSubmit={handleSubmit}
            className="space-y-5 rounded-2xl border border-border-default bg-surface p-6 shadow-(--shadow-lg) sm:p-7"
          >
            <div className="space-y-2">
              <label htmlFor="username" className="block text-sm font-medium">
                Display name
              </label>
              <input
                id="username"
                value={username}
                onChange={(event) => setNameDraft(event.target.value)}
                maxLength={MAX_USERNAME_LENGTH}
                autoComplete="nickname"
                placeholder="Ada"
                className={inputClass}
              />
            </div>

            <div className="space-y-2">
              <label htmlFor="room" className="block text-sm font-medium">
                Room
              </label>
              <div className="flex gap-2">
                <input
                  id="room"
                  value={room}
                  onChange={(event) => setRoom(event.target.value)}
                  maxLength={MAX_ROOM_LENGTH}
                  placeholder="general"
                  aria-describedby="room-hint"
                  className={inputClass}
                />
                <button
                  type="button"
                  onClick={() => setRoom(suggestRoom())}
                  aria-label="Suggest a random room name"
                  title="Suggest a random room name"
                  className="grid size-12 shrink-0 cursor-pointer place-items-center rounded-xl border border-border-default bg-bg-elevated text-fg-muted transition-colors duration-150 hover:bg-surface-hover hover:text-fg"
                >
                  <ShuffleIcon />
                </button>
              </div>
              <p id="room-hint" className="text-xs text-fg-subtle">
                Letters, numbers and dashes. Becomes the room URL.
              </p>
            </div>

            {error ? (
              <p
                role="alert"
                className="flex items-start gap-2 rounded-xl bg-danger-soft px-3.5 py-2.5 text-sm text-danger"
              >
                <AlertIcon size={18} className="mt-px shrink-0" />
                <span>{error}</span>
              </p>
            ) : null}

            <button
              type="submit"
              className="w-full cursor-pointer rounded-xl px-4 py-3 text-sm font-semibold surface-brand shadow-(--shadow-md) transition-[filter,transform] duration-150 hover:brightness-110 active:scale-[0.99]"
            >
              Join chat
            </button>
          </form>

          <p className="mt-5 text-center text-xs leading-relaxed text-fg-subtle">
            Open this page in a second window to talk to yourself and see it work.
          </p>
        </div>
      </main>
    </div>
  );
}
