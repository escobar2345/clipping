/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Remotion's renderer is server-only — keep it out of the client bundle
  experimental: {
    serverExternalPackages: ["@remotion/renderer", "@remotion/bundler"],
  },
};

export default nextConfig;