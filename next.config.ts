import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // forbidden() üçün lazımdır — icazə rədd olunanda render dayanır və 403
    // səhifəsi göstərilir (src/app/forbidden.tsx). Bax src/lib/access.ts.
    authInterrupts: true,
  },
};

export default nextConfig;
