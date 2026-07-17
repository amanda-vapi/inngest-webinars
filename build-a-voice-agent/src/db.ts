import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const databasePath = resolve(process.cwd(), "data", "voice-agent.db");
mkdirSync(dirname(databasePath), { recursive: true });

export const db = new Database(databasePath);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS customers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    phone TEXT NOT NULL UNIQUE,
    product TEXT NOT NULL,
    replicator_model TEXT,
    firmware_version TEXT,
    warranty_status TEXT
  );

  CREATE TABLE IF NOT EXISTS faq_articles (
    id TEXT PRIMARY KEY,
    product TEXT NOT NULL,
    keywords TEXT NOT NULL,
    answer TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS known_issues (
    id TEXT PRIMARY KEY,
    product TEXT NOT NULL,
    summary TEXT NOT NULL,
    status TEXT NOT NULL,
    affected_model TEXT,
    affected_firmware TEXT,
    workaround TEXT
  );

  CREATE TABLE IF NOT EXISTS firmware_releases (
    version TEXT PRIMARY KEY,
    product TEXT NOT NULL,
    released_at TEXT NOT NULL,
    notes TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS service_history (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL,
    summary TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (customer_id) REFERENCES customers(id)
  );

  CREATE TABLE IF NOT EXISTS customer_interactions (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL,
    channel TEXT NOT NULL,
    summary TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    FOREIGN KEY (customer_id) REFERENCES customers(id)
  );

  CREATE TABLE IF NOT EXISTS knowledge_base_articles (
    id TEXT PRIMARY KEY,
    device_model TEXT NOT NULL,
    firmware_version TEXT,
    title TEXT NOT NULL,
    content TEXT NOT NULL
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
    follow_up_method TEXT,
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

// SQLite does not add columns when CREATE TABLE runs against an existing local
// database. These tiny migrations keep an attendee's database current.
function ensureColumn(table: string, column: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((existing) => existing.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

ensureColumn("customers", "replicator_model", "TEXT");
ensureColumn("customers", "firmware_version", "TEXT");
ensureColumn("customers", "warranty_status", "TEXT");
ensureColumn("known_issues", "affected_model", "TEXT");
ensureColumn("known_issues", "affected_firmware", "TEXT");
ensureColumn("known_issues", "workaround", "TEXT");
ensureColumn("support_tickets", "device_model", "TEXT");
ensureColumn("support_tickets", "firmware_version", "TEXT");
ensureColumn("support_tickets", "symptom", "TEXT");
ensureColumn("support_tickets", "error_code", "TEXT");
ensureColumn("support_tickets", "follow_up_method", "TEXT");

// The webinar needs just enough data to prove the workflow is doing research.
// `seedDemoData()` is safe to call on every app start.
export function seedDemoData() {
  // Preserve any local test tickets while replacing the original placeholder
  // customer with the webinar's actual demo customer.
  const legacyCustomer = getCustomer("cus_ada");
  if (legacyCustomer && !getCustomer("cus_amanda")) {
    db.transaction(() => {
      db.prepare("UPDATE customers SET phone = 'legacy-cus-ada' WHERE id = 'cus_ada'").run();
      db.prepare(
        `INSERT INTO customers (
           id, name, email, phone, product, replicator_model, firmware_version, warranty_status
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "cus_amanda",
        "Amanda Martin",
        "amanda.martin@example.com",
        legacyCustomer.phone,
        legacyCustomer.product,
        legacyCustomer.replicator_model,
        legacyCustomer.firmware_version,
        legacyCustomer.warranty_status,
      );
      db.prepare("UPDATE support_tickets SET customer_id = 'cus_amanda' WHERE customer_id = 'cus_ada'").run();
      db.prepare("UPDATE service_history SET customer_id = 'cus_amanda' WHERE customer_id = 'cus_ada'").run();
      db.prepare("DELETE FROM customers WHERE id = 'cus_ada'").run();
    })();
  }

  db.prepare(
    `INSERT INTO customers (
       id, name, email, phone, product, replicator_model, firmware_version, warranty_status
     ) VALUES (
       'cus_amanda', 'Amanda Martin', 'amanda.martin@example.com', '+15555550100',
       'Home Replicator', 'XR-200', '9.4.0', 'active'
     )
     ON CONFLICT(id) DO UPDATE SET
       product = excluded.product,
       replicator_model = excluded.replicator_model,
       firmware_version = excluded.firmware_version,
       warranty_status = excluded.warranty_status`,
  ).run();

  db.prepare(
    `INSERT OR IGNORE INTO customer_interactions (id, customer_id, channel, summary, occurred_at)
     VALUES ('interaction_amanda_filter', 'cus_amanda', 'phone',
       'Called about replacing a water filter; resolved during the call.', '2026-05-17T14:30:00.000Z')`,
  ).run();

  db.prepare(
    `INSERT INTO knowledge_base_articles (id, device_model, firmware_version, title, content)
     VALUES ('kb_xr200_thermal_safety', 'XR-200', '9.4.0',
       'XR-200 thermal-safety recalibration',
       'If an XR-200 enters thermal-safety mode after a 9.4.0 update, open Device Settings, choose Diagnostics, then run Recalibrate Thermal Profile.')
     ON CONFLICT(id) DO UPDATE SET content = excluded.content`,
  ).run();

  db.prepare("DELETE FROM faq_articles WHERE id = 'faq_password_reset'").run();
  db.prepare(
    `INSERT INTO faq_articles (id, product, keywords, answer)
     VALUES ('faq_recalibration', 'Home Replicator', 'replicator,update,thermal,safety,stuck,not working',
       'For XR-200 units in thermal-safety mode after updating, run the recalibration sequence from the device settings menu.')
     ON CONFLICT(id) DO UPDATE SET answer = excluded.answer, keywords = excluded.keywords`,
  ).run();

  db.prepare("DELETE FROM known_issues WHERE id = 'issue_dashboard'").run();
  db.prepare(
    `INSERT INTO known_issues (
       id, product, summary, status, affected_model, affected_firmware, workaround
     ) VALUES (
       'issue_xr200_thermal_safety', 'Home Replicator',
       'Replicator OS 9.4 can leave XR-200 units stuck in thermal-safety mode after updating.',
       'investigating', 'XR-200', '9.4.0',
       'Run the recalibration sequence from device settings. If it fails, schedule a technician visit.'
     )
     ON CONFLICT(id) DO UPDATE SET status = excluded.status, workaround = excluded.workaround`,
  ).run();

  db.prepare(
    `INSERT INTO firmware_releases (version, product, released_at, notes)
     VALUES ('9.4.0', 'Home Replicator', '2026-07-16T16:00:00.000Z',
       'Improves recipe-selection latency and thermal-safety monitoring.')
     ON CONFLICT(version) DO UPDATE SET notes = excluded.notes`,
  ).run();

  db.prepare(
    `INSERT OR IGNORE INTO service_history (id, customer_id, summary, created_at)
     VALUES ('service_ada_filter', 'cus_ada', 'Water filter replaced during annual maintenance.', '2026-05-20T10:00:00.000Z')`,
  ).run();
}

export type Ticket = {
  id: string;
  customer_id: string;
  issue: string;
  status: string;
  created_at: string;
  device_model: string | null;
  firmware_version: string | null;
  symptom: string | null;
  error_code: string | null;
  follow_up_method: string | null;
};

export function getCustomerByContact(contact: string) {
  return db
    .prepare("SELECT * FROM customers WHERE email = ? OR phone = ?")
    .get(contact, contact) as
    | {
        id: string;
        name: string;
        email: string;
        phone: string;
        product: string;
        replicator_model: string;
        firmware_version: string;
        warranty_status: string;
      }
    | undefined;
}

export function getCustomer(id: string) {
  return db.prepare("SELECT * FROM customers WHERE id = ?").get(id) as
    | {
        id: string;
        name: string;
        email: string;
        phone: string;
        product: string;
        replicator_model: string;
        firmware_version: string;
        warranty_status: string;
      }
    | undefined;
}

export function getTicket(id: string) {
  return db.prepare("SELECT * FROM support_tickets WHERE id = ?").get(id) as Ticket | undefined;
}

export function createTicket(
  customerId: string,
  issue: string,
  details: {
    deviceModel?: string;
    firmwareVersion?: string;
    symptom?: string;
    errorCode?: string;
    followUpMethod?: string;
  } = {},
) {
  const id = `ticket_${crypto.randomUUID()}`;
  db.prepare(
    `INSERT INTO support_tickets (
       id, customer_id, issue, status, created_at, device_model, firmware_version,
       symptom, error_code, follow_up_method
     ) VALUES (?, ?, ?, 'researching', ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    customerId,
    issue,
    new Date().toISOString(),
    details.deviceModel ?? null,
    details.firmwareVersion ?? null,
    details.symptom ?? null,
    details.errorCode ?? null,
    details.followUpMethod ?? null,
  );
  return getTicket(id)!;
}

export function findFaqs(product: string, issue: string) {
  const words = new Set(issue.toLowerCase().split(/\W+/).filter((word) => word.length > 2));
  const articles = db
    .prepare("SELECT * FROM faq_articles WHERE product = ?")
    .all(product) as Array<{ id: string; keywords: string; answer: string }>;
  return articles.filter((article) =>
    article.keywords
      .toLowerCase()
      .split(/\W+/)
      .some((keyword) => words.has(keyword)),
  );
}

export function findKnownIssues(product: string, issue: string) {
  const words = new Set(issue.toLowerCase().split(/\W+/).filter((word) => word.length > 2));
  const issues = db
    .prepare("SELECT * FROM known_issues WHERE product = ?")
    .all(product) as Array<{ id: string; summary: string; status: string; workaround: string }>;
  return issues.filter((knownIssue) =>
    knownIssue.summary
      .toLowerCase()
      .split(/\W+/)
      .some((keyword) => words.has(keyword)),
  );
}

export function updateTicketStatus(ticketId: string, status: string) {
  db.prepare("UPDATE support_tickets SET status = ? WHERE id = ?").run(status, ticketId);
}

export function recordEmail(ticketId: string, recipient: string, body: string) {
  db.prepare(
    "INSERT INTO outbound_messages (ticket_id, recipient, body, created_at) VALUES (?, ?, ?, ?)",
  ).run(ticketId, recipient, body, new Date().toISOString());
}

export function getSupportHistory(customerId: string) {
  return {
    interactions: db
      .prepare("SELECT channel, summary, occurred_at FROM customer_interactions WHERE customer_id = ? ORDER BY occurred_at DESC")
      .all(customerId),
    service: db
      .prepare("SELECT summary, created_at FROM service_history WHERE customer_id = ? ORDER BY created_at DESC")
      .all(customerId),
  };
}

export function findRelatedTickets(customerId: string, issue: string, excludeTicketId: string) {
  const terms = issue.toLowerCase().split(/\W+/).filter((term) => term.length > 3);
  const tickets = db
    .prepare("SELECT id, issue, status, created_at FROM support_tickets WHERE customer_id = ? AND id != ? ORDER BY created_at DESC")
    .all(customerId, excludeTicketId) as Array<{ id: string; issue: string; status: string; created_at: string }>;
  return tickets.filter((ticket) => terms.some((term) => ticket.issue.toLowerCase().includes(term)));
}

export function getKnowledgeBaseArticles(deviceModel: string, firmwareVersion: string) {
  return db
    .prepare(
      "SELECT title, content FROM knowledge_base_articles WHERE device_model = ? AND (firmware_version = ? OR firmware_version IS NULL)",
    )
    .all(deviceModel, firmwareVersion) as Array<{ title: string; content: string }>;
}

export function getFirmwareRelease(version: string) {
  return db.prepare("SELECT version, released_at, notes FROM firmware_releases WHERE version = ?").get(version);
}
