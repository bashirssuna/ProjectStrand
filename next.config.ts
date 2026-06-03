import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  experimental: { serverActions: { bodySizeLimit: "25mb" } },
  // PGlite ships WASM + uses node APIs; the doc libraries pull in node/binary
  // deps — keep them all external to the server bundle.
  serverExternalPackages: ["@electric-sql/pglite", "mammoth", "xlsx", "unpdf", "docx", "pg"],
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },
};
export default nextConfig;
