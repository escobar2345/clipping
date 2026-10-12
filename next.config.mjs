/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Remotion pulls in native binaries (rspack .node files) and esbuild that
  // webpack cannot parse. Mark them external so Next.js `require()`s them at
  // runtime instead of bundling. NOTE: on Next 14.x this lives under
  // experimental.serverComponentsExternalPackages (top-level
  // serverExternalPackages is a Next 15.1+ key and is ignored here).
  experimental: {
    // Runs instrumentation.ts once per server boot: installs resilient DNS
    // and creates the Postgres tables if they're missing.
    instrumentationHook: true,
    serverComponentsExternalPackages: [
      "@remotion/bundler",
      "@remotion/renderer",
      "esbuild",
      "@rspack/core",
    ],
  },
  // FilmCraft's WebAssembly editor is served statically from public/filmcraft.
  // Per its HOSTING.md it needs NO isolation headers (no SharedArrayBuffer) —
  // the only hard requirement is that .wasm is served as application/wasm so
  // the browser can stream-compile it. Next serves public/ with that MIME by
  // default; this rule is a belt-and-suspenders guarantee for the .wasm file.
  async headers() {
    return [
      {
        source: "/filmcraft/:file*.wasm",
        headers: [{ key: "Content-Type", value: "application/wasm" }],
      },
    ];
  },
};

export default nextConfig;