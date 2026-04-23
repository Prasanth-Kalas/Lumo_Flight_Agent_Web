/**
 * Flight Agent smoke test — runs the same code paths the shell will
 * exercise at registry boot + first money-tool dispatch, without
 * needing a live Next.js server.
 *
 * Run with:
 *   pnpm --filter @lumo/flight-agent exec tsx scripts/smoke.ts
 *
 * What this verifies (ordered to match shell boot):
 *
 *   1. buildManifest() produces a value that passes parseManifest()
 *      — i.e. the shape matches the SDK's AgentManifestSchema.
 *   2. /openapi.json handler returns a valid OpenApiDocument whose
 *      operations declare the `x-lumo-*` fields the bridge requires.
 *   3. openApiToClaudeTools() extracts exactly 3 tools, in the right
 *      order, with the right cost_tier / confirmation / pii_required.
 *   4. /api/health handler returns { status: "ok" } with HTTP 200.
 *   5. The confirmation gate: given a stub offer, booking with a
 *      WRONG summary_hash returns 409 `confirmation_required`, and
 *      booking with the RIGHT hash returns 200 + booking_id.
 */

import {
  parseManifest,
  openApiToClaudeTools,
  hashSummary,
  HealthReportSchema,
  extractAttachedSummary,
} from "@lumo/agent-sdk";

import { buildManifest } from "../lib/manifest";
import {
  canonicalItinerarySummary,
  itineraryHash,
  searchOffers,
} from "../lib/duffel-stub";

import { GET as getAgentJson } from "../app/.well-known/agent.json/route";
import { GET as getOpenApi } from "../app/openapi.json/route";
import { GET as getHealth } from "../app/api/health/route";
import { POST as postPrice } from "../app/api/tools/flight_price_offer/route";
import { POST as postBook } from "../app/api/tools/flight_book_offer/route";

type Check = { name: string; ok: boolean; detail?: string };
const checks: Check[] = [];

function assert(name: string, ok: boolean, detail?: string) {
  checks.push({ name, ok, detail });
  const mark = ok ? "✓" : "✗";
  const tail = detail ? `  — ${detail}` : "";
  console.log(`  ${mark} ${name}${tail}`);
}

async function main() {
  console.log("\n── 1. Manifest factory\n");
  const manifest = buildManifest();
  const reparsed = parseManifest(manifest);
  assert(
    "buildManifest() round-trips through parseManifest",
    reparsed.agent_id === "flight",
    `agent_id=${reparsed.agent_id}`,
  );
  assert(
    "manifest declares flight-specific intents",
    manifest.intents.includes("book_flight"),
    manifest.intents.join(", "),
  );
  assert(
    "openapi_url + health_url are absolute",
    manifest.openapi_url.startsWith("http") &&
      manifest.health_url.startsWith("http"),
    `${manifest.openapi_url} | ${manifest.health_url}`,
  );

  console.log("\n── 2. /.well-known/agent.json\n");
  const agentJsonRes = await getAgentJson();
  assert("GET /.well-known/agent.json → 200", agentJsonRes.status === 200);
  const agentJsonBody = await agentJsonRes.json();
  parseManifest(agentJsonBody); // throws on bad shape
  assert("served manifest validates via parseManifest()", true);

  console.log("\n── 3. /openapi.json\n");
  const openapiRes = await getOpenApi();
  assert("GET /openapi.json → 200", openapiRes.status === 200);
  const openapi = await openapiRes.json();
  const bridge = openApiToClaudeTools(manifest.agent_id, openapi);
  assert(
    "bridge exposes exactly 4 tools",
    bridge.tools.length === 4,
    bridge.tools.map((t) => t.name).join(", "),
  );

  const expectedTools = [
    "flight_search_offers",
    "flight_price_offer",
    "flight_book_offer",
    "flight_cancel_booking",
  ];
  for (const name of expectedTools) {
    const r = bridge.routing[name];
    assert(`routing[${name}] exists`, !!r, r ? `${r.http_method} ${r.path}` : "missing");
  }

  const bookRouting = bridge.routing["flight_book_offer"];
  assert(
    "flight_book_offer cost_tier === 'money'",
    bookRouting?.cost_tier === "money",
    bookRouting?.cost_tier,
  );
  assert(
    "flight_book_offer requires structured-itinerary confirmation",
    bookRouting?.requires_confirmation === "structured-itinerary",
    String(bookRouting?.requires_confirmation),
  );
  assert(
    "flight_book_offer pii_required includes name + email + payment_method_id",
    ["name", "email", "payment_method_id"].every((p) =>
      bookRouting?.pii_required.includes(p),
    ),
    bookRouting?.pii_required.join(", "),
  );

  console.log("\n── 4. /api/health\n");
  const healthRes = await getHealth();
  assert("GET /api/health → 200", healthRes.status === 200);
  const healthBody = HealthReportSchema.parse(await healthRes.json());
  assert(
    "health status === 'ok' for fresh boot",
    healthBody.status === "ok",
    healthBody.status,
  );
  assert(
    "health agent_id === 'flight'",
    healthBody.agent_id === "flight",
    healthBody.agent_id,
  );

  console.log("\n── 5. flight_price_offer attaches _lumo_summary envelope\n");
  const seedOffers = searchOffers({
    slices: [{ origin: "SFO", destination: "LAS", departure_date: "2026-05-01" }],
    passengers: [{ type: "adult" }],
  });
  assert("searchOffers produced 3 stub offers", seedOffers.length === 3);
  const seedOffer = seedOffers[0]!;

  const priceReq = new Request("http://local/flight_price_offer", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ offer_id: seedOffer.offer_id }),
  });
  const priceRes = await postPrice(priceReq);
  assert("price offer → 200", priceRes.status === 200, String(priceRes.status));
  const priceBody = await priceRes.json();

  const env = extractAttachedSummary(priceBody);
  assert("price response carries _lumo_summary envelope", !!env);
  assert(
    "envelope.kind === 'structured-itinerary'",
    env?.kind === "structured-itinerary",
    env?.kind,
  );
  // Construction invariant: the envelope's hash must equal itineraryHash()
  // applied to the same offer. If this ever drifts, the shell's gate
  // fails silently — which is the whole bug this fix exists to prevent.
  const expectedHash = itineraryHash(seedOffer);
  assert(
    "envelope.hash === itineraryHash(offer)",
    env?.hash === expectedHash,
    `${env?.hash?.slice(0, 12)}… ?= ${expectedHash.slice(0, 12)}…`,
  );
  // Also assert parity via the shell's own extraction path — i.e., a
  // caller that only has the payload can reproduce the hash with the
  // same SDK helper, with no knowledge of the agent's internals.
  assert(
    "hashSummary(payload) reproduces envelope.hash",
    env?.hash === hashSummary(env?.payload),
    env ? `${env.hash.slice(0, 12)}…` : "(no envelope)",
  );
  // Search must NOT attach — enforce the asymmetric design decision.
  assert(
    "search results intentionally omit _lumo_summary",
    extractAttachedSummary({ offers: seedOffers }) === null,
  );

  console.log("\n── 6. Confirmation gate on flight_book_offer\n");
  const offer = seedOffer;

  // 5a. Bad hash → 409 confirmation_required
  const wrongHash = "0".repeat(64);
  const badReq = new Request("http://local/flight_book_offer", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      offer_id: offer.offer_id,
      passengers: [
        {
          given_name: "Ada",
          family_name: "Lovelace",
          email: "ada@example.com",
          type: "adult",
        },
      ],
      payment_method_id: "pm_stub_test",
      summary_hash: wrongHash,
      user_confirmed: true,
    }),
  });
  const badRes = await postBook(badReq);
  assert(
    "book with wrong summary_hash → 409 confirmation_required",
    badRes.status === 409,
    String(badRes.status),
  );
  const badBody = await badRes.json();
  assert(
    "409 body error === 'confirmation_required'",
    badBody.error === "confirmation_required",
    badBody.error,
  );

  // 5b. Right hash → 200 + booking_id
  const rightHash = itineraryHash(offer);
  // Sanity: confirm our canonical summary + shell-side hash agree with
  // the server's itineraryHash(). If these diverge the gate can NEVER pass.
  const shellSideHash = hashSummary(canonicalItinerarySummary(offer));
  assert(
    "shell-computed hash == server itineraryHash",
    rightHash === shellSideHash,
    `${rightHash.slice(0, 12)}… ?= ${shellSideHash.slice(0, 12)}…`,
  );

  const goodReq = new Request("http://local/flight_book_offer", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-idempotency-key": "smk_" + Date.now(),
    },
    body: JSON.stringify({
      offer_id: offer.offer_id,
      passengers: [
        {
          given_name: "Ada",
          family_name: "Lovelace",
          email: "ada@example.com",
          type: "adult",
        },
      ],
      payment_method_id: "pm_stub_test",
      summary_hash: rightHash,
      user_confirmed: true,
    }),
  });
  const goodRes = await postBook(goodReq);
  assert("book with correct hash → 200", goodRes.status === 200, String(goodRes.status));
  const goodBody = await goodRes.json();
  assert(
    "booking response has booking_id + pnr",
    typeof goodBody.booking_id === "string" && typeof goodBody.pnr === "string",
    `${goodBody.booking_id} / ${goodBody.pnr}`,
  );
  assert(
    "booking total matches offer total",
    goodBody.total_amount === offer.total_amount &&
      goodBody.total_currency === offer.total_currency,
    `${goodBody.total_amount} ${goodBody.total_currency}`,
  );

  // ── Summary
  console.log("\n── Summary\n");
  const failed = checks.filter((c) => !c.ok);
  if (failed.length === 0) {
    console.log(`  ${checks.length}/${checks.length} checks passed.`);
    process.exit(0);
  } else {
    console.log(`  ${checks.length - failed.length}/${checks.length} passed.`);
    for (const f of failed) {
      console.log(`  ✗ ${f.name}${f.detail ? `  — ${f.detail}` : ""}`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(1);
});
