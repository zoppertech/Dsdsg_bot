import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Make sure the knowledge-base files are shipped with the server code
  // (needed on AWS Amplify, where only traced files are deployed).
  outputFileTracingIncludes: {
    "/api/token": ["./prompts/**/*"],
    // The evaluation (Quality tab) also reads the prompts, as the knowledge base.
    "/admin/**": ["./prompts/**/*"],
  },
  async headers() {
    return [
      {
        // Promoter pages: keep them out of search engines and never leak the secret URL.
        source: "/promoter/:path*",
        headers: [
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
      {
        // Admin dashboard: also keep it out of search engines (in addition to the <meta> tag).
        source: "/admin/:path*",
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
      },
      {
        source: "/admin",
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
      },
    ];
  },
};

export default nextConfig;
