"use client"; // Error boundaries must be Client Components.

import { useEffect } from "react";
import Link from "next/link";

import { AlertIcon, ArrowLeftIcon, RefreshIcon } from "@/components/icons";

export default function Error({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="flex flex-1 items-center justify-center px-4 py-16">
      <div className="w-full max-w-md rounded-2xl border border-border-default bg-surface p-7 text-center shadow-(--shadow-lg)">
        <span
          className="mx-auto mb-5 grid size-12 place-items-center rounded-2xl bg-danger-soft text-danger"
          aria-hidden="true"
        >
          <AlertIcon size={24} />
        </span>
        <h1 className="font-display text-xl font-semibold">
          Something went wrong
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-fg-muted">
          The chat ran into an unexpected error. Trying again usually clears it.
        </p>
        {error.digest ? (
          <p className="mt-3 font-mono text-xs text-fg-subtle">
            Reference: {error.digest}
          </p>
        ) : null}

        <div className="mt-6 flex flex-col gap-2 sm:flex-row">
          <button
            type="button"
            onClick={() => retry()}
            className="flex flex-1 cursor-pointer items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold surface-brand shadow-(--shadow-md) transition-[filter,transform] duration-150 hover:brightness-110 active:scale-[0.99]"
          >
            <RefreshIcon size={18} />
            Try again
          </button>
          <Link
            href="/"
            className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-border-default bg-bg-elevated px-4 py-3 text-sm font-medium transition-colors duration-150 hover:bg-surface-hover"
          >
            <ArrowLeftIcon size={18} />
            Back to rooms
          </Link>
        </div>
      </div>
    </main>
  );
}
