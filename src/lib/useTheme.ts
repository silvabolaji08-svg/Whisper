"use client";

import { useCallback, useSyncExternalStore } from "react";

export const THEME_STORAGE_KEY = "chat:theme";

/** `null` means "follow the OS", which is the default until someone toggles. */
export type Theme = "light" | "dark" | null;

/**
 * Inlined in <head> before paint so the stored theme is applied to <html>
 * synchronously. Without this the first frame renders in the OS theme and
 * flashes to the chosen one.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)});if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t);}catch(e){}})();`;

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

function getSnapshot(): Theme {
  const attr = document.documentElement.getAttribute("data-theme");
  return attr === "light" || attr === "dark" ? attr : null;
}

// Undefined during SSR/hydration: the server cannot know the stored theme.
function getServerSnapshot(): Theme | undefined {
  return undefined;
}

/** Returns whether dark is currently showing, accounting for the OS fallback. */
function resolves(theme: Theme): "light" | "dark" {
  if (theme) return theme;
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export function useTheme() {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const toggle = useCallback(() => {
    const next = resolves(getSnapshot()) === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Private browsing: the choice still applies for this page view.
    }
    for (const listener of listeners) listener();
  }, []);

  return { theme, toggle };
}
