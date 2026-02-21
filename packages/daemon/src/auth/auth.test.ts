import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";

import { generateSecret, loadOrCreateSecret, createToken, verifyToken } from "./tokens";
import { checkPermission, checkScope } from "./policy";
import { AuthRateLimiter } from "./rate-limiter";
import {
  createAuthMiddleware,
  requirePermission,
  requireRateLimit,
} from "./middleware";
import { parseAuthConfig } from "./config";
import type { TokenClaims, TokenRole } from "./types";


// =============================================================================
// Tokens
// =============================================================================

describe("tokens", () => {
  const secret = generateSecret();

  test("generateSecret returns a 32-byte buffer", () => {
    const s = generateSecret();
    expect(s).toBeInstanceOf(Buffer);
    expect(s.length).toBe(32);
  });

  test("two generateSecret calls produce different values", () => {
    const a = generateSecret();
    const b = generateSecret();
    expect(a.equals(b)).toBe(false);
  });

  test("createToken produces a string with exactly one dot separator", () => {
    const token = createToken(secret, { sub: "test", scope: {}, role: "agent" }, 60);
    const dots = token.split(".").length - 1;
    expect(dots).toBe(1);
  });

  test("verifyToken succeeds with correct secret", () => {
    const token = createToken(secret, { sub: "u1", scope: {}, role: "operator" }, 60);
    const result = verifyToken(secret, token);
    expect(result.authenticated).toBe(true);
    expect(result.claims).not.toBeNull();
  });

  test("verifyToken fails with wrong secret", () => {
    const token = createToken(secret, { sub: "u1", scope: {}, role: "agent" }, 60);
    const other = generateSecret();
    const result = verifyToken(other, token);
    expect(result.authenticated).toBe(false);
    expect(result.error).toBe("invalid signature");
  });

  test("expired token is rejected", async () => {
    const token = createToken(secret, { sub: "u1", scope: {}, role: "agent" }, 1);
    // wait for the 1-second TTL to lapse
    await new Promise((r) => setTimeout(r, 1100));
    const result = verifyToken(secret, token);
    expect(result.authenticated).toBe(false);
    expect(result.error).toBe("token expired");
  });

  test("malformed token string is rejected", () => {
    const result = verifyToken(secret, "notavalidtoken");
    expect(result.authenticated).toBe(false);
    expect(result.error).toBe("malformed token");
  });

  test("token with trailing dot only is rejected", () => {
    const result = verifyToken(secret, "payload.");
    expect(result.authenticated).toBe(false);
  });

  test("token claims are correctly round-tripped", () => {
    const token = createToken(
      secret,
      { sub: "agent-42", scope: { project: "myproject" }, role: "agent" },
      300,
    );
    const result = verifyToken(secret, token);
    expect(result.authenticated).toBe(true);
    expect(result.claims?.sub).toBe("agent-42");
    expect(result.claims?.role).toBe("agent");
    expect(result.claims?.scope.project).toBe("myproject");
  });

  test("scope fields are all preserved through create/verify", () => {
    const scope = { project: "proj", agent: "bot", user: "alice" };
    const token = createToken(secret, { sub: "x", scope, role: "operator" }, 60);
    const result = verifyToken(secret, token);
    expect(result.claims?.scope).toEqual(scope);
  });

  test("empty scope object means full access (no scope fields set)", () => {
    const token = createToken(secret, { sub: "x", scope: {}, role: "agent" }, 60);
    const result = verifyToken(secret, token);
    expect(result.authenticated).toBe(true);
    const s = result.claims?.scope ?? {};
    expect(s.project).toBeUndefined();
    expect(s.agent).toBeUndefined();
    expect(s.user).toBeUndefined();
  });

  test.each(["admin", "operator", "agent", "readonly"] satisfies TokenRole[])(
    "token with role '%s' creates and verifies successfully",
    (role) => {
      const token = createToken(secret, { sub: "u", scope: {}, role }, 60);
      const result = verifyToken(secret, token);
      expect(result.authenticated).toBe(true);
      expect(result.claims?.role).toBe(role);
    },
  );

  describe("loadOrCreateSecret", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "signet-auth-test-"));
    });

    // cleanup is best-effort; test dirs are small and tmpdir is ephemeral
    test("creates file when missing and returns a buffer", () => {
      const path = join(tmpDir, "sub", "secret");
      const buf = loadOrCreateSecret(path);
      expect(buf).toBeInstanceOf(Buffer);
      expect(buf.length).toBe(32);
    });

    test("reads existing file rather than regenerating", () => {
      const path = join(tmpDir, "secret");
      const first = loadOrCreateSecret(path);
      const second = loadOrCreateSecret(path);
      expect(first.equals(second)).toBe(true);
    });
  });
});


// =============================================================================
// Policy
// =============================================================================

function makeClaims(role: TokenRole, scope = {}): TokenClaims {
  const now = Math.floor(Date.now() / 1000);
  return { sub: "test", scope, role, iat: now, exp: now + 3600 };
}

describe("policy - checkPermission", () => {
  test("local mode allows all operations without claims", () => {
    const decision = checkPermission(null, "admin", "local");
    expect(decision.allowed).toBe(true);
  });

  test("local mode allows operations even with valid claims", () => {
    const decision = checkPermission(makeClaims("readonly"), "admin", "local");
    expect(decision.allowed).toBe(true);
  });

  test("team mode rejects null claims", () => {
    const decision = checkPermission(null, "recall", "team");
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/authentication required/);
  });

  test("team mode allows admin all permissions", () => {
    const perms = ["remember", "recall", "modify", "forget", "recover", "admin", "documents", "connectors", "diagnostics"] as const;
    for (const perm of perms) {
      const d = checkPermission(makeClaims("admin"), perm, "team");
      expect(d.allowed).toBe(true);
    }
  });

  test("team mode allows operator all permissions except admin", () => {
    const allowed = ["remember", "recall", "modify", "forget", "recover", "documents", "connectors", "diagnostics"] as const;
    for (const perm of allowed) {
      const d = checkPermission(makeClaims("operator"), perm, "team");
      expect(d.allowed).toBe(true);
    }
    const denied = checkPermission(makeClaims("operator"), "admin", "team");
    expect(denied.allowed).toBe(false);
  });

  test("team mode allows agent only its permitted operations", () => {
    const agentAllowed = ["remember", "recall", "modify", "forget", "recover", "documents"] as const;
    for (const perm of agentAllowed) {
      const d = checkPermission(makeClaims("agent"), perm, "team");
      expect(d.allowed).toBe(true);
    }
  });

  test("team mode denies agent connectors permission", () => {
    const d = checkPermission(makeClaims("agent"), "connectors", "team");
    expect(d.allowed).toBe(false);
  });

  test("team mode denies agent diagnostics permission", () => {
    const d = checkPermission(makeClaims("agent"), "diagnostics", "team");
    expect(d.allowed).toBe(false);
  });

  test("team mode denies agent admin permission", () => {
    const d = checkPermission(makeClaims("agent"), "admin", "team");
    expect(d.allowed).toBe(false);
  });

  test("team mode allows readonly only recall", () => {
    const d = checkPermission(makeClaims("readonly"), "recall", "team");
    expect(d.allowed).toBe(true);
    const denied = checkPermission(makeClaims("readonly"), "remember", "team");
    expect(denied.allowed).toBe(false);
  });

  test("hybrid mode with claims delegates same logic as team", () => {
    // readonly should be denied 'remember' in hybrid, same as team
    const d = checkPermission(makeClaims("readonly"), "remember", "hybrid");
    expect(d.allowed).toBe(false);
    // admin should be allowed everything
    const a = checkPermission(makeClaims("admin"), "admin", "hybrid");
    expect(a.allowed).toBe(true);
  });

  test("hybrid mode with null claims denies (token required for non-localhost)", () => {
    const d = checkPermission(null, "recall", "hybrid");
    expect(d.allowed).toBe(false);
  });
});

describe("policy - checkScope", () => {
  test("local mode with null claims bypasses scope check", () => {
    const d = checkScope(null, { project: "any" }, "local");
    expect(d.allowed).toBe(true);
  });

  test("team mode rejects null claims", () => {
    const d = checkScope(null, { project: "any" }, "team");
    expect(d.allowed).toBe(false);
  });

  test("admin role bypasses scope restrictions", () => {
    const claims = makeClaims("admin", { project: "proj-a" });
    const d = checkScope(claims, { project: "proj-b" }, "team");
    expect(d.allowed).toBe(true);
  });

  test("matching project scope allows operation", () => {
    const claims = makeClaims("agent", { project: "proj-a" });
    const d = checkScope(claims, { project: "proj-a" }, "team");
    expect(d.allowed).toBe(true);
  });

  test("mismatched project scope denies operation", () => {
    const claims = makeClaims("agent", { project: "proj-a" });
    const d = checkScope(claims, { project: "proj-b" }, "team");
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/proj-a/);
  });

  test("empty scope object means full access", () => {
    const claims = makeClaims("agent", {});
    const d = checkScope(claims, { project: "anything" }, "team");
    expect(d.allowed).toBe(true);
  });

  test("mismatched agent scope denies", () => {
    const claims = makeClaims("operator", { agent: "bot-1" });
    const d = checkScope(claims, { agent: "bot-2" }, "team");
    expect(d.allowed).toBe(false);
  });

  test("mismatched user scope denies", () => {
    const claims = makeClaims("operator", { user: "alice" });
    const d = checkScope(claims, { user: "bob" }, "team");
    expect(d.allowed).toBe(false);
  });

  test("scope check passes when target has no matching dimension", () => {
    // token scoped to project-a, target has no project field
    const claims = makeClaims("agent", { project: "proj-a" });
    const d = checkScope(claims, {}, "team");
    expect(d.allowed).toBe(true);
  });
});


// =============================================================================
// Rate Limiter
// =============================================================================

describe("AuthRateLimiter", () => {
  let limiter: AuthRateLimiter;

  beforeEach(() => {
    limiter = new AuthRateLimiter(5000, 3);
  });

  test("first check with no records returns full remaining", () => {
    const result = limiter.check("key1");
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(3);
  });

  test("allows requests under the limit", () => {
    limiter.record("key1");
    limiter.record("key1");
    const result = limiter.check("key1");
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(1);
  });

  test("denies requests when limit is reached", () => {
    limiter.record("key1");
    limiter.record("key1");
    limiter.record("key1");
    const result = limiter.check("key1");
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  test("different keys have independent counters", () => {
    limiter.record("key1");
    limiter.record("key1");
    limiter.record("key1");
    const result = limiter.check("key2");
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(3);
  });

  test("returns correct remaining count after records", () => {
    limiter.record("k");
    const r = limiter.check("k");
    expect(r.remaining).toBe(2);
  });

  test("returns a resetAt timestamp in the future", () => {
    const before = Date.now();
    limiter.record("k");
    const r = limiter.check("k");
    expect(r.resetAt).toBeGreaterThan(before);
  });

  test("reset() clears all state so keys are fresh again", () => {
    limiter.record("key1");
    limiter.record("key1");
    limiter.record("key1");
    limiter.reset();
    const result = limiter.check("key1");
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(3);
  });

  test("window resets after expiry", async () => {
    const shortLimiter = new AuthRateLimiter(50, 2);
    shortLimiter.record("k");
    shortLimiter.record("k");
    // exhausted
    expect(shortLimiter.check("k").allowed).toBe(false);
    // wait for window to expire
    await new Promise((r) => setTimeout(r, 80));
    const result = shortLimiter.check("k");
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(2);
  });
});


// =============================================================================
// Middleware integration tests
// =============================================================================

const teamConfig = { mode: "team" as const, secretPath: "", rateLimits: {}, defaultTokenTtlSeconds: 3600, sessionTokenTtlSeconds: 3600 };
const localConfig = { mode: "local" as const, secretPath: "", rateLimits: {}, defaultTokenTtlSeconds: 3600, sessionTokenTtlSeconds: 3600 };
const hybridConfig = { mode: "hybrid" as const, secretPath: "", rateLimits: {}, defaultTokenTtlSeconds: 3600, sessionTokenTtlSeconds: 3600 };

function makeTestApp(middleware: ReturnType<typeof createAuthMiddleware>, extraMiddleware?: Parameters<Hono["use"]>[1]) {
  const app = new Hono();
  app.use("*", middleware);
  if (extraMiddleware) {
    app.use("*", extraMiddleware);
  }
  app.get("/test", (c) => c.json({ ok: true }));
  return app;
}

describe("middleware - createAuthMiddleware", () => {
  const secret = generateSecret();

  test("local mode: no Authorization header needed, returns 200", async () => {
    const app = makeTestApp(createAuthMiddleware(localConfig, null));
    const res = await app.request(new Request("http://localhost/test"));
    expect(res.status).toBe(200);
  });

  test("team mode: missing token returns 401", async () => {
    const app = makeTestApp(createAuthMiddleware(teamConfig, secret));
    const res = await app.request(new Request("http://localhost/test"));
    expect(res.status).toBe(401);
  });

  test("team mode: invalid token returns 401", async () => {
    const app = makeTestApp(createAuthMiddleware(teamConfig, secret));
    const res = await app.request(
      new Request("http://localhost/test", {
        headers: { Authorization: "Bearer notavalidtoken" },
      }),
    );
    expect(res.status).toBe(401);
  });

  test("team mode: valid token passes through, returns 200", async () => {
    const app = makeTestApp(createAuthMiddleware(teamConfig, secret));
    const token = createToken(secret, { sub: "u", scope: {}, role: "agent" }, 60);
    const res = await app.request(
      new Request("http://localhost/test", {
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(200);
  });

  test("team mode: expired token returns 401", async () => {
    const app = makeTestApp(createAuthMiddleware(teamConfig, secret));
    const token = createToken(secret, { sub: "u", scope: {}, role: "agent" }, 1);
    await new Promise((r) => setTimeout(r, 1100));
    const res = await app.request(
      new Request("http://localhost/test", {
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(401);
  });

  test("hybrid mode: localhost request without token passes", async () => {
    const app = makeTestApp(createAuthMiddleware(hybridConfig, secret));
    // hono reads 'host' header — set to localhost to simulate local request
    const res = await app.request(
      new Request("http://localhost/test", {
        headers: { host: "localhost:3850" },
      }),
    );
    expect(res.status).toBe(200);
  });

  test("hybrid mode: request with valid token also passes", async () => {
    const app = makeTestApp(createAuthMiddleware(hybridConfig, secret));
    const token = createToken(secret, { sub: "u", scope: {}, role: "admin" }, 60);
    const res = await app.request(
      new Request("http://localhost/test", {
        headers: {
          host: "localhost:3850",
          Authorization: `Bearer ${token}`,
        },
      }),
    );
    expect(res.status).toBe(200);
  });
});

describe("middleware - requirePermission", () => {
  const secret = generateSecret();

  function makePermApp(permission: Parameters<typeof requirePermission>[0]) {
    const app = new Hono();
    app.use("*", createAuthMiddleware(teamConfig, secret));
    app.use("*", requirePermission(permission, teamConfig));
    app.get("/test", (c) => c.json({ ok: true }));
    return app;
  }

  test("admin can access admin routes", async () => {
    const app = makePermApp("admin");
    const token = createToken(secret, { sub: "u", scope: {}, role: "admin" }, 60);
    const res = await app.request(
      new Request("http://localhost/test", {
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(200);
  });

  test("agent cannot access admin routes, returns 403", async () => {
    const app = makePermApp("admin");
    const token = createToken(secret, { sub: "u", scope: {}, role: "agent" }, 60);
    const res = await app.request(
      new Request("http://localhost/test", {
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(403);
  });

  test("readonly can recall", async () => {
    const app = makePermApp("recall");
    const token = createToken(secret, { sub: "u", scope: {}, role: "readonly" }, 60);
    const res = await app.request(
      new Request("http://localhost/test", {
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(200);
  });

  test("readonly cannot remember, returns 403", async () => {
    const app = makePermApp("remember");
    const token = createToken(secret, { sub: "u", scope: {}, role: "readonly" }, 60);
    const res = await app.request(
      new Request("http://localhost/test", {
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(403);
  });
});

describe("middleware - requireRateLimit", () => {
  const secret = generateSecret();

  function makeRateLimitApp(windowMs: number, max: number) {
    const limiter = new AuthRateLimiter(windowMs, max);
    const app = new Hono();
    app.use("*", createAuthMiddleware(teamConfig, secret));
    app.use("*", requireRateLimit("testOp", limiter, teamConfig));
    app.get("/test", (c) => c.json({ ok: true }));
    return app;
  }

  function bearerHeader(token: string) {
    return { Authorization: `Bearer ${token}` };
  }

  test("allows requests under limit", async () => {
    const app = makeRateLimitApp(5000, 5);
    const token = createToken(secret, { sub: "u", scope: {}, role: "agent" }, 60);
    const res = await app.request(
      new Request("http://localhost/test", { headers: bearerHeader(token) }),
    );
    expect(res.status).toBe(200);
  });

  test("returns 429 when limit exceeded with Retry-After header", async () => {
    const app = makeRateLimitApp(5000, 1);
    const token = createToken(secret, { sub: "u2", scope: {}, role: "agent" }, 60);
    const headers = bearerHeader(token);
    // first request consumes the only slot
    await app.request(new Request("http://localhost/test", { headers }));
    // second should be rate limited
    const res = await app.request(new Request("http://localhost/test", { headers }));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).not.toBeNull();
  });

  test("local mode skips rate limiting entirely", async () => {
    const limiter = new AuthRateLimiter(5000, 1);
    const app = new Hono();
    app.use("*", createAuthMiddleware(localConfig, null));
    app.use("*", requireRateLimit("testOp", limiter, localConfig));
    app.get("/test", (c) => c.json({ ok: true }));

    // exhaust what would be the limit
    await app.request(new Request("http://localhost/test"));
    const res = await app.request(new Request("http://localhost/test"));
    // local mode should still return 200
    expect(res.status).toBe(200);
  });
});


// =============================================================================
// Config
// =============================================================================

describe("parseAuthConfig", () => {
  const agentsDir = "/home/test/.agents";

  test("returns defaults for undefined input", () => {
    const cfg = parseAuthConfig(undefined, agentsDir);
    expect(cfg.mode).toBe("local");
    expect(cfg.secretPath).toContain(".daemon");
    expect(cfg.defaultTokenTtlSeconds).toBeGreaterThan(0);
    expect(cfg.sessionTokenTtlSeconds).toBeGreaterThan(0);
  });

  test("returns defaults for null input", () => {
    const cfg = parseAuthConfig(null, agentsDir);
    expect(cfg.mode).toBe("local");
  });

  test("parses valid mode from object", () => {
    const cfg = parseAuthConfig({ mode: "team" }, agentsDir);
    expect(cfg.mode).toBe("team");
  });

  test("parses hybrid mode", () => {
    const cfg = parseAuthConfig({ mode: "hybrid" }, agentsDir);
    expect(cfg.mode).toBe("hybrid");
  });

  test("invalid mode falls back to 'local'", () => {
    const cfg = parseAuthConfig({ mode: "superuser" }, agentsDir);
    expect(cfg.mode).toBe("local");
  });

  test("rate limits parse correctly", () => {
    const cfg = parseAuthConfig(
      { mode: "team", rateLimits: { forget: { windowMs: 30000, max: 10 } } },
      agentsDir,
    );
    expect(cfg.rateLimits.forget.windowMs).toBe(30000);
    expect(cfg.rateLimits.forget.max).toBe(10);
  });

  test("invalid rate limit values fall back to defaults", () => {
    const cfg = parseAuthConfig(
      { mode: "team", rateLimits: { forget: { windowMs: -1, max: 0 } } },
      agentsDir,
    );
    // defaults are windowMs: 60_000, max: 30
    expect(cfg.rateLimits.forget.windowMs).toBe(60_000);
    expect(cfg.rateLimits.forget.max).toBe(30);
  });

  test("custom TTL values are parsed", () => {
    const cfg = parseAuthConfig(
      { defaultTokenTtlSeconds: 1000, sessionTokenTtlSeconds: 500 },
      agentsDir,
    );
    expect(cfg.defaultTokenTtlSeconds).toBe(1000);
    expect(cfg.sessionTokenTtlSeconds).toBe(500);
  });

  test("non-positive TTL falls back to default", () => {
    const cfg = parseAuthConfig(
      { defaultTokenTtlSeconds: 0, sessionTokenTtlSeconds: -5 },
      agentsDir,
    );
    expect(cfg.defaultTokenTtlSeconds).toBeGreaterThan(0);
    expect(cfg.sessionTokenTtlSeconds).toBeGreaterThan(0);
  });
});
