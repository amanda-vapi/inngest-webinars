# Vapi Simulation Coverage

These three simulations test the conversation layer with adaptive AI callers and deterministic tool mocks. They complement the repository's deterministic tests; they do not replace the real API and Inngest workflow checks.

| Layer | Existing coverage | What it proves |
| --- | --- | --- |
| `npm test` | Domain and configuration tests | Validation, idempotency, state transitions, delivery deduplication, and versioned simulation payloads |
| `npm run test:demo` | Real local APIs and Inngest | Authentication, API contracts, duplicate requests, the ticket-to-event handoff, and workflow completion |
| `npm run test:vapi` | Scripted Vapi Chat conversations with real tools | The known success, decline, and no-match branches against the deployed assistant |
| `npm run test:vapi-simulations` | Adaptive Vapi callers with structured evaluations and tool mocks | Conversation behavior across natural variations, guardrail pressure, and a forced failure path |

`npm run test:coverage` currently reports 96.62% line, 78.05% branch, and 86.96% function coverage for the source modules imported by the unit suite (`db.ts` and `schemas.ts`). Those figures are not repository-wide coverage: `server.ts`, the Inngest functions, deployment scripts, and hosted assistant behavior run through separate integration commands and are not instrumented by that report.

## Why these three

1. **Confirmed Ticket** covers the demo's central contract: lookup first, explicit confirmation, unambiguous readback of voice-critical identifiers, one correctly populated ticket call, exact caller-reference fidelity, no internal UUID disclosure, and no claim of caller verification. The assistant's Deepgram Flux configuration includes a small `keyterm` list for the demo's uncommon product and error identifiers.
2. **Unknown Caller** makes the no-match test adversarial and finite. It checks one contact recheck followed by a terminal branch where caller-supplied account data and urgency cannot bypass the matched-customer boundary, trigger disclosure, or restart the contact loop.
3. **Workflow Dispatch Failure** forces the durability boundary that is difficult to reproduce live. It checks that `ticketSaved: true` does not become a success claim when `workflowStarted: false`, plus permission before retry, respect for a declined retry, and no improvised privacy promise when a cautious caller asks how the demo handles contact data.

The scenarios use Vapi's built-in Decisive Derek, Impatient Irene, and Skeptical Sam personalities. Tool mocks isolate assistant behavior from tunnel availability and keep the webinar repeatable. The real local workflow remains covered separately by `test:demo` and `test:vapi`.

## Provision and run

Vapi currently labels Simulations as pre-release, so review the [Simulations quickstart](https://docs.vapi.ai/observability/simulations-quickstart) and [advanced guide](https://docs.vapi.ai/observability/simulations-advanced) if the API changes.

Deploy the versioned assistant and tools, then run the live-configuration preflight before creating or updating the scenarios, simulations, and suite:

```bash
npm run deploy:vapi
npm run check:vapi-config
npm run setup:vapi-simulations
```

This writes `VAPI_SIMULATION_SUITE_ID` to `.env` and does not run the suite.

The simulation runner repeats this preflight automatically and stops before starting a paid run if the live assistant or tools have drifted.

Run one iteration of all three in chat mode:

```bash
npm run test:vapi-simulations
```

Run the same suite through the full audio path only when voice behavior is worth the added time and cost:

```bash
npm run test:vapi-simulations -- --voice
```

Use `--iterations=3` when demonstrating non-determinism or comparing pass rates. A voice simulation uses two concurrent call slots—one for the tester and one for the assistant under test.

## Deliberate limits

- The structured evaluations are LLM judgments, so a single passing run is evidence rather than a mathematical guarantee.
- Tool mocks validate conversational handling, not the HTTP credential, request template, or Inngest execution. The other test layers cover those boundaries.
- Voice mode can expose transcription, pronunciation, interruption, and synthesis issues, but this suite does not claim telephony-provider or production-network coverage.
- Voice recordings are private call artifacts. Use Vapi's authenticated call-artifact retrieval endpoint for a call ID instead of relying on the deprecated `recordingUrl` field.
- This educational project does not add CI quality gates, scheduled runs, production monitoring, or historical pass-rate requirements.
