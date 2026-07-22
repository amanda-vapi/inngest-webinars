import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const envPath = path.join(root, ".env");
const examplePath = path.join(root, ".env.example");
const envExisted = fs.existsSync(envPath);
const current = envExisted
  ? fs.readFileSync(envPath, "utf8")
  : fs.readFileSync(examplePath, "utf8");

const token = randomBytes(32).toString("base64url");
const lines = current.split(/\r?\n/);
let replaced = false;
const updated = lines.map((line) => {
  if (!line.startsWith("API_BEARER_TOKEN=")) return line;
  replaced = true;
  const value = line.slice("API_BEARER_TOKEN=".length);
  // Generate a real local secret for an empty value or the checked-in sample,
  // but never overwrite a token the attendee has already chosen.
  return value === "" || value === "local-demo-token" ? `API_BEARER_TOKEN=${token}` : line;
});
if (!replaced) updated.push(`API_BEARER_TOKEN=${token}`);

fs.writeFileSync(envPath, `${updated.filter(Boolean).join("\n")}\n`, { mode: 0o600 });
fs.chmodSync(envPath, 0o600);
console.log(envExisted ? "Local environment is ready in .env" : "Created .env");
