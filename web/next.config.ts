import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // the repo root may hold an empty pnpm lockfile (from `pnpm demo`); this app's root is here
  turbopack: { root: __dirname },
  // no floating dev badge (it shows up in demo recordings)
  devIndicators: false,
};

export default nextConfig;
