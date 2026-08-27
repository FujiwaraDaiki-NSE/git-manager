/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "standalone",
  // /api/* のプロキシは app/api/[...path]/route.ts が担う。
  // rewrites はビルド時に行き先が固定されるため使わない
};

export default nextConfig;
