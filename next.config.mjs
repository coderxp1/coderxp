/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  images: {
    unoptimized: true,
  },

  async headers() {
    const workspaceHeaders = [
      {
        key: "Cross-Origin-Embedder-Policy",
        value: "require-corp",
      },
      {
        key: "Cross-Origin-Opener-Policy",
        value: "same-origin",
      },
    ];

    return [
      {
        source: "/workspace",
        headers: workspaceHeaders,
      },
      {
        source: "/workspace/:path*",
        headers: workspaceHeaders,
      },
    ];
  },
};

export default nextConfig;
