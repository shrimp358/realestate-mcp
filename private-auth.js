import express from "express";
import { randomBytes, scryptSync, createCipheriv, createDecipheriv, createHash, timingSafeEqual } from "node:crypto";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { InvalidGrantError, InvalidTokenError, InvalidClientMetadataError, InvalidScopeError, InvalidTargetError } from "@modelcontextprotocol/sdk/server/auth/errors.js";

const scope = "realestate.read";
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

export function installPrivateAuth(app, { password, publicUrl }) {
  if (typeof password !== "string" || [...password].length < 12 || [...password].length > 128) {
    throw new Error("MCP_ACCESS_TOKEN에 12~128자의 개인 로그인 비밀번호를 설정하세요.");
  }
  const issuer = new URL(publicUrl);
  if (issuer.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(issuer.hostname)) throw new Error("MCP_PUBLIC_URL은 HTTPS 주소여야 합니다.");
  if (issuer.pathname !== "/" || issuer.search || issuer.hash || issuer.username || issuer.password) throw new Error("MCP_PUBLIC_URL에는 서버 기본 주소만 설정하세요.");
  const resource = new URL("/mcp", issuer).href;
  const encryptionKey = scryptSync(password, `realestate-mcp:${issuer.origin}`, 32);
  const passwordDigest = createHash("sha256").update(password).digest();
  const pending = new Map();
  const codes = new Map();
  const attempts = new Map();
  const now = () => Math.floor(Date.now() / 1000);
  const random = () => randomBytes(32).toString("base64url");
  const seal = (kind, data, seconds) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify({kind, data, exp: now() + seconds}), "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url");
  };
  const open = (token, kind) => {
    if (typeof token !== "string" || token.length > 16000 || !/^[A-Za-z0-9_-]+$/.test(token)) throw new Error("Invalid token");
    const bytes = Buffer.from(token, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    const payload = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8"));
    if (payload.kind !== kind || payload.exp <= now()) throw new Error("Expired token");
    return payload;
  };
  const validResource = r => { if (r && r.href !== resource) throw new InvalidTargetError("Invalid resource"); };
  const validScopes = s => { if (s?.some(x => x !== scope)) throw new InvalidScopeError("Only realestate.read is supported"); };
  const issueTokens = clientId => {
    const data = {clientId, scopes: [scope], resource};
    return {access_token: seal("access", data, 3600), token_type: "Bearer", expires_in: 3600, refresh_token: seal("refresh", data, 86400 * 30), scope};
  };
  const provider = {
    clientsStore: {
      getClient(clientId) { try { return {...open(clientId, "client").data, client_id: clientId}; } catch { return undefined; } },
      registerClient(client) {
        if (client.redirect_uris.length > 5 || client.redirect_uris.some(uri => {
          const u = new URL(uri);
          return !["https://chatgpt.com", "https://chat.openai.com"].includes(u.origin) || u.username || u.password || u.hash || uri.length > 2048;
        })) throw new InvalidClientMetadataError("Only ChatGPT HTTPS callback URLs are allowed");
        const data = {redirect_uris: client.redirect_uris, token_endpoint_auth_method: client.token_endpoint_auth_method,
          client_secret: client.client_secret, client_secret_expires_at: client.client_secret_expires_at,
          client_name: String(client.client_name || "ChatGPT").slice(0, 100), grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], scope};
        return {...data, client_id: seal("client", data, 86400 * 365), client_id_issued_at: now()};
      },
    },
    async authorize(client, params, res) {
      validResource(params.resource); validScopes(params.scopes);
      if (pending.size >= 1000) throw new InvalidGrantError("Please try again later");
      const id = random();
      pending.set(id, {clientId: client.client_id, name: client.client_name, ...params, expires: now() + 300, failures: 0});
      res.redirect(302, `/login?request=${id}`);
    },
    async challengeForAuthorizationCode(client, code) {
      const c = codes.get(code);
      if (!c || c.expires <= now() || c.clientId !== client.client_id) throw new InvalidGrantError("Invalid authorization code");
      return c.codeChallenge;
    },
    async exchangeAuthorizationCode(client, code, _verifier, redirectUri, target) {
      const c = codes.get(code);
      codes.delete(code);
      if (!c || c.expires <= now() || c.clientId !== client.client_id || redirectUri !== c.redirectUri) throw new InvalidGrantError("Invalid authorization code");
      validResource(target);
      return issueTokens(client.client_id);
    },
    async exchangeRefreshToken(client, token, scopes, target) {
      validResource(target); validScopes(scopes);
      let payload; try { payload = open(token, "refresh"); } catch { throw new InvalidGrantError("Invalid refresh token"); }
      if (payload.data.clientId !== client.client_id) throw new InvalidGrantError("Invalid refresh client");
      return issueTokens(client.client_id);
    },
    async verifyAccessToken(token) {
      try { const p = open(token, "access"); return {token, clientId: p.data.clientId, scopes: p.data.scopes, expiresAt: p.exp, resource: new URL(p.data.resource)}; }
      catch { throw new InvalidTokenError("Login required"); }
    },
  };
  const cleanup = setInterval(() => {
    for (const map of [pending, codes, attempts]) for (const [key, item] of map) if (item.expires <= now()) map.delete(key);
  }, 60000);
  cleanup.unref();
  const page = (id, error = "") => `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>아파트 실거래가 로그인</title><style>body{font:17px system-ui;background:#f3f6fa;padding:8vh 20px;color:#18304a}main{max-width:440px;margin:auto;background:white;padding:32px;border-radius:16px}input,button{box-sizing:border-box;width:100%;padding:13px;margin-top:12px;font:inherit}button{background:#176b5b;color:white;border:0;border-radius:8px}.error{color:#ac2030}</style><main><h1>아파트 실거래가</h1><p>ChatGPT 연결을 허용하려면 본인이 설정한 서버 비밀번호를 입력하세요.</p><p class="error">${escapeHtml(error)}</p><form method="post" action="/login"><input type="hidden" name="request" value="${id}"><label for="password">개인 비밀번호</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="256"><button type="submit">로그인하고 연결</button></form><p>공공데이터 인증키는 여기에 입력하지 않습니다.</p></main></html>`;
  app.use("/login", (_req, res, next) => {
    // no-referrer makes Chromium submit this form with Origin:null, rejecting valid logins.
    // Chromium also checks form-action on the successful 303 redirect to ChatGPT.
    res.set({"Cache-Control":"no-store", "Content-Security-Policy":"default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://chatgpt.com https://chat.openai.com; frame-ancestors 'none'; base-uri 'none'", "Referrer-Policy":"strict-origin", "X-Content-Type-Options":"nosniff"}); next();
  });
  app.get("/login", (req, res) => {
    const id = req.query.request;
    const ticket = pending.get(id);
    if (!ticket || ticket.expires <= now()) return res.status(400).send("로그인 요청이 만료됐습니다. ChatGPT에서 다시 연결하세요.");
    res.type("html").send(page(id));
  });
  app.post("/login", express.urlencoded({extended:false, limit:"4kb"}), (req, res) => {
    const id = req.body.request;
    const ticket = pending.get(id);
    if (!ticket || ticket.expires <= now()) return res.status(400).send("로그인 요청이 만료됐습니다. ChatGPT에서 다시 연결하세요.");
    const origin = req.get("origin");
    if (origin && origin !== issuer.origin) return res.status(403).send("허용되지 않은 요청입니다.");
    // 서버 전체 제한도 적용해 출발지 주소를 바꿔도 무제한 시도할 수 없게 한다.
    let record = attempts.get("global");
    if (!record || record.expires <= now()) { record = {count:0, expires:now()+900}; attempts.set("global", record); }
    if (record.count >= 30 || ticket.failures >= 5) return res.status(429).send("시도가 너무 많습니다. 잠시 후 다시 연결하세요.");
    const entered = typeof req.body.password === "string" ? req.body.password : "";
    const matches = timingSafeEqual(passwordDigest, createHash("sha256").update(entered).digest());
    if (!matches) { record.count++; ticket.failures++; return res.status(401).type("html").send(page(id, "비밀번호가 일치하지 않습니다.")); }
    pending.delete(id);
    const code = random();
    codes.set(code, {...ticket, expires:now()+120});
    const redirect = new URL(ticket.redirectUri);
    redirect.searchParams.set("code", code);
    if (ticket.state !== undefined) redirect.searchParams.set("state", ticket.state);
    res.redirect(303, redirect.href);
  });
  app.use(mcpAuthRouter({provider, issuerUrl:issuer, resourceServerUrl:new URL(resource), scopesSupported:[scope], resourceName:"개인 아파트 실거래가"}));
  app.use("/mcp", (_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  app.use("/mcp", requireBearerAuth({verifier:provider, requiredScopes:[scope], resourceMetadataUrl:getOAuthProtectedResourceMetadataUrl(new URL(resource))}));
  return provider;
}
