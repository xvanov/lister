/**
 * The provider webhooks as Next runs them (the route handlers themselves),
 * against real Postgres, with signatures computed the way each provider
 * documents them. The job queue is mocked: we assert what would be queued.
 */
import { createHmac, randomBytes } from "node:crypto";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@repo/db";
import { createTenant } from "@repo/db/testing";
import { resetEnvCache } from "@repo/env";
import { findSuppression } from "@repo/outbound";

import { POST as emailEvents } from "./email-events/route";

const { enqueue } = vi.hoisted(() => ({ enqueue: vi.fn(async () => "job") }));
vi.mock("@repo/jobs", () => ({ enqueue }));

const SVIX_SECRET = `whsec_${randomBytes(24).toString("base64")}`;
const HMAC_SECRET = "generic-test-secret";

beforeAll(() => {
  Object.assign(process.env, {
    RESEND_WEBHOOK_SECRET: SVIX_SECRET,
    EMAIL_WEBHOOK_SECRET: HMAC_SECRET,
  });
  resetEnvCache();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => enqueue.mockClear());

const uid = () => randomBytes(6).toString("hex");

/** Svix: base64 HMAC-SHA256 of `${id}.${ts}.${body}`, keyed by the decoded secret. */
function svixRequest(
  body: unknown,
  opts: { ts?: number; secret?: string } = {},
) {
  const raw = JSON.stringify(body);
  const id = `msg_${uid()}`;
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
  const key = Buffer.from((opts.secret ?? SVIX_SECRET).slice(6), "base64");
  const sig = createHmac("sha256", key)
    .update(`${id}.${ts}.${raw}`)
    .digest("base64");
  return new Request("http://internal:3000/api/webhooks/email-events", {
    method: "POST",
    headers: {
      "svix-id": id,
      "svix-timestamp": ts,
      "svix-signature": `v1,${sig}`,
      "content-type": "application/json",
    },
    body: raw,
  });
}

function hmacRequest(path: string, body: unknown) {
  const raw = JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = createHmac("sha256", HMAC_SECRET)
    .update(`${ts}.${raw}`)
    .digest("hex");
  return new Request(`http://internal:3000${path}`, {
    method: "POST",
    headers: {
      "x-webhook-timestamp": ts,
      "x-webhook-signature": `sha256=${sig}`,
    },
    body: raw,
  });
}


describe("/api/webhooks/email-events (Resend, Svix-signed)", () => {
  it("records delivery on our message by Resend's id", async () => {
    const a = await createTenant("wh-dlr");
    const emailId = `re-${uid()}`;
    const row = await db.outboundMessage.create({
      data: {
        organizationId: a.organizationId,
        channel: "email",
        recipient: `c-${uid()}@customer.test`,
        purpose: "test",
        status: "sent",
        providerMessageId: emailId,
      },
    });
    const res = await emailEvents(
      svixRequest({
        type: "email.delivered",
        data: { email_id: emailId, to: [row.recipient] },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "delivered", matched: 1 });
    expect(
      (await db.outboundMessage.findUniqueOrThrow({ where: { id: row.id } }))
        .deliveryStatus,
    ).toBe("delivered");
  });

  it("refuses a wrong secret and a replayed (old) timestamp", async () => {
    const body = {
      type: "email.complained",
      data: { email_id: "x", to: ["v@x.test"] },
    };
    const wrong = `whsec_${randomBytes(24).toString("base64")}`;
    expect(
      (await emailEvents(svixRequest(body, { secret: wrong }))).status,
    ).toBe(401);
    const old = Math.floor(Date.now() / 1000) - 600;
    expect((await emailEvents(svixRequest(body, { ts: old }))).status).toBe(
      401,
    );
    expect(await findSuppression("email", "v@x.test", null)).toBeNull();
  });

});



describe("every webhook: size cap before signature work; throttling only of failed signatures", () => {
  const routes = [
    ["email-events", emailEvents],
  ] as const;

  it("refuses an oversized chunked body (no Content-Length) with 413", async () => {
    for (const [name, handler] of routes) {
      const huge = new ReadableStream<Uint8Array>({
        start(c) {
          // 16 MB in 1 MB chunks: past every route's cap, inbound email's too.
          for (let i = 0; i < 16; i++) c.enqueue(new Uint8Array(1 << 20));
          c.close();
        },
      });
      const res = await handler(
        new Request(`http://internal:3000/api/webhooks/${name}`, {
          method: "POST",
          body: huge,
          // Node's fetch needs this for a stream body (cast below: whether
          // RequestInit declares it depends on the installed @types).
          duplex: "half",
        } as RequestInit),
      );
      expect(res.status, name).toBe(413);
    }
  });

  it("throttles only FAILED signatures per IP: a flood of forgeries cannot 429 real callbacks", async () => {
    // An attacker sets X-Forwarded-For to whatever IP the provider uses.
    const ip = `203.0.113.${Math.floor(Math.random() * 250)}`;
    const body = { type: "bounce", email: `t-${uid()}@customer.test` };
    const forged = () =>
      emailEvents(
        new Request("http://internal:3000/api/webhooks/email-events", {
          method: "POST",
          headers: {
            "x-forwarded-for": ip,
            "x-webhook-timestamp": String(Math.floor(Date.now() / 1000)),
            "x-webhook-signature": "sha256=forged",
          },
          body: JSON.stringify(body),
        }),
      );
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await forged()).status;
    expect(last).toBe(429);

    // The provider's real, signed callback to the SAME webhook from that same
    // IP still goes through.
    const signed = hmacRequest("/api/webhooks/email-events", body);
    signed.headers.set("x-forwarded-for", ip);
    const res = await emailEvents(signed);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
