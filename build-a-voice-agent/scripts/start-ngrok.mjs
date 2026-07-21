import "dotenv/config";
import { spawn } from "node:child_process";

const rawDomain = process.env.NGROK_DOMAIN || "";
const domain = rawDomain.replace(/^https?:\/\//, "").replace(/\/$/, "");
const args = domain ? ["http", `--domain=${domain}`, process.env.PORT || "3000"] : ["http", process.env.PORT || "3000"];
const child = spawn("ngrok", args, { stdio: "inherit" });
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
