import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (file: string) => JSON.parse(readFileSync(file, "utf8"));

test("defines only the two Vapi API Request tools", () => {
  const lookup = read("vapi/tools/lookup_customer.api-request-tool.json");
  const ticket = read("vapi/tools/create_support_ticket.api-request-tool.json");
  assert.equal(lookup.type, "apiRequest");
  assert.equal(ticket.type, "apiRequest");
  assert.equal(lookup.name, "lookup_customer");
  assert.equal(ticket.name, "create_support_ticket");
});

test("keeps customer identity in Vapi static call parameters", () => {
  const lookup = read("vapi/tools/lookup_customer.api-request-tool.json");
  const ticket = read("vapi/tools/create_support_ticket.api-request-tool.json");
  assert.deepEqual(lookup.parameters, [
    { key: "callId", value: "{{call.id}}" },
    { key: "callerNumber", value: "{{customer.number}}" },
    { key: "calledNumber", value: "{{phoneNumber.number}}" },
  ]);
  assert.deepEqual(ticket.parameters, [
    { key: "requestId", value: "{{call.id}}" },
    { key: "callId", value: "{{call.id}}" },
  ]);
  assert.equal(lookup.body.properties.contact, undefined);
  assert.equal(ticket.body.properties.customerId, undefined);
  assert.equal(ticket.body.properties.customerQuestion !== undefined, true);
});
