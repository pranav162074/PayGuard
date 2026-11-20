import { SignJWT } from "jose";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { signAccessToken } from "../src/auth/tokens.js";
import { bearer, refreshCookieFrom, signup, startTestApp, type TestApp } from "./helpers.js";

let t: TestApp;

afterEach(async () => {
  await t.close();
});

async function refresh(cookie: string, origin?: string) {
  const req = request(t.app).post("/v1/auth/refresh").set("Cookie", cookie);
  return origin ? req.set("Origin", origin) : req;
}

describe("signup", () => {
  it("creates the account, the merchant and an owner session", async () => {
    t = await startTestApp();

    const res = await request(t.app).post("/v1/auth/signup").send({
      email: "Ana@Example.com",
      password: "correct horse battery",
      name: "Ana",
      businessName: "Ana's Bakery",
    });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      tokenType: "Bearer",
      expiresIn: 900,
      user: { email: "ana@example.com", name: "Ana" },
      merchant: { name: "Ana's Bakery" },
      role: "owner",
    });
    const cookie = (res.headers["set-cookie"] as unknown as string[])[0];
    expect(cookie).toMatch(/^pg_refresh=[\w-]{43};/);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/v1/auth");

    const me = await request(t.app).get("/v1/me").set(bearer(res.body.accessToken));
    expect(me.body).toMatchObject({
      kind: "user",
      role: "owner",
      merchant: { name: "Ana's Bakery" },
    });
    expect(me.body.permissions).toContain("team:manage");
  });

  it("refuses a second account for the same email, whatever the case", async () => {
    t = await startTestApp();
    await signup(t.app, { email: "dup@example.com" });

    const again = await request(t.app).post("/v1/auth/signup").send({
      email: "DUP@example.com",
      password: "another long password",
      name: "Dup",
      businessName: "Dup Co",
    });

    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("email_taken");
  });

  it("lets only one of two simultaneous signups with one email through", async () => {
    t = await startTestApp();
    const body = {
      email: "race@example.com",
      password: "correct horse battery",
      name: "R",
      businessName: "Race",
    };

    const results = await Promise.all([
      request(t.app).post("/v1/auth/signup").send(body),
      request(t.app).post("/v1/auth/signup").send(body),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    // The transaction rolled back the loser's merchant too: no orphans
    expect(await t.app.locals.models.Merchant.countDocuments()).toBe(1);
  });

  it("names every invalid field", async () => {
    t = await startTestApp();

    const res = await request(t.app)
      .post("/v1/auth/signup")
      .send({ email: "not-an-email", password: "short", name: "", extra: true });

    expect(res.status).toBe(422);
    const fields = (res.body.error.details as { field: string }[]).map((d) => d.field);
    expect(fields).toEqual(expect.arrayContaining(["email", "password", "name", "businessName"]));
  });
});

describe("login", () => {
  it("logs in, and says nothing about whether the email exists", async () => {
    t = await startTestApp();
    const owner = await signup(t.app);

    const ok = await request(t.app)
      .post("/v1/auth/login")
      .send({ email: owner.email.toUpperCase(), password: owner.password });
    const wrongPassword = await request(t.app)
      .post("/v1/auth/login")
      .send({ email: owner.email, password: "wrong password!!" });
    const noSuchUser = await request(t.app)
      .post("/v1/auth/login")
      .send({ email: "ghost@example.com", password: "wrong password!!" });

    expect(ok.status).toBe(200);
    expect(ok.body.merchants).toEqual([
      { id: owner.merchantId, name: expect.any(String), role: "owner" },
    ]);
    expect(wrongPassword.status).toBe(401);
    expect(wrongPassword.body).toEqual(noSuchUser.body);
  });

  it("is rate limited per email", async () => {
    t = await startTestApp({
      config: {
        rateLimits: { apiPerMinute: 100, loginPerIp: 100, loginPerEmail: 3, signupPerIp: 100 },
      },
    });
    const attempt = () =>
      request(t.app)
        .post("/v1/auth/login")
        .send({ email: "victim@example.com", password: "guess" });

    const statuses = [];
    for (let i = 0; i < 4; i += 1) statuses.push((await attempt()).status);
    const blocked = await attempt();

    expect(statuses).toEqual([401, 401, 401, 429]);
    expect(blocked.headers["retry-after"]).toBeDefined();
    expect(blocked.body.error.code).toBe("rate_limited");
  });
});

describe("refresh tokens", () => {
  it("rotate: each refresh returns a new token and the old one stops working", async () => {
    t = await startTestApp();
    const owner = await signup(t.app);

    const first = await refresh(owner.cookie);
    const next = refreshCookieFrom(first);

    expect(first.status).toBe(200);
    expect(first.body.accessToken).toEqual(expect.any(String));
    expect(next).not.toBe(owner.cookie);
    expect((await refresh(next)).status).toBe(200);
  });

  it("revoke the whole session when an old token is reused (a stolen copy)", async () => {
    t = await startTestApp();
    const owner = await signup(t.app);
    const legit = refreshCookieFrom(await refresh(owner.cookie));

    // Someone replays the token the user already exchanged
    const replay = await refresh(owner.cookie);
    // ...and from then on even the user's current token is dead: log in again
    const afterwards = await refresh(legit);

    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe("invalid_session");
    expect(afterwards.status).toBe(401);
  });

  it("keep other sessions alive when one is revoked", async () => {
    t = await startTestApp();
    const owner = await signup(t.app);
    const laptop = await request(t.app)
      .post("/v1/auth/login")
      .send({ email: owner.email, password: owner.password });
    await refresh(owner.cookie);
    await refresh(owner.cookie); // reuse: kills the signup session only

    expect((await refresh(refreshCookieFrom(laptop))).status).toBe(200);
  });

  it("let only one of two simultaneous refreshes with the same token win", async () => {
    t = await startTestApp();
    const owner = await signup(t.app);

    const results = await Promise.all([refresh(owner.cookie), refresh(owner.cookie)]);

    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
  });

  it("don't extend the session: it ends a fixed time after login", async () => {
    t = await startTestApp();
    const owner = await signup(t.app);
    const { RefreshToken } = t.app.locals.models;
    const original = await RefreshToken.findOne().sort({ createdAt: 1 });

    await refresh(owner.cookie);
    const latest = await RefreshToken.findOne({ usedAt: null });

    expect(latest?.expiresAt.getTime()).toBe(original?.expiresAt.getTime());
  });

  it("need a cookie, and refuse requests from other sites", async () => {
    t = await startTestApp();
    const owner = await signup(t.app);

    const noCookie = await request(t.app).post("/v1/auth/refresh");
    const evil = await refresh(owner.cookie, "https://evil.example");
    const dashboard = await refresh(owner.cookie, "http://localhost:5173");

    expect(noCookie.status).toBe(401);
    expect(evil.status).toBe(403);
    expect(evil.body.error.code).toBe("forbidden_origin");
    expect(dashboard.status).toBe(200);
  });
});

describe("logout", () => {
  it("ends the session", async () => {
    t = await startTestApp();
    const owner = await signup(t.app);

    const res = await request(t.app).post("/v1/auth/logout").set("Cookie", owner.cookie);

    expect(res.status).toBe(204);
    expect((await refresh(owner.cookie)).status).toBe(401);
  });

  it("everywhere ends every session", async () => {
    t = await startTestApp();
    const owner = await signup(t.app);
    const other = await request(t.app)
      .post("/v1/auth/login")
      .send({ email: owner.email, password: owner.password });

    await request(t.app).post("/v1/auth/logout-all").set(bearer(owner.accessToken));

    expect((await refresh(owner.cookie)).status).toBe(401);
    expect((await refresh(refreshCookieFrom(other))).status).toBe(401);
  });
});

describe("access tokens", () => {
  it("are rejected if forged, tampered with, unsigned or expired", async () => {
    t = await startTestApp();
    const owner = await signup(t.app);
    const claims = {
      userId: owner.userId,
      merchantId: owner.merchantId,
      role: "owner" as const,
      sessionId: "s",
    };
    const forged = await signAccessToken(claims, "x".repeat(40), 900);
    const [header, payload, signature] = owner.accessToken.split(".") as [string, string, string];
    const promoted = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(payload, "base64url").toString()),
        role: "owner",
        mid: "000000000000000000000000",
      }),
    ).toString("base64url");
    const tampered = `${header}.${promoted}.${signature}`;
    const unsigned = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${payload}.`;
    const expired = await new SignJWT({ mid: owner.merchantId, role: "owner", sid: "s" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(owner.userId)
      .setIssuer("payguard")
      .setAudience("payguard-dashboard")
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(new TextEncoder().encode(t.config.jwtSecret));

    for (const token of [forged, tampered, unsigned, expired, "garbage"]) {
      const res = await request(t.app).get("/v1/me").set(bearer(token));
      expect(res.status).toBe(401);
    }
    expect((await request(t.app).get("/v1/me")).headers["www-authenticate"]).toBe("Bearer");
  });
});
