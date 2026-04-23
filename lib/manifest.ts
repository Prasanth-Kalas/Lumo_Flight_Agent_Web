/**
 * Flight Agent manifest factory.
 *
 * The manifest is the single source of truth the shell reads at registry
 * boot (via `/.well-known/agent.json`). It describes *what* this agent
 * does — not *how* — and declares the PII scope and SLA the router will
 * enforce.
 *
 * URLs must be absolute (AgentManifestSchema enforces z.string().url()).
 * Base URL resolution lives in lib/public-base-url.ts so we share the
 * same fallback chain with app/openapi.json/route.ts.
 */

import { defineManifest, type AgentManifest } from "@lumo/agent-sdk";
import { publicBaseUrl } from "./public-base-url";

/**
 * Build the manifest at request time so `PUBLIC_BASE_URL` can be changed
 * without rebuilding (Vercel preview URLs, staging overlays, etc.).
 */
export function buildManifest(): AgentManifest {
  const base = publicBaseUrl();

  return defineManifest({
    agent_id: "flight",
    version: "0.1.0",
    domain: "flights",
    display_name: "Lumo Flights",
    one_liner: "Search, price, and book flights worldwide.",

    // Canonical intents the orchestrator maps utterances to. Keep these
    // stable — analytics joins on them.
    intents: ["search_flights", "price_flight", "book_flight"],

    example_utterances: [
      "book a flight to Las Vegas tomorrow",
      "fly me to JFK Friday morning",
      "find me a non-stop to LHR next Tuesday under $800",
    ],

    openapi_url: `${base}/openapi.json`,
    // No MCP surface yet — the agent speaks OpenAPI only. Add mcp_url
    // later if/when we expose a Model Context Protocol front door.

    ui: {
      // Registered component names the shell is allowed to render into
      // its canvas. These must also exist in the web shell's component
      // registry (module federation or a static allowlist).
      components: ["flight_itinerary_card", "flight_offers_list"],
    },

    health_url: `${base}/api/health`,

    // SLA budgets. The shell's circuit breaker uses p95_latency_ms as
    // the "latency overshoot" denominator; availability_target feeds the
    // rolling score. Numbers below are aspirational — tune after real
    // Duffel traffic.
    sla: {
      p50_latency_ms: 1500,
      p95_latency_ms: 4000,
      availability_target: 0.995,
    },

    // PII scope — the absolute max this agent may *ever* see. The router
    // intersects this with the per-tool `x-lumo-pii-required` so each
    // tool only gets what it strictly needs.
    pii_scope: [
      "name",
      "email",
      "phone",
      "payment_method_id",
      "passport",
      "passport_optional",
      "traveler_profile",
    ],

    requires_payment: true,

    // Start US-only. Duffel supports global, but Seller of Travel
    // registrations are per-state and we're only filed in CA + WA.
    supported_regions: ["US"],

    // Contract self-declaration. Bump `sdk_version` when we rebuild
    // against a newer SDK — the shell's registry will warn if this
    // drifts from the package actually installed at runtime.
    // `implements_cancellation` is true now that flight_cancel_booking
    // (task #31) is live; the SDK's openapi bridge enforces the
    // bidirectional link (`flight_book_offer` ↔ `flight_cancel_booking`)
    // at registry load.
    capabilities: {
      sdk_version: "0.2.0-rc.2",
      supports_compound_bookings: true,
      implements_cancellation: true,
    },

    owner_team: "agents-platform",
  });
}
