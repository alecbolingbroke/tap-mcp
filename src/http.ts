// Hosted Tap, for AI clients that can't start a local server (ChatGPT, Claude on the web). Same tools as the stdio server;
// each user gets their own state file, in the same format as ~/.tap/state.json.
// Sign-in is Google with scope "openid" only: Tap learns an anonymous account id, never a name or an email. In front of
// that sits the small OAuth 2.1 server MCP clients expect (dynamic client registration, PKCE, refresh). Every client id,
// code and token is HMAC-signed, so the server keeps no session store.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { makeServer } from "./tools.ts";

export type Config = {
  /** Public origin, no trailing slash, e.g. https://host.example.ts.net:8443 */ baseUrl: string;
  secret: string;
  dataDir: string;
  googleClientId: string;
  /** Google's authorization code → the user's stable Google account id (sub), or null. Injected so tests don't call Google. */
  googleSub: (code: string) => Promise<string | null>;
};

const ACCESS_SECONDS = 3600;
const REFRESH_SECONDS = 90 * 864e2;
const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const sha = (s: string) => createHash("sha256").update(s).digest();

type Claims = { typ: "client" | "pending" | "code" | "access" | "refresh"; exp?: number } & Record<string, unknown>;
export function sign(c: Claims, secret: string) {
  const body = b64url(JSON.stringify(c));
  return `${body}.${b64url(createHmac("sha256", secret).update(body).digest())}`;
}
export function verify(token: unknown, typ: Claims["typ"], secret: string, now = Date.now()): Claims | null {
  if (typeof token !== "string") return null;
  const [body, mac, extra] = token.split(".");
  if (!body || !mac || extra !== undefined) return null;
  const want = createHmac("sha256", secret).update(body).digest();
  const got = Buffer.from(mac, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const c = JSON.parse(Buffer.from(body, "base64url").toString()) as Claims;
    return c.typ === typ && (c.exp === undefined || c.exp * 1000 > now) ? c : null;
  } catch {
    return null;
  }
}

// Where a sign-in may be sent: the web AI apps Tap supports, or the user's own machine (desktop and CLI clients listen on
// localhost). Any other site is refused, or anyone could register a "client" that sends a victim's sign-in to their server.
const REDIRECT_HOSTS = ["claude.ai", "claude.com", "chatgpt.com", "chat.openai.com"];
/** A redirect a client may register: https on a known AI app, or http on loopback (RFC 8252), never with a fragment. */
function okRedirect(uri: unknown): uri is string {
  if (typeof uri !== "string" || uri.length > 500) return false;
  try {
    const u = new URL(uri);
    const app = u.protocol === "https:" && REDIRECT_HOSTS.includes(u.hostname);
    return !u.hash && (app || (u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)));
  } catch {
    return false;
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1_000_000) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString();
}
const parseForm = (raw: string, type = "") =>
  type.includes("application/json") ? (JSON.parse(raw || "{}") as Record<string, unknown>) : Object.fromEntries(new URLSearchParams(raw));

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}
const redirect = (res: ServerResponse, to: string) => {
  res.writeHead(302, { Location: to, "Cache-Control": "no-store" });
  res.end();
};
const withQuery = (base: string, q: Record<string, string | undefined>) => {
  const u = new URL(base);
  for (const [k, v] of Object.entries(q)) if (v !== undefined) u.searchParams.set(k, v);
  return u.toString();
};

export function createApp(cfg: Config) {
  const resource = `${cfg.baseUrl}/mcp`;
  const googleRedirect = `${cfg.baseUrl}/oauth/google`;
  // shortcut: no rate limit or account cap; anyone with a Google account can sign up. Add both before promoting it widely.
  // shortcut: single-use codes are remembered in this process only; fine for one host, needs a shared store if it ever scales out.
  const usedCodes = new Map<string, number>();
  const clientKey = (clientId: string) => b64url(sha(clientId)).slice(0, 22);
  const userId = (sub: string) => b64url(sha(`google:${sub}`));
  const statePath = (sub: string) => `${cfg.dataDir}/users/${userId(sub)}.json`;
  // Deleting your data also signs out every app you connected: tokens issued before this moment stop working.
  const revokedPath = (sub: string) => `${cfg.dataDir}/revoked/${userId(sub)}`;
  const revoke = (sub: string) => {
    mkdirSync(`${cfg.dataDir}/revoked`, { recursive: true });
    writeFileSync(revokedPath(sub), String(Date.now()));
  };
  const isRevoked = (t: Claims) => {
    try {
      return (t.iat as number) * 1000 <= Number(readFileSync(revokedPath(t.sub as string), "utf8"));
    } catch {
      return false;
    }
  };
  const tokens = (sub: string, c: string) => {
    const now = Math.floor(Date.now() / 1000);
    return {
      access_token: sign({ typ: "access", sub, c, aud: resource, iat: now, exp: now + ACCESS_SECONDS }, cfg.secret),
      token_type: "Bearer",
      expires_in: ACCESS_SECONDS,
      refresh_token: sign({ typ: "refresh", sub, c, iat: now, exp: now + REFRESH_SECONDS }, cfg.secret),
    };
  };

  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", cfg.baseUrl);
    const path = url.pathname;
    const q = Object.fromEntries(url.searchParams);
    // MCP clients that run in a browser read discovery, register and exchange tokens cross-origin.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id");
    res.setHeader("Access-Control-Expose-Headers", "WWW-Authenticate, Mcp-Session-Id");
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS" });
      return res.end();
    }

    try {
      if (path.startsWith("/.well-known/oauth-protected-resource"))
        return send(res, 200, { resource, authorization_servers: [cfg.baseUrl], bearer_methods_supported: ["header"] });
      if (path.startsWith("/.well-known/oauth-authorization-server") || path.startsWith("/.well-known/openid-configuration"))
        return send(res, 200, {
          issuer: cfg.baseUrl,
          authorization_endpoint: `${cfg.baseUrl}/authorize`,
          token_endpoint: `${cfg.baseUrl}/token`,
          registration_endpoint: `${cfg.baseUrl}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });

      if (path === "/register" && req.method === "POST") {
        const b = parseForm(await readBody(req), req.headers["content-type"]);
        const uris = b.redirect_uris;
        if (!Array.isArray(uris) || !uris.length || uris.length > 10 || !uris.every(okRedirect))
          return send(res, 400, { error: "invalid_redirect_uri", error_description: "redirect_uris must be https (or http on localhost) URLs." });
        const name = typeof b.client_name === "string" ? b.client_name.slice(0, 80) : "MCP client";
        return send(res, 201, {
          client_id: sign({ typ: "client", r: uris }, cfg.secret),
          client_id_issued_at: Math.floor(Date.now() / 1000),
          client_name: name,
          redirect_uris: uris,
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        });
      }

      if (path === "/authorize") {
        const client = verify(q.client_id, "client", cfg.secret);
        // Never redirect to an address the client didn't register: that would make Tap an open redirector.
        if (!client || !(client.r as string[]).includes(q.redirect_uri)) return send(res, 400, { error: "invalid_client", error_description: "Unknown client or redirect_uri." });
        if (q.response_type !== "code" || q.code_challenge_method !== "S256" || !q.code_challenge)
          return redirect(res, withQuery(q.redirect_uri, { error: "invalid_request", error_description: "Needs response_type=code and PKCE (S256).", state: q.state }));
        if (q.resource && q.resource !== resource) return redirect(res, withQuery(q.redirect_uri, { error: "invalid_target", state: q.state }));
        const pending = sign({ typ: "pending", c: clientKey(q.client_id), r: q.redirect_uri, ch: q.code_challenge, s: q.state, exp: Math.floor(Date.now() / 1000) + 600 }, cfg.secret);
        return redirect(res, withQuery("https://accounts.google.com/o/oauth2/v2/auth", {
          client_id: cfg.googleClientId, redirect_uri: googleRedirect, response_type: "code", scope: "openid", state: pending, prompt: "select_account",
        }));
      }

      if (path === "/oauth/google") {
        const p = verify(q.state, "pending", cfg.secret);
        if (!p) return send(res, 400, { error: "invalid_request", error_description: "Sign-in expired. Start again from your AI app." });
        const back = (extra: Record<string, string>) => redirect(res, withQuery(p.r as string, { ...extra, state: p.s as string | undefined }));
        if (!q.code) return back({ error: "access_denied" });
        const sub = await cfg.googleSub(q.code);
        if (!sub) return back({ error: "access_denied", error_description: "Google sign-in failed." });
        const code = sign({ typ: "code", sub, c: p.c, r: p.r, ch: p.ch, j: b64url(randomBytes(12)), exp: Math.floor(Date.now() / 1000) + 120 }, cfg.secret);
        return back({ code });
      }

      if (path === "/token" && req.method === "POST") {
        const b = parseForm(await readBody(req), req.headers["content-type"]) as Record<string, string>;
        const bad = (d: string) => send(res, 400, { error: "invalid_grant", error_description: d });
        if (b.grant_type === "authorization_code") {
          const c = verify(b.code, "code", cfg.secret);
          if (!c) return bad("Code expired or invalid.");
          if (usedCodes.has(c.j as string)) return bad("Code already used.");
          if (!b.client_id || clientKey(b.client_id) !== c.c || b.redirect_uri !== c.r) return bad("client_id or redirect_uri doesn't match.");
          if (typeof b.code_verifier !== "string" || b64url(sha(b.code_verifier)) !== c.ch) return bad("PKCE check failed.");
          const now = Date.now();
          for (const [j, exp] of usedCodes) if (exp < now) usedCodes.delete(j);
          usedCodes.set(c.j as string, (c.exp as number) * 1000);
          return send(res, 200, tokens(c.sub as string, c.c as string));
        }
        if (b.resource && b.resource !== resource) return send(res, 400, { error: "invalid_target" });
        if (b.grant_type === "refresh_token") {
          const r = verify(b.refresh_token, "refresh", cfg.secret);
          if (!r || !b.client_id || clientKey(b.client_id) !== r.c || isRevoked(r)) return bad("Refresh token expired or invalid.");
          return send(res, 200, tokens(r.sub as string, r.c as string));
        }
        return send(res, 400, { error: "unsupported_grant_type" });
      }

      if (path === "/mcp") {
        const auth = req.headers.authorization ?? "";
        const t = verify(auth.startsWith("Bearer ") ? auth.slice(7) : "", "access", cfg.secret);
        if (!t || t.aud !== resource || isRevoked(t))
          return send(res, 401, { error: "invalid_token" }, { "WWW-Authenticate": `Bearer resource_metadata="${cfg.baseUrl}/.well-known/oauth-protected-resource"` });
        const body = req.method === "POST" ? JSON.parse((await readBody(req)) || "null") : undefined;
        // Stateless: a fresh server per request, bound to this user's file. Cheap, and no session can cross users.
        const server = makeServer(statePath(t.sub as string), () => revoke(t.sub as string));
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on("close", () => {
          void transport.close();
          void server.close();
        });
        await server.connect(transport);
        return await transport.handleRequest(req, res, body);
      }

      if (path === "/healthz") return send(res, 200, { ok: true });
      if (path === "/") return redirect(res, "https://tap.alecbolingbroke.com/agents");
      return send(res, 404, { error: "not_found" });
    } catch (err) {
      if (!res.headersSent) send(res, 400, { error: "invalid_request", error_description: (err as Error).message });
    }
  };
}

/** Google's code → the account id, straight from Google's token endpoint over TLS (so the ID token needs no signature check). */
export function googleSub(clientId: string, clientSecret: string, redirectUri: string) {
  return async (code: string) => {
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code" }),
    });
    if (!r.ok) return null;
    const idToken = ((await r.json()) as { id_token?: string }).id_token;
    const claims = idToken ? JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString() || "{}") : {};
    const fromGoogle = ["https://accounts.google.com", "accounts.google.com"].includes(claims.iss);
    return fromGoogle && claims.aud === clientId && typeof claims.sub === "string" ? claims.sub : null;
  };
}
