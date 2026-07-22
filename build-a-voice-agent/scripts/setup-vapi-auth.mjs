import "dotenv/config";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const envPath = path.join(root, ".env");

function updateEnv(values) {
  const current = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  const keys = new Set(Object.keys(values));
  const seen = new Set();
  const lines = current.split(/\r?\n/).filter(Boolean).map((line) => {
    const key = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/)?.[1];
    if (!key || !keys.has(key)) return line;
    seen.add(key);
    return `${key}=${values[key]}`;
  });
  for (const [key, value] of Object.entries(values)) {
    if (!seen.has(key)) lines.push(`${key}=${value}`);
  }
  fs.writeFileSync(envPath, `${lines.join("\n")}\n`, { mode: 0o600 });
}

async function vapi(pathname, options = {}) {
  const response = await fetch(`https://api.vapi.ai${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.VAPI_API_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`${options.method || "GET"} ${pathname}: ${response.status} ${body?.message || text}`);
  }
  return body;
}

async function main() {
  if (!process.env.VAPI_API_KEY) throw new Error("Missing VAPI_API_KEY in .env");

  if (process.env.API_BEARER_TOKEN && process.env.VAPI_API_CREDENTIAL_ID) {
    const credential = await vapi(`/credential/${process.env.VAPI_API_CREDENTIAL_ID}`);
    console.log(JSON.stringify({ credentialId: credential.id, status: "already_configured" }, null, 2));
    return;
  }

  const token = process.env.API_BEARER_TOKEN || randomBytes(32).toString("base64url");
  const credential = await vapi("/credential", {
    method: "POST",
    body: JSON.stringify({
      provider: "custom-credential",
      name: "Inngest Webinar Local API",
      authenticationPlan: {
        type: "bearer",
        token,
        headerName: "Authorization",
        bearerPrefixEnabled: true,
      },
    }),
  });

  updateEnv({
    API_BEARER_TOKEN: token,
    VAPI_API_CREDENTIAL_ID: credential.id,
  });
  console.log(JSON.stringify({ credentialId: credential.id, status: "created" }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
