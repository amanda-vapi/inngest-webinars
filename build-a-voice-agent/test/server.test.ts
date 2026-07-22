import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test, { after, before } from "node:test";
import Database from "better-sqlite3";

const testDirectory = mkdtempSync(join(tmpdir(), "voice-agent-test-"));
process.env.DATABASE_PATH = join(testDirectory, "voice-agent.db");
process.env.DEMO_MODE = "1";
process.env.API_BEARER_TOKEN = "test-token";
process.env.VOICE_AGENT_NO_LISTEN = "1";
process.env.INNGEST_DEV = "1";

const { createApp } = await import("../src/server.js");
const { db, getKnowledgeBaseArticles, getTicket, recordEmail, updateTicketStatus } = await import("../src/db.js");

const sentEvents: Array<Record<string, unknown>> = [];
let failDispatch = false;
const app = createApp({
  sendEvent: async (event) => {
    if (failDispatch) throw new Error("simulated dispatch failure");
    sentEvents.push(event as Record<string, unknown>);
    return { ids: ["event_test"] } as never;
  },
});

let baseUrl = "";
let server: ReturnType<typeof app.listen>;
const bearer = { authorization: "Bearer test-token" };

async function request(path: string, options: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, options);
}

async function createAmandaCall(callId = "call_amanda") {
  const response = await request("/api/call-sessions", {
    method: "POST",
    headers: { ...bearer, "content-type": "application/json" },
    body: JSON.stringify({ callId, callerNumber: "+15555550100", calledNumber: "+15555550999" }),
  });
  assert.equal(response.status, 201);
}

const ticketPayload = (overrides: Record<string, unknown> = {}) => ({
  callId: "call_amanda",
  requestId: "request_amanda_1",
  customerQuestion: "My replicator stopped working after the latest update.",
  deviceModel: "XR-200",
  firmwareVersion: "9.4.0",
  symptom: "The thermal-safety light flashes and no item is replicated.",
  errorCode: "THERM-94",
  ...overrides,
});

before(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind to a port");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(() => {
  server.close();
  db.close();
  rmSync(testDirectory, { recursive: true, force: true });
});

test("clean startup seeds Amanda without a foreign-key violation", () => {
  const customer = db.prepare("SELECT id FROM customers WHERE id = 'cus_amanda'").get();
  const history = db.prepare("SELECT customer_id FROM service_history WHERE id = 'service_amanda_filter'").get() as { customer_id: string };
  assert.deepEqual(customer, { id: "cus_amanda" });
  assert.equal(history.customer_id, "cus_amanda");
});

test("startup migrates a legacy database created by the original project", () => {
  const directory = mkdtempSync(join(tmpdir(), "voice-agent-legacy-"));
  const databasePath = join(directory, "legacy.db");
  const legacy = new Database(databasePath);
  legacy.exec(`
    CREATE TABLE customers (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, phone TEXT NOT NULL UNIQUE, product TEXT NOT NULL);
    CREATE TABLE faq_articles (id TEXT PRIMARY KEY, product TEXT NOT NULL, keywords TEXT NOT NULL, answer TEXT NOT NULL);
    CREATE TABLE known_issues (id TEXT PRIMARY KEY, product TEXT NOT NULL, summary TEXT NOT NULL, status TEXT NOT NULL);
    CREATE TABLE firmware_releases (version TEXT PRIMARY KEY, product TEXT NOT NULL, released_at TEXT NOT NULL, notes TEXT NOT NULL);
    CREATE TABLE service_history (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, summary TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE customer_interactions (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, channel TEXT NOT NULL, summary TEXT NOT NULL, occurred_at TEXT NOT NULL);
    CREATE TABLE knowledge_base_articles (id TEXT PRIMARY KEY, device_model TEXT NOT NULL, firmware_version TEXT, title TEXT NOT NULL, content TEXT NOT NULL);
    CREATE TABLE support_tickets (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, issue TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE outbound_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id TEXT NOT NULL, recipient TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);
    INSERT INTO customers (id, name, email, phone, product) VALUES ('cus_ada', 'Ada', 'ada@example.com', '+15550000001', 'Home Replicator');
    INSERT INTO service_history (id, customer_id, summary, created_at) VALUES ('service_ada_filter', 'cus_ada', 'Legacy history', '2026-01-01T00:00:00.000Z');
  `);
  legacy.close();

  const result = spawnSync(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_PATH: databasePath,
      DEMO_MODE: "1",
      VOICE_AGENT_NO_LISTEN: "1",
      INNGEST_DEV: "1",
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);

  const migrated = new Database(databasePath);
  const columns = migrated.prepare("PRAGMA table_info(support_tickets)").all() as Array<{ name: string }>;
  assert.equal(columns.some((column) => column.name === "request_id"), true);
  assert.equal(migrated.prepare("SELECT customer_id FROM service_history WHERE id = 'service_amanda_filter'").get().customer_id, "cus_amanda");
  migrated.close();
  rmSync(directory, { recursive: true, force: true });
});

test("startup fails without an API bearer token outside explicit demo mode", () => {
  const directory = mkdtempSync(join(tmpdir(), "voice-agent-auth-"));
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_PATH: join(directory, "voice-agent.db"),
      API_BEARER_TOKEN: "",
      DEMO_MODE: "",
      VOICE_AGENT_NO_LISTEN: "1",
      INNGEST_DEV: "1",
    },
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /API_BEARER_TOKEN is required/);
  rmSync(directory, { recursive: true, force: true });
});

test("private routes fail closed", async () => {
  const customerResponse = await request("/api/customers/lookup", { method: "POST", body: "{}" });
  const ticketResponse = await request("/api/tickets/not-a-ticket");
  const vapiResponse = await request("/api/vapi/tools", { method: "POST", body: "{}" });
  assert.equal(customerResponse.status, 401);
  assert.equal(ticketResponse.status, 401);
  assert.equal(vapiResponse.status, 401);
});

test("trusted call state derives customer ownership and returns minimum fields", async () => {
  const unknown = await request("/api/call-sessions", {
    method: "POST",
    headers: { ...bearer, "content-type": "application/json" },
    body: JSON.stringify({ callId: "call_unknown", callerNumber: "+15550000000", calledNumber: "+15555550999" }),
  });
  assert.equal(unknown.status, 404);

  const lookup = await request("/api/customers/lookup", {
    method: "POST",
    headers: { ...bearer, "content-type": "application/json" },
    body: JSON.stringify({ callId: "call_amanda", callerNumber: "+15555550100", calledNumber: "+15555550999" }),
  });
  assert.equal(lookup.status, 200);
  const customer = await lookup.json() as Record<string, unknown>;
  assert.equal(customer.name, "Amanda Martin");
  assert.equal("customerId" in customer, false);
  assert.equal("email" in customer, false);
  assert.equal("phone" in customer, false);
  assert.equal("warrantyStatus" in customer, false);
});

test("ticket requests are idempotent and cannot accept model-provided customer ownership", async () => {
  const invalid = await request("/api/tickets", {
    method: "POST",
    headers: { ...bearer, "content-type": "application/json" },
    body: JSON.stringify({ ...ticketPayload(), customerId: "cus_someone_else" }),
  });
  assert.equal(invalid.status, 400);

  const first = await request("/api/tickets", {
    method: "POST",
    headers: { ...bearer, "content-type": "application/json" },
    body: JSON.stringify(ticketPayload()),
  });
  assert.equal(first.status, 201);
  const firstBody = await first.json() as { ticketId: string; status: string };
  assert.equal(firstBody.status, "researching");

  const duplicate = await request("/api/tickets", {
    method: "POST",
    headers: { ...bearer, "content-type": "application/json" },
    body: JSON.stringify(ticketPayload()),
  });
  assert.equal(duplicate.status, 200);
  const duplicateBody = await duplicate.json() as { ticketId: string };
  assert.equal(duplicateBody.ticketId, firstBody.ticketId);
  assert.equal(sentEvents.filter((event) => event.name === "support/ticket.created").length, 1);

  const conflict = await request("/api/tickets", {
    method: "POST",
    headers: { ...bearer, "content-type": "application/json" },
    body: JSON.stringify(ticketPayload({ customerQuestion: "A different question" })),
  });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json() as { error: string }).error, "idempotency_conflict");

  const secondRequestForCall = await request("/api/tickets", {
    method: "POST",
    headers: { ...bearer, "content-type": "application/json" },
    body: JSON.stringify(ticketPayload({ requestId: "request_amanda_2" })),
  });
  assert.equal(secondRequestForCall.status, 409);
});

test("failed dispatch is visible and an identical retry resumes the existing ticket", async () => {
  await createAmandaCall("call_retry");
  failDispatch = true;
  const payload = ticketPayload({ callId: "call_retry", requestId: "request_retry" });
  const failed = await request("/api/tickets", {
    method: "POST",
    headers: { ...bearer, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  assert.equal(failed.status, 503);
  const failedBody = await failed.json() as { ticketId: string; status: string; retryable: boolean };
  assert.equal(failedBody.status, "event_failed");
  assert.equal(failedBody.retryable, true);

  failDispatch = false;
  const retried = await request("/api/tickets", {
    method: "POST",
    headers: { ...bearer, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  assert.equal(retried.status, 200);
  const retriedBody = await retried.json() as { ticketId: string; status: string };
  assert.equal(retriedBody.ticketId, failedBody.ticketId);
  assert.equal(retriedBody.status, "researching");
});

test("unrelated questions do not receive the thermal-safety knowledge-base answer", () => {
  assert.deepEqual(getKnowledgeBaseArticles("XR-200", "9.4.0", "Where can I find a replacement delivery?"), []);
  assert.equal(getKnowledgeBaseArticles("XR-200", "9.4.0", "The latest update left thermal safety on.").length, 1);
});

test("human resolution is state-checked and outbound delivery is idempotent", async () => {
  const ticket = getTicketByRequestIdForTest("request_amanda_1");
  updateTicketStatus(ticket.id, "needs_human_review");
  const resolve = await request(`/api/tickets/${ticket.id}/resolve`, {
    method: "POST",
    headers: { ...bearer, "content-type": "application/json" },
    body: JSON.stringify({ answer: "A technician will follow up." }),
  });
  assert.equal(resolve.status, 200);
  assert.equal(getTicket(ticket.id)?.status, "human_resolved");

  const repeated = await request(`/api/tickets/${ticket.id}/resolve`, {
    method: "POST",
    headers: { ...bearer, "content-type": "application/json" },
    body: JSON.stringify({ answer: "A technician will follow up." }),
  });
  assert.equal(repeated.status, 409);

  updateTicketStatus(ticket.id, "reply_queued");
  recordEmail(ticket.id, "amanda.martin@example.com", "Hello");
  recordEmail(ticket.id, "amanda.martin@example.com", "Hello");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM outbound_messages WHERE ticket_id = ?").get(ticket.id).count, 1);
  assert.equal(getTicket(ticket.id)?.status, "answered");
});

function getTicketByRequestIdForTest(requestId: string) {
  const ticket = db.prepare("SELECT * FROM support_tickets WHERE request_id = ?").get(requestId) as ReturnType<typeof getTicket>;
  if (!ticket) throw new Error(`Expected ticket for ${requestId}`);
  return ticket;
}
