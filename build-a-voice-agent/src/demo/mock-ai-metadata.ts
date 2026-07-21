import { trace } from "@opentelemetry/api";
import {
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
} from "@opentelemetry/semantic-conventions/incubating";

const tracer = trace.getTracer("build-a-voice-agent");

// Deliberately creates the same kind of GenAI span that a model
// instrumentation library would emit. Inngest's aiMetadata extraction reads
// this span and adds it to the current step's built-in AI Metadata panel.
export async function mockResearchAnalysisMetadata() {
  const span = tracer.startSpan("chat gpt-4.1-mini", {
    attributes: {
      [ATTR_GEN_AI_REQUEST_MODEL]: "gpt-4.1-mini",
      [ATTR_GEN_AI_OPERATION_NAME]: "chat",
      [ATTR_GEN_AI_PROVIDER_NAME]: "openai",
      [ATTR_GEN_AI_USAGE_INPUT_TOKENS]: 842,
      [ATTR_GEN_AI_USAGE_OUTPUT_TOKENS]: 196,
    },
  });

  try {
    // A small, predictable duration makes the local trace feel like a model call.
    await new Promise((resolve) => setTimeout(resolve, 700));
  } finally {
    span.end();
  }
}
