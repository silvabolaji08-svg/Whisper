"use client";

import { useCallback, useSyncExternalStore } from "react";

const NAME_STORAGE_KEY = "chat:username";

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Keep other tabs in sync when the name changes there.
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

function getSnapshot(): string | null {
  try {
    return localStorage.getItem(NAME_STORAGE_KEY);
  } catch {
    // Storage can throw in private browsing; behave as if no name is stored.
    return null;
  }
}

// `undefined` means "not known yet" — the value during SSR and hydration. Callers
// use it to hold off rendering rather than flashing the wrong state for a frame.
function getServerSnapshot(): string | null | undefined {
  return undefined;
}

/**
 * The display name persisted in localStorage, read through an external store so
 * it never has to be copied into state inside an effect.
 */
export function useStoredName() {
  const name = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const setName = useCallback((value: string) => {
    try {
      localStorage.setItem(NAME_STORAGE_KEY, value);
    } catch {
      // Non-fatal: the caller keeps the name in component state for this session.
    }
    for (const listener of listeners) listener();
  }, []);

  return [name, setName] as const;
}
