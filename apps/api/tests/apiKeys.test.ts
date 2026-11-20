import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { addMember, bearer, signup, startTestApp, type TestApp } from "./helpers.js";

let t: TestApp;

afterEach(async () => {
  await t.close();
});

async function createKey(token: string, mode: "test" | "live" = "test", name = "Server") {
  return request(t.app).post("/v1/api-keys").set(bearer(token)).send({ name, mode });
}

describe("API keys", () => {
  it("are shown once and stored only as a hash", async () => {
    t = await startTestApp();
    const owner = await signup(t.app);

    const created = await createKey(owner.accessToken, "live");
    const listed = await request(t.app).get("/v1/api-keys").set(bearer(owner.accessToken));
    const stored = await t.app.locals.models.ApiKey.findOne().lean();

    expect(created.status).toBe(201);
    expect(created.body.key).toMatch(/^sk_live_[\w-]{43}$/);
    expect(created.body.prefix).toBe(created.body.key.slice(0, 12));
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0].key).toBeUndefined();
    expect(JSON.stringify(stored)).not.toContain(created.body.key);
  });

  it("authenticate server-to-server calls for their merchant and mode", async () => {
    t = await startTestApp();
    const owner = await signup(t.app);
    const { key } = (await createKey(owner.accessToken, "test")).body;

    const me = await request(t.app).get("/v1/me").set(bearer(key));

    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({
      kind: "api_key",
      mode: "test",
      merchant: { id: owner.merchantId },
    });
    expect(me.body.permissions).toEqual(["payments:read", "payments:write"]);
    const stored = await t.app.locals.models.ApiKey.findOne().lean();
    expect(stored?.lastUsedAt).toBeInstanceOf(Date);
  });

  it("can't manage the account", async () => {
    t = await startTestApp();
    const owner = await signup(t.app);
    const { key } = (await createKey(owner.accessToken)).body;

    const makeKey = await createKey(key);
    const team = await request(t.app).get("/v1/team").set(bearer(key));

    expect(makeKey.status).toBe(403);
    expect(team.status).toBe(403);
  });

  it("stop working once revoked", async () => {
    t = await startTestApp();
    const owner = await signup(t.app);
    const created = (await createKey(owner.accessToken)).body;

    const revoked = await request(t.app)
      .delete(`/v1/api-keys/${created.id}`)
      .set(bearer(owner.accessToken));
    const again = await request(t.app)
      .delete(`/v1/api-keys/${created.id}`)
      .set(bearer(owner.accessToken));

    expect(revoked.status).toBe(204);
    expect(again.status).toBe(404);
    expect((await request(t.app).get("/v1/me").set(bearer(created.key))).status).toBe(401);
  });

  it("are managed by owners and developers, not analysts", async () => {
    t = await startTestApp();
    const owner = await signup(t.app);
    const developer = await addMember(t.app, owner, "developer");
    const analyst = await addMember(t.app, owner, "analyst");

    expect((await createKey(developer.accessToken)).status).toBe(201);
    expect((await createKey(analyst.accessToken)).status).toBe(403);
    expect((await request(t.app).get("/v1/api-keys").set(bearer(analyst.accessToken))).status).toBe(
      403,
    );
  });

  it("belong to one merchant", async () => {
    t = await startTestApp();
    const shopA = await signup(t.app);
    const shopB = await signup(t.app);
    const keyOfB = (await createKey(shopB.accessToken)).body;

    const list = await request(t.app).get("/v1/api-keys").set(bearer(shopA.accessToken));
    const revoke = await request(t.app)
      .delete(`/v1/api-keys/${keyOfB.id}`)
      .set(bearer(shopA.accessToken));

    expect(list.body).toEqual([]);
    expect(revoke.status).toBe(404);
    expect((await request(t.app).get("/v1/me").set(bearer(keyOfB.key))).status).toBe(200);
  });

  it("reject malformed and unknown keys", async () => {
    t = await startTestApp();

    for (const key of ["sk_test_short", "sk_prod_" + "a".repeat(43), "sk_test_" + "a".repeat(43)]) {
      expect((await request(t.app).get("/v1/me").set(bearer(key))).status).toBe(401);
    }
  });

  it("are rate limited per key", async () => {
    t = await startTestApp({
      config: {
        rateLimits: { apiPerMinute: 3, loginPerIp: 100, loginPerEmail: 100, signupPerIp: 100 },
      },
    });
    const owner = await signup(t.app);
    const { key } = (await createKey(owner.accessToken)).body;

    const statuses = [];
    for (let i = 0; i < 4; i += 1)
      statuses.push((await request(t.app).get("/v1/me").set(bearer(key))).status);

    expect(statuses).toEqual([200, 200, 200, 429]);
  });
});
