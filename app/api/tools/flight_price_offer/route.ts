/**
 * POST /api/tools/flight_price_offer
 *
 * Re-prices an offer returned by /flight_search_offers. In the stub
 * this just refreshes the TTL and echoes the offer back. In the real
 * Duffel impl this is a round-trip that may return a different
 * total_amount; the shell must detect that and re-confirm with the
 * user before booking.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { attachSummary } from "@lumo/agent-sdk";

import { canonicalItinerarySummary, priceOffer } from "@/lib/duffel";
import { badRequestFromZod, errorResponse, stripEnvelopeKeys } from "@/lib/http";

const BodySchema = z
  .object({
    offer_id: z.string().min(1),
  })
  .strict();

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return errorResponse("bad_request", 400, "Body must be valid JSON.");
  }

  const parsed = BodySchema.safeParse(stripEnvelopeKeys(raw));
  if (!parsed.success) return badRequestFromZod(parsed.error);

  const priced = await priceOffer(parsed.data.offer_id);
  if (priced === "not_found") {
    return errorResponse(
      "offer_not_found",
      404,
      `No offer with id ${parsed.data.offer_id}.`,
    );
  }
  if (priced === "expired") {
    return errorResponse(
      "offer_expired",
      410,
      "Offer has expired; search again.",
    );
  }

  // Attach the canonical confirmation envelope. The shell extracts
  // `_lumo_summary` from this response, stores it as the turn's summary,
  // and later compares its hash to `summary_hash` on the book call. Using
  // `attachSummary` + the shared `canonicalItinerarySummary` shape makes
  // hash parity a structural property, not a formatting convention.
  //
  // Deliberately NOT attached on flight_search_offers: search returns N
  // candidates and we want the shell to always re-price the chosen one
  // (real Duffel prices drift between search and book). Price is the
  // sole emitter of confirmation envelopes for flights.
  const body = attachSummary(priced, {
    kind: "structured-itinerary",
    payload: canonicalItinerarySummary(priced),
  });

  return NextResponse.json(body, {
    status: 200,
    headers: { "cache-control": "no-store" },
  });
}
