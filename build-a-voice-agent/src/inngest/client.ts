import { dependencyInjectionMiddleware, Inngest } from "inngest";
import { scoreMiddleware } from "inngest/experimental";
import { demoDelay } from "../demo/demo-delay.js";

// One shared client is used to send events and define every function.
// Locally, INNGEST_DEV=1 routes this client to the Inngest Dev Server.
export const inngest = new Inngest({
  id: "build-a-voice-agent",
  // Extract OpenTelemetry GenAI attributes and attach them to their step.
  aiMetadata: true,
  middleware: [
    dependencyInjectionMiddleware({ demoDelay }),
    scoreMiddleware(),
  ],
});
