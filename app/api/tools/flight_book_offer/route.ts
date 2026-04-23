/**
 * POST /api/tools/flight_book_offer
 *
 * MONEY TOOL. Creates a real booking against the carrier. Gated on:
 *
 *   1. summary_hash present (64-hex sha256)
 *   2. user_confirmed === true
 *   3. server-computed hash of canonical itinerary MATCHES summary_hash
 *
 * The shell ALSO enforces #1 and #2 before dispatching — we re-check
 * here because agent endpoints are individually addressable and must
 * never trust the caller to have gated correctly.
 *
 * On mismatch we return 409 `confirmation_required`. The orchestrator
 * treats that as a signal to re-render the itinerary summary card and
 * re-prompt the user.
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import {
  bookOffer,
  getStoredOffer,
  itineraryHash,
} from "@/lib/duffel-stub";
import { badRequestFromZod, errorResponse, stripEnvelopeKeys } from "@/lib/http";

const PassengerSchema = z
  .object({
    given_name: z.string().min(1),
    family_name: z.string().min(1),
    email: z.string().email(),
    phone_number: z.string().optional(),
    date_of_birth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    type: z.enum(["adult", "child", "infant_without_seat"]),
    passport: z
      .object({
        number: z.string().min(1),
        expires_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        country: z.string().length(2),
      })
      .optional(),
  })
  .strict();

const BodySchema = z
  .object({
    offer_id: z.string().min(1),
    passengers: z.array(PassengerSchema).min(1).max(9),
    payment_method_id: z.string().min(1),
    // 64 hex chars = sha256 digest
    summary_hash: z
      .string()
      .length(64)
      .regex(/^[0-9a-f]{64}$/, { message: "summary_hash must be sha256 hex" }),
    user_confirmed: z.literal(true),
  })
  .strict();

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  // Orchestrator emits this header on every money-tool dispatch. Absence
  // is not fatal in the stub (dev curl doesn't send one), but we log for
  // audit. In prod, missing/duplicate idempotency keys become a 400.
  const idempotency_key = req.headers.get("x-idempotency-key") ?? null;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return errorResponse("bad_request", 400, "Body must be valid JSON.");
  }

  const parsed = BodySchema.safeParse(stripEnvelopeKeys(raw));
  if (!parsed.success) return badRequestFromZod(parsed.error);

  const { offer_id, summary_hash } = parsed.data;

  // ── Gate A: offer must still exist and not have expired.
  const offer = getStoredOffer(offer_id);
  if (!offer) {
    return errorResponse(
      "offer_expired",
      410,
      "Offer no longer available; please re-search and re-confirm.",
    );
  }

  // ── Gate B: server-computed hash must match.
  const expected = itineraryHash(offer);
  if (expected !== summary_hash) {
    // The confirmation the user gave was for a different itinerary OR
    // the fare moved between confirmation and book. Either way, the
    // shell must re-prompt.
    return errorResponse(
      "confirmation_required",
      409,
      "The confirmed itinerary no longer matches the current offer. Re-present the summary to the user.",
      { expected_summary_hash: expected },
    );
  }

  // ── All gates passed. Book.
  const result = bookOffer({
    offer_id,
    passengers: parsed.data.passengers.map((p) => ({
      given_name: p.given_name,
      family_name: p.family_name,
      email: p.email,
      type: p.type,
    })),
    payment_method_id: parsed.data.payment_method_id,
  });

  if (!result.ok) {
    if (result.reason === "offer_not_found") {
      return errorResponse("offer_not_found", 404, "Offer not found.");
    }
    return errorResponse("offer_expired", 410, "Offer expired.");
  }

  // TODO (prod): persist {idempotency_key -> booking_id} so retries of
  // the same key return the same booking instead of charging twice.
  void idempotency_key;

  return NextResponse.json(result.result, {
    status: 200,
    headers: { "cache-control": "no-store" },
  });
}
