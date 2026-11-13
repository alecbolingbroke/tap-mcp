#!/usr/bin/env node
// Runs hosted Tap (see http.ts). Config comes from the environment; the host puts it behind HTTPS (e.g. Tailscale Funnel).
import { createServer } from "node:http";
import { homedir } from "node:os";
import { createApp, googleSub } from "./http.ts";

const need = (k: string) => process.env[k] || (console.error(`Missing ${k}`), process.exit(1));
const baseUrl = need("TAP_BASE_URL").replace(/\/$/, "");
const secret = need("TAP_SECRET");
if (secret.length < 32) (console.error("TAP_SECRET must be at least 32 characters."), process.exit(1));
const googleClientId = need("GOOGLE_CLIENT_ID");
const app = createApp({
  baseUrl,
  secret,
  dataDir: process.env.TAP_DATA_DIR ?? `${homedir()}/.tap/hosted`,
  googleClientId,
  googleSub: googleSub(googleClientId, need("GOOGLE_CLIENT_SECRET"), `${baseUrl}/oauth/google`),
});
const port = Number(process.env.PORT ?? 3232);
createServer((req, res) => void app(req, res)).listen(port, "127.0.0.1", () => console.log(`Tap hosted at ${baseUrl} (on 127.0.0.1:${port})`));
