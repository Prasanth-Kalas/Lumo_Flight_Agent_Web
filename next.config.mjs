/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Let Next compile the SDK's TypeScript sources directly in dev so we don't
  // need to rebuild the SDK on every change.
  transpilePackages: ["@lumo/agent-sdk"],
  async headers() {
    return [
      {
        // The shell fetches /.well-known/agent.json from this agent. Browsers
        // never call it, but CORS-clean defaults keep Vercel Preview happy.
        source: "/.well-known/agent.json",
        headers: [
          { key: "cache-control", value: "public, max-age=60, s-maxage=300" },
          { key: "access-control-allow-origin", value: "*" },
        ],
      },
      {
        source: "/openapi.json",
        headers: [
          { key: "cache-control", value: "public, max-age=60, s-maxage=300" },
          { key: "access-control-allow-origin", value: "*" },
        ],
      },
    ];
  },
};

export default nextConfig;
