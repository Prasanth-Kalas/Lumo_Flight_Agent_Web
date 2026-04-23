/**
 * Duffel façade.
 *
 * Routes search + re-price to the real Duffel API when
 * DUFFEL_ACCESS_TOKEN is configured; everything else (booking,
 * cancellation, confirmation hash) stays on the in-memory stub. The
 * split is deliberate:
 *
 *   - Search/price are reads against Duffel's test corpus and give us
 *     realistic airline/price/schedule data for the demo.
 *   - Book/cancel on real Duffel require a real payment (Stripe card
 *     tokenization or Duffel balance) and a full passenger payload the
 *     shell doesn't collect yet. Doing it half-right would break the
 *     confirmation-hash contract — we'd be hashing one shape at search
 *     and a different shape at book. Keep them on the stub until we
 *     have a full payment story.
 *
 * When real search runs we mirror every returned offer into the stub's
 * own offer store via `registerOffer`. That way the confirmation gate
 * (hash(offer) on the server === hash(offer) on the shell) works the
 * same whether the offer came from Duffel or from the stub generator.
 */

import {
  bookOffer as stubBookOffer,
  cancelBooking as stubCancelBooking,
  priceOffer as stubPriceOffer,
  registerOffer,
  searchOffers as stubSearchOffers,
  type FlightOffer,
  type SearchParams,
} from "./duffel-stub";

import { duffelEnabled, priceOfferReal, searchOffersReal } from "./duffel-real";

// Re-exports that never change regardless of real/fake Duffel.
export {
  canonicalItinerarySummary,
  getStoredBooking,
  getStoredOffer,
  itineraryHash,
} from "./duffel-stub";
export type {
  BookInput,
  BookResult,
  CancelInput,
  CancelResult,
  FlightOffer,
  OfferSlice,
  SearchParams,
} from "./duffel-stub";

// ── Public API ────────────────────────────────────────────────────────

export async function searchOffers(params: SearchParams): Promise<FlightOffer[]> {
  if (!duffelEnabled()) return stubSearchOffers(params);
  const offers = await searchOffersReal(params);
  // Mirror into the stub store so book/cancel (still stubbed) can find
  // the offer by id when the shell re-dispatches.
  offers.forEach(registerOffer);
  return offers;
}

export async function priceOffer(
  offer_id: string,
): Promise<FlightOffer | "not_found" | "expired"> {
  if (!duffelEnabled()) return stubPriceOffer(offer_id);
  const result = await priceOfferReal(offer_id);
  if (typeof result !== "string") registerOffer(result);
  return result;
}

export function bookOffer(input: Parameters<typeof stubBookOffer>[0]) {
  // TODO: real Duffel booking once payment + passenger collection land.
  return stubBookOffer(input);
}

export function cancelBooking(input: Parameters<typeof stubCancelBooking>[0]) {
  return stubCancelBooking(input);
}
