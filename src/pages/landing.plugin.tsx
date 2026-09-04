import { Elysia } from "elysia";
import { config } from "../config.ts";
import { LandingPage } from "./routes/landing.tsx";

/**
 * Landing page plugin — serves the developer-focused home page at GET /.
 * Returns raw HTML via Response to avoid html() plugin conflicts.
 *
 * When `LANDING_REDIRECT` is set the marketing page is skipped and visitors
 * are redirected there (e.g. `/dashboard` or a webmail URL) — a private
 * instance rarely wants a public product page on its root.
 */
export const landingPlugin = new Elysia().get(
  "/",
  () => {
    if (config.landingRedirect) {
      return new Response(null, {
        status: 302,
        headers: { location: config.landingRedirect },
      });
    }
    return new Response("<!doctype html>" + LandingPage(), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
  { detail: { hide: true } },
);
