/**
 * GET /openapi.json
 *
 * OpenAPI 3.1 document for the Flight Agent. Three operations are
 * exposed as orchestrator tools via `x-lumo-tool: true`:
 *
 *   1. flight_search_offers   — read, cheap, no PII
 *   2. flight_price_offer     — read, cheap, no PII; returns a fresh
 *                                priced offer with `expires_at`
 *   3. flight_book_offer      — money tool. Requires confirmation gate
 *                                (`structured-itinerary`) + PII payload.
 *
 * The `x-lumo-*` extensions are what the shell's orchestrator reads to
 * build the Claude tool list and the router's gating table. See
 * `@lumo/agent-sdk/openapi` for the full extension contract.
 *
 * Shape of the offer/slice/segment objects mirrors Duffel's NDC JSON so
 * that swapping the stub for the real `duffel.offerRequests.create()`
 * call later is a one-liner — no downstream refactor.
 */

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

function publicBaseUrl(): string {
  const raw = process.env.PUBLIC_BASE_URL?.trim();
  if (raw && raw.length > 0) return raw.replace(/\/+$/, "");
  return "http://localhost:3002";
}

export async function GET() {
  const base = publicBaseUrl();

  const doc = {
    openapi: "3.1.0",
    info: {
      title: "Lumo Flight Agent",
      version: "0.1.0",
      description:
        "Flight search, pricing, and booking. Service endpoint consumed by the Lumo orchestrator shell.",
    },
    servers: [{ url: base }],

    // ────────────────────────────────────────────────────────────────
    // Paths
    // ────────────────────────────────────────────────────────────────
    paths: {
      "/api/tools/flight_search_offers": {
        post: {
          operationId: "flight_search_offers",
          summary: "Search flight offers for a trip",
          description:
            "Return up to N flight offers matching an origin/destination/date trip. One-way or round-trip. No PII required. Offers are NOT fare-guaranteed — the LLM must call flight_price_offer before booking.",

          // x-lumo-* extensions drive the orchestrator.
          "x-lumo-tool": true,
          "x-lumo-cost-tier": "free",
          "x-lumo-requires-confirmation": false,
          "x-lumo-pii-required": [],
          "x-lumo-intent-tags": ["search_flights"],

          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/FlightSearchRequest" },
              },
            },
          },
          responses: {
            "200": {
              description: "Offers found",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/FlightSearchResponse" },
                },
              },
            },
            "400": { $ref: "#/components/responses/BadRequest" },
            "429": { $ref: "#/components/responses/RateLimited" },
          },
        },
      },

      "/api/tools/flight_price_offer": {
        post: {
          operationId: "flight_price_offer",
          summary: "Re-price a flight offer",
          description:
            "Given an offer_id from a prior search, fetch a fresh priced offer. Fares can move between search and book; the returned `expires_at` tells the shell when the price is no longer guaranteed.",

          "x-lumo-tool": true,
          "x-lumo-cost-tier": "low",
          "x-lumo-requires-confirmation": false,
          "x-lumo-pii-required": [],
          "x-lumo-intent-tags": ["price_flight"],

          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/FlightPriceRequest" },
              },
            },
          },
          responses: {
            "200": {
              description: "Priced offer",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/FlightOffer" },
                },
              },
            },
            "404": { $ref: "#/components/responses/OfferNotFound" },
            "410": { $ref: "#/components/responses/OfferExpired" },
          },
        },
      },

      "/api/tools/flight_book_offer": {
        post: {
          operationId: "flight_book_offer",
          summary: "Book a priced flight offer (money-moving)",
          description:
            "Creates a Duffel order. This is a money tool: the orchestrator MUST have the user's explicit confirmation of the full itinerary before calling. The request body must include `summary_hash` (sha256 of the itinerary the user confirmed) and `user_confirmed: true`. If the hash doesn't match the offer's current price + itinerary, the server returns 409 and the shell must re-confirm.",

          "x-lumo-tool": true,
          "x-lumo-cost-tier": "money",
          "x-lumo-requires-confirmation": "structured-itinerary",
          // Every money tool must declare its cancel counterpart. The
          // SDK's openApiToClaudeTools refuses to build the bridge if
          // this points at a non-existent op or is missing entirely.
          "x-lumo-cancels": "flight_cancel_booking",
          // Intersection with the agent's `pii_scope` determines what
          // the router actually forwards. `passport` is conditional on
          // the route (international); the book handler enforces.
          "x-lumo-pii-required": [
            "name",
            "email",
            "payment_method_id",
            "passport_optional",
          ],
          "x-lumo-intent-tags": ["book_flight"],

          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/FlightBookRequest" },
              },
            },
          },
          responses: {
            "200": {
              description: "Booking confirmed",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/FlightBookResponse" },
                },
              },
            },
            "402": { $ref: "#/components/responses/PaymentFailed" },
            "409": { $ref: "#/components/responses/ConfirmationRequired" },
            "410": { $ref: "#/components/responses/OfferExpired" },
          },
        },
      },

      "/api/tools/flight_cancel_booking": {
        post: {
          operationId: "flight_cancel_booking",
          summary: "Cancel a prior flight booking (Saga rollback)",
          description:
            "Cancel a booking created by `flight_book_offer`. This is the compensating action the Saga invokes during compound-booking rollback — it must NOT re-prompt the user. Idempotent: a repeat call with the same booking_id returns 200 with `already_cancelled: true` instead of double-processing. For non-refundable fares the PNR is still cancelled but `refund_amount` may be '0.00' — the tool is `compensation-kind: best-effort`, not `perfect`.",

          "x-lumo-tool": true,
          "x-lumo-cost-tier": "free",
          // MUST be literal false. The SDK's cancellation-protocol
          // validator rejects any cancel tool that would gate on
          // confirmation — the Saga has no user in the loop.
          "x-lumo-requires-confirmation": false,
          // Bidirectional link back to the forward money tool. Both
          // pointers must be present and agree; the SDK validator
          // rejects a one-sided link at registry boot.
          "x-lumo-cancel-for": "flight_book_offer",
          "x-lumo-compensation-kind": "best-effort",
          "x-lumo-pii-required": [],
          "x-lumo-intent-tags": ["cancel_flight"],

          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/FlightCancelRequest" },
              },
            },
          },
          responses: {
            "200": {
              description: "Booking cancelled (or idempotent repeat)",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/FlightCancelResponse" },
                },
              },
            },
            "400": { $ref: "#/components/responses/BadRequest" },
            "404": { $ref: "#/components/responses/BookingNotFound" },
          },
        },
      },
    },

    // ────────────────────────────────────────────────────────────────
    // Components — schemas
    // ────────────────────────────────────────────────────────────────
    components: {
      schemas: {
        // Request shapes
        FlightSearchRequest: {
          type: "object",
          additionalProperties: false,
          required: ["slices", "passengers"],
          properties: {
            slices: {
              type: "array",
              minItems: 1,
              maxItems: 4,
              items: { $ref: "#/components/schemas/SearchSlice" },
            },
            passengers: {
              type: "array",
              minItems: 1,
              maxItems: 9,
              items: { $ref: "#/components/schemas/PassengerCount" },
            },
            cabin_class: {
              type: "string",
              enum: ["economy", "premium_economy", "business", "first"],
              default: "economy",
            },
            max_connections: { type: "integer", minimum: 0, maximum: 2 },
            currency: { type: "string", minLength: 3, maxLength: 3, default: "USD" },
          },
        },
        SearchSlice: {
          type: "object",
          additionalProperties: false,
          required: ["origin", "destination", "departure_date"],
          properties: {
            origin: {
              type: "string",
              description: "IATA airport or city code (3 chars)",
              minLength: 3,
              maxLength: 3,
            },
            destination: {
              type: "string",
              minLength: 3,
              maxLength: 3,
            },
            departure_date: {
              type: "string",
              format: "date",
              description: "ISO 8601 date (YYYY-MM-DD)",
            },
          },
        },
        PassengerCount: {
          type: "object",
          additionalProperties: false,
          required: ["type"],
          properties: {
            type: { type: "string", enum: ["adult", "child", "infant_without_seat"] },
          },
        },

        FlightPriceRequest: {
          type: "object",
          additionalProperties: false,
          required: ["offer_id"],
          properties: {
            offer_id: { type: "string", minLength: 1 },
          },
        },

        FlightBookRequest: {
          type: "object",
          additionalProperties: false,
          required: [
            "offer_id",
            "passengers",
            "payment_method_id",
            "summary_hash",
            "user_confirmed",
          ],
          properties: {
            offer_id: { type: "string", minLength: 1 },
            passengers: {
              type: "array",
              minItems: 1,
              maxItems: 9,
              items: { $ref: "#/components/schemas/PassengerDetails" },
            },
            payment_method_id: {
              type: "string",
              description:
                "Stripe PaymentMethod id — the agent never sees card numbers.",
            },
            // Confirmation gate. The shell computes `summary_hash` from
            // the exact itinerary + total the user said yes to. Server
            // re-hashes and compares.
            summary_hash: {
              type: "string",
              description: "sha256 hex of the confirmed itinerary summary",
              minLength: 64,
              maxLength: 64,
            },
            user_confirmed: { type: "boolean", const: true },
          },
        },
        PassengerDetails: {
          type: "object",
          additionalProperties: false,
          required: ["given_name", "family_name", "email", "type"],
          properties: {
            given_name: { type: "string", minLength: 1 },
            family_name: { type: "string", minLength: 1 },
            email: { type: "string", format: "email" },
            phone_number: { type: "string" },
            date_of_birth: { type: "string", format: "date" },
            type: { type: "string", enum: ["adult", "child", "infant_without_seat"] },
            // International bookings only. Stubbed out on domestic US.
            passport: {
              type: "object",
              additionalProperties: false,
              properties: {
                number: { type: "string" },
                expires_on: { type: "string", format: "date" },
                country: { type: "string", minLength: 2, maxLength: 2 },
              },
            },
          },
        },

        // Response shapes (Duffel-shaped so the real-API swap is local)
        FlightSearchResponse: {
          type: "object",
          additionalProperties: false,
          required: ["offers"],
          properties: {
            offers: {
              type: "array",
              items: { $ref: "#/components/schemas/FlightOffer" },
            },
          },
        },
        FlightOffer: {
          type: "object",
          additionalProperties: false,
          required: [
            "offer_id",
            "total_amount",
            "total_currency",
            "slices",
            "expires_at",
          ],
          properties: {
            offer_id: { type: "string" },
            total_amount: {
              type: "string",
              description: "Decimal string, e.g. '482.37'. Avoids float drift.",
            },
            total_currency: { type: "string", minLength: 3, maxLength: 3 },
            slices: {
              type: "array",
              items: { $ref: "#/components/schemas/OfferSlice" },
            },
            expires_at: { type: "string", format: "date-time" },
            owner: {
              type: "object",
              properties: {
                name: { type: "string" },
                iata_code: { type: "string", minLength: 2, maxLength: 2 },
              },
            },
          },
        },
        OfferSlice: {
          type: "object",
          additionalProperties: false,
          required: ["origin", "destination", "segments"],
          properties: {
            origin: { $ref: "#/components/schemas/Place" },
            destination: { $ref: "#/components/schemas/Place" },
            duration: { type: "string", description: "ISO 8601 duration" },
            segments: {
              type: "array",
              items: { $ref: "#/components/schemas/Segment" },
            },
          },
        },
        Segment: {
          type: "object",
          additionalProperties: false,
          required: ["origin", "destination", "departing_at", "arriving_at"],
          properties: {
            origin: { $ref: "#/components/schemas/Place" },
            destination: { $ref: "#/components/schemas/Place" },
            departing_at: { type: "string", format: "date-time" },
            arriving_at: { type: "string", format: "date-time" },
            marketing_carrier: {
              type: "object",
              properties: {
                name: { type: "string" },
                iata_code: { type: "string", minLength: 2, maxLength: 2 },
              },
            },
            marketing_carrier_flight_number: { type: "string" },
          },
        },
        Place: {
          type: "object",
          additionalProperties: false,
          required: ["iata_code"],
          properties: {
            iata_code: { type: "string", minLength: 3, maxLength: 3 },
            name: { type: "string" },
            city_name: { type: "string" },
          },
        },

        FlightBookResponse: {
          type: "object",
          additionalProperties: false,
          required: ["booking_id", "pnr", "total_amount", "total_currency"],
          properties: {
            booking_id: { type: "string" },
            pnr: {
              type: "string",
              description: "Airline record locator (6 chars, e.g. 'A1B2C3')",
            },
            total_amount: { type: "string" },
            total_currency: { type: "string" },
            itinerary: {
              type: "array",
              items: { $ref: "#/components/schemas/OfferSlice" },
            },
            e_ticket_urls: { type: "array", items: { type: "string", format: "uri" } },
          },
        },

        FlightCancelRequest: {
          type: "object",
          additionalProperties: false,
          required: ["booking_id"],
          properties: {
            booking_id: {
              type: "string",
              minLength: 1,
              description: "booking_id returned by a prior flight_book_offer call",
            },
            reason: {
              type: "string",
              maxLength: 512,
              description:
                "Free-form context captured in the audit log. Saga rollbacks typically pass something like 'trip_rollback:hotel_leg_failed'.",
            },
          },
        },
        FlightCancelResponse: {
          type: "object",
          additionalProperties: true,
          required: ["booking_id", "status"],
          properties: {
            booking_id: { type: "string" },
            status: { type: "string", enum: ["cancelled"] },
            refund_amount: {
              type: "string",
              description:
                "Decimal string. May be '0.00' for non-refundable fares (compensation-kind is best-effort).",
            },
            refund_currency: { type: "string", minLength: 3, maxLength: 3 },
            cancelled_at: { type: "string", format: "date-time" },
            already_cancelled: {
              type: "boolean",
              description:
                "Present and true when this is an idempotent repeat of a prior cancel.",
            },
          },
        },

        // Error envelope — stable across all tool routes.
        ErrorEnvelope: {
          type: "object",
          additionalProperties: false,
          required: ["error"],
          properties: {
            error: { type: "string" },
            message: { type: "string" },
            details: { type: "object", additionalProperties: true },
          },
        },
      },

      responses: {
        BadRequest: {
          description: "Request body failed validation",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorEnvelope" },
            },
          },
        },
        RateLimited: {
          description: "Too many requests",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorEnvelope" },
            },
          },
        },
        OfferNotFound: {
          description: "Unknown offer_id",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorEnvelope" },
            },
          },
        },
        OfferExpired: {
          description: "Offer has expired; re-search required",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorEnvelope" },
            },
          },
        },
        PaymentFailed: {
          description: "Stripe declined the PaymentMethod",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorEnvelope" },
            },
          },
        },
        ConfirmationRequired: {
          description:
            "summary_hash did not match server-computed hash; user must re-confirm.",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorEnvelope" },
            },
          },
        },
        BookingNotFound: {
          description: "Unknown booking_id on this agent.",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorEnvelope" },
            },
          },
        },
      },
    },
  } as const;

  return NextResponse.json(doc, {
    status: 200,
    headers: {
      "cache-control": "public, max-age=60, s-maxage=300",
      "access-control-allow-origin": "*",
    },
  });
}
