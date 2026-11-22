/**
 * Listing state changes, shared by the API (create / markSold / remove /
 * retry) and the worker (the run's outcome). Every status change writes a
 * webhook_delivery row in the same transaction; the CALLER enqueues the
 * `webhook.deliver` job for the returned delivery id (this package does not
 * depend on @repo/jobs).
 *
 * Every write is scoped by organizationId in its `where` (updateMany), so a
 * listing id from another tenant changes nothing.
 */
import { randomUUID } from "node:crypto";
import { db, type Prisma } from "@repo/db";
import { env } from "@repo/env";

import {
  toListingDto,
  type CreateListingInput,
  type ListingRow,
  type ListingStatus,
  type ListingStatusEvent,
} from "./contract";

export type ListingAction = "create" | "markSold" | "remove";

export class ListerError extends Error {
  constructor(
    message: string,
    readonly code: "NOT_FOUND" | "BAD_REQUEST" | "CONFLICT",
  ) {
    super(message);
    // Named like @repo/api's domain errors, so tRPC maps them to their code.
    this.name = {
      NOT_FOUND: "NotFoundError",
      BAD_REQUEST: "DomainRuleError",
      CONFLICT: "ConflictError",
    }[code];
  }
}

type Tx = Prisma.TransactionClient;

export const listingSelect = {
  id: true,
  organizationId: true,
  accountId: true,
  platform: true,
  refSystem: true,
  refKind: true,
  refId: true,
  title: true,
  description: true,
  priceCents: true,
  category: true,
  condition: true,
  location: true,
  photoIds: true,
  callbackUrl: true,
  apiClientName: true,
  status: true,
  pendingAction: true,
  platformListingId: true,
  url: true,
  lastError: true,
  screenshotKeys: true,
  createdAt: true,
  updatedAt: true,
} as const;

export function appUrl(): string {
  return env().APP_URL;
}

export async function getListing(organizationId: string, listingId: string) {
  const row = await db.listing.findFirst({
    where: { id: listingId, organizationId },
    select: listingSelect,
  });
  if (!row) throw new ListerError("Listing not found.", "NOT_FOUND");
  return row;
}

/** Record a webhook event for the listing's current state. Returns its id. */
async function recordEvent(
  tx: Tx,
  organizationId: string,
  listingId: string,
): Promise<string | null> {
  const row = await tx.listing.findFirst({
    where: { id: listingId, organizationId },
    select: listingSelect,
  });
  if (!row?.callbackUrl) return null;
  const eventId = randomUUID();
  const event: ListingStatusEvent = {
    eventId,
    type: "listing.status",
    listing: toListingDto(row as ListingRow, appUrl()),
  };
  const d = await tx.webhookDelivery.create({
    data: {
      organizationId,
      listingId,
      eventId,
      eventType: event.type,
      url: row.callbackUrl,
      body: JSON.stringify(event),
    },
    select: { id: true },
  });
  return d.id;
}

/**
 * Create a listing, idempotent on (accountId, externalRef): a second create
 * for the same ref returns the existing listing and queues nothing.
 */
export async function createListing(
  organizationId: string,
  apiClientName: string | null,
  input: CreateListingInput,
): Promise<{
  listingId: string;
  status: ListingStatus;
  created: boolean;
  deliveryId: string | null;
}> {
  const account = await db.sellerAccount.findFirst({
    where: { id: input.accountId, organizationId },
    select: { id: true, platform: true, status: true },
  });
  if (!account) throw new ListerError("Account not found.", "NOT_FOUND");

  const existing = await db.listing.findFirst({
    where: {
      organizationId,
      accountId: account.id,
      refSystem: input.externalRef.system,
      refKind: input.externalRef.kind,
      refId: input.externalRef.id,
    },
    select: { id: true, status: true },
  });
  if (existing) {
    return {
      listingId: existing.id,
      status: existing.status,
      created: false,
      deliveryId: null,
    };
  }

  const photos = await db.mediaAsset.findMany({
    where: { organizationId, id: { in: input.photoIds } },
    select: { id: true, contentType: true },
  });
  const known = new Set(photos.map((p) => p.id));
  const missing = input.photoIds.filter((id) => !known.has(id));
  if (missing.length) {
    throw new ListerError(
      `Unknown photoIds: ${missing.join(", ")}`,
      "BAD_REQUEST",
    );
  }
  if (photos.some((p) => !p.contentType.startsWith("image/"))) {
    throw new ListerError("Every photo must be an image.", "BAD_REQUEST");
  }

  try {
    return await db.$transaction(async (tx) => {
      const row = await tx.listing.create({
        data: {
          organizationId,
          accountId: account.id,
          platform: account.platform,
          refSystem: input.externalRef.system,
          refKind: input.externalRef.kind,
          refId: input.externalRef.id,
          title: input.title,
          description: input.description,
          priceCents: input.priceCents,
          category: input.category,
          condition: input.condition,
          location: input.location ?? null,
          photoIds: input.photoIds,
          callbackUrl: input.callbackUrl,
          apiClientName,
          status: "QUEUED",
          pendingAction: "create",
        },
        select: { id: true },
      });
      const deliveryId = await recordEvent(tx, organizationId, row.id);
      return {
        listingId: row.id,
        status: "QUEUED" as const,
        created: true,
        deliveryId,
      };
    });
  } catch (err) {
    // Two concurrent creates for one ref: the loser returns the winner's row.
    if ((err as { code?: string }).code === "P2002") {
      const row = await db.listing.findFirst({
        where: {
          organizationId,
          accountId: account.id,
          refSystem: input.externalRef.system,
          refKind: input.externalRef.kind,
          refId: input.externalRef.id,
        },
        select: { id: true, status: true },
      });
      if (row)
        return {
          listingId: row.id,
          status: row.status,
          created: false,
          deliveryId: null,
        };
    }
    throw err;
  }
}

/**
 * Ask for markSold / remove / a retry. The listing's status is left as is
 * until the worker reports the outcome; `pendingAction` says what is queued.
 */
export async function requestAction(
  organizationId: string,
  listingId: string,
  action: ListingAction | "retry",
): Promise<{ action: ListingAction }> {
  const row = await getListing(organizationId, listingId);
  let next: ListingAction;
  if (action === "retry") {
    if (row.status === "SOLD" || row.status === "REMOVED") {
      throw new ListerError(
        `Listing is ${row.status}; nothing to retry.`,
        "CONFLICT",
      );
    }
    next = (row.pendingAction as ListingAction | null) ?? "create";
  } else {
    if (action === "markSold" && row.status === "SOLD") return { action };
    if (action === "remove" && row.status === "REMOVED") return { action };
    next = action;
  }
  await db.listing.updateMany({
    where: { id: listingId, organizationId },
    data: {
      pendingAction: next,
      ...(next === "create" ? { status: "QUEUED", lastError: null } : {}),
    },
  });
  return { action: next };
}

export interface Outcome {
  status: ListingStatus;
  platformListingId?: string | null;
  url?: string | null;
  lastError?: string | null;
  screenshotKeys?: string[];
  /** Clear pendingAction (the action is finished, ok or not for good). */
  done?: boolean;
}

/** Apply a status change and record its webhook. Returns the delivery id. */
export async function transition(
  organizationId: string,
  listingId: string,
  o: Outcome,
): Promise<string | null> {
  return db.$transaction(async (tx) => {
    const { count } = await tx.listing.updateMany({
      where: { id: listingId, organizationId },
      data: {
        status: o.status,
        ...(o.platformListingId !== undefined
          ? { platformListingId: o.platformListingId }
          : {}),
        ...(o.url !== undefined ? { url: o.url } : {}),
        ...(o.lastError !== undefined ? { lastError: o.lastError } : {}),
        ...(o.screenshotKeys !== undefined
          ? { screenshotKeys: o.screenshotKeys }
          : {}),
        ...(o.done ? { pendingAction: null } : {}),
      },
    });
    if (count === 0) return null;
    return recordEvent(tx, organizationId, listingId);
  });
}
