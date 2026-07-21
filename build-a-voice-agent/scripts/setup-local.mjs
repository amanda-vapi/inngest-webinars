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
  return line === "API_BEARER_TOKEN=" ? `API_BEARER_TOKEN=${token}` : line;
});
if (!replaced) updated.push(`API_BEARER_TOKEN=${token}`);

fs.writeFileSync(envPath, `${updated.filter(Boolean).join("\n")}\n`, { mode: 0o600 });
fs.chmodSync(envPath, 0o600);
console.log(envExisted ? "Local environment is ready in .env" : "Created .env");
