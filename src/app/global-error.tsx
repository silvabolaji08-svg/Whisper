"use client";

import { useEffect } from "react";

/**
 * Last-resort boundary for failures in the root layout itself.
 *
 * This file replaces the root layout when active, so it must render its own
 * <html>/<body> and cannot rely on globals.css or the font variables — every
 * style here is inline on purpose. `metadata` is unavailable in a Client
 * Component, hence the React <title>.
 */
export default function GlobalError({
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
    // global-error must include html and body tags
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "1.5rem",
          // No app theme reaches this document, so follow the OS preference.
          colorScheme: "light dark",
          background: "Canvas",
          color: "CanvasText",
          fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
          lineHeight: 1.6,
        }}
      >
        <title>Something went wrong · Whisper</title>
        <main style={{ maxWidth: "26rem", textAlign: "center" }}>
          <h1
            style={{
              margin: "0 0 0.5rem",
              fontSize: "1.25rem",
              letterSpacing: "-0.015em",
            }}
          >
            Something went wrong
          </h1>
          <p style={{ margin: "0 0 1.5rem", opacity: 0.75, fontSize: "0.9rem" }}>
            The app failed to start. Try again, and check the server logs if this
            keeps happening.
          </p>
          {error.digest ? (
            <p
              style={{
                margin: "0 0 1.5rem",
                opacity: 0.6,
                fontSize: "0.75rem",
                fontFamily: "ui-monospace, monospace",
              }}
            >
              Reference: {error.digest}
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => retry()}
            style={{
              cursor: "pointer",
              borderRadius: "0.75rem",
              border: "none",
              background: "#2563eb",
              color: "#ffffff",
              padding: "0.75rem 1.5rem",
              fontSize: "0.875rem",
              fontWeight: 600,
              fontFamily: "inherit",
            }}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
