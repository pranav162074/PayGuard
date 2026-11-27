import { Router } from "express";
import { z } from "zod";

import { ApiError } from "../errors.js";
import { authenticate, requirePermission, userOf } from "../middleware/auth.js";
import { KEY_MODES } from "../models/index.js";
import { newId } from "../payments/models.js";
import { jobOptions, replayDelivery } from "../webhooks/delivery.js";
import {
  DELIVERY_STATUSES,
  EVENT_TYPES,
  type WebhookDelivery,
  type WebhookEndpoint,
} from "../webhooks/models.js";
import { generateSecret, SecretBox } from "../webhooks/signing.js";
import { checkWebhookUrl, UnsafeUrlError } from "../webhooks/ssrf.js";
import { parse } from "../validation.js";
import type { RouteDeps } from "./deps.js";

const MAX_ENDPOINTS_PER_MODE = 16;
const MAX_ROTATION_GRACE_HOURS = 7 * 24;
const MAX_BULK_REPLAY = 1000;

const events = z
  .array(z.enum([...EVENT_TYPES, "*"]))
  .min(1)
  .max(EVENT_TYPES.length + 1)
  .transform((list) => [...new Set(list)]);

const createBody = z.strictObject({
  url: z.string().max(2048),
  enabled_events: events,
  description: z.string().max(500).optional(),
  mode: z.enum(KEY_MODES).default("test"),
});

const updateBody = z
  .strictObject({
    url: z.string().max(2048).optional(),
    enabled_events: events.optional(),
    description: z.string().max(500).nullable().optional(),
    status: z.enum(["enabled", "disabled"]).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, "Nothing to change");

const rotateBody = z.strictObject({
  // How long the old secret keeps signing too, so receivers can switch without a gap
  expire_previous_in_hours: z.number().int().min(0).max(MAX_ROTATION_GRACE_HOURS).default(24),
});

const deliveryQuery = z.object({
  endpoint: z.string().optional(),
  status: z.enum(DELIVERY_STATUSES).optional(),
  event: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  starting_after: z.string().optional(),
});

function endpointJson(endpoint: WebhookEndpoint) {
  return {
    id: endpoint._id,
    object: "webhook_endpoint",
    url: endpoint.url,
    description: endpoint.description,
    enabled_events: endpoint.enabledEvents,
    status: endpoint.status,
    mode: endpoint.mode,
    // When the previous secret, after a rotation, stops signing
    previous_secret_expires_at:
      endpoint.secrets.find((s) => s.expiresAt && s.expiresAt > new Date())?.expiresAt ?? null,
    created_at: endpoint.createdAt,
    updated_at: endpoint.updatedAt,
  };
}

function deliveryJson(delivery: WebhookDelivery, withAttempts = false) {
  return {
    id: delivery._id,
    object: "webhook_delivery",
    endpoint: delivery.endpointId,
    event: delivery.eventId,
    event_type: delivery.eventType,
    status: delivery.status,
    attempt_count: delivery.attemptCount,
    next_attempt_at: delivery.nextAttemptAt,
    last_attempt_at: delivery.lastAttemptAt,
    succeeded_at: delivery.succeededAt,
    replays: delivery.replays,
    last_response: delivery.attempts.at(-1) ?? null,
    ...(withAttempts
      ? {
          attempts: delivery.attempts.map((a) => ({
            at: a.at,
            status_code: a.statusCode,
            duration_ms: a.durationMs,
            error: a.error,
            response_body: a.responseBody,
          })),
        }
      : {}),
    created_at: delivery.createdAt,
  };
}

export function webhookEndpointsRouter(deps: RouteDeps): Router {
  const { models, config, webhooks } = deps;
  const router = Router();
  router.use(["/v1/webhook_endpoints", "/v1/webhook_deliveries"], authenticate(deps));
  const box = new SecretBox(config.webhooks.secretsKey);

  async function checkUrl(raw: string): Promise<string> {
    try {
      const url = await checkWebhookUrl(raw, {
        production: config.nodeEnv === "production",
        allowPrivate: config.webhooks.allowPrivateUrls,
        lookup: deps.lookup,
      });
      return url.toString();
    } catch (err) {
      if (err instanceof UnsafeUrlError) {
        throw new ApiError(422, "invalid_url", `This URL can't receive webhooks: ${err.message}`);
      }
      throw err;
    }
  }

  async function load(merchantId: string, id: string | string[] | undefined) {
    const endpoint =
      typeof id === "string"
        ? await models.WebhookEndpoint.findOne({ _id: id, merchantId }).lean<WebhookEndpoint>()
        : null;
    if (!endpoint) throw new ApiError(404, "not_found", "Webhook endpoint not found");
    return endpoint;
  }

  router.post("/v1/webhook_endpoints", requirePermission("webhooks:manage"), async (req, res) => {
    const { merchantId } = userOf(req);
    const body = parse(createBody, req.body);
    const url = await checkUrl(body.url);
    const count = await models.WebhookEndpoint.countDocuments({ merchantId, mode: body.mode });
    if (count >= MAX_ENDPOINTS_PER_MODE) {
      throw new ApiError(
        409,
        "too_many_endpoints",
        `At most ${MAX_ENDPOINTS_PER_MODE} endpoints per mode`,
      );
    }
    const secret = generateSecret();
    const endpoint = await models.WebhookEndpoint.create({
      merchantId,
      mode: body.mode,
      url,
      description: body.description ?? null,
      enabledEvents: body.enabled_events,
      secrets: [{ encrypted: box.encrypt(secret), createdAt: new Date() }],
    });
    // The only time the secret is shown (until it's rotated)
    res.status(201).json({ ...endpointJson(endpoint.toObject()), secret });
  });

  router.get("/v1/webhook_endpoints", requirePermission("webhooks:read"), async (req, res) => {
    const { merchantId } = userOf(req);
    const rows = await models.WebhookEndpoint.find({ merchantId })
      .sort({ createdAt: -1, _id: -1 })
      .lean<WebhookEndpoint[]>();
    res.json({ object: "list", data: rows.map(endpointJson) });
  });

  router.get("/v1/webhook_endpoints/:id", requirePermission("webhooks:read"), async (req, res) => {
    res.json(endpointJson(await load(userOf(req).merchantId, req.params.id)));
  });

  router.patch(
    "/v1/webhook_endpoints/:id",
    requirePermission("webhooks:manage"),
    async (req, res) => {
      const { merchantId } = userOf(req);
      const endpoint = await load(merchantId, req.params.id);
      const body = parse(updateBody, req.body);
      const set: Record<string, unknown> = {};
      if (body.url !== undefined) set.url = await checkUrl(body.url);
      if (body.enabled_events !== undefined) set.enabledEvents = body.enabled_events;
      if (body.description !== undefined) set.description = body.description;
      if (body.status !== undefined) set.status = body.status;
      const updated = await models.WebhookEndpoint.findOneAndUpdate(
        { _id: endpoint._id, merchantId },
        { $set: set },
        { returnDocument: "after" },
      ).lean<WebhookEndpoint>();
      if (!updated) throw new ApiError(404, "not_found", "Webhook endpoint not found");
      res.json(endpointJson(updated));
    },
  );

  router.delete(
    "/v1/webhook_endpoints/:id",
    requirePermission("webhooks:manage"),
    async (req, res) => {
      const { merchantId } = userOf(req);
      const endpoint = await load(merchantId, req.params.id);
      // Its queued deliveries find it gone and stop; the delivery logs stay until they expire
      await models.WebhookEndpoint.deleteOne({ _id: endpoint._id, merchantId });
      res.status(204).end();
    },
  );

  router.post(
    "/v1/webhook_endpoints/:id/rotate_secret",
    requirePermission("webhooks:manage"),
    async (req, res) => {
      const { merchantId } = userOf(req);
      const endpoint = await load(merchantId, req.params.id);
      const body = parse(rotateBody, req.body ?? {});
      const now = new Date();
      const expiresAt = new Date(now.getTime() + body.expire_previous_in_hours * 3600_000);
      const current = endpoint.secrets.find((s) => !s.expiresAt);
      const secret = generateSecret();
      const secrets = [
        // Only the one being replaced stays, and only for the grace period
        ...(current && body.expire_previous_in_hours > 0
          ? [{ encrypted: current.encrypted, createdAt: current.createdAt, expiresAt }]
          : []),
        { encrypted: box.encrypt(secret), createdAt: now, expiresAt: null },
      ];
      const updated = await models.WebhookEndpoint.findOneAndUpdate(
        { _id: endpoint._id, merchantId, updatedAt: endpoint.updatedAt },
        { $set: { secrets } },
        { returnDocument: "after" },
      ).lean<WebhookEndpoint>();
      // Two rotations at once: one wins, the other is told to try again
      if (!updated) throw new ApiError(409, "conflict", "The endpoint changed; try again");
      res.json({ ...endpointJson(updated), secret });
    },
  );

  router.post(
    "/v1/webhook_endpoints/:id/test",
    requirePermission("webhooks:manage"),
    async (req, res) => {
      const { merchantId } = userOf(req);
      const endpoint = await load(merchantId, req.params.id);
      const eventId = newId("evt_ping");
      const delivery = await models.WebhookDelivery.create({
        merchantId,
        mode: endpoint.mode,
        endpointId: endpoint._id,
        eventId,
        eventType: "ping",
        payload: {
          id: eventId,
          object: "event",
          type: "ping",
          created: Math.floor(Date.now() / 1000),
          livemode: endpoint.mode === "live",
          data: { object: { endpoint: endpoint._id } },
        },
      });
      await webhooks.queue.add(
        "deliver",
        { deliveryId: delivery._id },
        // One attempt: a test should say at once whether the endpoint works
        { ...jobOptions(config, delivery._id), attempts: 1 },
      );
      res.status(202).json(deliveryJson(delivery.toObject()));
    },
  );

  router.post(
    "/v1/webhook_endpoints/:id/retry_dead",
    requirePermission("webhooks:manage"),
    async (req, res) => {
      const { merchantId } = userOf(req);
      const endpoint = await load(merchantId, req.params.id);
      const dead = await models.WebhookDelivery.find({
        merchantId,
        endpointId: endpoint._id,
        status: "dead",
      })
        .sort({ createdAt: 1 })
        .limit(MAX_BULK_REPLAY)
        .lean<WebhookDelivery[]>();
      for (const delivery of dead) await replayDelivery(webhooks, delivery);
      res.status(202).json({ replayed: dead.length });
    },
  );

  router.get("/v1/webhook_deliveries", requirePermission("webhooks:read"), async (req, res) => {
    const { merchantId } = userOf(req);
    const query = parse(deliveryQuery, req.query);
    const filter: Record<string, unknown> = { merchantId };
    if (query.endpoint) filter.endpointId = query.endpoint;
    if (query.status) filter.status = query.status;
    if (query.event) filter.eventId = query.event;
    if (query.starting_after) {
      const cursor = await models.WebhookDelivery.findOne({
        _id: query.starting_after,
        merchantId,
      }).lean<WebhookDelivery>();
      if (!cursor) throw new ApiError(400, "invalid_cursor", "starting_after isn't a delivery");
      filter.$or = [
        { createdAt: { $lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, _id: { $lt: cursor._id } },
      ];
    }
    const rows = await models.WebhookDelivery.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(query.limit + 1)
      .lean<WebhookDelivery[]>();
    res.json({
      object: "list",
      data: rows.slice(0, query.limit).map((d) => deliveryJson(d)),
      has_more: rows.length > query.limit,
    });
  });

  router.get("/v1/webhook_deliveries/:id", requirePermission("webhooks:read"), async (req, res) => {
    const { merchantId } = userOf(req);
    const delivery = await models.WebhookDelivery.findOne({
      _id: req.params.id,
      merchantId,
    }).lean<WebhookDelivery>();
    if (!delivery) throw new ApiError(404, "not_found", "Webhook delivery not found");
    res.json(deliveryJson(delivery, true));
  });

  router.post(
    "/v1/webhook_deliveries/:id/retry",
    requirePermission("webhooks:manage"),
    async (req, res) => {
      const { merchantId } = userOf(req);
      const delivery = await models.WebhookDelivery.findOne({
        _id: req.params.id,
        merchantId,
      }).lean<WebhookDelivery>();
      if (!delivery) throw new ApiError(404, "not_found", "Webhook delivery not found");
      if (delivery.status === "pending" || delivery.status === "retrying") {
        throw new ApiError(409, "invalid_state", "It's already queued");
      }
      await replayDelivery(webhooks, delivery);
      res.status(202).json({ id: delivery._id, status: "pending" });
    },
  );

  return router;
}
