/** @type {import('next').NextConfig} */
const nextConfig = {
  // The UI only imports the engine's pure `types.ts` (via @/lib/contracts), which
  // has no internal `.js` specifiers, so Turbopack needs no extension aliasing.
  // The engine's runtime code runs on Daytona under tsx, not in the Next bundle.
  turbopack: {},
};

export default nextConfig;
