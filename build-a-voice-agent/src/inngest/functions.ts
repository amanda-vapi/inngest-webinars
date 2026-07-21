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
import { mockResearchAnalysisMetadata } from "../demo/mock-ai-metadata.js";
import OpenAI from "openai";

type ModelMessage = { role: "system" | "user"; content: string };

const researchModel = "gpt-4.1-mini";

async function callOpenAI({ messages }: { messages: ModelMessage[] }) {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openai.chat.completions.create({
    model: researchModel,
    response_format: { type: "json_object" },
    messages,
  });
}

function readJson(content: string) {
  return JSON.parse(content.replace(/^```json\s*|\s*```$/g, "")) as Record<string, unknown>;
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
  async ({ event, step, defer, attempt, demoDelay }) => {
    const ticket = await step.run("load-ticket", () => {
      const ticket = getTicket(event.data.ticketId);
      if (!ticket) throw new Error(`Ticket ${event.data.ticketId} was not found`);
      return ticket;
    });

    const [customer, supportHistory, relatedTickets, knowledgeBase, faqs, operations, firmware] = await Promise.all([
      step.run("crm-load-customer", async () => {
        await demoDelay("crm");
        return getCustomer(ticket.customer_id);
      }),
      step.run("support-history", async () => {
        await demoDelay("support-history");
        return getSupportHistory(ticket.customer_id);
      }),
      step.run("ticket-system-search", async () => {
        await demoDelay("ticket-system");
        return findRelatedTickets(ticket.customer_id, ticket.issue, ticket.id);
      }),
      step.run("knowledge-base-search", async () => {
        await demoDelay("knowledge-base");
        const customer = getCustomer(ticket.customer_id);
        return customer ? getKnowledgeBaseArticles(customer.replicator_model, customer.firmware_version) : [];
      }),
      step.run("faq-search", async () => {
        await demoDelay("faq");
        const customer = getCustomer(ticket.customer_id);
        return customer ? findFaqs(customer.product, ticket.issue) : [];
      }),
      step.run("operations-check-active-incidents", async () => {
        // Forces a retry of the operations call
        if (attempt === 0) {
          throw new Error("Operations API returned 503 Service Unavailable");
        }
        await demoDelay("operations");
        const customer = getCustomer(ticket.customer_id);
        return customer ? findKnownIssues(customer.product, ticket.issue) : [];
      }),
      step.run("firmware-service-release-details", async () => {
        await demoDelay("firmware");
        const customer = getCustomer(ticket.customer_id);
        return customer ? getFirmwareRelease(customer.firmware_version) : undefined;
      }),
    ]);

    if (!customer) throw new Error(`Customer ${ticket.customer_id} was not found`);

    const customerQuestion = ticket.issue;
    const evidence = { customerQuestion, customer, ticket, supportHistory, relatedTickets, knowledgeBase, faqs, operations, firmware };
    const fallbackAnswer = operations[0]?.workaround ?? knowledgeBase[0]?.content ?? faqs[0]?.answer;

    const analysis = await step.run("research-analysis", async () => {
      if (process.env.MOCK_AI_METADATA === "1") {
        await mockResearchAnalysisMetadata();
        return {
          canRespond: Boolean(fallbackAnswer),
          customerAnswer: fallbackAnswer,
          followUpDraft: fallbackAnswer
            ? `Hi ${customer.name},\n\n${fallbackAnswer}\n\nBest,\nReplicator Support`
            : undefined,
        };
      }

      if (!process.env.OPENAI_API_KEY) {
        return {
          canRespond: Boolean(fallbackAnswer),
          customerAnswer: fallbackAnswer,
          followUpDraft: fallbackAnswer
            ? `Hi ${customer.name},\n\n${fallbackAnswer}\n\nBest,\nReplicator Support`
            : undefined,
        };
      }
      const openAI = await callOpenAI({
        messages: [
          { role: "system", content: "You analyze support research. Return JSON: {canRespond:boolean, customerAnswer:string, followUpDraft:string}. Only recommend a response supported by the evidence; otherwise set canRespond to false and explain the gap in customerAnswer." },
          { role: "user", content: JSON.stringify(evidence) },
        ],
      });
      const content = openAI.choices[0]?.message.content;
      if (!content) throw new Error("OpenAI returned no research analysis");
      const result = readJson(content);
      return result;
    });
    const answer = analysis.canRespond && typeof analysis.customerAnswer === "string" ? analysis.customerAnswer : undefined;
    await step.score("score-research-confidence", {
      name: "research-confidence",
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

    const emailBody = typeof analysis.followUpDraft === "string"
      ? analysis.followUpDraft
      : `Hi ${customer.name},\n\n${answer}\n\nBest,\nReplicator Support`;
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
