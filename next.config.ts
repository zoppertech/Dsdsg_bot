import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Make sure the knowledge-base files are shipped with the server code
  // (needed on AWS Amplify, where only traced files are deployed).
  outputFileTracingIncludes: {
    "/api/token": ["./prompts/**/*"],
  },
  async headers() {
    return [
      {
        // Promoter pages: keep them out of search engines and never leak the secret URL.
        source: "/p/:path*",
        headers: [
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
    ];
  },
};

export default nextConfig;
