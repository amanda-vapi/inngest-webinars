import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTicket, createTicketIdempotently, db, getCustomerByContact, getTicket, IdempotencyConflictError, recordEmail, seedDemoData, transitionTicketStatus } from "../src/db.js";
import { createSupportTicketRequestSchema } from "../src/schemas.js";

seedDemoData();

test("looks up the seeded customer by email", () => {
  const customer = getCustomerByContact("amanda.martin@example.com");
  assert.equal(customer?.id, "cus_amanda");
  assert.equal(customer?.deviceModel, "XR-200");
});

test("validates the API request tool ticket body", () => {
  const parsed = createSupportTicketRequestSchema.parse({
    requestId: "call_test_1234",
    customerId: "cus_amanda",
    issue: "My replicator stopped working after the update.",
  });
  assert.equal(parsed.customerId, "cus_amanda");
});

test("reuses a ticket for the same idempotency key", () => {
  const input = { customerId: "cus_amanda", issue: "The idempotent thermal light is flashing." };
  const key = `test_${crypto.randomUUID()}`;
  const first = createTicketIdempotently(input, key);
  const second = createTicketIdempotently(input, key);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.ticket.id, first.ticket.id);
  assert.equal(second.ticket.reference, first.ticket.reference);
  assert.throws(
    () => createTicketIdempotently({ ...input, issue: "Different request content." }, key),
    IdempotencyConflictError,
  );
});

test("creates a local support ticket", () => {
  const ticket = createTicket({ customerId: "cus_amanda", issue: "The thermal light is flashing." });
  assert.equal(ticket.customerId, "cus_amanda");
  assert.equal(ticket.status, "event_pending");
  assert.match(ticket.reference, /^REP-\d{6}$/);
});

test("only advances a ticket from an expected durable state", () => {
  const ticket = createTicket({ customerId: "cus_amanda", issue: "The dispatch state needs testing." });
  assert.equal(transitionTicketStatus(ticket.id, ["event_pending"], "researching"), true);
  assert.equal(transitionTicketStatus(ticket.id, ["event_pending"], "event_failed"), false);
});

test("records the mock outbound email idempotently", () => {
  const ticket = createTicket({ customerId: "cus_amanda", issue: "The reply needs deduplication." });
  recordEmail(ticket.id, "amanda.martin@example.com", "First durable answer");
  recordEmail(ticket.id, "amanda.martin@example.com", "Duplicate delivery attempt");
  const messages = db.prepare(
    "SELECT body FROM outbound_messages WHERE ticket_id = ?",
  ).all(ticket.id) as Array<{ body: string }>;
  assert.deepEqual(messages, [{ body: "First durable answer" }]);
  assert.equal(getTicket(ticket.id)?.status, "answered");
});

test("defines exactly two Vapi API Request tools", () => {
  const files = [
    "vapi/tools/lookup_customer.api-request-tool.json",
    "vapi/tools/create_support_ticket.api-request-tool.json",
  ];
  const tools = files.map((file) => JSON.parse(readFileSync(file, "utf8")));
  assert.deepEqual(tools.map((tool) => tool.type), ["apiRequest", "apiRequest"]);
  assert.deepEqual(tools.map((tool) => tool.name), ["lookup_customer", "create_support_ticket"]);
  assert.deepEqual(tools.map((tool) => tool.function.name), ["api_request_tool", "api_request_tool"]);
  assert.deepEqual(tools[1].parameters, [{ key: "requestId", value: "{{ call.id }}" }]);
  assert.equal(tools[1].body.properties.requestId, undefined);
});
