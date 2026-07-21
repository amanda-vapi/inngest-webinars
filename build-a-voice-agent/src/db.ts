import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { CreateTicketInput, Customer, Ticket } from "./types.js";

const databasePath = process.env.DATABASE_PATH || resolve(process.cwd(), "data", "voice-agent.db");
mkdirSync(dirname(databasePath), { recursive: true });

export const db = new Database(databasePath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
  CREATE TABLE IF NOT EXISTS customers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    phone TEXT NOT NULL UNIQUE,
    product TEXT NOT NULL,
    device_model TEXT NOT NULL,
    firmware_version TEXT NOT NULL,
    warranty_status TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS knowledge (
    id TEXT PRIMARY KEY,
    product TEXT NOT NULL,
    keywords TEXT NOT NULL,
    answer TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS support_tickets (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL,
    issue TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    device_model TEXT,
    firmware_version TEXT,
    symptom TEXT,
    error_code TEXT,
    answer TEXT,
    FOREIGN KEY (customer_id) REFERENCES customers(id)
  );
  CREATE TABLE IF NOT EXISTS outbound_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id TEXT NOT NULL,
    recipient TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (ticket_id) REFERENCES support_tickets(id)
  );
`);

const ticketColumns = db.prepare("PRAGMA table_info(support_tickets)").all() as Array<{ name: string }>;
if (!ticketColumns.some((column) => column.name === "idempotency_key")) {
  db.exec("ALTER TABLE support_tickets ADD COLUMN idempotency_key TEXT");
}
if (!ticketColumns.some((column) => column.name === "reference")) {
  db.exec("ALTER TABLE support_tickets ADD COLUMN reference TEXT");
}
db.exec(`
  UPDATE support_tickets
  SET reference = 'REP-' || printf('%06d', rowid)
  WHERE reference IS NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS support_tickets_reference
  ON support_tickets(reference)
  WHERE reference IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS support_tickets_idempotency_key
  ON support_tickets(idempotency_key)
  WHERE idempotency_key IS NOT NULL
`);

export function seedDemoData() {
  db.prepare(`
    INSERT INTO customers (
      id, name, email, phone, product, device_model, firmware_version, warranty_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      email = excluded.email,
      phone = excluded.phone,
      product = excluded.product,
      device_model = excluded.device_model,
      firmware_version = excluded.firmware_version,
      warranty_status = excluded.warranty_status
  `).run(
    "cus_amanda",
    "Amanda Martin",
    "amanda.martin@example.com",
    "+15555550100",
    "Home Replicator",
    "XR-200",
    "9.4.0",
    "active",
  );

  db.prepare(`
    INSERT INTO knowledge (id, product, keywords, answer)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET keywords = excluded.keywords, answer = excluded.answer
  `).run(
    "kb_xr200_thermal",
    "Home Replicator",
    "replicator update thermal safety stuck stopped working THERM-94",
    "Run Recalibrate Thermal Profile from Device Settings > Diagnostics. If it fails, schedule a technician visit.",
  );
}

function customerFromRow(row: Record<string, unknown> | undefined): Customer | undefined {
  if (!row) return undefined;
  return {
    id: String(row.id),
    name: String(row.name),
    email: String(row.email),
    phone: String(row.phone),
    product: String(row.product),
    deviceModel: String(row.device_model),
    firmwareVersion: String(row.firmware_version),
    warrantyStatus: String(row.warranty_status),
  };
}

function ticketFromRow(row: Record<string, unknown> | undefined): Ticket | undefined {
  if (!row) return undefined;
  return {
    id: String(row.id),
    reference: String(row.reference),
    customerId: String(row.customer_id),
    issue: String(row.issue),
    status: String(row.status),
    createdAt: String(row.created_at),
    deviceModel: row.device_model === null ? null : String(row.device_model),
    firmwareVersion: row.firmware_version === null ? null : String(row.firmware_version),
    symptom: row.symptom === null ? null : String(row.symptom),
    errorCode: row.error_code === null ? null : String(row.error_code),
  };
}

export function getCustomerByContact(contact: string) {
  return customerFromRow(
    db.prepare("SELECT * FROM customers WHERE lower(email) = lower(?) OR phone = ?").get(contact, contact) as
      | Record<string, unknown>
      | undefined,
  );
}

export function getCustomer(id: string) {
  return customerFromRow(
    db.prepare("SELECT * FROM customers WHERE id = ?").get(id) as Record<string, unknown> | undefined,
  );
}

export function getTicket(id: string) {
  return ticketFromRow(
    db.prepare("SELECT * FROM support_tickets WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined,
  );
}

function insertTicket(input: CreateTicketInput, idempotencyKey: string | null) {
  const id = `ticket_${crypto.randomUUID()}`;
  const insertion = db.prepare(`
    INSERT INTO support_tickets (
      id, customer_id, issue, status, created_at, device_model, firmware_version,
      symptom, error_code, idempotency_key
    ) VALUES (?, ?, ?, 'event_pending', ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.customerId,
    input.issue,
    new Date().toISOString(),
    input.deviceModel ?? null,
    input.firmwareVersion ?? null,
    input.symptom ?? null,
    input.errorCode ?? null,
    idempotencyKey,
  );
  const reference = `REP-${String(insertion.lastInsertRowid).padStart(6, "0")}`;
  db.prepare("UPDATE support_tickets SET reference = ? WHERE id = ?").run(reference, id);
  return getTicket(id)!;
}

export function createTicket(input: CreateTicketInput) {
  return insertTicket(input, null);
}

export class IdempotencyConflictError extends Error {
  constructor() {
    super("Idempotency key was already used with a different ticket request");
    this.name = "IdempotencyConflictError";
  }
}

function sameTicketRequest(ticket: Ticket, input: CreateTicketInput) {
  return ticket.customerId === input.customerId &&
    ticket.issue === input.issue &&
    ticket.deviceModel === (input.deviceModel ?? null) &&
    ticket.firmwareVersion === (input.firmwareVersion ?? null) &&
    ticket.symptom === (input.symptom ?? null) &&
    ticket.errorCode === (input.errorCode ?? null);
}

const createTicketOnce = db.transaction((input: CreateTicketInput, idempotencyKey: string) => {
  const row = db.prepare("SELECT * FROM support_tickets WHERE idempotency_key = ?").get(idempotencyKey) as
    | Record<string, unknown>
    | undefined;
  const existing = ticketFromRow(row);
  if (existing) {
    if (!sameTicketRequest(existing, input)) throw new IdempotencyConflictError();
    return { ticket: existing, created: false };
  }
  return { ticket: insertTicket(input, idempotencyKey), created: true };
});

export function createTicketIdempotently(input: CreateTicketInput, idempotencyKey: string) {
  return createTicketOnce.immediate(input, idempotencyKey);
}

export function findKnowledge(product: string, issue: string) {
  const words = new Set(issue.toLowerCase().split(/\W+/).filter((word) => word.length > 2));
  const rows = db.prepare("SELECT * FROM knowledge WHERE product = ?").all(product) as Array<{
    id: string;
    keywords: string;
    answer: string;
  }>;
  return rows.filter((row) =>
    row.keywords.toLowerCase().split(/\W+/).some((keyword) => words.has(keyword)),
  );
}

export function updateTicket(ticketId: string, status: string, answer?: string) {
  db.prepare("UPDATE support_tickets SET status = ?, answer = COALESCE(?, answer) WHERE id = ?").run(
    status,
    answer ?? null,
    ticketId,
  );
}

export function transitionTicketStatus(
  ticketId: string,
  fromStatuses: string[],
  status: string,
  answer?: string,
) {
  if (fromStatuses.length === 0) return false;
  const placeholders = fromStatuses.map(() => "?").join(", ");
  const result = db.prepare(`
    UPDATE support_tickets
    SET status = ?, answer = COALESCE(?, answer)
    WHERE id = ? AND status IN (${placeholders})
  `).run(status, answer ?? null, ticketId, ...fromStatuses);
  return result.changes === 1;
}

export function recordEmail(ticketId: string, recipient: string, body: string) {
  recordEmailOnce.immediate(ticketId, recipient, body);
}

db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS outbound_messages_ticket_id
  ON outbound_messages(ticket_id)
`);

const recordEmailOnce = db.transaction((ticketId: string, recipient: string, body: string) => {
  const delivery = db.prepare(`
    INSERT INTO outbound_messages (ticket_id, recipient, body, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(ticket_id) DO NOTHING
  `).run(ticketId, recipient, body, new Date().toISOString());
  if (delivery.changes === 1) updateTicket(ticketId, "answered", body);
});

export function resetDemoData() {
  db.exec("DELETE FROM outbound_messages; DELETE FROM support_tickets;");
}
