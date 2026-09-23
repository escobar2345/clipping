/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Remotion pulls in native binaries (rspack .node files) and esbuild that
  // webpack cannot parse. Mark them external so Next.js `require()`s them at
  // runtime instead of bundling. NOTE: on Next 14.x this lives under
  // experimental.serverComponentsExternalPackages (top-level
  // serverExternalPackages is a Next 15.1+ key and is ignored here).
  experimental: {
    serverComponentsExternalPackages: [
      "@remotion/bundler",
      "@remotion/renderer",
      "esbuild",
      "@rspack/core",
    ],
  },
};

export default nextConfig;