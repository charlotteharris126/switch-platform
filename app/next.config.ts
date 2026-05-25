import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      // Default is 1MB which rejects almost every cover image. The blog-media
      // bucket's own ceiling is 10MB; match it here so the Server Action can
      // receive what the bucket would accept.
      bodySizeLimit: "10mb",
    },
  },
};

export default nextConfig;
