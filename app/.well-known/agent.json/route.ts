/**
 * GET /.well-known/agent.json
 *
 * The shell polls this at registry load. The response is cached by
 * `next.config.mjs` headers (public, max-age=60, s-maxage=300) and must
 * be served CORS-clean — the shell fetches from a different origin.
 */

import { NextResponse } from "next/server";
import { buildManifest } from "@/lib/manifest";

// Manifest URLs depend on PUBLIC_BASE_URL; compute per request rather
// than at module-load time so previews and staging work without rebuild.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const manifest = buildManifest();
    return NextResponse.json(manifest, {
      status: 200,
      headers: {
        "cache-control": "public, max-age=60, s-maxage=300",
        "access-control-allow-origin": "*",
      },
    });
  } catch (err) {
    // defineManifest() throws on schema failure. Surfacing a 500 with a
    // short reason is intentional — the shell logs will show it and a
    // human can fix the manifest definition.
    const message = err instanceof Error ? err.message : "manifest build failed";
    return NextResponse.json(
      { error: "manifest_invalid", message },
      { status: 500 },
    );
  }
}
