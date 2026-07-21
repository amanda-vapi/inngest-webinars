import "dotenv/config";

const baseUrl = (process.env.DEMO_BASE_URL || process.env.PUBLIC_URL || "http://127.0.0.1:3000")
  .replace(/\/$/, "");
const authorization = process.env.API_BEARER_TOKEN
  ? { Authorization: `Bearer ${process.env.API_BEARER_TOKEN}` }
  : {};
const headers = {
  "content-type": "application/json",
  "ngrok-skip-browser-warning": "1",
  ...authorization,
};

async function json(response, step) {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`${step} failed with ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function main() {
  const ticketRequestId = `demo_${crypto.randomUUID()}`;
  const healthResponse = await fetch(`${baseUrl}/health`, { headers });
  await json(healthResponse, "health check");
  console.log(`PASS health (${healthResponse.status})`);

  const rejectedLookupResponse = await fetch(
    `${baseUrl}/api/customers?contact=${encodeURIComponent("amanda.martin@example.com")}`,
    { headers: { "ngrok-skip-browser-warning": "1" } },
  );
  const rejectedLookupBody = await rejectedLookupResponse.json().catch(() => null);
  if (
    rejectedLookupResponse.status !== 401 ||
    rejectedLookupBody?.error !== "invalid_authentication"
  ) {
    throw new Error(`unauthenticated lookup was not rejected: ${rejectedLookupResponse.status}`);
  }
  console.log("PASS unauthenticated customer lookup rejected (401)");

  const rejectedTicketResponse = await fetch(`${baseUrl}/api/tickets`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "ngrok-skip-browser-warning": "1",
    },
    body: JSON.stringify({ customerId: "cus_amanda", issue: "This request must be rejected." }),
  });
  const rejectedTicketBody = await rejectedTicketResponse.json().catch(() => null);
  if (
    rejectedTicketResponse.status !== 401 ||
    rejectedTicketBody?.error !== "invalid_authentication"
  ) {
    throw new Error(`unauthenticated ticket creation was not rejected: ${rejectedTicketResponse.status}`);
  }
  console.log("PASS unauthenticated ticket creation rejected (401)");

  const lookupResponse = await fetch(
    `${baseUrl}/api/customers?contact=${encodeURIComponent("amanda.martin@example.com")}`,
    { headers },
  );
  const customer = await json(lookupResponse, "customer lookup");
  if (customer.customerId !== "cus_amanda" || customer.deviceModel !== "XR-200") {
    throw new Error(`customer lookup returned an unexpected contract: ${JSON.stringify(customer)}`);
  }
  console.log(`PASS customer lookup (${lookupResponse.status})`);

  const unknownLookupResponse = await fetch(
    `${baseUrl}/api/customers?contact=${encodeURIComponent("nobody-test@example.com")}`,
    { headers },
  );
  const unknownCustomer = await json(unknownLookupResponse, "unknown customer lookup");
  if (
    unknownCustomer.matched !== false ||
    unknownCustomer.nextAction !== "recheck_contact" ||
    "customerId" in unknownCustomer
  ) {
    throw new Error(`unknown lookup returned an unexpected contract: ${JSON.stringify(unknownCustomer)}`);
  }
  console.log(`PASS unknown customer returns a safe no-match (${unknownLookupResponse.status})`);

  const createResponse = await fetch(`${baseUrl}/api/tickets`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      requestId: ticketRequestId,
      customerId: customer.customerId,
      issue: "My replicator stopped working after the 9.4.0 update.",
      symptom: "The thermal-safety light flashes.",
      errorCode: "THERM-94",
    }),
  });
  const creation = await json(createResponse, "ticket creation");
  if (
    creation.ok !== true ||
    !creation.ticketId ||
    !/^REP-\d{6}$/.test(creation.ticketReference) ||
    creation.ticketSaved !== true ||
    creation.workflowStarted !== true ||
    creation.retryable !== false ||
    creation.status !== "researching" ||
    creation.created !== true
  ) {
    throw new Error(`ticket creation returned an unexpected contract: ${JSON.stringify(creation)}`);
  }
  console.log(`PASS ticket creation (${createResponse.status}, ${creation.ticketId})`);

  const duplicateResponse = await fetch(`${baseUrl}/api/tickets`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      requestId: ticketRequestId,
      customerId: customer.customerId,
      issue: "My replicator stopped working after the 9.4.0 update.",
      symptom: "The thermal-safety light flashes.",
      errorCode: "THERM-94",
    }),
  });
  const duplicate = await json(duplicateResponse, "duplicate ticket creation");
  if (
    duplicateResponse.status !== 200 ||
    duplicate.ticketId !== creation.ticketId ||
    duplicate.ticketReference !== creation.ticketReference ||
    duplicate.ok !== true ||
    duplicate.ticketSaved !== true ||
    duplicate.workflowStarted !== true ||
    duplicate.created !== false ||
    duplicate.duplicate !== true
  ) {
    throw new Error(`duplicate request was not safely reused: ${JSON.stringify(duplicate)}`);
  }
  console.log(`PASS duplicate request reused ticket (${duplicateResponse.status}, ${duplicate.ticketId})`);

  const conflictingResponse = await fetch(`${baseUrl}/api/tickets`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      requestId: ticketRequestId,
      customerId: customer.customerId,
      issue: "A different issue must not reuse this request ID.",
    }),
  });
  const conflict = await conflictingResponse.json().catch(() => null);
  if (conflictingResponse.status !== 409 || conflict?.error !== "idempotency_conflict") {
    throw new Error(`conflicting request was not rejected: ${JSON.stringify(conflict)}`);
  }
  console.log("PASS reused request ID with different content rejected (409)");

  let completedTicket = creation;
  for (let attempt = 0; attempt < 60 && completedTicket.status !== "answered"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const ticketResponse = await fetch(`${baseUrl}/api/tickets/${creation.ticketId}`, { headers });
    completedTicket = await json(ticketResponse, "ticket status");
  }

  if (completedTicket.status !== "answered") {
    throw new Error(`workflow did not reach answered; current status is ${completedTicket.status}`);
  }
  console.log(`PASS Inngest workflow (${completedTicket.status})`);
  console.log("\nDemo test passed. This validates connectivity and bearer authentication, not caller identity.");
}

main().catch((error) => {
  console.error(`FAIL ${error.message}`);
  process.exit(1);
});
