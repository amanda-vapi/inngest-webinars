# Building a Voice Agent

A deliberately small Vapi + Inngest support-agent demo for the webinar.

Vapi verifies a caller and creates a support ticket. That ticket emits an
Inngest event. Inngest researches the local database, sends an answer when it
finds one, or waits for a human resolution when it does not.

## What is included

- A local SQLite database with a replicator owner, firmware release, FAQ,
  known update issue, and service-history record.
- A Vapi custom-tool endpoint with only `lookup_customer` and
  `create_support_ticket`.
- Three Inngest functions: research, human-review wait, and mock email send.

## Setup

```bash
npm install
cp .env.example .env
npm run dev
```

In a second terminal, start the Inngest Dev Server:

```bash
npm run inngest:dev
```

Open `http://localhost:8288` to inspect the functions and runs.

### Local Dev Server

Keep `INNGEST_DEV=1` in `.env`. This is the standard Inngest local-development
configuration and uses port `8288`. The `inngest:dev` command disables
auto-discovery and syncs only this project's `/api/inngest` endpoint. If port
`8288` is in use, it stops with a clear error rather than silently changing
ports.

## Environment variables

For local work, leave the Inngest Cloud keys blank and keep `INNGEST_DEV=1`.
For the recorded Cloud run, set these in the deployed app:

| Variable | Used for |
| --- | --- |
| `VAPI_API_KEY` | Provisioning/running Vapi (added in the next step) |
| `INNGEST_EVENT_KEY` | Sending events to Inngest Cloud |
| `INNGEST_SIGNING_KEY` | Authenticating the deployed Inngest serve endpoint |

An Inngest project ID or a custom `INNGEST_CLIENT_SECRET` is not required by
this service. The Event Key and Signing Key identify and authenticate the app.

## Vapi tools

Configure these two function tools in Vapi to point at the public version of
`/api/vapi/tools`:

| Tool | Input |
| --- | --- |
| `lookup_customer` | `contact` (email or phone) |
| `create_support_ticket` | `customerId`, `issue` |

Vapi needs a public URL. During local work, expose this app with a tunnel.

## Test the long-running workflow

With the app and Inngest Dev Server running, post the same payload that Vapi
will use to create a ticket:

```bash
curl -X POST http://localhost:3000/test \
  -H 'content-type: application/json' \
  -d '{
    "customerId": "cus_amanda",
    "issue": "My replicator stopped working after the latest update.",
    "deviceModel": "XR-200",
    "firmwareVersion": "9.4.0",
    "symptom": "The thermal-safety light flashes and no item is replicated.",
    "errorCode": "THERM-94",
    "followUpMethod": "email"
  }'
```

Open `http://localhost:8288` and select `research-support-ticket` to follow
the CRM, support-history, ticket-system, knowledge-base, FAQ, operations, and
firmware fan-out, followed by the judge, draft, and delivery steps. The
complete API contract is in
[`openapi.yaml`](./openapi.yaml).

The Operations lookup deliberately returns one simulated `503` on the first
attempt. Inngest retries that step while preserving completed research steps,
so the trace includes a concise retry example.

## Test the human-review branch

Create a ticket whose issue has no matching FAQ, then post a resolution after
the workflow reaches its wait step:

```bash
curl -X POST http://localhost:3000/api/tickets/TICKET_ID/resolve \
  -H 'content-type: application/json' \
  -d '{"answer":"We are investigating this and will follow up."}'
```

The waiting Inngest run resumes and queues the same mock email function.
