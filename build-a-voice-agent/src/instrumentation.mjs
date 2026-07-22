// OpenTelemetry must load before application modules. Keep it opt-in because
// the webinar can run its deterministic research path without observability.
if (process.env.ENABLE_AI_METADATA === "1") {
  await import("@inngest/otel/node");
}
