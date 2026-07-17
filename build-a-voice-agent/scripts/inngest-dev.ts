import "dotenv/config";
import net from "node:net";
import { spawn } from "node:child_process";

function getDevServerPort() {
  const value = process.env.INNGEST_DEV ?? "1";

  // This is Inngest's conventional local setup: INNGEST_DEV=1 means 8288.
  if (value === "1" || value === "true") return 8288;

  try {
    const url = new URL(value);
    if (!["localhost", "127.0.0.1"].includes(url.hostname) || !url.port) {
      throw new Error();
    }
    return Number(url.port);
  } catch {
    throw new Error(
      "INNGEST_DEV must be `1` or a local URL such as http://localhost:8292.",
    );
  }
}

async function assertPortIsFree(port: number) {
  await new Promise<void>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", () => {
      reject(
        new Error(
          `Port ${port} is already in use. Stop the existing Dev Server or choose another port in .env.`,
        ),
      );
    });
    server.listen(port, () => server.close(() => resolve()));
  });
}

const devServerPort = getDevServerPort();
const appPort = process.env.PORT ?? "3000";

await assertPortIsFree(devServerPort);

// `--no-discovery` keeps this dashboard limited to this project. Crucially,
// this command derives --port from INNGEST_DEV, so the app and CLI cannot
// silently point to different Dev Servers.
const child = spawn(
  "npx",
  [
    "--yes",
    "inngest-cli@latest",
    "dev",
    "--port",
    String(devServerPort),
    "--no-discovery",
    "-u",
    `http://127.0.0.1:${appPort}/api/inngest`,
  ],
  { stdio: "inherit", shell: process.platform === "win32" },
);

child.on("exit", (code) => process.exit(code ?? 1));
