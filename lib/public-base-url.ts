/**
 * Resolve the public base URL this Flight Agent deployment serves under.
 *
 * Used by lib/manifest.ts and app/openapi.json/route.ts to build absolute
 * URLs for `openapi_url`, `health_url`, and `servers[].url`. The manifest
 * schema requires `z.string().url()` on those fields, so "empty string
 * fallback" isn't an option — we must produce a real URL.
 *
 * Fallback chain, most-specific → least-specific:
 *   1. PUBLIC_BASE_URL            — explicit dashboard override
 *   2. VERCEL_PROJECT_PRODUCTION_URL — auto-injected by Vercel, stable across
 *                                     deploys, matches the prod alias (e.g.
 *                                     "lumo-flight-agent.vercel.app"). Best
 *                                     default for prod.
 *   3. VERCEL_URL                 — auto-injected per-deploy. Used only on
 *                                     previews where 2 isn't set (shouldn't
 *                                     happen, but be defensive).
 *   4. http://localhost:3002      — local dev fallback.
 *
 * Vercel's auto-injected URLs are bare hostnames (no protocol), so we
 * prepend https:// when returning them.
 */
export function publicBaseUrl(): string {
  const explicit = process.env.PUBLIC_BASE_URL?.trim();
  if (explicit && explicit.length > 0) return explicit.replace(/\/+$/, "");

  const prod = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (prod && prod.length > 0) return `https://${prod.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;

  const deploy = process.env.VERCEL_URL?.trim();
  if (deploy && deploy.length > 0) return `https://${deploy.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;

  return "http://localhost:3002";
}
