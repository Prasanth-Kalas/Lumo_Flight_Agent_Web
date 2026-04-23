/**
 * POST /api/tools/flight_search_offers
 *
 * Read-only tool. Returns up to 3 stub offers per slice-set. No PII
 * enters this route; the orchestrator enforces empty pii_grant for
 * free-tier tools.
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { searchOffers } from "@/lib/duffel-stub";
import { badRequestFromZod, errorResponse, stripEnvelopeKeys } from "@/lib/http";

// IATA code: 3 uppercase letters. We also accept lowercase and uppercase it.
const iata = z
  .string()
  .length(3)
  .transform((s) => s.toUpperCase())
  .refine((s) => /^[A-Z]{3}$/.test(s), { message: "must be a 3-letter IATA code" });

const BodySchema = z
  .object({
    slices: z
      .array(
        z.object({
          origin: iata,
          destination: iata,
          departure_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, {
            message: "ISO date (YYYY-MM-DD)",
          }),
        }),
      )
      .min(1)
      .max(4),
    passengers: z
      .array(
        z.object({
          type: z.enum(["adult", "child", "infant_without_seat"]),
        }),
      )
      .min(1)
      .max(9),
    cabin_class: z
      .enum(["economy", "premium_economy", "business", "first"])
      .default("economy"),
    max_connections: z.number().int().min(0).max(2).optional(),
    currency: z.string().length(3).default("USD"),
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

  // Reject same-airport O/D — a common LLM hallucination.
  for (const [i, s] of parsed.data.slices.entries()) {
    if (s.origin === s.destination) {
      return errorResponse(
        "bad_request",
        400,
        `Slice ${i}: origin and destination must differ.`,
      );
    }
  }

  const offers = searchOffers(parsed.data);
  // Intentionally NOT calling attachSummary here. Search returns N
  // candidate offers; a confirmation envelope must refer to the specific
  // itinerary the user is about to book. We force the shell to round-trip
  // through flight_price_offer (which does attach a summary) before
  // flight_book_offer can fire. This also mirrors real Duffel: prices can
  // drift between search and book, and the re-price is the moment of
  // truth for "this is what you'll pay."
  return NextResponse.json(
    { offers },
    {
      status: 200,
      // These responses should never be cached — offer_ids are
      // session-local and total_amount depends on passenger count.
      headers: { "cache-control": "no-store" },
    },
  );
}
