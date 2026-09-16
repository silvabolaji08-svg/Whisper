import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Tests build into their own directory so `npm test` never fights a running
  // `next dev` over .next (and so Next's one-dev-server-per-directory lock
  // does not block the suite).
  distDir: process.env.NEXT_DIST_DIR ?? ".next",

  turbopack: {
    // Pin the workspace root, otherwise Turbopack walks up and finds an unrelated
    // package-lock.json in the home directory.
    root: path.resolve(__dirname),
  },
};

export default nextConfig;
