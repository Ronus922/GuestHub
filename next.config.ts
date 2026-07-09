import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Middleware buffers the whole request body (default 10mb). Room-image
    // uploads allow 15MiB per file; the multipart envelope is slightly larger,
    // so raise the buffer to 18mb to match the Nginx client_max_body_size.
    // Without this, middleware truncates >10mb bodies and request.formData()
    // fails with a generic 500. (Next 15 middleware.ts option.)
    middlewareClientMaxBodySize: "18mb",
  },
};

export default nextConfig;
