"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import ThemeToggle from "@/components/ThemeToggle";
import Wordmark from "@/components/Wordmark";
import {
  AlertIcon,
  CheckIcon,
  LogoutIcon,
  MessageIcon,
  PencilIcon,
  ShuffleIcon,
} from "@/components/icons";
import { avatarClass, initial } from "@/lib/avatar";
import { normalizeRoom, MAX_ROOM_LENGTH, MAX_USERNAME_LENGTH } from "@/lib/types";

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

export default function JoinForm({
  displayName: initialName,
  email,
}: {
  displayName: string;
  email: string;
}) {
  const router = useRouter();

  const [room, setRoom] = useState("general");
  const [error, setError] = useState<string | null>(null);

  const [displayName, setDisplayName] = useState(initialName);
  const [nameDraft, setNameDraft] = useState(initialName);
  const [editingName, setEditingName] = useState(false);
  const [savingName, setSavingName] = useState(false);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const slug = normalizeRoom(room);
    if (!slug) {
      setError("Room names need at least one letter or number.");
      return;
    }
    router.push(`/r/${slug}`);
  }

  async function saveName() {
    const next = nameDraft.trim();
    if (!next || next === displayName) {
      setEditingName(false);
      setNameDraft(displayName);
      return;
    }

    setSavingName(true);
    try {
      const response = await fetch("/api/auth/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: next }),
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        setError(data.error ?? "Could not save that name.");
        setNameDraft(displayName);
      } else {
        setDisplayName(data.user.displayName);
        setNameDraft(data.user.displayName);
        setError(null);
      }
    } catch {
      setError("Could not save that name.");
      setNameDraft(displayName);
    } finally {
      setSavingName(false);
      setEditingName(false);
    }
  }

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    router.replace("/login");
    router.refresh();
  }

  return (
    <div className="relative flex flex-1 flex-col overflow-hidden">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10"
        style={{
          background:
            "radial-gradient(60rem 30rem at 50% -10%, var(--primary-soft), transparent 70%)",
        }}
      />

      <header className="flex items-center justify-end gap-1 p-4">
        <ThemeToggle />
        <button
          type="button"
          onClick={signOut}
          aria-label="Sign out"
          title="Sign out"
          className="grid size-11 shrink-0 cursor-pointer place-items-center rounded-xl text-fg-muted transition-colors duration-150 hover:bg-surface-hover hover:text-fg"
        >
          <LogoutIcon />
        </button>
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
            <h1 className="text-5xl sm:text-6xl">
              <Wordmark />
            </h1>
            <p className="mt-2.5 max-w-sm text-sm leading-relaxed text-fg-muted">
              Pick a room. Anyone who opens the same room joins the conversation.
            </p>
          </div>

          <div className="space-y-4 rounded-2xl border border-border-default bg-surface p-6 shadow-(--shadow-lg) sm:p-7">
            {/* Who you are in the room, editable in place. */}
            <div className="flex items-center gap-3 rounded-xl bg-surface-muted p-3">
              <span
                className={`grid size-10 shrink-0 place-items-center rounded-full text-sm font-semibold text-white ${avatarClass(displayName)}`}
                aria-hidden="true"
              >
                {initial(displayName)}
              </span>

              {editingName ? (
                <>
                  <label htmlFor="display-name" className="sr-only">
                    Display name
                  </label>
                  <input
                    id="display-name"
                    autoFocus
                    value={nameDraft}
                    maxLength={MAX_USERNAME_LENGTH}
                    onChange={(event) => setNameDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") saveName();
                      if (event.key === "Escape") {
                        setNameDraft(displayName);
                        setEditingName(false);
                      }
                    }}
                    className="min-w-0 flex-1 rounded-lg border border-border-default bg-bg-elevated px-2.5 py-1.5 text-sm outline-none focus:border-primary"
                  />
                  <button
                    type="button"
                    onClick={saveName}
                    disabled={savingName}
                    aria-label="Save display name"
                    className="grid size-9 shrink-0 cursor-pointer place-items-center rounded-lg text-fg-muted transition-colors duration-150 hover:bg-surface-hover hover:text-fg disabled:opacity-50"
                  >
                    <CheckIcon size={18} />
                  </button>
                </>
              ) : (
                <>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {displayName}
                    </span>
                    <span className="block truncate text-xs text-fg-subtle">
                      {email}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => setEditingName(true)}
                    aria-label="Change display name"
                    title="Change display name"
                    className="grid size-9 shrink-0 cursor-pointer place-items-center rounded-lg text-fg-muted transition-colors duration-150 hover:bg-surface-hover hover:text-fg"
                  >
                    <PencilIcon size={16} />
                  </button>
                </>
              )}
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
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
          </div>

          <p className="mt-5 text-center text-xs leading-relaxed text-fg-subtle">
            Open this page in a second window to talk to yourself and see it work.
          </p>
        </div>
      </main>
    </div>
  );
}
