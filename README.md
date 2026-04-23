# Lumo Flight Agent

Duffel-backed flight search, pricing, and booking, exposed to the Lumo Super
Agent over HTTP via the [`@lumo/agent-sdk`](../Lumo_Agent_SDK) contract.

This is a **standalone repo**. It ships as its own Vercel project at
`flight.agents.lumo.rentals` so a bad deploy here can never take down the
shell or any other agent. That fault-isolation promise is the whole reason
the repo is separate.

## The contract

Every Lumo specialist agent serves three endpoints. The shell reads them on
boot; validation failure in any one means the agent is skipped.

| Endpoint | What it serves |
| --- | --- |
| `GET /.well-known/agent.json` | `AgentManifest` — identity, intents, PII scope, SLA |
| `GET /openapi.json` | OpenAPI 3.1 document with `x-lumo-*` annotations on tool operations |
| `GET /api/health` | `HealthReport` — status, deps, dependency latencies |

Tool operations (under `/api/tools/*`) are what the orchestrator actually
dispatches when Claude selects a tool. This agent exposes three:

- `flight_search_offers` — safe, read-only
- `flight_price_offer` — safe, read-only, attaches the `_lumo_summary`
  envelope the shell hashes for the confirmation gate
- `flight_book_offer` — money-moving, refuses to execute unless the caller
  presents a `summary_hash` matching the most recent priced offer

## Run locally

```bash
pnpm install
pnpm dev            # serves on http://localhost:3002
pnpm smoke          # runs scripts/smoke.ts (no Next process needed)
```

The smoke test exercises the exact code paths the shell hits at boot and on
first money-tool dispatch, including the confirmation gate on both the wrong-
hash (expect 409) and right-hash (expect 200 + `booking_id`) paths.

## Dependency on `@lumo/agent-sdk`

During local dev the SDK is pinned to a sibling directory:

```json
"@lumo/agent-sdk": "file:../Lumo_Agent_SDK"
```

For CI and prod, swap to a git tag so builds are reproducible:

```json
"@lumo/agent-sdk": "git+https://github.com/lumo-rentals/lumo-agent-sdk.git#v0.1.0"
```

Or — once GitHub Packages is set up — the scoped npm version:

```json
"@lumo/agent-sdk": "^0.1.0"
```

## Environment

See `.env.example`. Secrets (Duffel, Stripe) live only here, never in the
shell's env.

## Why this agent is its own repo

- A bug in flight-booking cannot break food-ordering or the shell itself.
- The Flight team can ship on their own cadence without shell-team review.
- Security blast radius is contained: a compromised Flight deploy exposes
  only Duffel + payment method scope, nothing else.
- Agent-level SLAs become meaningful because agent-level deploys do.

If any of that stops being true, the architecture is broken — talk to the
Lumo platform team before papering over it.

## Deploy to Vercel

Full runbook at [`../DEPLOYMENT.md`](../DEPLOYMENT.md). The short
version:

1. **Swap the SDK dep** (Vercel has no sibling folder):
   ```json
   "@lumo/agent-sdk": "git+https://github.com/Prasanth-Kalas/Lumo_Agent_SDK.git#v0.2.0"
   ```
   Commit and push before importing on Vercel.
2. **Import on Vercel.** Framework: Next.js. `vercel.json` in this
   repo pins tool routes to `maxDuration: 30` (plenty for Duffel
   round-trips).
3. **Set env vars:**
   - `DUFFEL_ACCESS_TOKEN` — sandbox for preview, live only after
     Seller-of-Travel review.
   - `LUMO_AGENT_PUBLIC_URL=https://<your-flight-project>.vercel.app`
     (or your custom domain once DNS resolves).
4. **Verify before pointing the shell at it:**
   ```bash
   curl https://<flight-url>/.well-known/agent.json | jq .agent_id
   # → "flight_agent"
   curl https://<flight-url>/api/health | jq .status
   # → "ok"
   ```
   If either fails, fix the agent before updating the shell's
   `LUMO_FLIGHT_AGENT_URL` — the shell gracefully drops flight tools
   when the manifest probe fails, which will silently hide this agent
   from users.

**Kill-switch.** If Duffel's sandbox is flapping and you want the shell
to stop offering flight tools immediately without redeploying this
repo, flip `"flight": { "enabled": false }` in the shell's
`config/agents.registry.vercel.json` and redeploy the shell. That's
faster than rolling back here.
