import { Inngest } from "inngest";
import { scoreMiddleware } from "inngest/experimental";

// One shared client is used to send events and define every function.
// Locally, INNGEST_DEV=1 routes this client to the Inngest Dev Server.
export const inngest = new Inngest({
  id: "build-a-voice-agent",
  middleware: [scoreMiddleware()],
});
