// Injected through Inngest middleware so the research workflow reads like
// business logic, not a collection of demo-only timers.
export async function demoDelay(system: string) {
  const base = Number(process.env.DEMO_SYSTEM_LATENCY_MS ?? 1200);
  const variation = [...system].reduce((sum, character) => sum + character.charCodeAt(0), 0) % 900;
  await new Promise((resolve) => setTimeout(resolve, base + variation));
}
