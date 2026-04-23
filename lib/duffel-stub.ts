/**
 * Duffel NDC stub.
 *
 * Generates deterministic fake offers, persists them in an in-memory
 * store keyed by `offer_id`, and exposes a canonical itinerary summary
 * helper that BOTH the shell and the server hash to enforce the
 * confirmation gate on booking.
 *
 * All shapes here mirror the real Duffel API one-for-one:
 *   - Offer.total_amount is a decimal string ("482.37") not a number
 *   - Place uses iata_code (3 chars)
 *   - Segment.marketing_carrier has name + iata_code
 *   - Offer.expires_at is RFC 3339
 *
 * Swap plan: replace the five functions at the bottom of this file
 * (`searchOffers`, `priceOffer`, `bookOffer`, `getStoredOffer`,
 * `canonicalItinerarySummary`) with Duffel SDK calls. No other file
 * changes.
 */

import { hashSummary } from "@lumo/agent-sdk";
import { randomBytes } from "node:crypto";

// ──────────────────────────────────────────────────────────────────────────
// Types (Duffel-shaped)
// ──────────────────────────────────────────────────────────────────────────

export interface Place {
  iata_code: string;
  name?: string;
  city_name?: string;
}

export interface Carrier {
  name: string;
  iata_code: string;
}

export interface Segment {
  origin: Place;
  destination: Place;
  departing_at: string; // ISO 8601
  arriving_at: string; // ISO 8601
  marketing_carrier: Carrier;
  marketing_carrier_flight_number: string;
}

export interface OfferSlice {
  origin: Place;
  destination: Place;
  duration?: string;
  segments: Segment[];
}

export interface FlightOffer {
  offer_id: string;
  total_amount: string; // decimal string
  total_currency: string;
  slices: OfferSlice[];
  expires_at: string; // ISO 8601
  owner: Carrier;
}

export interface SearchSlice {
  origin: string;
  destination: string;
  departure_date: string; // YYYY-MM-DD
}

export interface PassengerCount {
  type: "adult" | "child" | "infant_without_seat";
}

export interface SearchParams {
  slices: SearchSlice[];
  passengers: PassengerCount[];
  cabin_class?: "economy" | "premium_economy" | "business" | "first";
  max_connections?: number;
  currency?: string;
}

// ──────────────────────────────────────────────────────────────────────────
// In-memory store (dev only; real impl will use Duffel + Redis cache)
// ──────────────────────────────────────────────────────────────────────────

const OFFER_TTL_MS = 15 * 60 * 1000; // 15 min — realistic for an NDC offer

interface StoredOffer {
  offer: FlightOffer;
  stored_at: number;
}

const offerStore = new Map<string, StoredOffer>();

// Occasional sweep to keep memory bounded. Cheap enough to run on every write.
function sweepExpired(now: number) {
  for (const [id, entry] of offerStore) {
    if (now - entry.stored_at > OFFER_TTL_MS) offerStore.delete(id);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Static reference data used to give the stubs some texture
// ──────────────────────────────────────────────────────────────────────────

const AIRPORTS: Record<string, { name: string; city_name: string }> = {
  SFO: { name: "San Francisco International", city_name: "San Francisco" },
  LAS: { name: "Harry Reid International", city_name: "Las Vegas" },
  JFK: { name: "John F. Kennedy International", city_name: "New York" },
  LAX: { name: "Los Angeles International", city_name: "Los Angeles" },
  SEA: { name: "Seattle-Tacoma International", city_name: "Seattle" },
  ORD: { name: "O'Hare International", city_name: "Chicago" },
  LHR: { name: "Heathrow", city_name: "London" },
  NRT: { name: "Narita International", city_name: "Tokyo" },
};

const CARRIERS: Carrier[] = [
  { name: "United", iata_code: "UA" },
  { name: "Alaska", iata_code: "AS" },
  { name: "Delta", iata_code: "DL" },
  { name: "American", iata_code: "AA" },
];

function placeFromIata(iata: string): Place {
  const ref = AIRPORTS[iata.toUpperCase()];
  return {
    iata_code: iata.toUpperCase(),
    ...(ref ? { name: ref.name, city_name: ref.city_name } : {}),
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────────

/**
 * Search offers. Returns 3 stub offers per slice combination, with
 * varying carriers and prices. Deterministic per (origin, dest, date)
 * so dev runs are reproducible.
 */
export function searchOffers(params: SearchParams): FlightOffer[] {
  const now = Date.now();
  sweepExpired(now);

  const currency = params.currency ?? "USD";
  const pax = params.passengers.length;
  const expires_at = new Date(now + OFFER_TTL_MS).toISOString();

  // One slice = one-way, two slices = round-trip. For the stub we just
  // concatenate all slices into one offer's `slices` array.
  const offers: FlightOffer[] = [];
  for (let i = 0; i < 3; i += 1) {
    const carrier = CARRIERS[i % CARRIERS.length]!;

    const offerSlices: OfferSlice[] = params.slices.map((s, sliceIdx) => {
      const origin = placeFromIata(s.origin);
      const destination = placeFromIata(s.destination);
      // Fake departure time: 08:00, 12:30, or 17:45 based on offer index.
      const timeOfDay = ["08:00:00", "12:30:00", "17:45:00"][i]!;
      const departing_at = `${s.departure_date}T${timeOfDay}Z`;
      // 5h30m later — close enough for a domestic transcon.
      const arriveMs =
        Date.parse(departing_at) + (5 * 60 + 30) * 60 * 1000;
      const arriving_at = new Date(arriveMs).toISOString();

      const flightNum = 100 + i * 37 + sliceIdx * 13;
      return {
        origin,
        destination,
        duration: "PT5H30M",
        segments: [
          {
            origin,
            destination,
            departing_at,
            arriving_at,
            marketing_carrier: carrier,
            marketing_carrier_flight_number: String(flightNum),
          },
        ],
      };
    });

    // Price ladder: offer 0 cheapest, offer 2 priciest. Scale by passenger count.
    const basePrices = [287, 342, 421];
    const per_pax = basePrices[i]!;
    const total = (per_pax * pax).toFixed(2);

    const offer_id = `off_stub_${randomBytes(6).toString("hex")}`;
    const offer: FlightOffer = {
      offer_id,
      total_amount: total,
      total_currency: currency,
      slices: offerSlices,
      expires_at,
      owner: carrier,
    };

    offerStore.set(offer_id, { offer, stored_at: now });
    offers.push(offer);
  }

  return offers;
}

export function getStoredOffer(offer_id: string): FlightOffer | null {
  const entry = offerStore.get(offer_id);
  if (!entry) return null;
  if (Date.now() - entry.stored_at > OFFER_TTL_MS) {
    offerStore.delete(offer_id);
    return null;
  }
  return entry.offer;
}

/**
 * Re-price an offer. In the stub we just return the same offer with a
 * refreshed `expires_at`. The real Duffel call may return a different
 * `total_amount` (fares move) — the shell then has to re-confirm if it
 * changed.
 */
export function priceOffer(offer_id: string): FlightOffer | "not_found" | "expired" {
  const entry = offerStore.get(offer_id);
  if (!entry) return "not_found";
  const now = Date.now();
  if (now - entry.stored_at > OFFER_TTL_MS) {
    offerStore.delete(offer_id);
    return "expired";
  }
  // Refresh TTL; in real Duffel we'd round-trip to get a fresh price.
  const refreshed: FlightOffer = {
    ...entry.offer,
    expires_at: new Date(now + OFFER_TTL_MS).toISOString(),
  };
  offerStore.set(offer_id, { offer: refreshed, stored_at: now });
  return refreshed;
}

export interface BookInput {
  offer_id: string;
  passengers: Array<{
    given_name: string;
    family_name: string;
    email: string;
    type: "adult" | "child" | "infant_without_seat";
  }>;
  payment_method_id: string;
}

export interface BookResult {
  booking_id: string;
  pnr: string;
  total_amount: string;
  total_currency: string;
  itinerary: OfferSlice[];
  e_ticket_urls: string[];
}

/**
 * Book an offer. Stub always succeeds as long as the offer is still
 * valid. In the real impl this wraps `duffel.orders.create()` after a
 * Stripe PaymentIntent capture.
 */
export function bookOffer(
  input: BookInput,
):
  | { ok: true; result: BookResult }
  | { ok: false; reason: "offer_not_found" | "offer_expired" } {
  const offer = getStoredOffer(input.offer_id);
  if (!offer) {
    // Distinguish "never existed" vs "existed but expired". For the stub
    // we can't tell the difference once we've evicted it; treat as
    // not_found. The real impl will have Duffel's 410 to differentiate.
    return { ok: false, reason: "offer_not_found" };
  }

  const booking_id = `bk_stub_${randomBytes(8).toString("hex")}`;
  const pnr = randomBytes(3).toString("hex").toUpperCase();

  return {
    ok: true,
    result: {
      booking_id,
      pnr,
      total_amount: offer.total_amount,
      total_currency: offer.total_currency,
      itinerary: offer.slices,
      e_ticket_urls: [`https://stub.tickets.lumo.rentals/${booking_id}.pdf`],
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Confirmation gate payload
// ──────────────────────────────────────────────────────────────────────────

/**
 * Build the canonical itinerary summary the confirmation-hash is
 * computed over. MUST be identical on server and shell — the shell
 * hashes this shape when it renders the "Confirm booking?" card, and
 * the server re-hashes it here to compare.
 *
 * Keep this shape append-only. Any field change invalidates every
 * in-flight confirmation across both sides.
 */
export function canonicalItinerarySummary(offer: FlightOffer) {
  return {
    kind: "structured-itinerary" as const,
    offer_id: offer.offer_id,
    total_amount: offer.total_amount,
    total_currency: offer.total_currency,
    slices: offer.slices.map((s) => ({
      origin: s.origin.iata_code,
      destination: s.destination.iata_code,
      segments: s.segments.map((seg) => ({
        origin: seg.origin.iata_code,
        destination: seg.destination.iata_code,
        departing_at: seg.departing_at,
        arriving_at: seg.arriving_at,
        carrier: seg.marketing_carrier.iata_code,
        flight_number: seg.marketing_carrier_flight_number,
      })),
    })),
  };
}

/**
 * Convenience: the hash the shell and server must agree on before
 * `flight_book_offer` fires.
 */
export function itineraryHash(offer: FlightOffer): string {
  return hashSummary(canonicalItinerarySummary(offer));
}
