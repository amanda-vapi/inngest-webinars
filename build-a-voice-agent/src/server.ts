import "dotenv/config";
import express from "express";
import { serve } from "inngest/express";
import { timingSafeEqual } from "node:crypto";
import { createTicketIdempotently, getCustomer, getCustomerByContact, getTicket, IdempotencyConflictError, resetDemoData, seedDemoData, transitionTicketStatus } from "./db.js";
import { functions } from "./inngest/functions.js";
import { inngest } from "./inngest/client.js";
import { createSupportTicketRequestSchema, humanResolutionSchema } from "./schemas.js";

seedDemoData();
const apiBearerToken = process.env.API_BEARER_TOKEN;
if (!apiBearerToken) throw new Error("Missing API_BEARER_TOKEN; run npm run setup:local first");
const app = express();
app.use(express.json({ limit: "1mb" }));

function authorized(request: express.Request, response: express.Response) {
  const actual = request.get("authorization") ?? "";
  const expected = `Bearer ${apiBearerToken}`;
  if (
    actual.length === expected.length &&
    timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
  ) return true;
  response.status(401).json({ error: "invalid_authentication" });
  return false;
}

async function createAndTriggerTicket(input: unknown) {
  const parsed = createSupportTicketRequestSchema.parse(input);
  const { requestId, ...ticketRequest } = parsed;
  const customer = getCustomer(ticketRequest.customerId);
  if (!customer) throw new Error("Customer not found");
  const result = createTicketIdempotently({
    ...ticketRequest,
    deviceModel: ticketRequest.deviceModel ?? customer.deviceModel,
    firmwareVersion: ticketRequest.firmwareVersion ?? customer.firmwareVersion,
  }, requestId);

  if (["event_pending", "event_failed"].includes(result.ticket.status)) {
    try {
      await inngest.send({
        id: `support-ticket-created-${requestId}`,
        name: "support/ticket.created",
        data: { ticketId: result.ticket.id, requestId },
      });
    } catch {
      const markedFailed = transitionTicketStatus(
        result.ticket.id,
        ["event_pending", "event_failed"],
        "event_failed",
      );
      if (markedFailed) {
        throw new TicketDispatchError(result.ticket.id, result.ticket.reference);
      }
    }
    transitionTicketStatus(
      result.ticket.id,
      ["event_pending", "event_failed"],
      "researching",
    );
  }

  return { ...result, ticket: getTicket(result.ticket.id)! };
}

class TicketDispatchError extends Error {
  constructor(
    readonly ticketId: string,
    readonly ticketReference: string,
  ) {
    super("The ticket was saved, but the support workflow has not started yet");
    this.name = "TicketDispatchError";
  }
}

function ticketErrorResponse(error: unknown, response: express.Response) {
  if (error instanceof IdempotencyConflictError) {
    response.status(409).json({ error: "idempotency_conflict" });
    return true;
  }
  if (error instanceof TicketDispatchError) {
    response.status(503).json({
      ok: false,
      error: "workflow_dispatch_failed",
      ticketId: error.ticketId,
      ticketReference: error.ticketReference,
      ticketSaved: true,
      workflowStarted: false,
      status: "event_failed",
      retryable: true,
    });
    return true;
  }
  return false;
}

app.get("/", (_request, response) => response.json({
  ok: true,
  service: "inngest-webinar",
  vapiApiRequestTools: {
    lookup_customer: "GET /api/customers?contact={{contact}}",
    create_support_ticket: "POST /api/tickets",
  },
  endpoints: { health: "/health", customers: "/api/customers", tickets: "/api/tickets", inngest: "/api/inngest" },
}));
app.get("/health", (_request, response) => response.json({ ok: true }));

app.get("/api/customers", (request, response) => {
  if (!authorized(request, response)) return;
  const contact = typeof request.query.contact === "string"
    ? request.query.contact
    : typeof request.query.email === "string"
      ? request.query.email
      : request.query.phone;
  if (typeof contact !== "string") return response.status(400).json({ error: "Provide email or phone" });
  const customer = getCustomerByContact(contact);
  if (!customer) {
    return response.json({
      matched: false,
      nextAction: "recheck_contact",
    });
  }
  return response.json({
    matched: true,
    customerId: customer.id,
    product: customer.product,
    deviceModel: customer.deviceModel,
    firmwareVersion: customer.firmwareVersion,
  });
});

app.post("/api/tickets", async (request, response) => {
  if (!authorized(request, response)) return;
  try {
    const result = await createAndTriggerTicket(request.body);
    response.status(result.created ? 201 : 200).json({
      ok: true,
      created: result.created,
      ticketId: result.ticket.id,
      ticketReference: result.ticket.reference,
      ticketSaved: true,
      workflowStarted: true,
      status: result.ticket.status,
      duplicate: !result.created,
      retryable: false,
    });
  } catch (error) {
    if (ticketErrorResponse(error, response)) return;
    response.status(400).json({ error: error instanceof Error ? error.message : "Unable to create ticket" });
  }
});

app.post("/test", async (request, response) => {
  if (!authorized(request, response)) return;
  try {
    const result = await createAndTriggerTicket(request.body);
    response.status(result.created ? 201 : 200).json({
      ok: true,
      created: result.created,
      ticketId: result.ticket.id,
      ticketReference: result.ticket.reference,
      ticketSaved: true,
      workflowStarted: true,
      status: result.ticket.status,
      duplicate: !result.created,
      retryable: false,
    });
  } catch (error) {
    if (ticketErrorResponse(error, response)) return;
    response.status(400).json({ error: error instanceof Error ? error.message : "Unable to create ticket" });
  }
});

app.get("/api/tickets/:ticketId", (request, response) => {
  if (!authorized(request, response)) return;
  const ticket = getTicket(request.params.ticketId);
  return ticket ? response.json(ticket) : response.status(404).json({ error: "Ticket not found" });
});

app.post("/api/tickets/:ticketId/resolve", async (request, response) => {
  if (!authorized(request, response)) return;
  const ticket = getTicket(request.params.ticketId);
  if (!ticket) return response.status(404).json({ error: "ticket_not_found" });
  const parsed = humanResolutionSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: "invalid_resolution" });
  if (ticket.status !== "needs_human_review") {
    return response.status(409).json({
      error: "ticket_not_waiting_for_human_review",
      status: ticket.status,
    });
  }
  const { answer } = parsed.data;
  try {
    await inngest.send({
      id: `support-human-resolution-${ticket.id}`,
      name: "support/human-resolution.received",
      data: { ticketId: ticket.id, answer },
    });
  } catch {
    return response.status(503).json({ error: "resolution_dispatch_failed", retryable: true });
  }
  transitionTicketStatus(ticket.id, ["needs_human_review"], "human_resolved", answer);
  return response.json({ ok: true });
});

app.post("/api/demo/reset", (_request, response) => {
  if (!authorized(_request, response)) return;
  resetDemoData();
  response.json({ ok: true });
});

app.use("/api/inngest", serve({ client: inngest, functions }));

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`Inngest webinar listening on http://localhost:${port}`));
