import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    // Pin the workspace root, otherwise Turbopack walks up and finds an unrelated
    // package-lock.json in the home directory.
    root: path.resolve(__dirname),
  },
};

export default nextConfig;
