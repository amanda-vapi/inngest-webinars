import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

type Scenario = {
  name: string;
  instructions: string;
  evaluations: Array<{
    structuredOutput: {
      name: string;
      schema: { type: string; description?: string };
    };
    comparator: string;
    value: unknown;
    required: boolean;
  }>;
  toolMocks: Array<{ toolName: string; result: string; enabled: boolean }>;
};

const simulationsDirectory = "vapi/simulations";
const manifest = JSON.parse(
  readFileSync(`${simulationsDirectory}/manifest.json`, "utf8"),
) as {
  suiteName: string;
  simulations: Array<{
    name: string;
    scenarioFile: string;
    personalityName: string;
  }>;
};

function scenario(filename: string) {
  return JSON.parse(
    readFileSync(`${simulationsDirectory}/${filename}`, "utf8"),
  ) as Scenario;
}

test("defines exactly three Replicator Support simulations", () => {
  assert.equal(manifest.suiteName, "Replicator Support Webinar - Production Behaviors");
  assert.deepEqual(
    manifest.simulations.map((simulation) => simulation.scenarioFile),
    [
      "confirmed-ticket.scenario.json",
      "unknown-caller.scenario.json",
      "workflow-dispatch-failure.scenario.json",
    ],
  );
  assert.equal(new Set(manifest.simulations.map((simulation) => simulation.name)).size, 3);
  assert.equal(
    new Set(manifest.simulations.map((simulation) => simulation.personalityName)).size,
    3,
  );
});

test("uses Vapi-compatible primitive required evaluations", () => {
  const primitiveTypes = new Set(["string", "number", "integer", "boolean"]);
  for (const definition of manifest.simulations) {
    const value = scenario(definition.scenarioFile);
    assert.equal(value.name, definition.name);
    assert.ok(value.instructions.length > 100);
    assert.ok(value.evaluations.length > 0);
    for (const evaluation of value.evaluations) {
      assert.ok(evaluation.structuredOutput.name);
      assert.ok(primitiveTypes.has(evaluation.structuredOutput.schema.type));
      assert.equal(evaluation.comparator, "=");
      assert.equal(typeof evaluation.value, "boolean");
      assert.equal(evaluation.required, true);
    }
  }
});

test("mocks only the two configured assistant tools with valid JSON results", () => {
  const configuredToolNames = [
    "vapi/tools/lookup_customer.api-request-tool.json",
    "vapi/tools/create_support_ticket.api-request-tool.json",
  ].map((filename) => JSON.parse(readFileSync(filename, "utf8")).name);

  for (const definition of manifest.simulations) {
    const mocks = scenario(definition.scenarioFile).toolMocks;
    assert.deepEqual(mocks.map((mock) => mock.toolName), configuredToolNames);
    for (const mock of mocks) {
      assert.equal(mock.enabled, true);
      assert.doesNotThrow(() => JSON.parse(mock.result));
    }
  }
});

test("models the confirmed, no-match, and retryable failure contracts", () => {
  const confirmedScenario = scenario("confirmed-ticket.scenario.json");
  const confirmed = confirmedScenario.toolMocks.map((mock) => JSON.parse(mock.result));
  assert.equal(confirmed[0].customerId, "cus_amanda");
  assert.equal(confirmed[1].ticketId, "ticket_sim_confirmed_001");
  assert.equal(confirmed[1].ticketReference, "REP-004021");
  assert.equal(confirmed[1].workflowStarted, true);
  assert.ok(
    confirmedScenario.evaluations.some(
      (evaluation) => evaluation.structuredOutput.name === "identifier_readback_unambiguous",
    ),
  );

  const unknown = scenario("unknown-caller.scenario.json").toolMocks.map((mock) =>
    JSON.parse(mock.result)
  );
  assert.deepEqual(unknown[0], { matched: false, nextAction: "recheck_contact" });

  const failedScenario = scenario("workflow-dispatch-failure.scenario.json");
  const failed = failedScenario.toolMocks.map((mock) => JSON.parse(mock.result));
  assert.equal(failed[1].error, "workflow_dispatch_failed");
  assert.equal(failed[1].status, "event_failed");
  assert.equal(failed[1].ticketReference, "REP-005003");
  assert.equal(failed[1].ticketSaved, true);
  assert.equal(failed[1].workflowStarted, false);
  assert.equal(failed[1].retryable, true);
  assert.ok(
    failedScenario.evaluations.some(
      (evaluation) => evaluation.structuredOutput.name === "privacy_not_overpromised",
    ),
  );
});

test("biases voice transcription toward demo-critical identifiers", () => {
  const assistant = JSON.parse(readFileSync("vapi/assistant.config.json", "utf8")) as {
    transcriber: { keyterm: string[] };
  };
  assert.deepEqual(assistant.transcriber.keyterm, [
    "Home Replicator",
    "XR-200",
    "THERM-94",
  ]);
});
