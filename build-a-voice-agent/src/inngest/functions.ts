import {
  findKnowledge,
  getCustomer,
  getTicket,
  recordEmail,
  transitionTicketStatus,
  updateTicket,
} from "../db.js";
import { inngest } from "./client.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const latency = () => Number(process.env.DEMO_SYSTEM_LATENCY_MS ?? 300);

export const researchSupportTicket = inngest.createFunction(
  { id: "research-support-ticket", retries: 2, triggers: [{ event: "support/ticket.created" }] },
  async ({ event, step }) => {
    const ticket = await step.run("load-ticket", () => {
      const value = getTicket(event.data.ticketId);
      if (!value) throw new Error(`Ticket ${event.data.ticketId} was not found`);
      return value;
    });

    const [customer, knowledge] = await Promise.all([
      step.run("crm-load-customer", async () => {
        await wait(latency());
        return getCustomer(ticket.customerId);
      }),
      step.run("knowledge-search", async () => {
        await wait(latency());
        const owner = getCustomer(ticket.customerId);
        return owner ? findKnowledge(owner.product, ticket.issue) : [];
      }),
    ]);

    if (!customer) throw new Error(`Customer ${ticket.customerId} was not found`);
    const answer = knowledge[0]?.answer;
    if (!answer) {
      await step.run("mark-needs-human-review", () => updateTicket(ticket.id, "needs_human_review"));
      await step.sendEvent("request-human-review", {
        name: "support/escalation.requested",
        data: { ticketId: ticket.id },
      });
      return { ticketId: ticket.id, status: "needs_human_review" };
    }

    const email = `Hi ${customer.name},\n\n${answer}\n\nBest,\nReplicator Support`;
    await step.sendEvent("queue-email", {
      name: "support/reply.ready",
      data: { ticketId: ticket.id, recipient: customer.email, body: email },
    });
    await step.run("mark-reply-queued", () => {
      transitionTicketStatus(ticket.id, ["researching"], "reply_queued");
    });
    return { ticketId: ticket.id, status: "reply_queued" };
  },
);

export const waitForHumanResolution = inngest.createFunction(
  { id: "wait-for-human-resolution", triggers: [{ event: "support/escalation.requested" }] },
  async ({ event, step }) => {
    const resolution = await step.waitForEvent("wait-for-human-resolution", {
      event: "support/human-resolution.received",
      match: "data.ticketId",
      timeout: "3d",
    });
    if (!resolution) {
      await step.run("mark-review-timeout", () => updateTicket(event.data.ticketId, "review_timed_out"));
      return { ticketId: event.data.ticketId, status: "review_timed_out" };
    }
    const ticket = getTicket(event.data.ticketId);
    const customer = ticket ? getCustomer(ticket.customerId) : undefined;
    if (!customer) throw new Error("Customer was not found for human resolution");
    await step.sendEvent("queue-human-approved-email", {
      name: "support/reply.ready",
      data: {
        ticketId: event.data.ticketId,
        recipient: customer.email,
        body: `Hi ${customer.name},\n\n${resolution.data.answer}\n\nBest,\nReplicator Support`,
      },
    });
    await step.run("mark-human-reply-queued", () => {
      transitionTicketStatus(event.data.ticketId, ["human_resolved"], "reply_queued");
    });
    return { ticketId: event.data.ticketId, status: "reply_queued" };
  },
);

export const sendSupportEmail = inngest.createFunction(
  { id: "send-support-email", triggers: [{ event: "support/reply.ready" }] },
  async ({ event, step }) => {
    await step.run("record-email", () => {
      recordEmail(event.data.ticketId, event.data.recipient, event.data.body);
    });
    return { ticketId: event.data.ticketId, delivered: true };
  },
);

export const functions = [researchSupportTicket, waitForHumanResolution, sendSupportEmail];
