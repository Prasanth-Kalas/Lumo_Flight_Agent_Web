/**
 * POST /api/tools/flight_cancel_booking
 *
 * CANCEL TOOL (compensating action for flight_book_offer).
 *
 * Invariants the shell's SDK validates at registry load (see
 * @lumo/agent-sdk/openapi validateCancellationProtocol):
 *
 *   - cost-tier: "free"                  — no net money movement the
 *                                          orchestrator pays for; provider
 *                                          handles the actual refund.
 *   - requires-confirmation: false       — CRITICAL. The Saga invokes
 *                                          this during rollback with no
 *                                          human in the loop. Gating on
 *                                          user confirmation here would
 *                                          deadlock the rollback.
 *   - x-lumo-cancel-for: flight_book_offer
 *                                        — bidirectional link; the
 *                                          forward money tool sets
 *                                          x-lumo-cancels to point here.
 *   - compensation-kind: best-effort     — some fares are non-refundable;
 *                                          we still cancel the PNR, the
 *                                          refund_amount may be "0.00".
 *
 * Unlike flight_book_offer this route does NOT require `summary_hash`
 * or `user_confirmed`. The booking_id is the unique thing to cancel;
 * the forward confirmation has already authorised the Saga's authority
 * to roll it back.
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { cancelBooking } from "@/lib/duffel-stub";
import { badRequestFromZod, errorResponse } from "@/lib/http";

const BodySchema = z
  .object({
    booking_id: z.string().min(1),
    // Free-form reason captured for the audit log. The Saga typically
    // passes something like "trip_rollback:leg_hotel_failed".
    reason: z.string().max(512).optional(),
  })
  .strict();

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  // The Saga stamps an idempotency key per rollback attempt. Retries of
  // the same cancel must return the same terminal result — that's
  // enforced by `cancelBooking` returning `already_cancelled` on the
  // second call (we still 200 on the idempotent repeat below).
  const idempotency_key = req.headers.get("x-idempotency-key") ?? null;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return errorResponse("bad_request", 400, "Body must be valid JSON.");
  }

  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) return badRequestFromZod(parsed.error);

  const result = cancelBooking({
    booking_id: parsed.data.booking_id,
    reason: parsed.data.reason,
  });

  if (!result.ok) {
    if (result.reason === "not_found") {
      return errorResponse(
        "booking_not_found",
        404,
        "No booking with that id exists on this agent.",
      );
    }
    if (result.reason === "already_cancelled") {
      // Idempotent repeat — the Saga considers this a successful
      // rollback step. Return 200 with a short envelope so the
      // orchestrator doesn't escalate to manual intervention.
      return NextResponse.json(
        {
          booking_id: parsed.data.booking_id,
          status: "cancelled",
          already_cancelled: true,
        },
        { status: 200, headers: { "cache-control": "no-store" } },
      );
    }
  }

  // TODO (prod): persist {idempotency_key -> cancel_result} so Saga
  // retries of the same key short-circuit without re-hitting Duffel.
  void idempotency_key;

  return NextResponse.json(result.ok ? result.result : {}, {
    status: 200,
    headers: { "cache-control": "no-store" },
  });
}
