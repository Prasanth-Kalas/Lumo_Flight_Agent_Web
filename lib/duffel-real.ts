/**
 * Real Duffel API client — thin fetch wrapper, no SDK dep.
 *
 * Why no @duffel/api npm package? Two reasons:
 *   1. Vercel cold-start weight — the SDK pulls axios + its own types
 *      for every shape, most of which we don't touch.
 *   2. Our public contract (`FlightOffer` in duffel-stub) is a careful
 *      subset of Duffel's real shape. A direct SDK dep would tempt us
 *      into leaking Duffel's full object graph into tool results, and
 *      Claude does not need (and should not reason over) the noise.
 *
 * Covered endpoints:
 *   - POST /air/offer_requests?return_offers=true  (search)
 *   - GET  /air/offers/:id                          (re-price)
 *
 * Not covered yet (still handled by duffel-stub.ts):
 *   - POST /air/orders            (booking — needs real payment setup)
 *   - POST /air/order_cancellations (cancel — needs a real order_id)
 *
 * The façade in `duffel.ts` routes search/price to this module when
 * DUFFEL_ACCESS_TOKEN is set and keeps book/cancel on the stub for now.
 */

import type {
  FlightOffer,
  OfferSlice,
  Place,
  Segment,
  SearchParams,
} from "./duffel-stub";

const DUFFEL_API = "https://api.duffel.com";
const DUFFEL_VERSION = "v2";
const OFFER_LIMIT = 3; // mirror the stub's slice count for consistent UI

/** Whether real Duffel is wired up for this deploy. */
export function duffelEnabled(): boolean {
  const t = process.env.DUFFEL_ACCESS_TOKEN;
  return typeof t === "string" && t.length > 0;
}

function authHeaders(): Record<string, string> {
  const token = process.env.DUFFEL_ACCESS_TOKEN;
  if (!token) throw new Error("DUFFEL_ACCESS_TOKEN is not set");
  return {
    Authorization: `Bearer ${token}`,
    "Duffel-Version": DUFFEL_VERSION,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

// ── Duffel response shapes we care about ──────────────────────────────
// Keep these minimal — only the fields we map into FlightOffer.

interface DuffelPlace {
  iata_code: string;
  name?: string;
  city_name?: string;
}

interface DuffelCarrier {
  name: string;
  iata_code: string;
}

interface DuffelSegment {
  origin: DuffelPlace;
  destination: DuffelPlace;
  departing_at: string;
  arriving_at: string;
  marketing_carrier: DuffelCarrier;
  marketing_carrier_flight_number: string;
}

interface DuffelSlice {
  origin: DuffelPlace;
  destination: DuffelPlace;
  duration?: string;
  segments: DuffelSegment[];
}

interface DuffelOffer {
  id: string;
  total_amount: string;
  total_currency: string;
  expires_at: string;
  owner: DuffelCarrier;
  slices: DuffelSlice[];
}

interface DuffelOfferRequestResponse {
  data: {
    id: string;
    offers: DuffelOffer[];
  };
}

interface DuffelOfferResponse {
  data: DuffelOffer;
}

// ── Public API ────────────────────────────────────────────────────────

export async function searchOffersReal(
  params: SearchParams,
): Promise<FlightOffer[]> {
  const body = {
    data: {
      slices: params.slices.map((s) => ({
        origin: s.origin,
        destination: s.destination,
        departure_date: s.departure_date,
      })),
      passengers: params.passengers.map((p) => ({ type: p.type })),
      cabin_class: params.cabin_class ?? "economy",
      ...(params.max_connections !== undefined
        ? { max_connections: params.max_connections }
        : {}),
    },
  };

  // `return_offers=true` folds the offer list into the create response.
  // Without it we'd have to poll /air/offer_requests/:id — one extra
  // round-trip we don't need for a UI that shows the first few results.
  const url = `${DUFFEL_API}/air/offer_requests?return_offers=true`;
  const res = await fetch(url, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await safeText(res);
    throw new Error(`Duffel search failed: HTTP ${res.status} — ${text}`);
  }

  const json = (await res.json()) as DuffelOfferRequestResponse;
  const offers = (json.data?.offers ?? [])
    .slice(0, OFFER_LIMIT)
    .map(mapOffer);
  return offers;
}

export async function priceOfferReal(
  offer_id: string,
): Promise<FlightOffer | "not_found" | "expired"> {
  const url = `${DUFFEL_API}/air/offers/${encodeURIComponent(offer_id)}?return_available_services=false`;
  const res = await fetch(url, { method: "GET", headers: authHeaders() });

  if (res.status === 404) return "not_found";
  if (res.status === 410) return "expired";
  if (!res.ok) {
    const text = await safeText(res);
    throw new Error(`Duffel price failed: HTTP ${res.status} — ${text}`);
  }

  const json = (await res.json()) as DuffelOfferResponse;
  return mapOffer(json.data);
}

// ── Mapping ───────────────────────────────────────────────────────────

function mapOffer(o: DuffelOffer): FlightOffer {
  return {
    offer_id: o.id,
    total_amount: o.total_amount,
    total_currency: o.total_currency,
    expires_at: o.expires_at,
    owner: { name: o.owner.name, iata_code: o.owner.iata_code },
    slices: o.slices.map(mapSlice),
  };
}

function mapSlice(s: DuffelSlice): OfferSlice {
  return {
    origin: mapPlace(s.origin),
    destination: mapPlace(s.destination),
    ...(s.duration ? { duration: s.duration } : {}),
    segments: s.segments.map(mapSegment),
  };
}

function mapPlace(p: DuffelPlace): Place {
  return {
    iata_code: p.iata_code,
    ...(p.name ? { name: p.name } : {}),
    ...(p.city_name ? { city_name: p.city_name } : {}),
  };
}

function mapSegment(s: DuffelSegment): Segment {
  return {
    origin: mapPlace(s.origin),
    destination: mapPlace(s.destination),
    departing_at: s.departing_at,
    arriving_at: s.arriving_at,
    marketing_carrier: {
      name: s.marketing_carrier.name,
      iata_code: s.marketing_carrier.iata_code,
    },
    marketing_carrier_flight_number: s.marketing_carrier_flight_number,
  };
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "<unreadable body>";
  }
}
