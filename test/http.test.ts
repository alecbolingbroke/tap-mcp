// Hosted Tap end to end on a local port, with Google faked: discovery, client registration, sign-in, PKCE, tokens,
// the tools over MCP, each user's own state, and the ways each step must fail. Run: npm test
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { createApp, sign, verify } from "../src/http.ts";
import { saveState } from "../src/state.ts";

const dataDir = mkdtempSync(`${tmpdir()}/tap-http-`);
const secret = "test-secret-that-is-at-least-32-characters";
const srv = createServer();
await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
// Fake Google: the code is the account id, "nope" fails.
srv.on("request", createApp({ baseUrl: base, secret, dataDir, googleClientId: "g-id", googleSub: async (c) => (c === "nope" ? null : `sub-${c}`) }));

const get = (path: string) => fetch(base + path, { redirect: "manual" });
const form = (path: string, body: Record<string, string>) => fetch(base + path, { method: "POST", body: new URLSearchParams(body) });
const b64url = (b: Buffer) => b.toString("base64url");
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

// Discovery: an unauthenticated MCP call points the client at the resource metadata, which points at the auth server.
let r = await fetch(`${base}/mcp`, { method: "POST" });
assert.equal(r.status, 401);
assert.match(r.headers.get("www-authenticate") ?? "", /resource_metadata=".*oauth-protected-resource"/);
assert.deepEqual((await (await get("/.well-known/oauth-protected-resource")).json()).authorization_servers, [base]);
assert.deepEqual((await (await get("/.well-known/oauth-authorization-server")).json()).code_challenge_methods_supported, ["S256"]);

// Registration: https redirects only (or http on localhost).
// Registration: only the AI apps Tap supports, or localhost. An attacker's own site is refused: that's the account takeover
// found in review (register a "client" that sends a victim's sign-in to attacker.example, then use their account).
for (const bad of ["http://evil.example/cb", "https://attacker.example/cb", "https://claude.ai.attacker.example/cb"]) {
  r = await fetch(`${base}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: [bad] }) });
  assert.equal(r.status, 400, bad);
}
r = await fetch(`${base}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: ["http://127.0.0.1:33418/callback"] }) });
assert.equal(r.status, 201);
r = await fetch(`${base}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT] }) });
assert.equal(r.status, 201);
const clientId: string = (await r.json()).client_id;

/** Sign in as Google account `who` and come back with tokens, the way an MCP client does. */
async function signIn(who: string) {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const a = await get(`/authorize?${new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "xyz" })}`);
  const google = new URL(a.headers.get("location")!);
  assert.equal(google.origin, "https://accounts.google.com");
  assert.equal(google.searchParams.get("scope"), "openid"); // never asks Google for a name or email
  const back = new URL((await get(`/oauth/google?code=${who}&state=${encodeURIComponent(google.searchParams.get("state")!)}`)).headers.get("location")!);
  assert.equal(`${back.origin}${back.pathname}`, REDIRECT);
  assert.equal(back.searchParams.get("state"), "xyz");
  return { code: back.searchParams.get("code")!, verifier };
}
const exchange = (code: string, verifier: string, extra: Record<string, string> = {}) =>
  form("/token", { grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT, ...extra });

// Authorize refuses a redirect the client didn't register, and PKCE is required.
assert.equal((await get(`/authorize?${new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: "https://evil.example/cb", code_challenge: "x", code_challenge_method: "S256" })}`)).status, 400);
assert.match((await get(`/authorize?${new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT })}`)).headers.get("location") ?? "", /error=invalid_request/);

// Token exchange: wrong verifier fails, the right one works once, a reused code fails.
let { code, verifier } = await signIn("alice");
assert.equal((await exchange(code, "wrong-verifier")).status, 400);
r = await exchange(code, verifier);
assert.equal(r.status, 200);
const alice = await r.json();
assert.equal((await exchange(code, verifier)).status, 400);
// A failed Google sign-in goes back to the client as access_denied.
const a2 = await get(`/authorize?${new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: "c", code_challenge_method: "S256", state: "s" })}`);
const st = new URL(a2.headers.get("location")!).searchParams.get("state")!;
assert.match((await get(`/oauth/google?code=nope&state=${encodeURIComponent(st)}`)).headers.get("location") ?? "", /error=access_denied/);

// MCP with the token: Alice saves a card; Bob, signed in separately, has his own empty state.
let id = 0;
const mcp = async (token: string, method: string, params: unknown = {}) => {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  return (await res.json()).result;
};
const tool = async (token: string, name: string, args: unknown) => JSON.parse((await mcp(token, "tools/call", { name, arguments: args })).content[0].text);
const init = await mcp(alice.access_token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
assert.match(init.instructions, /optimize_purchase/);
assert.ok((await mcp(alice.access_token, "tools/list")).tools.some((t: { name: string }) => t.name === "optimize_purchase"));
await tool(alice.access_token, "set_my_cards", { cards: ["discover-it-cash-back"] });
assert.deepEqual((await tool(alice.access_token, "list_cards", {})).cards.filter((c: { held: boolean }) => c.held).map((c: { slug: string }) => c.slug), ["discover-it-cash-back"]);
({ code, verifier } = await signIn("bob"));
const bob = await (await exchange(code, verifier)).json();
assert.ok((await tool(bob.access_token, "list_cards", {})).cards.every((c: { held: boolean }) => !c.held));
// Files are named by a hash of the account id: nothing on disk says who anyone is.
const files = readdirSync(`${dataDir}/users`);
assert.equal(files.length, 1);
assert.ok(!files[0].includes("alice"));

// Refresh works and stays Alice's; a tampered or wrong-kind token is refused.
assert.equal((await form("/token", { grant_type: "refresh_token", refresh_token: alice.refresh_token })).status, 400); // client_id required
assert.equal((await form("/token", { grant_type: "refresh_token", refresh_token: alice.refresh_token, client_id: clientId, resource: "https://other.example/mcp" })).status, 400);
r = await form("/token", { grant_type: "refresh_token", refresh_token: alice.refresh_token, client_id: clientId });
const refreshed = await r.json();
assert.ok((await tool(refreshed.access_token, "list_cards", {})).cards.some((c: { held: boolean }) => c.held));
const forged = sign({ typ: "access", sub: "sub-alice", c: "x", exp: 9e9 }, "some-other-secret-at-least-32-chars!!");
assert.equal((await fetch(`${base}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${forged}` } })).status, 401);
assert.equal((await fetch(`${base}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${alice.refresh_token}` } })).status, 401);
assert.equal(verify(sign({ typ: "access", exp: 1 }, secret), "access", secret), null); // expired

// Deleting needs a confirm, then removes Alice's file (Bob never saved anything, so none are left).
assert.match(JSON.stringify(await mcp(refreshed.access_token, "tools/call", { name: "delete_my_data", arguments: { confirm: false } })), /confirm/);
assert.equal((await tool(refreshed.access_token, "delete_my_data", { confirm: true })).deleted, true);
// ...and signs her out everywhere: her old access and refresh tokens stop working; a fresh sign-in works.
assert.equal((await fetch(`${base}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${refreshed.access_token}` } })).status, 401);
assert.equal((await form("/token", { grant_type: "refresh_token", refresh_token: alice.refresh_token, client_id: clientId })).status, 400);
await new Promise((r) => setTimeout(r, 1100)); // tokens carry whole seconds; a new one must be issued after the sign-out
({ code, verifier } = await signIn("alice"));
const again = await (await exchange(code, verifier)).json();
assert.ok((await tool(again.access_token, "list_cards", {})).cards.every((c: { held: boolean }) => !c.held));
assert.equal(readdirSync(`${dataDir}/users`).length, 0);
// A token for another resource is refused, and one user can't grow their file without limit.
assert.equal((await fetch(`${base}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${sign({ typ: "access", sub: "sub-alice", c: "x", aud: "https://other.example/mcp", iat: 9e9, exp: 9e9 }, secret)}` } })).status, 401);
assert.throws(() => saveState(`${dataDir}/big.json`, { balances: Array.from({ length: 3000 }, (_, i) => ({ name: `b${i}`, program: "p".repeat(50), value: 1, unit: "USD" as const })) }), /too large/);
srv.close();
rmSync(dataDir, { recursive: true });
assert.ok(!existsSync(dataDir));
console.log("hosted: all scenarios pass");
