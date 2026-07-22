import "dotenv/config";
import crypto from "node:crypto";
import express from "express";
import { serve } from "inngest/express";
import { z } from "zod";
import {
  createCallSession,
  createTicket,
  getCallSession,
  getCustomer,
  getCustomerByContact,
  getTicket,
  getTicketByCallId,
  getTicketByRequestId,
  seedDemoData,
  transitionTicketStatus,
  type Ticket,
} from "./db.js";
import { inngest } from "./inngest/client.js";
import { functions } from "./inngest/functions.js";

const demoMode = process.env.DEMO_MODE === "1";
const apiToken = process.env.API_BEARER_TOKEN;

if (!apiToken && !demoMode) {
  throw new Error("API_BEARER_TOKEN is required unless DEMO_MODE=1 is explicitly enabled");
}
if (demoMode && process.env.NODE_ENV === "production") {
  throw new Error("DEMO_MODE=1 cannot be used in production");
}

seedDemoData();

const callSessionSchema = z.object({
  callId: z.string().min(1).max(200),
  callerNumber: z.string().min(1).max(32),
  calledNumber: z.string().min(1).max(32),
}).strict();

const ticketSchema = z.object({
  callId: z.string().min(1).max(200),
  requestId: z.string().min(1).max(200),
  customerQuestion: z.string().min(1).max(4_000),
  deviceModel: z.string().min(1).max(100).optional(),
  firmwareVersion: z.string().min(1).max(100).optional(),
  symptom: z.string().min(1).max(1_000).optional(),
  errorCode: z.string().min(1).max(100).optional(),
}).strict();

const resolutionSchema = z.object({ answer: z.string().min(1).max(4_000) }).strict();
const feedbackSchema = z.object({ helpful: z.boolean() }).strict();

type TicketInput = z.infer<typeof ticketSchema>;

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

function sendApiError(response: express.Response, error: unknown) {
  if (error instanceof ApiError) {
    return response.status(error.status).json({ error: error.code, message: error.message, ...error.extra });
  }
  return response.status(500).json({ error: "internal_error", message: "Unexpected server error" });
}

function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ApiError(400, "invalid_request", "Request body does not match the API contract");
  }
  return result.data;
}

function requireApiToken(request: express.Request, response: express.Response) {
  if (!apiToken || request.get("authorization") !== `Bearer ${apiToken}`) {
    response.status(401).json({ error: "unauthorized", message: "Valid bearer authentication is required" });
    return false;
  }
  return true;
}

function publicCustomer(customer: NonNullable<ReturnType<typeof getCustomer>>) {
  return {
    name: customer.name,
    product: customer.product,
    deviceModel: customer.replicator_model,
    firmwareVersion: customer.firmware_version,
  };
}

function requireActiveCallSession(callId: string) {
  const session = getCallSession(callId);
  if (!session) throw new ApiError(404, "call_session_not_found", "No trusted call session was found");
  if (Date.parse(session.expires_at) <= Date.now()) {
    throw new ApiError(409, "call_session_expired", "The trusted call session has expired");
  }
  const customer = getCustomer(session.customer_id);
  if (!customer) throw new ApiError(404, "customer_not_found", "The call session has no matching customer");
  return { session, customer };
}

function registerTrustedCallSession(input: z.infer<typeof callSessionSchema>) {
  const customer = getCustomerByContact(input.callerNumber);
  if (!customer) {
    throw new ApiError(404, "caller_not_found", "No customer matches the trusted caller number");
  }

  const existing = getCallSession(input.callId);
  if (existing) {
    if (existing.caller_number !== input.callerNumber || existing.called_number !== input.calledNumber) {
      throw new ApiError(409, "call_context_conflict", "callId was already registered with different trusted context");
    }
    return { session: existing, customer, created: false };
  }

  const expiresAt = new Date(Date.now() + 30 * 60 * 1_000).toISOString();
  const session = createCallSession({ ...input, customerId: customer.id, expiresAt });
  return { session, customer, created: true };
}

function ticketMatches(ticket: Ticket, input: TicketInput, customerId: string) {
  return ticket.request_id === input.requestId
    && ticket.call_id === input.callId
    && ticket.customer_id === customerId
    && ticket.issue === input.customerQuestion
    && ticket.device_model === (input.deviceModel ?? null)
    && ticket.firmware_version === (input.firmwareVersion ?? null)
    && ticket.symptom === (input.symptom ?? null)
    && ticket.error_code === (input.errorCode ?? null);
}

type EventSender = (event: Parameters<typeof inngest.send>[0]) => ReturnType<typeof inngest.send>;

async function dispatchTicket(ticket: Ticket, sendEvent: EventSender) {
  if (ticket.status !== "event_pending" && ticket.status !== "event_failed") return ticket;
  try {
    await sendEvent({
      id: `support-ticket-created-${ticket.request_id}`,
      name: "support/ticket.created",
      data: { ticketId: ticket.id, requestId: ticket.request_id, callId: ticket.call_id },
      meta: { sessions: { ticket_id: ticket.id, call_id: ticket.call_id ?? "unknown" } },
    });
  } catch {
    transitionTicketStatus(ticket.id, ["event_pending", "event_failed"], "event_failed");
    throw new ApiError(503, "workflow_dispatch_failed", "The research workflow could not be started", {
      ticketId: ticket.id,
      status: "event_failed",
      retryable: true,
    });
  }

  transitionTicketStatus(ticket.id, ["event_pending", "event_failed"], "researching");
  return getTicket(ticket.id)!;
}

async function createAndDispatchTicket(input: TicketInput, sendEvent: EventSender) {
  const { customer } = requireActiveCallSession(input.callId);
  let ticket = getTicketByRequestId(input.requestId) ?? getTicketByCallId(input.callId);
  let created = false;

  if (ticket) {
    if (!ticketMatches(ticket, input, customer.id)) {
      throw new ApiError(409, "idempotency_conflict", "requestId was already used with different ticket content");
    }
  } else {
    try {
      ticket = createTicket(
        {
          requestId: input.requestId,
          callId: input.callId,
          customerId: customer.id,
          issue: input.customerQuestion,
        },
        {
          deviceModel: input.deviceModel,
          firmwareVersion: input.firmwareVersion,
          symptom: input.symptom,
          errorCode: input.errorCode,
        },
      );
      created = true;
    } catch {
      ticket = getTicketByRequestId(input.requestId);
      if (!ticket || !ticketMatches(ticket, input, customer.id)) {
        throw new ApiError(409, "idempotency_conflict", "requestId was already used with different ticket content");
      }
    }
  }

  const dispatched = await dispatchTicket(ticket, sendEvent);
  return { ticket: dispatched, created };
}

export function createApp({ sendEvent = inngest.send.bind(inngest) as EventSender }: { sendEvent?: EventSender } = {}) {
  const app = express();
  app.use(express.json({ limit: "128kb" }));

  app.get("/health", (_request, response) => response.json({ ok: true }));

  // This is called at the beginning of a Vapi call using static, trusted call
  // fields. The backend, not model-controlled input, chooses the customer.
  app.post("/api/call-sessions", (request, response) => {
    if (!requireApiToken(request, response)) return;
    try {
      const input = parse(callSessionSchema, request.body);
      const { session, customer, created } = registerTrustedCallSession(input);
      return response.status(created ? 201 : 200).json({ callId: session.call_id, expiresAt: session.expires_at, customer: publicCustomer(customer) });
    } catch (error) {
      return sendApiError(response, error);
    }
  });

  app.post("/api/customers/lookup", (request, response) => {
    if (!requireApiToken(request, response)) return;
    try {
      const callIdOnly = z.object({ callId: z.string().min(1).max(200) }).strict().safeParse(request.body);
      const customer = callIdOnly.success
        ? requireActiveCallSession(callIdOnly.data.callId).customer
        : registerTrustedCallSession(parse(callSessionSchema, request.body)).customer;
      return response.json(publicCustomer(customer));
    } catch (error) {
      return sendApiError(response, error);
    }
  });

  app.post("/api/tickets", async (request, response) => {
    if (!requireApiToken(request, response)) return;
    try {
      const { ticket, created } = await createAndDispatchTicket(parse(ticketSchema, request.body), sendEvent);
      return response.status(created ? 201 : 200).json({ ticketId: ticket.id, requestId: ticket.request_id, status: ticket.status, created });
    } catch (error) {
      return sendApiError(response, error);
    }
  });

  // Local-only shortcut. It remains unavailable unless DEMO_MODE=1 is explicit.
  app.post("/test", async (request, response) => {
    if (!demoMode) return response.status(404).json({ error: "not_found" });
    try {
      const { ticket, created } = await createAndDispatchTicket(parse(ticketSchema, request.body), sendEvent);
      return response.status(created ? 201 : 200).json({ ticketId: ticket.id, requestId: ticket.request_id, status: ticket.status, created });
    } catch (error) {
      return sendApiError(response, error);
    }
  });

  // Kept as a compatibility adapter while Amanda owns the Vapi configuration.
  // It never accepts customer identity from tool arguments.
  app.post("/api/vapi/tools", async (request, response) => {
    if (!requireApiToken(request, response)) return;
    const calls = request.body?.message?.toolCallList;
    const trustedCallId = request.body?.message?.call?.id;
    if (!Array.isArray(calls) || typeof trustedCallId !== "string") {
      return response.status(400).json({ error: "invalid_vapi_payload", message: "A Vapi call ID and tool calls are required" });
    }

    const results = [];
    for (const call of calls) {
      const args = call.arguments ?? call.function?.parameters ?? {};
      try {
        if (call.name === "lookup_customer") {
          const { customer } = requireActiveCallSession(trustedCallId);
          results.push({ toolCallId: call.id, result: publicCustomer(customer) });
        } else if (call.name === "create_support_ticket") {
          const input = parse(ticketSchema, { ...args, callId: trustedCallId });
          const { ticket } = await createAndDispatchTicket(input, sendEvent);
          results.push({ toolCallId: call.id, result: { created: true, ticketId: ticket.id, status: ticket.status } });
        } else {
          results.push({ toolCallId: call.id, result: { error: "unknown_tool" } });
        }
      } catch (error) {
        const apiError = error instanceof ApiError ? error : new ApiError(500, "internal_error", "Unexpected server error");
        results.push({ toolCallId: call.id, result: { created: false, error: apiError.code, retryable: apiError.status === 503 } });
      }
    }
    return response.json({ results });
  });

  app.get("/api/tickets/:ticketId", (request, response) => {
    if (!requireApiToken(request, response)) return;
    const ticket = getTicket(request.params.ticketId);
    if (!ticket) return response.status(404).json({ error: "ticket_not_found" });
    return response.json(ticket);
  });

  app.post("/api/tickets/:ticketId/resolve", async (request, response) => {
    if (!requireApiToken(request, response)) return;
    try {
      const { answer } = parse(resolutionSchema, request.body);
      const ticket = getTicket(request.params.ticketId);
      if (!ticket) throw new ApiError(404, "ticket_not_found", "Ticket was not found");
      if (ticket.status !== "needs_human_review") {
        throw new ApiError(409, "invalid_ticket_state", "Human resolution is only allowed while a ticket needs review");
      }
      try {
        await sendEvent({
          id: `support-human-resolution-${ticket.id}`,
          name: "support/human-resolution.received",
          data: { ticketId: ticket.id, requestId: ticket.request_id, callId: ticket.call_id, answer },
          meta: { sessions: { ticket_id: ticket.id, call_id: ticket.call_id ?? "unknown" } },
        });
      } catch {
        throw new ApiError(503, "workflow_dispatch_failed", "The resolution event could not be sent", {
          ticketId: ticket.id,
          status: ticket.status,
          retryable: true,
        });
      }
      transitionTicketStatus(ticket.id, ["needs_human_review"], "human_resolved");
      return response.json({ ok: true, ticketId: ticket.id, status: "human_resolved" });
    } catch (error) {
      return sendApiError(response, error);
    }
  });

  app.post("/api/tickets/:ticketId/feedback", async (request, response) => {
    if (!requireApiToken(request, response)) return;
    try {
      const { helpful } = parse(feedbackSchema, request.body);
      const ticket = getTicket(request.params.ticketId);
      if (!ticket) throw new ApiError(404, "ticket_not_found", "Ticket was not found");
      await sendEvent({
        id: `support-customer-feedback-${ticket.id}`,
        name: "support/customer-feedback.received",
        data: { ticketId: ticket.id, helpful },
        meta: { sessions: { ticket_id: ticket.id } },
      });
      return response.json({ ok: true });
    } catch (error) {
      return sendApiError(response, error);
    }
  });

  app.use("/api/inngest", serve({ client: inngest, functions }));
  return app;
}

const app = createApp();
const port = Number(process.env.PORT ?? 3000);
if (process.env.VOICE_AGENT_NO_LISTEN !== "1") {
  app.listen(port, () => console.log(`Voice-agent demo listening on http://localhost:${port}`));
}
