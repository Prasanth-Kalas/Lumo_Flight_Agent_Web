# Flight Agent — smoke scripts

## `smoke.ts` — in-process contract + gate test

Exercises the shell's boot path and the confirmation gate without
booting a Next.js server. Good for CI and pre-commit.

```bash
pnpm --filter @lumo/flight-agent exec tsx scripts/smoke.ts
```

Checks, in order:

1. `buildManifest()` round-trips through `parseManifest()`.
2. `/.well-known/agent.json` handler serves that same manifest.
3. `/openapi.json` handler serves a document that
   `openApiToClaudeTools()` converts into **exactly 3 tools** —
   `flight_search_offers`, `flight_price_offer`, `flight_book_offer` —
   with the expected `cost_tier` / `requires_confirmation` /
   `pii_required`.
4. `/api/health` returns `status: "ok"`.
5. `flight_book_offer` rejects a wrong `summary_hash` with HTTP 409
   and accepts the correct hash with HTTP 200.

## Live-server curl recipe

After `pnpm --filter @lumo/flight-agent dev`:

```bash
# 1. Manifest
curl -s http://localhost:3002/.well-known/agent.json | jq .

# 2. OpenAPI
curl -s http://localhost:3002/openapi.json | jq '.paths | keys'

# 3. Health
curl -sS http://localhost:3002/api/health | jq .

# 4. Search
OFFER_ID=$(curl -s -X POST http://localhost:3002/api/tools/flight_search_offers \
  -H 'content-type: application/json' \
  -d '{
    "slices":[{"origin":"SFO","destination":"LAS","departure_date":"2026-05-01"}],
    "passengers":[{"type":"adult"}]
  }' | jq -r '.offers[0].offer_id')
echo "offer_id=$OFFER_ID"

# 5. Price
curl -s -X POST http://localhost:3002/api/tools/flight_price_offer \
  -H 'content-type: application/json' \
  -d "{\"offer_id\":\"$OFFER_ID\"}" | jq .

# 6. Book with wrong hash → expect 409 confirmation_required
curl -sS -o /dev/null -w '%{http_code}\n' \
  -X POST http://localhost:3002/api/tools/flight_book_offer \
  -H 'content-type: application/json' \
  -d "{
    \"offer_id\":\"$OFFER_ID\",
    \"passengers\":[{\"given_name\":\"Ada\",\"family_name\":\"Lovelace\",\"email\":\"ada@example.com\",\"type\":\"adult\"}],
    \"payment_method_id\":\"pm_stub_test\",
    \"summary_hash\":\"0000000000000000000000000000000000000000000000000000000000000000\",
    \"user_confirmed\":true
  }"
```

The smoke script is what the shell's CI will re-run on every deploy;
the curl recipe is for hands-on debugging.
