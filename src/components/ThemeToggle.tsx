"use client";

import { useTheme } from "@/lib/useTheme";
import { MoonIcon, SunIcon } from "./icons";

/**
 * Icon-only control, so it carries its own accessible name. Both icons are
 * rendered and cross-faded — swapping one for the other would resize the button
 * on click and jitter the header.
 */
export default function ThemeToggle({ className = "" }: { className?: string }) {
  const { theme, toggle } = useTheme();

  // `undefined` until hydration; render the button but stay label-neutral.
  const known = theme !== undefined;

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={known ? "Switch colour theme" : "Colour theme"}
      title="Switch colour theme"
      className={`grid size-11 shrink-0 cursor-pointer place-items-center rounded-xl text-fg-muted transition-colors duration-150 hover:bg-surface-hover hover:text-fg ${className}`}
    >
      <span className="relative block size-5">
        <SunIcon className="theme-icon theme-icon-light" />
        <MoonIcon className="theme-icon theme-icon-dark" />
      </span>
    </button>
  );
}
