import Link from "next/link";

import { ArrowLeftIcon, MessageIcon } from "@/components/icons";

export default function NotFound() {
  return (
    <main className="flex flex-1 items-center justify-center px-4 py-16">
      <div className="w-full max-w-md rounded-2xl border border-border-default bg-surface p-7 text-center shadow-(--shadow-lg)">
        <span
          className="mx-auto mb-5 grid size-12 place-items-center rounded-2xl bg-surface-muted text-fg-subtle"
          aria-hidden="true"
        >
          <MessageIcon size={24} />
        </span>
        <p className="font-display text-sm font-semibold tracking-widest text-fg-subtle uppercase">
          404
        </p>
        <h1 className="mt-1 font-display text-xl font-semibold">
          This page does not exist
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-fg-muted">
          The link may be mistyped. Rooms live at <code>/r/&lt;room&gt;</code> —
          pick one from the join screen.
        </p>

        <Link
          href="/"
          className="mt-6 flex items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold surface-brand shadow-(--shadow-md) transition-[filter,transform] duration-150 hover:brightness-110 active:scale-[0.99]"
        >
          <ArrowLeftIcon size={18} />
          Back to rooms
        </Link>
      </div>
    </main>
  );
}
