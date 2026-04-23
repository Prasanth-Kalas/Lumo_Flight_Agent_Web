# Flight Agent — repo history

This agent was initially developed inside the `Lumo-Agents` monorepo under
`apps/flight-agent/` so the contract + orchestrator + first consumer could
co-evolve without a publish step between every edit.

It was extracted to its own repo once the `@lumo/agent-sdk` contract stabilized
and the envelope-based confirmation protocol was smoke-tested end-to-end
(`scripts/smoke.ts`, 29/29 passing at extraction time).

The monorepo's workspace-link dep (`"@lumo/agent-sdk": "workspace:*"`) was
replaced with a `file:../Lumo_Agent_SDK` pin for local dev; CI and prod use
a git-URL or registry pin per the README.

The `EXTRACTION.md` planning doc that shipped with the monorepo version of
this agent has been deleted — it described the migration that this commit
is the execution of.
