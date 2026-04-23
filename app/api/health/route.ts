/**
 * GET /api/health
 *
 * Polled by the shell every HEALTH_POLL_MS (default 10s). The payload
 * feeds the rolling score that drives the circuit breaker — so keep
 * this cheap. Never hit Duffel from here on the happy path; only
 * report cached upstream status.
 *
 * Status conventions (defined in @lumo/agent-sdk/health):
 *   - "ok"       → HTTP 200, all upstreams healthy, within SLA
 *   - "degraded" → HTTP 200, we can serve but something is wobbly
 *                  (e.g. Duffel latency elevated, Stripe test mode)
 *   - "down"     → HTTP 503, we cannot serve; circuit breaker opens
 */

import { healthResponse } from "@lumo/agent-sdk";

export const dynamic = "force-dynamic";

export async function GET() {
  // For the stub phase, we have no real upstreams yet — just report ok.
  // Once Duffel + Stripe are wired in, cache the last probe result in a
  // module-level ring buffer and surface aggregate status here.
  return healthResponse({
    status: "ok",
    agent_id: "flight",
    version: "0.1.0",
    // Optional fields left off for now; the SDK will fill `checked_at`.
  });
}
