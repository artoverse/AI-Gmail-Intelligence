import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone output — required for Render (and Vercel) production deployments
  // This packages only the required files instead of the full node_modules
  output: "standalone",

  // Externalize heavy server-only packages from the edge runtime
  serverExternalPackages: ['googleapis', '@google/generative-ai'],
};

export default nextConfig;
