import {
  findFaqs,
  findKnownIssues,
  findRelatedTickets,
  getCustomer,
  getFirmwareRelease,
  getKnowledgeBaseArticles,
  getSupportHistory,
  getTicket,
  recordEmail,
  updateTicketStatus,
} from "../db.js";
import { inngest } from "./client.js";
import { createScorer } from "inngest/experimental";

type ModelMessage = { role: "system" | "user"; content: string };

async function callOpenAI({ messages }: { messages: ModelMessage[] }) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model: "gpt-4.1-mini", response_format: { type: "json_object" }, messages }),
  });
  if (!response.ok) throw new Error(`OpenAI request failed: ${response.status}`);
  return (await response.json()) as { choices: Array<{ message: { content: string } }> };
}

function readJson(content: string) {
  return JSON.parse(content.replace(/^```json\s*|\s*```$/g, "")) as Record<string, unknown>;
}

async function simulateSystemLatency(system: string) {
  const base = Number(process.env.DEMO_SYSTEM_LATENCY_MS ?? 1200);
  const variation = [...system].reduce((sum, character) => sum + character.charCodeAt(0), 0) % 900;
  await new Promise((resolve) => setTimeout(resolve, base + variation));
}

// This score waits for the real-world outcome instead of asking a model to
// grade itself. It is visible in Inngest Cloud after a customer responds.
export const customerOutcomeScorer = createScorer(
  inngest,
  { id: "score-customer-outcome" },
  async ({ event, step }) => {
    const feedback = await step.waitForEvent("wait-for-customer-feedback", {
      event: "support/customer-feedback.received",
      timeout: "7d",
      match: "data.ticketId",
    });
    return { name: "customer-outcome", value: feedback?.data.helpful ?? false };
  },
);

export const researchSupportTicket = inngest.createFunction(
  { id: "research-support-ticket", triggers: [{ event: "support/ticket.created" }], retries: 2 },
  async ({ event, step, defer, attempt }) => {
    const ticket = await step.run("load-ticket", () => {
      const ticket = getTicket(event.data.ticketId);
      if (!ticket) throw new Error(`Ticket ${event.data.ticketId} was not found`);
      return ticket;
    });

    // This is the fan-out/fan-in moment of the demo. Each database lookup is a
    // durable step: a failure retries only that lookup, not the completed work.
    const [customer, supportHistory, relatedTickets, knowledgeBase, faqs, operations, firmware] = await Promise.all([
      step.run("crm-load-customer", async () => {
        await simulateSystemLatency("crm");
        return getCustomer(ticket.customer_id);
      }),
      step.run("support-history", async () => {
        await simulateSystemLatency("support-history");
        return getSupportHistory(ticket.customer_id);
      }),
      step.run("ticket-system-search", async () => {
        await simulateSystemLatency("ticket-system");
        return findRelatedTickets(ticket.customer_id, ticket.issue, ticket.id);
      }),
      step.run("knowledge-base-search", async () => {
        await simulateSystemLatency("knowledge-base");
        const customer = getCustomer(ticket.customer_id);
        return customer ? getKnowledgeBaseArticles(customer.replicator_model, customer.firmware_version) : [];
      }),
      step.run("faq-search", async () => {
        await simulateSystemLatency("faq");
        const customer = getCustomer(ticket.customer_id);
        return customer ? findFaqs(customer.product, ticket.issue) : [];
      }),
      step.run("operations-check-active-incidents", async () => {
        // Forces a retry of the operations call
        if (attempt === 0) {
          throw new Error("Operations API returned 503 Service Unavailable");
        }
        await simulateSystemLatency("operations");
        const customer = getCustomer(ticket.customer_id);
        return customer ? findKnownIssues(customer.product, ticket.issue) : [];
      }),
      step.run("firmware-service-release-details", async () => {
        await simulateSystemLatency("firmware");
        const customer = getCustomer(ticket.customer_id);
        return customer ? getFirmwareRelease(customer.firmware_version) : undefined;
      }),
    ]);

    if (!customer) throw new Error(`Customer ${ticket.customer_id} was not found`);

    const evidence = { customer, ticket, supportHistory, relatedTickets, knowledgeBase, faqs, operations, firmware };
    const fallbackAnswer = operations[0]?.workaround ?? knowledgeBase[0]?.content ?? faqs[0]?.answer;
    const judge = process.env.OPENAI_API_KEY
      ? readJson(
          (
            await step.ai.wrap("judge-research", callOpenAI, {
              messages: [
                { role: "system", content: "You are a support-quality judge. Return JSON: {confident:boolean, answer:string}. Only be confident when the supplied evidence supports a safe answer." },
                { role: "user", content: JSON.stringify(evidence) },
              ],
            })
          ).choices[0].message.content,
        )
      : { confident: Boolean(fallbackAnswer), answer: fallbackAnswer };
    const answer = judge.confident && typeof judge.answer === "string" ? judge.answer : undefined;
    await step.score("score-evidence-sufficient", {
      name: "evidence-sufficient",
      value: Boolean(answer),
    });
    if (!answer) {
      await step.run("mark-needs-human-review", () => updateTicketStatus(ticket.id, "needs_human_review"));
      await step.sendEvent("request-human-review", {
        name: "support/escalation.requested",
        data: { ticketId: ticket.id },
      });
      return { ticketId: ticket.id, status: "needs_human_review" };
    }

    const fallbackEmail = `Hi ${customer.name},\n\n${answer}\n\nBest,\nReplicator Support`;
    const emailBody = process.env.OPENAI_API_KEY
      ? String(
          readJson(
            (
              await step.ai.wrap("draft-customer-email", callOpenAI, {
                messages: [
                  { role: "system", content: "Write a concise, calm customer-support email. Return JSON: {email:string}. Do not invent facts." },
                  { role: "user", content: JSON.stringify({ customer: customer.name, answer }) },
                ],
              })
            ).choices[0].message.content,
          ).email,
        )
      : fallbackEmail;
    await step.sendEvent("queue-email", {
      name: "support/reply.ready",
      data: { ticketId: ticket.id, recipient: customer.email, body: emailBody },
    });
    defer("score-customer-feedback", {
      function: customerOutcomeScorer,
      data: { ticketId: ticket.id },
    });

    return { ticketId: ticket.id, status: "reply_queued" };
  },
);

export const waitForHumanResolution = inngest.createFunction(
  { id: "wait-for-human-resolution", triggers: [{ event: "support/escalation.requested" }] },
  async ({ event, step }) => {
    // This pauses the run without holding a server open. The UI/API sends the
    // matching event whenever the human supplies a resolution.
    const resolution = await step.waitForEvent("wait-for-human-resolution", {
      event: "support/human-resolution.received",
      match: "data.ticketId",
      timeout: "3d",
    });

    if (!resolution) {
      await step.run("mark-review-timeout", () => updateTicketStatus(event.data.ticketId, "review_timed_out"));
      return { ticketId: event.data.ticketId, status: "review_timed_out" };
    }

    const customer = await step.run("load-customer-for-resolution", () => {
      const ticket = getTicket(event.data.ticketId);
      return ticket ? getCustomer(ticket.customer_id) : undefined;
    });
    if (!customer) throw new Error("Customer was not found for human resolution");

    await step.sendEvent("queue-human-approved-email", {
      name: "support/reply.ready",
      data: {
        ticketId: event.data.ticketId,
        recipient: customer.email,
        body: `Hi ${customer.name},\n\n${resolution.data.answer}\n\nBest,\nSupport`,
      },
    });
    return { ticketId: event.data.ticketId, status: "reply_queued" };
  },
);

export const sendSupportEmail = inngest.createFunction(
  { id: "send-support-email", triggers: [{ event: "support/reply.ready" }] },
  async ({ event, step }) => {
    // This is a mock email provider for the webinar. Swapping it for Resend or
    // another provider later does not change the workflow around it.
    await step.run("record-email", () => {
      recordEmail(event.data.ticketId, event.data.recipient, event.data.body);
      updateTicketStatus(event.data.ticketId, "answered");
    });
    return { ticketId: event.data.ticketId, delivered: true };
  },
);

export const functions = [
  researchSupportTicket,
  waitForHumanResolution,
  sendSupportEmail,
  customerOutcomeScorer,
];
