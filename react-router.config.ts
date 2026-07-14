import type { Config } from "@react-router/dev/config";

export default {
  // SPA mode: builds to static assets for Cloudflare Pages.
  // All server logic lives in the Cloud Run API (/server), called over HTTPS.
  ssr: false,
} satisfies Config;
