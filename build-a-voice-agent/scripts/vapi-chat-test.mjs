import "dotenv/config";
import { assertVapiConfigMatches } from "./check-vapi-config.mjs";

// This webinar uses caller-ID-based ownership. The trusted variables used by
// the tools are supplied by a Vapi phone call, not the Chat API. Keep this
// preflight under the historical `test:vapi` command so attendees cannot get
// a false positive from a chat session with no caller-number context.
async function main() {
  await assertVapiConfigMatches();
  console.log("PASS Vapi phone-agent preflight: the assistant and both API Request tools match this repository.");
  console.log("Run an inbound phone call to exercise trusted caller-number lookup and ticket creation.");
}

main().catch((error) => {
  console.error(`FAIL ${error.message}`);
  process.exit(1);
});
