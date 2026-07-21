import "dotenv/config";
import net from "node:net";
import { spawn } from "node:child_process";

function devServerPort() {
  const value = process.env.INNGEST_DEV ?? "1";
  if (value === "1" || value === "true") return 8288;
  const url = new URL(value);
  if (!["localhost", "127.0.0.1"].includes(url.hostname) || !url.port) {
    throw new Error("INNGEST_DEV must be 1 or a local URL with a port");
  }
  return Number(url.port);
}

async function assertFree(port: number) {
  await new Promise<void>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", () => reject(new Error(`Port ${port} is already in use`)));
    server.listen(port, () => server.close(() => resolve()));
  });
}

const port = devServerPort();
await assertFree(port);
const appPort = process.env.PORT ?? "3000";
const child = spawn(
  "npx",
  ["--yes", "inngest-cli@1.37.0", "dev", "--port", String(port), "--no-discovery", "-u", `http://127.0.0.1:${appPort}/api/inngest`],
  { stdio: "inherit", shell: process.platform === "win32" },
);
child.on("exit", (code) => process.exit(code ?? 1));
