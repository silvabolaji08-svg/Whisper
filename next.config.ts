import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Tests build into their own directory so `npm test` never fights a running
  // `next dev` over .next (and so Next's one-dev-server-per-directory lock
  // does not block the suite).
  distDir: process.env.NEXT_DIST_DIR ?? ".next",

  // Neither survives being bundled into a Route Handler: PGlite ships a WASM
  // build whose loader breaks, and pg resolves native bindings at runtime.
  // Opting them out makes Next require() them normally.
  serverExternalPackages: ["@electric-sql/pglite", "pg"],

  turbopack: {
    // Pin the workspace root, otherwise Turbopack walks up and finds an unrelated
    // package-lock.json in the home directory.
    root: path.resolve(__dirname),
  },
};

export default nextConfig;
