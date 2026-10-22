/** @type {import('next').NextConfig} */
const nextConfig = {
  // Static export: the whole app is client-side, so it deploys as plain files
  // and the service worker can cache everything for offline shows.
  output: 'export',
  reactStrictMode: true,
  images: { unoptimized: true },
};
export default nextConfig;
