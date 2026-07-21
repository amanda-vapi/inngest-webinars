import "dotenv/config";
import express from "express";
import { serve } from "inngest/express";
import { createTicket, getCustomer, getCustomerByContact, getTicket, seedDemoData, updateTicketStatus } from "./db.js";
import { inngest } from "./inngest/client.js";
import { functions } from "./inngest/functions.js";

seedDemoData();

const app = express();
app.use(express.json());

app.get("/health", (_request, response) => response.json({ ok: true }));

function requireApiToken(request: express.Request, response: express.Response) {
  const token = process.env.API_BEARER_TOKEN;
  if (!token) return true;
  if (request.get("authorization") === `Bearer ${token}`) return true;
  response.status(401).json({ error: "Unauthorized" });
  return false;
}

async function createAndTriggerTicket(input: {
  customerId: string;
  customerQuestion?: string;
  issue?: string;
  deviceModel?: string;
  firmwareVersion?: string;
  symptom?: string;
  errorCode?: string;
  followUpMethod?: string;
}) {
  const customer = getCustomer(input.customerId);
  const customerQuestion = input.customerQuestion ?? input.issue;
  if (!customer || !customerQuestion) throw new Error("A valid customerId and customerQuestion are required");
  const ticket = createTicket(customer.id, customerQuestion, {
    deviceModel: input.deviceModel ?? customer.replicator_model,
    firmwareVersion: input.firmwareVersion ?? customer.firmware_version,
    symptom: input.symptom,
    errorCode: input.errorCode,
    followUpMethod: input.followUpMethod,
  });
  await inngest.send({
    id: `support-ticket-created-${ticket.id}`,
    name: "support/ticket.created",
    data: { ticketId: ticket.id },
    meta: { sessions: { ticket_id: ticket.id } },
  });
  return ticket;
}

// These are the small database APIs Amanda can use directly from Vapi.
app.get("/api/customers", (request, response) => {
  if (!requireApiToken(request, response)) return;
  const contact = typeof request.query.email === "string" ? request.query.email : request.query.phone;
  if (typeof contact !== "string") return response.status(400).json({ error: "Provide email or phone" });
  const customer = getCustomerByContact(contact);
  if (!customer) return response.status(404).json({ error: "Customer not found" });
  return response.json(customer);
});

app.post("/api/tickets", async (request, response) => {
  if (!requireApiToken(request, response)) return;
  try {
    const ticket = await createAndTriggerTicket(request.body ?? {});
    return response.status(201).json(ticket);
  } catch (error) {
    return response.status(400).json({ error: error instanceof Error ? error.message : "Unable to create ticket" });
  }
});

// Local webinar shortcut: same body as POST /api/tickets, but no auth layer.
// Use it to trigger the full workflow without Vapi.
app.post("/test", async (request, response) => {
  try {
    const ticket = await createAndTriggerTicket(request.body ?? {});
    return response.status(201).json({ ticketId: ticket.id, status: ticket.status });
  } catch (error) {
    return response.status(400).json({ error: error instanceof Error ? error.message : "Unable to create ticket" });
  }
});

// Vapi posts every custom-tool call here. We support only the two tools needed
// for the webinar, keeping the voice-agent surface intentionally small.
app.post("/api/vapi/tools", async (request, response) => {
  const calls = request.body?.message?.toolCallList ?? [];
  const results = [];

  for (const call of calls) {
    const arguments_ = call.arguments ?? call.function?.parameters ?? {};
    if (call.name === "lookup_customer") {
      const customer = getCustomerByContact(arguments_.contact ?? "");
      results.push({
        toolCallId: call.id,
        result: customer
          ? {
              customerId: customer.id,
              name: customer.name,
              product: customer.product,
              deviceModel: customer.replicator_model,
              firmwareVersion: customer.firmware_version,
            }
          : { found: false },
      });
      continue;
    }

    if (call.name === "create_support_ticket") {
      try {
        const ticket = await createAndTriggerTicket(arguments_);
        results.push({ toolCallId: call.id, result: { created: true, ticketId: ticket.id } });
      } catch (error) {
        results.push({ toolCallId: call.id, result: { created: false, error: error instanceof Error ? error.message : "Unable to create ticket" } });
      }
      continue;
    }

    results.push({ toolCallId: call.id, result: { error: `Unknown tool: ${call.name}` } });
  }

  response.json({ results });
});

app.get("/api/tickets/:ticketId", (request, response) => {
  const ticket = getTicket(request.params.ticketId);
  if (!ticket) return response.status(404).json({ error: "Ticket not found" });
  return response.json(ticket);
});

app.post("/api/tickets/:ticketId/resolve", async (request, response) => {
  if (!requireApiToken(request, response)) return;
  const ticket = getTicket(request.params.ticketId);
  const answer = request.body?.answer;
  if (!ticket || !answer) return response.status(400).json({ error: "A ticket and answer are required" });

  updateTicketStatus(ticket.id, "human_resolved");
  await inngest.send({
    name: "support/human-resolution.received",
    data: { ticketId: ticket.id, answer },
    meta: { sessions: { ticket_id: ticket.id } },
  });
  return response.json({ ok: true });
});

app.post("/api/tickets/:ticketId/feedback", async (request, response) => {
  if (!requireApiToken(request, response)) return;
  const ticket = getTicket(request.params.ticketId);
  if (!ticket || typeof request.body?.helpful !== "boolean") {
    return response.status(400).json({ error: "A ticket and boolean helpful value are required" });
  }
  await inngest.send({
    name: "support/customer-feedback.received",
    data: { ticketId: ticket.id, helpful: request.body.helpful },
    meta: { sessions: { ticket_id: ticket.id } },
  });
  return response.json({ ok: true });
});

app.use("/api/inngest", serve({ client: inngest, functions }));

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`Voice-agent demo listening on http://localhost:${port}`));
