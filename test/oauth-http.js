import assert from "node:assert/strict";
import express from "express";
import { createHash } from "node:crypto";
import { installPrivateAuth } from "../private-auth.js";

const password = "테스트!Password12";
const app = express();
const server = app.listen(0, "127.0.0.1");
await new Promise(resolve => server.once("listening", resolve));
const base = `http://localhost:${server.address().port}`;
installPrivateAuth(app, {password, publicUrl:base});
let apiReached = 0;
app.post("/mcp", (_req, res) => { apiReached++; res.json({ok:true}); });
const request = (path, opts = {}) => fetch(base + path, {redirect:"manual", ...opts});
const form = fields => ({method:"POST", headers:{"Content-Type":"application/x-www-form-urlencoded", Origin:base}, body:new URLSearchParams(fields)});
const verifier = "v".repeat(64);
const challenge = createHash("sha256").update(verifier).digest("base64url");
const callback = "https://chatgpt.com/connector_platform/oauth_redirect";

try {
  assert.throws(() => installPrivateAuth(express(), {password:"short", publicUrl:base}));
  for (const headers of [{}, {Authorization:`Bearer ${"legacy-password".repeat(3)}`}, {Authorization:"Bearer bogus"}]) {
    assert.equal((await request("/mcp", {method:"POST", headers})).status, 401);
  }
  assert.equal(apiReached, 0);
  const discovery = await (await request("/.well-known/oauth-protected-resource/mcp")).json();
  assert.equal(discovery.resource, base + "/mcp");
  const metadata = await (await request("/.well-known/oauth-authorization-server")).json();
  assert.equal(metadata.registration_endpoint, base + "/register");
  const regBody = {redirect_uris:[callback], token_endpoint_auth_method:"none", grant_types:["authorization_code", "refresh_token"], response_types:["code"]};
  assert.equal((await request("/register", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({...regBody, redirect_uris:["https://attacker.invalid/callback"]})})).status, 400);
  const reg = await request("/register", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(regBody)});
  assert.equal(reg.status, 201);
  const client = await reg.json();
  const authQuery = new URLSearchParams({client_id:client.client_id, redirect_uri:callback, response_type:"code", code_challenge:challenge, code_challenge_method:"S256", state:"test-state", resource:base + "/mcp", scope:"realestate.read"});
  const auth = await request("/authorize?" + authQuery);
  assert.equal(auth.status, 302);
  const login = auth.headers.get("location");
  const ticket = new URL(login, base).searchParams.get("request");
  const loginPage = await request(login);
  assert.equal(loginPage.status, 200);
  assert.match(loginPage.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal((await loginPage.text()).includes(password), false);
  const wrong = await request("/login", form({request:ticket, password:"wrong"}));
  assert.equal(wrong.status, 401);
  assert.equal(apiReached, 0);
  assert.equal((await request("/login", {...form({request:ticket, password}), headers:{"Content-Type":"application/x-www-form-urlencoded",Origin:"https://attacker.invalid"}})).status, 403);
  const logged = await request("/login", form({request:ticket, password}));
  assert.equal(logged.status, 303);
  const redirected = new URL(logged.headers.get("location"));
  assert.equal(redirected.origin, "https://chatgpt.com");
  assert.equal(redirected.searchParams.get("state"), "test-state");
  const code = redirected.searchParams.get("code");
  assert.equal((await request("/login", form({request:ticket, password}))).status, 400);
  const exchangeFields = {grant_type:"authorization_code", client_id:client.client_id, redirect_uri:callback, code, code_verifier:verifier, resource:base + "/mcp"};
  assert.equal((await request("/token", form({...exchangeFields, code_verifier:"wrong"}))).status, 400);
  const exchange = await request("/token", form(exchangeFields));
  assert.equal(exchange.status, 200);
  const tokens = await exchange.json();
  assert.equal((await request("/token", form(exchangeFields))).status, 400);
  assert.equal((await request("/mcp", {method:"POST", headers:{Authorization:`Bearer ${tokens.access_token}`}})).status, 200);
  assert.equal(apiReached, 1);
  assert.equal((await request("/mcp", {method:"POST", headers:{Authorization:`Bearer ${tokens.access_token.slice(0,-8)}bogus123`}})).status, 401);
  const refresh = await request("/token", form({grant_type:"refresh_token", client_id:client.client_id, refresh_token:tokens.refresh_token, resource:base + "/mcp"}));
  assert.equal(refresh.status, 200);
  assert.equal((await request("/token", form({grant_type:"refresh_token", client_id:client.client_id, refresh_token:tokens.refresh_token, resource:"https://attacker.invalid/mcp"}))).status, 400);
  // 새 프로세스와 같은 빈 저장소에서도 클라이언트 및 접속 증표가 검증된다.
  const restarted = installPrivateAuth(express(), {password, publicUrl:base});
  assert.equal((await restarted.clientsStore.getClient(client.client_id)).client_id, client.client_id);
  assert.equal((await restarted.verifyAccessToken(tokens.access_token)).clientId, client.client_id);
  const changed = installPrivateAuth(express(), {password:"새로운!Password12", publicUrl:base});
  await assert.rejects(changed.verifyAccessToken(tokens.access_token));
  assert.equal(await changed.clientsStore.getClient(client.client_id), undefined);
  console.log("PASS: password login, 401 protection, ChatGPT-only callbacks, PKCE, single-use codes, refresh, restart, and password change invalidation; no real API calls.");
} finally {
  await new Promise(resolve => server.close(resolve));
}
