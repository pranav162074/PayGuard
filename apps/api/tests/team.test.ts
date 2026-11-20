import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import {
  addMember,
  bearer,
  refreshCookieFrom,
  signup,
  startTestApp,
  type TestApp,
} from "./helpers.js";

let t: TestApp;

afterEach(async () => {
  await t.close();
});

describe("invitations", () => {
  it("a new person accepts and joins with the invited role", async () => {
    t = await startTestApp();
    const owner = await signup(t.app);

    const analyst = await addMember(t.app, owner, "analyst");
    const team = await request(t.app).get("/v1/team").set(bearer(owner.accessToken));

    expect(analyst.merchantId).toBe(owner.merchantId);
    expect(team.body.members.map((m: { role: string }) => m.role)).toEqual(["owner", "analyst"]);
    expect(team.body.invitations).toEqual([]);
  });

  it("an existing account joins a second merchant by proving its password", async () => {
    t = await startTestApp();
    const shopA = await signup(t.app);
    const shopB = await signup(t.app);
    const invite = await request(t.app)
      .post("/v1/team/invitations")
      .set(bearer(shopB.accessToken))
      .send({ email: shopA.email, role: "developer" });

    const wrong = await request(t.app)
      .post("/v1/auth/accept-invitation")
      .send({ token: invite.body.token, password: "not their password" });
    const right = await request(t.app)
      .post("/v1/auth/accept-invitation")
      .send({ token: invite.body.token, password: shopA.password });
    const login = await request(t.app)
      .post("/v1/auth/login")
      .send({ email: shopA.email, password: shopA.password, merchantId: shopB.merchantId });

    expect(wrong.status).toBe(401);
    expect(right.status).toBe(201);
    expect(login.body.role).toBe("developer");
    expect(login.body.merchants).toHaveLength(2);
  });

  it("can be used once, and not after it's revoked or expired", async () => {
    t = await startTestApp();
    const owner = await signup(t.app);
    const invite = (email: string) =>
      request(t.app)
        .post("/v1/team/invitations")
        .set(bearer(owner.accessToken))
        .send({ email, role: "analyst" });
    const accept = (token: string, name = "X") =>
      request(t.app)
        .post("/v1/auth/accept-invitation")
        .send({ token, password: "long enough password", name });

    const once = await invite("once@example.com");
    const revoked = await invite("revoked@example.com");
    const expired = await invite("expired@example.com");
    await request(t.app)
      .delete(`/v1/team/invitations/${revoked.body.invitation.id}`)
      .set(bearer(owner.accessToken));
    await t.app.locals.models.Invitation.updateOne(
      { email: "expired@example.com" },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );

    const results = await Promise.all([accept(once.body.token), accept(once.body.token)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 404]);
    expect((await accept(revoked.body.token)).status).toBe(404);
    expect((await accept(expired.body.token)).status).toBe(404);
  });

  it("refuses duplicates and existing members", async () => {
    t = await startTestApp();
    const owner = await signup(t.app);
    const member = await addMember(t.app, owner, "analyst");
    const invite = (email: string) =>
      request(t.app)
        .post("/v1/team/invitations")
        .set(bearer(owner.accessToken))
        .send({ email, role: "analyst" });

    await invite("pending@example.com");

    expect((await invite("pending@example.com")).body.error.code).toBe("invitation_exists");
    expect((await invite(member.email)).body.error.code).toBe("already_member");
  });
});

describe("roles", () => {
  it("only owners manage the team", async () => {
    t = await startTestApp();
    const owner = await signup(t.app);
    const developer = await addMember(t.app, owner, "developer");
    const analyst = await addMember(t.app, owner, "analyst");

    for (const member of [developer, analyst]) {
      const res = await request(t.app)
        .post("/v1/team/invitations")
        .set(bearer(member.accessToken))
        .send({ email: "x@example.com", role: "owner" });
      expect(res.status).toBe(403);
      // Everyone can see the team, though
      expect((await request(t.app).get("/v1/team").set(bearer(member.accessToken))).status).toBe(
        200,
      );
    }
  });

  it("a role change shows up at the member's next refresh", async () => {
    t = await startTestApp();
    const owner = await signup(t.app);
    const member = await addMember(t.app, owner, "analyst");

    await request(t.app)
      .patch(`/v1/team/members/${member.userId}`)
      .set(bearer(owner.accessToken))
      .send({ role: "developer" });
    const refreshed = await request(t.app).post("/v1/auth/refresh").set("Cookie", member.cookie);
    const me = await request(t.app).get("/v1/me").set(bearer(refreshed.body.accessToken));

    expect(me.body.role).toBe("developer");
  });

  it("the last owner can't be demoted or removed", async () => {
    t = await startTestApp();
    const owner = await signup(t.app);

    const demote = await request(t.app)
      .patch(`/v1/team/members/${owner.userId}`)
      .set(bearer(owner.accessToken))
      .send({ role: "analyst" });
    const remove = await request(t.app)
      .delete(`/v1/team/members/${owner.userId}`)
      .set(bearer(owner.accessToken));

    expect(demote.status).toBe(409);
    expect(demote.body.error.code).toBe("last_owner");
    expect(remove.status).toBe(409);
  });

  it("two owners demoting each other at once can't leave zero owners", async () => {
    t = await startTestApp();
    const alice = await signup(t.app);
    const bob = await addMember(t.app, alice, "owner");

    const results = await Promise.all([
      request(t.app)
        .patch(`/v1/team/members/${bob.userId}`)
        .set(bearer(alice.accessToken))
        .send({ role: "analyst" }),
      request(t.app)
        .patch(`/v1/team/members/${alice.userId}`)
        .set(bearer(bob.accessToken))
        .send({ role: "analyst" }),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const owners = await t.app.locals.models.Membership.countDocuments({ role: "owner" });
    expect(owners).toBe(1);
  });

  it("removing a member logs them out", async () => {
    t = await startTestApp();
    const owner = await signup(t.app);
    const member = await addMember(t.app, owner, "developer");

    const removed = await request(t.app)
      .delete(`/v1/team/members/${member.userId}`)
      .set(bearer(owner.accessToken));
    const refresh = await request(t.app).post("/v1/auth/refresh").set("Cookie", member.cookie);

    expect(removed.status).toBe(204);
    expect(refresh.status).toBe(401);
  });

  it("can't touch another merchant's members", async () => {
    t = await startTestApp();
    const shopA = await signup(t.app);
    const shopB = await signup(t.app);

    const res = await request(t.app)
      .delete(`/v1/team/members/${shopB.userId}`)
      .set(bearer(shopA.accessToken));
    const bogus = await request(t.app)
      .delete("/v1/team/members/not-an-id")
      .set(bearer(shopA.accessToken));

    expect(res.status).toBe(404);
    expect(bogus.status).toBe(404);
    expect(
      refreshCookieFrom(await request(t.app).post("/v1/auth/refresh").set("Cookie", shopB.cookie)),
    ).toBeTruthy();
  });
});
