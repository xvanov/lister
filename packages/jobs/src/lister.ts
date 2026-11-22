/**
 * lister's jobs: run a listing action in a browser, deliver a webhook, check
 * an account's session. The registry entries are in ./handlers.ts.
 *
 * ONE RUN PER ACCOUNT: a Chromium profile directory cannot be opened by two
 * processes, so every browser job takes a Redis lock on its account first
 * (and waits for it), whatever WORKER_CONCURRENCY is. `npm run account:login`
 * takes the same lock.
 */
import { randomUUID } from "node:crypto";
import { UnrecoverableError } from "bullmq";
import { db } from "@repo/db";
import {
  transition,
  webhookHeaders,
  webhookSecretFor,
  type ListingAction,
} from "@repo/lister";

import { connection } from "./queue";

const LOCK_TTL_MS = 20 * 60_000;
const LOCK_WAIT_MS = 30 * 60_000;

export function accountLockKey(accountId: string): string {
  return `lister:account-lock:${accountId}`;
}

/** Run `fn` holding the account's lock; waits (polling) while another run holds it. */
export async function withAccountLock<T>(
  accountId: string,
  fn: () => Promise<T>,
  opts: { waitMs?: number } = {},
): Promise<T> {
  const key = accountLockKey(accountId);
  const token = randomUUID();
  const deadline = Date.now() + (opts.waitMs ?? LOCK_WAIT_MS);
  for (;;) {
    const ok = await connection.set(key, token, "PX", LOCK_TTL_MS, "NX");
    if (ok === "OK") break;
    if (Date.now() > deadline)
      throw new Error(`account ${accountId} is busy (another browser run holds its profile)`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  try {
    return await fn();
  } finally {
    // Release only our own lock.
    await connection
      .eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
        1,
        key,
        token,
      )
      .catch(() => undefined);
  }
}

/** Enqueue the webhook for a recorded delivery (no-op for null). */
export async function enqueueDelivery(
  organizationId: string,
  deliveryId: string | null,
): Promise<void> {
  if (!deliveryId) return;
  const { enqueue } = await import("./queue");
  await enqueue(
    "webhook.deliver",
    { organizationId, deliveryId },
    { attempts: 8, backoffMs: 5_000 },
  );
}

export async function runListing(p: {
  organizationId: string;
  listingId: string;
  action: ListingAction;
}): Promise<unknown> {
  const listing = await db.listing.findFirst({
    where: { id: p.listingId, organizationId: p.organizationId },
    select: { accountId: true, status: true },
  });
  if (!listing) return { skipped: "listing not found" };

  return withAccountLock(listing.accountId, async () => {
    if (p.action === "create") {
      await enqueueDelivery(
        p.organizationId,
        await transition(p.organizationId, p.listingId, {
          status: "POSTING",
          lastError: null,
        }),
      );
    }
    // Loaded here, not at the top: it pulls in Playwright, which only the
    // worker may load (the web app imports this package for `enqueue`).
    const { runListingAction } = await import("@repo/lister/runner");
    const r = await runListingAction(p.organizationId, p.listingId, p.action);
    const { localScreenshots, ...outcome } = r;
    await enqueueDelivery(
      p.organizationId,
      await transition(p.organizationId, p.listingId, outcome),
    );
    if (localScreenshots.length)
      console.log(`[lister] ${p.listingId} screenshots:\n  ${localScreenshots.join("\n  ")}`);
    if (r.status === "FAILED") {
      // The listing records the failure; the job_run row says so too.
      throw new ListingRunFailed(r.lastError ?? "failed");
    }
    return { status: r.status, platformListingId: r.platformListingId ?? null };
  });
}

/** A listing run that failed; never retried by the queue (it could double-post). */
export class ListingRunFailed extends UnrecoverableError {}

export async function checkAccountJob(p: {
  organizationId: string;
  accountId: string;
}): Promise<unknown> {
  return withAccountLock(p.accountId, async () => {
    const { checkAccount } = await import("@repo/lister/runner");
    return checkAccount(p.organizationId, p.accountId);
  });
}

export async function deliverWebhook(p: {
  organizationId: string;
  deliveryId: string;
}): Promise<unknown> {
  const d = await db.webhookDelivery.findFirst({
    where: { id: p.deliveryId, organizationId: p.organizationId },
    select: {
      id: true,
      eventId: true,
      eventType: true,
      url: true,
      body: true,
      status: true,
      listing: { select: { apiClientName: true } },
    },
  });
  if (!d) return { skipped: "delivery not found" };
  if (d.status === "delivered") return { skipped: "already delivered" };
  const secret = webhookSecretFor(d.listing.apiClientName);
  if (!secret) throw new Error("LISTER_WEBHOOK_SECRET is not set; cannot sign webhooks");

  let status: number | null = null;
  let error: string | null = null;
  try {
    const res = await fetch(d.url, {
      method: "POST",
      headers: webhookHeaders(d.body, secret, d.eventId, d.eventType),
      body: d.body,
      signal: AbortSignal.timeout(15_000),
      redirect: "manual",
    });
    status = res.status;
    if (!res.ok) error = `HTTP ${res.status}`;
  } catch (err) {
    error = (err as Error).message.slice(0, 300);
  }
  await db.webhookDelivery.updateMany({
    where: { id: d.id, organizationId: p.organizationId },
    data: {
      attempts: { increment: 1 },
      responseStatus: status,
      lastError: error,
      ...(error ? {} : { status: "delivered", deliveredAt: new Date() }),
    },
  });
  if (error) throw new Error(`webhook to ${new URL(d.url).host} failed: ${error}`);
  return { delivered: true, status };
}

export async function webhookGaveUp(p: { organizationId: string; deliveryId: string }) {
  await db.webhookDelivery.updateMany({
    where: { id: p.deliveryId, organizationId: p.organizationId },
    data: { status: "failed" },
  });
}
